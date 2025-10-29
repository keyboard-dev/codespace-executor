import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import url from 'url';

// Import converted modules
import {
    retrievePackageJson,
    retrieveEnvironmentVariableKeys,
    retrieveDocResources
} from './retrieve_resources/index.js';
import { encrypt, decrypt, safeObfuscate } from './utils/crypto.js';
import { getKeyMetadata, decryptWithPrivateKey, encryptWithPublicKey, isKeyPairInitialized, tryDecrypt } from './utils/asymmetric-crypto.js';
import { verifyBearerToken, extractBearerToken } from './utils/auth.js';
import LocalLLM from './local_llm/local.js';
import JobManager from './jobs/JobManager.js';
import SecureExecutor from './secure/SecureExecutor.js';
import { bootUpServices, ServiceBootstrap } from './boot-up-services.js';

// Import types
import {
    ExecutionPayload,
    JobOptions,
    JobStatus,
    HeaderEnvVars,
    EncryptedResponse,
    FileInfo,
    JobResponse,
    JobListResponse,
    JobStatsResponse,
    ExecutionOptions
} from './types/index.js';

// Local LLM integration
const localLLM = new LocalLLM();

// Job system integration
let jobManager: JobManager | null = null;

// Secure execution system
let secureExecutor: SecureExecutor | null = null;

// Service bootstrap integration
let serviceBootstrap: ServiceBootstrap | null = null;

function getJobManager(): JobManager {
    if (!jobManager) {
        jobManager = new JobManager({
            maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '5'),
            jobTTL: (parseInt(process.env.JOB_TTL_HOURS || '24')) * 60 * 60 * 1000,
            enablePersistence: process.env.DISABLE_JOB_PERSISTENCE !== 'true'
        });
    }
    return jobManager;
}

function getSecureExecutor(): SecureExecutor {
    if (!secureExecutor) {
        secureExecutor = new SecureExecutor({
            timeout: 30000
        });
    }
    return secureExecutor;
}

// Legacy Ollama integration (keeping for backward compatibility)
let ollamaClient: any = null;
try {
    const { Ollama } = require('ollama');
    ollamaClient = new Ollama({ host: 'http://localhost:11434' });
} catch (error) {
    // Ollama not available
}

// 🚀 NEW: Start Ollama setup in background AFTER server is running
// function startOllamaSetupInBackground(): void {
//     try {
//         const setupProcess = spawn('node', ['setup-ollama.js'], {
//             detached: true,
//             stdio: ['ignore', 'pipe', 'pipe'],
//             cwd: __dirname
//         });
//         
//         // Optional: Log setup output (but don't block server)
//         setupProcess.stdout?.on('data', () => {
//             // Silent background setup
//         });
//         
//         setupProcess.stderr?.on('data', () => {
//             // Silent background setup
//         });
//         
//         setupProcess.on('close', () => {
//             // Silent background setup
//         });
//         
//         // Don't wait for the setup process - let it run independently
//         setupProcess.unref();
//         
//     } catch (error) {
//         // Don't fail server startup if Ollama setup fails
//     }
// }

