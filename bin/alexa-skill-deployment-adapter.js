/**
 * This is a CasperJS script that automates the deployment of Alexa Skills using the Amazon Developer Portal website.
 * This is the next best thing until an official CLI is available from Amazon.
 */

var fs = require('fs');
var system = require("system");
var utils = require("utils");

var casper = require("casper").create({
    //verbose: true,
    logLevel: "debug",
    viewportSize: {
        width: 1280,
        height: 900
    },
    pageSettings: {
        // We must set the user agent to this, otherwise the Amazon Developer Portal login page appears to reject the login submission form
        userAgent: "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/44.0.2403.157 Safari/537.36"
    }
});

var startTime = new Date().getTime();
casper.start();

var config = loadConfiguration();
var publishProfile = config.profile;
var cookiesPath = config.profile.skillOutputDirectory + "/casper/cookies/" + config.username + ".json";
var screenshotsDir = config.profile.skillOutputDirectory + "/casper/screenshots/";
var intentsFileName = "intents.json";
var slotTypesFileName = "custom.types";
var utterancesFileName = "skill.utr";
var skillConfigFilePath = config.profile.tempSkillConfigFilePath;
var MAX_UTTERANCE_FILE_SIZE = 200000;
var MAX_UTTERANCE_FILE_SIZE_FRIENDLY = "200K";

if (fs.isFile(cookiesPath)) {
  phantom.cookies = JSON.parse(fs.read(cookiesPath));
}

if (fs.isDirectory(screenshotsDir)) {
    fs.removeTree(screenshotsDir);
}

casper.on('step.error', function(err) {
    var defaultErrorMessage = "An unknown error has occurred";
    err = err || { message: defaultErrorMessage, code: 500 };

    if (typeof err === "string") {
        this.echo(err || defaultErrorMessage, "ERROR");
    } else {
        this.echo(err.message ||defaultErrorMessage, "ERROR");
    }

    this.capture(screenshotsDir + "errors/" + new Date().getTime() + ".png");
    this.bypass(Number.MAX_VALUE).exit(err.code || 500);
});

casper.on('waitFor.timeout', function(timeout, details) {
    var captureName;
    if (details && details.captureName) {

    } else {
        captureName = new Date().getTime();
    }

    this.capture(screenshotsDir + "timeouts/" + captureName + ".png");
});

casper.on('run.complete', function() {
    var endTime = new Date().getTime();
    var timeElapsed = endTime - startTime;
    this.echo("Run time: " + timeElapsed + "ms", "COMMENT");
    this.capture(screenshotsDir + new Date().getTime() + ".png");
});


casper.on('remote.message', function(message) {
    this.echo(message);
});

casper.on("page.error", function(msg, trace) {
    this.emit("step.error", "Page Error: " + msg);
});

casper.thenOpen("https://developer.amazon.com", function visitLoginPage() {
    this.echo("Initializing Alexa Skills deployment...");
    this.click("header a.dp-navbar-login");
});

// first attempt (with cookies possibly set)
casper.then(signIn.bind(casper));
// second attempt (without cookies)
casper.then(signIn.bind(casper, true));

// Some accounts may have been invited by other accounts.
// If this is the case, we need to select the account we wish to add the skill to by company name.
casper.then(function selectCompany() {
    var companies = this.evaluate(function() {
       return $("#headerFirmDropdown").find("ul > li > a").map(function() {
           return $(this).text();
       }).toArray();
    });

    if (companies.length && (!publishProfile.companyName || companies.indexOf(publishProfile.companyName) === -1)) {
        var errorMessage =
            "You belong to more than one company!\r\n" +
            "Please indicate which company you wish to publish your skill to " +
            "by configuring the \"companyName\" setting of your publish profile to be one of the following: \r\n" +
            companies.map(function(company) { return "  - " + company; }).join("\r\n");

        this.emit("step.error", errorMessage);
    } else {
        if (companies.length) {
            this.evaluate(function(publishProfile) {
                $("#headerFirmDropdown").find("ul > li > a").filter(function(index, link) {
                    return $(link).text() === publishProfile.companyName;
                })[0].click();
            }, publishProfile);

            this.wait(500, function() {
                this.waitFor(function waitForCompanySelection() {
                    return this.evaluate(function(publishProfile) {
                        try {
                            return $("#headerFirmDropdown").children(".button").text() === publishProfile.companyName;
                        } catch (e) {
                            return false;
                        }
                    }, publishProfile);
                });
            });
        }
    }
});

