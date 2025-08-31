const express = require('express');
const JobManager = require('../jobs/JobManager');
const { encrypt, decrypt, safeObfuscate } = require('../utils/crypto');

const router = express.Router();

// Initialize job manager (singleton pattern)
let jobManager = null;

function getJobManager() {
    if (!jobManager) {
        jobManager = new JobManager({
            maxConcurrentJobs: process.env.MAX_CONCURRENT_JOBS || 5,
            jobTTL: (process.env.JOB_TTL_HOURS || 24) * 60 * 60 * 1000,
            enablePersistence: process.env.DISABLE_JOB_PERSISTENCE !== 'true'
        });
    }
    return jobManager;
}

// Utility function to handle encryption if requested
function encryptResponseIfNeeded(data, encryptMessages = false) {
    if (!encryptMessages) {
        return data;
    }
    
    try {
        const responseString = JSON.stringify(data);
        const encryptedResponse = encrypt(responseString);
        return {
            encrypted: true,
            data: encryptedResponse
        };
    } catch (error) {
        console.error('❌ Failed to encrypt response:', error.message);
        return {
            ...data,
            encryptionError: 'Failed to encrypt response: ' + error.message
        };
    }
}

// POST /jobs - Submit a new background job
router.post('/', (req, res) => {
    try {
        const payload = req.body;
        
        // Validate required fields
        if (!payload.code && !payload.command) {
            return res.status(400).json({
                error: 'Either code or command is required'
            });
        }
        
        // Handle encryption if encrypt_messages is true
        if (payload.encrypt_messages) {
            try {
                if (!process.env.KB_ENCRYPTION_SECRET) {
                    return res.status(400).json({
                        error: 'KB_ENCRYPTION_SECRET environment variable is required when encrypt_messages is true'
                    });
                }
                
                if (payload.code) {
                    try {
                        payload.code = decrypt(payload.code);
                    } catch (decryptError) {
                        return res.status(400).json({
                            error: 'Failed to decrypt code',
                            details: decryptError.message
                        });
                    }
                }
            } catch (encryptionError) {
                return res.status(500).json({
                    error: 'Encryption setup failed',
                    details: encryptionError.message
                });
            }
        }
        
        // Extract headers for environment variables (same logic as main server)
        const headerEnvVars = {};
        if (req.headers) {
            Object.keys(req.headers).forEach(headerName => {
                if (headerName.toLowerCase().startsWith('x-keyboard-provider-user-token-for-')) {
                    const envVarName = headerName
                        .toLowerCase()
                        .replace('x-', '')
                        .toUpperCase()
                        .replace(/-/g, '_');
                    headerEnvVars[envVarName] = req.headers[headerName];
                }
            });
        }
        
        // Prepare job payload
        const jobPayload = {
            ...payload,
            headerEnvVars
        };
        
        const jobOptions = {
            priority: payload.priority || 'normal',
            timeout: payload.timeout || 600000, // 10 minutes default for background jobs
            maxRetries: payload.maxRetries || 0
        };
        
        const jobId = getJobManager().createJob(jobPayload, jobOptions);
        
        const response = encryptResponseIfNeeded({
            success: true,
            jobId: jobId,
            status: 'PENDING',
            message: 'Job submitted successfully'
        }, payload.encrypt_messages);
        
        res.status(201).json(response);
        
    } catch (error) {
        console.error('❌ Error creating job:', error);
        
        const response = encryptResponseIfNeeded({
            success: false,
            error: 'Failed to create job',
            details: error.message
        }, req.body?.encrypt_messages);
        
        res.status(500).json(response);
    }
});

