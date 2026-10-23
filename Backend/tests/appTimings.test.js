import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, expectError, resetDb, someId } from './helpers/db.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { FoodUser } from '../src/core/users/user.model.js';
import {
    POS_ONLINE_WINDOW_MS,
    getAppStatus,
    getPosPresence,
    isWithinWindow,
    normalizeAppTimings,
    toMinutes
} from '../src/modules/food/restaurant/helpers/appStatus.helper.js';
import { getRestaurantAvailabilityStatus } from '../src/modules/food/restaurant/helpers/restaurantAvailability.helper.js';
import { listAppTimings, saveAppTimings } from '../src/modules/food/admin/services/appTimings.service.js';
import { getStoreAppStatus, recordPosHeartbeat } from '../src/modules/food/restaurant/services/appStatus.service.js';
import {
    assertRestaurantOpenForOrdering,
    calculateOrderPricing,
    loadRestaurantForOrdering
} from '../src/modules/food/orders/services/order-pricing.service.js';

/**
 * Admin > App timings & store status.
 *
 * The store's own outlet timings and pause switch stay in force; the admin's settings sit on top:
 * a window, "force open / closed", an instant-delivery switch and window, and (per store) a
 * requirement that the till is online. A store the admin has never configured must behave exactly
 * as it did before.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

/** A wall-clock time today in India, where the platform runs. */
const ist = (hhmm) => new Date(`2026-10-22T${hhmm}:00+05:30`);
const NOON = ist('12:00');
const secondsBefore = (now, s) => new Date(now.getTime() - s * 1000);

// A seller schedule that is open all day, and one that is shut at noon.
const OPEN_ALL_DAY = { openingTime: '00:00', closingTime: '23:59' };
const SHUT_AT_NOON = { openingTime: '01:00', closingTime: '02:00' };

describe('time windows', () => {
    it('reads HH:mm and nothing else', () => {
        assert.equal(toMinutes('06:00'), 360);
        assert.equal(toMinutes('23:59'), 1439);
        for (const bad of ['6:00', '24:00', '12:60', '', null, undefined, '6am']) assert.equal(toMinutes(bad), null, String(bad));
    });

    it('is inside a window from its start up to, not including, its end', () => {
        assert.equal(isWithinWindow(360, '06:00', '22:00'), true);
        assert.equal(isWithinWindow(1319, '06:00', '22:00'), true);
        assert.equal(isWithinWindow(1320, '06:00', '22:00'), false);
        assert.equal(isWithinWindow(359, '06:00', '22:00'), false);
    });

    it('runs a window that ends before it starts overnight', () => {
        assert.equal(isWithinWindow(23 * 60, '22:00', '02:00'), true);
        assert.equal(isWithinWindow(60, '22:00', '02:00'), true);
        assert.equal(isWithinWindow(12 * 60, '22:00', '02:00'), false);
    });

    it('treats equal ends as all day and a missing end as no window', () => {
        assert.equal(isWithinWindow(12 * 60, '06:00', '06:00'), true);
        assert.equal(isWithinWindow(12 * 60, '', ''), true);
        assert.equal(isWithinWindow(12 * 60, '06:00', ''), true);
    });
});

describe('normalizing the saved settings', () => {
    it('fills every field and drops anything invalid', () => {
        const c = normalizeAppTimings({ customerMode: 'nonsense', openTime: '9am', instantMode: 'on', requirePosOnline: 'yes' });
        assert.equal(c.customerMode, 'follow');
        assert.equal(c.openTime, '');
        assert.equal(c.instantMode, 'on');
        assert.equal(c.requirePosOnline, false, 'only a real true counts');
        assert.deepEqual(normalizeAppTimings(undefined).customerMode, 'follow');
    });
});

