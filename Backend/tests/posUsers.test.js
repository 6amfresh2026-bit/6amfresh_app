import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodPosUser } from '../src/core/pos/posUser.model.js';
import {
    createPosUser,
    deletePosUser,
    listPosUsers,
    posUserLogin,
    resetPosUserPassword,
    updatePosUser
} from '../src/core/pos/posUser.service.js';
import { authMiddleware, isPosSessionAllowed } from '../src/core/auth/auth.middleware.js';
import { refreshAccessToken } from '../src/core/auth/auth.service.js';
import { verifyAccessToken } from '../src/core/auth/token.util.js';

/**
 * Admin > POS users: the usernames and passwords cashiers sign in to the till with.
 * The session they get is the store's, so it must be confined to the POS and must not touch the
 * owner's own single-device session.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

/** The promise must reject with a message matching the pattern. */
const fails = (promise, pattern) => assert.rejects(promise, { message: pattern });

const makeStore = (over = {}) =>
    FoodRestaurant.create({
        restaurantName: 'Demo Store',
        ownerName: 'Owner',
        ownerPhone: '9876500001',
        status: 'approved',
        ...over
    });

const valid = (store, over = {}) => ({
    restaurantId: String(store._id),
    name: 'Asha Kumar',
    username: 'asha.k',
    password: 'secret123',
    ...over
});

/** Runs the real middleware against a fake request and says how it ended. */
const callMiddleware = (token, { method = 'GET', url = '/api/v1/food/restaurant/pos/orders' } = {}) =>
    new Promise((resolve) => {
        const req = { headers: { authorization: `Bearer ${token}` }, method, originalUrl: url };
        const res = {
            status(code) {
                this.code = code;
                return this;
            },
            json(body) {
                resolve({ code: this.code, body, req });
            }
        };
        authMiddleware(req, res, () => resolve({ code: 200, req }));
    });

describe('creating POS users', () => {
    it('creates one for a store, with the username lower-cased and no password in the answer', async () => {
        const store = await makeStore();
        const user = await createPosUser(valid(store, { username: 'Asha.K' }));
        assert.equal(user.username, 'asha.k');
        assert.equal(user.restaurantName, 'Demo Store');
        assert.equal(user.isActive, true);
        assert.equal('password' in user, false);
        const stored = await FoodPosUser.findById(user.id).lean();
        assert.notEqual(stored.password, 'secret123');
    });

    it('rejects a bad username, a short password, a missing name and an unknown store', async () => {
        const store = await makeStore();
        await fails(createPosUser(valid(store, { username: 'a b' })), /Username must be/);
        await fails(createPosUser(valid(store, { username: 'ab' })), /Username must be/);
        await fails(createPosUser(valid(store, { password: '123' })), /at least 6/);
        await fails(createPosUser(valid(store, { name: '  ' })), /Name is required/);
        await fails(createPosUser(valid(store, { restaurantId: String(someId()) })), /Store not found/);
        await fails(createPosUser(valid(store, { restaurantId: 'nope' })), /Store is invalid/);
    });

    it('keeps usernames unique across stores', async () => {
        const a = await makeStore();
        const b = await makeStore({ restaurantName: 'Other', ownerPhone: '9876500002' });
        await createPosUser(valid(a));
        await fails(createPosUser(valid(b, { username: 'ASHA.K' })), /already taken/);
    });
});

describe('listing, editing and removing', () => {
    it('lists newest first, filters by store and search, and counts active', async () => {
        const a = await makeStore();
        const b = await makeStore({ restaurantName: 'Other', ownerPhone: '9876500002' });
        await createPosUser(valid(a));
        const second = await createPosUser(valid(b, { name: 'Ravi', username: 'ravi' }));
        await updatePosUser(second.id, { isActive: false });

        const all = await listPosUsers({});
        assert.equal(all.total, 2);
        assert.deepEqual(all.summary, { total: 2, active: 1, inactive: 1 });
        assert.equal(all.users[0].username, 'ravi');
        assert.equal((await listPosUsers({ restaurantId: String(a._id) })).total, 1);
        assert.equal((await listPosUsers({ search: 'rav' })).users[0].name, 'Ravi');
        assert.equal((await listPosUsers({ search: '(' })).total, 0);
    });

    it('edits name and phone, and refuses a non-boolean active flag', async () => {
        const store = await makeStore();
        const u = await createPosUser(valid(store));
        const edited = await updatePosUser(u.id, { name: 'Asha K', phone: '9000000000' });
        assert.equal(edited.name, 'Asha K');
        assert.equal(edited.phone, '9000000000');
        await fails(updatePosUser(u.id, { isActive: 'no' }), /true or false/);
        await fails(updatePosUser(u.id, { name: '' }), /Name is required/);
    });

    it('deletes, and then says it is gone', async () => {
        const store = await makeStore();
        const u = await createPosUser(valid(store));
        await deletePosUser(u.id);
        assert.equal(await FoodPosUser.countDocuments(), 0);
        await fails(deletePosUser(u.id), /not found/);
    });
});

