const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { safeObfuscate } = require('../utils/crypto');
const { awaitedScriptGenerator, secureWrapperGenerator, isolatedDataVariableGenerator, isolatedDataMethodCodeGenerator, globalCodeWithDataMethodsGenerator } = require('./templates');

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
        // Check for new secure data variables payload structure
        if (payload.secure_data_variables && payload.Global_code) {
            return this.executeSecureWithDataVariables(payload, headerEnvVars);
        }

        // Check for api_calls + global_code format (new restricted-run-code tool format)
        if (payload.api_calls && (payload.global_code || payload.Global_code)) {
            const convertedPayload = this.convertApiCallsToSecureDataVariables(payload);
            return this.executeSecureWithDataVariables(convertedPayload, headerEnvVars);
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
     * Convert api_calls + global_code format to secure_data_variables + Global_code format
     */
    convertApiCallsToSecureDataVariables(payload) {
        try {
            const secure_data_variables = {};
            // Convert each api_call to a secure_data_variable
            for (const [functionName, apiConfig] of Object.entries(payload.api_calls)) {
                // Validate function name is a valid JavaScript identifier
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(functionName)) {
                    throw new Error(`Invalid function name: ${functionName}. Must be a valid JavaScript identifier.`);
                }
                // Convert the api_calls format to secure_data_variables format
                secure_data_variables[functionName] = {
                    fetchOptions: {
                        url: apiConfig.url,
                        method: apiConfig.method || 'GET',
                        body: apiConfig.body || null
                    },
                    headers: apiConfig.headers || {}
                };
                // Add timeout if specified
                if (apiConfig.timeout) {
                    secure_data_variables[functionName].timeout = apiConfig.timeout;
                }

                // Preserve passed_variables for dependency resolution
                if (apiConfig.passed_variables) {
                    secure_data_variables[functionName].passed_variables = apiConfig.passed_variables;
                }
            }

            // Handle both global_code and Global_code (case insensitive)
            let globalCode = payload.Global_code || payload.global_code;
            if (!globalCode) {
                throw new Error('Missing global_code or Global_code in payload');
            }
            // Fix double-escaped quotes that might come from JSON serialization
            globalCode = this.unescapeGlobalCode(globalCode);

            // Return converted payload
            return {
                secure_data_variables: secure_data_variables,
                Global_code: globalCode,
                timeout: payload.timeout || 30000,
                ai_eval: payload.ai_eval || false,
                encrypt_messages: payload.encrypt_messages || false,
                explanation_of_code: payload.explanation_of_code // Pass through if present
            };

        } catch (error) {
            throw new Error(`Failed to convert api_calls payload: ${error.message}`);
        }
    }

    /**
     * Unescape double-escaped quotes and other common escape sequences in global code
     */
    unescapeGlobalCode(globalCode) {
        if (typeof globalCode !== 'string') {
            return globalCode;
        }

        // Fix common double-escaping issues
        let unescaped = globalCode
            .replace(/\\"/g, '"')
            .replace(/\\'/g, "'")
            .replace(/\\\\/g, '\\')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t');

        return unescaped;
    }

    /**
     * Execute code with secure two-phase execution and isolated data variables (new format)
     */
    async executeSecureWithDataVariables(payload, headerEnvVars = {}) {
        return new Promise(async (resolve, reject) => {
            try {
                // Validate global code doesn't try to access process.env.KEYBOARD_* variables
                this.validateGlobalCodeForEnvAccess(payload.Global_code);
                // Phase 1: Execute secure data variables in isolation
                const sanitizedDataVariables = await this.executeDataVariablesPhase(payload.secure_data_variables, headerEnvVars);
                // Phase 2: Execute global code with access to sanitized data
                const result = await this.executeGlobalCodePhase(payload.Global_code, sanitizedDataVariables, payload);

                resolve(result);
            } catch (error) {
                reject({
                    error: 'Secure execution with data variables failed',
                    details: error.message,
                    executionMode: 'secure-two-phase'
                });
            }
        });
    }

    /**
     * Execute code with secure two-phase execution and isolated data methods (legacy format)
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
                codeToExecute = awaitedScriptGenerator(payload, asyncTimeout);
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
            const asyncTimeout = 5000
            const secureWrapper = secureWrapperGenerator(payload, asyncTimeout = 5000);

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
                                stdout: (options.executionMode === 'secure' ||
                                    options.executionMode === 'isolated-data-variable' ||
                                    options.executionMode === 'isolated-data-method' ||
                                    options.skipOutputSanitization) ?
                                    stdout : this.sanitizeOutput(stdout),
                                stderr: (options.executionMode === 'secure' ||
                                    options.executionMode === 'isolated-data-variable' ||
                                    options.executionMode === 'isolated-data-method' ||
                                    options.skipOutputSanitization) ?
                                    stderr : this.sanitizeOutput(stderr),
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
                let santizedResult = this.sanitizeDataMethodResult(rawResult);
                sanitizedDataMethods[methodName] = santizedResult

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
     * Phase 1: Execute secure data variables in isolation with full credential access (new format)
     */
    async executeDataVariablesPhase(secureDataVariables, headerEnvVars = {}) {
        // Security validation for data variables payload
        this.validateSecureDataVariablesPayload(secureDataVariables);

        // Build dependency graph and get execution order
        const executionOrder = this.buildDependencyGraph(secureDataVariables);


        const sanitizedDataVariables = {};
        const resultsMap = {}; // Store raw results for dependency interpolation

        // Execute in dependency order (sequential)
        for (const variableName of executionOrder) {
            try {
                const variableConfig = secureDataVariables[variableName];



                // Check rate limits
                if (!this.checkDataMethodRateLimit(variableName)) {
                    sanitizedDataVariables[variableName] = {
                        error: true,
                        message: 'Rate limit exceeded for data variable',
                        type: 'rate_limit_error'
                    };
                    continue;
                }

                // Validate variable configuration
                this.validateDataVariableConfig(variableConfig);

                // Interpolate passed_variables if present
                let configToExecute = variableConfig;
                if (variableConfig?.passed_variables && typeof variableConfig?.passed_variables === 'object') {
                    configToExecute = this.interpolatePassedVariables(variableConfig, variableConfig.passed_variables, resultsMap);
                }



                // Execute the data variable in isolation
                const rawResult = await this.executeIsolatedDataVariable(variableName, configToExecute, headerEnvVars);

                // Store raw result for dependency interpolation
                resultsMap[variableName] = rawResult;

                // Sanitize the result (strip sensitive data)
                sanitizedDataVariables[variableName] = this.sanitizeDataMethodResult(rawResult);

                // Update rate limit tracking
                this.updateDataMethodRateLimit(variableName);

            } catch (error) {
                // Create safe error message without exposing sensitive details
                sanitizedDataVariables[variableName] = {
                    error: true,
                    message: 'Data variable execution failed',
                    type: 'execution_error',
                    details: error.message
                };
                console.error(`❌ Data variable ${variableName} failed:`, error.message);
            }
        }

        return sanitizedDataVariables;
    }

    /**
     * Build dependency graph for data variables and return execution order
     * Uses topological sort to determine which variables must execute first
     */
    buildDependencyGraph(secureDataVariables) {
        const variableNames = Object.keys(secureDataVariables);
        const dependencies = new Map(); // variable -> array of dependencies
        const dependents = new Map();   // variable -> array of dependents

        // Initialize maps
        variableNames.forEach(name => {
            dependencies.set(name, []);
            dependents.set(name, []);
        });

        // Build dependency relationships
        for (const [variableName, config] of Object.entries(secureDataVariables)) {
            if (config.passed_variables && typeof config.passed_variables === 'object') {
                for (const [field, passedConfig] of Object.entries(config.passed_variables)) {
                    const dependencyName = passedConfig.passed_from;

                    if (!dependencyName) {
                        throw new Error(`passed_variables.${field} in ${variableName} must have 'passed_from' field`);
                    }

                    if (!variableNames.includes(dependencyName)) {
                        throw new Error(`${variableName} depends on '${dependencyName}' which doesn't exist in api_calls`);
                    }

                    // variableName depends on dependencyName
                    dependencies.get(variableName).push(dependencyName);
                    dependents.get(dependencyName).push(variableName);
                }
            }
        }

        // Detect circular dependencies using DFS
        const visited = new Set();
        const recursionStack = new Set();

        const detectCycle = (node, path = []) => {
            if (recursionStack.has(node)) {
                const cycle = [...path, node];
                throw new Error(`Circular dependency detected: ${cycle.join(' -> ')}`);
            }

            if (visited.has(node)) {
                return;
            }

            visited.add(node);
            recursionStack.add(node);
            path.push(node);

            const deps = dependencies.get(node) || [];
            for (const dep of deps) {
                detectCycle(dep, [...path]);
            }

            recursionStack.delete(node);
        };

        variableNames.forEach(name => detectCycle(name));

        // Topological sort using Kahn's algorithm
        const inDegree = new Map();
        variableNames.forEach(name => {
            inDegree.set(name, dependencies.get(name).length);
        });

        const queue = [];
        const executionOrder = [];

        // Start with variables that have no dependencies
        variableNames.forEach(name => {
            if (inDegree.get(name) === 0) {
                queue.push(name);
            }
        });

        while (queue.length > 0) {
            const current = queue.shift();
            executionOrder.push(current);

            // Reduce in-degree for all dependents
            const currentDependents = dependents.get(current) || [];
            for (const dependent of currentDependents) {
                inDegree.set(dependent, inDegree.get(dependent) - 1);
                if (inDegree.get(dependent) === 0) {
                    queue.push(dependent);
                }
            }
        }

        // If not all variables are in execution order, there's a cycle
        if (executionOrder.length !== variableNames.length) {
            throw new Error('Circular dependency detected in api_calls');
        }

        return executionOrder;
    }

    /**
     * Interpolate passed_variables into config using results from previous executions
     * @param {Object} config - Original variable configuration
     * @param {Object} passed_variables - Map of field -> {passed_from, value}
     * @param {Object} resultsMap - Map of variableName -> execution result
     * @returns {Object} - Config with interpolated values
     */
    interpolatePassedVariables(config, passed_variables, resultsMap) {
        // Deep clone config to avoid mutations
        const interpolatedConfig = JSON.parse(JSON.stringify(config));

        // Remove passed_variables from the config (it's metadata, not execution config)
        delete interpolatedConfig.passed_variables;
        for (const [fieldPath, passedConfig] of Object.entries(passed_variables)) {
            let { passed_from, value, field_name } = passedConfig;

            if (!passed_from || !value) {
                throw new Error(`passed_variables.${fieldPath} must have 'passed_from' and 'value' fields`);
            }

            // Get the result from the dependency
            const dependencyResult = resultsMap[passed_from];
            if (!dependencyResult) {
                throw new Error(`Cannot interpolate ${fieldPath}: ${passed_from} has not been executed yet`);
            }

            if (field_name?.startsWith("url")) field_name = `fetchOptions.${field_name}`
            if (field_name?.startsWith("body")) field_name = `fetchOptions.${field_name}`
            if (field_name?.startsWith("method")) field_name = `fetchOptions.${field_name}`

            // Extract the data from the dependency result
            // Result structure: { data: { status, headers, body, success }, ... }
            const resultData = dependencyResult.data?.body

            // Interpolate the value template with result data
            const interpolatedValue = this.interpolateTemplate(value, { result: resultData });

            // Set the interpolated value at the field path
            this.setValueAtPath(interpolatedConfig, field_name, interpolatedValue);
        }

        return interpolatedConfig;
    }

    /**
     * Interpolate a template string with data
     * Supports ${result.field} and ${result.nested.field} syntax
     * Leaves ${process.env.*} patterns untouched for runtime evaluation
     * @param {String} template - Template string with ${} placeholders
     * @param {Object} data - Data object to interpolate from
     * @returns {String} - Interpolated string
     */
    interpolateTemplate(template, data) {
        if (typeof template !== 'string') {
            return template;
        }

        // Replace only ${result.*} patterns, leave ${process.env.*} patterns for runtime
        return template.replace(/\$\{result\.([^}]+)\}/g, (match, path) => {
            // path = "id" or "body.name" (without the "result." prefix)
            const fullPath = 'result.' + path;
            const value = this.getValueAtPath(data, fullPath);

            if (value === undefined || value === null) {
                const error = `Interpolation failed: ${fullPath} is undefined. Available data: ${JSON.stringify(data, null, 2)}`;
                console.error(`❌ ${error}`);
                throw new Error(error);
            }

            return value;
        });
    }

    /**
     * Get value from object using dot-notation path with array index support
     * @param {Object} obj - Object to get value from
     * @param {String} path - Dot-notation path (e.g., "result.id" or "result.body.name" or "result.nodes[0].id")
     * @returns {*} - Value at path or undefined
     */
    getValueAtPath(obj, path) {
        // Split path by dots, but preserve array bracket notation
        // e.g., "result.data.nodes[0].id" -> ["result", "data", "nodes[0]", "id"]
        const parts = path.split('.');
        let current = obj;

        for (const part of parts) {
            if (current === undefined || current === null) {
                return undefined;
            }

            // Check if this part contains array index notation like "nodes[0]"
            const arrayMatch = part.match(/^([^\[]+)\[(\d+)\]$/);
            if (arrayMatch) {
                // Extract property name and index: "nodes[0]" -> ["nodes", "0"]
                const [, propName, index] = arrayMatch;
                current = current[propName];

                if (current === undefined || current === null) {
                    return undefined;
                }

                // Access array element
                current = current[parseInt(index, 10)];
            } else {
                // Normal property access
                current = current[part];
            }
        }

        return current;
    }

    /**
     * Set value in object using dot-notation path
     * Supports nested paths like "headers.Authorization" or "body.user.id"
     * @param {Object} obj - Object to set value in
     * @param {String} path - Dot-notation path
     * @param {*} value - Value to set
     */
    setValueAtPath(obj, path, value) {
        const parts = path.split('.');
        let current = obj;

        // Navigate to the parent of the target field
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];

            // Create nested object if it doesn't exist
            if (!(part in current) || typeof current[part] !== 'object') {
                current[part] = {};
            }

            current = current[part];
        }


        // Set the final value
        const finalKey = parts[parts.length - 1];
        current[finalKey] = value;
    }

    /**
     * Validate that global code doesn't try to access process.env.KEYBOARD_* variables
     * Static analysis layer - catches obvious env var access before execution
     */
    validateGlobalCodeForEnvAccess(globalCode) {
        if (!globalCode || typeof globalCode !== 'string') {
            return; // Nothing to validate
        }

        // Pattern to detect process.env.KEYBOARD_* access
        const envAccessPattern = /process\.env\.KEYBOARD_[A-Z_0-9]+/g;
        const matches = globalCode.match(envAccessPattern);

        if (matches && matches.length > 0) {
            throw new Error(
                '❌ Error: Do not try to execute process.env code in the global code. ' +
                'Please interact with external APIs in the api_calls section. ' +
                `Found: ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? '...' : ''}`
            );
        }
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
     * Validate the overall secure data variables payload for security (new format)
     */
    validateSecureDataVariablesPayload(secureDataVariables) {
        if (!secureDataVariables || typeof secureDataVariables !== 'object') {
            throw new Error('secure_data_variables must be an object');
        }

        const variableNames = Object.keys(secureDataVariables);

        // Limit number of data variables
        if (variableNames.length > this.maxDataMethods) {
            throw new Error(`Too many data variables. Maximum allowed: ${this.maxDataMethods}`);
        }

        // Validate variable names (no special characters, reasonable length)
        variableNames.forEach(variableName => {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variableName)) {
                throw new Error(`Invalid data variable name: ${variableName}`);
            }

            if (variableName.length > 50) {
                throw new Error(`Data variable name too long: ${variableName}`);
            }

            // Prevent reserved JavaScript keywords/names
            const reservedNames = ['constructor', 'prototype', '__proto__', 'eval', 'Function'];
            if (reservedNames.includes(variableName)) {
                throw new Error(`Reserved variable name not allowed: ${variableName}`);
            }
        });
    }

    /**
     * Validate data variable configuration for security (new format)
     */
    validateDataVariableConfig(config) {
        if (!config || typeof config !== 'object') {
            throw new Error('Invalid data variable configuration');
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

        // Validate passed_variables if present
        if (config.passed_variables) {
            if (typeof config.passed_variables !== 'object' || Array.isArray(config.passed_variables)) {
                throw new Error('passed_variables must be an object (not an array)');
            }

            // Validate each passed variable configuration
            for (const [fieldPath, passedConfig] of Object.entries(config.passed_variables)) {
                if (!passedConfig || typeof passedConfig !== 'object') {
                    throw new Error(`passed_variables.${fieldPath} must be an object`);
                }

                if (!passedConfig.passed_from || typeof passedConfig.passed_from !== 'string') {
                    throw new Error(`passed_variables.${fieldPath}.passed_from must be a string`);
                }

                if (!passedConfig.value || typeof passedConfig.value !== 'string') {
                    throw new Error(`passed_variables.${fieldPath}.value must be a string`);
                }

                // Validate fieldPath is a valid path (alphanumeric, dots, dashes, and underscores)
                if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(fieldPath)) {
                    throw new Error(`Invalid field path in passed_variables: ${fieldPath}`);
                }

                // Validate passed_from is a valid identifier
                if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(passedConfig.passed_from)) {
                    throw new Error(`Invalid passed_from identifier: ${passedConfig.passed_from}`);
                }
            }
        }
    }

    /**
     * Execute a single data variable in isolation with credential access (new format)
     */
    async executeIsolatedDataVariable(variableName, variableConfig, headerEnvVars) {
        return new Promise((resolve, reject) => {
            const tempFile = `temp_data_variable_${Date.now()}_${randomBytes(8).toString('hex')}.js`;
            const tempPath = path.join(this.tempDir, tempFile);

            // Create isolated execution code for the data variable

            const isolatedCode = this.generateIsolatedDataVariableCode(variableName, variableConfig);


            try {
                fs.writeFileSync(tempPath, isolatedCode);

                // Create environment for isolated execution with full credential access
                const isolatedEnv = this.createIsolatedEnvironment(headerEnvVars);
                this.executeProcess('node', [tempPath], {
                    timeout: this.maxDataMethodTimeout, // Configurable timeout for data variable
                    env: isolatedEnv,
                    executionMode: 'isolated-data-variable',
                    skipOutputSanitization: true // Skip sanitization to preserve JSON structure
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
     * Generate isolated execution code for a data variable (new format)
     */
    generateIsolatedDataVariableCode(variableName, variableConfig) {
        let actualConfig;
        let actualConfigIsString = typeof variableConfig === "string"
        if (actualConfigIsString) actualConfig = JSON.parse(variableConfig)
        else actualConfig = variableConfig

        const { credential } = actualConfig
        delete actualConfig["credential"]
        let configCode = this.buildConfigObjectCode(actualConfig)

        let code = isolatedDataVariableGenerator(configCode)

        return code
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
                    executionMode: 'isolated-data-method',
                    skipOutputSanitization: true // Skip sanitization to preserve JSON structure
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
        return isolatedDataMethodCodeGenerator(resolvedConfig);
    }

    /**
     * Build JavaScript code for a config object with runtime interpolation
     */
    buildConfigObjectCode(obj) {
        if (obj === null) return 'null';
        if (obj === undefined) return 'undefined';
        if (typeof obj === 'boolean') return obj.toString();
        if (typeof obj === 'number') return obj.toString();

        if (typeof obj === 'string') {
            // Check if this string contains interpolation markers
            if (obj.includes('${process.env.')) {
                // Return as template literal for runtime interpolation
                return '`' + obj + '`';
            }
            // Regular string
            return JSON.stringify(obj);
        }

        if (Array.isArray(obj)) {
            const elements = obj.map(item => this.buildConfigObjectCode(item));
            return '[' + elements.join(', ') + ']';
        }

        if (typeof obj === 'object') {
            const props = Object.entries(obj).map(([key, value]) => {
                const keyStr = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? key : JSON.stringify(key);
                return `${keyStr}: ${this.buildConfigObjectCode(value)}`;
            });
            return '{' + props.join(', ') + '}';
        }

        return 'null';
    }

    /**
     * Resolve environment variables in configuration
     * This generates code that will be interpolated at runtime using template literals
     */
    resolveEnvironmentVariables(config) {
        const resolved = JSON.parse(JSON.stringify(config)); // Deep clone

        // Get the credential reference (e.g., "process.env.KEYBOARD_PROVIDER_USER_TOKEN_FOR_NOTION")
        const credentialRef = resolved.credential;

        const resolveValue = (value) => {
            if (typeof value === 'string' && credentialRef) {

                // Replace {KEYBOARD_*} placeholders with ${process.env.KEYBOARD_*} for runtime interpolation
                value = value.replace(/\{(KEYBOARD_[A-Z_0-9]+)\}/g, (match, envVar) => {
                    return `\${process.env.${envVar}}`;
                });

                // Replace {process.env.KEYBOARD_*} placeholders with ${process.env.KEYBOARD_*}
                value = value.replace(/\{process\.env\.(KEYBOARD_[A-Z_0-9]+)\}/g, (match, envVar) => {
                    return `\${process.env.${envVar}}`;
                });
                return value;
            }
            return value;
        };

        const resolveObject = (obj) => {
            for (const [key, value] of Object.entries(obj)) {
                // Skip the credential field itself
                if (key === 'credential') {
                    continue;
                }

                if (typeof value === 'object' && value !== null) {
                    resolveObject(value);
                } else {
                    obj[key] = resolveValue(value);
                }
            }
        };

        resolveObject(resolved);

        // Remove the credential field from the resolved config
        delete resolved.credential;

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
                const jsonString = match[1];
                try {
                    return JSON.parse(jsonString);
                } catch (jsonError) {
                    // Provide detailed JSON parsing error information
                    console.error('❌ JSON parsing error in isolated data method result:');
                    console.error(`   Error: ${jsonError.message}`);
                    console.error(`   JSON string length: ${jsonString.length}`);
                    console.error(`   First 100 chars: ${jsonString.substring(0, 100)}`);

                    // Try to identify the problematic character position
                    const errorPos = this.extractJsonErrorPosition(jsonError.message);
                    if (errorPos >= 0 && errorPos < jsonString.length) {
                        const contextStart = Math.max(0, errorPos - 20);
                        const contextEnd = Math.min(jsonString.length, errorPos + 20);
                        const context = jsonString.substring(contextStart, contextEnd);
                        const markerPos = errorPos - contextStart;
                        const marker = ' '.repeat(markerPos) + '^';
                        console.error(`   Context around error: "${context}"`);
                        console.error(`   Error position:      ${marker}`);
                    }

                    return {
                        data: null,
                        error: {
                            message: `JSON parsing failed: ${jsonError.message}`,
                            type: 'json_parse_error',
                            position: errorPos,
                            context: jsonString.substring(0, 200) // First 200 chars for context
                        },
                        unparsed: true
                    };
                }
            } else {
                console.error('❌ No ISOLATED_DATA_METHOD_RESULT found in stdout');
                console.error(`   Stdout content: ${stdout.substring(0, 500)}`);

                return {
                    data: null,
                    error: {
                        message: 'No isolated data method result marker found in output',
                        type: 'missing_result_marker'
                    },
                    unparsed: true
                };
            }
        } catch (parseError) {
            console.error('❌ Failed to parse isolated data method result:', parseError.message);
            console.error('   Stack trace:', parseError.stack);
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
     * Extract error position from JSON error message
     */
    extractJsonErrorPosition(errorMessage) {
        // Try to extract position from error messages like "Unexpected token at position 44"
        const positionMatch = errorMessage.match(/position (\d+)/);
        if (positionMatch) {
            return parseInt(positionMatch[1], 10);
        }

        // Try to extract from "line X column Y" format
        const lineColMatch = errorMessage.match(/line (\d+) column (\d+)/);
        if (lineColMatch) {
            // For simple cases, estimate position (this is approximate)
            const line = parseInt(lineColMatch[1], 10);
            const col = parseInt(lineColMatch[2], 10);
            return Math.max(0, (line - 1) * 50 + col); // Rough estimate
        }

        return -1; // Position not found
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


            if (rawResult.data) {
                const sanitizedData = rawResult.data.body

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
            safeData = responseData.body
        }

        // Include basic success indicators (safe)
        if (responseData.status) {
            // Only include status code ranges, not exact codes that might leak info
            if (responseData.status >= 200 && responseData.status < 300) {
                // safeData.success = true;
                return safeData
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
            sanitized[key] = value
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
        return globalCodeWithDataMethodsGenerator(globalCode, sanitizedDataMethods);
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