const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse): void => {
    // Parse URL for better routing
    const parsedUrl = url.parse(req.url || '', true);
    const pathname = parsedUrl.pathname;

    // Serve index.html at root
    if (pathname === '/' && req.method === 'GET') {
        const indexPath = path.join(__dirname, '../../index.html');
        fs.readFile(indexPath, (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading index.html');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            }
        });
    }
    // API endpoint to list files in shareable_assets directory
    else if (pathname === '/files' && req.method === 'GET') {
        const assetsDir = path.join(__dirname, '../../shareable_assets');
        
        fs.readdir(assetsDir, { withFileTypes: true }, (err, entries) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to read directory', details: err.message }));
                return;
            }

            // Filter only files (not directories) and get their stats
            const filePromises = entries
                .filter(entry => entry.isFile())
                .map(entry => {
                    const filePath = path.join(assetsDir, entry.name);
                    return new Promise<FileInfo | null>((resolve) => {
                        fs.stat(filePath, (err, stats) => {
                            if (err) {
                                resolve(null);
                            } else {
                                resolve({
                                    name: entry.name,
                                    size: stats.size,
                                    modified: stats.mtime,
                                    created: stats.birthtime
                                });
                            }
                        });
                    });
                });

            Promise.all(filePromises).then(files => {
                const validFiles = files.filter(f => f !== null) as FileInfo[];
                res.writeHead(200, { 
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify({ files: validFiles }));
            });
        });
    }
    // Serve static files from shareable_assets directory
    else if (pathname?.startsWith('/shareable_assets/') && req.method === 'GET') {
        const fileName = pathname.slice('/shareable_assets/'.length);
        const filePath = path.join(__dirname, '../shareable_assets', fileName);

        // Security check to prevent directory traversal
        if (!filePath.startsWith(path.join(__dirname, '../shareable_assets'))) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File not found');
            } else {
                // Determine content type
                const ext = path.extname(fileName).toLowerCase();
                const contentTypes: Record<string, string> = {
                    '.html': 'text/html',
                    '.css': 'text/css',
                    '.js': 'application/javascript',
                    '.json': 'application/json',
                    '.png': 'image/png',
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif',
                    '.svg': 'image/svg+xml',
                    '.pdf': 'application/pdf',
                    '.txt': 'text/plain',
                    '.md': 'text/markdown'
                };
                const contentType = contentTypes[ext] || 'application/octet-stream';
                
                res.writeHead(200, { 
                    'Content-Type': contentType,
                    'Content-Disposition': `inline; filename="${fileName}"`
                });
                res.end(data);
            }
        });
    }
    else if (req.method === 'POST' && req.url === '/local-llm/initialize') {
        // Initialize Local LLM (start Ollama and ensure model is ready)
        (async (): Promise<void> => {
            try {
                const success = await localLLM.initialize();
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: success,
                    message: success ? 'Local LLM initialized successfully' : 'Failed to initialize Local LLM',
                    status: await localLLM.getStatus()
                }));
            } catch (error: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: error.message
                }));
            }
        })();
    } else if (req.method === 'GET' && req.url === '/local-llm/status') {
        // Get Local LLM status
        (async (): Promise<void> => {
            try {
                const status = await localLLM.getStatus();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(status));
            } catch (error: any) {
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
        req.on('end', async (): Promise<void> => {
            try {
                const { message, temperature, model } = JSON.parse(body);
                
                if (!message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Message is required' }));
                }

                const response = await localLLM.chat(message, { temperature, model });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));

            } catch (error: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: error.message
                }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/local-llm/stop') {
        // Stop Local LLM service
        (async (): Promise<void> => {
            try {
                const success = await localLLM.stop();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: success,
                    message: success ? 'Local LLM stopped successfully' : 'Failed to stop Local LLM'
                }));
            } catch (error: any) {
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
        req.on('end', async (): Promise<void> => {
            try {
                if (!ollamaClient) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Ollama service not available' }));
                }

                const { message, model = 'gemma3:1b' } = JSON.parse(body);
                
                if (!message) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Message is required' }));
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

            } catch (error: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Failed to chat with Ollama',
                    details: error.message
                }));
            }
        });
    } else if (req.method === 'GET' && req.url === '/ollama/status') {
        // Legacy Ollama status endpoint (updated for gemma3:1b)
        (async (): Promise<void> => {
            try {
                if (!ollamaClient) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        ollamaAvailable: false,
                        error: 'Ollama client not initialized'
                    }));
                }

                // Try to get list of models to check if service is running
                const models = await ollamaClient.list();
                const gemmaAvailable = models.models.some((model: any) => model.name.includes('gemma3'));

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ollamaAvailable: true,
                    gemmaAvailable: gemmaAvailable,
                    models: models.models.map((m: any) => m.name),
                    apiUrl: 'http://localhost:11434'
                }));

            } catch (error: any) {
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

        req.on('end', async (): Promise<void> => {
            try {
                const projectConfig = JSON.parse(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    message: 'Project created successfully',
                    projectPath: `codebases_projects/${projectConfig.title.toLowerCase().replace(/\s+/g, '-')}`
                }));
            } catch (error: any) {
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

        req.on('end', async (): Promise<void> => {
            try {
                JSON.parse(body); // Parse to validate JSON format
                const packageJson = await retrievePackageJson();
                const environmentVariableKeys = await retrieveEnvironmentVariableKeys();
                const docResources = await retrieveDocResources();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    "packageJson": packageJson,
                    "environmentVariableKeys": environmentVariableKeys,
                    "docResources": docResources,
                }));
            } catch (error: any) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Failed to retrieve package.json and environment variable keys',
                    details: error.message
                }));
            }
        });

    } else if (req.method === 'GET' && req.url === '/crypto/public-key') {
        // Get public encryption key (requires bearer token authentication)
        (async (): Promise<void> => {
            try {
                // Extract and verify bearer token
                const authHeader = req.headers['authorization'];
                const token = extractBearerToken(authHeader);

                if (!token) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Unauthorized',
                        message: 'Bearer token required. Please provide Authorization header with Bearer token.'
                    }));
                    return;
                }

                // Verify token against keyboard.dev auth service
                const isValid = await verifyBearerToken(token);
                if (!isValid) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Unauthorized',
                        message: 'Invalid or expired bearer token'
                    }));
                    return;
                }

                // Check if key pair is initialized
                if (!isKeyPairInitialized()) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Service Unavailable',
                        message: 'Encryption key pair not initialized. Server may still be starting up.'
                    }));
                    return;
                }

                // Return public key metadata
                const keyMetadata = getKeyMetadata();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    publicKey: keyMetadata.publicKey,
                    algorithm: keyMetadata.algorithm,
                    createdAt: keyMetadata.createdAt,
                    fingerprint: keyMetadata.fingerprint
                }));

            } catch (error: any) {
                console.error('❌ Error retrieving public key:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Internal Server Error',
                    message: 'Failed to retrieve public key',
                    details: error.message
                }));
            }
        })();

    } else if(req.method === 'POST' && req.url === '/execute') {
        let body = '';

        // Extract x-keyboard-provider-user-token-for-* headers
        const headerEnvVars: HeaderEnvVars = {};
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
                    
                    const headerValue = req.headers[headerName];
                    if (typeof headerValue === 'string') {
                        const decryptedValue = tryDecrypt(headerValue);
                        headerEnvVars[envVarName] = decryptedValue
                    }
                }
            });
            
        }
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async (): Promise<void> => {
            try {
                const payload: ExecutionPayload = JSON.parse(body);

                // Handle encryption (both asymmetric and symmetric)
                if (payload.encrypt_messages || payload.use_asymmetric_encryption) {
                    try {
                        // Determine which encryption method to use
                        const useAsymmetric = payload.use_asymmetric_encryption;

                        if (useAsymmetric) {
                            // Use asymmetric encryption (RSA)
                            if (!isKeyPairInitialized()) {
                                res.writeHead(503, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    error: 'Asymmetric encryption not available. Key pair not initialized.'
                                }));
                                return;
                            }

                            // Decrypt the code using private key
                            if (payload.code) {
                                try {
                                    payload.code = decryptWithPrivateKey(payload.code);
                                    
                                } catch (decryptError: any) {
                                    console.error('❌ Failed to decrypt code with private key:', decryptError.message);
                                    res.writeHead(400, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({
                                        error: 'Failed to decrypt code',
                                        details: decryptError.message
                                    }));
                                    return;
                                }
                            }
                        } else {
                            // Use symmetric encryption (AES) - legacy support
                            if (!process.env.KB_ENCRYPTION_SECRET) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    error: 'KB_ENCRYPTION_SECRET environment variable is required when encrypt_messages is true'
                                }));
                                return;
                            }

                            // Decrypt the code if it's encrypted
                            if (payload.code) {
                                try {
                                    payload.code = decrypt(payload.code);
                                    
                                } catch (decryptError: any) {
                                    console.error('❌ Failed to decrypt code:', decryptError.message);
                                    res.writeHead(400, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({
                                        error: 'Failed to decrypt code',
                                        details: decryptError.message
                                    }));
                                    return;
                                }
                            }
                        }
                    } catch (encryptionError: any) {
                        console.error('❌ Encryption setup error:', encryptionError.message);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: 'Encryption setup failed',
                            details: encryptionError.message
                        }));
                        return;
                    }
                }

                // const areResourcesValid = await checkIfResourcesAreValid(payload);
                // if (!areResourcesValid) {
                //     res.writeHead(400, { 'Content-Type': 'application/json' });
                //     res.end(JSON.stringify({ error: 'Resources are not valid, make sure you have the correct environment variables and doc resources before trying to execute' }));
                // }

                if (payload.code || payload.Global_code) {
                    // Check if background execution is requested
                    if (payload.background) {
                        // Submit as background job
                        try {
                            const jobPayload = {
                                ...payload,
                                headerEnvVars
                            };
                            
                            const jobOptions: JobOptions = {
                                priority: payload.priority || 'normal',
                                timeout: payload.timeout || 600000, // 10 minutes default for background jobs
                                maxRetries: payload.maxRetries || 0
                            };
                            
                            const jobId = getJobManager().createJob(jobPayload, jobOptions);
                            
                            let response: any = {
                                success: true,
                                background: true,
                                jobId: jobId,
                                status: 'PENDING',
                                message: 'Job submitted for background execution'
                            };

                            // Encrypt response if requested
                            if (payload.use_asymmetric_encryption) {
                                try {
                                    const responseString = JSON.stringify(response);
                                    const encryptedResponse = encryptWithPublicKey(responseString);
                                    response = {
                                        encrypted: true,
                                        data: encryptedResponse
                                    };
                                } catch (encryptError: any) {
                                    response.encryptionError = 'Failed to encrypt response: ' + encryptError.message;
                                }
                            } else if (payload.encrypt_messages) {
                                try {
                                    const responseString = JSON.stringify(response);
                                    const encryptedResponse = encrypt(responseString);
                                    response = {
                                        encrypted: true,
                                        data: encryptedResponse
                                    };
                                } catch (encryptError: any) {
                                    response.encryptionError = 'Failed to encrypt response: ' + encryptError.message;
                                }
                            }
                            
                            res.writeHead(201, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify(response));
                        } catch (error: any) {
                            console.error('❌ Error creating background job:', error);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                success: false,
                                error: 'Failed to create background job',
                                details: error.message
                            }));
                        }
                    } else {
                        // Enhanced code execution with secure or full mode based on feature flag
                        executeCodeWithSecureMode(payload, res, headerEnvVars);
                    }
                } else if (payload.command) {
                    // Handle command execution
                    const [cmd, ...args] = (payload.command || '').split(' ');
                    executeProcess(cmd, args, res);
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Either code or command is required' }));
                }
            } catch (err: any) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Looks there was an error did you review or look at docs before executing this request?' }));
            }
        });
    
    // Job management endpoints
    } else if (req.method === 'POST' && req.url === '/jobs') {
        // Submit new background job
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const payload: ExecutionPayload = JSON.parse(body);
                
                // Validate required fields
                if (!payload.code && !payload.command) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: 'Either code or command is required'
                    }));
                }
                
                // Handle encryption if encrypt_messages is true
                if (payload.encrypt_messages) {
                    try {
                        if (!process.env.KB_ENCRYPTION_SECRET) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                error: 'KB_ENCRYPTION_SECRET environment variable is required when encrypt_messages is true'
                            }));
                        }
                        
                        if (payload.code) {
                            try {
                                payload.code = decrypt(payload.code);
                            } catch (decryptError: any) {
                                res.writeHead(400, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    error: 'Failed to decrypt code',
                                    details: decryptError.message
                                }));
                            }
                        }
                    } catch (encryptionError: any) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: 'Encryption setup failed',
                            details: encryptionError.message
                        }));
                    }
                }
                
                // Extract headers for environment variables
                const headerEnvVars: HeaderEnvVars = {};
                if (req.headers) {
                    Object.keys(req.headers).forEach(headerName => {
                        if (headerName.toLowerCase().startsWith('x-keyboard-provider-user-token-for-')) {
                            const envVarName = headerName
                                .toLowerCase()
                                .replace('x-', '')
                                .toUpperCase()
                                .replace(/-/g, '_');
                            const headerValue = req.headers[headerName];
                            if (typeof headerValue === 'string') {
                                headerEnvVars[envVarName] = headerValue;
                            }
                        }
                    });
                }
                
                // Prepare job payload
                const jobPayload = {
                    ...payload,
                    headerEnvVars
                };
                
                const jobOptions: JobOptions = {
                    priority: payload.priority || 'normal',
                    timeout: payload.timeout || 600000, // 10 minutes default for background jobs
                    maxRetries: payload.maxRetries || 0
                };
                
                const jobId = getJobManager().createJob(jobPayload, jobOptions);
                
                let response: any = {
                    success: true,
                    jobId: jobId,
                    status: 'PENDING',
                    message: 'Job submitted successfully'
                };
                
                if (payload.encrypt_messages) {
                    try {
                        const responseString = JSON.stringify(response);
                        const encryptedResponse = encrypt(responseString);
                        response = {
                            encrypted: true,
                            data: encryptedResponse
                        };
                    } catch (encryptError: any) {
                        response.encryptionError = 'Failed to encrypt response: ' + encryptError.message;
                    }
                }
                
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
                
            } catch (error: any) {
                console.error('❌ Error creating job:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Failed to create job',
                    details: error.message
                }));
            }
        });
    
    } else if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
        // Get specific job status
        const pathParts = req.url.split('/');
        const jobId = pathParts[2]?.split('?')[0]; // Handle query params
        
        if (!jobId || jobId === 'stats') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Job ID is required' }));
        }
        
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const encryptMessages = url.searchParams.get('encrypt_messages') === 'true';
            
            const job = getJobManager().getJob(jobId);
            
            if (!job) {
                let response: any = { error: 'Job not found' };
                if (encryptMessages) {
                    try {
                        const responseString = JSON.stringify(response);
                        const encryptedResponse = encrypt(responseString);
                        response = {
                            encrypted: true,
                            data: encryptedResponse
                        };
                    } catch (encryptError: any) {
                        response.encryptionError = 'Failed to encrypt response: ' + encryptError.message;
                    }
                }
                
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            }
            
            // Create response with obfuscated sensitive data
            const jobResponse: JobResponse = {
                id: job.id,
                status: job.status,
                progress: job.progress,
                progressMessage: job.progressMessage,
                createdAt: job.createdAt,
                updatedAt: job.updatedAt,
                startedAt: job.startedAt,
                completedAt: job.completedAt
            };
            
            // Add results or error details based on status
            if (job.status === 'COMPLETED' && job.result) {
                jobResponse.result = {
                    stdout: safeObfuscate(job.result.stdout),
                    stderr: safeObfuscate(job.result.stderr),
                    code: job.result.code,
                    executionTime: job.result.executionTime,
                    aiAnalysis: job.result.aiAnalysis
                };
            } else if (job.status === 'FAILED' && job.error) {
                jobResponse.error = {
                    message: job.error.message,
                    type: job.error.type,
                    code: job.error.code as any,
                    stdout: safeObfuscate(job.error.stdout),
                    stderr: safeObfuscate(job.error.stderr)
                };
            }
            
            let response: any = {
                success: true,
                job: jobResponse
            };
            
            if (encryptMessages) {
                try {
                    const responseString = JSON.stringify(response);
                    const encryptedResponse = encrypt(responseString);
                    response = {
                        encrypted: true,
                        data: encryptedResponse
                    };
                } catch (encryptError: any) {
                    response.encryptionError = 'Failed to encrypt response: ' + encryptError.message;
                }
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            
        } catch (error: any) {
            console.error('❌ Error getting job:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Failed to get job',
                details: error.message
            }));
        }
    
    } else if (req.method === 'GET' && req.url?.startsWith('/jobs')) {
        // List all jobs
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const options = {
                status: url.searchParams.get('status') as JobStatus | null,
                limit: Math.min(parseInt(url.searchParams.get('limit') || '100') || 100, 1000),
                offset: parseInt(url.searchParams.get('offset') || '0') || 0
            };
            const encryptMessages = url.searchParams.get('encrypt_messages') === 'true';
            
            const result = getJobManager().getAllJobs(options);
            
            // Obfuscate sensitive data in job list
            const sanitizedJobs = result.jobs.map(job => ({
                id: job.id,
                status: job.status,
                progress: job.progress,
                progressMessage: job.progressMessage,
                createdAt: job.createdAt,
                updatedAt: job.updatedAt,
                startedAt: job.startedAt,
                completedAt: job.completedAt,
                hasResults: job.status === 'COMPLETED' && !!job.result,
                hasError: job.status === 'FAILED' && !!job.error
            }));
            
            let response: JobListResponse = {
                success: true,
                jobs: sanitizedJobs,
                pagination: {
                    total: result.total,
                    limit: options.limit,
                    offset: options.offset,
                    hasMore: result.hasMore
                }
            };
            
            if (encryptMessages) {
                try {
                    const responseString = JSON.stringify(response);
                    const encryptedResponse = encrypt(responseString);
                    response = {
                        encrypted: true,
                        data: encryptedResponse
                    } as any;
                } catch (encryptError: any) {
                    (response as any).encryptionError = 'Failed to encrypt response: ' + encryptError.message;
                }
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            
        } catch (error: any) {
            console.error('❌ Error listing jobs:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Failed to list jobs',
                details: error.message
            }));
        }
    
    } else if (req.method === 'DELETE' && req.url?.startsWith('/jobs/')) {
        // Cancel/delete specific job
        const pathParts = req.url.split('/');
        const jobId = pathParts[2];
        
        if (!jobId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Job ID is required' }));
        }
        
        try {
            const job = getJobManager().getJob(jobId);
            
            if (!job) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Job not found' }));
            }
            
            let result: any;
            let message: string;
            if (job.status === 'RUNNING' || job.status === 'PENDING') {
                // Cancel the job
                result = getJobManager().cancelJob(jobId);
                message = 'Job cancelled successfully';
            } else {
                // Delete completed/failed job
                getJobManager().deleteJob(jobId);
                result = { id: jobId, deleted: true };
                message = 'Job deleted successfully';
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: message,
                job: {
                    id: result.id,
                    status: result.status || 'DELETED'
                }
            }));
            
        } catch (error: any) {
            console.error('❌ Error deleting job:', error);
            const statusCode = error.message.includes('not found') ? 404 : 500;
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message.includes('not found') ? 'Job not found' : 'Failed to delete job',
                details: error.message
            }));
        }
    
    } else if (req.method === 'GET' && req.url === '/jobs-stats') {
        // Get job system statistics
        try {
            const stats = getJobManager().getStats();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                stats: stats
            } as JobStatsResponse));
        } catch (error: any) {
            console.error('❌ Error getting job stats:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: 'Failed to get job statistics',
                details: error.message
            }));
        }
        
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// New secure execution function with feature flag support
async function executeCodeWithSecureMode(
    payload: ExecutionPayload, 
    res: http.ServerResponse, 
    headerEnvVars: HeaderEnvVars = {}
): Promise<void> {
    try {
        const executor = getSecureExecutor();
        const result = await executor.executeCode(payload, headerEnvVars);

        // Handle encryption if requested
        let finalResult: any = result;
        if (payload.use_asymmetric_encryption) {
            try {
                const responseString = JSON.stringify(result);
                const encryptedResponse = encryptWithPublicKey(responseString);
                finalResult = {
                    encrypted: true,
                    data: encryptedResponse
                };
            } catch (encryptError: any) {
                console.error('❌ Failed to encrypt response with public key:', encryptError.message);
                (finalResult as any).encryptionError = 'Failed to encrypt response: ' + encryptError.message;
            }
        } else if (payload.encrypt_messages) {
            try {
                const responseString = JSON.stringify(result);
                const encryptedResponse = encrypt(responseString);
                finalResult = {
                    encrypted: true,
                    data: encryptedResponse
                };
            } catch (encryptError: any) {
                console.error('❌ Failed to encrypt response:', encryptError.message);
                (finalResult as any).encryptionError = 'Failed to encrypt response: ' + encryptError.message;
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResult));

    } catch (error: any) {
        console.error('❌ Secure execution error:', error);

        let errorResult: any = {
            success: false,
            error: error.error || 'Execution failed',
            details: error.details || error.message,
            executionMode: error.executionMode || 'unknown'
        };

        // Handle encryption for error response
        if (payload.use_asymmetric_encryption) {
            try {
                const errorString = JSON.stringify(errorResult);
                const encryptedError = encryptWithPublicKey(errorString);
                errorResult = {
                    encrypted: true,
                    data: encryptedError
                };
            } catch (encryptError: any) {
                console.error('❌ Failed to encrypt error response with public key:', encryptError.message);
                errorResult.encryptionError = 'Failed to encrypt error response: ' + encryptError.message;
            }
        } else if (payload.encrypt_messages) {
            try {
                const errorString = JSON.stringify(errorResult);
                const encryptedError = encrypt(errorString);
                errorResult = {
                    encrypted: true,
                    data: encryptedError
                };
            } catch (encryptError: any) {
                console.error('❌ Failed to encrypt error response:', encryptError.message);
                errorResult.encryptionError = 'Failed to encrypt error response: ' + encryptError.message;
            }
        }

        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(errorResult));
    }
}

