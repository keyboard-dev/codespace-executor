const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomBytes, createCipheriv, createDecipheriv } = require('crypto');
// const { createProject } = require('./src/project-generator/create');
const { retrievePackageJson, retrieveEnvironmentVariableKeys, retrieveDocResources, checkIfResourcesAreValid } = require('./src/retrieve_resources');
const { obfuscateSensitiveData } = require('./src/obfuscate');

// Encryption utilities
const ALGORITHM = 'aes-256-cbc';

function getEncryptionKey() {
    const key = process.env.KB_ENCRYPTION_SECRET;
    if (!key) {
        throw new Error('KB_ENCRYPTION_SECRET environment variable is required for encryption');
    }
    // If key is hex string, convert to buffer, otherwise use as is and pad/truncate to 32 bytes
    if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
        return Buffer.from(key, 'hex');
    } else {
        // Convert string to buffer and ensure it's 32 bytes
        const buffer = Buffer.from(key, 'utf8');
        if (buffer.length === 32) {
            return buffer;
        } else if (buffer.length < 32) {
            // Pad with zeros
            return Buffer.concat([buffer, Buffer.alloc(32 - buffer.length)]);
        } else {
            // Truncate to 32 bytes
            return buffer.slice(0, 32);
        }
    }
}

function encrypt(text) {
    try {
        const encryptionKey = getEncryptionKey();
        const iv = randomBytes(16);
        const cipher = createCipheriv(ALGORITHM, encryptionKey, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const ivString = iv.toString('hex');
        return ivString + ':' + encrypted;
    } catch (error) {
        console.error('Encryption error:', error);
        throw new Error('Failed to encrypt data');
    }
}

function decrypt(encryptedText) {
    try {
        const encryptionKey = getEncryptionKey();
        const [ivHex, encrypted] = encryptedText.split(':');
        
        if (!ivHex || !encrypted) {
            throw new Error('Invalid encrypted data format');
        }
        
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = createDecipheriv(ALGORITHM, encryptionKey, iv);
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        console.error('Decryption error:', error);
        throw new Error('Failed to decrypt data');
    }
}

// Local LLM integration
const LocalLLM = require('./src/local_llm/local');
const localLLM = new LocalLLM();

// Legacy Ollama integration (keeping for backward compatibility)
let ollamaClient = null;
try {
    const { Ollama } = require('ollama');
    ollamaClient = new Ollama({ host: 'http://localhost:11434' });
} catch (error) {

}

// 🚀 NEW: Start Ollama setup in background AFTER server is running
function startOllamaSetupInBackground() {

    
    try {
        const setupProcess = spawn('node', ['setup-ollama.js'], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: __dirname
        });
        
        // Optional: Log setup output (but don't block server)
        setupProcess.stdout.on('data', (data) => {

        });
        
        setupProcess.stderr.on('data', (data) => {

        });
        
        setupProcess.on('close', (code) => {

        });
        
        // Don't wait for the setup process - let it run independently
        setupProcess.unref();
        
    } catch (error) {

        // Don't fail server startup if Ollama setup fails
    }
}

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Hello World');
        }
    } else if (req.method === 'POST' && req.url === '/local-llm/initialize') {
        // Initialize Local LLM (start Ollama and ensure model is ready)
        (async () => {
            try {

                const success = await localLLM.initialize();
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: success,
                    message: success ? 'Local LLM initialized successfully' : 'Failed to initialize Local LLM',
                    status: await localLLM.getStatus()
                }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: error.message
                }));
            }
        })();
    } else if (req.method === 'GET' && req.url === '/local-llm/status') {
        // Get Local LLM status
        (async () => {
            try {
                const status = await localLLM.getStatus();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(status));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: error.message
                }));
            }
        })();
    } else if (req.method === 'POST' && req.url === '/local-llm/chat') {
        // Chat with Local LLM
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const { message, temperature, model } = JSON.parse(body);
                
                if (!message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Message is required' }));
                }

                const response = await localLLM.chat(message, { temperature, model });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));

            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: error.message
                }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/local-llm/stop') {
        // Stop Local LLM service
        (async () => {
            try {
                const success = await localLLM.stop();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: success,
                    message: success ? 'Local LLM stopped successfully' : 'Failed to stop Local LLM'
                }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: error.message
                }));
            }
        })();
    } else if (req.method === 'POST' && req.url === '/ollama/chat') {
        // Legacy Ollama chat endpoint (updated to use gemma3:1b by default)
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                if (!ollamaClient) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Ollama service not available' }));
                }

                const { message, model = 'gemma3:1b', stream = false } = JSON.parse(body);
                
                if (!message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Message is required' }));
                }

                const response = await ollamaClient.chat({
                    model: model,
                    messages: [{ role: 'user', content: message }],
                    stream: false
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    response: response.message.content,
                    model: model
                }));

            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Failed to chat with Ollama',
                    details: error.message
                }));
            }
        });
    } else if (req.method === 'GET' && req.url === '/ollama/status') {
        // Legacy Ollama status endpoint (updated for gemma3:1b)
        (async () => {
            try {
                if (!ollamaClient) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ 
                        ollamaAvailable: false,
                        error: 'Ollama client not initialized'
                    }));
                }

                // Try to get list of models to check if service is running
                const models = await ollamaClient.list();
                const gemmaAvailable = models.models.some(model => model.name.includes('gemma3'));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ollamaAvailable: true,
                    gemmaAvailable: gemmaAvailable,
                    models: models.models.map(m => m.name),
                    apiUrl: 'http://localhost:11434'
                }));

            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ollamaAvailable: false,
                    error: error.message
                }));
            }
        })();
    } else if (req.method === 'POST' && req.url === '/create_project') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const projectConfig = JSON.parse(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    message: 'Project created successfully',
                    projectPath: `codebases_projects/${projectConfig.title.toLowerCase().replace(/\s+/g, '-')}`
                }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    error: 'Failed to create project',
                    details: error.message 
                }));
            }
        });
    } else if(req.method === 'POST' && req.url === '/fetch_key_name_and_resources') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);
                const packageJson = await retrievePackageJson();
                const environmentVariableKeys = await retrieveEnvironmentVariableKeys();
                const docResources = await retrieveDocResources();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    "packageJson": packageJson,
                    "environmentVariableKeys": environmentVariableKeys,
                    "docResources": docResources,
                }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    error: 'Failed to retrieve package.json and environment variable keys',
                    details: error.message 
                }));
            }
        });
    
    } else if(req.method === 'POST' && req.url === '/execute') {
        let body = '';

        // Extract x-keyboard-provider-user-token-for-* headers
        const headerEnvVars = {};
        if (req.headers) {
            Object.keys(req.headers).forEach(headerName => {
                // Check if this is an x-keyboard-provider-user-token-for- header
                if (headerName.toLowerCase().startsWith('x-keyboard-provider-user-token-for-')) {
                    // Convert header name to environment variable format
                    // x-keyboard-provider-user-token-for-google -> KEYBOARD_PROVIDER_USER_TOKEN_FOR_GOOGLE
                    const envVarName = headerName
                        .toLowerCase()
                        .replace('x-', '') // Remove the x- prefix
                        .toUpperCase()
                        .replace(/-/g, '_'); // Replace hyphens with underscores
                    
                    headerEnvVars[envVarName] = req.headers[headerName];

                }
            });
        }

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async() => {
            try {
                const payload = JSON.parse(body);

                // Handle encryption if encrypt_messages is true
                if (payload.encrypt_messages) {
                    try {
                        // Check if KB_ENCRYPTION_SECRET is available
                        if (!process.env.KB_ENCRYPTION_SECRET) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            return res.end(JSON.stringify({ 
                                error: 'KB_ENCRYPTION_SECRET environment variable is required when encrypt_messages is true' 
                            }));
                        }

                        // Decrypt the code if it's encrypted
                        if (payload.code) {
                            try {
                                payload.code = decrypt(payload.code);

                            } catch (decryptError) {
                                console.error('❌ Failed to decrypt code:', decryptError.message);
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                return res.end(JSON.stringify({ 
                                    error: 'Failed to decrypt code', 
                                    details: decryptError.message 
                                }));
                            }
                        }
                    } catch (encryptionError) {
                        console.error('❌ Encryption setup error:', encryptionError.message);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ 
                            error: 'Encryption setup failed', 
                            details: encryptionError.message 
                        }));
                    }
                }

                // const areResourcesValid = await checkIfResourcesAreValid(payload);
                // if (!areResourcesValid) {
                //     res.writeHead(400, { 'Content-Type': 'application/json' });
                //     return res.end(JSON.stringify({ error: 'Resources are not valid, make sure you have the correct environment variables and doc resources before trying to execute' }));
                // }

                if (payload.code) {

                    // Enhanced code execution with async support
                    console.log(payload)
                    executeCodeWithAsyncSupport(payload, res, headerEnvVars);
                } else if (payload.command) {
                    // Handle command execution
                    const [cmd, ...args] = payload.command.split(' ');
                    executeProcess(cmd, args, res);
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Either code or command is required' }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Looks there was an error did you review or look at docs before executing this request?' }));
            }
        });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// Enhanced code execution function with better async support
