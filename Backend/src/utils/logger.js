/**
 * `node --test` relays each test file's console output to the parent process
 * over a structured-clone channel. A test that exercises an error path (a
 * batch mismatch, an expired stock write-off) logs heavily on purpose, and
 * enough of it lands mid-write to desync that channel: the run dies with
 * "Unable to deserialize cloned data due to invalid or unsupported version",
 * not a real assertion failure. `NODE_TEST_CONTEXT` is set by the test
 * runner in every child it spawns, so logging is silenced only there.
 */
const silenced = Boolean(process.env.NODE_TEST_CONTEXT);

export const logger = {
    info: (msg) => { if (!silenced) console.log(`✅ [INFO] ${new Date().toLocaleTimeString()}: ${msg}`); },
    error: (msg) => { if (!silenced) console.error(`❌ [ERROR] ${new Date().toLocaleTimeString()}: ${msg}`); },
    warn: (msg) => { if (!silenced) console.warn(`⚠️ [WARN] ${new Date().toLocaleTimeString()}: ${msg}`); },
    // Called in a couple of places and never defined, so every one of those
    // calls threw -- including one inside a catch block, where the thrown
    // TypeError replaced the error being reported.
    debug: (msg) => { if (!silenced) console.log(`🔍 [DEBUG] ${new Date().toLocaleTimeString()}: ${msg}`); }
};
