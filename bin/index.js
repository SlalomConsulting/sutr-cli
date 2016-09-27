#! /usr/bin/env node

/**
 * This is a NodeJS script that is intended to provide a command line interface for the deployment of Alexa Skills for use with npm.
 */
var Promise = require("promise");
var AWS = require("aws-sdk");
var fs = require("fs-extra");
var copyNodeModules = Promise.denodeify(require("copy-node-modules"));
var os = require("os");
var path = require("path");
var ini = require("ini");
var prompt = require("prompt");
var colors = require("colors/safe");
var child_process = require("child_process");
var spawn = require("cross-spawn");
var commandLineArgs = require("command-line-args"); // TODO: use commander instead (https://www.npmjs.com/package/commander)
var getUsage = require("command-line-usage"); // TODO: use commander instead (https://www.npmjs.com/package/commander)
var util = require("util");
var zipDir = Promise.denodeify(require("zip-dir"));
var which = Promise.denodeify(require("which"));

AWS.config.apiVersions = {
    lambda: "2015-03-31"
};

var sutrConfigDir = path.resolve(os.homedir() + "/.sutr/");
var sutrConfigFilePath = path.resolve(sutrConfigDir + "/config");
var env;
var supportedRuntimes = ["nodejs", "nodejs4.3", "java8", "python2.7"];
var defaultRuntime = supportedRuntimes[1];
var defaultRegion = "us-east-1";
var profileOutputDir = path.resolve("./deployment/profiles");
var sutrIntentModelsFileName = "intentName.json";
var intentsFileName = "intents.json";


colors.setTheme({
    debug: "cyan",
    info: "white",
    error: "bgRed",
    warning: "red",
    title: ["green", "bold"],
    success: "bgGreen",
    comment: "yellow"
});

fs.fileExistsSync = function(path) {
    var exists = true;
    try {
        fs.accessSync(path, fs.F_OK);
    } catch(e) {
        exists = false;
    }

    return exists;
};

executeCommand();

