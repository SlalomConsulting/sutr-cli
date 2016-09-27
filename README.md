# sutr-cli
A command line interface for streamlining Alexa Skills deployment.

## Installation
```
npm install -g sutr
```
## Usage
Use with [sutr-io IntelliJ plugin](https://github.com/SlalomConsulting/sutr-io)

### Configure Sutr
```
sutr configure [--env environment]
```

### Publish Your Skill
```
sutr publish --skills [--profile profile]
```

### Publish Your Lambda Code
```
sutr publish --lambda [--profile profile]
```

### TODO
* Details on usage
* run and debug lambda locally
* `sutr init` command for creating boilerplate Sutr project
* `sutr build` command compiles sutr files independent of WebStorm
* Language support (i.e. English UK, and German)

## Release History

* 0.5.5 Added .npmignore
* 0.5.4 FIXED: #2 - Require company name when account is affiliated with more than one company
* 0.5.3 FIXED: #1 - Unable to publish skills
* 0.5.0 Initial release
