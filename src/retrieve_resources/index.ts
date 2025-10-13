import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

export interface PackageJson {
    name: string;
    version: string;
    description?: string;
    main?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    [key: string]: any;
}

export interface DocResources {
    [key: string]: string;
}

export interface ResourceCheckPayload {
    environmentVariablesNames: string[];
    docResources?: DocResources;
    [key: string]: any;
}

export async function retrievePackageJson(): Promise<PackageJson> {
    try {
        // Create the base directory path using the title
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJson = fs.readFileSync(packageJsonPath, 'utf8');
        const packageJsonObject: PackageJson = JSON.parse(packageJson);
        return packageJsonObject;
    } catch (error: any) {
        console.error('Error creating project:', error);
        throw error;
    }
}

export async function checkIfResourcesAreValid(itemsToCheck: ResourceCheckPayload): Promise<boolean> {
    const { environmentVariablesNames, docResources } = itemsToCheck;
    const existingServerEnvVars = await retrieveEnvironmentVariableKeys();
    // Compare environmentVariableKeys with existingServerEnvVars
    const areEnvironmentVariablesMatching = compareArrays(environmentVariablesNames, existingServerEnvVars);    

    return areEnvironmentVariablesMatching;
}

export async function retrieveEnvironmentVariableKeys(): Promise<string[]> {
    const keys = Object.keys(process.env);
    // Filter keys to only include those that start with "KEYBOARD_"
    const filteredKeys = keys.filter(key => key.startsWith('KEYBOARD_'));
    return filteredKeys;
}

export async function retrieveDocResources(): Promise<DocResources> {
    const keys = Object.keys(process.env);
    // Filter keys to only include those that start with "KB_DOCS"
    const filteredKeys = keys.filter(key => key.startsWith('KB_DOCS'));
    // Return the complete environment variable objects instead of just keys
    const filteredEnvVars: DocResources = {};
    filteredKeys.forEach(key => {
        filteredEnvVars[key] = process.env[key] || '';
    });
    return filteredEnvVars;
}

// Helper function to compare two arrays
function compareArrays(arr1: string[] | undefined, arr2: string[] | undefined): boolean {
    if (!arr1 || !arr2) return false;
    if (arr1.length !== arr2.length) return false;
    
    // Sort both arrays to compare regardless of order
    const sorted1 = [...arr1].sort();
    const sorted2 = [...arr2].sort();
    
    return sorted1.every((val, index) => val === sorted2[index]);
}