describe('the till being online', () => {
    it('is online if it checked in within the last minute', () => {
        const p = getPosPresence({ posLastSeenAt: secondsBefore(NOON, 11) }, NOON);
        assert.equal(p.online, true);
        assert.equal(p.secondsAgo, 11);
    });

    it('is offline once it has been silent longer than the window', () => {
        const justOver = new Date(NOON.getTime() - POS_ONLINE_WINDOW_MS - 1000);
        assert.equal(getPosPresence({ posLastSeenAt: justOver }, NOON).online, false);
    });

    it('is offline, with no last-seen time, for a till that never checked in', () => {
        assert.deepEqual(getPosPresence({}, NOON), { online: false, lastSeenAt: null, secondsAgo: null });
    });
});

describe('the admin side of the verdict', () => {
    it('leaves a store nobody configured open, with instant on', () => {
        const s = getAppStatus({}, NOON);
        assert.equal(s.customerOpen, true);
        assert.equal(s.instantLive, true);
        assert.equal(s.reason, 'open');
    });

    it('closes a store forced closed', () => {
        const s = getAppStatus({ appTimings: { customerMode: 'closed' } }, NOON);
        assert.equal(s.customerOpen, false);
        assert.equal(s.reason, 'app-forced-closed');
    });

    it('follows the admin window', () => {
        const store = { appTimings: { customerMode: 'follow', openTime: '06:00', closeTime: '22:00' } };
        assert.equal(getAppStatus(store, ist('09:00')).customerOpen, true);
        const late = getAppStatus(store, ist('23:00'));
        assert.equal(late.customerOpen, false);
        assert.equal(late.reason, 'app-outside-hours');
    });

    it('ignores the window when forced open', () => {
        const store = { appTimings: { customerMode: 'open', openTime: '06:00', closeTime: '07:00' } };
        assert.equal(getAppStatus(store, NOON).customerOpen, true);
    });

    it('needs the till online only when the store says so', () => {
        const off = { appTimings: { requirePosOnline: false } };
        assert.equal(getAppStatus(off, NOON).customerOpen, true, 'not required: a silent till does not matter');

        const required = { appTimings: { requirePosOnline: true } };
        const down = getAppStatus(required, NOON);
        assert.equal(down.customerOpen, false);
        assert.equal(down.reason, 'pos-offline');

        const up = getAppStatus({ ...required, posLastSeenAt: secondsBefore(NOON, 5) }, NOON);
        assert.equal(up.customerOpen, true);
    });

    it('forced open still needs the till when the store requires it', () => {
        const s = getAppStatus({ appTimings: { customerMode: 'open', requirePosOnline: true } }, NOON);
        assert.equal(s.customerOpen, false);
        assert.equal(s.reason, 'pos-offline');
    });

    it('has instant delivery on, off, or following its own window', () => {
        assert.equal(getAppStatus({ appTimings: { instantMode: 'on' } }, NOON).instantLive, true);
        assert.equal(getAppStatus({ appTimings: { instantMode: 'off' } }, NOON).instantLive, false);
        const follow = { appTimings: { instantMode: 'follow', instantFrom: '07:00', instantTo: '21:00' } };
        assert.equal(getAppStatus(follow, ist('08:00')).instantLive, true);
        assert.equal(getAppStatus(follow, ist('21:30')).instantLive, false);
    });

    it('never has instant delivery while the app itself is closed', () => {
        const s = getAppStatus({ appTimings: { customerMode: 'closed', instantMode: 'on' } }, NOON);
        assert.equal(s.instantLive, false);
    });
});