function startLambdaDeployment(options, config) {
    return new Promise(function(resolve, reject) {
        if (!options.lambda) {
            comment("Skipping publish of lambda.  Include --labmda command line argument to publish lambda code");
            return resolve();
        }

        if (options.profile.endpoint.type !== "lambda") {
            comment("Skipping publish of lambda.  The publish profile is not configured with a lambda function.");
            return resolve();
        }

        var uploadZipDestinationDir = path.resolve(os.tmpdir(),"sutr");
        var uploadStagingDir = path.resolve(uploadZipDestinationDir, "upload");
        var uploadZipFile = path.resolve(uploadZipDestinationDir, "index.zip");
        var uploadZipSourceDir = path.resolve(options.profile.sourceDirectory);
        info("Packaging zip of source code for upload to Lambda: " + uploadZipSourceDir);

        // Remove any possible existing files left over from a previous upload
        Promise.denodeify(fs.remove)(uploadStagingDir)
            .then(function(){
                fs.mkdirsSync(uploadStagingDir);
                // copy lambda source code to temporary upload directory
                return Promise.denodeify(fs.copy)(uploadZipSourceDir, uploadStagingDir)
            })
            .then(function(){
                // copy the node_modules from the source directory to resolve dependencies for lambda code
                return copyNodeModules("./", path.resolve(uploadStagingDir), { devDependencies: false });
            })
            .then(function() {
                // merge any existing config.json with the config.json from the temp directory
                // existing config values will be favored over temp config values
                var exitingConfigFilePath = path.resolve(options.profile.sourceDirectory, options.profile.skillConfigFilePath);
                var mergedConfigFilePath = path.resolve(uploadStagingDir, options.profile.skillConfigFilePath);
                var existingConfig;
                if (fs.fileExistsSync(exitingConfigFilePath)) {
                    existingConfig = fs.readJsonSync(exitingConfigFilePath);
                } else {
                    existingConfig = {};
                }

                var tempConfig;
                var tempConfigFilePath = path.resolve(options.profile.skillOutputDirectory, options.profile.skillConfigFilePath);
                if (fs.fileExistsSync(tempConfigFilePath)) {
                    tempConfig = fs.readJsonSync(tempConfigFilePath);
                    if (typeof tempConfig.applicationId === "undefined") {
                        warning(
                            "An application id has not been configured for this skill.\n" +
                            "This prevents verification of the application id and leaves your skill less secure!\n" +
                            "Make sure you've run \"sutr build && sutr publish --skills\" to correctly generate the application id configruation for your skill."
                        );
                    }
                } else {
                    warning(
                        "A generated config file could not be found at: \"" + tempConfigFilePath + "\"\n" +
                        "Make sure you've run \"sutr build && sutr publish --skills\" to correctly generate the application id configruation for your skill."
                    );

                    tempConfig = {};
                }

                var mergedConfig = Object.assign(tempConfig, existingConfig);
                fs.writeJsonSync(mergedConfigFilePath, mergedConfig);
                // copy intentRoutes.json into the zip location
                fs.copySync(
                    options.profile.tempSkillRouteConfigFilePath,
                    path.resolve(uploadStagingDir, options.profile.skillRouteConfigFilePath)
                );
            })
            .then(function() {
                return zipDir(uploadStagingDir, { saveTo: uploadZipFile });
            })
            .catch(function(err) {
                setErrorAndExit(500, "Error packaging source code for upload" + err);
            })
            .then(function(){
                info("Successfully created package for lambda upload at: " + uploadZipFile);
                info("Uploading code to Lambda function \"" + options.profile.endpoint.location + "\" ...");

                AWS.config.update({
                    accessKeyId: config.aws_access_key_id,
                    secretAccessKey: config.aws_secret_access_key,
                    region: config.region
                });

                // upload AWS Lambda code
                var lambda = new AWS.Lambda();
                return lambda.updateFunctionCode({
                    FunctionName: options.profile.endpoint.location,
                    ZipFile: fs.readFileSync(uploadZipFile)
                }).promise();
            })
            .then(function() {
                success("Successfully uploaded code to Lambda function \"" + options.profile.endpoint.location);
                resolve();
            })
            .catch(function(err) {
                setErrorAndExit(500, "An error occurred while uploading code to Lambda" + err);
            });

    });
}

function startSkillDeployment(options) {
    return new Promise(function(resolve, reject) {
        if (!options.skills) {
            comment("Skipping publish of skills.  Include --skills command line argument to publish skills");
            return resolve();
        }

        which("python")
            .then(function(){
                var casperJSExePath = path.resolve(__dirname, "../node_modules/.bin/casperjs");
                var casperJS = spawn(
                    casperJSExePath,
                    [path.resolve(__dirname, "alexa-skill-deployment-adapter.js")],
                    {
                        stdio: ["pipe", "pipe", "inherit"],
                        env: {
                            PHANTOMJS_EXECUTABLE: path.resolve(__dirname, "../node_modules/.bin/phantomjs")
                        }
                    }
                );

                casperJS.stdout.on("data", function(data){
                    process.stdout.write(data);
                });

                casperJS.on("close", function (code) {
                    if (code !== 0) {
                        return reject("Alexa Skill deployment Failed");
                    }

                    return resolve();
                });

                casperJS.stdin.end(JSON.stringify(options));
            })
            .catch(function(err) {
                reject("Please install Python 2.7+ and add to PATH: " + err);
            });
    });
}

function showHelp() {
    var sections = [
        {
            header: 'Sutr Command Line Interface',
            content: 'Welcome to the command line interface for serving your Amazon Echo deployment needs.'
        },
        {
            header: 'Usage',
            content:
                "$ sutr configure [--env envName]\n" +
                "$ sutr build [--profile file]\n" +
                "$ sutr publish [--profile file] [--skills] [--lambda]\n"
        },
        {
            header: 'Options',
            optionList: [
                {
                    name: 'profile',
                    typeLabel: '[underline]{file}',
                    description: 'The file path to a publish profile used to configure the deployment'
                },
                {
                    name: 'help',
                    description: 'Print this usage guide.'
                }
            ]
        }
    ];

    var usage = getUsage(sections);
    console.log(usage);
}

