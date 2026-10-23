import bcrypt from 'bcryptjs';
import ms from 'ms';
import mongoose from 'mongoose';
import { FoodPosUser } from './posUser.model.js';
import { POS_PERMISSIONS, resolveLimits, resolvePermissions } from './posPermissions.js';
import { enrichPosUsers } from './posUserActivity.service.js';
import { FoodRestaurant } from '../../modules/food/restaurant/models/restaurant.model.js';
import { FoodRefreshToken } from '../refreshTokens/refreshToken.model.js';
import { signAccessToken, signRefreshToken } from '../auth/token.util.js';
import { AuthError, ValidationError } from '../auth/errors.js';
import { config } from '../../config/env.js';

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
export const MIN_PASSWORD = 6;
export const MAX_PASSWORD = 72; // bcrypt ignores anything past 72 bytes

const clean = (v) => String(v ?? '').trim();

const toRow = (u, store) => ({
    id: String(u._id),
    name: u.name,
    username: u.username,
    phone: u.phone || '',
    isActive: u.isActive !== false,
    permissions: resolvePermissions(u.permissions),
    limits: resolveLimits(u.limits),
    restaurantId: String(u.restaurantId),
    restaurantName: store?.restaurantName || store?.name || '',
    lastLoginAt: u.lastLoginAt || null,
    createdAt: u.createdAt,
});

const assertPassword = (password) => {
    const p = String(password ?? '');
    if (p.length < MIN_PASSWORD) throw new ValidationError(`Password must be at least ${MIN_PASSWORD} characters`);
    if (p.length > MAX_PASSWORD) throw new ValidationError(`Password can be at most ${MAX_PASSWORD} characters`);
    return p;
};

/** A permissions array from the form: only known keys, no repeats. Anything else is an error. */
const cleanPermissions = (value) => {
    if (!Array.isArray(value)) throw new ValidationError('permissions must be a list');
    const bad = value.find((k) => !POS_PERMISSIONS.includes(k));
    if (bad !== undefined) throw new ValidationError(`Unknown permission: ${bad}`);
    return POS_PERMISSIONS.filter((k) => value.includes(k));
};

const cleanLimits = (value) => {
    if (!value || typeof value !== 'object') throw new ValidationError('limits must be an object');
    const out = {};
    if (value.maxBillAmount !== undefined) {
        const n = Number(value.maxBillAmount);
        if (!Number.isFinite(n) || n < 0) throw new ValidationError('Bill limit must be 0 or more');
        out.maxBillAmount = Math.round(n * 100) / 100;
    }
    if (value.maxDiscountPercent !== undefined) {
        const n = Number(value.maxDiscountPercent);
        if (!Number.isFinite(n) || n < 0 || n > 100) throw new ValidationError('Discount limit must be between 0 and 100');
        out.maxDiscountPercent = n;
    }
    return out;
};

const assertId = (id, what) => {
    if (!mongoose.isValidObjectId(id)) throw new ValidationError(`${what} is invalid`);
    return id;
};

const storesById = async (rows) => {
    const ids = [...new Set(rows.map((r) => String(r.restaurantId)))];
    const stores = await FoodRestaurant.find({ _id: { $in: ids } }).select('restaurantName name').lean();
    return new Map(stores.map((s) => [String(s._id), s]));
};

/** Admin: the POS users, newest first, optionally for one store or matching a search. */
export const listPosUsers = async ({ search, restaurantId, page = 1, limit = 50 } = {}) => {
    const filter = {};
    if (restaurantId) filter.restaurantId = assertId(restaurantId, 'Store');
    const q = clean(search);
    if (q) {
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: rx }, { username: rx }, { phone: rx }];
    }
    const size = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const [rows, total, active] = await Promise.all([
        FoodPosUser.find(filter).sort({ createdAt: -1 }).skip((pg - 1) * size).limit(size).select('-password').lean(),
        FoodPosUser.countDocuments(filter),
        FoodPosUser.countDocuments({ ...filter, isActive: true }),
    ]);
    const stores = await storesById(rows);
    const users = await enrichPosUsers(rows.map((u) => toRow(u, stores.get(String(u.restaurantId)))));
    return {
        users,
        total,
        page: pg,
        limit: size,
        summary: { total, active, inactive: total - active },
    };
};

