# API Request Chaining - Issues & Fixes

## Overview
This document outlines the issues that need to be fixed to support robust API request chaining with complex data structures, arrays, and various data types.

---

## 🔴 Critical Issues

### 1. `setValueAtPath()` - Missing Array Index Support
**File**: `src/secure/SecureExecutor.js:924-944`

**Problem**:
The `setValueAtPath` function only handles dot notation for objects. It cannot handle array index notation like `body.users[0].id`.

**Impact**:
- ❌ Cannot set interpolated values into array positions in request configs
- ❌ Will fail when field_name points to an array element
- ❌ Example: `field_name: "body.users[0].id"` with an interpolated value will crash

**Example Failure**:
```javascript
// This will fail:
setValueAtPath(config, "fetchOptions.body.items[0].id", "abc123")

// Error: Cannot create property '0' on string 'items[0]'
```

**Fix Required**:
Add array bracket notation parsing similar to what was done in `getValueAtPath()`:
- Parse `propName[index]` pattern
- Create arrays if they don't exist
- Handle array element access for both intermediate and final keys

**Code Location**: Lines 924-944

---

## 🟡 Moderate Issues

### 2. `buildConfigObjectCode()` - No String Escaping
**File**: `src/secure/SecureExecutor.js:1264-1292`

**Problem**:
When building JavaScript code from config objects, string values containing backticks or `${}` are not escaped. This can cause:
1. Syntax errors in generated code
2. Unintended template literal interpolation
3. Code injection vulnerabilities

**Impact**:
- ⚠️ If an API response contains backticks, the generated code breaks
- ⚠️ If an API response contains `${}`, it gets interpolated at runtime (security risk)
- ⚠️ Interpolated values from previous API calls could break subsequent requests

**Example Failure**:
```javascript
// API 1 returns: { name: "Hello `world`" }
// Gets interpolated into API 2 config:
const config = {
  body: `User name is ${result.name}`  // Becomes: User name is Hello `world`
};
// Result: Syntax error due to nested backticks
```

**Another Example**:
```javascript
// API 1 returns: { code: "${process.env.SECRET}" }
// Gets interpolated:
const config = {
  url: `https://api.com?code=${result.code}`
};
// Result: Template literal evaluates ${process.env.SECRET} at runtime!
```

**Fix Required**:
In the `buildConfigObjectCode()` function, when handling strings:
```javascript
if (typeof obj === 'string') {
    if (obj.includes('${process.env.')) {
        // Escape backticks and ${} in the string before wrapping in template literal
        const escaped = obj
            .replace(/\\/g, '\\\\')    // Escape backslashes first
            .replace(/`/g, '\\`')       // Escape backticks
            .replace(/\$/g, '\\$');     // Escape dollar signs
        return '`' + escaped + '`';
    }
    // Regular string - use JSON.stringify which handles escaping
    return JSON.stringify(obj);
}
```

**Code Location**: Lines 1270-1278

---

### 3. `interpolateTemplate()` - No Type Handling
**File**: `src/secure/SecureExecutor.js:857-876`

**Problem**:
The function returns raw values without converting them to strings. When interpolating into string contexts (URLs, request bodies), this causes issues.

**Impact**:
- ⚠️ Objects become `[object Object]`
- ⚠️ Arrays become comma-separated values without proper formatting
- ⚠️ `null` becomes the string `"null"`
- ⚠️ `undefined` should probably error but might become `"undefined"`

**Example Failures**:
```javascript
// Object interpolation:
template: "https://api.com/users/${result.user}"
result.user: {id: 1, name: "Bob"}
// Result: "https://api.com/users/[object Object]" ❌

// Array interpolation:
template: "Tags: ${result.tags}"
result.tags: ["urgent", "bug"]
// Result: "Tags: urgent,bug" (might be okay, but unpredictable)

// Null interpolation:
template: "Value: ${result.missing}"
result.missing: null
// Result: "Value: null" (string "null", not actual null)
```

**Fix Required**:
Add smart type conversion at line 874:
```javascript
if (value === undefined || value === null) {
    const error = `Interpolation failed: ${fullPath} is undefined or null. Available data: ${JSON.stringify(data, null, 2)}`;
    console.error(`❌ ${error}`);
    throw new Error(error);
}

// Convert non-primitives to strings appropriately
if (typeof value === 'object') {
    // For objects and arrays, JSON stringify them
    return JSON.stringify(value);
}

// Primitives (string, number, boolean) can be returned as-is
// They'll be coerced to strings in the template context
return String(value);
```

**Code Location**: Lines 868-875

---

## 🟢 Minor Issues

### 4. `interpolatePassedVariables()` - Overly Broad Prefix Detection
**File**: `src/secure/SecureExecutor.js:831-833`

**Problem**:
The field name prefix detection is too broad:
```javascript
if (field_name?.startsWith("url")) field_name = `fetchOptions.${field_name}`
if (field_name?.startsWith("body")) field_name = `fetchOptions.${field_name}`
```

**Impact**:
- Edge case: If you want to set a header named `body` (rare but valid HTTP header)
- It will incorrectly transform `headers.body` → `fetchOptions.headers.body`
- Similarly for a header/field starting with "url"

**Example Failure**:
```javascript
field_name: "headers.body-hash"
// Gets transformed to: "fetchOptions.headers.body-hash" ❌
// Should stay as: "headers.body-hash"
```

**Fix Required**:
Make the detection more precise:
```javascript
// Only transform if it's EXACTLY "url", "body", or "method", not just starts with
if (field_name === "url") field_name = `fetchOptions.url`
if (field_name === "body") field_name = `fetchOptions.body`
if (field_name === "method") field_name = `fetchOptions.method`

// OR use a more specific check:
const topLevel = field_name.split('.')[0];
if (topLevel === "url" || topLevel === "body" || topLevel === "method") {
    field_name = `fetchOptions.${field_name}`;
}
```

**Code Location**: Lines 831-833

---

### 5. `interpolateTemplate()` - Regex Limitations
**File**: `src/secure/SecureExecutor.js:863`

**Problem**:
The regex `/\$\{result\.([^}]+)\}/g` is simple and works for basic paths, but has limitations:
- Uses `[^}]+` which means "anything except `}`"
- Cannot handle nested braces (not a real issue since we only support simple paths)
- Very permissive - allows any characters in the path

**Impact**:
- 🟢 Currently works fine for intended use cases
- 🟢 The simplicity is actually good for security (prevents complex expressions)
- ⚠️ Could be more strict to validate path format

**Current Behavior**:
```javascript
// Works:
"${result.data.id}" ✅
"${result.items[0].name}" ✅

