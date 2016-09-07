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
var spawn = require("child_process").spawn;
var commandLineArgs = require("command-line-args");
var getUsage = require("command-line-usage");
var Promise = require("promise");
var util = require("util");

var sutrConfigDir = path.resolve(os.homedir() + "/.sutr/");
var sutrConfigFilePath = path.resolve(sutrConfigDir + "/config");
var env;

colors.setTheme({
    info: "white",
    error: "bgRed",
    warning: "red",
    title: ["green", "bold"],
    comment: "yellow"
});

executeCommand();

function startSkillDeployment(config) {
    return new Promise(function(resolve, reject) {
        var casperJS = spawn("casperjs", ["alexa-skill-deployment-adapter.js"], {stdio: "pipe"});

        casperJS.stdout.on("data", function(data){
            process.stdout.write(data);
        });

        casperJS.on("close", function (code) {
            if (code !== 0) {
                return reject("Alexa Skill deployment Failed");
            }

            return resolve();
        });

        casperJS.stdin.end(JSON.stringify(config));
    });
}

function showHelp() {
    var sections = [
        {
            header: 'Sutr Command Line Interface',
            content: 'Welcome to the command line interface for serving your Amazon Echo deployment needs.'
        },
        {
            header: 'Synopsis',
            content:
                "$ sutr configure\n" +
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
        loadPublishProfileConfiguration(options)
            .then(function() {
                return setSkillsCredentials(options);
            })
            .then(function() {
                return startSkillDeployment(options);
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
        config[env].region = config[env].region || "us-east-1";

        resolve(config);
    });
}

function setAwsConfiguration(config) {
    return new Promise(function(resolve) {
        comment("You must provide AWS access credentials to authorize publishing to Lambda.");

        var existingAWSAccessKeyStr = config.aws_access_key_id ? " [" + config.aws_access_key_id + "]" : " [None]";
        var existingAWSSecretAccessKeyStr = config.aws_secret_access_key ? " [*****]" : " [None]";

        prompt.message = "";
        prompt.start();
        prompt.get({
            properties: {
                username: {
                    description: "AWS Access Key ID" + existingAWSAccessKeyStr
                },
                password: {
                    description: "AWS Secret Access Key" + existingAWSSecretAccessKeyStr,
                    hidden: true,
                    replace: "*"
                }
            }
        }, function (err, result) {
            if (!result) {
                // The most likely cause to this is when a command is cancelled.
                return process.exit(400);
            }

            config.aws_access_key_id = result.username || config.aws_access_key_id;
            config.aws_secret_access_key = result.password || config.aws_secret_access_key;

            resolve();
        });
    });
}

function setSkillsCredentials(config) {
    return new Promise(function(resolve){
        comment("You must provide your Amazon Developer account credentials to authorize publishing Alexa Skills.");

        var existingSkillsAccessKeyStr = config.skills_access_key_id ? " [" + config.skills_access_key_id + "]" : " [None]";
        var existingSkillsSecretAccessKeyStr = config.aws_secret_access_key ? " [*****]" : " [None]";

        prompt.message = "";
        prompt.start();
        prompt.get({
            properties: {
                username: {
                    description: "Email" + existingSkillsAccessKeyStr
                },
                password: {
                    description: "Password" + existingSkillsSecretAccessKeyStr,
                    hidden: true,
                    replace: "*"
                }
            }
        }, function (err, result) {
            if (!result) {
                // The most likely cause to this is when a command is cancelled.
                return process.exit(400);
            }

            config.skills_access_key_id = result.username || config.skills_access_key_id;
            config.skills_secret_access_key = encrypt(result.password) || config.skills_access_key_id;

            resolve();
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
            config.profile = publishConfig;
            console.log(colors.green(util.inspect(publishConfig)));
            // TODO: validate publish profile
        } catch (e) {
            setErrorAndExit(400, "Error loading profile: " + e);
        }

        resolve();
    });

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
    console.log(colors.error(message));
    showHelp();
    process.exit(code);
}

function setErrorAndExit(code, message) {
    console.log(colors.error(message));
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