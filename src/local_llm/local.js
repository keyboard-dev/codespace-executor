const { spawn, exec } = require("child_process");
const { promisify } = require("util");
const os = require("os");

const execAsync = promisify(exec);

class LocalLLM {
  constructor() {
    this.ollamaProcess = null;
    this.apiUrl = "http://127.0.0.1:11434";
    this.model = "gemma3n:e4b";
  }

  // Check if Ollama CLI is installed
  async isOllamaInstalled() {
    try {
      await execAsync("which ollama");
      return true;
    } catch (error) {
      return false;
    }
  }

  // Install Ollama CLI
  async installOllama() {
    console.log("📦 Installing Ollama CLI...");

    try {
      const platform = os.platform();

      if (platform === "darwin") {
        // macOS installation
        console.log("🍎 Detected macOS, installing via curl...");
        await execAsync("curl -fsSL https://ollama.ai/install.sh | sh");
      } else if (platform === "linux") {
        // Linux installation
        console.log("🐧 Detected Linux, installing via curl...");
        await execAsync("curl -fsSL https://ollama.ai/install.sh | sh");
      } else {
        throw new Error(
          `Unsupported platform: ${platform}. Please install Ollama manually from https://ollama.ai`
        );
      }

      // Verify installation
      if (await this.isOllamaInstalled()) {
        console.log("✅ Ollama CLI installed successfully");
        return true;
      } else {
        throw new Error("Installation completed but ollama command not found");
      }
    } catch (error) {
      console.error("❌ Failed to install Ollama:", error.message);
      console.log("💡 Please install Ollama manually from https://ollama.ai");
      return false;
    }
  }

  // Ensure Ollama CLI is available
  async ensureOllamaInstalled() {
    if (await this.isOllamaInstalled()) {
      console.log("✅ Ollama CLI already installed");
      return true;
    }

    console.log("📦 Ollama CLI not found, attempting to install...");
    return await this.installOllama();
  }

  // Check if Ollama service is running
  async isOllamaRunning() {
    try {
      const response = await execAsync(`curl -s ${this.apiUrl}/api/tags`);
      return true;
    } catch (error) {
      return false;
    }
  }

  // Check if Gemma model is available
  async isGemmaAvailable() {
    try {
      const response = await execAsync(`curl -s ${this.apiUrl}/api/tags`);
      const data = JSON.parse(response.stdout);
      return (
        data.models &&
        data.models.some(
          (model) =>
            model.name.includes("gemma3:1b") || model.name.includes("gemma3")
        )
      );
    } catch (error) {
      return false;
    }
  }

  // Get Ollama status
  async getStatus() {
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
  async startOllama() {
    console.log("🔄 Starting Ollama service...");

    try {
      // Ensure Ollama CLI is installed
      if (!(await this.ensureOllamaInstalled())) {
        throw new Error("Ollama CLI not available and installation failed");
      }

      // Check if already running
      if (await this.isOllamaRunning()) {
        console.log("✅ Ollama already running");
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
          console.log("✅ Ollama service started successfully");
          return true;
        }
        attempts++;
      }

      throw new Error("Ollama service failed to start within timeout");
    } catch (error) {
      console.error("❌ Failed to start Ollama:", error.message);
      return false;
    }
  }

  // Pull Gemma model if not available
  async ensureGemmaModel() {
    console.log("📥 Ensuring Gemma 3 1B model is available...");

    try {
      // Ensure Ollama CLI is installed
      if (!(await this.ensureOllamaInstalled())) {
        throw new Error("Ollama CLI not available and installation failed");
      }

      if (await this.isGemmaAvailable()) {
        console.log("✅ Gemma 3 1B model already available");
        return true;
      }

      console.log(
        "📥 Pulling Gemma 3 1B model (this may take a few minutes)..."
      );

      // Pull model synchronously so we know when it's done
      await execAsync(`ollama pull ${this.model}`);

      console.log("✅ Gemma 3 1B model pulled successfully");
      return true;
    } catch (error) {
      console.error("❌ Failed to pull Gemma model:", error.message);
      return false;
    }
  }

  // Initialize everything - ensure Ollama is installed, start service, and ensure model is ready
  async initialize() {
    console.log("🚀 Initializing Local LLM...");

    try {
      // First ensure Ollama CLI is installed
      if (!(await this.ensureOllamaInstalled())) {
        throw new Error("Ollama CLI not available and installation failed");
      }

      // Check current status
      const status = await this.getStatus();
      console.log("📊 Current status:", status);

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

      console.log("🎉 Local LLM initialized successfully!");
      console.log(`📍 API available at: ${this.apiUrl}`);
      console.log(`🤖 Model ready: ${this.model}`);

      return true;
    } catch (error) {
      console.error("❌ Local LLM initialization failed:", error.message);
      return false;
    }
  }

  // Stop Ollama service
  async stop() {
    console.log("🛑 Stopping Ollama service...");

    try {
      // Kill any running ollama processes
      await execAsync('pkill -f "ollama serve"');
      console.log("✅ Ollama service stopped");
      return true;
    } catch (error) {
      if (error.code === 1) {
        console.log("ℹ️  Ollama service was not running");
        return true;
      }
      console.error("❌ Failed to stop Ollama:", error.message);
      return false;
    }
  }

  // Chat with the model
  async evaluate(message, options = {}) {
    try {
      // Ensure everything is ready
      const status = await this.getStatus();
      if (!status.ready) {
        throw new Error("Local LLM not ready. Please initialize first.");
      }

      const model = options.model || this.model;
      const temperature = options.temperature || 0.7;

      // Use Ollama API directly
      const response = await execAsync(
        `curl -s -X POST ${
          this.apiUrl
        }/api/chat -H "Content-Type: application/json" -d '${JSON.stringify({
          model: model,
          messages: [{ role: "user", content: message }],
          stream: false,
          format: {
            type: "object",
            properties: {
              EXPOSES_API_KEY_OR_SENSITIVE_DATA: {
                type: "boolean",
              },
            },
            required: ["EXPOSES_API_KEY_OR_SENSITIVE_DATA"],
          },
          options: {
            temperature: temperature,
          },
        })}'`
      );

      const data = JSON.parse(response.stdout);

      if (data.error) {
        throw new Error(data.error);
      }

      return {
        success: true,
        response: data.message.content,
        model: model,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async chat(message, options = {}) {
    try {
      // Ensure everything is ready
      const status = await this.getStatus();
      if (!status.ready) {
        throw new Error("Local LLM not ready. Please initialize first.");
      }

      const model = options.model || this.model;
      const temperature = options.temperature || 0.7;

      // Use Ollama API directly
      const response = await execAsync(
        `curl -s -X POST ${
          this.apiUrl
        }/api/chat -H "Content-Type: application/json" -d '${JSON.stringify({
          model: model,
          messages: [{ role: "user", content: message }],
          stream: false,
          options: {
            temperature: temperature,
          },
        })}'`
      );

      const data = JSON.parse(response.stdout);

      if (data.error) {
        throw new Error(data.error);
      }

      return {
        success: true,
        response: data.message.content,
        model: model,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  // Analyze code for hardcoded sensitive data
  async analyzeResponse(code, options = {}) {
    try {
      const prompt = `-----Output to eval-----
            ${code}
            -----Output to eval-----`;

      const result = await this.evaluate(prompt, {
        ...options,
        temperature: 0.1, // Use low temperature for consistent responses
      });               
      console.log(result)

      return result?.response;
    } catch (error) {
      console.log(error)
      return {
        success: false,
        error: error.message,
      };
    }
  }
}

module.exports = LocalLLM;