function executeCommand() {
    var optionDefinitions = [
        { name: "command", type: String, defaultOption: true},
        { name: "env", type: String },
        { name: "profile", type: String },
        { name: "skills", type: Boolean},
        { name: "lambda", type: Boolean},
        { name: "help", type: Boolean }
    ];

    var options = commandLineArgs(optionDefinitions);
    if (options.help) {
        showHelp();
        return process.exit(0);
    }

    env = options.env || "default";

    if (options.command === "configure") {
        setSutrConfiguration()
            .catch(function(err) {
                setErrorAndExit(500, err + "\n" + (err.stack || ""));
            });
    } else if(options.command === "build") {
        loadPublishProfileConfiguration(options, false)
            .then(function() {
                return loadSutrIntentModel(options);
            })
            .then(function(intentModel) {
                options.sutrIntentModel = intentModel;
                return createRoutesConfig(options);
            })
            .then(function() {
                return createIntentsFile(options);
            })
            .then(function() {
                return createEmptyConfigFile(options);
            })
            .catch(function(err) {
                setErrorAndExit(500, err + "\n" + (err.stack || ""));
            });
    } else if (options.command === "publish") {
        var config;
        loadPublishProfileConfiguration(options, true)
            .then(function() {
                env = options.env || options.profile.environment;
                return loadSutrConfiguration(options);
            })
            .then(function(allConfigs) {
                config = allConfigs[env];
                var missingConfiguration = false;
                if (!config) {
                    missingConfiguration = true;
                } else if (options.skills && (!config.skills_access_key_id || !config.skills_secret_access_key)) {
                    missingConfiguration = true;
                } else if (options.lambda && (!config.aws_access_key_id || !config.aws_secret_access_key)) {
                    missingConfiguration = true;
                }

                if (missingConfiguration) {
                    return setUsageErrorAndExit(400, "Configuration missing. Please call sutr configure to enable publishing");
                }

                return config;
            })
            .then(function(config) {
                options.username = config.skills_access_key_id;
                options.password = decrypt(config.skills_secret_access_key);
                return startSkillDeployment(options);
            })
            .then(function() {
                return startLambdaDeployment(options, config);
            })
            .then(function() {
                process.exit(0);
            })
            .catch(function(err) {
                setErrorAndExit(500, err + "\n" + (err.stack || ""));
            });
    } else {
        setUsageErrorAndExit(400, "command not available: \"" + options.command + "\"");
    }
}

function setSutrConfiguration() {
    return new Promise(function(resolve) {
        var allConfigs;
        var config;
        tryMakeSutrDirectory()
            .then(function() {
                return loadSutrConfiguration();
            })
            .then(function(allConf) {
                info("Sutr will now quide you through a configuration wizard to prepare your machine for easy deployment");
                title("Step 1: Skills Deployment Authorization");

                allConfigs = allConf;
                config = allConf[env];
                return setSkillsCredentials(config)
            })
            .then(function() {
                title("Step 2: AWS Lambda Authorization");
                return setAwsConfiguration(config);
            })
            .then(function() {
                return saveSutrConfiguration(allConfigs);
            })
            .then(function() {
                title("Step 3: Create a Publish Profile");
                return createPublishProfile(config, allConfigs["default"]);
            })
            .then(function() {
                return saveSutrConfiguration(allConfigs);
            })
            .then(function() {
                resolve();
            })
            .catch(function(err) {
                setErrorAndExit(500, "An error occurred while configuring Sutr: " + err);
            });
    });
}

function saveSutrConfiguration(config) {
    return new Promise(function(resolve) {
        fs.writeFileSync(sutrConfigFilePath, ini.stringify(config));
        resolve();
    });
}

