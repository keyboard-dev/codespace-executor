const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

class JobManager {
    constructor(options = {}) {
        this.jobs = new Map();
        this.workers = new Map();
        this.maxConcurrentJobs = options.maxConcurrentJobs || 5;
        this.jobTTL = options.jobTTL || 24 * 60 * 60 * 1000; // 24 hours default
        this.persistenceFile = options.persistenceFile || path.join(__dirname, '../../data/jobs.json');
        this.enablePersistence = options.enablePersistence !== false;
        
        // Ensure data directory exists
        if (this.enablePersistence) {
            const dataDir = path.dirname(this.persistenceFile);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            this.loadPersistedJobs();
        }
        
        // Start cleanup interval
        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredJobs();
        }, 60000); // Run every minute
    }

    generateJobId() {
        return randomBytes(16).toString('hex');
    }

    createJob(payload, options = {}) {
        const jobId = this.generateJobId();
        const job = {
            id: jobId,
            status: 'PENDING',
            payload: payload,
            options: options,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            result: null,
            error: null,
            progress: 0
        };

        this.jobs.set(jobId, job);
        this.persistJob(job);
        
        // Try to start job immediately if worker slots available
        this.processNextJob();
        
        return jobId;
    }

    getJob(jobId) {
        return this.jobs.get(jobId);
    }

    getAllJobs(options = {}) {
        const { status, limit = 100, offset = 0 } = options;
        let jobs = Array.from(this.jobs.values());
        
        if (status) {
            jobs = jobs.filter(job => job.status === status);
        }
        
        // Sort by creation date (newest first)
        jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        return {
            jobs: jobs.slice(offset, offset + limit),
            total: jobs.length,
            hasMore: jobs.length > offset + limit
        };
    }

    updateJobStatus(jobId, status, data = {}) {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        job.status = status;
        job.updatedAt = new Date().toISOString();
        
        if (status === 'RUNNING') {
            job.startedAt = new Date().toISOString();
        } else if (status === 'COMPLETED' || status === 'FAILED') {
            job.completedAt = new Date().toISOString();
        }
        
        // Update additional data
        Object.assign(job, data);
        
        this.jobs.set(jobId, job);
        this.persistJob(job);
        
        return job;
    }

    updateJobProgress(jobId, progress, message = null) {
        const job = this.jobs.get(jobId);
        if (job && job.status === 'RUNNING') {
            job.progress = Math.min(100, Math.max(0, progress));
            job.updatedAt = new Date().toISOString();
            if (message) {
                job.progressMessage = message;
            }
            this.jobs.set(jobId, job);
            this.persistJob(job);
        }
    }

    cancelJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        if (job.status === 'RUNNING') {
            // Kill the worker process if it exists
            const worker = this.workers.get(jobId);
            if (worker && worker.kill) {
                worker.kill('SIGTERM');
                this.workers.delete(jobId);
            }
        }

        this.updateJobStatus(jobId, 'CANCELLED');
        return job;
    }

    deleteJob(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        // Cancel if running
        if (job.status === 'RUNNING') {
            this.cancelJob(jobId);
        }

        this.jobs.delete(jobId);
        this.removePersistedJob(jobId);
        
        return true;
    }

    processNextJob() {
        // Check if we have available worker slots
        if (this.workers.size >= this.maxConcurrentJobs) {
            return false;
        }

        // Find next pending job
        const pendingJob = Array.from(this.jobs.values())
            .find(job => job.status === 'PENDING');
        
        if (!pendingJob) {
            return false;
        }

        this.startJobExecution(pendingJob);
        return true;
    }

    async startJobExecution(job) {
        const { spawn } = require('child_process');
        const fs = require('fs');
        
        try {
            this.updateJobStatus(job.id, 'RUNNING');
            
            // Prepare code execution similar to existing executeCodeWithAsyncSupport
            const tempFile = `temp_job_${job.id}_${Date.now()}.js`;
            let codeToExecute = job.payload.code;
            
            // Check if code needs async wrapper (same logic as server.js)
            const needsAsyncWrapper = codeToExecute.includes('await') || 
                                     codeToExecute.includes('Promise') ||
                                     codeToExecute.includes('.then(') ||
                                     codeToExecute.includes('setTimeout') ||
                                     codeToExecute.includes('setInterval') ||
                                     codeToExecute.includes('https.request') ||
                                     codeToExecute.includes('fetch(');
            
            if (needsAsyncWrapper) {
                const allowLongRunning = job.payload.allowLongRunning || job.payload.use_background_jobs;
                const asyncTimeout = job.payload.asyncTimeout || (allowLongRunning ? 0 : 5000);
                
                let exitLogic;
                if (allowLongRunning || asyncTimeout === 0) {
                    // For long-running jobs, let the code complete naturally without forced timeout
                    exitLogic = `
        // Long-running job - let async operations complete naturally
        console.log('🔄 Long-running job mode: waiting for natural completion...');`;
                } else {
                    // Standard behavior with timeout for quick jobs
                    exitLogic = `
        // Wait for any pending async operations
        await new Promise(resolve => setTimeout(resolve, ${asyncTimeout}));`;
                }
                
                codeToExecute = `
(async () => {
    try {
        ${exitLogic}
        
        // Execute the main code 
        ${job.payload.code}
        
        // For background jobs, let the event loop keep the process alive
        // until all async operations naturally complete
        if (${allowLongRunning}) {
            console.log('🔄 Background job: letting async operations complete naturally...');
            console.log('📊 Process will exit when all async operations finish');
            
            // Set a reasonable maximum wait time as a safety net
            const safetyTimeout = setTimeout(() => {
                console.log('⏰ Safety timeout reached after 30 minutes');
                console.log('✅ Job completed (with safety timeout)');
                process.exit(0);
            }, 1800000); // 30 minutes
            
            // Also add a check for when the event loop becomes empty
            process.nextTick(() => {
                const checkEventLoop = () => {
                    // If no more async operations are pending, clean up and exit
                    if (process._getActiveHandles().length <= 1 && process._getActiveRequests().length === 0) {
                        clearTimeout(safetyTimeout);
                        console.log('✅ All async operations completed - exiting naturally');
                        process.exit(0);
                    } else {
                        // Check again in 100ms
                        setTimeout(checkEventLoop, 100);
                    }
                };
                setTimeout(checkEventLoop, 1000); // Start checking after 1 second
            });
        } else {
            // For non-background jobs, use the original timeout behavior  
            console.log('⏳ Waiting for async operations to complete...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log('✅ Job completed successfully');
            process.exit(0);
        }
        
    } catch (error) {
        console.error('❌ Job execution error:', error.message);
        console.error('❌ Error type:', error.constructor.name);
        console.error('❌ Stack trace:', error.stack);
        process.exit(1);
    }
})().catch(error => {
    console.error('❌ Promise rejection:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Promise Rejection:', reason);
    process.exit(1);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error.message);
    process.exit(1);
});
`;
            }
            
            fs.writeFileSync(tempFile, codeToExecute);
            
            // Prepare environment variables (same logic as server.js)
            const allowedEnvVars = [
                'PATH', 'HOME', 'USER', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL', 'PWD', 'TMPDIR', 'TEMP', 'TMP'
            ];
            
            const limitedEnv = {};
            allowedEnvVars.forEach(key => {
                if (process.env[key]) {
                    limitedEnv[key] = process.env[key];
                }
            });
            
            // Add KEYBOARD environment variables
            Object.keys(process.env).forEach(key => {
                if (key.startsWith('KEYBOARD')) {
                    limitedEnv[key] = process.env[key];
                }
            });
            
            // Add header environment variables if provided
            if (job.payload.headerEnvVars) {
                Object.assign(limitedEnv, job.payload.headerEnvVars);
            }
            
            const child = spawn('node', [tempFile], { env: limitedEnv });
            this.workers.set(job.id, child);
            
            let stdout = '';
            let stderr = '';
            // Support maxDuration and longer timeouts for background jobs
            const allowLongRunning = job.payload.allowLongRunning || job.payload.use_background_jobs;
            const defaultTimeout = allowLongRunning ? 1800000 : 600000; // 30 minutes for background jobs, 10 minutes for others
            const timeout = job.payload.maxDuration || job.payload.timeout || defaultTimeout;
            
            const timeoutId = setTimeout(() => {
                if (this.workers.has(job.id)) {
                    child.kill('SIGTERM');
                    this.updateJobStatus(job.id, 'FAILED', {
                        error: {
                            message: `Job timed out after ${timeout}ms`,
                            type: 'TIMEOUT',
                            stdout,
                            stderr
                        }
                    });
                }
            }, timeout);
            
            child.stdout.on('data', data => {
                const output = data.toString();
                stdout += output;
                
                // Look for progress indicators in the output
                const lines = output.split('\n');
                for (const line of lines) {
                    // Look for progress patterns like "Progress: 50%" or "📊 Progress: 50%"
                    const progressMatch = line.match(/(?:Progress:\s*|📊\s*Progress:\s*)(\d+)%/i);
                    if (progressMatch) {
                        const progress = parseInt(progressMatch[1]);
                        this.updateJobProgress(job.id, progress, line.trim());
                    }
                }
            });
            
            child.stderr.on('data', data => {
                stderr += data.toString();
            });
            
            child.on('close', async (code) => {
                clearTimeout(timeoutId);
                this.workers.delete(job.id);
                
                try {
                    fs.unlinkSync(tempFile);
                } catch (e) {
                    // File cleanup error, not critical
                }
                
                if (code === 0) {
                    // Success
                    let result = {
                        stdout,
                        stderr,
                        code,
                        executionTime: Date.now()
                    };
                    
                    // AI analysis if requested
                    if (job.payload.ai_eval) {
                        try {
                            const LocalLLM = require('../local_llm/local');
                            const localLLM = new LocalLLM();
                            const outputsOfCodeExecution = `
                            output of code execution: 
                            <stdout>${stdout}</stdout>
                            <stderr>${stderr}</stderr>`;
                            result.aiAnalysis = await localLLM.analyzeResponse(JSON.stringify(outputsOfCodeExecution));
                        } catch (e) {
                            result.aiAnalysisError = e.message;
                        }
                    }
                    
                    this.updateJobStatus(job.id, 'COMPLETED', { result });
                } else {
                    // Failure
                    this.updateJobStatus(job.id, 'FAILED', {
                        error: {
                            message: `Process exited with code ${code}`,
                            type: 'PROCESS_EXIT',
                            code,
                            stdout,
                            stderr
                        }
                    });
                }
                
                // Try to process next job
                this.processNextJob();
            });
            
            child.on('error', (error) => {
                clearTimeout(timeoutId);
                this.workers.delete(job.id);
                
                try {
                    fs.unlinkSync(tempFile);
                } catch (e) {
                    // File cleanup error, not critical
                }
                
                this.updateJobStatus(job.id, 'FAILED', {
                    error: {
                        message: error.message,
                        type: error.constructor.name,
                        code: error.code,
                        stdout,
                        stderr
                    }
                });
                
                // Try to process next job
                this.processNextJob();
            });
            
        } catch (error) {
            this.updateJobStatus(job.id, 'FAILED', {
                error: {
                    message: error.message,
                    type: error.constructor.name
                }
            });
            
            // Try to process next job
            this.processNextJob();
        }
    }

    cleanupExpiredJobs() {
        const now = Date.now();
        const expiredJobs = [];
        
        for (const [jobId, job] of this.jobs.entries()) {
            const jobAge = now - new Date(job.createdAt).getTime();
            if (jobAge > this.jobTTL && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
                expiredJobs.push(jobId);
            }
        }
        
        expiredJobs.forEach(jobId => {
            this.jobs.delete(jobId);
            this.removePersistedJob(jobId);
        });
        
        if (expiredJobs.length > 0) {
            console.log(`🧹 Cleaned up ${expiredJobs.length} expired jobs`);
        }
    }

    persistJob(job) {
        if (!this.enablePersistence) return;
        
        try {
            const jobs = this.loadJobsFromFile();
            jobs[job.id] = job;
            fs.writeFileSync(this.persistenceFile, JSON.stringify(jobs, null, 2));
        } catch (error) {
            console.error('❌ Failed to persist job:', error.message);
        }
    }

    removePersistedJob(jobId) {
        if (!this.enablePersistence) return;
        
        try {
            const jobs = this.loadJobsFromFile();
            delete jobs[jobId];
            fs.writeFileSync(this.persistenceFile, JSON.stringify(jobs, null, 2));
        } catch (error) {
            console.error('❌ Failed to remove persisted job:', error.message);
        }
    }

    loadJobsFromFile() {
        try {
            if (fs.existsSync(this.persistenceFile)) {
                const data = fs.readFileSync(this.persistenceFile, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('❌ Failed to load jobs from file:', error.message);
        }
        return {};
    }

    loadPersistedJobs() {
        try {
            const persistedJobs = this.loadJobsFromFile();
            
            for (const [jobId, job] of Object.entries(persistedJobs)) {
                // Reset running jobs to pending on startup
                if (job.status === 'RUNNING') {
                    job.status = 'PENDING';
                    job.startedAt = null;
                    job.updatedAt = new Date().toISOString();
                }
                
                this.jobs.set(jobId, job);
            }
            
            console.log(`📂 Loaded ${Object.keys(persistedJobs).length} persisted jobs`);
            
            // Process any pending jobs
            this.processNextJob();
        } catch (error) {
            console.error('❌ Failed to load persisted jobs:', error.message);
        }
    }

    getStats() {
        const stats = {
            total: this.jobs.size,
            pending: 0,
            running: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            activeWorkers: this.workers.size,
            maxConcurrentJobs: this.maxConcurrentJobs
        };

        for (const job of this.jobs.values()) {
            stats[job.status.toLowerCase()]++;
        }

        return stats;
    }

    shutdown() {
        // Cancel all running jobs
        for (const [jobId, worker] of this.workers.entries()) {
            if (worker && worker.kill) {
                worker.kill('SIGTERM');
            }
        }
        
        // Clear cleanup interval
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        console.log('🛑 JobManager shutdown complete');
    }
}

module.exports = JobManager;