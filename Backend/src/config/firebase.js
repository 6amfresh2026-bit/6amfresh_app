import admin from 'firebase-admin';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

let db = null;
let messaging = null;
let cachedServiceAccount = null;

const sanitizeString = (value) => String(value ?? '').trim();

const getServiceAccountFromEnv = () => {
    if (cachedServiceAccount) return cachedServiceAccount;

    const rawJson = sanitizeString(config.firebaseServiceAccount);
    if (rawJson) {
        try {
            cachedServiceAccount = JSON.parse(rawJson);
            return cachedServiceAccount;
        } catch (err) {
            logger.error('Error parsing FIREBASE_SERVICE_ACCOUNT JSON:', err.message);
        }
    }

    const pathValue = sanitizeString(config.firebaseServiceAccountPath);
    if (pathValue) {
        const filePath = resolve(process.cwd(), pathValue);
        if (existsSync(filePath)) {
            try {
                cachedServiceAccount = JSON.parse(readFileSync(filePath, 'utf8'));
                return cachedServiceAccount;
            } catch (err) {
                logger.error(`Error reading or parsing firebase service account file at ${filePath}:`, err.message);
            }
        }
    }

    return null;
};

/**
 * Initializes Firebase Admin SDK with Service Account.
 * Supports both FCM and Realtime Database.
 */
export const initializeFirebaseRealtime = () => {
    try {
        if (admin.apps.length > 0) {
            messaging = admin.messaging();
            // Same ordering rule as below: asking for the database when none is
            // configured throws, and must not take messaging down with it.
            if (config.firebaseDatabaseUrl) db = admin.database();
            return { db, messaging };
        }

        const serviceAccount = getServiceAccountFromEnv();
        const databaseURL = config.firebaseDatabaseUrl;

        if (!serviceAccount) {
            logger.warn('⚠️ Firebase service account not configured. Firebase features may not work.');
            return null;
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: databaseURL || undefined
        });

        // Messaging first, and never conditional on the database.
        //
        // admin.database() throws "Can't determine Firebase Database URL" when
        // no URL is configured, and it used to run first -- so a project with
        // no Realtime Database instance never reached this line. Messaging
        // stayed null, getFirebaseMessaging() threw for every caller, and the
        // startup log said Firebase had failed outright when the only missing
        // piece was an optional one.
        messaging = admin.messaging();

        if (databaseURL) {
            db = admin.database();
            logger.info('✅ Firebase initialized (messaging + realtime database)');
        } else {
            // A warning, not an error: plenty of deployments never use the
            // realtime database, and every caller of getFirebaseDB already
            // handles its absence. Saying "error" here sent people looking for
            // a broken credential when push was working perfectly well.
            logger.warn(
                '⚠️ Firebase initialized for messaging only. No VITE_FIREBASE_DATABASE_URL set, ' +
                    'so live rider tracking through the realtime database is off.',
            );
        }

        return { db, messaging };
    } catch (error) {
        logger.error(`❌ Firebase Initialization Error: ${error.message}`);
        return null;
    }
};

/**
 * Returns the initialized Firebase Realtime Database instance.
 * @returns {admin.database.Database}
 * @throws Error if not initialized
 */
export const getFirebaseDB = () => {
    if (!db) {
        throw new Error(
            'Firebase Realtime Database is not configured. Create a database in the Firebase console ' +
                'and set VITE_FIREBASE_DATABASE_URL to enable live tracking.',
        );
    }
    return db;
};

/** Whether live tracking through the realtime database is available at all. */
export const isFirebaseRealtimeEnabled = () => Boolean(db);

/**
 * Returns the initialized Firebase Messaging instance.
 * @returns {admin.messaging.Messaging}
 * @throws Error if not initialized
 */
export const getFirebaseMessaging = () => {
    if (!messaging) {
        throw new Error('⚠️ Firebase Messaging not initialized. Call initializeFirebaseRealtime() first.');
    }
    return messaging;
};

export default admin;