function tryMakeSutrDirectory() {
    return new Promise(function(resolve) {
        try {
            fs.mkdirSync(sutrConfigDir);
        } catch(e) {
            if ( e.code != 'EEXIST' ) {
                throw e;
            }
        }

        resolve();
    });
}

function loadSutrConfiguration() {
    return new Promise(function(resolve) {
        var config = {};
        if (fs.fileExistsSync(sutrConfigFilePath)) {
            config = ini.parse(fs.readFileSync(sutrConfigFilePath, "utf-8"));
        }

        config[env] = config[env] || {};
        // currently, Lambda for Alexa Skills Kit is only available in the us-east-1 region
        config[env].region = config[env].region || defaultRegion;

        resolve(config);
    });
}

function setAwsConfiguration(config) {
    return new Promise(function(resolve) {
        comment("You must provide AWS access credentials to authorize publishing to Lambda.");

        var existingAWSAccessKeyStr = config.aws_access_key_id ? " [" + config.aws_access_key_id + "]" : " [None]";
        var existingAWSSecretAccessKeyStr = config.aws_secret_access_key ? " [*****]" : " [None]";
        var existingAWSRegionStr = config.region ? " [" + config.region + "]" : " [None]";

        prompt.message = "";
        prompt.start();
        prompt.get({
            properties: {
                username: {
                    description: "AWS Access Key ID" + existingAWSAccessKeyStr,
                    before: function(value) {
                        return value || config.aws_access_key_id;
                    }
                },
                password: {
                    description: "AWS Secret Access Key" + existingAWSSecretAccessKeyStr,
                    hidden: true,
                    replace: "*",
                    before: function(value) {
                        return value || config.aws_secret_access_key;
                    }
                },
                region: {
                    description: "AWS Region" + existingAWSRegionStr,
                    before: function(value) {
                        return value || config.region;
                    }
                },
                lambdaFunctionRole: {
                    description: "AWS Lambda Execution Role [" + (config.aws_lambda_execution_role || "None") + "]"
                }
            }
        }, function (err, result) {
            if (!result) {
                // The most likely cause to this is when a command is cancelled.
                return process.exit(400);
            }

            config.aws_access_key_id = result.username;
            config.aws_secret_access_key = result.password;
            config.region = result.region;

            if (result.lambdaFunctionRole) {
                config.aws_lambda_execution_role = result.lambdaFunctionRole;
            }

            resolve();
        });
    });
}

function setSkillsCredentials(config) {
    return new Promise(function(resolve){
        comment("You must provide your Amazon Developer account credentials to authorize publishing Alexa Skills.");

        var existingSkillsAccessKeyStr = config.skills_access_key_id ? " [" + config.skills_access_key_id + "]" : " [None]";
        var existingSkillsSecretAccessKeyStr = config.skills_secret_access_key ? " [*****]" : " [None]";
        var existingCompanyName = config.skills_company_name ? " [" + config.skills_company_name + "]" : " [None]";

        prompt.message = "";
        prompt.start();
        prompt.get({
            properties: {
                username: {
                    description: "Email" + existingSkillsAccessKeyStr,
                    before: function(value) {
                        return value || config.skills_access_key_id;
                    }
                },
                password: {
                    description: "Password" + existingSkillsSecretAccessKeyStr,
                    hidden: true,
                    replace: "*",
                    before: function(value) {
                        if (value) {
                            return encrypt(value);
                        }

                        return config.skills_secret_access_key;
                    }
                },
                companyName: {
                    description: "Company or Developer Name" + existingCompanyName,
                    before: function(value) {
                        return value || config.skills_company_name || "";
                    }
                }
            }
        }, function (err, result) {
            if (!result) {
                // The most likely cause to this is when a command is cancelled.
                return process.exit(400);
            }

            config.skills_access_key_id = result.username;
            config.skills_secret_access_key = result.password;

            if (result.companyName) {
                config.skills_company_name = result.companyName;
            }

            resolve();
        });
    });
}