async function executeCodeWithAsyncSupport(payload, res, headerEnvVars = {}) {
    const tempFile = `temp_${Date.now()}.js`;
    let codeToExecute = payload.code;
    
    // Check if code needs async wrapper
    const needsAsyncWrapper = codeToExecute.includes('await') || 
                             codeToExecute.includes('Promise') ||
                             codeToExecute.includes('.then(') ||
                             codeToExecute.includes('setTimeout') ||
                             codeToExecute.includes('setInterval') ||
                             codeToExecute.includes('https.request') ||
                             codeToExecute.includes('fetch(');
    
    if (needsAsyncWrapper) {
        // Configurable async timeout - default 5 seconds for API calls
        const asyncTimeout = payload.asyncTimeout || 5000;
        
        // Wrap in async IIFE and add proper exit handling
        codeToExecute = `
(async () => {
    try {
        ${payload.code}
        
        // Wait for any pending async operations (configurable timeout)
        await new Promise(resolve => setTimeout(resolve, ${asyncTimeout}));
        
    } catch (error) {
        console.error('❌ Execution error:', error.message);
        console.error('❌ Error type:', error.constructor.name);
        console.error('❌ Stack trace:', error.stack);
        
        // Try to log additional error details
        if (error.code) console.error('❌ Error code:', error.code);
        if (error.errno) console.error('❌ Error number:', error.errno);
        if (error.syscall) console.error('❌ System call:', error.syscall);
        
        process.exit(1);
    }
})().then(() => {
    // Give a moment for any final logs
    setTimeout(() => {

        process.exit(0);
    }, 200);
}).catch(error => {
    console.error('❌ Promise rejection:', error.message);
    console.error('❌ Promise rejection stack:', error.stack);
    process.exit(1);
});

// Handle unhandled promise rejections with more details
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Promise Rejection at:', promise);
    console.error('❌ Reason:', reason);
    if (reason && reason.stack) {
        console.error('❌ Stack:', reason.stack);
    }
    process.exit(1);
});

// Handle uncaught exceptions with more details
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    console.error('❌ Exception stack:', error.stack);
    console.error('❌ Exception type:', error.constructor.name);
    process.exit(1);
});
`;
    }
    
    try {
        fs.writeFileSync(tempFile, codeToExecute);
        const allowedEnvVars = [
            'PATH',
            'HOME',
            'USER',
            'NODE_ENV',
            'TZ',
            'LANG',
            'LC_ALL',
            'PWD',
            'TMPDIR',
            'TEMP',
            'TMP'
        ];
        
        // Create limited environment with only allowed variables
        const limitedEnv = {};
        
        // Add basic allowed environment variables
        allowedEnvVars.forEach(key => {
            if (process.env[key]) {
                limitedEnv[key] = process.env[key];
            }
        });
        
        // Add all environment variables that start with "KEYBOARD"
        Object.keys(process.env).forEach(key => {
            if (key.startsWith('KEYBOARD')) {
                limitedEnv[key] = process.env[key];
            }
        });

        // Add extracted headers as environment variables
        if (headerEnvVars && typeof headerEnvVars === 'object') {
            Object.keys(headerEnvVars).forEach(key => {
                limitedEnv[key] = headerEnvVars[key];

            });
        }
        
        // Enhanced execution with timeout
        executeProcessWithTimeout('node', [tempFile], res, () => {
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {
                // File might already be deleted
            }
        }, {
            timeout: payload.timeout || 30000, // 30 second default timeout
            env: { ...limitedEnv }, // Allow custom environment variables
            ai_eval: payload.ai_eval || false, // Enable AI evaluation of output
            encrypt_messages: payload.encrypt_messages || false // Enable response encryption
        });
        
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            error: 'Failed to write temporary file',
            details: error.message 
        }));
    }
}

