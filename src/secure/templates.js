const awaitedScriptGenerator = function(payload, asyncTimeout) {
  return `(async () => {
    try {
        ${payload.code}
        await new Promise(resolve => setTimeout(resolve, ${asyncTimeout}));
    } catch (error) {
        console.error('❌ Execution error:', error.message);
        console.error('❌ Error type:', error.constructor.name);
        console.error('❌ Stack trace:', error.stack);
        if (error.code) console.error('❌ Error code:', error.code);
        if (error.errno) console.error('❌ Error number:', error.errno);
        if (error.syscall) console.error('❌ System call:', error.syscall);
        process.exit(1);
    }
})().then(() => {
    setTimeout(() => {
        process.exit(0);
    }, 200);
}).catch(error => {
    console.error('❌ Promise rejection:', error.message);
    console.error('❌ Promise rejection stack:', error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Promise Rejection at:', promise);
    console.error('❌ Reason:', reason);
    if (reason && reason.stack) {
        console.error('❌ Stack:', reason.stack);
    }
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    console.error('❌ Exception stack:', error.stack);
    console.error('❌ Exception type:', error.constructor.name);
    process.exit(1);
});`
}

const secureWrapperGenerator = function(payload, asyncTimeout) {
    return `const originalConsoleError = console.error;
const originalConsoleLog = console.log;
let capturedOutput = { stdout: '', stderr: '', data: null, errors: [] };

// Override console methods to capture output
console.log = (...args) => {
    const output = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    capturedOutput.stdout += output + '\\n';
    originalConsoleLog(...args);
};

console.error = (...args) => {
    const output = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    capturedOutput.stderr += output + '\\n';
    originalConsoleError(...args);
};

// Secure execution wrapper
(async () => {
    try {
        // Execute user code in isolated context
        const result = await (async () => {
            ${payload.code}
        })();

        // Capture any returned data
        if (result !== undefined) {
            capturedOutput.data = result;
        }

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, ${payload.asyncTimeout || 2000}));

    } catch (error) {
        // Capture error but filter sensitive information
        const safeError = {
            message: error.message || 'Unknown error',
            type: error.constructor.name,
            // Don't include stack trace or other details that might leak env vars
        };
        capturedOutput.errors.push(safeError);
        console.error('❌ Secure execution error:', safeError.message);
    }

    // Output results in a controlled format
    console.log('SECURE_EXECUTION_RESULT:', JSON.stringify(capturedOutput));
    process.exit(0);
})().catch(error => {
    console.error('❌ Secure execution wrapper error:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled rejection in secure execution');
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception in secure execution');
    process.exit(1);
});`;
}

const isolatedDataVariableGenerator = function(configCode) {
    return `
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Capture console output
let capturedOutput = { stdout: '', stderr: '', data: null, error: null };

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args) => {
    const output = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    capturedOutput.stdout += output + '\\n';
    originalConsoleLog(...args);
};

console.error = (...args) => {
    const output = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    capturedOutput.stderr += output + '\\n';
    originalConsoleError(...args);
};

async function executeDataVariable() {
    try {
        const config = ${configCode};

        // Prepare fetch options
        const fetchOptions = config.fetchOptions || {};
        const headers = config.headers || {};


        // Default to GET if no method specified
        const method = (fetchOptions.method || 'GET').toUpperCase();

        // Extract URL (could be in various places)
        const url = fetchOptions.url || config.url;
        if (!url) {
            throw new Error('No URL specified for data variable');
        }

        // Prepare request data
        const requestData = {
            method: method,
            headers: headers
        };

        if (fetchOptions.body && method !== 'GET' && method !== 'HEAD') {
            requestData.body = typeof fetchOptions.body === 'object' ?
                JSON.stringify(fetchOptions.body) : fetchOptions.body;

            if (!headers['Content-Type'] && typeof fetchOptions.body === 'object') {
                requestData.headers['Content-Type'] = 'application/json';
            }
        }

        // Make HTTP request using Node.js built-in modules
        const result = await makeHttpRequest(url, requestData);

        capturedOutput.data = {
            status: result.status,
            headers: result.headers,
            body: result.body,
            success: true
        };

    } catch (error) {
        capturedOutput.error = {
            message: error.message,
            type: error.constructor.name
        };
    }

    // Output the captured result
    console.log('ISOLATED_DATA_METHOD_RESULT:', JSON.stringify(capturedOutput));
    process.exit(0);
}

function makeHttpRequest(url, options) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method,
            headers: options.headers || {}
        };

        const req = client.request(reqOptions, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const body = data.length > 0 ? (
                        res.headers['content-type']?.includes('application/json') ?
                        JSON.parse(data) : data
                    ) : null;

                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: body
                    });
                } catch (parseError) {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: data
                    });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        // Write request body if present
        if (options.body) {
            req.write(options.body);
        }

        req.end();
    });
}

// Execute the data variable
executeDataVariable().catch(error => {
    console.error('❌ Data variable execution failed:', error.message);
    process.exit(1);
});
`;
}

const isolatedDataMethodCodeGenerator = function(resolvedConfig) {
    return `const https = require('https');
const http = require('http');
const { URL } = require('url');

// Capture console output
let capturedOutput = { stdout: '', stderr: '', data: null, error: null };

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args) => {
    const output = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    capturedOutput.stdout += output + '\\n';
    originalConsoleLog(...args);
};

console.error = (...args) => {
    const output = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' ');
    capturedOutput.stderr += output + '\\n';
    originalConsoleError(...args);
};

async function executeDataMethod() {
    try {
        const config = ${JSON.stringify(resolvedConfig)};

        // Prepare fetch options
        const fetchOptions = config.fetchOptions || {};
        const headers = config.headers || {};

        // Default to GET if no method specified
        const method = (fetchOptions.method || 'GET').toUpperCase();

        // Extract URL (could be in various places)
        const url = fetchOptions.url || config.url;
        if (!url) {
            throw new Error('No URL specified for data method');
        }

        // Prepare request data
        const requestData = {
            method: method,
            headers: headers
        };

        if (fetchOptions.body && method !== 'GET' && method !== 'HEAD') {
            requestData.body = typeof fetchOptions.body === 'object' ?
                JSON.stringify(fetchOptions.body) : fetchOptions.body;

            if (!headers['Content-Type'] && typeof fetchOptions.body === 'object') {
                requestData.headers['Content-Type'] = 'application/json';
            }
        }

        // Make HTTP request using Node.js built-in modules
        const result = await makeHttpRequest(url, requestData);

        capturedOutput.data = {
            status: result.status,
            headers: result.headers,
            body: result.body,
            success: true
        };

    } catch (error) {
        capturedOutput.error = {
            message: error.message,
            type: error.constructor.name
        };
    }

    // Output the captured result
    console.log('ISOLATED_DATA_METHOD_RESULT:', JSON.stringify(capturedOutput));
    process.exit(0);
}

function makeHttpRequest(url, options) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method,
            headers: options.headers || {}
        };

        const req = client.request(reqOptions, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const body = data.length > 0 ? (
                        res.headers['content-type']?.includes('application/json') ?
                        JSON.parse(data) : data
                    ) : null;

                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: body
                    });
                } catch (parseError) {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: data
                    });
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        // Write request body if present
        if (options.body) {
            req.write(options.body);
        }

        req.end();
    });
}

// Execute the data method
executeDataMethod().catch(error => {
    console.error('❌ Data method execution failed:', error.message);
    process.exit(1);
});
`
}

module.exports = { awaitedScriptGenerator, secureWrapperGenerator, isolatedDataVariableGenerator, isolatedDataMethodCodeGenerator };