function getNewFunctionConfiguration(config) {
    return new Promise(function(resolve) {
        comment("Just a few more details to create your new Lambda function");

        prompt.message = "";
        prompt.start();
        prompt.get({
            properties: {
                lamdaFunctionDescription: {
                    description: "Lambda Function Description [None]"
                },
                lambdaFunctionRole: {
                    description: "Lambda Function Role [" + (config.aws_lambda_execution_role || "None") + "]",
                    message: "Enter the ARN of the IAM role to use when executing the lambda function",
                    conform: function(value) {
                        return value || config.aws_lambda_execution_role;
                    },
                    before: function(value) {
                        return value || config.aws_lambda_execution_role;
                    }
                },
                lambdaFunctionRuntime: {
                    pattern: new RegExp("^" + supportedRuntimes.join("|") + "$", "i"),
                    description: "Lambda Function Runtime: [" + defaultRuntime + "]",
                    message: "Possible values: " + supportedRuntimes.join(", "),
                    before: function(value) {
                        return value || defaultRuntime;
                    }
                }
            }
        }, function (err, result) {
            if (!result) {
                // The most likely cause to this is when a command is cancelled.
                return process.exit(400);
            }

            resolve(result);
        });
    });
}

function createPublishProfile(config, defaultConfig) {
    return new Promise(function(resolve, reject){
        comment("A publish profile is used to configure a deployment for a skill.");
        info("Enter a profile name below to create a new profile");
        var availableProfiles = getAvailableProfiles();

        prompt.message = "";
        prompt.start();
        prompt.get({
            properties: {
                profileName: {
                    pattern: /^[a-zA-Z0-9\-_]+$/,
                    description: "Profile Name [None]",
                    message: "Only letters, numbers, dashes and underscores please."
                },
                skillName: {
                    pattern: /^[a-zA-Z\s]+$/,
                    description: "Skill Name",
                    message: "Only letters and spaces please",
                    required: true,
                    ask: function() {
                        return prompt.history("profileName").value;
                    }
                },
                skillInvocationName: {
                    pattern: /^[a-zA-Z\s]+$/,
                    description: "Skill Invocation Name",
                    message: "Only letters and spaces please",
                    required: true,
                    ask: function() {
                        return prompt.history("profileName").value;
                    }
                },
                lambdaFunctionName: {
                    pattern: /^[a-zA-Z\-_]+$/,
                    description: "Lambda Function Name [None]",
                    message: "Only letters, dashes, and underscores please.",
                    ask: function() {
                        return prompt.history("profileName").value;
                    }
                },
                useNewProfileAsDefault: {
                    pattern: /^(yes|y|no|n)$/i,
                    description: "Use as default profile? [yes]",
                    message: "yes/y, no/n?",
                    before: function(value) {
                        if (!value) {
                            return true;
                        }

                        if (value.toLowerCase() === "yes" || value.toLowerCase() === "y") {
                            return true;
                        }

                        return false;
                    },
                    ask: function() {
                        return prompt.history("profileName").value;
                    }
                },
                defaultProfileName: {
                    description: "Default Profile" + (defaultConfig.default_profile ? " [" + defaultConfig.default_profile + "]" : " [None]"),
                    message: "\nAvailable Profiles: " + availableProfiles
                        .map(function(profileName) {
                            return "\n   " + profileName;
                        })
                        .join(""),
                    before: function(value) {
                        return value || defaultConfig.default_profile;
                    },
                    conform: function(value) {
                        return availableProfiles.indexOf(value) !== -1;
                    },
                    ask: function() {
                        return !prompt.history("profileName").value;
                    }
                }
            }
        }, function (err, result) {
            if (!result) {
                // The most likely cause to this is when a command is cancelled.
                return process.exit(400);
            }

            if (result.useNewProfileAsDefault) {
                defaultConfig.default_profile = result.profileName;
            } else if (result.defaultProfileName) {
                defaultConfig.default_profile = result.defaultProfileName;
            }

            if (result.profileName) {
                generatePublishProfile(result, config)
                    .then(function() {
                        resolve();
                    })
                    .catch(function(err) {
                        reject(err);
                    })
            } else {
                resolve();
            }
        });
    });
}