describe('combined with the seller\'s own schedule and pause', () => {
    it('does not change a store the admin never configured', () => {
        const open = getRestaurantAvailabilityStatus({ ...OPEN_ALL_DAY }, NOON);
        const shut = getRestaurantAvailabilityStatus({ ...SHUT_AT_NOON }, NOON);
        assert.equal(open.isOpen, true);
        assert.equal(shut.isOpen, false);
        assert.equal(shut.reason, 'outside-hours');
    });

    it('needs both the seller\'s hours and the admin window when following', () => {
        const window = { customerMode: 'follow', openTime: '06:00', closeTime: '22:00' };
        assert.equal(getRestaurantAvailabilityStatus({ ...OPEN_ALL_DAY, appTimings: window }, NOON).isOpen, true);
        // seller closed, admin window open
        assert.equal(getRestaurantAvailabilityStatus({ ...SHUT_AT_NOON, appTimings: window }, NOON).isOpen, false);
        // seller open, admin window closed
        const late = getRestaurantAvailabilityStatus({ ...OPEN_ALL_DAY, appTimings: window }, ist('23:00'));
        assert.equal(late.isOpen, false);
        assert.equal(late.reason, 'app-outside-hours');
    });

    it('lets "force open" override the seller\'s schedule', () => {
        const a = getRestaurantAvailabilityStatus({ ...SHUT_AT_NOON, appTimings: { customerMode: 'open' } }, NOON);
        assert.equal(a.isOpen, true);
        assert.equal(a.reason, 'open');
    });

    it('does not let "force open" override a seller\'s pause or a deactivated store', () => {
        const paused = getRestaurantAvailabilityStatus({ ...OPEN_ALL_DAY, isAcceptingOrders: false, appTimings: { customerMode: 'open' } }, NOON);
        assert.equal(paused.isOpen, false);
        assert.equal(paused.reason, 'not-accepting-orders');

        const inactive = getRestaurantAvailabilityStatus({ ...OPEN_ALL_DAY, isActive: false, appTimings: { customerMode: 'open' } }, NOON);
        assert.equal(inactive.isOpen, false);
        assert.equal(inactive.reason, 'inactive');
    });

    it('closes a forced-closed store even though the seller is open', () => {
        const a = getRestaurantAvailabilityStatus({ ...OPEN_ALL_DAY, appTimings: { customerMode: 'closed' } }, NOON);
        assert.equal(a.isOpen, false);
        assert.equal(a.reason, 'app-forced-closed');
    });

    it('gives instant delivery its own verdict on top of being open', () => {
        const base = { ...OPEN_ALL_DAY };
        assert.equal(getRestaurantAvailabilityStatus({ ...base, appTimings: { instantMode: 'off' } }, NOON).instantLive, false);
        assert.equal(getRestaurantAvailabilityStatus({ ...base, appTimings: { instantMode: 'on' } }, NOON).instantLive, true);
        assert.equal(getRestaurantAvailabilityStatus({ ...SHUT_AT_NOON, appTimings: { instantMode: 'on' } }, NOON).instantLive, false, 'a closed store has no instant');
    });
});

const makeStore = (over = {}) =>
    FoodRestaurant.create({
        restaurantName: 'Vijay Nagar Store',
        ownerName: 'Owner',
        ownerPhone: '9000011111',
        phone: '9000011111',
        status: 'approved',
        ...OPEN_ALL_DAY,
        location: { type: 'Point', coordinates: [77.59, 12.97] },
        ...over
    });

describe('the till checking in', () => {
    it('stamps the store, which makes it online', async () => {
        const store = await makeStore();
        const before = await FoodRestaurant.findById(store._id).lean();
        assert.equal(before.posLastSeenAt, null);

        const res = await recordPosHeartbeat(store._id);
        assert.equal(res.ok, true);

        const after = await FoodRestaurant.findById(store._id).lean();
        assert.equal(getPosPresence(after).online, true);
    });

    it('rejects a store that does not exist', async () => {
        await expectError(() => recordPosHeartbeat(String(someId())), 'Store not found', assert);
        await expectError(() => recordPosHeartbeat('nope'), 'Store not found', assert);
    });
});

