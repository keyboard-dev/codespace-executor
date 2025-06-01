const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createProject } = require('./src/project-generator/create');
const { retrievePackageJson, retrieveEnvironmentVariableKeys } = require('./src/retrieve_resources');

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
                const packageJson = await retrievePackageJson(payload);
                const environmentVariableKeys = await retrieveEnvironmentVariableKeys(payload);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    packageJson,
                    environmentVariableKeys
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

        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                
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
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
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
                             codeToExecute.includes('setInterval');
    
    if (needsAsyncWrapper) {
        // Wrap in async IIFE and add proper exit handling
        codeToExecute = `
(async () => {
    try {
        ${payload.code}
        
        // Wait a bit for any pending async operations
        await new Promise(resolve => setTimeout(resolve, 100));
        
    } catch (error) {
        console.error('❌ Execution error:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
})().then(() => {
    // Give a moment for any final logs
    setTimeout(() => {
        console.log('\\n--- 🏁 Execution completed ---');
        process.exit(0);
    }, 50);
}).catch(error => {
    console.error('❌ Promise rejection:', error.message);
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Promise Rejection:', reason);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
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
                stderr: stderr
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
                    code
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
});
