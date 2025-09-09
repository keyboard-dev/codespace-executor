// Sample JavaScript File
// This file is for testing the file explorer

function greetUser(name) {
    return `Hello, ${name}! Welcome to the file explorer.`;
}

const config = {
    appName: 'File Explorer',
    version: '1.0.0',
    features: ['browse', 'download', 'search', 'sort']
};

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { greetUser, config };
}

console.log('Test script loaded successfully');