casper.then(function goToAlexaDeveloperPortal() {
    fs.write(cookiesPath, JSON.stringify(phantom.cookies), 644);
    this.click("nav a#top_nav_echodeveloperwebsite");
    // The button we need to click to open the Alexa Skills Kit Portal does not have an id.
    // We could just say click the first button with class of "EDWHomeToolButton", but that might not be the most robust way.
    // To improve the reliability, we will instead look for the <p> tag that contains the text "Alexa Skills Kit" and click the button next to that.
    this.waitFor(function waitForAlexaSkillsKitToolButton() {
        return this.evaluate(function(publishProfile){
            try {
                return $('div.EDWHomeToolFrame p:contains("' + publishProfile.toolName + '")').siblings('button.EDWHomeToolButton').length > 0;
            } catch(e) {
                return false;
            }
        }, publishProfile);
    }, function() {
        this.evaluate(function(publishProfile){
            $('div.EDWHomeToolFrame p:contains("' + publishProfile.toolName + '")').siblings('button.EDWHomeToolButton').click();
        }, publishProfile);

        this.echo("Retrieving existing skills...");
        this.waitForSelector(".EDW_AppList");
    }, undefined, 10000);
});

casper.then(function checkForExistingSkillAndRemove() {
    this.echo("Checking for existing published skill named \"" + publishProfile.skillName + "\"...");
    this.waitFor(function checkForExistingPublishedSkill() {
        return this.evaluate(function(publishProfile){
            try {
                return $('div.edw-applist span.edw-applist-app-skillname')
                            .filter(function() {
                                return $(this).text() === publishProfile.skillName;
                            }).length > 0;
            } catch(e) {
                return false;
            }
        }, publishProfile);
    }, function onFoundExistingPublishedSkill() {
        this.echo("Found existing published skill!", "INFO");
    }, function existingPublishedSkillNotFound(){
        this.echo("Existing skill not found", "COMMENT");
        this.bypass(1); // skips next step
    });
});

casper.then(function deleteExistingSkill() {
    this.echo("Removing skill \"" + publishProfile.skillName + "\"...", "COMMENT");
    this.evaluate(function(publishProfile) {
        $('div.edw-applist span.edw-applist-app-skillname')
            .filter(function() {
                return $(this).text() === publishProfile.skillName;
            })
            .parent()
            .find('.edw-applist-app-action:contains("Delete")')
            .click();
    }, publishProfile);
    this.waitFor(function waitForConfirmationDialog() {
       return this.evaluate(function() {
            return $('#edw-message-box').find('button:contains("Delete")').length;
       });
    }, function() {
        this.evaluate(function() {
            $('#edw-message-box').find('button:contains("Delete")').click();
        });
        // after the dialog closes the page might be doing a rebind and so waiting briefly before continuing helps.
        this.wait(1000);
    });
});

