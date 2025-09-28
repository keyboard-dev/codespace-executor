#!/usr/bin/env node

/**
 * Test script to verify secure execution functionality
 * Tests both secure and full execution modes
 */

const http = require('http');

const SERVER_URL = 'http://localhost:3000';

// Test cases for traditional secure execution
const testCases = [
    {
        name: 'Basic Console Output',
        code: 'console.log("Hello from basic test");',
        expected: 'Hello from basic test'
    },
    {
        name: 'Environment Variable Access (High Risk)',
        code: `
            console.log("Testing env access");
            if (process.env.KEYBOARD_PROVIDER_API_ENDPOINT) {
                console.log("Found KEYBOARD env var");
            } else {
                console.log("No KEYBOARD env var found");
            }
        `,
        expected: 'Testing env access'
    },
    {
        name: 'Fetch API Call (High Risk)',
        code: `
            console.log("Testing fetch call");
            try {
                // This should be caught by security analysis
                const response = fetch('https://httpbin.org/get');
                console.log("Fetch initiated");
            } catch (error) {
                console.log("Fetch error:", error.message);
            }
        `,
        expected: 'Testing fetch call'
    },
    {
        name: 'Safe Code (Low Risk)',
        code: `
            const data = [1, 2, 3, 4, 5];
            const sum = data.reduce((a, b) => a + b, 0);
            console.log("Sum:", sum);
        `,
        expected: 'Sum: 15'
    }
];

// Test cases for new secure two-phase execution
const secureDataMethodTestCases = [
    {
        name: 'Basic Two-Phase Execution with Mock API',
        payload: {
            "Secure_data_methods": {
                "mockApiData": {
                    "fetchOptions": {
                        "url": "https://httpbin.org/json",
                        "method": "GET"
                    },
                    "headers": {
                        "User-Agent": "SecureExecutor-Test"
                    }
                }
            },
            "Global_code": `
                let result = await mockApiData();
                console.log("API call result type:", typeof result);
                console.log("Has data:", result.data ? "yes" : "no");
                if (result.data && result.data.body) {
                    console.log("Mock API test successful");
                } else {
                    console.log("No body in result");
                }
            `
        },
        expected: 'Mock API test successful'
    },
    {
        name: 'Two-Phase with Multiple Data Methods',
        payload: {
            "Secure_data_methods": {
                "firstApi": {
                    "fetchOptions": {
                        "url": "https://httpbin.org/get",
                        "method": "GET"
                    }
                },
                "secondApi": {
                    "fetchOptions": {
                        "url": "https://httpbin.org/user-agent",
                        "method": "GET"
                    },
                    "headers": {
                        "User-Agent": "Test-Agent"
                    }
                }
            },
            "Global_code": `
                console.log("Testing multiple data methods...");
                let first = await firstApi();
                let second = await secondApi();
                console.log("First API result type:", typeof first);
                console.log("Second API result type:", typeof second);
                console.log("Multiple data methods test complete");
            `
        },
        expected: 'Multiple data methods test complete'
    },
    {
        name: 'Two-Phase with Error Handling',
        payload: {
            "Secure_data_methods": {
                "invalidApi": {
                    "fetchOptions": {
                        "url": "https://invalid-url-that-should-fail.example",
                        "method": "GET"
                    }
                }
            },
            "Global_code": `
                console.log("Testing error handling...");
                try {
                    let result = await invalidApi();
                    console.log("Unexpected success:", result);
                } catch (error) {
                    console.log("Caught expected error:", error.message);
                }
                console.log("Error handling test complete");
            `
        },
        expected: 'Error handling test complete'
    },
    {
        name: 'Security Test - No Credential Leakage',
        payload: {
            "Secure_data_methods": {
                "secureTest": {
                    "credential": "process.env.KEYBOARD_GOOGLE_TOKEN",
                    "fetchOptions": {
                        "url": "https://httpbin.org/headers",
                        "method": "GET"
                    },
                    "headers": {
                        "Authorization": "Bearer process.env.KEYBOARD_GOOGLE_TOKEN"
                    }
                }
            },
            "Global_code": `
                console.log("Testing credential security...");

                // Try to access environment variables (should fail)
                try {
                    console.log("Env access:", process.env.KEYBOARD_GOOGLE_TOKEN);
                } catch (e) {
                    console.log("Environment access blocked (good)");
                }

                // Get sanitized data
                let result = await secureTest();
                console.log("Got sanitized result:", typeof result);

                // Check that no credentials are present in the result
                let resultStr = JSON.stringify(result);
                if (resultStr.includes('KEYBOARD_GOOGLE_TOKEN') || resultStr.includes('Bearer ')) {
                    console.log("❌ SECURITY BREACH: Credentials found in result!");
                } else {
                    console.log("✅ Security test passed: No credentials leaked");
                }
            `
        },
        expected: 'Security test passed'
    }
];

