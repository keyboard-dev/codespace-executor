const WebSocket = require('ws');

// You'll need to get this URL from the server output
// Format: ws://127.0.0.1:4000?key=YOUR_GENERATED_KEY
const WS_URL = 'ws://127.0.0.1:4000?key=REPLACE_WITH_ACTUAL_KEY';

console.log('🔗 Connecting to WebSocket server...');
console.log('URL:', WS_URL);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✅ Connected to WebSocket server!');
  
  // Test different message types
  setTimeout(() => {
    console.log('📤 Sending token request...');
    ws.send(JSON.stringify({
      type: 'request-token',
      requestId: 'test-123'
    }));
  }, 1000);

  setTimeout(() => {
    console.log('📤 Sending provider token request...');
    ws.send(JSON.stringify({
      type: 'request-provider-token',
      providerId: 'github',
      requestId: 'test-456'
    }));
  }, 2000);

  setTimeout(() => {
    console.log('📤 Sending test message...');
    ws.send(JSON.stringify({
      type: 'test-message',
      data: 'Hello from test client!',
      id: 'msg-789'
    }));
  }, 3000);
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log('📥 Received:', message);
  } catch (error) {
    console.log('📥 Received (raw):', data.toString());
  }
});

ws.on('close', () => {
  console.log('👋 Disconnected from WebSocket server');
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Closing connection...');
  ws.close();
  process.exit(0);
});