// Enhanced code execution function with better async support (LEGACY - removed for now)

// Enhanced process execution with timeout and better error handling
function executeProcessWithTimeout(
    cmd: string, 
    args: string[], 
    res: http.ServerResponse, 
    cleanup: (() => void) | null = null, 
    options: ExecutionOptions = {}
): void {
    const timeout = options.timeout || 30000;
    
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
            
            let timeoutResult: any = { 
                error: 'Execution timeout',
                timeout: timeout,
                stdout: safeObfuscate(stdout),
                stderr: safeObfuscate(stderr),
                message: `Process timed out after ${timeout}ms. Consider increasing timeout or optimizing async operations.`
            };
            
            // Encrypt the timeout response if requested
            if (options.use_asymmetric_encryption) {
                try {
                    const timeoutString = JSON.stringify(timeoutResult);
                    const encryptedTimeout = encryptWithPublicKey(timeoutString);
                    timeoutResult = {
                        encrypted: true,
                        data: encryptedTimeout
                    };
                } catch (encryptError: any) {
                    console.error('❌ Failed to encrypt timeout response with public key:', encryptError.message);
                    timeoutResult.encryptionError = 'Failed to encrypt timeout response: ' + encryptError.message;
                }
            } else if (options.encrypt_messages) {
                try {
                    const timeoutString = JSON.stringify(timeoutResult);
                    const encryptedTimeout = encrypt(timeoutString);
                    timeoutResult = {
                        encrypted: true,
                        data: encryptedTimeout
                    };
                } catch (encryptError: any) {
                    console.error('❌ Failed to encrypt timeout response:', encryptError.message);
                    // Fall back to unencrypted timeout response with error indication
                    timeoutResult.encryptionError = 'Failed to encrypt timeout response: ' + encryptError.message;
                }
            }
            
            res.writeHead(408, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(timeoutResult));
        }
    }, timeout);
    
    child.stdout?.on('data', data => {
        stdout += data.toString();
    });

    child.stderr?.on('data', data => {
        stderr += data.toString();
    });

    child.on('close', async (code) => {
        if (!isCompleted) {
            isCompleted = true;
            clearTimeout(timeoutId);
            
            if (cleanup) cleanup();
            let aiAnalysis: any;
            if(options.ai_eval) {
                try {
                
                let outputsOfCodeExecution = `
                output of code execution: 

                <stdout>${safeObfuscate(stdout)}</stdout>
                
                <stderr>${safeObfuscate(stderr)}</stderr>`
                let result = await localLLM.analyzeResponse(JSON.stringify(outputsOfCodeExecution))
                aiAnalysis = result
                
                } catch(e) {

                }
            }

            let finalResult: any;
            try {
               finalResult = { 
                success: true,
                data: {
                    stdout: safeObfuscate(stdout), 
                    stderr: safeObfuscate(stderr), 
                    code,
                    aiAnalysis,
                    executionTime: Date.now() // Add execution timestamp
                }
            }

            
            // Encrypt the response if requested
            if (options.use_asymmetric_encryption) {
                try {
                    const responseString = JSON.stringify(finalResult);
                    const encryptedResponse = encryptWithPublicKey(responseString);
                    finalResult = {
                        encrypted: true,
                        data: encryptedResponse
                    };
                } catch (encryptError: any) {
                    console.error('❌ Failed to encrypt response with public key:', encryptError.message);
                    finalResult.encryptionError = 'Failed to encrypt response: ' + encryptError.message;
                }
            } else if (options.encrypt_messages) {
                try {
                    const responseString = JSON.stringify(finalResult);
                    const encryptedResponse = encrypt(responseString);
                    finalResult = {
                        encrypted: true,
                        data: encryptedResponse
                    };
                } catch (encryptError: any) {
                    console.error('❌ Failed to encrypt response:', encryptError.message);
                    // Fall back to unencrypted response with error indication
                    finalResult.encryptionError = 'Failed to encrypt response: ' + encryptError.message;
                }
            }
            
            } catch(e) {
    
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
            
            let errorResult: any = { 
                success: false,
                error: {
                    message: error.message,
                    type: error.constructor.name,
                    code: (error as any).code,
                    stdout: safeObfuscate(stdout),
                    stderr: safeObfuscate(stderr)
                }
            };
            
            // Encrypt the error response if requested
            if (options.use_asymmetric_encryption) {
                try {
                    const errorString = JSON.stringify(errorResult);
                    const encryptedError = encryptWithPublicKey(errorString);
                    errorResult = {
                        encrypted: true,
                        data: encryptedError
                    };
                } catch (encryptError: any) {
                    console.error('❌ Failed to encrypt error response with public key:', encryptError.message);
                    errorResult.encryptionError = 'Failed to encrypt error response: ' + encryptError.message;
                }
            } else if (options.encrypt_messages) {
                try {
                    const errorString = JSON.stringify(errorResult);
                    const encryptedError = encrypt(errorString);
                    errorResult = {
                        encrypted: true,
                        data: encryptedError
                    };
                } catch (encryptError: any) {
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
function executeProcess(cmd: string, args: string[], res: http.ServerResponse, cleanup: (() => void) | null = null): void {
    executeProcessWithTimeout(cmd, args, res, cleanup);
}

const PORT = process.env.PORT || 3000;

server.timeout = 600000; // 10 minutes in milliseconds
server.headersTimeout = 610000; // Slightly longer than server timeout
server.keepAliveTimeout = 605000; // Keep-alive timeout
server.listen(PORT, async () => {
    
    

    // 🎯 Boot up additional services (Ollama, WebSocket, etc.)
    try {
        serviceBootstrap = await bootUpServices();
        
    } catch (error: any) {
        
    }
});

// Graceful shutdown handler
async function shutdown(): Promise<void> {
    

    // Shutdown services first
    if (serviceBootstrap) {
        await serviceBootstrap.shutdown();
    }

    // Shutdown job manager
    if (jobManager) {
        jobManager.shutdown();
    }

    server.close(() => {
        
        process.exit(0);
    });

    // Force exit after 30 seconds
    setTimeout(() => {
        console.error('❌ Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGUSR2', shutdown); // Nodemon restart