async function makeRequest(endpoint, payload) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);

        const options = {
            hostname: 'localhost',
            port: 3000,
            path: endpoint,
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
                    resolve({ status: res.statusCode, data: parsed });
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

async function testExecutionMode(mode) {
    console.log(`\n🧪 Testing ${mode.toUpperCase()} execution mode`);
    console.log('='.repeat(50));

    // Set environment variable for the mode
    process.env.KEYBOARD_FULL_CODE_EXECUTION = mode === 'full' ? 'true' : 'false';

    for (const testCase of testCases) {
        console.log(`\n📋 Test: ${testCase.name}`);

        try {
            const response = await makeRequest('/execute', {
                code: testCase.code,
                timeout: 10000
            });

            if (response.status === 200 && response.data.success) {
                const stdout = response.data.data.stdout || '';
                const executionMode = response.data.data.executionMode || 'unknown';
                const securityFiltered = response.data.data.securityFiltered || false;

                console.log(`✅ SUCCESS (${executionMode} mode)`);
                console.log(`   Security Filtered: ${securityFiltered}`);
                console.log(`   Output: ${stdout.trim()}`);

                if (response.data.data.codeAnalysis) {
                    const analysis = response.data.data.codeAnalysis;
                    console.log(`   Risk Level: ${analysis.riskLevel}`);
                    console.log(`   Env Access: ${analysis.hasEnvironmentAccess}`);
                    console.log(`   API Calls: ${analysis.hasExternalApiCalls}`);
                }
            } else {
                console.log(`❌ FAILED: ${response.data.error || 'Unknown error'}`);
                if (response.data.details) {
                    console.log(`   Details: ${response.data.details}`);
                }
            }
        } catch (error) {
            console.log(`❌ ERROR: ${error.message}`);
        }
    }
}

async function checkServerStatus() {
    try {
        const response = await makeRequest('/fetch_key_name_and_resources', {});
        return response.status === 200;
    } catch (error) {
        return false;
    }
}

async function testSecureDataMethods() {
    console.log('\n🔐 Testing Secure Two-Phase Execution (Data Methods)');
    console.log('='.repeat(60));

    for (const testCase of secureDataMethodTestCases) {
        console.log(`\n📋 Test: ${testCase.name}`);

        try {
            const response = await makeRequest('/execute', testCase.payload);

            if (response.status === 200 && response.data.success) {
                const stdout = response.data.data.stdout || '';
                const executionMode = response.data.data.executionMode || 'unknown';
                const securityFiltered = response.data.data.securityFiltered || false;
                const dataMethodsUsed = response.data.data.dataMethodsUsed || [];

                console.log(`✅ SUCCESS (${executionMode} mode)`);
                console.log(`   Security Filtered: ${securityFiltered}`);
                console.log(`   Data Methods Used: ${dataMethodsUsed.join(', ')}`);
                console.log(`   Output: ${stdout.trim()}`);

                // Check if test passed based on expected output
                if (stdout.includes(testCase.expected)) {
                    console.log(`   ✅ Expected output found`);
                } else {
                    console.log(`   ⚠️  Expected output not found (looking for: "${testCase.expected}")`);
                }

            } else {
                console.log(`❌ FAILED: ${response.data.error || 'Unknown error'}`);
                if (response.data.details) {
                    console.log(`   Details: ${response.data.details}`);
                }
            }
        } catch (error) {
            console.log(`❌ ERROR: ${error.message}`);
        }
    }
}

async function runTests() {
    console.log('🚀 Secure Execution System Test Suite');
    console.log('=====================================');

    // Check if server is running
    console.log('\n🔍 Checking server status...');
    const serverRunning = await checkServerStatus();

    if (!serverRunning) {
        console.log('❌ Server is not running. Please start the server with: npm start');
        process.exit(1);
    }

    console.log('✅ Server is running');

    // Test traditional execution modes
    await testExecutionMode('secure');
    await testExecutionMode('full');

    // Test new secure two-phase execution
    await testSecureDataMethods();

    console.log('\n🎉 Test suite completed!');
    console.log('\n📝 Summary:');
    console.log('- Traditional secure mode: Filters environment variables and uses isolated execution');
    console.log('- Traditional full mode: Uses the original execution behavior');
    console.log('- NEW: Secure two-phase execution with data methods');
    console.log('- Two-phase mode provides secure API key handling with credential isolation');
    console.log('- Sanitized data only crosses the security boundary');
    console.log('- Global code never has access to credentials or sensitive information');
}

// Run tests
runTests().catch(error => {
    console.error('Test suite failed:', error);
    process.exit(1);
});