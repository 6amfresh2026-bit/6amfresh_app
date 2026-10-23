import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import * as pos from '../src/modules/food/restaurant/services/pos.service.js';
import { createPosUser, posUserLogin, updatePosUser } from '../src/core/pos/posUser.service.js';
import {
    POS_PERMISSIONS,
    POS_PERMISSION_GROUPS,
    requirePosPermission,
    resolveLimits,
    resolvePermissions
} from '../src/core/pos/posPermissions.js';
import { authMiddleware } from '../src/core/auth/auth.middleware.js';

/**
 * Admin > POS users > Permissions: what each cashier may do at the till, and how big a bill or
 * discount they may give. A cashier with nothing saved can do everything; the store owner is never
 * limited by any of this.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const fails = (promise, pattern) => assert.rejects(promise, { message: pattern });

const setup = async () => {
    await FoodZone.create({
        name: 'Test Zone',
        coordinates: [
            { latitude: 12.9, longitude: 77.5 },
            { latitude: 12.9, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.5 }
        ]
    });
    const shop = await FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000001',
        phone: '9000000001',
        status: 'approved',
        addressLine1: '12 Market Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        location: { type: 'Point', coordinates: [77.59, 12.97] }
    });
    const milk = await FoodItem.create({ restaurantId: shop._id, name: 'Milk', price: 100, stockQty: 50, gstRate: 0 });
    const user = await createPosUser({ restaurantId: String(shop._id), name: 'Asha', username: 'asha', password: 'secret123' });
    const actorOf = (u, perms, limits) => ({
        id: u.id,
        name: u.name,
        ...(perms ? { permissions: perms, limits: limits || {} } : {})
    });
    const sell = (actor, extra = {}) =>
        pos.createPosOrder(shop._id, {
            items: [{ itemId: String(milk._id), quantity: 1 }],
            paymentMode: 'cash',
            ...(actor ? { _actor: actor } : {}),
            ...extra
        });
    return { shop, milk, user, actorOf, sell };
};

describe('the catalogue', () => {
    it('lists each permission once, in groups', () => {
        assert.equal(new Set(POS_PERMISSIONS).size, POS_PERMISSIONS.length);
        assert.equal(POS_PERMISSION_GROUPS.flatMap((g) => g.permissions).length, POS_PERMISSIONS.length);
        for (const g of POS_PERMISSION_GROUPS) assert.ok(g.label && g.permissions.length);
    });

    it('gives a user with nothing saved every permission, and no limits', () => {
        assert.deepEqual(resolvePermissions(undefined), POS_PERMISSIONS);
        assert.deepEqual(resolvePermissions(['sell', 'nonsense']), ['sell']);
        assert.deepEqual(resolvePermissions([]), []);
        assert.deepEqual(resolveLimits(undefined), { maxBillAmount: 0, maxDiscountPercent: 0 });
        assert.deepEqual(resolveLimits({ maxBillAmount: 500, maxDiscountPercent: 250 }), { maxBillAmount: 500, maxDiscountPercent: 100 });
    });
});

describe('saving permissions', () => {
    it('new users can do everything until the admin narrows it', async () => {
        const { user } = await setup();
        assert.deepEqual(user.permissions, POS_PERMISSIONS);
        assert.deepEqual(user.limits, { maxBillAmount: 0, maxDiscountPercent: 0 });
    });

    it('creates with chosen permissions and limits, and edits them later', async () => {
        const { shop } = await setup();
        const u = await createPosUser({
            restaurantId: String(shop._id),
            name: 'Ravi',
            username: 'ravi',
            password: 'secret123',
            permissions: ['sell', 'view_bills'],
            limits: { maxBillAmount: 2000, maxDiscountPercent: 10 }
        });
        assert.deepEqual(u.permissions, ['sell', 'view_bills']);
        assert.deepEqual(u.limits, { maxBillAmount: 2000, maxDiscountPercent: 10 });

        const edited = await updatePosUser(u.id, { permissions: ['sell'], limits: { maxBillAmount: 0 } });
        assert.deepEqual(edited.permissions, ['sell']);
        assert.deepEqual(edited.limits, { maxBillAmount: 0, maxDiscountPercent: 10 }, 'only the sent limit changes');
        assert.deepEqual((await updatePosUser(u.id, { permissions: [] })).permissions, [], 'none is allowed, and is not "everything"');
    });

    it('rejects unknown permissions and bad limits', async () => {
        const { user } = await setup();
        await fails(updatePosUser(user.id, { permissions: ['sell', 'fly'] }), /Unknown permission: fly/);
        await fails(updatePosUser(user.id, { permissions: 'sell' }), /must be a list/);
        await fails(updatePosUser(user.id, { limits: { maxBillAmount: -1 } }), /Bill limit/);
        await fails(updatePosUser(user.id, { limits: { maxDiscountPercent: 101 } }), /between 0 and 100/);
    });
});

describe('the route guard and the session', () => {
    const run = (req) =>
        new Promise((resolve) => {
            const res = { status(c) { this.code = c; return this; }, json() { resolve(this.code); } };
            requirePosPermission('discount')(req, res, () => resolve(200));
        });

    it('lets the owner through, blocks a cashier without it, lets one with it', async () => {
        assert.equal(await run({ user: { userId: 's1' } }), 200);
        assert.equal(await run({ user: { posUserId: 'p1', posPermissions: ['sell'] } }), 403);
        assert.equal(await run({ user: { posUserId: 'p1', posPermissions: ['sell', 'discount'] } }), 200);
    });

    it('carries the live permissions on the session, so an admin change applies at once', async () => {
        const { user } = await setup();
        const { accessToken } = await posUserLogin('asha', 'secret123');
        const seen = () =>
            new Promise((resolve) => {
                const req = { headers: { authorization: `Bearer ${accessToken}` }, method: 'GET', originalUrl: '/api/v1/food/restaurant/pos/me' };
                authMiddleware(req, { status() { return this; }, json: () => resolve(null) }, () => resolve(req.user));
            });
        assert.deepEqual((await seen()).posPermissions, POS_PERMISSIONS);
        await updatePosUser(user.id, { permissions: ['sell'], limits: { maxBillAmount: 300 } });
        const after = await seen();
        assert.deepEqual(after.posPermissions, ['sell']);
        assert.equal(after.posLimits.maxBillAmount, 300);
    });
});

describe('enforced at the till', () => {
    it('lets a full-permission cashier and the owner do anything', async () => {
        const { user, actorOf, sell } = await setup();
        await sell(actorOf(user, POS_PERMISSIONS), { flatDiscount: { type: 'percent', value: 50 } });
        await sell(null, { flatDiscount: { type: 'percent', value: 50 } });
    });

    it('refuses a discount without the permission, a percentage over the cap, and a line discount too', async () => {
        const { user, milk, actorOf, sell } = await setup();
        const noDiscount = actorOf(user, ['sell']);
        await fails(sell(noDiscount, { flatDiscount: { type: 'percent', value: 5 } }), /not allowed to give discounts/);
        await fails(
            sell(noDiscount, { items: [{ itemId: String(milk._id), quantity: 1, discount: 5 }] }),
            /not allowed to give discounts/
        );

        const capped = actorOf(user, ['sell', 'discount'], { maxDiscountPercent: 10 });
        await sell(capped, { flatDiscount: { type: 'percent', value: 10 } });
        await fails(sell(capped, { flatDiscount: { type: 'percent', value: 11 } }), /at most 10% discount/);
        await fails(sell(capped, { flatDiscount: { type: 'flat', value: 11 } }), /at most 10% discount/);
        await sell(capped, { flatDiscount: { type: 'flat', value: 10 } });
    });

    it('refuses a bill over the amount limit, and one on credit', async () => {
        const { user, actorOf, sell } = await setup();
        await fails(sell(actorOf(user, ['sell'], { maxBillAmount: 99 })), /at most ₹99/);
        await sell(actorOf(user, ['sell'], { maxBillAmount: 100 }));

        const noCredit = actorOf(user, ['sell']);
        await fails(sell(noCredit, { paymentMode: 'pay_later', customerPhone: '9876500001' }), /not allowed to sell on credit/);
    });

    it('refuses a coupon without the permission', async () => {
        const { user, actorOf, sell } = await setup();
        await fails(sell(actorOf(user, ['sell']), { couponCode: 'SAVE10' }), /not allowed to apply coupons/);
    });
});
