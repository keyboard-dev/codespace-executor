const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);



class OllamaSetup {
    constructor() {
        this.apiUrl = 'http://127.0.0.1:11434';
        this.model = 'hf.co/unsloth/gemma-3n-E2B-it-GGUF:Q4_K_M';
        this.statusFile = path.join(__dirname, 'ollama-status.json');
        this.logFile = path.join(__dirname, 'ollama-startup.log');
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;

        try {
            fs.appendFileSync(this.logFile, logMessage + '\n');
        } catch (error) {
            // Ignore logging errors
        }
    }

    async updateStatus(updates) {
        try {
            let status = {
                installTime: new Date().toISOString(),
                ollamaInstalled: false,
                apiUrl: this.apiUrl,
                model: this.model
            };
            
            if (fs.existsSync(this.statusFile)) {
                status = JSON.parse(fs.readFileSync(this.statusFile, 'utf8'));
            }
            
            Object.assign(status, updates);
            fs.writeFileSync(this.statusFile, JSON.stringify(status, null, 2));
        } catch (error) {
            this.log(`⚠️  Could not update status file: ${error.message}`);
        }
    }

    async installOllama() {
        try {
            this.log('📦 Checking Ollama installation...');
            
            // Check if Ollama is already installed
            try {
                await execAsync('which ollama');
                this.log('✅ Ollama already installed');
                return true;
            } catch (error) {
                this.log('📥 Installing Ollama...');
                await execAsync('curl -fsSL https://ollama.com/install.sh | sh');
                this.log('✅ Ollama installed successfully');
                return true;
            }
        } catch (error) {
            this.log(`❌ Error installing Ollama: ${error.message}`);
            return false;
        }
    }

    async isOllamaRunning() {
        try {
            await execAsync(`curl -s ${this.apiUrl}/api/tags`);
            return true;
        } catch (error) {
            return false;
        }
    }

    async isModelAvailable() {
        try {
            const response = await execAsync(`curl -s ${this.apiUrl}/api/tags`);
            const data = JSON.parse(response.stdout);
            return data.models && data.models.some(model => 
                model.name.includes('gemma-3n-E2B-it') || 
                model.name.includes('unsloth') ||
                model.name === this.model
            );
        } catch (error) {
            return false;
        }
    }

    async startOllama() {
        this.log('🔄 Starting Ollama service...');
        
        try {
            // Check if already running
            if (await this.isOllamaRunning()) {
                this.log('✅ Ollama already running');
                return true;
            }

            // Start Ollama service in background
            const ollamaProcess = spawn('ollama', ['serve'], {
                detached: true,
                stdio: ['ignore', 'ignore', 'ignore'],
                env: {
                    ...process.env,
                    OLLAMA_HOST: '0.0.0.0:11434'
                }
            });
            
            ollamaProcess.unref();

            // Wait for service to start
            let attempts = 0;
            const maxAttempts = 15;
            
            while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                if (await this.isOllamaRunning()) {
                    this.log('✅ Ollama service started successfully');
                    return true;
                }
                attempts++;
                this.log(`⏳ Waiting for Ollama to start... (${attempts}/${maxAttempts})`);
            }
            
            throw new Error('Ollama service failed to start within timeout');
            
        } catch (error) {
            this.log(`❌ Failed to start Ollama: ${error.message}`);
            return false;
        }
    }

    async pullModel() {
        this.log(`📥 Checking if model ${this.model} is available...`);
        
        try {
            if (await this.isModelAvailable()) {
                this.log('✅ Model already available');
                return true;
            }

            this.log(`📥 Pulling model ${this.model} (this may take several minutes)...`);
            this.log('☕ This will run in the background, your server can start normally');
            
            await this.updateStatus({ 
                modelPullStarted: new Date().toISOString(),
                modelPullInProgress: true 
            });

            // Pull model with extended timeout
            await execAsync(`ollama pull ${this.model}`, { 
                timeout: 1800000 // 30 minute timeout
            });
            
            this.log(`✅ Successfully pulled model: ${this.model}`);
            await this.updateStatus({ 
                modelPullCompleted: new Date().toISOString(),
                modelPullInProgress: false,
                modelAvailable: true
            });
            
            return true;
            
        } catch (error) {
            this.log(`❌ Failed to pull model: ${error.message}`);
            await this.updateStatus({ 
                modelPullInProgress: false,
                modelPullError: error.message,
                modelPullErrorTime: new Date().toISOString()
            });
            
            // Don't fail the entire setup if model pull fails
            this.log('⚠️  Model pull failed, but Ollama is still available for manual model management');
            return false;
        }
    }

    async run() {
        this.log('🚀 Starting Ollama setup and model pull...');
        
        // Initialize status file
        await this.updateStatus({});
        
        // Install Ollama
        const installed = await this.installOllama();
        await this.updateStatus({ ollamaInstalled: installed });
        
        if (!installed) {
            this.log('❌ Ollama installation failed, exiting');
            process.exit(1);
        }

        // Start Ollama service
        const started = await this.startOllama();
        await this.updateStatus({ ollamaRunning: started });
        
        if (!started) {
            this.log('❌ Ollama service failed to start, exiting');
            process.exit(1);
        }

        // Pull model (non-blocking for setup completion)
        const modelPulled = await this.pullModel();
        
        if (installed && started) {
            this.log('🎉 Ollama setup complete!');
            this.log(`📍 API available at: ${this.apiUrl}`);
            if (modelPulled) {
                this.log(`🤖 Model ready: ${this.model}`);
            } else {
                this.log('💡 You can manually pull models using: ollama pull <model-name>');
            }
            this.log('📋 Check ollama-status.json for current status');
        }
        
        // Exit gracefully to continue with server startup
        process.exit(0);
    }
}

// Main execution
const setup = new OllamaSetup();
setup.run().catch((error) => {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
}); 