describe('signing in to the till', () => {
    it('gives the store session plus the cashier, and leaves the owner session alone', async () => {
        const store = await makeStore({ tokenVersion: 4 });
        const u = await createPosUser(valid(store));
        const out = await posUserLogin('ASHA.K', 'secret123');

        const claims = verifyAccessToken(out.accessToken);
        assert.equal(claims.role, 'RESTAURANT');
        assert.equal(claims.userId, String(store._id));
        assert.equal(claims.posUserId, u.id);
        assert.equal(claims.tokenVersion, undefined);
        assert.equal(out.posUser.username, 'asha.k');
        assert.equal((await FoodRestaurant.findById(store._id).lean()).tokenVersion, 4);
        assert.ok((await FoodPosUser.findById(u.id).lean()).lastLoginAt);
    });

    it('lets two cashiers be signed in at once', async () => {
        const store = await makeStore();
        await createPosUser(valid(store));
        await createPosUser(valid(store, { name: 'Ravi', username: 'ravi' }));
        const a = await posUserLogin('asha.k', 'secret123');
        const b = await posUserLogin('ravi', 'secret123');
        assert.equal((await callMiddleware(a.accessToken)).code, 200);
        assert.equal((await callMiddleware(b.accessToken)).code, 200);
    });

    it('says the same thing for a wrong password and an unknown user', async () => {
        const store = await makeStore();
        await createPosUser(valid(store));
        await fails(posUserLogin('asha.k', 'wrong-pass'), /Invalid username or password/);
        await fails(posUserLogin('nobody', 'secret123'), /Invalid username or password/);
        await fails(posUserLogin('', ''), /required/);
    });

    it('refuses an inactive cashier and a store that is not approved', async () => {
        const store = await makeStore();
        const u = await createPosUser(valid(store));
        await updatePosUser(u.id, { isActive: false });
        await fails(posUserLogin('asha.k', 'secret123'), /inactive/);
        await updatePosUser(u.id, { isActive: true });
        await FoodRestaurant.updateOne({ _id: store._id }, { status: 'pending' });
        await fails(posUserLogin('asha.k', 'secret123'), /not approved/);
    });
});

describe('what a cashier session may do', () => {
    it('allows the till and its three reads, and nothing else', () => {
        const p = '/api/v1/food/restaurant';
        assert.equal(isPosSessionAllowed('POST', `${p}/pos/orders`), true);
        assert.equal(isPosSessionAllowed('GET', `${p}/pos/shift/current?x=1`), true);
        assert.equal(isPosSessionAllowed('GET', `${p}/menu`), true);
        assert.equal(isPosSessionAllowed('GET', `${p}/current`), true);
        assert.equal(isPosSessionAllowed('GET', `${p}/orders?limit=5`), true);
        assert.equal(isPosSessionAllowed('POST', `${p}/withdraw`), false);
        assert.equal(isPosSessionAllowed('POST', `${p}/orders`), false);
        assert.equal(isPosSessionAllowed('PUT', `${p}/profile`), false);
        assert.equal(isPosSessionAllowed('GET', `${p}/finance`), false);
        assert.equal(isPosSessionAllowed('GET', `${p}/pos-evil`), false);
        assert.equal(isPosSessionAllowed('GET', '/api/v1/food/admin/pos-users'), false);
    });

    it('is blocked outside the till by the middleware itself', async () => {
        const store = await makeStore();
        await createPosUser(valid(store));
        const { accessToken } = await posUserLogin('asha.k', 'secret123');
        assert.equal((await callMiddleware(accessToken, { url: '/api/v1/food/restaurant/pos/orders' })).code, 200);
        const blocked = await callMiddleware(accessToken, { method: 'POST', url: '/api/v1/food/restaurant/withdraw' });
        assert.equal(blocked.code, 403);
    });

    it('stops working the moment the cashier is deactivated, reset or deleted', async () => {
        const store = await makeStore();
        const u = await createPosUser(valid(store));

        let { accessToken } = await posUserLogin('asha.k', 'secret123');
        await updatePosUser(u.id, { isActive: false });
        assert.equal((await callMiddleware(accessToken)).code, 401);

        await updatePosUser(u.id, { isActive: true });
        ({ accessToken } = await posUserLogin('asha.k', 'secret123'));
        assert.equal((await callMiddleware(accessToken)).code, 200);
        await resetPosUserPassword(u.id, 'brand-new-1');
        assert.equal((await callMiddleware(accessToken)).code, 401);
        await fails(posUserLogin('asha.k', 'secret123'), /Invalid username or password/);
        ({ accessToken } = await posUserLogin('asha.k', 'brand-new-1'));
        assert.equal((await callMiddleware(accessToken)).code, 200);

        await deletePosUser(u.id);
        assert.equal((await callMiddleware(accessToken)).code, 401);
    });

    it('is not tied to the owner signing in elsewhere', async () => {
        const store = await makeStore();
        await createPosUser(valid(store));
        const { accessToken } = await posUserLogin('asha.k', 'secret123');
        await FoodRestaurant.updateOne({ _id: store._id }, { $inc: { tokenVersion: 1 } });
        assert.equal((await callMiddleware(accessToken)).code, 200);
    });
});

describe('refreshing a cashier session', () => {
    it('keeps it a cashier session and refuses once the cashier is gone', async () => {
        const store = await makeStore();
        const u = await createPosUser(valid(store));
        const { refreshToken } = await posUserLogin('asha.k', 'secret123');

        const next = await refreshAccessToken(refreshToken);
        const claims = verifyAccessToken(next.accessToken);
        assert.equal(claims.posUserId, u.id);
        assert.equal(claims.userId, String(store._id));

        await updatePosUser(u.id, { isActive: false });
        await fails(refreshAccessToken(refreshToken), /inactive/);
    });

    it('refuses after a password reset', async () => {
        const store = await makeStore();
        const u = await createPosUser(valid(store));
        const { refreshToken } = await posUserLogin('asha.k', 'secret123');
        await resetPosUserPassword(u.id, 'brand-new-1');
        await fails(refreshAccessToken(refreshToken), /signed out/);
    });
});