describe('saving the admin\'s settings', () => {
    it('stores what was sent and reads it back', async () => {
        const store = await makeStore();
        const row = await saveAppTimings(store._id, {
            customerMode: 'follow',
            openTime: '06:30',
            closeTime: '21:30',
            instantMode: 'off',
            instantFrom: '08:00',
            instantTo: '20:00',
            closedMessage: '  Closed for stock count. Back at 4 pm.  ',
            requirePosOnline: true
        });
        assert.equal(row.config.openTime, '06:30');
        assert.equal(row.config.closeTime, '21:30');
        assert.equal(row.config.instantMode, 'off');
        assert.equal(row.config.closedMessage, 'Closed for stock count. Back at 4 pm.');
        assert.equal(row.config.requirePosOnline, true);
        assert.equal(row.configured, true);

        const saved = await FoodRestaurant.findById(store._id).lean();
        assert.equal(saved.appTimings.customerMode, 'follow');
        assert.ok(saved.appTimings.updatedAt);
    });

    it('changes only the fields that are sent', async () => {
        const store = await makeStore();
        await saveAppTimings(store._id, { openTime: '06:00', closeTime: '22:00', closedMessage: 'Back soon' });
        await saveAppTimings(store._id, { instantMode: 'on' });
        const saved = await FoodRestaurant.findById(store._id).lean();
        assert.equal(saved.appTimings.instantMode, 'on');
        assert.equal(saved.appTimings.openTime, '06:00');
        assert.equal(saved.appTimings.closedMessage, 'Back soon');
    });

    it('clears a window by sending both ends empty', async () => {
        const store = await makeStore();
        await saveAppTimings(store._id, { openTime: '06:00', closeTime: '22:00' });
        await saveAppTimings(store._id, { openTime: '', closeTime: '' });
        const saved = await FoodRestaurant.findById(store._id).lean();
        assert.equal(saved.appTimings.openTime, '');
        assert.equal(getAppStatus(saved, ist('23:30')).customerOpen, true, 'no window left, so no restriction');
    });

    it('rejects values that are not valid', async () => {
        const store = await makeStore();
        await expectError(() => saveAppTimings(store._id, { customerMode: 'maybe' }), 'follow, open or closed', assert);
        await expectError(() => saveAppTimings(store._id, { instantMode: 'sometimes' }), 'follow, on or off', assert);
        await expectError(() => saveAppTimings(store._id, { openTime: '6am', closeTime: '22:00' }), 'Open time', assert);
        await expectError(() => saveAppTimings(store._id, { openTime: '06:00' }), 'both', assert);
        await expectError(() => saveAppTimings(store._id, { instantFrom: '07:00' }), 'both', assert);
        await expectError(() => saveAppTimings(store._id, { closedMessage: 'x'.repeat(281) }), 'at most 280', assert);
        await expectError(() => saveAppTimings(store._id, { requirePosOnline: 'true' }), 'true or false', assert);
        const saved = await FoodRestaurant.findById(store._id).lean();
        assert.equal(saved.appTimings?.updatedAt ?? null, null, 'a rejected save changes nothing');
    });

    it('refuses a store that is missing or not approved', async () => {
        await expectError(() => saveAppTimings(String(someId()), {}), 'Store not found', assert);
        const pending = await makeStore({ status: 'pending', ownerPhone: '9000022222', phone: '9000022222' });
        await expectError(() => saveAppTimings(pending._id, {}), 'Store not found', assert);
        await expectError(() => saveAppTimings('bad-id', {}), 'Invalid store', assert);
    });
});

