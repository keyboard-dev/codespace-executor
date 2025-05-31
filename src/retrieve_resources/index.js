const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

async function retrievePackageJson(config) {
    try {
        // Create the base directory path using the title
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJson = fs.readFileSync(packageJsonPath, 'utf8');
        const packageJsonObject = JSON.parse(packageJson);
        return packageJsonObject;
    } catch (error) {
        console.error('Error creating project:', error);
        throw error;
    }
}

async function retrieveEnvironmentVariableKeys(config) {
    let keys = Object.keys(process.env);
    // Filter keys to only include those that start with "KEYBOARD_"
    let filteredKeys = keys.filter(key => key.startsWith('KEYBOARD_'));
    return filteredKeys;
}

module.exports = {
    retrievePackageJson,
    retrieveEnvironmentVariableKeys
};
