#!/usr/bin/env node

const SecureExecutor = require('./src/secure/SecureExecutor');

// Test with headers that were being sanitized
const testPayload = {
  "api_calls": {
    "getGitHubZen": {
      "url": "https://api.github.com/zen",
      "method": "GET",
      "headers": {
        "User-Agent": "restricted-run-code-tool/1.0",
        "Accept": "text/plain"
      }
    }
  },
  "global_code": "let item = await getGitHubZen();\nconsole.log(item);"
};

async function testHeadersFix() {
  console.log('🧪 Testing headers fix...\n');

  const executor = new SecureExecutor({
    timeout: 30000,
    maxDataMethodTimeout: 15000
  });

  try {
    console.log('📝 Testing with headers:', testPayload.api_calls.getGitHubZen.headers);

    const result = await executor.executeCode(testPayload, {});

    console.log('\n✅ Execution completed!');
    console.log('- Success:', result.success);

    if (result.success) {
      console.log('\n📝 Output:');
      console.log('STDOUT:', result.data.stdout);
      if (result.data.stderr && result.data.stderr.trim()) {
        console.log('STDERR:', result.data.stderr);
      }

      // Check if we're getting a valid response instead of the User-Agent error
      const stdout = result.data.stdout || '';
      if (stdout.includes('"success":false') && stdout.includes('User-Agent')) {
        console.log('\n❌ Still getting User-Agent error - headers not working');
      } else if (stdout.includes('"success":true') || stdout.includes('zen')) {
        console.log('\n🎉 Headers fix successful - no more User-Agent error!');
      } else {
        console.log('\n🤔 Unexpected response format');
      }
    } else {
      console.log('\n❌ Failed:', result.error || result);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testHeadersFix();