/** Admin: create a POS user for a store. */
export const createPosUser = async (body = {}, adminId = null) => {
    const restaurantId = assertId(body.restaurantId, 'Store');
    const name = clean(body.name);
    const username = clean(body.username).toLowerCase();
    if (!name) throw new ValidationError('Name is required');
    if (name.length > 80) throw new ValidationError('Name can be at most 80 characters');
    if (!USERNAME_RE.test(username)) {
        throw new ValidationError('Username must be 3-30 characters: letters, numbers, dot, dash or underscore');
    }
    const password = assertPassword(body.password);

    const store = await FoodRestaurant.findById(restaurantId).select('restaurantName name').lean();
    if (!store) throw new ValidationError('Store not found');
    if (await FoodPosUser.exists({ username })) throw new ValidationError('That username is already taken');

    let user;
    try {
        user = await FoodPosUser.create({
            restaurantId,
            name,
            username,
            phone: clean(body.phone),
            password: await bcrypt.hash(password, 10),
            ...(body.permissions !== undefined ? { permissions: cleanPermissions(body.permissions) } : {}),
            ...(body.limits !== undefined ? { limits: cleanLimits(body.limits) } : {}),
            createdBy: mongoose.isValidObjectId(adminId) ? adminId : null,
        });
    } catch (err) {
        if (err?.code === 11000) throw new ValidationError('That username is already taken');
        throw err;
    }
    return toRow(user.toObject(), store);
};

const findUser = async (id) => {
    const user = await FoodPosUser.findById(assertId(id, 'POS user'));
    if (!user) throw new ValidationError('POS user not found');
    return user;
};

/** Admin: change name, phone or active state. Deactivating signs the person out at once. */
export const updatePosUser = async (id, body = {}) => {
    const user = await findUser(id);
    if (body.name !== undefined) {
        const name = clean(body.name);
        if (!name) throw new ValidationError('Name is required');
        if (name.length > 80) throw new ValidationError('Name can be at most 80 characters');
        user.name = name;
    }
    if (body.phone !== undefined) user.phone = clean(body.phone);
    if (body.permissions !== undefined) user.permissions = cleanPermissions(body.permissions);
    if (body.limits !== undefined) user.limits = { ...resolveLimits(user.limits), ...cleanLimits(body.limits) };
    if (body.isActive !== undefined) {
        if (typeof body.isActive !== 'boolean') throw new ValidationError('isActive must be true or false');
        if (user.isActive && !body.isActive) user.tokenVersion += 1;
        user.isActive = body.isActive;
    }
    await user.save();
    const stores = await storesById([user]);
    return toRow(user.toObject(), stores.get(String(user.restaurantId)));
};

/** Admin: set a new password. Sessions already open stop working. */
export const resetPosUserPassword = async (id, password) => {
    const user = await findUser(id);
    user.password = await bcrypt.hash(assertPassword(password), 10);
    user.tokenVersion += 1;
    await user.save();
    return { id: String(user._id) };
};

/** Admin: remove a POS user for good. */
export const deletePosUser = async (id) => {
    const user = await findUser(id);
    await user.deleteOne();
    return { id: String(id) };
};

/**
 * Till sign-in. The session is the store's (role RESTAURANT, userId = the store) so every POS route
 * already works for it, but it carries posUserId so the middleware confines it to the POS and
 * checks the person is still active. It does not touch the store's own tokenVersion: signing a
 * cashier in must not sign the owner out, and two cashiers can be signed in together.
 */
export const posUserLogin = async (username, password) => {
    const uname = clean(username).toLowerCase();
    const pass = String(password ?? '');
    if (!uname || !pass) throw new ValidationError('Username and password are required');

    const user = await FoodPosUser.findOne({ username: uname });
    // Same message for "no such user" and "wrong password" so usernames cannot be probed.
    const ok = user ? await bcrypt.compare(pass, user.password) : false;
    if (!user || !ok) throw new AuthError('Invalid username or password');
    if (user.isActive === false) throw new AuthError('This POS account is inactive. Please contact your admin.');

    const store = await FoodRestaurant.findById(user.restaurantId);
    if (!store) throw new AuthError('The store for this account no longer exists');
    if (store.status && store.status !== 'approved') throw new AuthError('This store is not approved yet');

    const payload = {
        userId: String(store._id),
        role: 'RESTAURANT',
        posUserId: String(user._id),
        posTokenVersion: user.tokenVersion || 0,
    };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);
    await FoodRefreshToken.create({
        userId: store._id,
        token: refreshToken,
        expiresAt: new Date(Date.now() + ms(config.jwtRefreshExpiresIn || '7d')),
    });

    user.lastLoginAt = new Date();
    await user.save();

    return {
        accessToken,
        refreshToken,
        user: store,
        posUser: { id: String(user._id), name: user.name, username: user.username },
    };
};
