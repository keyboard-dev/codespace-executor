import { generateKeyPairSync, publicEncrypt, privateDecrypt, createHash, constants } from 'crypto';

interface KeyPair {
  publicKey: string;
  privateKey: string;
  createdAt: Date;
  fingerprint: string;
}

interface KeyMetadata {
  algorithm: string;
  createdAt: string;
  fingerprint: string;
  publicKey: string;
}

// In-memory key storage (regenerates on every boot)
let keyPair: KeyPair | null = null;

/**
 * Generate a new RSA-4096 key pair
 * This is called once on server startup
 */
export function generateKeyPair(): KeyPair {

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  // Generate fingerprint from public key
  const fingerprint = createHash('sha256')
    .update(publicKey)
    .digest('hex')
    .toUpperCase()
    .match(/.{2}/g)
    ?.join(':') || '';

  keyPair = {
    publicKey,
    privateKey,
    createdAt: new Date(),
    fingerprint
  };


  return keyPair;
}

/**
 * Get the current public key in PEM format
 */
export function getPublicKey(): string {
  if (!keyPair) {
    throw new Error('Key pair not initialized. Call generateKeyPair() first.');
  }
  return keyPair.publicKey;
}

/**
 * Get key metadata (algorithm, created date, fingerprint)
 */
export function getKeyMetadata(): KeyMetadata {
  if (!keyPair) {
    throw new Error('Key pair not initialized. Call generateKeyPair() first.');
  }

  return {
    algorithm: 'RSA-4096',
    createdAt: keyPair.createdAt.toISOString(),
    fingerprint: keyPair.fingerprint,
    publicKey: keyPair.publicKey
  };
}

/**
 * Encrypt data using the public key
 * This is typically used by external services to encrypt data to send to us
 * @param data - Plain text data to encrypt
 * @returns Base64 encoded encrypted data
 */
export function encryptWithPublicKey(data: string): string {
  if (!keyPair) {
    throw new Error('Key pair not initialized. Call generateKeyPair() first.');
  }

  try {
    const buffer = Buffer.from(data, 'utf8');
    const encrypted = publicEncrypt(
      {
        key: keyPair.publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer
    );
    return encrypted.toString('base64');
  } catch (error: any) {
    console.error('❌ Encryption error:', error.message);
    throw new Error(`Failed to encrypt data: ${error.message}`);
  }
}

/**
 * Decrypt data using the private key
 * This is used to decrypt data sent to us that was encrypted with our public key
 * @param encryptedData - Base64 encoded encrypted data
 * @returns Decrypted plain text
 */
export function decryptWithPrivateKey(encryptedData: string): string {
  if (!keyPair) {
    throw new Error('Key pair not initialized. Call generateKeyPair() first.');
  }

  try {
    const buffer = Buffer.from(encryptedData, 'base64');
    const decrypted = privateDecrypt(
      {
        key: keyPair.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer
    );
    return decrypted.toString('utf8');
  } catch (error: any) {
    console.error('❌ Decryption error:', error.message);
    throw new Error(`Failed to decrypt data: ${error.message}`);
  }
}

/**
 * Check if key pair has been initialized
 */
export function isKeyPairInitialized(): boolean {
  return keyPair !== null;
}

/**
 * Get key pair creation timestamp
 */
export function getKeyCreatedAt(): Date | null {
  return keyPair?.createdAt || null;
}

/**
 * Attempt to decrypt a value using the private key
 * If decryption fails for any reason, silently return the original value
 * This is useful for header values that may or may not be encrypted
 * @param value - The value to attempt to decrypt
 * @returns Decrypted value if successful, original value if decryption fails
 */
export function tryDecrypt(value: string): string {
  // Return original value if empty or whitespace only
  if (!value || value.trim() === '') {
    return value;
  }
  // Return original value if key pair not initialized
  if (!keyPair) {
    return value;
  }

  try {
    // Attempt to decrypt the value
    const buffer = Buffer.from(value, 'base64');
    const decrypted = privateDecrypt(
      {
        key: keyPair.privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      buffer
    );
    return decrypted.toString('utf8');
  } catch (error) {
    // Silently return original value if any error occurs
    // This includes: invalid base64, wrong padding, decryption failure, etc.
    return value;
  }
}
