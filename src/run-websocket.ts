import { WebSocketServer } from './web-socket'

// Create and start the WebSocket server
const wsServer = new WebSocketServer()

// Log the connection URL with key
setTimeout(() => {
  try {
    const connectionUrl = wsServer.getWebSocketConnectionUrl()
    console.log('\n🔗 WebSocket Connection URL:')
    console.log(connectionUrl)
    console.log('\n📊 Server Status:')
    console.log(`Messages: ${wsServer.getMessages().length}`)
    console.log(`Pending: ${wsServer.getPendingCount()}`)
  } catch (error) {
    console.log('⏳ Server still initializing...')
  }
}, 1000)

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down WebSocket server...')
  wsServer.cleanup()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down WebSocket server...')
  wsServer.cleanup()
  process.exit(0)
})

console.log('🚀 Starting WebSocket server on port 4000...')