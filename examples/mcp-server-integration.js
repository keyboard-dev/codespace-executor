/**
 * Example MCP Server Integration with Secure Two-Phase Execution
 * This shows how an MCP server can safely make API calls using the secure execution system
 */

const http = require('http');
const { ValidationHelpers } = require('../schemas/secure-execution-schema');

class SecureExecutionMCPTool {
  constructor(executionServerUrl = 'http://localhost:3000') {
    this.executionServerUrl = executionServerUrl;
  }

  /**
   * Make a secure API call through the two-phase execution system (new format)
   */
  async makeSecureApiCall(variableName, apiConfig, globalCode, options = {}) {
    // Build the request payload using new format
    const payload = {
      secure_data_variables: {
        [variableName]: {
          credential: apiConfig.credential,
          fetchOptions: {
            url: apiConfig.url,
            method: apiConfig.method || 'GET',
            body: apiConfig.body
          },
          headers: apiConfig.headers || {}
        }
      },
      Global_code: globalCode,
      timeout: options.timeout || 30000,
      ai_eval: options.ai_eval || false
    };

    // Validate the request before sending
    const validation = ValidationHelpers.validateRequest(payload);
    if (!validation.success) {
      throw new Error(`Request validation failed: ${validation.error}`);
    }

    // Send to execution server
    try {
      const response = await this.sendRequest('/execute', payload);

      if (!response.success) {
        throw new Error(`Execution failed: ${response.error}`);
      }

      return {
        success: true,
        output: response.data.stdout,
        result: response.data.result,
        errors: response.data.errors,
        executionMode: response.data.executionMode,
        securityFiltered: response.data.securityFiltered
      };

    } catch (error) {
      throw new Error(`Secure execution failed: ${error.message}`);
    }
  }

  /**
   * Make multiple secure API calls in one execution (new format)
   */
  async makeMultipleSecureApiCalls(apiConfigs, globalCode, options = {}) {
    const dataVariables = {};

    // Build data variables object
    apiConfigs.forEach(config => {
      dataVariables[config.variableName] = {
        credential: config.credential,
        fetchOptions: {
          url: config.url,
          method: config.method || 'GET',
          body: config.body
        },
        headers: config.headers || {}
      };
    });

    const payload = {
      secure_data_variables: dataVariables,
      Global_code: globalCode,
      timeout: options.timeout || 45000 // Longer timeout for multiple calls
    };

    // Validate the request
    const validation = ValidationHelpers.validateRequest(payload);
    if (!validation.success) {
      throw new Error(`Request validation failed: ${validation.error}`);
    }

    // Send to execution server
    try {
      const response = await this.sendRequest('/execute', payload);

      if (!response.success) {
        throw new Error(`Execution failed: ${response.error}`);
      }

      return {
        success: true,
        output: response.data.stdout,
        result: response.data.result,
        dataVariablesUsed: response.data.dataMethodsUsed, // Note: Server still returns dataMethodsUsed for compatibility
        securityFiltered: response.data.securityFiltered
      };

    } catch (error) {
      throw new Error(`Multi-API execution failed: ${error.message}`);
    }
  }

  /**
   * Helper method to send HTTP requests
   */
  async sendRequest(endpoint, payload) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const url = new URL(endpoint, this.executionServerUrl);

      const options = {
        hostname: url.hostname,
        port: url.port || 3000,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length
        }
      };

      const req = http.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${responseData}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(data);
      req.end();
    });
  }
}

// Example usage for different MCP server scenarios

/**
 * Example 1: GitHub API Integration
 */
async function exampleGitHubIntegration() {
  const tool = new SecureExecutionMCPTool();

  try {
    const result = await tool.makeSecureApiCall(
      'getUserProfile',
      {
        credential: 'process.env.GITHUB_TOKEN',
        url: 'https://api.github.com/user',
        method: 'GET',
        headers: {
          'Authorization': 'Bearer process.env.GITHUB_TOKEN',
          'User-Agent': 'MCP-Server/1.0'
        }
      },
      `
        let profile = await getUserProfile();

        if (profile.data && profile.data.body) {
          console.log('✅ GitHub profile retrieved successfully');

          // Safe to process - no credentials will be present
          const userData = profile.data.body;
          if (userData.login) {
            console.log('Username found in profile');
            return { username: userData.login, success: true };
          }
        } else {
          console.log('❌ Failed to retrieve GitHub profile');
          return { success: false, error: 'No profile data' };
        }
      `
    );

    console.log('GitHub integration result:', result);
    return result;

  } catch (error) {
    console.error('GitHub integration failed:', error.message);
    throw error;
  }
}

/**
 * Example 2: Google Docs API Integration
 */
