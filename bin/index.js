#! /usr/bin/env node

/**
 * This is a NodeJS script that is intended to provide a command line interface for the deployment of Alexa Skills for use with npm.
 */

var fs = require("fs");
var os = require("os");
var path = require("path");
var ini = require("ini");
var prompt = require("prompt");
var colors = require("colors/safe");
var child_process = require("child_process");
var spawn = child_process.spawn;
var commandLineArgs = require("command-line-args"); // TODO: use commander instead (https://www.npmjs.com/package/commander)
var getUsage = require("command-line-usage"); // TODO: use commander instead (https://www.npmjs.com/package/commander)
var Promise = require("promise");
var util = require("util");
var mkdirp = require("mkdirp");
var zipDir = require("zip-dir");
var ncp = require("ncp").ncp;
ncp.limit = 16;
var rmdir = require("rimraf");

var sutrConfigDir = path.resolve(os.homedir() + "/.sutr/");
var sutrConfigFilePath = path.resolve(sutrConfigDir + "/config");
var env;
var supportedRuntimes = ["nodejs", "nodejs4.3", "java8", "python2.7"];
var defaultRuntime = supportedRuntimes[1];
var defaultRegion = "us-east-1";
var profileOutputDir = path.resolve("./deployment/profiles");


colors.setTheme({
    info: "white",
    error: "bgRed",
    warning: "red",
    title: ["green", "bold"],
    success: "bgGreen",
    comment: "yellow"
});

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
        Promise.denodeify(rmdir)(uploadStagingDir)
            .then(function(){
                mkdirp.sync(uploadStagingDir);
                // copy lambda source code to temporary upload directory
                return Promise.denodeify(ncp)(uploadZipSourceDir, uploadStagingDir)
            })
            .then(function(){
                // TODO: only copy over dependencies (i.e. NOT devDependencies)
                // copy the node_modules from the source directory to resolve dependencies for lambda code
                return Promise.denodeify(ncp)("./node_modules", path.resolve(uploadStagingDir, "node_modules"));
            })
            .then(function() {
                return Promise.denodeify(zipDir)(uploadStagingDir, { saveTo: uploadZipFile });
            })
            .catch(function(err) {
                setErrorAndExit(500, "Error packaging source code for upload" + err);
            })
            .then(function(){
                info("Uploading code to Lambda function \"" + options.profile.endpoint.location + "\" ...");

                executeCmdSync("aws configure set aws_access_key_id " + config.aws_access_key_id + " --profile sutr", false, true);
                executeCmdSync("aws configure set aws_secret_access_key " + config.aws_secret_access_key + " --profile sutr", false, true);
                executeCmdSync("aws configure set output json --profile sutr", false, true);
                executeCmdSync("aws configure set region " + config.region + " --profile sutr", false, true);

                // create AWS lambda function
                lambda = executeCmdSync(
                    "aws --profile sutr lambda update-function-code " +
                    "--function-name " + options.profile.endpoint.location + " " +
                    "--zip-file fileb://" + uploadZipFile + " ", false, true);

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

        options.profile.skillConfigFilePath = path.resolve(options.profile.skillConfigFilePath);

        var casperJS = spawn("casperjs", [path.resolve(__dirname, "alexa-skill-deployment-adapter.js")], {stdio: "pipe"});

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
                "$ sutr publish --profile file [--skills] [--lambda]\n"
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
    } else if (options.command === "publish") {
        var config;
        loadPublishProfileConfiguration(options)
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
                return createPublishProfile(config);
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

        var configFileExists = true;
        try {
            fs.accessSync(sutrConfigFilePath, fs.F_OK);
        } catch(e) {
            configFileExists = false;
        }

        if (configFileExists) {
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
                }
            }
        }, function (err, result) {
            if (!result) {
                // The most likely cause to this is when a command is cancelled.
                return process.exit(400);
            }

            config.skills_access_key_id = result.username;
            config.skills_secret_access_key = result.password;

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

function createPublishProfile(config) {
    return new Promise(function(resolve){
        comment("A publish profile is used to configure a deployment for a skill.");
        info("Enter a profile name below to create a new profile");

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
                }
            }
        }, function (err, result) {
            if (!result) {
                // The most likely cause to this is when a command is cancelled.
                return process.exit(400);
            }

            if (result.profileName) {
                // result.lambdaFunctionRole = result.lambdaFunctionRole || config.aws_lambda_execution_role;
                // result.
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

function generatePublishProfile(prompts, config) {
    return new Promise(function(resolve, reject) {
        var profile = {
            environment: env,
            toolName: "Alexa Skills Kit",
            skillName: prompts.skillName,
            skillInvocationName: prompts.skillInvocationName,
            skillType: "Custom",
            usesAudioPlayer: false,
            skillOutputDirectory: "./deployment/ask",
            skillConfigFilePath: "./lambda/config.json",
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
        executeCmdSync("aws configure set aws_access_key_id " + config.aws_access_key_id + " --profile sutr", false, true);
        executeCmdSync("aws configure set aws_secret_access_key " + config.aws_secret_access_key + " --profile sutr", false, true);
        executeCmdSync("aws configure set output json --profile sutr", false, true);
        executeCmdSync("aws configure set region " + config.region + " --profile sutr", false, true);

        info("Getting details for Lambda function named \"" + prompts.lambdaFunctionName + "\" ...");

        // if a lambda function with the given name already exists for the account
        var lambda = executeCmdSync("aws --profile sutr lambda get-function --function-name " + prompts.lambdaFunctionName, false, false);
        if (lambda) {
            lambda = JSON.parse(lambda);
            var arn = lambda.Configuration.FunctionArn;
            comment("Using existing Lambda function \"" + prompts.lambdaFunctionName + "\": " + arn);
            return resolve({
                arn: arn
            });
        }

        comment("A Lambda function with name \"" + prompts.lambdaFunctionName + "\" does not exist");

        getNewFunctionConfiguration(config)
            .then(function(lambdaConfig) {
                info("Creating Lambda function \"" + prompts.lambdaFunctionName + "\" ...");

                var starterZipDestinationDir = path.resolve(os.tmpdir(),"sutr");
                var starterZipFile = path.resolve(starterZipDestinationDir, "starter_" + lambdaConfig.lambdaFunctionRuntime + ".zip");
                var starterZipSourceDir = path.resolve(__dirname, "starterSource/" + lambdaConfig.lambdaFunctionRuntime);
                mkdirp.sync(starterZipDestinationDir);

                zipDir(starterZipSourceDir, { saveTo: starterZipFile } , function(err) {
                    if(err) {
                        return reject("An error occurred while creating lambda function: " + err);
                    }

                    // create AWS lambda function
                    lambda = executeCmdSync(
                        "aws --profile sutr lambda create-function " +
                        "--function-name " + prompts.lambdaFunctionName + " " +
                        "--runtime " + lambdaConfig.lambdaFunctionRuntime + " " +
                        "--handler index.handler " +
                        "--role " + lambdaConfig.lambdaFunctionRole + " " +
                        "--zip-file fileb://" + starterZipFile + " " +
                        "--description \"" + lambdaConfig.lamdaFunctionDescription + "\"", false, true);

                    lambda = JSON.parse(lambda);
                    if (lambda.FunctionArn) {
                        success("Lambda function \"" + prompts.lambdaFunctionName + "\" sucessfully created: " + lambda.FunctionArn);
                    }

                    // Allow Alexa Skill Kit to call lambda function
                    info("Adding permission to allow Alexa Skills Kit to invoke lambda function...");
                    executeCmdSync(
                        "aws --profile sutr lambda add-permission " +
                        "--function-name " + prompts.lambdaFunctionName + " " +
                        "--statement-id " + new Date().getTime() + " " +
                        "--action \"lambda:InvokeFunction\" " +
                        "--principal \"alexa-appkit.amazon.com\"", false, true);

                    success("Access succesfully granted to Alexa Skills Kit!");

                    resolve({
                        arn: lambda.FunctionArn
                    });
                });
            })
            .catch(function(err) {
                reject(err);
            });
    });
}

function savePublishProfile(profileName, profile) {
    return new Promise(function(resolve, reject) {
        mkdirp(profileOutputDir, function(err) {
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

function loadPublishProfileConfiguration(config) {
    return new Promise(function(resolve) {
        var profilePath = config.profile;

        if (!profilePath) {
            setUsageErrorAndExit(400, "A publish profile is required! Use --profile=<path/to/profile>");
            return resolve();
        }

        try {
            var absolutePath = path.resolve(profilePath);
            if (fs.accessSync(absolutePath, fs.F_OK)) {
                setErrorAndExit(400, "Error loading profile: file does not exist or access is denied: \"" + absolutePath + "\".");
                return resolve();
            }

            comment("Loading publish profile at \"" + profilePath + "\" ...");
            var publishConfig = JSON.parse(fs.readFileSync(profilePath));
            config.profileName = path.parse(absolutePath).name;
            config.profile = publishConfig;
            config.profile.sourceDirectory = path.resolve(config.profile.sourceDirectory);
            config.profile.skillOutputDirectory = path.resolve(config.profile.skillOutputDirectory);
            info(JSON.stringify(publishConfig, null, 2));
        } catch (e) {
            setErrorAndExit(400, "Error loading profile: " + e);
        }

        resolve();
    });

}

function success(message) {
    console.log(colors.success(message));
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
    console.log(colors.error(message));
    process.exit(code);
}

function setErrorAndExit(code, message) {
    console.log(colors.error(message));
    if (message && message.stack) {
        console.log(colors.error(message.stack));
    }

    process.exit(code);
}

function executeCmdSync(cmd, showOutput, exitOnFailure) {
    if (typeof exitOnFailure === "undefined") {
        exitOnFailure = true;
    }

    if (typeof showOutput === "undefined") {
        showOutput = true;
    }

    try {
        var output = child_process.execSync(cmd, {stdio: ["ignore"]});
        if (showOutput) {
            process.stdout.write(output);
        }

        return output || true;
    } catch (e) {
        if (exitOnFailure) {
            return setErrorAndExit(500, e.message);
        }

        return undefined;
    }
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