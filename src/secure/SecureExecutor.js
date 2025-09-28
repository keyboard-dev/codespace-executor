const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { safeObfuscate } = require('../utils/crypto');

class SecureExecutor {
    constructor(options = {}) {
        this.defaultTimeout = options.timeout || 30000;
        this.tempDir = options.tempDir || path.join(__dirname, '../../temp');

        // Rate limiting for data methods
        this.dataMethodRateLimit = new Map(); // Track execution counts per method
        this.maxDataMethodExecutionsPerHour = options.maxDataMethodExecutionsPerHour || 100;

        // Security validation settings
        this.maxDataMethods = options.maxDataMethods || 10;
        this.maxDataMethodTimeout = options.maxDataMethodTimeout || 15000;

        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * Analyze code to detect if it uses environment variables or external APIs
     */
    analyzeCodeSecurity(code) {
        const securityPatterns = {
            // Environment variable access
            envAccess: /process\.env\./g,

            // External API calls
            fetch: /fetch\s*\(/g,
            httpRequest: /https?\.(request|get|post)/g,
            axios: /axios\./g,

            // Node.js modules that might use env vars
            nodeModules: /require\s*\(\s*['"`](https?|fs|path|os|crypto|child_process)['"`]\s*\)/g,

            // Dynamic imports that might access env
            dynamicImport: /import\s*\(/g,

            // Console or process methods that might leak info
            processAccess: /process\.(argv|cwd|exit|env)/g
        };

        const analysis = {
            hasEnvironmentAccess: false,
            hasExternalApiCalls: false,
            hasNodeModuleUsage: false,
            riskLevel: 'low',
            patterns: []
        };

        for (const [patternName, regex] of Object.entries(securityPatterns)) {
            const matches = code.match(regex);
            if (matches) {
                analysis.patterns.push({
                    type: patternName,
                    matches: matches.length,
                    samples: matches.slice(0, 3) // First 3 matches for debugging
                });

                if (patternName === 'envAccess' || patternName === 'processAccess') {
                    analysis.hasEnvironmentAccess = true;
                }
                if (patternName === 'fetch' || patternName === 'httpRequest' || patternName === 'axios') {
                    analysis.hasExternalApiCalls = true;
                }
                if (patternName === 'nodeModules' || patternName === 'dynamicImport') {
                    analysis.hasNodeModuleUsage = true;
                }
            }
        }

        // Determine risk level
        if (analysis.hasEnvironmentAccess && analysis.hasExternalApiCalls) {
            analysis.riskLevel = 'high';
        } else if (analysis.hasEnvironmentAccess || analysis.hasExternalApiCalls) {
            analysis.riskLevel = 'medium';
        }

        return analysis;
    }

    /**
     * Execute code with security isolation if needed
     */
    async executeCode(payload, headerEnvVars = {}) {
        // Check for new secure data methods payload structure
        if (payload.Secure_data_methods && payload.Global_code) {
            return this.executeSecureWithDataMethods(payload, headerEnvVars);
        }

        const codeAnalysis = this.analyzeCodeSecurity(payload.code);

        // Check environment variable at runtime for dynamic switching
        const enableSecureExecution = process.env.KEYBOARD_FULL_CODE_EXECUTION !== 'true';

        // If secure execution is disabled, use full execution
        if (!enableSecureExecution) {
            return this.executeCodeFull(payload, headerEnvVars, codeAnalysis);
        }

        // If code doesn't access environment or external APIs, use normal execution
        if (codeAnalysis.riskLevel === 'low') {
            return this.executeCodeNormal(payload, headerEnvVars, codeAnalysis);
        }

        // High/medium risk code uses secure isolation
        return this.executeCodeSecure(payload, headerEnvVars, codeAnalysis);
    }

    /**
     * Execute code with secure two-phase execution and isolated data methods
     */
    async executeSecureWithDataMethods(payload, headerEnvVars = {}) {
        return new Promise(async (resolve, reject) => {
            try {
                // Phase 1: Execute secure data methods in isolation
                const sanitizedDataMethods = await this.executeDataMethodsPhase(payload.Secure_data_methods, headerEnvVars);

                // Phase 2: Execute global code with access to sanitized data
                const result = await this.executeGlobalCodePhase(payload.Global_code, sanitizedDataMethods, payload);

                resolve(result);
            } catch (error) {
                reject({
                    error: 'Secure execution with data methods failed',
                    details: error.message,
                    executionMode: 'secure-two-phase'
                });
            }
        });
    }

    /**
     * Full execution mode (original behavior)
     */
    async executeCodeFull(payload, headerEnvVars = {}, codeAnalysis = null) {
        return new Promise((resolve, reject) => {
            const tempFile = `temp_full_${Date.now()}_${randomBytes(8).toString('hex')}.js`;
            const tempPath = path.join(this.tempDir, tempFile);

            let codeToExecute = payload.code;

            // Apply async wrapper if needed (same logic as original)
            const needsAsyncWrapper = codeToExecute.includes('await') ||
                                     codeToExecute.includes('Promise') ||
                                     codeToExecute.includes('.then(') ||
                                     codeToExecute.includes('setTimeout') ||
                                     codeToExecute.includes('setInterval') ||
                                     codeToExecute.includes('https.request') ||
                                     codeToExecute.includes('fetch(');

            if (needsAsyncWrapper) {
                const asyncTimeout = payload.asyncTimeout || 5000;
                codeToExecute = `
(async () => {
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
});`;
            }

            try {
                fs.writeFileSync(tempPath, codeToExecute);

                // Full environment access (original behavior)
                const allowedEnvVars = [
                    'PATH', 'HOME', 'USER', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'PWD', 'TMPDIR', 'TEMP', 'TMP'
                ];

                const limitedEnv = {};
                allowedEnvVars.forEach(key => {
                    if (process.env[key]) {
                        limitedEnv[key] = process.env[key];
                    }
                });

                // Add KEYBOARD env vars
                Object.keys(process.env).forEach(key => {
                    if (key.startsWith('KEYBOARD')) {
                        limitedEnv[key] = process.env[key];
                    }
                });

                // Add header env vars
                if (headerEnvVars && typeof headerEnvVars === 'object') {
                    Object.assign(limitedEnv, headerEnvVars);
                }

                this.executeProcess('node', [tempPath], {
                    timeout: payload.timeout || this.defaultTimeout,
                    env: limitedEnv,
                    ai_eval: payload.ai_eval || false,
                    encrypt_messages: payload.encrypt_messages || false,
                    executionMode: 'full',
                    codeAnalysis
                }).then(result => {
                    this.cleanup(tempPath);
                    resolve(result);
                }).catch(error => {
                    this.cleanup(tempPath);
                    reject(error);
                });

            } catch (error) {
                this.cleanup(tempPath);
                reject({
                    error: 'Failed to write temporary file',
                    details: error.message
                });
            }
        });
    }

    /**
     * Normal execution for low-risk code
     */
    async executeCodeNormal(payload, headerEnvVars = {}, codeAnalysis = null) {
        return this.executeCodeFull(payload, headerEnvVars, codeAnalysis);
    }

    /**
     * Secure execution with environment isolation
     */
    async executeCodeSecure(payload, headerEnvVars = {}, codeAnalysis = null) {
        return new Promise((resolve, reject) => {
            const tempFile = `temp_secure_${Date.now()}_${randomBytes(8).toString('hex')}.js`;
            const tempPath = path.join(this.tempDir, tempFile);

            // Wrap code to capture and filter results
            const secureWrapper = `
const originalConsoleError = console.error;
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

            try {
                fs.writeFileSync(tempPath, secureWrapper);

                // Minimal environment for secure execution
                const secureEnv = {
                    PATH: process.env.PATH,
                    NODE_ENV: process.env.NODE_ENV || 'production',
                    TZ: process.env.TZ,
                    LANG: process.env.LANG,
                    PWD: process.env.PWD
                };

                // Only add specific required env vars based on analysis
                if (codeAnalysis && codeAnalysis.hasEnvironmentAccess) {
                    // Add only safe KEYBOARD env vars (not the full set)
                    const safeKeyboardVars = ['KEYBOARD_PROVIDER_API_ENDPOINT'];
                    Object.keys(process.env).forEach(key => {
                        if (key.startsWith('KEYBOARD') && safeKeyboardVars.includes(key)) {
                            secureEnv[key] = process.env[key];
                        }
                    });

                    // Add specific header env vars if they're deemed safe
                    if (headerEnvVars && typeof headerEnvVars === 'object') {
                        Object.keys(headerEnvVars).forEach(key => {
                            // Only add non-sensitive looking env vars
                            if (!key.toLowerCase().includes('token') && !key.toLowerCase().includes('secret')) {
                                secureEnv[key] = headerEnvVars[key];
                            }
                        });
                    }
                }

                this.executeProcess('node', [tempPath], {
                    timeout: payload.timeout || this.defaultTimeout,
                    env: secureEnv,
                    ai_eval: payload.ai_eval || false,
                    encrypt_messages: payload.encrypt_messages || false,
                    executionMode: 'secure',
                    codeAnalysis
                }).then(result => {
                    // Parse and filter the secure execution result
                    const filteredResult = this.filterSecureExecutionResult(result);
                    this.cleanup(tempPath);
                    resolve(filteredResult);
                }).catch(error => {
                    this.cleanup(tempPath);
                    reject(error);
                });

            } catch (error) {
                this.cleanup(tempPath);
                reject({
                    error: 'Failed to write secure temporary file',
                    details: error.message
                });
            }
        });
    }

    /**
     * Filter results from secure execution to remove sensitive data
     */
    filterSecureExecutionResult(result) {
        try {
            // Look for the secure execution result in stdout
            const stdout = result.data?.stdout || '';
            const secureResultMatch = stdout.match(/SECURE_EXECUTION_RESULT: (.+)/);

            if (secureResultMatch) {
                const capturedOutput = JSON.parse(secureResultMatch[1]);

                // Return filtered, safe result
                return {
                    success: true,
                    data: {
                        stdout: this.sanitizeOutput(capturedOutput.stdout),
                        stderr: this.sanitizeOutput(capturedOutput.stderr),
                        result: capturedOutput.data,
                        errors: capturedOutput.errors,
                        code: result.data?.code || 0,
                        executionTime: result.data?.executionTime,
                        aiAnalysis: result.data?.aiAnalysis,
                        executionMode: 'secure',
                        securityFiltered: true
                    }
                };
            }
        } catch (parseError) {
            // If parsing fails, return sanitized original result
            console.error('Failed to parse secure execution result:', parseError.message);
        }

        // Fallback: return heavily sanitized version of original result
        return {
            success: result.success,
            data: {
                stdout: this.sanitizeOutput(result.data?.stdout || ''),
                stderr: this.sanitizeOutput(result.data?.stderr || ''),
                code: result.data?.code,
                executionTime: result.data?.executionTime,
                aiAnalysis: result.data?.aiAnalysis,
                executionMode: 'secure',
                securityFiltered: true,
                fallback: true
            }
        };
    }

    /**
     * Enhanced output sanitization for secure execution
     */
    sanitizeOutput(output) {
        if (!output) return output;

        // Use existing obfuscation plus additional patterns
        let sanitized = safeObfuscate(output);

        // Additional patterns for environment variable leakage
        const envPatterns = [
            // Environment variable values in error messages
            /KEYBOARD_[A-Z_]+=['"][^'"]*['"]/gi,
            /process\.env\.[A-Z_]+=['"][^'"]*['"]/gi,

            // API endpoints that might contain sensitive info
            /https?:\/\/[^\s]*api[^\s]*\/[^\s]*/gi,

            // Common error patterns that might leak env info
            /Error: connect ECONNREFUSED [^\s]+/gi,
            /Error: getaddrinfo ENOTFOUND [^\s]+/gi,

            // File paths that might contain sensitive info
            /\/[^\s]*\/\.[^\/\s]+/gi,
        ];

        envPatterns.forEach(pattern => {
            sanitized = sanitized.replace(pattern, '[FILTERED_FOR_SECURITY]');
        });

        return sanitized;
    }

    /**
     * Execute process with enhanced security monitoring
     */
    async executeProcess(cmd, args, options = {}) {
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, args, { env: options.env || {} });
            let stdout = '';
            let stderr = '';
            let isCompleted = false;

            const timeout = options.timeout || this.defaultTimeout;
            const timeoutId = setTimeout(() => {
                if (!isCompleted) {
                    isCompleted = true;
                    child.kill('SIGTERM');

                    reject({
                        error: 'Execution timeout',
                        timeout: timeout,
                        stdout: this.sanitizeOutput(stdout),
                        stderr: this.sanitizeOutput(stderr),
                        executionMode: options.executionMode || 'unknown'
                    });
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

                    try {
                        let result = {
                            success: true,
                            data: {
                                stdout: options.executionMode === 'secure' ? stdout : this.sanitizeOutput(stdout),
                                stderr: options.executionMode === 'secure' ? stderr : this.sanitizeOutput(stderr),
                                code,
                                executionTime: Date.now(),
                                executionMode: options.executionMode || 'normal',
                                codeAnalysis: options.codeAnalysis
                            }
                        };

                        // AI analysis if requested
                        if (options.ai_eval) {
                            try {
                                const LocalLLM = require('../local_llm/local');
                                const localLLM = new LocalLLM();
                                const outputsOfCodeExecution = `
                                output of code execution:
                                <stdout>${this.sanitizeOutput(stdout)}</stdout>
                                <stderr>${this.sanitizeOutput(stderr)}</stderr>`;
                                result.data.aiAnalysis = await localLLM.analyzeResponse(JSON.stringify(outputsOfCodeExecution));
                            } catch (e) {
                                result.data.aiAnalysisError = 'AI analysis failed';
                            }
                        }

                        resolve(result);
                    } catch (error) {
                        reject({
                            error: 'Processing execution result failed',
                            details: error.message
                        });
                    }
                }
            });

            child.on('error', error => {
                if (!isCompleted) {
                    isCompleted = true;
                    clearTimeout(timeoutId);

                    reject({
                        success: false,
                        error: {
                            message: error.message,
                            type: error.constructor.name,
                            code: error.code,
                            stdout: this.sanitizeOutput(stdout),
                            stderr: this.sanitizeOutput(stderr),
                            executionMode: options.executionMode || 'unknown'
                        }
                    });
                }
            });
        });
    }

    /**
     * Phase 1: Execute secure data methods in isolation with full credential access
     */
    async executeDataMethodsPhase(secureDataMethods, headerEnvVars = {}) {
        // Security validation for data methods payload
        this.validateSecureDataMethodsPayload(secureDataMethods);

        const sanitizedDataMethods = {};

        for (const [methodName, methodConfig] of Object.entries(secureDataMethods)) {
            try {
                // Check rate limits
                if (!this.checkDataMethodRateLimit(methodName)) {
                    sanitizedDataMethods[methodName] = {
                        error: true,
                        message: 'Rate limit exceeded for data method',
                        type: 'rate_limit_error'
                    };
                    continue;
                }

                // Validate method configuration
                this.validateDataMethodConfig(methodConfig);

                // Execute the data method in isolation
                const rawResult = await this.executeIsolatedDataMethod(methodName, methodConfig, headerEnvVars);

                // Sanitize the result (strip sensitive data)
                sanitizedDataMethods[methodName] = this.sanitizeDataMethodResult(rawResult);

                // Update rate limit tracking
                this.updateDataMethodRateLimit(methodName);

            } catch (error) {
                // Create safe error message without exposing sensitive details
                sanitizedDataMethods[methodName] = {
                    error: true,
                    message: 'Data method execution failed',
                    type: 'execution_error'
                };
                console.error(`❌ Data method ${methodName} failed:`, error.message);
            }
        }

        return sanitizedDataMethods;
    }

    /**
     * Validate the overall secure data methods payload for security
     */
    validateSecureDataMethodsPayload(secureDataMethods) {
        if (!secureDataMethods || typeof secureDataMethods !== 'object') {
            throw new Error('Secure_data_methods must be an object');
        }

        const methodNames = Object.keys(secureDataMethods);

        // Limit number of data methods
        if (methodNames.length > this.maxDataMethods) {
            throw new Error(`Too many data methods. Maximum allowed: ${this.maxDataMethods}`);
        }

        // Validate method names (no special characters, reasonable length)
        methodNames.forEach(methodName => {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(methodName)) {
                throw new Error(`Invalid data method name: ${methodName}`);
            }

            if (methodName.length > 50) {
                throw new Error(`Data method name too long: ${methodName}`);
            }

            // Prevent reserved JavaScript keywords/names
            const reservedNames = ['constructor', 'prototype', '__proto__', 'eval', 'Function'];
            if (reservedNames.includes(methodName)) {
                throw new Error(`Reserved method name not allowed: ${methodName}`);
            }
        });
    }

    /**
     * Check rate limit for data method execution
     */
    checkDataMethodRateLimit(methodName) {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;

        if (!this.dataMethodRateLimit.has(methodName)) {
            return true; // First execution, allow
        }

        const methodHistory = this.dataMethodRateLimit.get(methodName);

        // Clean old entries (older than 1 hour)
        const recentExecutions = methodHistory.filter(timestamp => (now - timestamp) < oneHour);
        this.dataMethodRateLimit.set(methodName, recentExecutions);

        return recentExecutions.length < this.maxDataMethodExecutionsPerHour;
    }

    /**
     * Update rate limit tracking for data method
     */
    updateDataMethodRateLimit(methodName) {
        const now = Date.now();

        if (!this.dataMethodRateLimit.has(methodName)) {
            this.dataMethodRateLimit.set(methodName, []);
        }

        const methodHistory = this.dataMethodRateLimit.get(methodName);
        methodHistory.push(now);
        this.dataMethodRateLimit.set(methodName, methodHistory);
    }

    /**
     * Validate data method configuration for security
     */
    validateDataMethodConfig(config) {
        if (!config || typeof config !== 'object') {
            throw new Error('Invalid data method configuration');
        }

        // Validate fetchOptions if present
        if (config.fetchOptions) {
            if (typeof config.fetchOptions !== 'object') {
                throw new Error('fetchOptions must be an object');
            }

            // Validate method
            if (config.fetchOptions.method) {
                const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
                if (!allowedMethods.includes(config.fetchOptions.method.toUpperCase())) {
                    throw new Error('Invalid HTTP method');
                }
            }
        }

        // Validate headers
        if (config.headers && typeof config.headers !== 'object') {
            throw new Error('Headers must be an object');
        }
    }

    /**
     * Execute a single data method in isolation with credential access
     */
    async executeIsolatedDataMethod(methodName, methodConfig, headerEnvVars) {
        return new Promise((resolve, reject) => {
            const tempFile = `temp_data_method_${Date.now()}_${randomBytes(8).toString('hex')}.js`;
            const tempPath = path.join(this.tempDir, tempFile);

            // Create isolated execution code for the data method
            const isolatedCode = this.generateIsolatedDataMethodCode(methodName, methodConfig);

            try {
                fs.writeFileSync(tempPath, isolatedCode);

                // Create environment for isolated execution with full credential access
                const isolatedEnv = this.createIsolatedEnvironment(headerEnvVars);

                this.executeProcess('node', [tempPath], {
                    timeout: this.maxDataMethodTimeout, // Configurable timeout for data method
                    env: isolatedEnv,
                    executionMode: 'isolated-data-method'
                }).then(result => {
                    this.cleanup(tempPath);
                    resolve(this.parseIsolatedDataMethodResult(result));
                }).catch(error => {
                    this.cleanup(tempPath);
                    reject(error);
                });

            } catch (error) {
                this.cleanup(tempPath);
                reject(error);
            }
        });
    }

    /**
     * Generate isolated execution code for a data method
     */
    generateIsolatedDataMethodCode(methodName, methodConfig) {
        // Resolve environment variables in configuration
        const resolvedConfig = this.resolveEnvironmentVariables(methodConfig);

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
`;
    }

    /**
     * Resolve environment variables in configuration
     */
    resolveEnvironmentVariables(config) {
        const resolved = JSON.parse(JSON.stringify(config)); // Deep clone

        const resolveValue = (value) => {
            if (typeof value === 'string') {
                // Replace environment variable references
                return value.replace(/process\.env\.([A-Z_]+)/g, (match, envVar) => {
                    return process.env[envVar] || '';
                });
            }
            return value;
        };

        const resolveObject = (obj) => {
            for (const [key, value] of Object.entries(obj)) {
                if (typeof value === 'object' && value !== null) {
                    resolveObject(value);
                } else {
                    obj[key] = resolveValue(value);
                }
            }
        };

        resolveObject(resolved);
        return resolved;
    }

    /**
     * Create isolated environment for data method execution
     */
    createIsolatedEnvironment(headerEnvVars) {
        // Start with minimal base environment
        const isolatedEnv = {
            PATH: process.env.PATH,
            NODE_ENV: process.env.NODE_ENV || 'production',
            TZ: process.env.TZ,
            LANG: process.env.LANG
        };

        // Add all KEYBOARD environment variables for credential access
        Object.keys(process.env).forEach(key => {
            if (key.startsWith('KEYBOARD')) {
                isolatedEnv[key] = process.env[key];
            }
        });

        // Add header environment variables
        if (headerEnvVars && typeof headerEnvVars === 'object') {
            Object.assign(isolatedEnv, headerEnvVars);
        }

        return isolatedEnv;
    }

    /**
     * Parse the result from isolated data method execution
     */
    parseIsolatedDataMethodResult(executionResult) {
        try {
            const stdout = executionResult.data?.stdout || '';
            const match = stdout.match(/ISOLATED_DATA_METHOD_RESULT: (.+)/);

            if (match) {
                return JSON.parse(match[1]);
            }
        } catch (parseError) {
            console.error('Failed to parse isolated data method result:', parseError.message);
        }

        // Fallback: return execution result as-is but mark as unparsed
        return {
            data: null,
            error: {
                message: 'Failed to parse data method result',
                type: 'parse_error'
            },
            unparsed: true,
            rawResult: executionResult
        };
    }

    /**
     * Sanitize data method result to remove all sensitive information
     * This is the critical security boundary - NO sensitive data should pass through
     */
    sanitizeDataMethodResult(rawResult) {
        try {
            // If there was an error in execution, return safe error
            if (rawResult.error) {
                return {
                    error: true,
                    message: 'Data method execution failed',
                    type: 'execution_error'
                };
            }

            // If we have data, sanitize it thoroughly
            if (rawResult.data && rawResult.data.success) {
                const sanitizedData = this.extractSafeDataOnly(rawResult.data);

                return {
                    success: true,
                    data: sanitizedData,
                    sanitized: true
                };
            }

            // Fallback: return generic error
            return {
                error: true,
                message: 'No data available',
                type: 'no_data'
            };

        } catch (sanitizationError) {
            console.error('❌ Data sanitization failed:', sanitizationError.message);
            return {
                error: true,
                message: 'Data sanitization failed',
                type: 'sanitization_error'
            };
        }
    }

    /**
     * Extract only safe data from API response, removing ALL sensitive information
     */
    extractSafeDataOnly(responseData) {
        // CRITICAL: This function must NEVER allow sensitive data to pass through

        const safeData = {};

        // Only extract the body/payload, never headers or status details that might leak info
        if (responseData.body) {
            safeData.body = this.sanitizeResponseBody(responseData.body);
        }

        // Include basic success indicators (safe)
        if (responseData.status) {
            // Only include status code ranges, not exact codes that might leak info
            if (responseData.status >= 200 && responseData.status < 300) {
                safeData.success = true;
            } else {
                safeData.success = false;
                safeData.error = 'Request failed';
            }
        }

        return safeData;
    }

    /**
     * Sanitize response body to remove any potential sensitive data
     */
    sanitizeResponseBody(body) {
        if (!body) return null;

        try {
            // If it's a string, check for common sensitive patterns
            if (typeof body === 'string') {
                return this.sanitizeStringContent(body);
            }

            // If it's an object, recursively sanitize
            if (typeof body === 'object') {
                return this.sanitizeObjectContent(body);
            }

            // For other types (numbers, booleans), return as-is (safe)
            return body;

        } catch (error) {
            console.error('❌ Body sanitization failed:', error.message);
            return { error: 'Content could not be sanitized' };
        }
    }

    /**
     * Sanitize string content to remove sensitive patterns
     */
    sanitizeStringContent(content) {
        let sanitized = content;

        // Remove common sensitive patterns
        const sensitivePatterns = [
            // API keys and tokens
            /\b[A-Za-z0-9]{32,}\b/g,
            /bearer\s+[A-Za-z0-9._-]+/gi,
            /token[\s]*[:=][\s]*['"]*[A-Za-z0-9._-]+['"]*$/gim,
            /key[\s]*[:=][\s]*['"]*[A-Za-z0-9._-]+['"]*$/gim,

            // Environment variable references
            /process\.env\.[A-Z_]+/g,

            // URLs with potential credentials
            /https?:\/\/[^\s]*:[^\s]*@[^\s]+/g,

            // Common secret patterns
            /secret[\s]*[:=][\s]*['"]*[^\s'"]+['"]*$/gim,
            /password[\s]*[:=][\s]*['"]*[^\s'"]+['"]*$/gim,
        ];

        sensitivePatterns.forEach(pattern => {
            sanitized = sanitized.replace(pattern, '[REDACTED]');
        });

        return sanitized;
    }

    /**
     * Sanitize object content recursively
     */
    sanitizeObjectContent(obj) {
        if (Array.isArray(obj)) {
            return obj.map(item => this.sanitizeResponseBody(item));
        }

        const sanitized = {};
        const sensitiveKeys = [
            'authorization', 'auth', 'token', 'key', 'secret', 'password',
            'credential', 'bearer', 'x-api-key', 'x-auth-token',
            'access_token', 'refresh_token', 'api_key', 'private_key'
        ];

        for (const [key, value] of Object.entries(obj)) {
            const lowerKey = key.toLowerCase();

            // Skip entirely if key looks sensitive
            if (sensitiveKeys.some(sensitiveKey => lowerKey.includes(sensitiveKey))) {
                sanitized[key] = '[REDACTED]';
                continue;
            }

            // Recursively sanitize the value
            sanitized[key] = this.sanitizeResponseBody(value);
        }

        return sanitized;
    }

    /**
     * Phase 2: Execute global code with access to sanitized data methods
     */
    async executeGlobalCodePhase(globalCode, sanitizedDataMethods, originalPayload) {
        return new Promise((resolve, reject) => {
            const tempFile = `temp_global_${Date.now()}_${randomBytes(8).toString('hex')}.js`;
            const tempPath = path.join(this.tempDir, tempFile);

            // Generate the global code with data method injection
            const globalCodeWithInjections = this.generateGlobalCodeWithDataMethods(globalCode, sanitizedDataMethods);

            try {
                fs.writeFileSync(tempPath, globalCodeWithInjections);

                // Create secure environment for global code (NO credentials)
                const secureEnv = this.createSecureGlobalEnvironment();

                this.executeProcess('node', [tempPath], {
                    timeout: originalPayload.timeout || 30000,
                    env: secureEnv,
                    executionMode: 'secure-global-phase'
                }).then(result => {
                    // Parse and filter the global execution result
                    const filteredResult = this.filterGlobalExecutionResult(result, sanitizedDataMethods);
                    this.cleanup(tempPath);
                    resolve(filteredResult);
                }).catch(error => {
                    this.cleanup(tempPath);
                    reject(error);
                });

            } catch (error) {
                this.cleanup(tempPath);
                reject(error);
            }
        });
    }

    /**
     * Generate global code with injected data method functions
     */
    generateGlobalCodeWithDataMethods(globalCode, sanitizedDataMethods) {
        // Create function injections for each data method
        const methodInjections = Object.entries(sanitizedDataMethods).map(([methodName, methodData]) => {
            return `
// Injected data method: ${methodName}
async function ${methodName}() {
    const methodData = ${JSON.stringify(methodData)};

    if (methodData.error) {
        throw new Error(methodData.message || 'Data method failed');
    }

    return methodData.data || methodData;
}`;
        }).join('\n');

        return `
// Secure Global Code Execution Environment
// NO CREDENTIALS OR SENSITIVE DATA IS AVAILABLE HERE

const capturedOutput = { stdout: '', stderr: '', data: null, errors: [] };

// Override console methods to capture output
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

// Inject sanitized data methods
${methodInjections}

// Execute global code in secure context
(async () => {
    try {
        const result = await (async () => {
            ${globalCode}
        })();

        // Capture any returned data
        if (result !== undefined) {
            capturedOutput.data = result;
        }

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 1000));

    } catch (error) {
        // Capture error without sensitive information
        const safeError = {
            message: error.message || 'Unknown error',
            type: error.constructor.name,
            // Intentionally NO stack trace to prevent info leakage
        };
        capturedOutput.errors.push(safeError);
        console.error('❌ Global code execution error:', safeError.message);
    }

    // Output results in controlled format
    console.log('SECURE_GLOBAL_EXECUTION_RESULT:', JSON.stringify(capturedOutput));
    process.exit(0);
})().catch(error => {
    console.error('❌ Global execution wrapper error:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled rejection in global execution');
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception in global execution');
    process.exit(1);
});`;
    }

    /**
     * Create secure environment for global code execution (NO credentials)
     */
    createSecureGlobalEnvironment() {
        // Minimal environment with NO access to credentials
        const secureEnv = {
            PATH: process.env.PATH,
            NODE_ENV: process.env.NODE_ENV || 'production',
            TZ: process.env.TZ,
            LANG: process.env.LANG,
            PWD: process.env.PWD
        };

        // Explicitly NO KEYBOARD environment variables
        // This ensures global code cannot access any credentials

        return secureEnv;
    }

    /**
     * Filter and parse global execution result
     */
    filterGlobalExecutionResult(executionResult, sanitizedDataMethods) {
        try {
            const stdout = executionResult.data?.stdout || '';
            const match = stdout.match(/SECURE_GLOBAL_EXECUTION_RESULT: (.+)/);

            if (match) {
                const capturedOutput = JSON.parse(match[1]);

                return {
                    success: true,
                    data: {
                        stdout: this.sanitizeOutput(capturedOutput.stdout),
                        stderr: this.sanitizeOutput(capturedOutput.stderr),
                        result: capturedOutput.data,
                        errors: capturedOutput.errors,
                        code: executionResult.data?.code || 0,
                        executionTime: executionResult.data?.executionTime,
                        executionMode: 'secure-two-phase',
                        dataMethodsUsed: Object.keys(sanitizedDataMethods),
                        securityFiltered: true
                    }
                };
            }
        } catch (parseError) {
            console.error('Failed to parse global execution result:', parseError.message);
        }

        // Fallback: return sanitized original result
        return {
            success: executionResult.success,
            data: {
                stdout: this.sanitizeOutput(executionResult.data?.stdout || ''),
                stderr: this.sanitizeOutput(executionResult.data?.stderr || ''),
                code: executionResult.data?.code,
                executionTime: executionResult.data?.executionTime,
                executionMode: 'secure-two-phase',
                securityFiltered: true,
                fallback: true
            }
        };
    }

    /**
     * Clean up temporary files
     */
    cleanup(filePath) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (error) {
            console.error('Failed to cleanup temp file:', error.message);
        }
    }

    /**
     * Get current execution mode info
     */
    getExecutionInfo() {
        const enableSecureExecution = process.env.KEYBOARD_FULL_CODE_EXECUTION !== 'true';
        return {
            secureExecutionEnabled: enableSecureExecution,
            fullCodeExecution: !enableSecureExecution,
            environmentFlag: process.env.KEYBOARD_FULL_CODE_EXECUTION || 'false',
            tempDirectory: this.tempDir
        };
    }
}

module.exports = SecureExecutor;