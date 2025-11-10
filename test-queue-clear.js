/**
 * Test script to verify queue is cleared after delivery
 *
 * This tests that:
 * 1. Messages are queued when no clients connected
 * 2. First connecting client receives queued messages
 * 3. Queue is cleared after delivery
 * 4. Second connecting client does NOT receive old messages (prevents loop)
 */

const WebSocket = require('ws')
const fs = require('fs')
const path = require('path')
const os = require('os')

const WS_KEY_FILE = path.join(os.homedir(), '.keyboard-mcp', '.keyboard-mcp-ws-key')

async function getWebSocketKey() {
  try {
    const keyData = fs.readFileSync(WS_KEY_FILE, 'utf8')
    const parsedData = JSON.parse(keyData)
    return parsedData.key
  } catch (error) {
    console.error('❌ Error reading WebSocket key:', error.message)
    process.exit(1)
  }
}

async function testQueueClearing() {
  console.log('🧪 Testing Queue Clearing (Infinite Loop Prevention)\n')

  const key = await getWebSocketKey()
  const wsUrl = `ws://127.0.0.1:4002?key=${key}`

  // Step 1: Connect client 1 and send a message
  console.log('Step 1: Client 1 sends a message')
  const client1 = new WebSocket(wsUrl)

  await new Promise((resolve) => {
    client1.on('open', () => {
      console.log('✅ Client 1 connected')

      const testMessage = {
        type: 'request-provider-token',
        providerId: 'test-provider-1',
        timestamp: Date.now()
      }

      console.log('📤 Client 1 sends:', testMessage.type)
      client1.send(JSON.stringify(testMessage))

      setTimeout(resolve, 1000)
    })
  })

  client1.close()
  console.log('🔌 Client 1 disconnected\n')

  // Step 2: Wait and connect client 2 (should receive queued message)
  console.log('Step 2: Client 2 connects (should receive queued message)')
  await new Promise((resolve) => setTimeout(resolve, 1000))

  const client2 = new WebSocket(wsUrl)
  let client2Messages = []

  client2.on('message', (data) => {
    const message = JSON.parse(data.toString())
    client2Messages.push(message)
    console.log('📨 Client 2 received:', message.type || message)
  })

  await new Promise((resolve) => {
    client2.on('open', () => {
      console.log('✅ Client 2 connected')
      setTimeout(resolve, 1500)
    })
  })

  console.log(`📊 Client 2 received ${client2Messages.length} message(s)\n`)

  // Step 3: Connect client 3 (should NOT receive old messages)
  console.log('Step 3: Client 3 connects (should NOT receive old queued messages)')

  const client3 = new WebSocket(wsUrl)
  let client3Messages = []

  client3.on('message', (data) => {
    const message = JSON.parse(data.toString())
    client3Messages.push(message)
    console.log('📨 Client 3 received:', message.type || message)
  })

  await new Promise((resolve) => {
    client3.on('open', () => {
      console.log('✅ Client 3 connected')
      setTimeout(resolve, 1500)
    })
  })

  console.log(`📊 Client 3 received ${client3Messages.length} message(s)\n`)

  // Verify results
  console.log('=== RESULTS ===')
  if (client2Messages.length > 0) {
    console.log('✅ Client 2 received queued messages (GOOD)')
  } else {
    console.log('❌ Client 2 did NOT receive queued messages (BAD)')
  }

  if (client3Messages.length === 0) {
    console.log('✅ Client 3 did NOT receive old messages (GOOD - queue was cleared)')
  } else {
    console.log('❌ Client 3 received old messages (BAD - infinite loop risk!)')
  }

  // Cleanup
  client2.close()
  client3.close()

  console.log('\n🧪 Test completed')
}

testQueueClearing().catch((error) => {
  console.error('❌ Test failed:', error)
  process.exit(1)
})
