export const logger = {
    info: (msg) => console.log(`✅ [INFO] ${new Date().toLocaleTimeString()}: ${msg}`),
    error: (msg) => console.error(`❌ [ERROR] ${new Date().toLocaleTimeString()}: ${msg}`),
    warn: (msg) => console.warn(`⚠️ [WARN] ${new Date().toLocaleTimeString()}: ${msg}`),
    // Called in a couple of places and never defined, so every one of those
    // calls threw -- including one inside a catch block, where the thrown
    // TypeError replaced the error being reported.
    debug: (msg) => console.log(`🔍 [DEBUG] ${new Date().toLocaleTimeString()}: ${msg}`)
};
