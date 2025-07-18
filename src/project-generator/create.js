const fs = require('fs');
const path = require('path');

/**
 * Creates a new project based on the provided configuration
 * @param {Object} config - The project configuration object
 * @param {string} config.title - The project title
 * @param {string} config.description - The project description
 * @param {string[]} config.dependencies - List of project dependencies
 * @param {Array<{filename: string, code: string}>} config.files - List of files to create
 * @returns {Promise<void>}
 */
async function createProject(config) {
    try {
        // Create the base directory path using the title
        const baseDir = path.join(process.cwd(), 'codebases_projects', config.title.toLowerCase().replace(/\s+/g, '-'));

        // Create the base directory if it doesn't exist
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        // Process each file in the configuration
        for (const file of config.files) {
            // Create the full file path
            const filePath = path.join(baseDir, file.filename);

            // Ensure the directory for the file exists
            const fileDir = path.dirname(filePath);
            if (!fs.existsSync(fileDir)) {
                fs.mkdirSync(fileDir, { recursive: true });
            }

            // Write the file
            fs.writeFileSync(filePath, file.code);
        }


        return
    } catch (error) {
        console.error('Error creating project:', error);
        throw error;
    }
}

module.exports = {
    createProject
};
