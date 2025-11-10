/**
 * Test script for WebSocket message queue functionality
 *
 * This script tests the scenario where:
 * 1. A message is sent when no clients are connected (should be queued)
 * 2. A client connects later (should receive the queued message)
 */

const WebSocket = require('ws')
const fs = require('fs')
const path = require('path')
const os = require('os')

// Read the WebSocket key
const WS_KEY_FILE = path.join(os.homedir(), '.keyboard-mcp', '.keyboard-mcp-ws-key')

async function getWebSocketKey() {
  try {
    const keyData = fs.readFileSync(WS_KEY_FILE, 'utf8')
    const parsedData = JSON.parse(keyData)
    return parsedData.key
  } catch (error) {
    console.error('❌ Error reading WebSocket key:', error.message)
    console.log('💡 Make sure the WebSocket server is running first')
    process.exit(1)
  }
}

async function testMessageQueue() {
  console.log('🧪 Testing WebSocket Message Queue\n')

  const key = await getWebSocketKey()
  const wsUrl = `ws://127.0.0.1:4002?key=${key}`

  // Test 1: Connect a client and send a message to trigger queuing
  console.log('📋 Test 1: Sending message with only one client connected')
  console.log('   (Message should be queued for other clients)\n')

  const client1 = new WebSocket(wsUrl)

  await new Promise((resolve) => {
    client1.on('open', () => {
      console.log('✅ Client 1 connected')

      // Send a test message - this will be queued for future clients
      const testMessage = {
        type: 'request-provider-token',
        providerId: 'test-provider',
        requestId: 'test-request-123',
        timestamp: Date.now()
      }

      console.log('📤 Client 1 sending message:', JSON.stringify(testMessage, null, 2))
      client1.send(JSON.stringify(testMessage))

      // Wait a moment for the message to be processed
      setTimeout(resolve, 1000)
    })
  })

  // Test 2: Connect a second client after a delay
  console.log('\n📋 Test 2: Connecting second client after 2 seconds')
  console.log('   (Should receive queued messages)\n')

  await new Promise((resolve) => setTimeout(resolve, 2000))

  const client2 = new WebSocket(wsUrl)
  let receivedMessages = []

  client2.on('message', (data) => {
    const message = JSON.parse(data.toString())
    receivedMessages.push(message)
    console.log('📨 Client 2 received queued message:', JSON.stringify(message, null, 2))
  })

  await new Promise((resolve) => {
    client2.on('open', () => {
      console.log('✅ Client 2 connected')

      // Wait a bit to receive any queued messages
      setTimeout(() => {
        console.log(`\n📊 Client 2 received ${receivedMessages.length} queued message(s)`)

        if (receivedMessages.length > 0) {
          console.log('✅ SUCCESS: Message queue is working!')
          console.log('   Messages were queued and delivered to the late-connecting client')
        } else {
          console.log('⚠️  WARNING: No messages received')
          console.log('   This might mean the queue TTL expired or messages weren\'t queued')
        }

        resolve()
      }, 2000)
    })
  })

  // Cleanup
  client1.close()
  client2.close()

  console.log('\n🧪 Test completed\n')
}

// Run the test
testMessageQueue().catch((error) => {
  console.error('❌ Test failed:', error)
  process.exit(1)
})
