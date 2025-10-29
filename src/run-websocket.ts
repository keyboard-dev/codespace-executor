import { WebSocketServer } from './web-socket'

// Create and start the WebSocket server
const wsServer = new WebSocketServer()

// Log the connection URL with key
setTimeout(() => {
  try {
    const connectionUrl = wsServer.getWebSocketConnectionUrl()
    
    
    
    
    
  } catch (error) {
    
  }
}, 1000)

// Handle graceful shutdown
process.on('SIGINT', () => {
  
  wsServer.cleanup()
  process.exit(0)
})

process.on('SIGTERM', () => {
  
  wsServer.cleanup()
  process.exit(0)
})