describe('the admin list', () => {
    it('shows each approved store with its live status', async () => {
        const zone = await FoodZone.create({
            name: 'South',
            coordinates: [
                { latitude: 12.9, longitude: 77.5 },
                { latitude: 12.9, longitude: 77.7 },
                { latitude: 13.05, longitude: 77.7 }
            ]
        });
        const a = await makeStore({ zoneId: zone._id });
        const b = await makeStore({ restaurantName: 'Palasia Store', ownerPhone: '9000033333', phone: '9000033333' });
        await makeStore({ restaurantName: 'Pending Store', status: 'pending', ownerPhone: '9000044444', phone: '9000044444' });
        await recordPosHeartbeat(a._id);
        await saveAppTimings(b._id, { customerMode: 'closed' });

        const { stores, total, summary } = await listAppTimings();
        assert.equal(total, 2, 'only approved stores');
        assert.deepEqual(stores.map((s) => s.name), ['Palasia Store', 'Vijay Nagar Store']);

        const palasia = stores[0];
        assert.equal(palasia.pos.online, false);
        assert.equal(palasia.customerOpen, false);
        assert.equal(palasia.reason, 'app-forced-closed');
        assert.equal(palasia.instantLive, false);

        const vijay = stores[1];
        assert.equal(vijay.pos.online, true);
        assert.equal(vijay.customerOpen, true);
        assert.equal(vijay.zoneName, 'South');

        assert.equal(summary.posOnline, 1);
        assert.equal(summary.customerOpen, 1);
    });

    it('suggests the usual windows for a store nobody has configured, without enforcing them', async () => {
        const store = await makeStore();
        const { stores } = await listAppTimings();
        assert.equal(stores[0].configured, false);
        assert.deepEqual(
            [stores[0].config.openTime, stores[0].config.closeTime, stores[0].config.instantFrom, stores[0].config.instantTo],
            ['06:00', '22:00', '07:00', '21:00']
        );
        const saved = await FoodRestaurant.findById(store._id).lean();
        assert.equal(saved.appTimings?.openTime ?? '', '', 'nothing was written by looking');
    });

    it('filters by name and by zone, and rejects a bad zone id', async () => {
        await makeStore();
        await makeStore({ restaurantName: 'Palasia Store', ownerPhone: '9000033333', phone: '9000033333' });
        assert.equal((await listAppTimings({ search: 'palasia' })).total, 1);
        assert.equal((await listAppTimings({ search: 'zzz' })).total, 0);
        assert.equal((await listAppTimings({ search: '(' })).total, 0, 'a regex character is just text');
        await expectError(() => listAppTimings({ zoneId: 'nope' }), 'Invalid zone', assert);
    });

    it('pages through the stores', async () => {
        for (let i = 0; i < 5; i += 1) {
            await makeStore({ restaurantName: `Store ${i}`, ownerPhone: `90000555${i}0`, phone: `90000555${i}0` });
        }
        const first = await listAppTimings({ limit: 2, page: 1 });
        const last = await listAppTimings({ limit: 2, page: 3 });
        assert.equal(first.stores.length, 2);
        assert.equal(last.stores.length, 1);
        assert.equal(first.total, 5);
    });
});

describe('what the customer app is told', () => {
    it('says open for an unconfigured store', async () => {
        const store = await makeStore();
        const s = await getStoreAppStatus(String(store._id), NOON);
        assert.deepEqual([s.open, s.message, s.instantLive], [true, '', true]);
    });

    it('gives the admin\'s message when the store is closed', async () => {
        const store = await makeStore();
        await saveAppTimings(store._id, { customerMode: 'closed', closedMessage: 'Closed for stock count. Back at 4 pm.' });
        const s = await getStoreAppStatus(String(store._id), NOON);
        assert.equal(s.open, false);
        assert.equal(s.reason, 'app-forced-closed');
        assert.equal(s.message, 'Closed for stock count. Back at 4 pm.');
        assert.equal(s.instantLive, false);
    });

    it('gives a plain sentence when the admin wrote no message', async () => {
        const store = await makeStore();
        await saveAppTimings(store._id, { customerMode: 'closed' });
        const s = await getStoreAppStatus(String(store._id), NOON);
        assert.match(s.message, /closed/i);
    });

    it('follows the till going on and off line', async () => {
        const store = await makeStore();
        await saveAppTimings(store._id, { requirePosOnline: true });
        assert.equal((await getStoreAppStatus(String(store._id))).open, false);
        await recordPosHeartbeat(store._id);
        assert.equal((await getStoreAppStatus(String(store._id))).open, true);
        await FoodRestaurant.updateOne({ _id: store._id }, { $set: { posLastSeenAt: new Date(Date.now() - 5 * 60 * 1000) } });
        const gone = await getStoreAppStatus(String(store._id));
        assert.equal(gone.open, false);
        assert.equal(gone.reason, 'pos-offline');
    });

    it('does not report a store that is not approved', async () => {
        const pending = await makeStore({ status: 'pending' });
        await expectError(() => getStoreAppStatus(String(pending._id)), 'not available', assert);
    });
});

