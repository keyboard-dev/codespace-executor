import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as WebSocket from 'ws'

// Types for WebSocket server configuration
interface WebSocketVerifyInfo {
  req: {
    url?: string
    headers?: {
      [key: string]: string | string[] | undefined
      authorization?: string
      'x-github-token'?: string
    }
    connection: {
      remoteAddress?: string
    }
  }
}

// Types for WebSocket message
interface WebSocketMessage {
  type: string
  id?: string
  data?: unknown
  requestId?: string
  providerId?: string
  timestamp?: number
  token?: string | null
  authenticated?: boolean
  user?: unknown
  providerName?: string
  error?: string
  tokensAvailable?: string[]
}

// Types for stored messages
interface Message {
  id: string
  type?: string
  title: string
  body: string
  timestamp: number
  priority?: 'low' | 'normal' | 'high'
  status?: 'pending' | 'approved' | 'rejected'
  read?: boolean
  requiresResponse?: boolean
  feedback?: string
  risk_level?: 'never' | 'low' | 'medium' | 'high'
  codespaceResponse?: {
    data: {
      stderr?: string
    }
  }
}

// Types for queued messages
interface QueuedMessage {
  message: unknown
  timestamp: number
  expiresAt: number
}

export class WebSocketServer {
  private wsServer: WebSocket.Server | null = null
  private readonly WS_PORT = 4002
  // WebSocket security
  private wsConnectionKey: string | null = null
  private readonly STORAGE_DIR = path.join(os.homedir(), '.keyboard-mcp')
  private readonly WS_KEY_FILE = path.join(os.homedir(), '.keyboard-mcp', '.keyboard-mcp-ws-key')
  
  // Message storage
  private messages: Message[] = []
  private pendingCount: number = 0

  // Message queue for offline clients
  private messageQueue: QueuedMessage[] = []
  private readonly MESSAGE_QUEUE_TTL = 2 * 60 * 1000 // 2 minutes in milliseconds
  private readonly MESSAGE_QUEUE_MAX_SIZE = 100 // Maximum messages to queue
  private cleanupInterval: NodeJS.Timeout | null = null

  // Ping/pong keep-alive to prevent idle connections
  private readonly PING_INTERVAL = 30000 // 30 seconds
  private connectionAliveStatus: Map<WebSocket, boolean> = new Map()
  private pingIntervals: Map<WebSocket, NodeJS.Timeout> = new Map()

  // Settings for automatic approvals
  private automaticCodeApproval: 'never' | 'low' | 'medium' | 'high' = 'never'
  private readonly CODE_APPROVAL_ORDER = ['never', 'low', 'medium', 'high'] as const
  private automaticResponseApproval: boolean = false

  constructor() {
    this.initializeWebSocket()
    this.startCleanupInterval()
  }

  private async initializeWebSocket(): Promise<void> {
    await this.initializeStorageDir()
    await this.initializeWebSocketKey()
    this.setupWebSocketServer()
  }

  private async initializeStorageDir(): Promise<void> {
    if (!fs.existsSync(this.STORAGE_DIR)) {
      fs.mkdirSync(this.STORAGE_DIR, { mode: 0o700 })
    }
  }

  private async initializeWebSocketKey(): Promise<void> {
    try {
      // Try to load existing key
      if (fs.existsSync(this.WS_KEY_FILE)) {
        const keyData = fs.readFileSync(this.WS_KEY_FILE, 'utf8')
        const parsedData = JSON.parse(keyData)

        // Validate key format and age (regenerate if older than 30 days)
        if (parsedData.key && parsedData.createdAt) {
          const keyAge = Date.now() - parsedData.createdAt
          const maxAge = 30 * 24 * 60 * 60 * 1000 // 30 days

          if (keyAge < maxAge) {
            this.wsConnectionKey = parsedData.key
            return
          }
        }
      }

      // Generate new key if none exists or is expired
      await this.generateNewWebSocketKey()
    }
    catch (error) {
      console.error('❌ Error initializing WebSocket key:', error)
      // Fallback: generate new key
      await this.generateNewWebSocketKey()
    }
  }

