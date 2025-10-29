import { jwtVerify, createRemoteJWKSet } from 'jose';

const ISSUER_URL = "https://login.keyboard.dev"
const JWKS = createRemoteJWKSet(new URL(`${ISSUER_URL}/oauth2/jwks`));

interface VerificationResult {
  isValid: boolean;
  error?: string;
}

/**
 * Verify a bearer token using jose JWT verification
 * @param token - The bearer token to verify
 * @returns Promise<boolean> - true if token is valid, false otherwise
 */
export async function verifyBearerToken(token: string): Promise<boolean> {
  if (!token || token.trim() === '') {
    console.error('❌ Token verification failed: Empty token');
    return false;
  }

  try {
    await jwtVerify(token, JWKS, {
      issuer: ISSUER_URL,
    });

    return true;

  } catch (error: any) {
    if (error.code === 'ERR_JWT_EXPIRED') {
      console.error('❌ Token verification failed: Token expired');
    } else if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      console.error('❌ Token verification failed: Invalid issuer or claims');
    } else if (error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      console.error('❌ Token verification failed: Invalid signature');
    } else {
      console.error('❌ Token verification error:', error.message);
    }
    return false;
  }
}

/**
 * Extract bearer token from Authorization header
 * @param authHeader - The Authorization header value
 * @returns The token string or null if not found
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Verify bearer token with detailed result
 * Useful for debugging and detailed error messages
 */
export async function verifyBearerTokenDetailed(token: string): Promise<VerificationResult> {
  if (!token || token.trim() === '') {
    return {
      isValid: false,
      error: 'Empty or missing token'
    };
  }

  try {
    await jwtVerify(token, JWKS, {
      issuer: ISSUER_URL,
    });

    return { isValid: true };

  } catch (error: any) {
    let errorMessage = 'Unknown error';

    if (error.code === 'ERR_JWT_EXPIRED') {
      errorMessage = 'Token expired';
    } else if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      errorMessage = 'Invalid issuer or claims';
    } else if (error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      errorMessage = 'Invalid signature';
    } else {
      errorMessage = error.message || 'JWT verification failed';
    }

    return {
      isValid: false,
      error: errorMessage
    };
  }
}