function getAvailableProfiles() {
    try {
        return fs.readdirSync(profileOutputDir).map(function(profilePaths) {
            return path.parse(profilePaths).name;
        });
    } catch (e) {
        return [];
    }
}

function generatePublishProfile(prompts, config) {
    return new Promise(function(resolve, reject) {
        var profile = {
            environment: env,
            toolName: "Alexa Skills Kit",
            companyName: config.skills_company_name,
            skillName: prompts.skillName,
            skillInvocationName: prompts.skillInvocationName,
            skillType: "Custom",
            usesAudioPlayer: false,
            skillOutputDirectory: "./out/ask",
            skillConfigFilePath: "config.json",
            skillRouteConfigFilePath: "intentRoutes.json",
            sourceDirectory: "./lambda",
            buildModelTimeout: 60000,
            endpoint: {
                type: prompts.lambdaFunctionName ? "lambda" : "https"
            }
        };

        if (profile.endpoint.type === "lambda") {
            getOrCreateLambdaFunction(prompts, config)
                .then(function(lambda) {
                    profile.endpoint.location = lambda.arn;
                    savePublishProfile(prompts.profileName, profile)
                        .then(function() {
                            resolve(profile);
                        }).catch(function(err) {
                            reject("Error generating publish profile: " + err);
                        });
                })
                .catch(function(err) {
                    reject(err);
                });
        } else {
            profile.endpoint.location = "<your endpoint here>";
            savePublishProfile(prompts.profileName, profile)
                .then(function() {
                   resolve(profile);
                }).catch(function(err) {
                   reject("Error generating publish profile: " + err);
                });
        }
    });
}

function getOrCreateLambdaFunction(prompts, config) {
    return new Promise(function(resolve, reject) {
        AWS.config.update({
            accessKeyId: config.aws_access_key_id,
            secretAccessKey: config.aws_secret_access_key,
            region: config.region
        });

        var lambda = new AWS.Lambda();

        info("Getting details for Lambda function named \"" + prompts.lambdaFunctionName + "\" ...");

        lambda.getFunction({FunctionName: prompts.lambdaFunctionName}).promise()
            // if a lambda function with the given name already exists for the account
            .then(function(data) {
                var arn = data.Configuration.FunctionArn;
                comment("Using existing Lambda function \"" + prompts.lambdaFunctionName + "\": " + arn);
                return resolve({
                    arn: arn
                });
            })
            .catch(function(err) {
                if (err.name === "ResourceNotFoundException") {
                    // if a lambda function does not exist with the given name, continue to create a new function
                    return createNewLambda();
                }

                // some unknown error occurred
                throw err;
            })
            .then(function(data) {
                resolve(data);
            })
            .catch(function(err) {
               reject(err);
            });

            function createNewLambda() {
                var createdFunction;
                var lambdaConfig;
                return Promise.resolve(true)
                    .then(function() {
                        comment("A Lambda function with name \"" + prompts.lambdaFunctionName + "\" does not exist");
                        return getNewFunctionConfiguration(config);
                    })
                    .then(function(lambdaConf) {
                        lambdaConfig = lambdaConf;
                        info("Creating Lambda function \"" + prompts.lambdaFunctionName + "\" ...");

                        var starterZipDestinationDir = path.resolve(os.tmpdir(),"sutr");
                        var starterZipFile = lambdaConfig.starterZipFile = path.resolve(starterZipDestinationDir, "starter_" + lambdaConfig.lambdaFunctionRuntime + ".zip");
                        var starterZipSourceDir = path.resolve(__dirname, "starterSource/" + lambdaConfig.lambdaFunctionRuntime);
                        fs.mkdirsSync(starterZipDestinationDir);

                        return zipDir(starterZipSourceDir, { saveTo: starterZipFile } );
                    })
                    .then(function() {
                        // create AWS lambda function
                        return lambda.createFunction({
                            FunctionName: prompts.lambdaFunctionName,
                            Runtime: lambdaConfig.lambdaFunctionRuntime,
                            Handler: "index.handler", // TODO: may be different for other platforms (i.e. Java/Python)
                            Role: lambdaConfig.lambdaFunctionRole,
                            Code: {
                                ZipFile: fs.readFileSync(lambdaConfig.starterZipFile)
                            },
                            Description: lambdaConfig.lamdaFunctionDescription
                        }).promise();
                    })
                    .then(function(result) {
                        createdFunction = result;
                        success("Lambda function \"" + prompts.lambdaFunctionName + "\" sucessfully created: " + createdFunction.FunctionArn);

                        // Allow Alexa Skill Kit to call lambda function
                        info("Adding permission to allow Alexa Skills Kit to invoke lambda function...");
                        return lambda.addPermission({
                            FunctionName: prompts.lambdaFunctionName,
                            StatementId: new Date().getTime().toString(),
                            Action: "lambda:InvokeFunction",
                            Principal: "alexa-appkit.amazon.com"
                        }).promise();
                    })
                    .then(function(){
                        success("Access succesfully granted to Alexa Skills Kit!");

                        return Promise.resolve({
                            arn: createdFunction.FunctionArn
                        });
                    })
                    .catch(function(err) {
                        throw new Error("An error occurred while creating lambda function: " + err + "\n" + err.stack);
                    });
            }
    });
}

