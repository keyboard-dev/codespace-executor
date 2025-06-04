const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createProject } = require('./src/project-generator/create');
const { retrievePackageJson, retrieveEnvironmentVariableKeys, retrieveDocResources, checkIfResourcesAreValid } = require('./src/retrieve_resources');

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Hello World');
        }
    } else if (req.method === 'POST' && req.url === '/create_project') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const projectConfig = JSON.parse(body);
                await createProject(projectConfig);
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

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async() => {
            try {
                const payload = JSON.parse(body);

                const areResourcesValid = await checkIfResourcesAreValid(payload);
                if (!areResourcesValid) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Resources are not valid, make sure you have the correct environment variables and doc resources before trying to execute' }));
                }

                if (payload.code) {
                    console.log(payload.code);
                    // Enhanced code execution with async support
                    executeCodeWithAsyncSupport(payload, res);
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
function executeCodeWithAsyncSupport(payload, res) {
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
        console.log('\\n--- 🏁 Execution completed ---');
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
        
        // Enhanced execution with timeout
        executeProcessWithTimeout('node', [tempFile], res, () => {
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {
                // File might already be deleted
            }
        }, {
            timeout: payload.timeout || 30000, // 30 second default timeout
            env: { ...process.env, ...payload.env } // Allow custom environment variables
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
    const env = options.env || process.env;
    
    const child = spawn(cmd, args, { env });
    let stdout = '';
    let stderr = '';
    let isCompleted = false;
    
    // Set up timeout
    const timeoutId = setTimeout(() => {
        if (!isCompleted) {
            isCompleted = true;
            child.kill('SIGTERM');
            
            if (cleanup) cleanup();
            res.writeHead(408, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: 'Execution timeout',
                timeout: timeout,
                stdout: stdout,
                stderr: stderr,
                message: `Process timed out after ${timeout}ms. Consider increasing timeout or optimizing async operations.`
            }));
        }
    }, timeout);
    
    child.stdout.on('data', data => {
        stdout += data.toString();
    });

    child.stderr.on('data', data => {
        stderr += data.toString();
    });

    child.on('close', code => {
        if (!isCompleted) {
            isCompleted = true;
            clearTimeout(timeoutId);
            
            if (cleanup) cleanup();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: true,
                data: {
                    stdout, 
                    stderr, 
                    code,
                    executionTime: Date.now() // Add execution timestamp
                }
            }));
        }
    });

    child.on('error', error => {
        if (!isCompleted) {
            isCompleted = true;
            clearTimeout(timeoutId);
            
            if (cleanup) cleanup();
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                success: false,
                error: {
                    message: error.message,
                    type: error.constructor.name,
                    code: error.code,
                    stdout: stdout,
                    stderr: stderr
                }
            }));
        }
    });
}

// Original helper function for backward compatibility
function executeProcess(cmd, args, res, cleanup = null) {
    executeProcessWithTimeout(cmd, args, res, cleanup);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Enhanced server running at http://localhost:${PORT}/`);
    console.log(`📝 Available endpoints:`);
    console.log(`   GET  /                           - Hello World`);
    console.log(`   POST /create_project             - Create new project`);
    console.log(`   POST /fetch_key_name_and_resources - Get package.json and env vars`);
    console.log(`   POST /execute                    - Execute code or commands`);
    console.log(`🔧 Async improvements:`);
    console.log(`   - Configurable async timeout (default: 5000ms)`);
    console.log(`   - Better error reporting and stack traces`);
    console.log(`   - Enhanced HTTPS/API call detection`);
});
