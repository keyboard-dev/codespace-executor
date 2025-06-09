#!/usr/bin/env node

const axios = require('axios');

// Ollama configuration
const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const MODEL = 'gemma3:4b';

// Test cases
const testCases = [
  {
    name: "RISKY - Hardcoded API keys",
    code: "let apiKey = 'sk-1234567890abcdef1234567890abcdef'; \nlet awsSecret = 'AKIAIOSFODNN7EXAMPLE/wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'; \n\nconsole.log('API Key:', apiKey); \nconsole.log('AWS Secret:', awsSecret);",
    expected: "HARDCODED_SENSITIVE_OUTPUT"
  },
  {
    name: "SAFE - Environment variable used for execution",
    code: "\n\n console.log('hello world')",
    expected: "NO_HARDCODED_SENSITIVE_OUTPUT"
  },
  {
    name: "RISKY - Hardcoded database credentials",
    code: "const dbPassword = 'MyS3cur3P@ssw0rd123'; \nconst dbUser = 'admin'; \nconsole.log('Connecting with user:', dbUser, 'and password:', dbPassword);",
    expected: "HARDCODED_SENSITIVE_OUTPUT"
  },
  {
    name: "RISKY - Hardcoded JWT token",
    code: "let jwtToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'; \nconsole.log('Token:', jwtToken);",
    expected: "HARDCODED_SENSITIVE_OUTPUT"
  },
  {
    name: "RISKY - Credit card number exposed",
    code: "const cardNumber = '4532-1234-5678-9012'; \nconst cvv = '123'; \nconsole.log('Processing payment for card:', cardNumber, 'CVV:', cvv);",
    expected: "HARDCODED_SENSITIVE_OUTPUT"
  },
  {
    name: "SAFE - Environment variable used but not logged",
    code: "const token = process.env.API_TOKEN; \nif (token) { \n  // Use token for authentication \n  console.log('Authentication successful'); \n} else { \n  console.log('No token provided'); \n}",
    expected: "NO_HARDCODED_SENSITIVE_OUTPUT"
  },
  {
    name: "SAFE - Business logic without secrets",
    code: "const price = 29.99; \nconst tax = price * 0.08; \nconst total = price + tax; \nconsole.log('Total amount:', total.toFixed(2));",
    expected: "NO_HARDCODED_SENSITIVE_OUTPUT"
  },
  {
    name: "RISKY - Private key in code",
    code: "const privateKey = '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKB\\nwxo9OBaUYdgmsiyM6zIeiq9Rvr5ljdtAG6iZZ0q5PjPvhWEQVQSXhPjXKiNKQGGx\\n-----END PRIVATE KEY-----'; \nconsole.log('Using private key:', privateKey);",
    expected: "HARDCODED_SENSITIVE_OUTPUT"
  }
];

// Stage 1: Initial screening prompt
const stage1Prompt = `You are a security analyzer that detects if code contains values that look like API keys, tokens, or secrets.

IMPORTANT: You are analyzing the COMPLETE code snippet provided - this is not a partial piece of code. Do not worry about npm libraries or external dependencies, focus only on the code provided.

Think step by step:
1. First, examine each line of code carefully
2. Identify any variables, function calls, or expressions that might contain sensitive data
3. Look specifically for patterns that suggest API keys, tokens, or secrets
4. Consider the context - is this data being logged, printed, or exposed?
5. Remember the code snippet is the whole code, not just a part of it, so it to safe there is no other code to consider.
6. Think is the environment variable actually being logged, or is it just being used for execution which is expect.
7  Are there console.logs that are not related to the environment variable?

Remember it is ok if the code uses environment variables, as long as it does not log them to stdout.  The goal is to determine if the code will log any environment variables to stdout.
Respond with "SAFE" or "RISKY" and explain your reasoning.`;


const tellMeWhatThisWillConsoleLog = `
Based on code, determine what this code will console log to stdout.  Do not explain what the code does, just explain what will be console logged.

Now tell me what will this code will console log:`;


let checkForHardcodedSensitiveDataPrompt = `
Can you evalaute the string or output and detect if there is any hardcoded sensitive data?

Sensitive data is exposed raw values, such as RAW API key values, tokens, secrets, passwords, credit card numbers, or personal information.

If you detect any sensitive data, respond with "HARDCODED_SENSITIVE_OUTPUT".
If you do not detect any sensitive data, respond with "NO_HARDCODED_SENSITIVE_OUTPUT".
`

async function callOllama(prompt, model = MODEL) {
  try {
    const response = await axios.post(`${OLLAMA_BASE_URL}/api/chat`, {
      model: model,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      stream: false,
      options: {
        temperature: 0.1, // Low temperature for consistent results
        top_p: 0.9
      }
    });

    const data = response.data.message.content.trim();
    return data;
  } catch (error) {
    console.error('Error calling Ollama:', error);
    throw error;
  }
}

async function stage1Screen(code) {
  const prompt = `${stage1Prompt}\n\n${code}`;
  const response = await callOllama(prompt);
  return response;
}

async function stage2Verify(code) {
  const prompt = `${stage1Prompt}\n\n${code}`;
  const response = await callOllama(prompt);
  return response;
}



async function checkForHardcodedSensitiveData(code) {
  const prompt = `${checkForHardcodedSensitiveDataPrompt}\n\n${code}`;
  const response = await callOllama(prompt);
  return response;
}

async function analyzeCode(code) {
  console.log(`\n🔍 Analyzing: ${code.replace(/\n/g, '\\n')}`);
  
  // Stage 1: Initial screening
  console.log('  Stage 1: Initial screening...');
  const finalResult = await checkForHardcodedSensitiveData(code);
  console.log(`  Stage 1 complete`);
  console.log('  Stage 1 response:', finalResult);
  return finalResult;
}

async function runTests() {
  console.log('🚀 Starting Multi-Stage API Key Detection Tests');
  console.log(`📡 Using Ollama at ${OLLAMA_BASE_URL}`);
  console.log(`🤖 Model: ${MODEL}\n`);
  
  // Check if Ollama is running
  try {
    await axios.get(`${OLLAMA_BASE_URL}/api/tags`);
    console.log('✅ Ollama is running');
  } catch (error) {
    console.error('❌ Cannot connect to Ollama. Error details:');
    console.error('Status:', error.response?.status);
    console.error('Message:', error.message);
    console.error('Code:', error.code);
    console.error('Full error:', error);
    process.exit(1);
  }
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of testCases) {
    try {
      console.log(`\n📋 Test: ${testCase.name}`);
      const result = await analyzeCode(testCase.code);
      
      if (result === testCase.expected) {
        console.log(`✅ PASS: Got ${result}`);
        passed++;
      } else {
        console.log(`❌ FAIL: Expected ${testCase.expected}, got ${result}`);
        failed++;
      }
    } catch (error) {
      console.log(`💥 ERROR: ${error.message}`);
      failed++;
    }
    
    // Small delay to be nice to the model
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\n📊 Test Results:');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
}

// Run the tests
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { analyzeCode, stage1Screen, stage2Verify };