function savePublishProfile(profileName, profile) {
    return new Promise(function(resolve, reject) {
        fs.mkdirs(profileOutputDir, function(err) {
            if (err) {
                return reject(err);
            }

            var profileFilePath = path.resolve(profileOutputDir, profileName + ".json");
            fs.writeFileSync(profileFilePath, JSON.stringify(profile, null, 2));
            success("Publish profile successfully created: " + profileFilePath);
            resolve(profile);
        });
    });
}

function loadPublishProfileConfiguration(config, showProfile) {
    return new Promise(function(resolve) {
        env = "default";
        loadSutrConfiguration()
            .then(function(allConfigs) {
                var profilePath = config.profile;

                if (!profilePath) {
                    var defaultConfig = allConfigs["default"];
                    if (!defaultConfig) {
                        return setErrorAndExit(400, "Please run \"sutr configure\" to set up your default profile or use the --profile option");
                    }

                    var defaultProfilePath = defaultConfig.default_profile;
                    if (!defaultProfilePath) {
                        return setErrorAndExit(400, "Please run \"sutr configure\" to set up your default profile or use the --profile option");
                    }

                    profilePath = path.resolve(profileOutputDir, defaultProfilePath + ".json");
                }

                try {
                    var absolutePath = path.resolve(profilePath);

                    if (!fs.fileExistsSync(absolutePath)) {
                        setErrorAndExit(400, "Error loading profile: file does not exist or access is denied: \"" + absolutePath + "\".");
                        return resolve();
                    }

                    comment("Loading publish profile at \"" + profilePath + "\" ...");
                    var publishConfig = JSON.parse(fs.readFileSync(profilePath));
                    config.profileName = path.parse(absolutePath).name;
                    config.profile = publishConfig;
                    config.profile.sourceDirectory = path.resolve(config.profile.sourceDirectory);
                    config.profile.skillOutputDirectory = path.resolve(config.profile.skillOutputDirectory);

                    if (showProfile) {
                        info(JSON.stringify(publishConfig, null, 2));
                    }

                    config.profile.tempSkillConfigFilePath = path.resolve(config.profile.skillOutputDirectory, config.profile.skillConfigFilePath);
                    config.profile.tempSkillRouteConfigFilePath = path.resolve(config.profile.skillOutputDirectory, config.profile.skillRouteConfigFilePath);
                } catch (e) {
                    setErrorAndExit(400, "Error loading profile: " + e);
                }

                resolve();
            })
            .catch(function(err) {
                reject(err);
            });
    });

}