casper.then(function createNewSkill() {
    this.click(".CreateApplicationButton");

    var nameFieldSelector = 'edw-user-input[edw-name="AppEditingConfig.APP_INFO_TAB.SKILL_TYPES.TEXT"] input[type="radio"][value="' + publishProfile.skillType + '"]';
    this.waitUntilVisible(nameFieldSelector, function onNewSkillEditorLoaded() {
        // set skill type
        this.click(nameFieldSelector);

        // set the skill name (this is the name of Alexa app as it would show up in the Alexa App Store)
        this.sendKeys('edw-user-input[edw-name="AppEditingConfig.APP_INFO_TAB.NAME.TEXT"] input[type="text"]', publishProfile.skillName);

        // set the invocation name (e.g. "Alexa ask [Invocation Name]...")
        this.sendKeys('edw-user-input[edw-name="AppEditingConfig.APP_INFO_TAB.SPOKEN_NAME.TEXT"] input[type="text"]', publishProfile.skillInvocationName);

        // set if audio player directives are used for the skill
        this.click('edw-user-input[edw-name="AppEditingConfig.ALEXA_APPSTORE_INFO_TAB.SUB_SECTIONS.AUDIO_PLAYER"] input[type="radio"][value="' + publishProfile.usesAudioPlayer + '"]');

        //this.click('#edw-save-skill-button');
        saveChanges.call(this,{
            loadingMessage: "Creating new skill...",
            successMessage: "",
            failureMessage: "Failed to create new skill"
        });

        this.waitUntilVisible('edw-user-input[edw-name="AppEditingConfig.APP_INFO_TAB.ID.TEXT"]', function() {
            // Get the application id for the skill
            publishProfile.applicationId = this.evaluate(function() {
                return $('edw-user-input[edw-name="AppEditingConfig.APP_INFO_TAB.ID.TEXT"]')
                    .find('.UpdateApplicationFormRowTextBox:visible')
                    .find('label')
                    .text();
            });

            this.click("#edw-next-skill-tab-button");
            this.waitUntilVisible('form[name="IntentSchemaForm"]');
        });
    });
});

casper.then(function uploadIntents() {
    var intentsJsonPath = publishProfile.skillOutputDirectory.replace(/\/$/, "") + "/" + intentsFileName;
    if (!fs.isFile(intentsJsonPath)) {
        this.emit("step.error", {
            message: "Unable to find intents at \"" + intentsJsonPath + "\"",
            code: 404
        });
    }

    var intentsJson;
    try {
        intentsJson = JSON.stringify(JSON.parse(fs.read(intentsJsonPath)), null, 2);
    } catch (e) {
        this.emit("step.error", {
            message: "Error loading \"" + intentsJsonPath + "\"\nReason:" + (e || "Unknown"),
            code: 400
        });
    }

    this.echo("Uploading intents from \"" + intentsJsonPath + "\" ...");

    this.evaluate(function(json) {
        var intentTextArea = $('textarea[name="intentModel"]');
        // This is how we simulate copy/pasting code into the CodeMirror text area.
        var editor = intentTextArea.next(".CodeMirror")[0].CodeMirror;
        editor.getDoc().setValue(json);
        angular.element(editor).triggerHandler('input');
    }, intentsJson);
});

