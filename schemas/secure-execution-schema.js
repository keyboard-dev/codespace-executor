/**
 * Zod schemas for Secure Two-Phase Code Execution API
 * Use these schemas to validate requests before sending to the execution endpoint
 */

const { z } = require('zod');

// HTTP method validation
const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Environment variable reference pattern
const EnvVarPattern = z.string().regex(
  /^process\.env\.[A-Z_][A-Z0-9_]*$/,
  'Must be a valid environment variable reference like process.env.API_KEY'
);

// URL validation
const HttpUrl = z.string().url().refine(
  (url) => url.startsWith('https://') || url.startsWith('http://'),
  'Must be a valid HTTP/HTTPS URL'
);

// JavaScript identifier validation for variable/method names
const JavaScriptIdentifier = z.string().regex(
  /^[a-zA-Z_][a-zA-Z0-9_]*$/,
  'Must be a valid JavaScript identifier'
).refine(
  (name) => !['constructor', 'prototype', '__proto__', 'eval', 'Function'].includes(name),
  'Cannot use reserved JavaScript keywords'
).max(50, 'Variable/method name too long (max 50 characters)');

// Fetch options schema
const FetchOptions = z.object({
  url: HttpUrl,
  method: HttpMethod.optional().default('GET'),
  body: z.union([
    z.string(),
    z.object({}).passthrough(), // Allow any object for JSON body
    z.null()
  ]).optional()
}).strict();

// Headers schema - allows environment variable substitution
const Headers = z.record(
  z.string(), // header name
  z.string()  // header value (can contain env var references)
).optional();

// Single data variable configuration (new format)
const DataVariableConfig = z.object({
  // Optional credential reference (for documentation/clarity)
  credential: EnvVarPattern.optional(),

  // Required fetch configuration
  fetchOptions: FetchOptions,

  // Optional headers (often contains Authorization)
  headers: Headers,

  // Optional additional configuration
  timeout: z.number().min(1000).max(30000).optional()
}).strict();

// Single data method configuration (legacy format)
const DataMethodConfig = z.object({
  // Optional credential reference (for documentation/clarity)
  credential: EnvVarPattern.optional(),

  // Required fetch configuration
  fetchOptions: FetchOptions,

  // Optional headers (often contains Authorization)
  headers: Headers,

  // Optional additional configuration
  timeout: z.number().min(1000).max(30000).optional()
}).strict();

// Secure data variables object (new format)
const SecureDataVariables = z.record(
  JavaScriptIdentifier, // variable name
  DataVariableConfig    // variable configuration
).refine(
  (variables) => Object.keys(variables).length <= 10,
  'Maximum 10 data variables allowed per request'
).refine(
  (variables) => Object.keys(variables).length > 0,
  'At least one data variable is required'
);

// Secure data methods object (legacy format)
const SecureDataMethods = z.record(
  JavaScriptIdentifier, // method name
  DataMethodConfig      // method configuration
).refine(
  (methods) => Object.keys(methods).length <= 10,
  'Maximum 10 data methods allowed per request'
).refine(
  (methods) => Object.keys(methods).length > 0,
  'At least one data method is required'
);