async function exampleGoogleDocsIntegration(documentId) {
  const tool = new SecureExecutionMCPTool();

  try {
    const result = await tool.makeSecureApiCall(
      'getGoogleDoc',
      {
        credential: 'process.env.GOOGLE_DOCS_TOKEN',
        url: `https://docs.googleapis.com/v1/documents/${documentId}`,
        method: 'GET',
        headers: {
          'Authorization': 'Bearer process.env.GOOGLE_DOCS_TOKEN'
        }
      },
      `
        let doc = await getGoogleDoc();

        if (doc.data && doc.data.body) {
          console.log('✅ Google Doc retrieved successfully');

          const docData = doc.data.body;
          if (docData.title) {
            console.log('Document title found');
            return {
              title: docData.title,
              hasContent: !!docData.body,
              success: true
            };
          }
        } else {
          console.log('❌ Failed to retrieve Google Doc');
          return { success: false, error: 'No document data' };
        }
      `
    );

    console.log('Google Docs integration result:', result);
    return result;

  } catch (error) {
    console.error('Google Docs integration failed:', error.message);
    throw error;
  }
}

/**
 * Example 3: Multiple API Calls (GitHub + Weather)
 */
async function exampleMultipleApiIntegration() {
  const tool = new SecureExecutionMCPTool();

  try {
    const result = await tool.makeMultipleSecureApiCalls(
      [
        {
          variableName: 'getGitHubProfile',
          credential: 'process.env.GITHUB_TOKEN',
          url: 'https://api.github.com/user',
          method: 'GET',
          headers: {
            'Authorization': 'Bearer process.env.GITHUB_TOKEN'
          }
        },
        {
          variableName: 'getWeatherData',
          credential: 'process.env.WEATHER_API_KEY',
          url: 'https://api.openweathermap.org/data/2.5/weather?q=London&appid=process.env.WEATHER_API_KEY',
          method: 'GET'
        }
      ],
      `
        console.log('🔄 Fetching data from multiple APIs...');

        let github = await getGitHubProfile();
        let weather = await getWeatherData();

        const results = {
          github: {
            success: !!(github.data && github.data.body),
            hasUser: !!(github.data && github.data.body && github.data.body.login)
          },
          weather: {
            success: !!(weather.data && weather.data.body),
            hasTemp: !!(weather.data && weather.data.body && weather.data.body.main)
          }
        };

        console.log('📊 API Results Summary:');
        console.log('- GitHub API:', results.github.success ? '✅' : '❌');
        console.log('- Weather API:', results.weather.success ? '✅' : '❌');

        return results;
      `
    );

    console.log('Multiple API integration result:', result);
    return result;

  } catch (error) {
    console.error('Multiple API integration failed:', error.message);
    throw error;
  }
}

/**
 * Example 4: Error Handling and Validation
 */
async function exampleErrorHandling() {
  const tool = new SecureExecutionMCPTool();

  try {
    // This should fail validation due to invalid URL
    await tool.makeSecureApiCall(
      'invalidTest',
      {
        credential: 'process.env.API_KEY',
        url: 'not-a-valid-url',
        method: 'GET'
      },
      'console.log("This should not execute");'
    );

  } catch (error) {
    console.log('✅ Validation correctly caught invalid URL:', error.message);
  }

  try {
    // This should fail due to invalid method name
    await tool.makeSecureApiCall(
      'invalid-method-name',
      {
        credential: 'process.env.API_KEY',
        url: 'https://api.example.com',
        method: 'GET'
      },
      'console.log("This should not execute");'
    );

  } catch (error) {
    console.log('✅ Validation correctly caught invalid method name:', error.message);
  }
}

// MCP Server Tool Definition (updated for new format)
const MCPToolDefinition = {
  name: 'secure_api_execution',
  description: 'Execute API calls securely with credential isolation using secure_data_variables',
  inputSchema: {
    type: 'object',
    properties: {
      variableName: {
        type: 'string',
        description: 'Name for the API variable (must be valid JavaScript identifier)'
      },
      apiUrl: {
        type: 'string',
        description: 'The API endpoint URL'
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        default: 'GET',
        description: 'HTTP method'
      },
      envVarName: {
        type: 'string',
        description: 'Name of environment variable containing the API key'
      },
      headers: {
        type: 'object',
        description: 'Additional headers to send with the request'
      },
      globalCode: {
        type: 'string',
        description: 'JavaScript code to execute with access to the API response'
      },
      timeout: {
        type: 'number',
        default: 30000,
        description: 'Execution timeout in milliseconds'
      }
    },
    required: ['variableName', 'apiUrl', 'envVarName', 'globalCode']
  }
};

// Export everything for use in MCP servers
module.exports = {
  SecureExecutionMCPTool,
  MCPToolDefinition,
  examples: {
    exampleGitHubIntegration,
    exampleGoogleDocsIntegration,
    exampleMultipleApiIntegration,
    exampleErrorHandling
  }
};