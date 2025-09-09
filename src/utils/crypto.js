const { randomBytes, createCipheriv, createDecipheriv } = require('crypto');
const { obfuscateSensitiveData } = require('../obfuscate');

const ALGORITHM = 'aes-256-cbc';

function getEncryptionKey() {
    const key = process.env.KB_ENCRYPTION_SECRET;
    if (!key) {
        throw new Error('KB_ENCRYPTION_SECRET environment variable is required for encryption');
    }
    // If key is hex string, convert to buffer, otherwise use as is and pad/truncate to 32 bytes
    if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
        return Buffer.from(key, 'hex');
    } else {
        // Convert string to buffer and ensure it's 32 bytes
        const buffer = Buffer.from(key, 'utf8');
        if (buffer.length === 32) {
            return buffer;
        } else if (buffer.length < 32) {
            // Pad with zeros
            return Buffer.concat([buffer, Buffer.alloc(32 - buffer.length)]);
        } else {
            // Truncate to 32 bytes
            return buffer.slice(0, 32);
        }
    }
}

function encrypt(text) {
    try {
        const encryptionKey = getEncryptionKey();
        const iv = randomBytes(16);
        const cipher = createCipheriv(ALGORITHM, encryptionKey, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const ivString = iv.toString('hex');
        return ivString + ':' + encrypted;
    } catch (error) {
        console.error('Encryption error:', error);
        throw new Error('Failed to encrypt data');
    }
}

function decrypt(encryptedText) {
    try {
        const encryptionKey = getEncryptionKey();
        const [ivHex, encrypted] = encryptedText.split(':');
        
        if (!ivHex || !encrypted) {
            throw new Error('Invalid encrypted data format');
        }
        
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = createDecipheriv(ALGORITHM, encryptionKey, iv);
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        console.error('Decryption error:', error);
        throw new Error('Failed to decrypt data');
    }
}

// Safe wrapper for obfuscation that never throws
function safeObfuscate(data, fallbackMessage = '[OBFUSCATION_FAILED]') {
    try {
        return obfuscateSensitiveData(data);
    } catch (error) {
        console.error('❌ Obfuscation failed:', error.message);
        // Return original data with a warning, or fallback message for safety
        return typeof data === 'string' ? 
            `${fallbackMessage}: ${data}` : 
            `${fallbackMessage}: ${String(data)}`;
    }
}

module.exports = {
    encrypt,
    decrypt,
    safeObfuscate
};