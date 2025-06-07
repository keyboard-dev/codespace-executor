const { spawn, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

console.log('🚀 Setting up Ollama and Gemma 3 1B...');

// Store process reference globally for shutdown
let ollamaProcess = null;

async function setupOllama() {
    try {
        console.log('📦 Installing Ollama...');
        
        // Check if Ollama is already installed
        try {
            await execAsync('which ollama');
            console.log('✅ Ollama already installed');
        } catch (error) {
            console.log('📥 Installing Ollama...');
            await execAsync('curl -fsSL https://ollama.com/install.sh | sh');
        }

        // Start Ollama service in background
        console.log('🔄 Starting Ollama service...');
        ollamaProcess = spawn('ollama', ['serve'], {
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore']
        });
        
        // Unref the process so parent can exit independently
        ollamaProcess.unref();

        // Give Ollama time to start
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Check if Ollama is running
        try {
            await execAsync('curl -s http://localhost:11434/api/tags');
            console.log('✅ Ollama service is running on port 11434');
        } catch (error) {
            console.log('⚠️  Ollama service might still be starting...');
        }

        // Pull Gemma 3 1B model
        console.log('📥 Pulling Gemma 3 1B model (this may take a few minutes)...');
        
        const pullProcess = spawn('ollama', ['pull', 'gemma3:1b'], {
            stdio: ['inherit', 'pipe', 'pipe']
        });

        pullProcess.stdout.on('data', (data) => {
            process.stdout.write(data);
        });

        pullProcess.stderr.on('data', (data) => {
            process.stderr.write(data);
        });

        pullProcess.on('close', (code) => {
            if (code === 0) {
                console.log('✅ Gemma 3 1B model pulled successfully!');
                console.log('🎉 Ollama setup complete!');
                console.log('📍 Ollama API available at: http://localhost:11434');
                console.log('🤖 Model ready: gemma3:1b');
            } else {
                console.log(`⚠️  Model pull process exited with code ${code}`);
            }
        });

        // Don't wait for the pull to complete, let it run in background
        setTimeout(() => {
            console.log('⏭️  Continuing with server startup while model downloads...');
        }, 1000);

    } catch (error) {
        console.error('❌ Error setting up Ollama:', error.message);
        console.log('⚠️  Continuing with server startup...');
    }
}

// Create a simple status file to track setup
async function createStatusFile() {
    const statusFile = path.join(__dirname, 'ollama-status.json');
    const status = {
        setupTime: new Date().toISOString(),
        ollamaRunning: false,
        gemma3Available: false,
        apiUrl: 'http://localhost:11434',
        ollamaPid: null
    };
    
    try {
        fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
        console.log('📝 Created status file: ollama-status.json');
    } catch (error) {
        console.log('⚠️  Could not create status file:', error.message);
    }
}

// Enhanced shutdown function
function shutdownOllama() {
    console.log('🛑 Shutting down Ollama service...');
    
    // Try to kill the tracked process first
    if (ollamaProcess && !ollamaProcess.killed) {
        console.log(`🔄 Terminating Ollama process (PID: ${ollamaProcess.pid})...`);
        ollamaProcess.kill('SIGTERM');
        
        // Force kill after 5 seconds if it doesn't terminate gracefully
        setTimeout(() => {
            if (ollamaProcess && !ollamaProcess.killed) {
                console.log('💀 Force killing Ollama process...');
                ollamaProcess.kill('SIGKILL');
            }
        }, 5000);
    }
    
    // Also try system-wide cleanup as backup
    exec('pkill -f "ollama serve"', (error) => {
        if (error && error.code !== 1) {
            console.log('⚠️  System cleanup error:', error.message);
        } else if (error && error.code === 1) {
            console.log('ℹ️  No additional Ollama processes found');
        } else {
            console.log('✅ System cleanup completed');
        }
    });
    
    // Update status file
    try {
        const statusFile = path.join(__dirname, 'ollama-status.json');
        if (fs.existsSync(statusFile)) {
            const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            status.ollamaRunning = false;
            status.ollamaPid = null;
            fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
        }
    } catch (error) {
        console.log('⚠️  Could not update status file:', error.message);
    }
}

// Main setup function
async function main() {
    await createStatusFile();
    await setupOllama();
    
    // Update status file with PID if we have a process
    if (ollamaProcess) {
        try {
            const statusFile = path.join(__dirname, 'ollama-status.json');
            const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            status.ollamaPid = ollamaProcess.pid;
            status.ollamaRunning = true;
            fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
            console.log(`📋 Ollama PID ${ollamaProcess.pid} tracked in status file`);
        } catch (error) {
            console.log('⚠️  Could not update status file with PID:', error.message);
        }
    }
    
    // Exit gracefully to continue with server startup
    process.exit(0);
}

// Remove the shutdown handlers since we want ollama to keep running
// Comment out or remove these:
/*
process.on('SIGINT', () => {
    console.log('🛑 Setup interrupted');
    shutdownOllama();
    setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
    console.log('🛑 Setup terminated');
    shutdownOllama();
    setTimeout(() => process.exit(0), 1000);
});
*/

main().catch((error) => {
    console.error('❌ Setup failed:', error.message);
    shutdownOllama();
    process.exit(1);
}); 