const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
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

        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                
                if (payload.code) {
                    console.log(payload.code);
                    // Handle code execution
                    const tempFile = `temp_${Date.now()}.js`;
                    fs.writeFileSync(tempFile, payload.code);
                    executeProcess('node', [tempFile], res, () => fs.unlinkSync(tempFile));
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

// Helper function to execute processes
function executeProcess(cmd, args, res, cleanup = null) {
    const child = spawn(cmd, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
        stdout += data.toString();
    });

    child.stderr.on('data', data => {
        stderr += data.toString();
    });

    child.on('close', code => {
        if (cleanup) cleanup();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stdout, stderr, code }));
    });

    child.on('error', error => {
        if (cleanup) cleanup();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
