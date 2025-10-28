import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { generateKeyPair } from './utils/asymmetric-crypto.js';

interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: 'pipe' | 'inherit' | 'ignore';
}

interface ServiceProcess {
  name: string;
  process: ChildProcess;
  status: 'starting' | 'running' | 'failed' | 'stopped';
}

export class ServiceBootstrap {
  private services: ServiceProcess[] = [];
  private readonly projectRoot: string;

  constructor() {
    // Get project root (parent directory of dist/src)
    this.projectRoot = path.resolve(__dirname, '../..');
  }

  /**
   * Boot up all configured services
   */
  async bootUpServices(): Promise<void> {
    

    // Generate RSA key pair on boot
    try {
      generateKeyPair();
    } catch (error: any) {
      console.error('❌ Failed to generate encryption key pair:', error.message);
      console.error('⚠️  Server will continue without asymmetric encryption support');
    }

    const services: ServiceConfig[] = [
      // WebSocket server
      {
        name: 'WebSocket Server',
        command: 'node',
        args: ['dist/src/run-websocket.js'],
        cwd: this.projectRoot,
        stdio: 'inherit', // Show output directly
      },
    ];

    // Start all services
    for (const serviceConfig of services) {
      await this.startService(serviceConfig);
    }

    
  }

  /**
   * Start a single service
   */
  private async startService(config: ServiceConfig): Promise<void> {
    

    try {
      const serviceProcess = spawn(config.command, config.args, {
        cwd: config.cwd || this.projectRoot,
        env: { ...process.env, ...config.env },
        stdio: config.stdio || 'pipe',
        detached: false, // Keep attached so they shutdown with parent
      });

      const serviceInfo: ServiceProcess = {
        name: config.name,
        process: serviceProcess,
        status: 'starting',
      };

      this.services.push(serviceInfo);

      // Handle service output if piped
      if (config.stdio === 'pipe') {
        serviceProcess.stdout?.on('data', (data) => {
          const output = data.toString().trim();
          if (output) {
            
          }
        });

        serviceProcess.stderr?.on('data', (data) => {
          const output = data.toString().trim();
          if (output) {
            console.error(`  [${config.name}] ${output}`);
          }
        });
      }

      // Handle service exit
      serviceProcess.on('exit', (code, signal) => {
        serviceInfo.status = code === 0 ? 'stopped' : 'failed';
        if (code !== 0 && code !== null) {
          console.error(`❌ ${config.name} exited with code ${code}`);
        } else if (signal) {
          
        } else {
          
        }
      });

      // Handle service errors
      serviceProcess.on('error', (error) => {
        serviceInfo.status = 'failed';
        console.error(`❌ Failed to start ${config.name}:`, error.message);
      });

      // Mark as running after a brief delay
      setTimeout(() => {
        if (serviceInfo.status === 'starting') {
          serviceInfo.status = 'running';
          
        }
      }, 1000);

      // Small delay between starting services
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error: any) {
      console.error(`❌ Error starting ${config.name}:`, error.message);
    }
  }

  /**
   * Get status of all services
   */
  getServicesStatus(): { name: string; status: string }[] {
    return this.services.map(service => ({
      name: service.name,
      status: service.status,
    }));
  }

  /**
   * Shutdown all services gracefully
   */
  async shutdown(): Promise<void> {
    

    for (const service of this.services) {
      if (service.status === 'running' || service.status === 'starting') {
        
        try {
          service.process.kill('SIGTERM');
          service.status = 'stopped';
        } catch (error: any) {
          console.error(`  Failed to stop ${service.name}:`, error.message);
        }
      }
    }

    // Wait a bit for graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Force kill any remaining processes
    for (const service of this.services) {
      if (service.status === 'running') {
        
        try {
          service.process.kill('SIGKILL');
        } catch (error) {
          // Ignore errors on force kill
        }
      }
    }

    
  }
}

/**
 * Main export function to boot up services
 * Can be called from server.ts
 */
export async function bootUpServices(): Promise<ServiceBootstrap> {
  const bootstrap = new ServiceBootstrap();
  await bootstrap.bootUpServices();
  return bootstrap;
}

/**
 * If running this file directly (for testing)
 */
if (require.main === module) {
  const bootstrap = new ServiceBootstrap();

  bootstrap.bootUpServices().catch((error) => {
    console.error('❌ Failed to boot services:', error);
    process.exit(1);
  });

  // Handle graceful shutdown
  process.on('SIGTERM', async () => {
    await bootstrap.shutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await bootstrap.shutdown();
    process.exit(0);
  });
}
