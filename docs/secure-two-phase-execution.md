# Secure Two-Phase Code Execution API

## Overview

The Secure Two-Phase Execution system provides a secure way to execute code that requires API credentials while maintaining complete credential isolation. This system is designed for MCP servers and other tools that need to make API calls without exposing sensitive credentials to user code.

## Security Architecture

### Phase 1: Isolated Credential Execution
- Executes API calls in a secure, isolated environment
- Has full access to environment variables and credentials
- Performs HTTP requests using Node.js built-in modules
- Captures responses including headers, status, and body

### Data Sanitization Layer
- **Critical Security Boundary**: Strips ALL sensitive information
- Removes credentials, tokens, authorization headers
- Filters out stack traces and error details that might leak info
- Only allows safe data payload to pass through

### Phase 2: Global Code Execution
- Executes user code with ZERO credential access
- Receives only sanitized data from Phase 1
- Cannot access environment variables or credentials
- Functions are injected that return pre-fetched, sanitized data

## API Endpoint

**POST** `/execute`

## Request Payload Structure

```json
{
  "secure_data_variables": {
    "[variableNameOfSafeData]": {
      "credential": "process.env.KEYBOARD_SOME_CREDENTIAL",
      "fetchOptions": {
        "url": "https://api.example.com/endpoint",
        "method": "GET|POST|PUT|PATCH|DELETE",
        "body": "optional request body"
      },
      "headers": {
        "Authorization": `Bearer ${process.env.KEYBOARD_SOME_CREDENTIAL}`,
        "Content-Type": "application/json"
      }
    }
  },
  "Global_code": "JavaScript code that can call methodName() functions",
  "timeout": 30000
}
```

## Example Usage

### Google Docs API Call
```json
{
  "secure_data_variables": {
    "getGoogleDoc": {
      "credential": "process.env.KEYBOARD_GOOGLE_TOKEN",
      "fetchOptions": {
        "url": "https://docs.googleapis.com/v1/documents/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
        "method": "GET"
      },
      "headers": {
        "Authorization": "Bearer process.env.KEYBOARD_GOOGLE_TOKEN"
      }
    }
  },
  "Global_code": `
    let doc = await getGoogleDoc();
    if (doc.data && doc.data.body) {
      console.log('Document title found');
      console.log('Content length:', JSON.stringify(doc.data.body).length);
    } else {
      console.log('No document data received');
    }
  `
}
```

### Multiple API Calls
```json
{
  "secure_data_variables": {
    "getUserProfile": {
      "fetchOptions": {
        "url": "https://api.github.com/user",
        "method": "GET"
      },
      "headers": {
        "Authorization": "Bearer process.env.GITHUB_TOKEN",
        "User-Agent": "MyApp/1.0"
      }
    },
    "getRepositories": {
      "fetchOptions": {
        "url": "https://api.github.com/user/repos",
        "method": "GET"
      },
      "headers": {
        "Authorization": "Bearer process.env.GITHUB_TOKEN"
      }
    }
  },
  "Global_code": `
    console.log('Fetching GitHub data...');

    let profile = await getUserProfile();
    let repos = await getRepositories();

    console.log('Profile type:', typeof profile);
    console.log('Repos type:', typeof repos);

    if (profile.data && repos.data) {
      console.log('Successfully retrieved GitHub data');
    }
  `
}
```

## Security Features

### Credential Protection
- API credentials never appear in Global_code execution environment
- Environment variables are resolved in isolated Phase 1 only
- Authorization headers are stripped from responses

### Data Sanitization
- Removes sensitive patterns: tokens, API keys, credentials
- Filters object keys containing: 'auth', 'token', 'secret', 'password'
- Strips stack traces and detailed error messages
- Removes URLs with embedded credentials

### Rate Limiting
- Maximum 100 data method executions per hour per method
- Configurable limits to prevent abuse
- Tracks execution history and cleans old entries

### Validation
- Method names must follow JavaScript identifier rules
- Maximum 10 data methods per request
- Prevents reserved JavaScript keywords
- Validates HTTP methods and URL formats

## Response Format

### Successful Execution
```json
{
  "success": true,
  "data": {
    "stdout": "Console output from Global_code",
    "stderr": "Error output if any",
    "result": "Return value from Global_code if any",
    "errors": [],
    "code": 0,
    "executionTime": 1234567890,
    "executionMode": "secure-two-phase",
    "dataMethodsUsed": ["methodName1", "methodName2"],
    "securityFiltered": true
  }
}
```

### Error Response
```json
{
  "success": false,
  "error": "Error description",
  "details": "Additional error details",
  "executionMode": "secure-two-phase"
}
```

## Data Method Function Behavior

In the Global_code, each data method becomes an async function:

```javascript
// For a data method named "getApiData"
let result = await getApiData();

// Result structure:
{
  "success": true,
  "data": {
    "body": {}, // Sanitized response body
    "success": true // HTTP success indicator
  },
  "sanitized": true
}

// On error:
{
  "error": true,
  "message": "Data method execution failed",
  "type": "execution_error"
}
```

## Best Practices

### For MCP Servers
1. **Validate credentials** before making requests
2. **Use specific method names** that describe the API being called
3. **Handle errors gracefully** in Global_code
4. **Keep Global_code focused** on data processing, not credential management
5. **Test with minimal examples** first

### Security Considerations
1. **Never log credentials** in Global_code (they won't be available anyway)
2. **Assume all data is sanitized** - no sensitive info will be present
3. **Use HTTPS URLs only** for API calls
4. **Validate response data** structure before using

## Error Handling

```javascript
// In Global_code
try {
  let result = await myApiCall();
  if (result.error) {
    console.log('API call failed:', result.message);
    return;
  }

  // Process sanitized data
  console.log('Data received:', typeof result.data);
} catch (error) {
  console.log('Execution error:', error.message);
}
```

## Testing

Use the included test suite to verify functionality:

```bash
node test_secure_execution.js
```

The test suite includes:
- Basic two-phase execution
- Multiple data methods
- Error handling
- Security validation (credential leakage prevention)