// GET /jobs/:id - Get job status and results
router.get('/:id', (req, res) => {
    try {
        const jobId = req.params.id;
        const encryptMessages = req.query.encrypt_messages === 'true';
        
        const job = getJobManager().getJob(jobId);
        
        if (!job) {
            const response = encryptResponseIfNeeded({
                error: 'Job not found'
            }, encryptMessages);
            
            return res.status(404).json(response);
        }
        
        // Create response with obfuscated sensitive data
        const jobResponse = {
            id: job.id,
            status: job.status,
            progress: job.progress,
            progressMessage: job.progressMessage,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt
        };
        
        // Add results or error details based on status
        if (job.status === 'COMPLETED' && job.result) {
            jobResponse.result = {
                stdout: safeObfuscate(job.result.stdout),
                stderr: safeObfuscate(job.result.stderr),
                code: job.result.code,
                executionTime: job.result.executionTime,
                aiAnalysis: job.result.aiAnalysis
            };
        } else if (job.status === 'FAILED' && job.error) {
            jobResponse.error = {
                message: job.error.message,
                type: job.error.type,
                code: job.error.code,
                stdout: safeObfuscate(job.error.stdout),
                stderr: safeObfuscate(job.error.stderr)
            };
        }
        
        const response = encryptResponseIfNeeded({
            success: true,
            job: jobResponse
        }, encryptMessages);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Error getting job:', error);
        
        const response = encryptResponseIfNeeded({
            success: false,
            error: 'Failed to get job',
            details: error.message
        }, req.query.encrypt_messages === 'true');
        
        res.status(500).json(response);
    }
});

// GET /jobs - List all jobs with filtering and pagination
router.get('/', (req, res) => {
    try {
        const options = {
            status: req.query.status,
            limit: Math.min(parseInt(req.query.limit) || 100, 1000), // Max 1000 jobs
            offset: parseInt(req.query.offset) || 0
        };
        
        const encryptMessages = req.query.encrypt_messages === 'true';
        
        const result = getJobManager().getAllJobs(options);
        
        // Obfuscate sensitive data in job list
        const sanitizedJobs = result.jobs.map(job => ({
            id: job.id,
            status: job.status,
            progress: job.progress,
            progressMessage: job.progressMessage,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            hasResults: job.status === 'COMPLETED' && !!job.result,
            hasError: job.status === 'FAILED' && !!job.error
        }));
        
        const response = encryptResponseIfNeeded({
            success: true,
            jobs: sanitizedJobs,
            pagination: {
                total: result.total,
                limit: options.limit,
                offset: options.offset,
                hasMore: result.hasMore
            }
        }, encryptMessages);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Error listing jobs:', error);
        
        const response = encryptResponseIfNeeded({
            success: false,
            error: 'Failed to list jobs',
            details: error.message
        }, req.query.encrypt_messages === 'true');
        
        res.status(500).json(response);
    }
});

// DELETE /jobs/:id - Cancel or delete a job
router.delete('/:id', (req, res) => {
    try {
        const jobId = req.params.id;
        const encryptMessages = req.body?.encrypt_messages || req.query.encrypt_messages === 'true';
        
        const job = getJobManager().getJob(jobId);
        
        if (!job) {
            const response = encryptResponseIfNeeded({
                error: 'Job not found'
            }, encryptMessages);
            
            return res.status(404).json(response);
        }
        
        let result;
        if (job.status === 'RUNNING' || job.status === 'PENDING') {
            // Cancel the job
            result = getJobManager().cancelJob(jobId);
            var message = 'Job cancelled successfully';
        } else {
            // Delete completed/failed job
            getJobManager().deleteJob(jobId);
            result = { id: jobId, deleted: true };
            var message = 'Job deleted successfully';
        }
        
        const response = encryptResponseIfNeeded({
            success: true,
            message: message,
            job: {
                id: result.id,
                status: result.status || 'DELETED'
            }
        }, encryptMessages);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Error deleting job:', error);
        
        const response = encryptResponseIfNeeded({
            success: false,
            error: error.message.includes('not found') ? 'Job not found' : 'Failed to delete job',
            details: error.message
        }, req.body?.encrypt_messages || req.query.encrypt_messages === 'true');
        
        const statusCode = error.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json(response);
    }
});

// GET /jobs-stats - Get job system statistics
router.get('/system/stats', (req, res) => {
    try {
        const encryptMessages = req.query.encrypt_messages === 'true';
        const stats = getJobManager().getStats();
        
        const response = encryptResponseIfNeeded({
            success: true,
            stats: stats
        }, encryptMessages);
        
        res.json(response);
        
    } catch (error) {
        console.error('❌ Error getting job stats:', error);
        
        const response = encryptResponseIfNeeded({
            success: false,
            error: 'Failed to get job statistics',
            details: error.message
        }, req.query.encrypt_messages === 'true');
        
        res.status(500).json(response);
    }
});

module.exports = router;