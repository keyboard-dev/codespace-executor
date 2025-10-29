export function obfuscateSensitiveData(input: any): string {
    if (!input) return input;
    
    // Convert objects to strings for processing
    let str: string;
    if (typeof input === 'object') {
        try {
            str = JSON.stringify(input, null, 2);
        } catch (error) {
            // Handle circular references and other JSON.stringify errors
            str = String(input);
        }
    } else {
        str = String(input);
    }
    
    // 1. Remove entire sensitive objects first (most aggressive, catches the most)
    str = str.replace(/['"]?headers['"]?\s*:\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/gi, 'headers: {***REMOVED***}');
    str = str.replace(/['"]?request['"]?\s*:\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/gi, 'request: {***REMOVED***}');
    str = str.replace(/['"]?config['"]?\s*:\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/gi, 'config: {***REMOVED***}');
    str = str.replace(/['"]?_header['"]?\s*:\s*['"][^'"]*['"]/g, '_header: "***REMOVED***"');
    
    // Headers as objects (catches rawHeaders, defaultHeaders, etc.)
    str = str.replace(/['"]?[^'"]*[Hh]eader[^'"]*['"]?\s*:\s*\{[\s\S]*?\}/gi, (match) => match.split(':')[0] + ': {***REMOVED***}');
    // Headers as arrays
    str = str.replace(/['"]?[^'"]*[Hh]eader[^'"]*['"]?\s*:\s*\[[\s\S]*?\]/gi, (match) => match.split(':')[0] + ': [***REMOVED***]');
    // Headers as strings
    str = str.replace(/['"]?[^'"]*[Hh]eader[^'"]*['"]?\s*:\s*['"][^'"]*['"]/gi, (match) => match.split(':')[0] + ': "***REMOVED***"');
    
    // 2. Environment variable patterns (enhanced for secure execution)
    str = str.replace(/process\.env\.[A-Z_]+\s*=\s*['"][^'"]*['"]/gi, 'process.env.***FILTERED*** = "***REDACTED***"');
    str = str.replace(/KEYBOARD_[A-Z_]+\s*[:=]\s*['"][^'"]*['"]/gi, 'KEYBOARD_***_VAR: "***REDACTED***"');
    str = str.replace(/['"][^'"]*KEYBOARD[^'"]*['"]:\s*['"][^'"]*['"]/gi, '"KEYBOARD_***_VAR": "***REDACTED***"');

    // 3. API endpoint and connection error patterns
    str = str.replace(/https?:\/\/[^\s]*api[^\s]*\.[^\s]*/gi, 'https://***API_ENDPOINT***/');
    str = str.replace(/connect ECONNREFUSED [^\s]+/gi, 'connect ECONNREFUSED ***FILTERED_ADDRESS***');
    str = str.replace(/getaddrinfo ENOTFOUND [^\s]+/gi, 'getaddrinfo ENOTFOUND ***FILTERED_HOST***');

    // 4. Then catch any remaining tokens that might be in error messages
    str = str.replace(/Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi, 'Bearer ***REDACTED***');
    str = str.replace(/\b(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36}/g, '***GITHUB_TOKEN***');
    str = str.replace(/\bAKIA[0-9A-Z]{16}/g, '***AWS_ACCESS_KEY***');
    str = str.replace(/\bya29\.[A-Za-z0-9_\-\.]{50,}/g, '***GOOGLE_TOKEN***');
    str = str.replace(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, '***JWT_TOKEN***');

    // 5. Environment variable values in various formats
    str = str.replace(/KEYBOARD_[A-Z_]+=['"][^'"]{20,}['"]/gi, 'KEYBOARD_***_VAR="***REDACTED***"');
    str = str.replace(/[A-Z_]+_TOKEN=['"][^'"]{20,}['"]/gi, '***_TOKEN="***REDACTED***"');
    str = str.replace(/[A-Z_]+_SECRET=['"][^'"]{20,}['"]/gi, '***_SECRET="***REDACTED***"');
    str = str.replace(/[A-Z_]+_KEY=['"][^'"]{20,}['"]/gi, '***_KEY="***REDACTED***"');

    // 6. File path patterns that might contain sensitive info
    str = str.replace(/\/[^\s]*\/\.[^\/\s]+/gi, '/***FILTERED_PATH***/');
    str = str.replace(/Error: ENOENT: no such file or directory, open '[^']*'/gi, 'Error: ENOENT: no such file or directory, open \'***FILTERED_PATH***\'');
    
    // 7. Generic long token pattern as final catch-all
    str = str.replace(/(['"\s])([a-zA-Z0-9_-]{40,})(['"\s])/g, '$1***REDACTED***$3');
    
    return str;
}