function loadSutrIntentModel(options) {
    return new Promise(function(resolve) {
        var sutrIntentModelFilePath = path.resolve(options.profile.skillOutputDirectory, sutrIntentModelsFileName);
        if (!fs.fileExistsSync(sutrIntentModelFilePath)) {
            return setErrorAndExit(400, "Unable to load sutr models at: \"" + sutrIntentModelFilePath + "\".");
        }

        var sutrIntentModels = JSON.parse(fs.readFileSync(sutrIntentModelFilePath));
        return resolve(sutrIntentModels);
    });
}

function createRoutesConfig(options) {
    return new Promise(function(resolve) {
        info("Generating route configuration...");
        try {
            fs.mkdirsSync(path.dirname(options.profile.tempSkillRouteConfigFilePath));
            var routesConfig = {
                routes: {}
            };

            options.sutrIntentModel.sutrIntentModels.forEach(function(model) {
                routesConfig.routes[model.intentName] = model.functionName;
            });

            fs.writeFileSync(options.profile.tempSkillRouteConfigFilePath, JSON.stringify(routesConfig, null, 2));
        } catch(e) {
            return setErrorAndExit(500, "Error generating route configuration: " + e + "\".");
        }

        resolve();
    });
}

function createEmptyConfigFile(options) {
    return new Promise(function(resolve) {
        // Create an empty config file allow graceful warning when configuration of application ID is unavailable.
        var tempConfigFilePath = path.resolve(options.profile.skillOutputDirectory, options.profile.skillConfigFilePath);
        fs.writeJsonSync(tempConfigFilePath, {});
        resolve();
    });
}

function createIntentsFile(options) {
    return new Promise(function(resolve) {
       info("Generating intents from Sutr intents model...");
        try {
            fs.mkdirsSync(options.profile.skillOutputDirectory);
            var intents = getIntentsFromSutrIntentModels(options.sutrIntentModel);
            fs.writeFileSync(path.resolve(options.profile.skillOutputDirectory, intentsFileName), intents);
        } catch(e) {
            return setErrorAndExit(500, "Error generating intents: " + e + "\".");
        }

        resolve();
    });
}

function getIntentsFromSutrIntentModels(sutrIntents) {
    var intents = { };
    intents.intents = sutrIntents.sutrIntentModels.map(function(model) {
        return {
            intent: model.intentName,
            slots: model.slots.map(function(sutrSlotModel) {
                return {
                    name: sutrSlotModel.slotName,
                    type: sutrSlotModel.slotType
                };
            })
        };
    });

    return JSON.stringify(intents, null, 2);
}

function success(message) {
    console.log(colors.success(message));
}

function debug(message) {
    console.log(colors.debug(message));
}

function warning(message) {
    process.stderr.write(colors.warning("WARNING: " + message + "\n"));
}

function info(message) {
    console.log(colors.info(message));
}

function title(message) {
    console.log(colors.title(message));
}

function comment(message) {
    console.log(colors.comment(message));
}

function setUsageErrorAndExit(code, message) {
    showHelp();
    process.stderr.write(colors.error(message) + "\n");
    process.exit(code);
}

function setErrorAndExit(code, message) {
    process.stderr.write(colors.error(message) + "\n");
    if (message && message.stack) {
        console.log(colors.error(message.stack));
    }

    process.exit(code);
}

/**
 *  Security through Obscurity.
 *  We just want to make sure passwords are NOT stored in plain text in the .sutr configuration.
 *  So we will incorporate some simple encryption here to obscure the values.
 */

var crypto = require('crypto')
var encryptionPassword = "dCqGoyQk35gGTPBUcPqwcM8IfVQ5ObcHjzypZTcZm3VIe3lt";
function encrypt(text){
    var cipher = crypto.createCipher('aes-256-ctr', encryptionPassword)
    var crypted = cipher.update(text,'utf8','hex')
    crypted += cipher.final('hex');
    return crypted;
}

function decrypt(text){
    var decipher = crypto.createDecipher('aes-256-ctr', encryptionPassword)
    var dec = decipher.update(text,'hex','utf8')
    dec += decipher.final('utf8');
    return dec;
}