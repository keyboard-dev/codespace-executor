const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

async function retrievePackageJson() {
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

async function checkIfResourcesAreValid(itemsToCheck) {
    let {environmentVariablesNames, docResources} = itemsToCheck;
    let existingServerEnvVars = await retrieveEnvironmentVariableKeys();
    // Compare environmentVariableKeys with existingServerEnvVars
    const areEnvironmentVariablesMatching = compareArrays(environmentVariablesNames, existingServerEnvVars);    
    console.log('Expected environment variables:', environmentVariablesNames);
    console.log('Existing environment variables:', existingServerEnvVars);
    console.log('Environment variables match:', areEnvironmentVariablesMatching);
    return areEnvironmentVariablesMatching
}

async function retrieveEnvironmentVariableKeys() {
    let keys = Object.keys(process.env);
    // Filter keys to only include those that start with "KEYBOARD_"
    let filteredKeys = keys.filter(key => key.startsWith('KEYBOARD_'));
    return filteredKeys;
}

async function retrieveDocResources() {
    let keys = Object.keys(process.env);
    // Filter keys to only include those that start with "KB_DOCS"
    let filteredKeys = keys.filter(key => key.startsWith('KB_DOCS'));
    // Return the complete environment variable objects instead of just keys
    let filteredEnvVars = {};
    filteredKeys.forEach(key => {
        filteredEnvVars[key] = process.env[key];
    });
    return filteredEnvVars;
}

// Helper function to compare two arrays
function compareArrays(arr1, arr2) {
    if (!arr1 || !arr2) return false;
    if (arr1.length !== arr2.length) return false;
    
    // Sort both arrays to compare regardless of order
    const sorted1 = [...arr1].sort();
    const sorted2 = [...arr2].sort();
    
    return sorted1.every((val, index) => val === sorted2[index]);
}

module.exports = {
    retrievePackageJson,
    retrieveEnvironmentVariableKeys,
    retrieveDocResources,
    checkIfResourcesAreValid
};