// Also works (but maybe shouldn't?):
"${result.weird!!!chars}" ✅ (though getValueAtPath will fail)
```

**Optional Fix**:
Make the regex more strict to validate proper path format:
```javascript
// Only allow: letters, numbers, dots, brackets, underscores
return template.replace(/\$\{result\.([\w.\[\]]+)\}/g, (match, path) => {
    // ...
});
```

**Code Location**: Line 863

---

## 📋 Priority Order for Fixes

1. **🔴 CRITICAL - Fix `setValueAtPath()` array support** (Issue #1)
   - Required for API chains that pass array data
   - Blocks basic functionality

2. **🟡 HIGH - Fix `buildConfigObjectCode()` escaping** (Issue #2)
   - Security issue (template injection)
   - Can break generated code

3. **🟡 HIGH - Fix `interpolateTemplate()` type handling** (Issue #3)
   - Prevents silent failures with wrong data types
   - Improves error messages

4. **🟢 MEDIUM - Improve `field_name` detection** (Issue #4)
   - Edge case fix
   - Low priority but easy to fix

5. **🟢 LOW - Improve regex validation** (Issue #5)
   - Optional enhancement
   - Current behavior is acceptable

---

## Testing Recommendations

After fixes, test these scenarios:

### Test Case 1: Array Index in Paths
```javascript
{
  api_calls: {
    getUsers: { url: "https://api.com/users" },
    getFirstUser: {
      url: "https://api.com/users/${result.data[0].id}",
      passed_variables: {
        "fetchOptions.url": {
          passed_from: "getUsers",
          value: "${result.data[0].id}"
        }
      }
    }
  }
}
```

### Test Case 2: Special Characters in Response
```javascript
// API returns: { message: "Hello `world` with ${vars}" }
// Should be safely interpolated without breaking code
```

### Test Case 3: Object/Array Interpolation
```javascript
// API returns: { user: {id: 1, name: "Bob"} }
// Interpolate into string: Should JSON stringify, not [object Object]
```

### Test Case 4: Nested Array Access
```javascript
// result.data.users[0].roles[1].name
// Should properly navigate nested arrays
```

---

## Summary

- **1 Critical** issue blocking API chaining with arrays
- **2 High priority** issues causing security/reliability problems
- **2 Medium/Low** priority issues for edge cases and improvements

All issues are in `src/secure/SecureExecutor.js` and can be fixed independently.
