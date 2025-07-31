function obfuscateSensitiveData(input) {
    if (!input) return input;
    
    // Convert objects to strings for processing
    let str;
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
    
    // 2. Then catch any remaining tokens that might be in error messages
    str = str.replace(/Bearer\s+[A-Za-z0-9\-._~+\/]+=*/gi, 'Bearer ***REDACTED***');
    str = str.replace(/\b(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36}/g, '***GITHUB_TOKEN***');
    str = str.replace(/\bAKIA[0-9A-Z]{16}/g, '***AWS_ACCESS_KEY***');
    str = str.replace(/\bya29\.[A-Za-z0-9_\-\.]{50,}/g, '***GOOGLE_TOKEN***');
    // Add after the Google token pattern:
    str = str.replace(/\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, '***JWT_TOKEN***');
    
    // 3. Generic long token pattern as final catch-all
    str = str.replace(/(['"\s])([a-zA-Z0-9_-]{40,})(['"\s])/g, '$1***REDACTED***$3');
    
    return str;
}

module.exports = {
    obfuscateSensitiveData
};