casper.eachThen(getSlotDefinitions(), function(item) {
    var slotType = item.data;
    this.then(function uploadSlotDefinition() {
        this.echo("Uploading slot definition: " + slotType.name + " ...");

        // click the "Add Slot Type" button
        this.click("#interaction-model-tab-add-catalog-button");

        // wait for the Custom Slot Editor to show
        this.waitUntilVisible(".catalog-editor-container", function() {
            this.evaluate(function(slotType) {
                // The following line is a HACK!
                // PhantomJS is encountering a javascript error when adding slot types after recent changes to Amazon Developer Portal
                // And it happens in edw_app.min.js ~line 174:
                // if (!m.isRawTextSlotEnabled) {
                //     var i = d.modelDef[c].models
                //         , i = i.replace(/\s/g, "");
                //     if (i.includes(b.INTERACTION_MODEL_TAB.RAW_TEXT_SLOT)) {
                //         g("There was a problem with your request: Unknown slot type 'AMAZON.1315766020'");
                //         return
                //     }
                // }
                // The error is similar to the following:
                // "undefined is not a constructor (evaluating 'i.includes(b.INTERACTION_MODEL_TAB.RAW_TEXT_SLOT)')"
                // By making "isRawTextSlotEnabled" true, we avoid this error and slots get added just fine!
                window.EDW_CONFIG.isRawTextSlotEnabled = true;

                // set the slot type name
                var slotNameTextBox = $("#interaction-model-tab-catalog-name-textbox");
                slotNameTextBox.val(slotType.name);
                // This is a hack to let angular know the element changed.
                // Without this, the "Save" button in the editor does not enable because angular
                // doesn't think the element has changed.
                // The following line is necessary when jQuery is used to modify values.
                // It is probably better to modify the angular model directly / stay within angular context(s)
                // See this StackOverflow answer for details: http://stackoverflow.com/a/23850753
                angular.element(slotNameTextBox).triggerHandler('input');

                // set the slot type values
                var slotValueEditorElement = $('textarea[name="catalog-values"]').next(".CodeMirror");
                var editor = slotValueEditorElement[0].CodeMirror;
                editor.getDoc().setValue(slotType.values);
                angular.element(editor).triggerHandler('input');
            }, slotType);

            this.waitFor(function waitForSaveButtonToEnable() {
                return this.evaluate(function() {
                    try {
                        return $("#interaction-model-tab-save-catalog-button").prop("disabled") === false;
                    } catch (e) {
                        return false;
                    }
                })
            }, function() {
                // Click "Save" to add the custom slot type and close the slot type editor
                this.click("#interaction-model-tab-save-catalog-button");

                this.waitFor(function waitForAddNewSlotToEnable() {
                    return this.evaluate(function() {
                        try {
                            return $("#interaction-model-tab-add-catalog-button").prop("disabled") === false;
                        } catch (e) {
                            return false;
                        }
                    });
                }, undefined, function onTimeout() {
                    this.emit("step.error", "Failed to save slot type \"" + slotType.name + "\"\nReason: Internal Server Error");
                });
            }, function onTimeout() {
                this.emit("step.error", "Failed to add slot type \"" + slotType.name + "\"\nReason: Internal Server Error");
            });
        });
    });
});

casper.then(function uploadUtterances() {
    var utterancesFilePath = publishProfile.skillOutputDirectory.replace(/\/$/, "") + "/" + utterancesFileName;
    if (!fs.isFile(utterancesFilePath)) {
        this.emit("step.error", {
            message: "Unable to find intents at \"" + utterancesFilePath + "\"",
            code: 404
        });
    }

    var utterances;
    try {
        var utteranceFileSize = fs.size(utterancesFilePath);
        if (utteranceFileSize > MAX_UTTERANCE_FILE_SIZE) {
            this.echo(
                "Warning: Your utterance file is " + utteranceFileSize + " bytes in size, " +
                "which exceeds the " + MAX_UTTERANCE_FILE_SIZE_FRIENDLY + " limit!  " +
                "Consider reducing the combinations and sample size and validating input in the business logic",
                "WARNING"
            );
        }

        utterances = fs.read(utterancesFilePath);
    } catch (e) {
        this.emit("step.error", {
            message: "Error loading \"" + utterancesFilePath + "\"\nReason:" + (e || "Unknown"),
            code: 400
        });
    }

    this.echo("Uploading utterances from \"" + utterancesFilePath + "\" ...");

    this.evaluate(function(utterances) {
        // This is how we simulate copy/pasting code into the CodeMirror text area.
        var editor = $('textarea[name="tests"]').next(".CodeMirror")[0].CodeMirror;
        editor.getDoc().setValue(utterances);
    }, utterances);
});

casper.then(function saveInteractionModel() {
    saveChanges.call(this,{
        loadingMessage: "Building interaction model, please wait...",
        successMessage: "Successfully saved Alexa interaction model!",
        failureMessage: "Failed to save Alexa interaction model"
    });
});

casper.then(function goToEditConfigurationSettings() {
    // click "Next" to go to endpoint configuration
    this.click("#edw-next-skill-tab-button");

    // wait for endpoint configuration to load
    this.waitForSelector("section.update-application-endpoint", function() {
        this.waitForSelector("#service-endpoint-lambda", function() {
            this.waitForSelector("#service-endpoint-https");
        })
    });
});

