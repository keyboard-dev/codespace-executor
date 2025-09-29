#!/usr/bin/env node

const SecureExecutor = require('./src/secure/SecureExecutor');

// Test just the World Time API
const testPayload = {
  "api_calls": {
    "getTimeAPI": {
      "url": "https://worldtimeapi.org/api/timezone/UTC",
      "method": "GET"
    }
  },
  "global_code": "console.log(\\\"Testing single API call...\\\");\ntry {\n  const timeResponse = await getTimeAPI();\n  console.log(\\\"World Time API Response:\\\", timeResponse);\n  console.log(\\\"✅ API call completed successfully!\\\");\n} catch (error) {\n  console.error(\\\"❌ Error:\\\", error.message);\n}"
};

async function testSingleAPI() {
  console.log('🧪 Testing single World Time API call...\n');

  const executor = new SecureExecutor({
    timeout: 45000,
    maxDataMethodTimeout: 20000
  });

  try {
    const result = await executor.executeCode(testPayload, {});

    console.log('✅ Execution completed!');
    console.log('- Success:', result.success);

    if (result.success) {
      console.log('STDOUT:', result.data.stdout);
      if (result.data.stderr && result.data.stderr.trim()) {
        console.log('STDERR:', result.data.stderr);
      }
    } else {
      console.log('❌ Failed:', result.error || result);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testSingleAPI();