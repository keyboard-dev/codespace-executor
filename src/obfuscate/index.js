// Function to obfuscate sensitive information in text
function obfuscateSensitiveData(text) {
    if (!text || typeof text !== 'string') return text;
    
    let obfuscatedText = text;
    
    // Patterns for sensitive data
    const sensitivePatterns = [
        // API Keys (various formats)
        {
            pattern: /\b[Aa][Pp][Ii][\s_-]*[Kk][Ee][Yy][\s]*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/g,
            replacement: (match, key) => match.replace(key, `***API_KEY_${key.length}***`)
        },
        // Bearer tokens
        {
            pattern: /\b[Bb][Ee][Aa][Rr][Ee][Rr][\s]+([A-Za-z0-9_\-\.]{20,})/g,
            replacement: (match, token) => match.replace(token, `***BEARER_TOKEN_${token.length}***`)
        },
        // Authorization headers
        {
            pattern: /\b[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn][\s]*[:=]\s*['"]?([A-Za-z0-9_\-\.]{20,})['"]?/g,
            replacement: (match, auth) => match.replace(auth, `***AUTH_${auth.length}***`)
        },
        // Generic tokens
        {
            pattern: /\b[Tt][Oo][Kk][Ee][Nn][\s]*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/g,
            replacement: (match, token) => match.replace(token, `***TOKEN_${token.length}***`)
        },
        // Passwords
        {
            pattern: /\b[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd][\s]*[:=]\s*['"]?([A-Za-z0-9_\-!@#$%^&*()]{6,})['"]?/g,
            replacement: (match, password) => match.replace(password, `***PASSWORD_${password.length}***`)
        },
        // Secret keys
        {
            pattern: /\b[Ss][Ee][Cc][Rr][Ee][Tt][\s_-]*[Kk][Ee][Yy][\s]*[:=]\s*['"]?([A-Za-z0-9_\-]{20,})['"]?/g,
            replacement: (match, secret) => match.replace(secret, `***SECRET_${secret.length}***`)
        },
        // Generic keys with common patterns (including access_token)
        {
            pattern: /\b(access_key|access_token|secret_key|private_key|client_secret|client_id|refresh_token)[\s]*[:=]\s*['"]?([A-Za-z0-9_\-\.]{16,})['"]?/gi,
            replacement: (match, keyType, keyValue) => match.replace(keyValue, `***${keyType.toUpperCase()}_${keyValue.length}***`)
        },
        // Google OAuth tokens (ya29. prefix)
        {
            pattern: /\bya29\.[A-Za-z0-9_\-\.]{50,}/g,
            replacement: (match) => `***GOOGLE_ACCESS_TOKEN_${match.length}***`
        },
        // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_ prefixes)
        {
            pattern: /\b(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36}/g,
            replacement: (match) => `***GITHUB_TOKEN_${match.length}***`
        },
        // AWS tokens
        {
            pattern: /\bAKIA[0-9A-Z]{16}/g,
            replacement: (match) => `***AWS_ACCESS_KEY_${match.length}***`
        },
        // Slack tokens
        {
            pattern: /\bxox[bpoa]-[0-9]{12}-[0-9]{12}-[0-9a-zA-Z]{24}/g,
            replacement: (match) => `***SLACK_TOKEN_${match.length}***`
        },
        // JWT tokens (basic pattern)
        {
            pattern: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g,
            replacement: (match) => `***JWT_TOKEN_${match.length}***`
        },
        // Base64 encoded keys (common pattern)
        {
            pattern: /\b([A-Za-z0-9+\/]{64,}={0,2})\b/g,
            replacement: (match) => {
                // Only obfuscate if it looks like it could be a key (longer than 64 chars)
                if (match.length > 64) {
                    return `***BASE64_KEY_${match.length}***`;
                }
                return match;
            }
        },
        // Environment variable patterns (in logs)
        {
            pattern: /\b[A-Z_]{2,}_(?:KEY|TOKEN|SECRET|PASSWORD|API)[A-Z_]*[\s]*[:=]\s*['"]?([A-Za-z0-9_\-]{10,})['"]?/g,
            replacement: (match, value) => match.replace(value, `***ENV_VAR_${value.length}***`)
        },
        // URL parameters with tokens (common in OAuth flows)
        {
            pattern: /[?&](access_token|token|key|secret|client_secret|refresh_token)=([A-Za-z0-9_\-\.%]{16,})(?:[&\s]|$)/gi,
            replacement: (match, paramName, paramValue) => match.replace(paramValue, `***URL_${paramName.toUpperCase()}_${paramValue.length}***`)
        },
        // Obfuscate ALL header values (aggressive approach for security)
        {
            pattern: /(['"]?)([a-zA-Z0-9_\-]+)(['"]?\s*:\s*)(['"]?)([^'",\}\s][^'",\}]*?)(\4)(\s*[,\}])/g,
            replacement: (match, keyQuote1, keyName, separator, valueQuote1, value, valueQuote2, ending) => {
                // Define safe header values that don't need obfuscation
                const safeValues = [
                    // Content types
                    'application/json', 'application/xml', 'application/x-www-form-urlencoded',
                    'text/plain', 'text/html', 'text/css', 'text/javascript',
                    'multipart/form-data', 'image/jpeg', 'image/png', 'image/gif',
                    // Common headers
                    'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
                    'gzip', 'deflate', 'br', 'identity',
                    'en-US', 'en', '*', 'utf-8', 'iso-8859-1',
                    'keep-alive', 'close', 'no-cache', 'max-age=0',
                    'same-origin', 'cors', 'navigate'
                ];
                
                // Check if this appears to be in a headers context
                const isInHeadersContext = /headers\s*[:=]\s*\{[^}]*$/.test(match.substring(0, match.indexOf(keyName))) ||
                                         /["']headers["']\s*:\s*\{[^}]*$/.test(match.substring(0, match.indexOf(keyName)));
                
                if (isInHeadersContext) {
                    // Check if the value is in our safe list (case insensitive)
                    const isSafeValue = safeValues.some(safe => 
                        value.toLowerCase() === safe.toLowerCase() || 
                        value.toLowerCase().startsWith(safe.toLowerCase() + '/') ||
                        value.toLowerCase().startsWith(safe.toLowerCase() + ';')
                    );
                    
                    // Also preserve very short values (likely not secrets)
                    if (!isSafeValue && value.length >= 4) {
                        return `${keyQuote1}${keyName}${separator}${valueQuote1}***HEADER_${value.length}***${valueQuote2}${ending}`;
                    }
                }
                
                return match; // Return unchanged if not in headers or is safe value
            }
        },
        // Specific patterns for headers object detection
        {
            pattern: /(headers\s*[:=]\s*\{[^}]*?)(['"]?)([^'",\}\s][^'",\}]{4,})(\2)([^}]*?\})/gi,
            replacement: (match, beforeValue, quote, value, endQuote, afterValue) => {
                // Safe values that shouldn't be obfuscated
                const safeHeaderValues = [
                    'application/json', 'application/xml', 'text/plain', 'text/html',
                    'multipart/form-data', 'gzip', 'deflate', 'en-us', 'utf-8',
                    'keep-alive', 'no-cache', 'cors', 'same-origin'
                ];
                
                const isSafe = safeHeaderValues.some(safe => 
                    value.toLowerCase().includes(safe.toLowerCase())
                );
                
                if (!isSafe && value.length >= 4) {
                    return `${beforeValue}${quote}***HEADER_VAL_${value.length}***${endQuote}${afterValue}`;
                }
                return match;
            }
        },
        // JSON format headers
        {
            pattern: /("headers"\s*:\s*\{[^}]*?)(['"]?)([^'",\}\s][^'",\}]{4,})(\2)([^}]*?\})/gi,
            replacement: (match, beforeValue, quote, value, endQuote, afterValue) => {
                // Skip safe values
                const safePrefixes = ['application/', 'text/', 'multipart/', 'image/', 'en-', 'utf-'];
                const isSafe = safePrefixes.some(prefix => value.toLowerCase().startsWith(prefix)) ||
                              ['gzip', 'deflate', 'cors', 'keep-alive', 'no-cache'].includes(value.toLowerCase());
                
                if (!isSafe && value.length >= 4) {
                    return `${beforeValue}${quote}***JSON_HDR_${value.length}***${endQuote}${afterValue}`;
                }
                return match;
            }
        }
    ];
    
    // Apply each pattern
    sensitivePatterns.forEach(({ pattern, replacement }) => {
        obfuscatedText = obfuscatedText.replace(pattern, replacement);
    });
    
    return obfuscatedText;
}

module.exports = {
    obfuscateSensitiveData
};