casper.then(function configureEndpoint() {
    if (!publishProfile.endpoint) {
        this.echo(
            "An endpoint has not been set in the publish profile.  " +
            "Please update the publish profile and run again, or set the endpoint manually here: " + this.getCurrentUrl(), "WARNING");
    } else {
        this.echo("Configuring endpoint...");
        var endpointType;
        // is this a lambda endpoint?
        if (publishProfile.endpoint.type.toLowerCase() === "lambda") {
            // set endpoint type
            this.click("#service-endpoint-lambda");
            endpointType = "Lambda";
        } else {
            this.click("#service-endpoint-https");
            endpointType = "HTTPS";
        }

        // TODO: allow Skill region to be configured. For now, hardcoding to North America
        this.click("#endpoint-region-NA");

        this.evaluate(function(publishProfile) {
            var endpointTextBox = $("#regional-endpoint-option-input-NA");
            endpointTextBox.val(publishProfile.endpoint.location);
            angular.element(endpointTextBox).triggerHandler('input');
        }, publishProfile);

        saveChanges.call(this, {
            loadingMessage: "Saving endpoint configuration, please wait...",
            successMessage: "Successfully configured endpoint to " + endpointType + ": " + publishProfile.endpoint.location,
            failureMessage: "Failed to save endpoint configuration"
        });
    }
});

casper.then(function() {
    var skillConfig;
    if (fs.exists(skillConfigFilePath)) {
        this.echo("Updating skill config file at: " + skillConfigFilePath, "COMMENT");
        skillConfig = JSON.parse(fs.read(skillConfigFilePath));
    } else {
        this.echo("Creating skill config file at: " + skillConfigFilePath, "COMMENT");
        skillConfig = {};
    }

    skillConfig.applicationId = publishProfile.applicationId;
    fs.write(skillConfigFilePath, JSON.stringify(skillConfig, null, 2), 'w');

    this.echo(
        "Successfully published Alexa Skills:\n" +
        "\tApplication Id: " + publishProfile.applicationId + "\n" +
        "\tName: " + publishProfile.skillName + "\n" +
        "\tInvocation Name: " + publishProfile.skillInvocationName + "\n" +
        "\tEndpoint: " + publishProfile.endpoint.location,
        "GREEN_BAR"
    );

    this.wait(2000);
});

casper.run(function() {
    this.exit();
});

function signIn(isRetry) {
    this.waitForUrl("https://developer.amazon.com/home.html", function onSuccess() {
        if (!isRetry) {
            this.bypass(1); // skip retry
        }
    }, function onFailure() {
        if (!isRetry) {
            this.echo("Authenticating...");
        }

        this.fill('form#ap_signin_form', {
            "email": config.username,
            "password": config.password
        }, true);

        this.waitForUrl("https://developer.amazon.com/home.html", function onSuccess() {
            if (!isRetry) {
                this.bypass(1); // skip retry
            }
        }, function onFailure() {
            // If we have cookies, lets remove those and try again
            if (phantom.cookies) {
                phantom.cookies = null;
                return;
            }

            this.emit("step.error", {
                message: "SignIn Error. Exiting process...",
                code: 401
            });
        });
    });
}

function loadConfiguration() {

    try {
        var config = system.stdin.read();
        config.username = config.username || config.skills_access_key_id;
        config.password = config.password || config.skills_secret_access_key;
        return JSON.parse(config);
    } catch (e) {
        setErrorAndExit(400, "Error loading configuration: Unexpected format: " + e, "ERROR");
    }
}

function setErrorAndExit(errorCode, errorMessage) {
    casper.echo(errorMessage, "ERROR");
    casper.bypass(Number.MAX_VALUE);
    casper.exit(errorCode);
}

