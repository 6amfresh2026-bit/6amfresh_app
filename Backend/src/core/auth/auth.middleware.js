import { verifyAccessToken } from './token.util.js';
import { sendError } from '../../utils/response.js';
import { FoodUser } from '../users/user.model.js';
import { FoodPosUser } from '../pos/posUser.model.js';
import { resolveLimits, resolvePermissions } from '../pos/posPermissions.js';
import { FoodRestaurant } from '../../modules/food/restaurant/models/restaurant.model.js';
import { FoodDeliveryPartner } from '../../modules/food/delivery/models/deliveryPartner.model.js';

export const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'ADMIN') {
        return sendError(res, 403, 'Admin access required');
    }
    next();
};

/**
 * Accounts whose sessions are single-device.
 *
 * Admins are intentionally absent: the panel is routinely used across several
 * browser tabs and machines, so evicting the others on each sign-in would be a
 * regression rather than a safeguard.
 */
const SESSION_SCOPED_MODELS = {
    USER: FoodUser,
    RESTAURANT: FoodRestaurant,
    DELIVERY_PARTNER: FoodDeliveryPartner
};

/**
 * What a cashier's session (a token carrying posUserId) may call: the till and the three reads it
 * is built on. The session is the store's, so without this it would reach everything the owner can
 * (withdrawals, profile edits, payouts).
 */
const POS_SESSION_ALLOWED = [
    { method: null, re: /^\/api\/v1\/food\/restaurant\/pos(\/|$)/ },
    { method: 'GET', re: /^\/api\/v1\/food\/restaurant\/(menu|current|orders)\/?$/ },
    { method: 'GET', re: /^\/api\/v1(\/food)?\/auth\/me\/?$/ },
];

export const isPosSessionAllowed = (method, originalUrl) => {
    const path = String(originalUrl || '').split('?')[0];
    const verb = String(method || 'GET').toUpperCase();
    return POS_SESSION_ALLOWED.some((r) => (!r.method || r.method === verb) && r.re.test(path));
};

const authenticatePosSession = (req, res, next, decoded) => {
    if (decoded.role !== 'RESTAURANT') return sendError(res, 401, 'Invalid or expired token');
    if (!isPosSessionAllowed(req.method, req.originalUrl)) {
        return sendError(res, 403, 'This POS account can only use the point of sale');
    }
    FoodPosUser.findById(decoded.posUserId)
        .select('isActive tokenVersion restaurantId name permissions limits')
        .lean()
        .then((u) => {
            if (!u || String(u.restaurantId) !== String(decoded.userId)) return sendError(res, 401, 'Account not found');
            if (u.isActive === false) return sendError(res, 401, 'This POS account is inactive');
            if (Number(decoded.posTokenVersion) !== (Number(u.tokenVersion) || 0)) {
                return sendError(res, 401, 'You have been signed out. Please sign in again.');
            }
            req.user.posUserId = String(u._id);
            req.user.posUserName = u.name || '';
            req.user.posPermissions = resolvePermissions(u.permissions);
            req.user.posLimits = resolveLimits(u.limits);
            return next();
        })
        .catch(() => sendError(res, 401, 'Authentication failed'));
};

export const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!token) {
        return sendError(res, 401, 'Authentication token missing');
    }

    let decoded;
    try {
        decoded = verifyAccessToken(token);
    } catch (error) {
        return sendError(res, 401, 'Invalid or expired token');
    }

    req.user = {
        userId: decoded.userId,
        role: decoded.role,
        adminType: decoded.adminType
    };

    if (decoded.posUserId) return authenticatePosSession(req, res, next, decoded);

    const model = SESSION_SCOPED_MODELS[decoded.role];
    if (!model) return next();

    // One indexed lookup of two small fields. USER already paid for this to check
    // isActive; the version travels in the same query rather than a second round
    // trip, and the other two roles now share the same path.
    model
        .findById(decoded.userId)
        .select('isActive tokenVersion')
        .lean()
        .then((doc) => {
            if (!doc) return sendError(res, 401, 'Account not found');
            if (decoded.role === 'USER' && doc.isActive === false) {
                return sendError(res, 401, 'User account is deactivated');
            }

            // A token minted before the latest login belongs to a device that has
            // since been replaced.
            //
            // Tokens issued BEFORE this feature shipped carry no version at all.
            // Treating those as 0 would sign every existing user out the moment a
            // single new login bumped anyone; instead they are accepted until the
            // account next logs in, which is when the eviction genuinely applies.
            const stored = Number(doc.tokenVersion) || 0;
            const presented = decoded.tokenVersion;
            if (presented !== undefined && Number(presented) !== stored) {
                return sendError(
                    res,
                    401,
                    'You have been signed out because this account was used on another device'
                );
            }

            return next();
        })
        .catch(() => sendError(res, 401, 'Authentication failed'));
};
export const optionalAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!token) {
        return next();
    }

    try {
        const decoded = verifyAccessToken(token);
        // A cashier's session is confined to the POS; it is not a store sign-in here.
        if (!decoded.posUserId) {
            req.user = {
                userId: decoded.userId,
                role: decoded.role,
                adminType: decoded.adminType
            };
        }
        next();
    } catch (error) {
        // Silently ignore invalid tokens in optional auth
        next();
    }
};