describe('at checkout', () => {
    it('loads the settings the check needs (a field missing from the select reads as unset)', async () => {
        const store = await makeStore();
        await saveAppTimings(store._id, { customerMode: 'closed', closedMessage: 'Back at 4 pm.' });
        await recordPosHeartbeat(store._id);
        const loaded = await loadRestaurantForOrdering(String(store._id));
        assert.equal(loaded.appTimings.customerMode, 'closed');
        assert.ok(loaded.posLastSeenAt);
    });

    it('refuses an order from a closed store with the admin\'s message', async () => {
        const store = await makeStore();
        await saveAppTimings(store._id, { customerMode: 'closed', closedMessage: 'Back at 4 pm.' });
        const loaded = await loadRestaurantForOrdering(String(store._id));
        assert.throws(() => assertRestaurantOpenForOrdering(loaded, NOON), /Back at 4 pm\./);
    });

    it('refuses an order when a required till is offline', async () => {
        const store = await makeStore();
        await saveAppTimings(store._id, { requirePosOnline: true });
        const loaded = await loadRestaurantForOrdering(String(store._id));
        assert.throws(() => assertRestaurantOpenForOrdering(loaded, NOON), /not taking orders/i);
    });

    describe('pricing an order', () => {
        const ZONE = [
            { latitude: 12.9, longitude: 77.5 },
            { latitude: 12.9, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.5 }
        ];
        const setup = async (appTimings) => {
            const zone = await FoodZone.create({ name: 'Test Zone', coordinates: ZONE });
            const store = await makeStore({ zoneId: zone._id, ...(appTimings ? { appTimings } : {}) });
            const item = await FoodItem.create({ restaurantId: store._id, name: 'Milk', price: 50, stockQty: 20, gstRate: 0 });
            const user = await FoodUser.create({ phone: '9111111111', name: 'Buyer' });
            const dto = (extra = {}) => ({
                restaurantId: String(store._id),
                items: [{ itemId: String(item._id), quantity: 1 }],
                deliveryAddress: { street: '1 Road', city: 'Bengaluru', state: 'KA', location: { type: 'Point', coordinates: [77.595, 12.975] } },
                ...extra
            });
            return { store, user, dto };
        };

        it('prices a normal order and an instant one when instant is allowed', async () => {
            const { user, dto } = await setup();
            const basic = await calculateOrderPricing(String(user._id), dto({ deliveryMode: 'basic' }));
            assert.ok(basic.pricing.total > 0);
            const quick = await calculateOrderPricing(String(user._id), dto({ deliveryMode: 'quick' }));
            assert.equal(quick.pricing.deliveryMode, 'quick');
        });

        it('refuses instant delivery when the admin switched it off, but still prices a standard order', async () => {
            const { user, dto } = await setup({ instantMode: 'off' });
            await expectError(() => calculateOrderPricing(String(user._id), dto({ deliveryMode: 'quick' })), 'Instant delivery is not available', assert);
            const basic = await calculateOrderPricing(String(user._id), dto({ deliveryMode: 'basic' }));
            assert.ok(basic.pricing.total > 0);
        });

        it('refuses any order from a store the admin closed', async () => {
            const { user, dto } = await setup({ customerMode: 'closed', closedMessage: 'Closed for stock count.' });
            await expectError(() => calculateOrderPricing(String(user._id), dto({ deliveryMode: 'basic' })), 'Closed for stock count.', assert);
        });

        it('skips the check for the counter, which is not a customer-app order', async () => {
            const { store, user, dto } = await setup({ customerMode: 'closed' });
            const priced = await calculateOrderPricing(String(user._id), dto(), { skipAvailabilityCheck: true });
            assert.ok(priced.pricing.total > 0);
            assert.ok(store);
        });
    });
});