function saveChanges(context) {
    this.waitFor(function waitForAddNewSlotToEnable() {
        return this.evaluate(function() {
            try {
                return $("#edw-save-skill-button").prop("disabled") === false;
            } catch (e) {
                return false;
            }
        });
    }, function onSaveEnabled() {
        this.click("#edw-save-skill-button");

        // On the configuration page there is a dialog asking to confirm global changes
        // If that dialog exists, lets click the "Yes, apply changes" button
        this.waitFor(function waitForConfirmationDialog() {
            return this.evaluate(function() {
                var dialog = $('#edw-message-box').closest(".edw-messagebox");
                return dialog.is(":visible") && dialog.find('button:contains("Yes")').length;
            });
        }, function() {
            this.evaluate(function() {
                $('#edw-message-box').find('button:contains("Yes")').click();
            });
            // after the dialog closes the page might be doing a rebind and so waiting briefly before continuing helps.
            this.wait(1000, function() {
                onConfirmSaveChanges.call(this, context);
            });

        }, function onNoConfirmationDialogFound() {
            onConfirmSaveChanges.call(this, context);
        });

    }, function onTimeout() {
        this.emit("step.error", context.failureMessage + "\nReason: Internal Server Error");
    });
}

function onConfirmSaveChanges(context) {
    if (context.loadingMessage) {
        this.echo(context.loadingMessage, "COMMENT");
    }

    this.waitFor(function waitSaveComplete() {
        return this.evaluate(function(){
            try {
                // wait until we are done loading
                return $("#EDW_Main_Loading_Status").is(':visible') === false;
            } catch (e) {
                return false;
            }
        });
    }, function saveComplete(){
        var status = this.evaluate(function() {
            return angular.element($("#EDW_Status")).scope().getStatus();
        });

        if (status.type && status.type !== "success") {
            return this.emit("step.error", context.failureMessage + "\nReason: " + status.message);
        }

        if (context.successMessage) {
            this.echo(context.successMessage, "INFO");
        }

    }, function onTimeout() {
        this.emit("step.error", context.failureMessage + "\nReason: Timed out!");
    }, publishProfile.buildModelTimeout);
}

function getSlotDefinitions() {
    var slotTypeFilePath = publishProfile.skillOutputDirectory.replace(/\/$/, "") + "/" + slotTypesFileName;
    var slotTypesUploaded = false;
    var stream;

    try {
        stream = fs.open(slotTypeFilePath, 'r');
        var slotTypeTerminator = "<<<<<";
        var line;
        var slotTypes = [];

        casper.echo("Retrieving slot definitions from \"" + slotTypeFilePath + "\" ...");
        while (!stream.atEnd()) {
            var slotName = "undefined";
            try {
                var slotType;
                line = stream.readLine();
                // The first line will be the slot type name
                if (line) {
                    slotName = line;
                    slotType = {
                        name: slotName,
                        values: "" // The values as a line terminated string
                    }
                }

                // The remaining lines until a terminator (i.e. "<<<<<") will be the values for the slot type
                var slotValues = [];
                do {
                    if (stream.atEnd()) {
                        break;
                    }

                    line = stream.readLine();

                    if (line && line !== slotTypeTerminator) {
                        slotValues.push(line);
                    } else {
                        break;
                    }

                } while(true);

                slotType.values = slotValues.join("\n");
                slotTypes.push(slotType);
                casper.echo("Loaded slot definition: " + slotType.name + " with " + slotValues.length + " values", "INFO");
            } catch (e) {
                throw "An error occured while loading slot definition \"" + slotName + "\"\nReason: " + e;
            }
        }

        casper.echo("Loaded " + slotTypes.length + " slot types", "INFO");
        return slotTypes;

    } catch (e) {
        casper.echo("An error occurred while attempting to open slot type definitions file at \"" + slotTypeFilePath + "\"\nReason: " + e, "ERROR");
        throw e;
    } finally {
        if (stream) {
            stream.close();
        }
    }
}