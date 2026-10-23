import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodLoginAudit } from '../src/core/auth/loginAudit.model.js';
import * as pos from '../src/modules/food/restaurant/services/pos.service.js';
import { createPosUser, listPosUsers } from '../src/core/pos/posUser.service.js';
import { getPosUserActivity, resolveRange } from '../src/core/pos/posUserActivity.service.js';

/**
 * Admin > POS users > activity: every bill, register and cash movement is pinned on the cashier who
 * did it, and the admin screen adds it up. The owner's own work carries no cashier and is not counted.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const makeShop = async () => {
    await FoodZone.create({
        name: 'Test Zone',
        coordinates: [
            { latitude: 12.9, longitude: 77.5 },
            { latitude: 12.9, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.5 }
        ]
    });
    return FoodRestaurant.create({
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
};

const setup = async () => {
    const shop = await makeShop();
    const milk = await FoodItem.create({ restaurantId: shop._id, name: 'Milk', price: 50, stockQty: 50, gstRate: 0 });
    const asha = await createPosUser({ restaurantId: String(shop._id), name: 'Asha', username: 'asha', password: 'secret123' });
    const ravi = await createPosUser({ restaurantId: String(shop._id), name: 'Ravi', username: 'ravi', password: 'secret123' });
    const as = (u) => ({ id: u.id, name: u.name });
    const sell = (actor, qty = 1, extra = {}) =>
        pos.createPosOrder(shop._id, {
            items: [{ itemId: String(milk._id), quantity: qty }],
            paymentMode: 'cash',
            ...(actor ? { _actor: as(actor) } : {}),
            ...extra
        });
    return { shop, milk, asha, ravi, as, sell };
};

describe('bills are pinned on the cashier', () => {
    it('stamps the order with who rang it up, and leaves the owner bills unstamped', async () => {
        const { asha, sell } = await setup();
        const mine = await sell(asha);
        const owners = await sell(null);
        const a = await FoodOrder.findById(mine.order._id).lean();
        const b = await FoodOrder.findById(owners.order._id).lean();
        assert.equal(String(a.pos.posUserId), asha.id);
        assert.equal(a.pos.cashierName, 'Asha');
        assert.equal(b.pos.posUserId, undefined);
    });

    it('adds up bills, sales and the tender mix per cashier', async () => {
        const { asha, ravi, sell } = await setup();
        await sell(asha, 2); // 100
        await sell(asha, 1); // 50
        await sell(ravi, 3); // 150
        await sell(null, 9); // the owner: nobody's

        const a = await getPosUserActivity(asha.id);
        assert.equal(a.stats.bills, 2);
        assert.equal(a.stats.sales, 150);
        assert.equal(a.stats.avgBill, 75);
        assert.equal(a.stats.byMode.cash, 150);
        assert.equal(a.bills.length, 2);
        assert.equal(a.bills[0].total, 50, 'newest first');
        const r = await getPosUserActivity(ravi.id);
        assert.equal(r.stats.sales, 150);
    });

    it('does not count a cancelled bill as a sale, but does count it as cancelled', async () => {
        const { asha, sell } = await setup();
        const one = await sell(asha, 2);
        await sell(asha, 1);
        await FoodOrder.updateOne({ _id: one.order._id }, { orderStatus: 'cancelled_by_restaurant' });
        const a = await getPosUserActivity(asha.id);
        assert.equal(a.stats.bills, 1);
        assert.equal(a.stats.cancelled, 1);
        assert.equal(a.stats.sales, 50);
    });
});

describe('registers and cash', () => {
    it('records who opened and closed a register, and every pay-in and pay-out', async () => {
        const { shop, asha, ravi, as } = await setup();
        const opened = await pos.openShift(shop._id, { openingCash: 500, _actor: as(asha) });
        assert.equal(opened.shift.cashierName, 'Asha', 'the login is the cashier; no typed name needed');
        await pos.recordCashMovement(shop._id, { type: 'in', amount: 200, _actor: as(asha) });
        await pos.recordCashMovement(shop._id, { type: 'out', amount: 50, _actor: as(ravi) });
        await pos.closeShift(shop._id, { countedCash: 650, _actor: as(ravi) });

        const a = await getPosUserActivity(asha.id);
        assert.equal(a.shifts.length, 1);
        assert.deepEqual(a.shifts[0].role, ['opened']);
        assert.deepEqual(a.movements.map((m) => [m.type, m.amount]), [['in', 200]]);

        const r = await getPosUserActivity(ravi.id);
        assert.deepEqual(r.shifts[0].role, ['closed']);
        assert.equal(r.shifts[0].difference, 0);
        assert.deepEqual(r.movements.map((m) => [m.type, m.amount]), [['out', 50]]);
    });

    it('keeps the typed cashier name when no cashier login is involved', async () => {
        const { shop } = await setup();
        const { shift } = await pos.openShift(shop._id, { openingCash: 0, cashierName: 'Owner Raj' });
        assert.equal(shift.cashierName, 'Owner Raj');
        assert.equal(shift.openedByPosUserId, undefined);
    });
});

describe('the list and the range', () => {
    it('shows todays bills and sales, an open register, and last activity', async () => {
        const { shop, asha, ravi, as, sell } = await setup();
        await sell(asha, 2);
        await pos.openShift(shop._id, { openingCash: 0, _actor: as(asha) });
        await FoodLoginAudit.create({ userId: ravi.id, role: 'POS', name: 'Ravi' });

        const { users } = await listPosUsers({});
        const a = users.find((u) => u.username === 'asha');
        const r = users.find((u) => u.username === 'ravi');
        assert.deepEqual(a.today, { bills: 1, sales: 100 });
        assert.equal(a.registerOpen, true);
        assert.ok(a.lastActiveAt);
        assert.deepEqual(r.today, { bills: 0, sales: 0 });
        assert.equal(r.registerOpen, false);
        assert.ok(r.lastActiveAt, 'a sign-in counts as activity');
    });

    it('lists recent sign-ins', async () => {
        const { asha } = await setup();
        await FoodLoginAudit.create({ userId: asha.id, role: 'POS', name: 'Asha', systemDetails: 'Desktop Win11 Chrome' });
        const a = await getPosUserActivity(asha.id);
        assert.equal(a.logins[0].system, 'Desktop Win11 Chrome');
    });

    it('only counts bills inside the range, and rejects a bad one', async () => {
        const { asha, sell } = await setup();
        const old = await sell(asha);
        await FoodOrder.collection.updateOne({ _id: old.order._id }, { $set: { createdAt: new Date('2026-01-05T10:00:00Z') } });
        await sell(asha);
        assert.equal((await getPosUserActivity(asha.id)).stats.bills, 1);
        const wide = await getPosUserActivity(asha.id, { from: '2026-01-01', to: new Date().toISOString() });
        assert.equal(wide.stats.bills, 2);
        assert.throws(() => resolveRange({ from: 'nope' }), /Invalid date range/);
        assert.throws(() => resolveRange({ from: '2026-02-02', to: '2026-02-01' }), /after the start/);
        await assert.rejects(getPosUserActivity('bad'), /invalid/);
    });
});