// Enhanced process execution with timeout and better error handling
function executeProcessWithTimeout(cmd, args, res, cleanup = null, options = {}) {
    const timeout = options.timeout || 30000;
    
    // Define allowed environment variables for security

    
    // Allow specific custom env vars from payload if they're safe
    const safeCustomEnvVars = ['NODE_OPTIONS', 'DEBUG'];

    
    const child = spawn(cmd, args, { env: options?.env || {}});
    let stdout = '';
    let stderr = '';
    let isCompleted = false;
    
    
    // Set up timeout
    const timeoutId = setTimeout(() => {
        if (!isCompleted) {
            isCompleted = true;
            child.kill('SIGTERM');
            
            if (cleanup) cleanup();
            
            let timeoutResult = { 
                error: 'Execution timeout',
                timeout: timeout,
                stdout: obfuscateSensitiveData(stdout),
                stderr: obfuscateSensitiveData(stderr),
                message: `Process timed out after ${timeout}ms. Consider increasing timeout or optimizing async operations.`
            };
            
            // Encrypt the timeout response if encrypt_messages is true
            if (options.encrypt_messages) {
                try {
                    const timeoutString = JSON.stringify(timeoutResult);
                    const encryptedTimeout = encrypt(timeoutString);
                    timeoutResult = {
                        encrypted: true,
                        data: encryptedTimeout
                    };

                } catch (encryptError) {
                    console.error('❌ Failed to encrypt timeout response:', encryptError.message);
                    // Fall back to unencrypted timeout response with error indication
                    timeoutResult.encryptionError = 'Failed to encrypt timeout response: ' + encryptError.message;
                }
            }
            
            res.writeHead(408, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(timeoutResult));
        }
    }, timeout);
    
    child.stdout.on('data', data => {
        stdout += data.toString();
    });

    child.stderr.on('data', data => {
        stderr += data.toString();
    });

    child.on('close', async (code) => {
        if (!isCompleted) {
            isCompleted = true;
            clearTimeout(timeoutId);
            
            if (cleanup) cleanup();
            let aiAnalysis;
            console.log(options)
            if(options.ai_eval) {
                try {
                console.log("AI EVALUATION")
                let outputsOfCodeExecution = `
                output of code execution: 

                <stdout>${obfuscateSensitiveData(stdout)}</stdout>
                
                <stderr>${obfuscateSensitiveData(stderr)}</stderr>`
                let result = await localLLM.analyzeResponse(JSON.stringify(outputsOfCodeExecution))
                console.log("this is the result", result)
                aiAnalysis = result
                
                } catch(e) {
                    console.log("this is the error")
                    console.log(e)
                }
            }

            let finalResult;
            try {
               finalResult = { 
                success: true,
                data: {
                    stdout: obfuscateSensitiveData(stdout), 
                    stderr: obfuscateSensitiveData(stderr), 
                    code,
                    aiAnalysis,
                    executionTime: Date.now() // Add execution timestamp
                }
            }
            console.log(finalResult)
            
            // Encrypt the response if encrypt_messages is true
            if (options.encrypt_messages) {
                try {
                    const responseString = JSON.stringify(finalResult);
                    const encryptedResponse = encrypt(responseString);
                    finalResult = {
                        encrypted: true,
                        data: encryptedResponse
                    };

                } catch (encryptError) {
                    console.error('❌ Failed to encrypt response:', encryptError.message);
                    // Fall back to unencrypted response with error indication
                    finalResult.encryptionError = 'Failed to encrypt response: ' + encryptError.message;
                }
            }
            
            } catch(e) {
                console.log(e)
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(finalResult));
        }
    });

    child.on('error', error => {
        if (!isCompleted) {
            isCompleted = true;
            clearTimeout(timeoutId);
            
            if (cleanup) cleanup();
            
            let errorResult = { 
                success: false,
                error: {
                    message: error.message,
                    type: error.constructor.name,
                    code: error.code,
                    stdout: obfuscateSensitiveData(stdout),
                    stderr: obfuscateSensitiveData(stderr)
                }
            };
            
            // Encrypt the error response if encrypt_messages is true
            if (options.encrypt_messages) {
                try {
                    const errorString = JSON.stringify(errorResult);
                    const encryptedError = encrypt(errorString);
                    errorResult = {
                        encrypted: true,
                        data: encryptedError
                    };

                } catch (encryptError) {
                    console.error('❌ Failed to encrypt error response:', encryptError.message);
                    // Fall back to unencrypted error response with error indication
                    errorResult.encryptionError = 'Failed to encrypt error response: ' + encryptError.message;
                }
            }
            
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errorResult));
        }
    });
}

// Original helper function for backward compatibility
function executeProcess(cmd, args, res, cleanup = null) {
    executeProcessWithTimeout(cmd, args, res, cleanup);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {


    
    // 🎯 KEY: Start Ollama setup ONLY after server is confirmed running
 
});