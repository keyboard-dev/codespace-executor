const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

console.log('🚀 Installing Ollama...');

async function installOllama() {
    try {
        console.log('📦 Checking Ollama installation...');
        
        // Check if Ollama is already installed
        try {
            await execAsync('which ollama');
            console.log('✅ Ollama already installed');
            return true;
        } catch (error) {
            console.log('📥 Installing Ollama...');
            await execAsync('curl -fsSL https://ollama.com/install.sh | sh');
            console.log('✅ Ollama installed successfully');
            return true;
        }
    } catch (error) {
        console.error('❌ Error installing Ollama:', error.message);
        return false;
    }
}

// Create a simple status file to track installation
async function createStatusFile() {
    const statusFile = path.join(__dirname, 'ollama-status.json');
    const status = {
        installTime: new Date().toISOString(),
        ollamaInstalled: false,
        apiUrl: 'http://localhost:11434'
    };
    
    try {
        fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
        console.log('📝 Created status file: ollama-status.json');
    } catch (error) {
        console.log('⚠️  Could not create status file:', error.message);
    }
}

// Main installation function
async function main() {
    await createStatusFile();
    
    const installed = await installOllama();
    
    // Update status file
    try {
        const statusFile = path.join(__dirname, 'ollama-status.json');
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        status.ollamaInstalled = installed;
        fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
        
        if (installed) {
            console.log('🎉 Ollama installation complete!');
            console.log('💡 Use the Local LLM module to start and manage Ollama service');
        }
    } catch (error) {
        console.log('⚠️  Could not update status file:', error.message);
    }
    
    // Exit gracefully to continue with server startup
    process.exit(installed ? 0 : 1);
}

main().catch((error) => {
    console.error('❌ Installation failed:', error.message);
    process.exit(1);
}); 