  private async generateNewWebSocketKey(): Promise<void> {
    try {
      // Generate a secure random key
      this.wsConnectionKey = crypto.randomBytes(32).toString('hex')

      // Store key with metadata
      const keyData = {
        key: this.wsConnectionKey,
        createdAt: Date.now(),
        version: '1.0',
      }

      // Write to file with restricted permissions
      fs.writeFileSync(this.WS_KEY_FILE, JSON.stringify(keyData, null, 2), { mode: 0o600 })
    }
    catch (error) {
      console.error('❌ Error generating WebSocket key:', error)
      throw error
    }
  }

  getWebSocketConnectionUrl(): string {
    if (!this.wsConnectionKey) {
      throw new Error('WebSocket connection key not initialized')
    }
    return `ws://127.0.0.1:${this.WS_PORT}?key=${this.wsConnectionKey}`
  }

  private validateWebSocketKey(providedKey: string): boolean {
    return this.wsConnectionKey === providedKey
  }

  private setupWebSocketServer(): void {
    this.wsServer = new WebSocket.Server({
      port: this.WS_PORT,
      host: '127.0.0.1', // Localhost only for security
      verifyClient: (info: WebSocketVerifyInfo) => {
        try {
          // Validate connection is from localhost
          // const remoteAddress = info.req.connection.remoteAddress
          // const isLocalhost = remoteAddress === '127.0.0.1'
          //   || remoteAddress === '::1'
          //   || remoteAddress === '::ffff:127.0.0.1'

          // if (!isLocalhost) {
          //   
          //   return false
          // }

          // Check for GitHub token authentication in headers
          const authHeader = info.req.headers?.['authorization']
          const githubTokenHeader = info.req.headers?.['x-github-token']
          
          // Accept connection if either:
          // 1. Has Authorization header with Bearer token
          // 2. Has X-GitHub-Token header
          // 3. Has key in query params (legacy support)
          const url = new URL(info.req.url!, `ws://127.0.0.1:${this.WS_PORT}`)
          const providedKey = url.searchParams.get('key')
          
          const authHeaderStr = Array.isArray(authHeader) ? authHeader[0] : authHeader
          const githubTokenStr = Array.isArray(githubTokenHeader) ? githubTokenHeader[0] : githubTokenHeader
          
          const hasGitHubAuth = (authHeaderStr && authHeaderStr.startsWith('Bearer ')) || githubTokenStr
          const hasKeyAuth = providedKey && this.validateWebSocketKey(providedKey)
          
          if (!hasGitHubAuth && !hasKeyAuth) {
            
            return false
          }

          if (hasGitHubAuth) {
            
          }

          return true
        }
        catch (error) {
          console.error('❌ Error validating WebSocket connection:', error)
          return false
        }
      },
    })

    this.wsServer.on('connection', (ws: WebSocket) => {
      console.log('✅ New WebSocket client connected')

      // Set up ping/pong keep-alive for this connection
      this.setupConnectionKeepalive(ws)

      // Deliver any queued messages to the newly connected client
      this.deliverQueuedMessages(ws)

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString()) as WebSocketMessage
          

          // Handle token request
          if (message.type === 'request-token') {
            // This would need to be implemented based on your auth system
            const tokenResponse = {
              type: 'auth-token',
              token: null, // Implement token retrieval
              timestamp: Date.now(),
              requestId: message.requestId,
              authenticated: false,
              user: null,
            }
            ws.send(JSON.stringify(tokenResponse))
            return
          }

          // Handle provider token request
          if (message.type === 'request-provider-token') {
            const { providerId } = message

            if (!providerId) {
              ws.send(JSON.stringify({
                type: 'provider-auth-token',
                error: 'Provider ID is required',
                timestamp: Date.now(),
                requestId: message.requestId,
              }))
              return
            }
            this.broadcastToOthers({
                ...message,
                timestamp: Date.now(),
            }, ws)
            return
          }
          if (message.type === 'provider-auth-token') {
              this.broadcastToOthers({
                ...message,
                timestamp: Date.now(),
            }, ws)
            return
          }

          // Handle provider status request
          if (message.type === 'request-provider-status') {
            // This would need to be implemented based on your provider system
            this.broadcastToOthers({
                ...message,
                timestamp: Date.now(),
            }, ws)
            return
          }

          // Handle collection share request
          if (message.type === 'collection-share-request') {
            // Broadcast to other clients or handle as needed
            this.broadcast({
              type: 'collection-share-request',
              data: message.data,
              id: message.id,
              timestamp: Date.now(),
            })
            return
          }

          // Handle prompter request
          if (message.type === 'prompter-request') {
            // Broadcast to other clients or handle as needed
            this.broadcast({
              type: 'prompter-request',
              data: message.data,
              id: message.id,
              timestamp: Date.now(),
            })
            return
          }

          // Handle prompt response
          if (message.type === 'prompt-response') {
            // Broadcast to other clients or handle as needed
            this.broadcast({
              type: 'prompt-response',
              data: message.data,
              id: message.id,
              requestId: message.requestId,
              timestamp: Date.now(),
            })
            return
          }

          // Handle auth token response from MenuBarApp
          if (message.type === 'auth-token') {
            this.broadcastToOthers(message, ws)
            return
          }

          // Handle user tokens available response
          if (message.type === 'user-tokens-available') {
            this.broadcastToOthers(message, ws)
            return
          }

          // Handle collection share response
          if (message.type === 'collection-share-response') {
            this.broadcast({
              type: 'collection-share-response',
              ...message,
              timestamp: Date.now(),
            })
            return
          }

          // Handle wrapped websocket messages
          if (message.type === 'websocket-message') {
            this.broadcastToOthers(message, ws)
            return
          }

          // Handle messages cleared notification
          if (message.type === 'messages-cleared') {
            this.broadcast({
              type: 'messages-cleared',
              timestamp: Date.now(),
            })
            return
          }

          // Handle approval response from approver-client
          if (message.type === 'approval-response') {
            
            // Find and update the message
            const targetMessage = this.messages.find(m => m.id === message.id)
            if (targetMessage) {
              targetMessage.status = (message as any).status
              targetMessage.feedback = (message as any).feedback
              
              // Update pending count
              this.pendingCount = this.messages.filter(m => m.status === 'pending' || !m.status).length

              // Broadcast the updated message to other clients (excluding sender)
              this.broadcastToOthers({
                type: 'websocket-message',
                message: targetMessage,
                timestamp: Date.now(),
              }, ws)
            }
            else {
              console.warn(`⚠️ Message ${message.id} not found for approval response`)
            }
            return
          }

          // Handle regular messages (convert WebSocketMessage to Message format)
          if (message) {

            this.handleIncomingMessage(message, ws)
            return
          }

          // Handle unknown message types
          console.warn('⚠️ Unknown message type:', message.type)
          ws.send(JSON.stringify({
            type: 'error',
            error: `Unknown message type: ${message.type}`,
            timestamp: Date.now(),
            requestId: message.requestId,
          }))
        }
        catch (error) {
          console.error('❌ Error parsing WebSocket message:', error)
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Invalid message format',
            timestamp: Date.now(),
          }))
        }
      })

      ws.on('close', () => {
        console.log('🔌 WebSocket client disconnected')
        this.cleanupConnection(ws)
      })

      ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error)
        this.cleanupConnection(ws)
      })
    })
  }

  // Public method to send a message to all connected clients
  broadcast(message: unknown): void {
    if (this.wsServer) {
      let deliveredToAnyClient = false

      this.wsServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(message))
          deliveredToAnyClient = true
        }
      })

      // If no clients are connected, queue the message for future delivery
      if (!deliveredToAnyClient) {
        this.addToQueue(message)
        console.log('📦 No clients connected, message queued for future delivery')
      }
    }
  }

  // Send a message to all clients except the sender
  broadcastToOthers(message: unknown, sender: WebSocket): void {
    if (this.wsServer) {
      let deliveredToAnyClient = false

      this.wsServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client !== sender) {
          client.send(JSON.stringify(message))
          deliveredToAnyClient = true
        }
      })

      // If no other clients are connected, queue the message for future delivery
      if (!deliveredToAnyClient) {
        this.addToQueue(message)
        console.log('📦 No other clients connected, message queued for future delivery')
      }
    }
  }

  // Get WebSocket key info
  getWebSocketKeyInfo(): { key: string | null, createdAt: number | null, keyFile: string } {
    let createdAt: number | null = null
    let key: string | null = null
    try {
      if (fs.existsSync(this.WS_KEY_FILE)) {
        const keyData = fs.readFileSync(this.WS_KEY_FILE, 'utf8')
        const parsedData = JSON.parse(keyData)
        createdAt = parsedData.createdAt
        key = parsedData.key
      }
    }
    catch (error) {
      console.error('Error reading key file:', error)
    }

    return {
      key: key,
      createdAt,
      keyFile: this.WS_KEY_FILE,
    }
  }

  // Handle incoming messages
  private handleIncomingMessage(message: any, sender?: WebSocket): void {
    // Add timestamp if not provided
    if (!message.timestamp) {
      message.timestamp = Date.now()
    }

    // Set default status if not provided
    if (!message.status) {
      message.status = 'pending'
    }

    // Store the message
    this.messages.push(message)

    // Handle automatic approvals based on message type
    switch (message.title) {
      case 'Security Evaluation Request': {
        const { risk_level } = message
        if (!risk_level) break

        const riskLevelIndex = this.CODE_APPROVAL_ORDER.indexOf(risk_level)
        const automaticCodeApprovalIndex = this.CODE_APPROVAL_ORDER.indexOf(this.automaticCodeApproval)
        if (riskLevelIndex <= automaticCodeApprovalIndex) {
          message.status = 'approved'
        }
        break
      }

      case 'code response approval': {
        const { codespaceResponse } = message
        if (!codespaceResponse) break

        const { data: codespaceResponseData } = codespaceResponse
        const { stderr } = codespaceResponseData
        if (!stderr && this.automaticResponseApproval) {
          message.status = 'approved'
        }
        break
      }
    }

    if (message.status === 'approved') {
      this.handleApproveMessage(message)
    }

    // Update pending count
    this.pendingCount = this.messages.filter(m => m.status === 'pending' || !m.status).length

    // Broadcast message to all connected clients except the sender
    if (sender) {
      this.broadcastToOthers({
        type: 'websocket-message',
        message: message,
        timestamp: Date.now(),
      }, sender)
    } else {
      // Fallback to broadcast if no sender provided
      this.broadcast({
        type: 'websocket-message',
        message: message,
        timestamp: Date.now(),
      })
    }
  }

  private handleApproveMessage(message: Message, feedback?: string): void {
    const existingMessage = this.messages.find(msg => msg.id === message.id)

    if (!existingMessage) return

    // Update the existing message
    Object.assign(existingMessage, message)
    existingMessage.status = 'approved'
    existingMessage.feedback = feedback

    // Update pending count
    this.pendingCount = this.messages.filter(m => m.status === 'pending' || !m.status).length

    

    // Send response back through WebSocket if needed
    this.sendWebSocketResponse(existingMessage)
  }

  private sendWebSocketResponse(message: Message): void {
    if (this.wsServer && message.requiresResponse) {
      // Send response to all connected WebSocket clients
      this.wsServer.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(message))
        }
      })
    }
  }

  // Public methods for message management
  getMessages(): Message[] {
    return this.messages
  }

  getPendingCount(): number {
    return this.pendingCount
  }

  approveMessage(messageId: string, feedback?: string): boolean {
    const message = this.messages.find(msg => msg.id === messageId)
    if (message) {
      this.handleApproveMessage(message, feedback)
      return true
    }
    return false
  }

  rejectMessage(messageId: string, feedback?: string): boolean {
    const message = this.messages.find(msg => msg.id === messageId)
    if (message) {
      message.status = 'rejected'
      message.feedback = feedback

      // Update pending count
      this.pendingCount = this.messages.filter(m => m.status === 'pending' || !m.status).length

      // Send response back through WebSocket if needed
      this.sendWebSocketResponse(message)
      return true
    }
    return false
  }

  clearAllMessages(): void {
    this.messages = []
    this.pendingCount = 0


    // Notify all clients
    this.broadcast({
      type: 'messages-cleared',
      timestamp: Date.now(),
    })
  }

  // Message queue management methods

  /**
   * Starts the periodic cleanup interval for expired messages
   */
  private startCleanupInterval(): void {
    // Clean up expired messages every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredMessages()
    }, 30000)
  }

  /**
   * Adds a message to the queue with TTL
   */
  private addToQueue(message: unknown): void {
    const now = Date.now()
    const queuedMessage: QueuedMessage = {
      message,
      timestamp: now,
      expiresAt: now + this.MESSAGE_QUEUE_TTL,
    }

    this.messageQueue.push(queuedMessage)

    // Enforce max queue size - remove oldest messages if over limit
    if (this.messageQueue.length > this.MESSAGE_QUEUE_MAX_SIZE) {
      const excess = this.messageQueue.length - this.MESSAGE_QUEUE_MAX_SIZE
      this.messageQueue.splice(0, excess)
      console.warn(`⚠️ Message queue exceeded max size (${this.MESSAGE_QUEUE_MAX_SIZE}), removed ${excess} oldest messages`)
    }
  }

  /**
   * Removes expired messages from the queue
   */
  private cleanupExpiredMessages(): void {
    const now = Date.now()
    const originalLength = this.messageQueue.length

    this.messageQueue = this.messageQueue.filter(queuedMsg => queuedMsg.expiresAt > now)

    const removed = originalLength - this.messageQueue.length
    if (removed > 0) {
      console.log(`🧹 Cleaned up ${removed} expired message(s) from queue`)
    }
  }

  /**
   * Delivers all queued messages to a newly connected client
   * Clears the queue after delivery to prevent infinite loops
   */
  private deliverQueuedMessages(client: WebSocket): void {
    // Clean up expired messages first
    this.cleanupExpiredMessages()

    if (this.messageQueue.length === 0) {
      return
    }

    console.log(`📬 Delivering ${this.messageQueue.length} queued message(s) to new client`)

    // Send all queued messages to the new client
    this.messageQueue.forEach(queuedMsg => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(queuedMsg.message))
      }
    })

    // Clear the queue after delivery to prevent messages from being
    // delivered multiple times and to avoid infinite loops
    this.messageQueue = []
    console.log('🧹 Queue cleared after delivery')
  }

  /**
   * Gets queue statistics for monitoring
   */
  getQueueStats(): { size: number, oldestAge: number | null, newestAge: number | null } {
    const now = Date.now()
    if (this.messageQueue.length === 0) {
      return { size: 0, oldestAge: null, newestAge: null }
    }

    const oldestAge = now - this.messageQueue[0].timestamp
    const newestAge = now - this.messageQueue[this.messageQueue.length - 1].timestamp

    return {
      size: this.messageQueue.length,
      oldestAge,
      newestAge,
    }
  }

  /**
   * Sets up ping/pong keep-alive for a WebSocket connection
   * Prevents connections from going idle by sending periodic pings
   * and terminating unresponsive connections
   */
  private setupConnectionKeepalive(ws: WebSocket): void {
    // Initialize connection as alive
    this.connectionAliveStatus.set(ws, true)

    // Handle pong responses from client
    ws.on('pong', () => {
      this.connectionAliveStatus.set(ws, true)
    })

    // Send periodic pings and check if client is responsive
    const pingInterval = setInterval(() => {
      const isAlive = this.connectionAliveStatus.get(ws)

      if (isAlive === false) {
        // Client didn't respond to last ping - terminate connection
        console.log('⚠️ Client failed to respond to ping, terminating connection')
        ws.terminate()
        this.cleanupConnection(ws)
        return
      }

      // Mark as not alive - will be set to true if pong is received
      this.connectionAliveStatus.set(ws, false)

      // Send ping if connection is open
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    }, this.PING_INTERVAL)

    // Store interval for cleanup
    this.pingIntervals.set(ws, pingInterval)
  }

  /**
   * Cleans up resources associated with a connection
   */
  private cleanupConnection(ws: WebSocket): void {
    // Clear ping interval
    const pingInterval = this.pingIntervals.get(ws)
    if (pingInterval) {
      clearInterval(pingInterval)
      this.pingIntervals.delete(ws)
    }

    // Remove connection status
    this.connectionAliveStatus.delete(ws)
  }

  // Clean up resources
  cleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    // Clean up all ping intervals
    this.pingIntervals.forEach((interval) => {
      clearInterval(interval)
    })
    this.pingIntervals.clear()
    this.connectionAliveStatus.clear()

    if (this.wsServer) {
      this.wsServer.close()
    }
  }
}

