import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { safeObfuscate } from '../utils/crypto';
import { awaitedScriptGenerator, secureWrapperGenerator, isolatedDataVariableGenerator, isolatedDataMethodCodeGenerator, globalCodeWithDataMethodsGenerator } from './templates';
import {
    ExecutionPayload,
    ExecutionResult,
    CodeAnalysis,
    SecureDataVariables,
    SecureDataMethods,
    DataVariableConfig,
    DataMethodConfig,
    PassedVariables,
    // ApiCalls - imported but not used in current implementation
} from '../types';
import LocalLLM from '../local_llm/local';

export interface SecureExecutorOptions {
    timeout?: number;
    tempDir?: string;
    maxDataMethodExecutionsPerHour?: number;
    maxDataMethods?: number;
    maxDataMethodTimeout?: number;
}

interface ProcessOptions {
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    ai_eval?: boolean;
    encrypt_messages?: boolean;
    use_asymmetric_encryption?: boolean;
    executionMode?: string;
    skipOutputSanitization?: boolean;
}

// interface IsolatedExecutionResult {
//     stdout: string;
//     stderr: string;
//     data: any;
//     error: any;
// }

export default class SecureExecutor {
    private defaultTimeout: number;
    private tempDir: string;
    private dataMethodRateLimit: Map<string, number[]> = new Map();
    private maxDataMethodExecutionsPerHour: number;
    private maxDataMethods: number;
    private maxDataMethodTimeout: number;

    constructor(options: SecureExecutorOptions = {}) {
        this.defaultTimeout = options.timeout || 30000;
        this.tempDir = options.tempDir || path.join(__dirname, '../../temp');
        this.maxDataMethodExecutionsPerHour = options.maxDataMethodExecutionsPerHour || 100;
        this.maxDataMethods = options.maxDataMethods || 10;
        this.maxDataMethodTimeout = options.maxDataMethodTimeout || 15000;

        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }


    /**
     * Execute code with security isolation if needed
     */
    async executeCode(payload: ExecutionPayload, headerEnvVars: Record<string, string> = {}): Promise<ExecutionResult> {
        // Check for new secure data variables payload structure
        if (payload.secure_data_variables && payload.Global_code) {
            return this.executeSecureWithDataVariables(payload, headerEnvVars);
        }

        // Check for api_calls + global_code format (new restricted-run-code tool format)
        if (payload.api_calls && (payload.global_code || payload.Global_code)) {
            const convertedPayload = this.convertApiCallsToSecureDataVariables(payload);
            return this.executeSecureWithDataVariables(convertedPayload, headerEnvVars);
        }

        if (!payload.code) {
            throw new Error('No code provided to execute');
        }

        // Use full execution for simple code without structured API calls
        return this.executeCodeFull(payload, headerEnvVars);
    }

