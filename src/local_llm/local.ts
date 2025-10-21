import { spawn, exec, ChildProcess } from "child_process";
import { promisify } from "util";
import os from "os";
import https from "https";
import http from "http";
import { URL } from "url";

const execAsync = promisify(exec);

export interface LocalLLMOptions {
  apiUrl?: string;
  model?: string;
}

export interface LLMStatus {
  ollamaRunning: boolean;
  gemmaAvailable: boolean;
  apiUrl: string;
  model: string;
  ready: boolean;
}

export interface ChatOptions {
  temperature?: number;
  model?: string;
}

export interface ChatResponse {
  success: boolean;
  response?: string;
  error?: string;
  model?: string;
}

export interface EvaluateResponse {
  success: boolean;
  response?: any;
  error?: string;
  model?: string;
}

interface HTTPRequestOptions {
  method: string;
  headers: Record<string, string>;
}

interface OllamaModel {
  name: string;
  [key: string]: any;
}

interface OllamaTagsResponse {
  models?: OllamaModel[];
}

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream: boolean;
  format?: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
  options?: {
    temperature: number;
  };
}

interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  options?: {
    temperature: number;
  };
}

interface OllamaResponse {
  error?: string;
  response?: string;
  message?: {
    content: string;
  };
}

export default class LocalLLM {
  private ollamaProcess: ChildProcess | null = null;
  private apiUrl: string;
  private model: string;

  constructor(options: LocalLLMOptions = {}) {
    this.apiUrl = options.apiUrl || "http://127.0.0.1:11434";
    this.model = options.model || "hf.co/unsloth/gemma-3n-E2B-it-GGUF:Q4_K_M";
  }