// Global code validation
const GlobalCode = z.string()
  .min(1, 'Global code cannot be empty')
  .max(50000, 'Global code too long (max 50KB)')
  .refine(
    (code) => {
      // Basic validation - ensure it's not trying to access process.env directly
      const suspiciousPatterns = [
        /require\s*\(\s*['"`]child_process['"`]\s*\)/,
        /require\s*\(\s*['"`]fs['"`]\s*\)/,
        /eval\s*\(/,
        /Function\s*\(/
      ];
      return !suspiciousPatterns.some(pattern => pattern.test(code));
    },
    'Global code contains potentially unsafe patterns'
  );

// Main request payload schema (new format)
const SecureTwoPhaseExecutionRequest = z.object({
  // Required: Secure data variables configuration
  secure_data_variables: SecureDataVariables,

  // Required: Global code to execute
  Global_code: GlobalCode,

  // Optional: Overall execution timeout
  timeout: z.number().min(5000).max(120000).optional().default(30000),

  // Optional: Enable AI analysis of results
  ai_eval: z.boolean().optional().default(false),

  // Optional: Encrypt response messages
  encrypt_messages: z.boolean().optional().default(false)
}).strict();

// Legacy request payload schema (for backward compatibility)
const SecureTwoPhaseExecutionRequestLegacy = z.object({
  // Required: Secure data methods configuration (legacy)
  Secure_data_methods: SecureDataMethods,

  // Required: Global code to execute
  Global_code: GlobalCode,

  // Optional: Overall execution timeout
  timeout: z.number().min(5000).max(120000).optional().default(30000),

  // Optional: Enable AI analysis of results
  ai_eval: z.boolean().optional().default(false),

  // Optional: Encrypt response messages
  encrypt_messages: z.boolean().optional().default(false)
}).strict();

// Union schema that accepts both formats
const SecureTwoPhaseExecutionRequestUnion = z.union([
  SecureTwoPhaseExecutionRequest,
  SecureTwoPhaseExecutionRequestLegacy
]);

// Response schemas
const SecureExecutionSuccess = z.object({
  success: z.literal(true),
  data: z.object({
    stdout: z.string(),
    stderr: z.string(),
    result: z.any().optional(),
    errors: z.array(z.object({
      message: z.string(),
      type: z.string()
    })),
    code: z.number(),
    executionTime: z.number(),
    executionMode: z.literal('secure-two-phase'),
    dataMethodsUsed: z.array(z.string()),
    securityFiltered: z.literal(true)
  })
});

const SecureExecutionError = z.object({
  success: z.literal(false),
  error: z.string(),
  details: z.string().optional(),
  executionMode: z.string().optional()
});

const SecureExecutionResponse = z.union([
  SecureExecutionSuccess,
  SecureExecutionError
]);

// Helper functions for MCP servers
const ValidationHelpers = {
  /**
   * Validate a complete secure execution request (supports both formats)
   */
  validateRequest: (payload) => {
    try {
      return {
        success: true,
        data: SecureTwoPhaseExecutionRequestUnion.parse(payload)
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.errors || []
      };
    }
  },

  /**
   * Validate just the data variables part (new format)
   */
  validateDataVariables: (dataVariables) => {
    try {
      return {
        success: true,
        data: SecureDataVariables.parse(dataVariables)
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.errors || []
      };
    }
  },

  /**
   * Validate a single data variable configuration (new format)
   */
  validateDataVariable: (variableConfig) => {
    try {
      return {
        success: true,
        data: DataVariableConfig.parse(variableConfig)
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.errors || []
      };
    }
  },

  /**
   * Validate just the data methods part (legacy format)
   */
  validateDataMethods: (dataMethods) => {
    try {
      return {
        success: true,
        data: SecureDataMethods.parse(dataMethods)
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.errors || []
      };
    }
  },

  /**
   * Validate a single data method configuration (legacy format)
   */
  validateDataMethod: (methodConfig) => {
    try {
      return {
        success: true,
        data: DataMethodConfig.parse(methodConfig)
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        details: error.errors || []
      };
    }
  },

  /**
   * Create a basic request template (new format)
   */
  createRequestTemplate: (variableName, apiUrl, envVarName) => {
    return {
      secure_data_variables: {
        [variableName]: {
          credential: `process.env.${envVarName}`,
          fetchOptions: {
            url: apiUrl,
            method: 'GET'
          },
          headers: {
            Authorization: `Bearer process.env.${envVarName}`
          }
        }
      },
      Global_code: `
        let result = await ${variableName}();
        console.log('API call result:', typeof result);
        if (result.data) {
          console.log('Data received successfully');
        } else {
          console.log('No data in result');
        }
      `.trim()
    };
  },

  /**
   * Create a basic request template (legacy format)
   */
  createRequestTemplateLegacy: (methodName, apiUrl, envVarName) => {
    return {
      Secure_data_methods: {
        [methodName]: {
          credential: `process.env.${envVarName}`,
          fetchOptions: {
            url: apiUrl,
            method: 'GET'
          },
          headers: {
            Authorization: `Bearer process.env.${envVarName}`
          }
        }
      },
      Global_code: `
        let result = await ${methodName}();
        console.log('API call result:', typeof result);
        if (result.data) {
          console.log('Data received successfully');
        } else {
          console.log('No data in result');
        }
      `.trim()
    };
  },

  /**
   * Create a request with multiple API calls (new format)
   */
  createMultiApiRequest: (apiConfigs, globalCode) => {
    const dataVariables = {};

    apiConfigs.forEach(config => {
      dataVariables[config.variableName] = {
        credential: config.envVar ? `process.env.${config.envVar}` : undefined,
        fetchOptions: {
          url: config.url,
          method: config.method || 'GET',
          body: config.body
        },
        headers: config.headers || (config.envVar ? {
          Authorization: `Bearer process.env.${config.envVar}`
        } : {})
      };
    });

    return {
      secure_data_variables: dataVariables,
      Global_code: globalCode
    };
  },

  /**
   * Create a request with multiple API calls (legacy format)
   */
  createMultiApiRequestLegacy: (apiConfigs, globalCode) => {
    const dataMethods = {};

    apiConfigs.forEach(config => {
      dataMethods[config.methodName] = {
        credential: config.envVar ? `process.env.${config.envVar}` : undefined,
        fetchOptions: {
          url: config.url,
          method: config.method || 'GET',
          body: config.body
        },
        headers: config.headers || (config.envVar ? {
          Authorization: `Bearer process.env.${config.envVar}`
        } : {})
      };
    });

    return {
      Secure_data_methods: dataMethods,
      Global_code: globalCode
    };
  }
};

// Export schemas and helpers
module.exports = {
  // Main schemas (new format)
  SecureTwoPhaseExecutionRequest,
  SecureExecutionResponse,
  SecureExecutionSuccess,
  SecureExecutionError,

  // Legacy schemas
  SecureTwoPhaseExecutionRequestLegacy,
  SecureTwoPhaseExecutionRequestUnion,

  // Component schemas (new format)
  SecureDataVariables,
  DataVariableConfig,

  // Component schemas (legacy format)
  SecureDataMethods,
  DataMethodConfig,

  // Shared schemas
  FetchOptions,
  Headers,
  GlobalCode,
  HttpMethod,
  HttpUrl,
  EnvVarPattern,
  JavaScriptIdentifier,

  // Helper functions
  ValidationHelpers
};

// Usage examples for MCP servers
const UsageExamples = {
  /**
   * Example: Basic API call validation (new format)
   */
  basicExample: () => {
    const payload = {
      secure_data_variables: {
        getUser: {
          credential: 'process.env.GITHUB_TOKEN',
          fetchOptions: {
            url: 'https://api.github.com/user',
            method: 'GET'
          },
          headers: {
            Authorization: 'Bearer process.env.GITHUB_TOKEN',
            'User-Agent': 'MyMCPServer/1.0'
          }
        }
      },
      Global_code: `
        let user = await getUser();
        if (user.data && user.data.body) {
          console.log('User data retrieved');
        } else {
          console.log('Failed to get user data');
        }
      `
    };

    const validation = ValidationHelpers.validateRequest(payload);
    console.log('Validation result:', validation);
    return validation;
  },

  /**
   * Example: Multiple API calls (new format)
   */
  multipleApiExample: () => {
    const apiConfigs = [
      {
        variableName: 'getProfile',
        url: 'https://api.github.com/user',
        envVar: 'GITHUB_TOKEN',
        method: 'GET'
      },
      {
        variableName: 'getRepos',
        url: 'https://api.github.com/user/repos',
        envVar: 'GITHUB_TOKEN',
        method: 'GET'
      }
    ];

    const globalCode = `
      console.log('Fetching GitHub data...');

      let profile = await getProfile();
      let repos = await getRepos();

      if (profile.data && repos.data) {
        console.log('Successfully retrieved all GitHub data');
      } else {
        console.log('Some API calls failed');
      }
    `;

    const request = ValidationHelpers.createMultiApiRequest(apiConfigs, globalCode);
    const validation = ValidationHelpers.validateRequest(request);

    console.log('Multi-API validation result:', validation);
    return { request, validation };
  }
};

// Export usage examples separately
module.exports.UsageExamples = UsageExamples;