    /**
     * Convert api_calls + global_code format to secure_data_variables + Global_code format
     */
    convertApiCallsToSecureDataVariables(payload: ExecutionPayload): ExecutionPayload {
        try {
            if (!payload.api_calls) {
                throw new Error('No api_calls found in payload');
            }

            const secure_data_variables: SecureDataVariables = {};
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
                use_asymmetric_encryption: payload.use_asymmetric_encryption || false,
                explanation_of_code: payload.explanation_of_code // Pass through if present
            };

        } catch (error: any) {
            throw new Error(`Failed to convert api_calls payload: ${error.message}`);
        }
    }

    /**
     * Unescape double-escaped quotes and other common escape sequences in global code
     */
    unescapeGlobalCode(globalCode: any): string {
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
    async executeSecureWithDataVariables(payload: ExecutionPayload, headerEnvVars: Record<string, string> = {}): Promise<ExecutionResult> {
        return new Promise(async (resolve, reject) => {
            try {
                if (!payload.Global_code) {
                    throw new Error('Global_code is required');
                }
                if (!payload.secure_data_variables) {
                    throw new Error('secure_data_variables is required');
                }

                // Validate global code doesn't try to access process.env.KEYBOARD_* variables
                this.validateGlobalCodeForEnvAccess(payload.Global_code);
                // Phase 1: Execute secure data variables in isolation
                const sanitizedDataVariables = await this.executeDataVariablesPhase(payload.secure_data_variables, headerEnvVars);
                // Phase 2: Execute global code with access to sanitized data
                const result = await this.executeGlobalCodePhase(payload.Global_code, sanitizedDataVariables, payload);

                resolve(result);
            } catch (error: any) {
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
    async executeSecureWithDataMethods(payload: ExecutionPayload, headerEnvVars: Record<string, string> = {}): Promise<ExecutionResult> {
        return new Promise(async (resolve, reject) => {
            try {
                if (!payload.Secure_data_methods) {
                    throw new Error('Secure_data_methods is required');
                }
                if (!payload.Global_code) {
                    throw new Error('Global_code is required');
                }
                // Phase 1: Execute secure data methods in isolation
                const sanitizedDataMethods = await this.executeDataMethodsPhase(payload.Secure_data_methods, headerEnvVars);
                // Phase 2: Execute global code with access to sanitized data
                const result = await this.executeGlobalCodePhase(payload.Global_code, sanitizedDataMethods, payload);
                resolve(result);
            } catch (error: any) {
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
    async executeCodeFull(payload: ExecutionPayload, headerEnvVars: Record<string, string> = {}): Promise<ExecutionResult> {
        return new Promise((resolve, reject) => {
            const tempFile = `temp_full_${Date.now()}_${randomBytes(8).toString('hex')}.js`;
            const tempPath = path.join(this.tempDir, tempFile);

            let codeToExecute = payload.code!;

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

                const limitedEnv: NodeJS.ProcessEnv = {};
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
                    use_asymmetric_encryption: payload.use_asymmetric_encryption || false,
                    executionMode: 'full'
                }).then(result => {
                    this.cleanup(tempPath);
                    resolve(result);
                }).catch(error => {
                    this.cleanup(tempPath);
                    reject(error);
                });

            } catch (error: any) {
                this.cleanup(tempPath);
                reject({
                    error: 'Failed to write temporary file',
                    details: error.message
                });
            }
        });
    }




    /**
     * Enhanced output sanitization for secure execution
     */
    sanitizeOutput(output: string): string {
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
    async executeProcess(cmd: string, args: string[], options: ProcessOptions = {}): Promise<ExecutionResult> {
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
                        let result: ExecutionResult = {
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
                                code: code || 0,
                                executionTime: Date.now(),
                                executionMode: options.executionMode || 'normal'
                            }
                        };

                        // AI analysis if requested
                        if (options.ai_eval) {
                            try {
                                const localLLM = new LocalLLM();
                                const outputsOfCodeExecution = `
                                output of code execution:
                                <stdout>${this.sanitizeOutput(stdout)}</stdout>
                                <stderr>${this.sanitizeOutput(stderr)}</stderr>`;
                                result.data!.aiAnalysis = await localLLM.analyzeResponse(JSON.stringify(outputsOfCodeExecution));
                            } catch (e) {
                                result.data!.aiAnalysis = { error: 'AI analysis failed' };
                            }
                        }

                        resolve(result);
                    } catch (error: any) {
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
                            code: (error as any).code,
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
     * Phase 1: Execute secure data variables in isolation with full credential access (new format)
     */
    async executeDataVariablesPhase(secureDataVariables: SecureDataVariables, headerEnvVars: Record<string, string> = {}): Promise<any> {
        // Security validation for data variables payload
        this.validateSecureDataVariablesPayload(secureDataVariables);

        // Build dependency graph and get execution order
        const executionOrder = this.buildDependencyGraph(secureDataVariables);

        const sanitizedDataVariables: any = {};
        const resultsMap: any = {}; // Store raw results for dependency interpolation

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

            } catch (error: any) {
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
     * Phase 1: Execute secure data methods in isolation with full credential access
     */
    async executeDataMethodsPhase(secureDataMethods: SecureDataMethods, headerEnvVars: Record<string, string> = {}): Promise<any> {
        // Security validation for data methods payload
        this.validateSecureDataMethodsPayload(secureDataMethods);

        const sanitizedDataMethods: any = {};

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

            } catch (error: any) {
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
     * Build dependency graph for data variables and return execution order
     * Uses topological sort to determine which variables must execute first
     */
    buildDependencyGraph(secureDataVariables: SecureDataVariables): string[] {
        const variableNames = Object.keys(secureDataVariables);
        const dependencies = new Map<string, string[]>(); // variable -> array of dependencies
        const dependents = new Map<string, string[]>();   // variable -> array of dependents

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
                    dependencies.get(variableName)!.push(dependencyName);
                    dependents.get(dependencyName)!.push(variableName);
                }
            }
        }

        // Detect circular dependencies using DFS
        const visited = new Set<string>();
        const recursionStack = new Set<string>();

        const detectCycle = (node: string, path: string[] = []): void => {
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
        const inDegree = new Map<string, number>();
        variableNames.forEach(name => {
            inDegree.set(name, dependencies.get(name)!.length);
        });

        const queue: string[] = [];
        const executionOrder: string[] = [];

        // Start with variables that have no dependencies
        variableNames.forEach(name => {
            if (inDegree.get(name) === 0) {
                queue.push(name);
            }
        });

        while (queue.length > 0) {
            const current = queue.shift()!;
            executionOrder.push(current);

            // Reduce in-degree for all dependents
            const currentDependents = dependents.get(current) || [];
            for (const dependent of currentDependents) {
                inDegree.set(dependent, inDegree.get(dependent)! - 1);
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
     * Validate global code doesn't access process.env.KEYBOARD_* variables
     */
    validateGlobalCodeForEnvAccess(globalCode: string): void {
        if (!globalCode || typeof globalCode !== 'string') {
            return;
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
     * Cleanup temporary files
     */
    private cleanup(filePath: string): void {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (error: any) {
            console.error('Failed to cleanup temp file:', error.message);
        }
    }

    /**
     * Get current execution mode info
     */
    getExecutionInfo(): any {
        const enableSecureExecution = process.env.KEYBOARD_FULL_CODE_EXECUTION !== 'true';
        return {
            secureExecutionEnabled: enableSecureExecution,
            fullCodeExecution: !enableSecureExecution,
            environmentFlag: process.env.KEYBOARD_FULL_CODE_EXECUTION || 'false',
            tempDirectory: this.tempDir
        };
    }

    /**
     * Interpolate passed_variables into config using results from previous executions
     */
    private interpolatePassedVariables(config: DataVariableConfig, passed_variables: PassedVariables, resultsMap: any): DataVariableConfig {
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

            // Transform top-level fetchOptions fields to proper paths
            // Only transform if it's EXACTLY "url", "body", or "method" at the top level
            // This prevents false positives like "headers.body-hash" being transformed
            if (field_name) {
                const topLevelField = field_name.split('.')[0];
                if (topLevelField === "url" || topLevelField === "body" || topLevelField === "method") {
                    field_name = `fetchOptions.${field_name}`;
                }
            }

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
     */
    private interpolateTemplate(template: string, data: any): any {
        if (typeof template !== 'string') {
            return template;
        }

        // Replace only ${result.*} patterns, leave ${process.env.*} patterns for runtime
        // Regex validates proper path format: letters, numbers, dots, brackets, underscores
        return template.replace(/\$\{result\.([\w.\[\]]+)\}/g, (match, path) => {
            // path = "id" or "body.name" or "items[0].id" (without the "result." prefix)
            const fullPath = 'result.' + path;
            const value = this.getValueAtPath(data, fullPath);

            // Strict null/undefined check - these should error
            if (value === undefined || value === null) {
                const error = `Interpolation failed: ${fullPath} is ${value === null ? 'null' : 'undefined'}. Available data: ${JSON.stringify(data, null, 2)}`;
                console.error(`❌ ${error}`);
                throw new Error(error);
            }

            // Handle different value types appropriately for string interpolation
            if (typeof value === 'object') {
                // Objects and arrays get JSON stringified
                return JSON.stringify(value);
            }

            // Primitives (string, number, boolean) convert to string naturally
            return String(value);
        });
    }

    /**
     * Get value from object using dot-notation path with array index support
     */
    private getValueAtPath(obj: any, path: string): any {
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
     * Set value in object using dot-notation path with array index support
     * Supports nested paths like "headers.Authorization", "body.user.id", or "body.users[0].id"
     */
    private setValueAtPath(obj: any, path: string, value: any): void {
        const parts = path.split('.');
        let current = obj;

        // Navigate to the parent of the target field
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];

            // Check if this part contains array index notation like "users[0]"
            const arrayMatch = part.match(/^([^\[]+)\[(\d+)\]$/);
            if (arrayMatch) {
                const [, propName, index] = arrayMatch;
                const arrayIndex = parseInt(index, 10);

                // Create array if it doesn't exist
                if (!(propName in current)) {
                    current[propName] = [];
                }

                // Ensure it's an array
                if (!Array.isArray(current[propName])) {
                    current[propName] = [];
                }

                // Create array element if it doesn't exist
                if (!current[propName][arrayIndex]) {
                    current[propName][arrayIndex] = {};
                }

                current = current[propName][arrayIndex];
            } else {
                // Create nested object if it doesn't exist
                if (!(part in current) || typeof current[part] !== 'object') {
                    current[part] = {};
                }

                current = current[part];
            }
        }

        // Set the final value (handle array index in final key)
        const finalKey = parts[parts.length - 1];
        const finalArrayMatch = finalKey.match(/^([^\[]+)\[(\d+)\]$/);

        if (finalArrayMatch) {
            const [, propName, index] = finalArrayMatch;
            const arrayIndex = parseInt(index, 10);

            // Create array if it doesn't exist
            if (!(propName in current)) {
                current[propName] = [];
            }

            // Ensure it's an array
            if (!Array.isArray(current[propName])) {
                current[propName] = [];
            }

            current[propName][arrayIndex] = value;
        } else {
            current[finalKey] = value;
        }
    }

    /**
     * Validate the overall secure data variables payload for security
     */
    private validateSecureDataVariablesPayload(secureDataVariables: SecureDataVariables): void {
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
     * Validate the overall secure data methods payload for security
     */
    private validateSecureDataMethodsPayload(secureDataMethods: SecureDataMethods): void {
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
     * Validate data variable configuration for security (new format)
     */
    private validateDataVariableConfig(config: DataVariableConfig): void {
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
     * Validate data method configuration for security
     */
    private validateDataMethodConfig(config: DataMethodConfig): void {
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
     * Check rate limit for data method execution
     */
    private checkDataMethodRateLimit(methodName: string): boolean {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;

        if (!this.dataMethodRateLimit.has(methodName)) {
            return true; // First execution, allow
        }

        const methodHistory = this.dataMethodRateLimit.get(methodName)!;

        // Clean old entries (older than 1 hour)
        const recentExecutions = methodHistory.filter(timestamp => (now - timestamp) < oneHour);
        this.dataMethodRateLimit.set(methodName, recentExecutions);

        return recentExecutions.length < this.maxDataMethodExecutionsPerHour;
    }

    /**
     * Update rate limit tracking for data method
     */
    private updateDataMethodRateLimit(methodName: string): void {
        const now = Date.now();

        if (!this.dataMethodRateLimit.has(methodName)) {
            this.dataMethodRateLimit.set(methodName, []);
        }

        const methodHistory = this.dataMethodRateLimit.get(methodName)!;
        methodHistory.push(now);
        this.dataMethodRateLimit.set(methodName, methodHistory);
    }

    /**
     * Execute a single data variable in isolation with credential access (new format)
     */
    private async executeIsolatedDataVariable(variableName: string, variableConfig: DataVariableConfig, headerEnvVars: Record<string, string>): Promise<any> {
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

            } catch (error: any) {
                this.cleanup(tempPath);
                reject(error);
            }
        });
    }

    /**
     * Execute a single data method in isolation with credential access
     */
    private async executeIsolatedDataMethod(methodName: string, methodConfig: DataMethodConfig, headerEnvVars: Record<string, string>): Promise<any> {
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

            } catch (error: any) {
                this.cleanup(tempPath);
                reject(error);
            }
        });
    }

    /**
     * Generate isolated execution code for a data variable (new format)
     */
    private generateIsolatedDataVariableCode(variableName: string, variableConfig: DataVariableConfig): string {
        let actualConfig;
        let actualConfigIsString = typeof variableConfig === "string"
        if (actualConfigIsString) actualConfig = JSON.parse(variableConfig as string)
        else actualConfig = variableConfig

        const { credential } = actualConfig as any
        delete actualConfig["credential"]
        let configCode = this.buildConfigObjectCode(actualConfig)

        let code = isolatedDataVariableGenerator(configCode)
        return code
    }

    /**
     * Generate isolated execution code for a data method
     */
    private generateIsolatedDataMethodCode(methodName: string, methodConfig: DataMethodConfig): string {
        // Resolve environment variables in configuration
        const resolvedConfig = this.resolveEnvironmentVariables(methodConfig);
        return isolatedDataMethodCodeGenerator(resolvedConfig);
    }

    /**
     * Build JavaScript code for a config object with runtime interpolation
     */
    private buildConfigObjectCode(obj: any): string {
        if (obj === null) return 'null';
        if (obj === undefined) return 'undefined';
        if (typeof obj === 'boolean') return obj.toString();
        if (typeof obj === 'number') return obj.toString();

        if (typeof obj === 'string') {
            // Check if this string contains interpolation markers
            if (obj.includes('${process.env.')) {
                // Escape special characters before wrapping in template literal
                // This prevents code injection and syntax errors
                const escaped = obj
                    .replace(/\\/g, '\\\\')    // Escape backslashes first
                    .replace(/`/g, '\\`')       // Escape backticks
                    .replace(/\$/g, '\\$');     // Escape dollar signs (prevents ${} interpolation)

                return '`' + escaped + '`';
            }
            // Regular string - JSON.stringify handles escaping automatically
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
    private resolveEnvironmentVariables(config: DataMethodConfig): any {
        const resolved = JSON.parse(JSON.stringify(config)); // Deep clone

        // Get the credential reference (e.g., "process.env.KEYBOARD_PROVIDER_USER_TOKEN_FOR_NOTION")
        const credentialRef = (resolved as any).credential;

        const resolveValue = (value: any): any => {
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

        const resolveObject = (obj: any): void => {
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
    private createIsolatedEnvironment(headerEnvVars: Record<string, string>): NodeJS.ProcessEnv {
        // Start with minimal base environment
        const isolatedEnv: NodeJS.ProcessEnv = {
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
    private parseIsolatedDataMethodResult(executionResult: ExecutionResult): any {
        try {
            const stdout = executionResult.data?.stdout || '';
            const match = stdout.match(/ISOLATED_DATA_METHOD_RESULT: (.+)/);

            if (match) {
                const jsonString = match[1];
                try {
                    return JSON.parse(jsonString);
                } catch (jsonError: any) {
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
        } catch (parseError: any) {
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
    private extractJsonErrorPosition(errorMessage: string): number {
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
    private sanitizeDataMethodResult(rawResult: any): any {
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

        } catch (sanitizationError: any) {
            console.error('❌ Data sanitization failed:', sanitizationError.message);
            return {
                error: true,
                message: 'Data sanitization failed',
                type: 'sanitization_error'
            };
        }
    }

    /**
     * Phase 2: Execute global code with access to sanitized data methods
     */
    private async executeGlobalCodePhase(globalCode: string, sanitizedDataMethods: any, originalPayload: ExecutionPayload): Promise<ExecutionResult> {
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

            } catch (error: any) {
                this.cleanup(tempPath);
                reject(error);
            }
        });
    }

    /**
     * Generate global code with injected data method functions
     */
    private generateGlobalCodeWithDataMethods(globalCode: string, sanitizedDataMethods: any): string {
        return globalCodeWithDataMethodsGenerator(globalCode, sanitizedDataMethods);
    }

    /**
     * Create secure environment for global code execution (NO credentials)
     */
    private createSecureGlobalEnvironment(): NodeJS.ProcessEnv {
        // Minimal environment with NO access to credentials
        const secureEnv: NodeJS.ProcessEnv = {
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
    private filterGlobalExecutionResult(executionResult: ExecutionResult, sanitizedDataMethods: any): ExecutionResult {
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
        } catch (parseError: any) {
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
}