  // Helper method to make HTTP requests
  private async makeRequest<T>(url: string, data: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;
      
      const postData = JSON.stringify(data);
      
      const options: https.RequestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData).toString()
        }
      };

      const req = client.request(options, (res) => {
        let body = '';
        
        res.on('data', (chunk) => {
          body += chunk;
        });
        
        res.on('end', () => {
          try {
            const jsonData = JSON.parse(body) as T;
            resolve(jsonData);
          } catch (error: any) {
            reject(new Error(`Failed to parse JSON: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }

  // Check if Ollama CLI is installed
  async isOllamaInstalled(): Promise<boolean> {
    try {
      await execAsync("which ollama");
      return true;
    } catch (error) {
      return false;
    }
  }

  // Install Ollama CLI
  async installOllama(): Promise<boolean> {
    try {
      const platform = os.platform();

      if (platform === "darwin") {
        // macOS installation
        await execAsync("curl -fsSL https://ollama.ai/install.sh | sh");
      } else if (platform === "linux") {
        // Linux installation
        await execAsync("curl -fsSL https://ollama.ai/install.sh | sh");
      } else {
        throw new Error(
          `Unsupported platform: ${platform}. Please install Ollama manually from https://ollama.ai`
        );
      }

      // Verify installation
      if (await this.isOllamaInstalled()) {
        return true;
      } else {
        throw new Error("Installation completed but ollama command not found");
      }
    } catch (error: any) {
      console.error("❌ Failed to install Ollama:", error.message);
      return false;
    }
  }

  // Ensure Ollama CLI is available
  async ensureOllamaInstalled(): Promise<boolean> {
    if (await this.isOllamaInstalled()) {
      return true;
    }
    return await this.installOllama();
  }

  // Check if Ollama service is running
  async isOllamaRunning(): Promise<boolean> {
    try {
      await execAsync(`curl -s ${this.apiUrl}/api/tags`);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Check if Gemma model is available
  async isGemmaAvailable(): Promise<boolean> {
    try {
      const response = await execAsync(`curl -s ${this.apiUrl}/api/tags`);
      const data: OllamaTagsResponse = JSON.parse(response.stdout);
      return !!(
        data.models &&
        data.models.some(
          (model) =>
            model.name.includes("gemma3:1b") || model.name.includes("gemma")
        )
      );
    } catch (error) {
      return false;
    }
  }

  // Get Ollama status
  async getStatus(): Promise<LLMStatus> {
    const running = await this.isOllamaRunning();
    const gemmaReady = running ? await this.isGemmaAvailable() : false;

    return {
      ollamaRunning: running,
      gemmaAvailable: gemmaReady,
      apiUrl: this.apiUrl,
      model: this.model,
      ready: running && gemmaReady,
    };
  }

  // Start Ollama service
  async startOllama(): Promise<boolean> {
    try {
      // Ensure Ollama CLI is installed
      if (!(await this.ensureOllamaInstalled())) {
        throw new Error("Ollama CLI not available and installation failed");
      }

      // Check if already running
      if (await this.isOllamaRunning()) {
        return true;
      }

      // Start Ollama service
      this.ollamaProcess = spawn("ollama", ["serve"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          OLLAMA_HOST: "0.0.0.0:11434", // Explicitly bind to all interfaces
        },
      });

      this.ollamaProcess.unref();

      // Wait for service to start
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (await this.isOllamaRunning()) {
          return true;
        }
        attempts++;
      }

      throw new Error("Ollama service failed to start within timeout");
    } catch (error: any) {
      console.error("❌ Failed to start Ollama:", error.message);
      return false;
    }
  }

  // Pull Gemma model if not available
  async ensureGemmaModel(): Promise<boolean> {
    try {
      // Ensure Ollama CLI is installed
      if (!(await this.ensureOllamaInstalled())) {
        throw new Error("Ollama CLI not available and installation failed");
      }

      if (await this.isGemmaAvailable()) {
        return true;
      }

      console.log(
        "📥 Pulling Gemma 3 1B model (this may take a few minutes)..."
      );

      // Pull model synchronously so we know when it's done
      await execAsync(`ollama pull ${this.model}`);
      return true;
    } catch (error: any) {
      console.error("❌ Failed to pull Gemma model:", error.message);
      return false;
    }
  }

  // Initialize everything - ensure Ollama is installed, start service, and ensure model is ready
  async initialize(): Promise<boolean> {
    try {
      // First ensure Ollama CLI is installed
      if (!(await this.ensureOllamaInstalled())) {
        throw new Error("Ollama CLI not available and installation failed");
      }

      // Check current status
      const status = await this.getStatus();

      // Start Ollama if not running
      if (!status.ollamaRunning) {
        const started = await this.startOllama();
        if (!started) {
          throw new Error("Failed to start Ollama service");
        }
      }

      // Ensure Gemma model is available
      if (!status.gemmaAvailable) {
        const modelReady = await this.ensureGemmaModel();
        if (!modelReady) {
          throw new Error("Failed to ensure Gemma model is available");
        }
      }

      return true;
    } catch (error: any) {
      console.error("❌ Local LLM initialization failed:", error.message);
      return false;
    }
  }

  // Stop Ollama service
  async stop(): Promise<boolean> {
    try {
      // Kill any running ollama processes
      await execAsync('pkill -f "ollama serve"');
      return true;
    } catch (error: any) {
      if (error.code === 1) {
        return true;
      }
      console.error("❌ Failed to stop Ollama:", error.message);
      return false;
    }
  }

  // Chat with the model - FIXED VERSION
  async evaluate(message: string, options: ChatOptions = {}): Promise<EvaluateResponse> {
    try {
      // Ensure everything is ready
      const status = await this.getStatus();
      if (!status.ready) {
        throw new Error("Local LLM not ready. Please initialize first.");
      }

      const model = options.model || this.model;
      const temperature = options.temperature || 0;

      // Use proper HTTP request instead of shell command
      const prompt = `You are a system that is reviewing code responses of executed code. You main goal is detect if there is any hard coded or exposed sensitive data in the content. Remember we want to avoid false positives, so if there is a pointer or variable AKA using an environment variable is ok as long as it is not showing the real value, and you should not flag it as sensitive data.<data_to_eval> ${message} </data_to_eval>`;
      
      const requestData: OllamaGenerateRequest = {
        model: model,
        prompt: prompt,
        stream: false,
        format: {
          type: "object",
          properties: {
            VISIBLE_HARD_CODED_API_KEY_OR_RAW_SENSITIVE_DATA: {
              type: "boolean",
            },
          },
          required: ["VISIBLE_HARD_CODED_API_KEY_OR_RAW_SENSITIVE_DATA"],
        },
        options: {
          temperature: temperature,
        },
      };

      const data = await this.makeRequest<OllamaResponse>(`${this.apiUrl}/api/generate`, requestData);

      if (data.error) {
        throw new Error(data.error);
      }

      return {
        success: true,
        response: data.response,
        model: model,
      };
    } catch (error: any) {
      console.error("Evaluate error:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // Chat with the model - FIXED VERSION
  async chat(message: string, options: ChatOptions = {}): Promise<ChatResponse> {
    try {
      // Ensure everything is ready
      const status = await this.getStatus();
      if (!status.ready) {
        throw new Error("Local LLM not ready. Please initialize first.");
      }

      const model = options.model || this.model;
      const temperature = options.temperature || 0.7;

      const requestData: OllamaChatRequest = {
        model: model,
        messages: [{ role: "user", content: message }],
        stream: false,
        options: {
          temperature: temperature,
        },
      };

      const data = await this.makeRequest<OllamaResponse>(`${this.apiUrl}/api/chat`, requestData);

      if (data.error) {
        throw new Error(data.error);
      }

      return {
        success: true,
        response: data.message?.content,
        model: model,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // Analyze code for hardcoded sensitive data
  async analyzeResponse(code: string, options: ChatOptions = {}): Promise<any> {
    try {
      const prompt = `-----Output to eval-----
            ${code}
            -----Output to eval-----`;

      const result = await this.evaluate(prompt, {
        ...options,
        temperature: 0, // Use low temperature for consistent responses
      });               

      return result?.response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  }
}