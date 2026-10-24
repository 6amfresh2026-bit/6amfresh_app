import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, expectError, resetDb, someId } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodUser } from '../src/core/users/user.model.js';
import { FoodProductSubscription } from '../src/modules/food/user/models/productSubscription.model.js';
import { FoodSubscriptionOccurrence } from '../src/modules/food/user/models/subscriptionOccurrence.model.js';
import * as admin from '../src/modules/food/admin/services/productSubscriptionAdmin.service.js';
import { getCustomerAddresses } from '../src/modules/food/admin/services/admin.service.js';
import { createSlot, deactivateSlot } from '../src/modules/food/admin/services/deliverySlot.service.js';

/**
 * Admin starting a subscription for a customer who phoned the shop.
 *
 * The point of these is that the phone route and the app route stay the same
 * arrangement: the admin write delegates to the customer-facing service, so
 * every rule the app enforces has to still bite here. Each refusal below is
 * one of those rules, checked from the admin side.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const iso = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const today = () => iso(new Date());
const daysFromNow = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return iso(d);
};

const makeShop = (over = {}) =>
    FoodRestaurant.create({
        restaurantName: 'Dairy Corner',
        ownerName: 'Owner',
        ownerPhone: '9000000001',
        phone: '9000000001',
        status: 'approved',
        ...over
    });

const makeProduct = (restaurantId, over = {}) =>
    FoodItem.create({ restaurantId, name: 'Amul Gold 1L', price: 68, stockQty: 100, subscriptionEnabled: true, ...over });

const makeCustomer = async (over = {}) => {
    const { withAddress = true, ...rest } = over;
    return FoodUser.create({
        phone: '9800000001',
        name: 'Ravi Kumar',
        addresses: withAddress
            ? [{
                label: 'Home',
                flatNumber: '12B',
                street: 'MG Road',
                city: 'Bengaluru',
                state: 'Karnataka',
                zipCode: '560001',
                phone: '9800000001',
                isDefault: true,
                location: { type: 'Point', coordinates: [77.59, 12.97] }
            }]
            : [],
        ...rest
    });
};

/** The body the admin form posts. */
const body = (customer, item, over = {}) => ({
    customerId: String(customer._id),
    restaurantId: String(item.restaurantId),
    itemId: String(item._id),
    quantity: 1,
    frequency: 'daily',
    deliveryTime: '06:00',
    startDate: today(),
    addressId: String(customer.addresses[0]._id),
    paymentMethod: 'cash',
    ...over
});

describe('admin creates a subscription', () => {
    it('sets up the standing arrangement and pre-generates its deliveries', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        const { subscription } = await admin.createSubscriptionForCustomer(
            body(customer, milk, { quantity: 2, deliveryTime: '06:30' })
        );

        assert.equal(subscription.customer.name, 'Ravi Kumar');
        assert.equal(subscription.customer.phone, '9800000001');
        assert.equal(subscription.restaurantName, 'Dairy Corner');
        assert.equal(subscription.itemName, 'Amul Gold 1L', 'the name is snapshotted at signup');
        assert.equal(subscription.quantity, 2);
        assert.equal(subscription.frequency, 'daily');
        assert.equal(subscription.deliveryTime, '06:30');
        assert.equal(subscription.status, 'active');

        const saved = await FoodProductSubscription.findById(subscription.id).lean();
        assert.equal(String(saved.userId), String(customer._id), 'it belongs to the customer, not the admin');

        // A daily subscription is pre-generated over a rolling two-week horizon.
        const occurrences = await FoodSubscriptionOccurrence.find({ subscriptionId: subscription.id }).sort({ scheduledDate: 1 }).lean();
        assert.ok(occurrences.length >= 14, `expected a fortnight of deliveries, got ${occurrences.length}`);
        assert.equal(occurrences[0].status, 'scheduled');
        assert.equal(occurrences[0].deliveryTime, '06:30');
        assert.equal(String(occurrences[0].userId), String(customer._id));
    });

    it('shows up in the admin list exactly as the form left it', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();
        await admin.createSubscriptionForCustomer(body(customer, milk));

        const { subscriptions, total } = await admin.listSubscriptions({});
        assert.equal(total, 1);
        assert.equal(subscriptions[0].customer.phone, '9800000001');
        assert.equal(subscriptions[0].itemName, 'Amul Gold 1L');

        // And it is findable the way someone searches when that customer rings back.
        const byPhone = await admin.listSubscriptions({ search: '9800000001' });
        assert.equal(byPhone.total, 1);
        const byItem = await admin.listSubscriptions({ search: 'amul' });
        assert.equal(byItem.total, 1);
    });

    it('carries a weekly rule through with its days', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        const { subscription } = await admin.createSubscriptionForCustomer(
            body(customer, milk, { frequency: 'weekly', daysOfWeek: [1, 4] })
        );
        assert.deepEqual(subscription.daysOfWeek, [1, 4]);

        const occurrences = await FoodSubscriptionOccurrence.find({ subscriptionId: subscription.id }).lean();
        assert.ok(occurrences.length > 0, 'a weekly subscription still gets a schedule');
        assert.ok(
            occurrences.every((o) => [1, 4].includes(new Date(o.scheduledDate).getDay())),
            'every generated delivery falls on a chosen weekday'
        );
    });

    it('carries a monthly rule through with its day', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        const { subscription } = await admin.createSubscriptionForCustomer(
            body(customer, milk, { frequency: 'monthly', dayOfMonth: 5 })
        );
        assert.equal(subscription.dayOfMonth, 5);
        assert.deepEqual(subscription.daysOfWeek, [], 'the weekly field is cleared, not carried over');
    });
});

describe('the rules the app enforces still bite from the admin side', () => {
    it('refuses a product the seller has not made subscribable', async () => {
        const shop = await makeShop();
        const notSubscribable = await makeProduct(shop._id, { name: 'Birthday Cake', subscriptionEnabled: false });
        const customer = await makeCustomer();

        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, notSubscribable)),
            'not available for subscription',
            assert
        );
        assert.equal(await FoodProductSubscription.countDocuments({}), 0);
    });

    it('refuses a product belonging to a different shop', async () => {
        const shop = await makeShop();
        const other = await makeShop({ restaurantName: 'Other Shop', ownerPhone: '9000000002', phone: '9000000002' });
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, milk, { restaurantId: String(other._id) })),
            'does not belong to this restaurant',
            assert
        );
    });

    it('refuses an address that is not this customer\'s', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();
        const stranger = await makeCustomer({ phone: '9800000002', name: 'Someone Else' });

        await expectError(
            () => admin.createSubscriptionForCustomer(
                body(customer, milk, { addressId: String(stranger.addresses[0]._id) })
            ),
            'Saved address not found',
            assert
        );
    });

    it('refuses a start date in the past', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, milk, { startDate: daysFromNow(-1) })),
            'cannot be in the past',
            assert
        );
    });

    it('refuses a weekly rule with no days and a monthly rule with no day', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, milk, { frequency: 'weekly' })),
            'daysOfWeek is required',
            assert
        );
        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, milk, { frequency: 'monthly' })),
            'dayOfMonth is required',
            assert
        );
    });

    it('refuses a delivery time that is not HH:mm', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, milk, { deliveryTime: '6am' })),
            'HH:mm',
            assert
        );
    });
});

describe('the customer the admin names', () => {
    it('has to exist', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, milk, { customerId: String(someId()) })),
            'Customer not found',
            assert
        );
        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, milk, { customerId: 'not-an-id' })),
            'Invalid customerId',
            assert
        );
    });

    it('cannot be a deactivated account', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer({ isActive: false });

        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, milk)),
            'deactivated',
            assert
        );
    });
});

describe('the address picker', () => {
    it('lists a customer\'s addresses as one readable line each', async () => {
        const customer = await makeCustomer();
        const { customer: who, addresses } = await getCustomerAddresses(customer._id);

        assert.equal(who.name, 'Ravi Kumar');
        assert.equal(addresses.length, 1);
        assert.equal(addresses[0].label, 'Home');
        assert.equal(addresses[0].line, '12B, MG Road, Bengaluru, Karnataka, 560001');
        assert.equal(addresses[0].isDefault, true);
        assert.equal(addresses[0].hasLocation, true);
    });

    it('flags a legacy address with no coordinates, because an order cannot be written to one', async () => {
        // Such a row cannot be created through the schema any more: Mongoose
        // fills in location.type = 'Point', and the 2dsphere index rejects a
        // Point with no position. It only exists in rows written before
        // coordinates were captured, which have no location key at all — so
        // that is what the driver writes here.
        const id = someId();
        await FoodUser.collection.insertOne({
            _id: id,
            phone: '9800000003',
            name: 'No Pin',
            role: 'USER',
            isActive: true,
            addresses: [{
                _id: someId(),
                label: 'Office',
                street: 'Somewhere',
                city: 'Bengaluru',
                state: 'Karnataka',
                zipCode: '560002'
            }]
        });

        const { addresses } = await getCustomerAddresses(id);
        assert.equal(addresses[0].hasLocation, false, 'the form must be able to grey this one out');
        assert.equal(addresses[0].line, 'Somewhere, Bengaluru, Karnataka, 560002');
    });

    it('returns nothing for a customer who does not exist', async () => {
        assert.equal(await getCustomerAddresses(someId()), null);
        assert.equal(await getCustomerAddresses('not-an-id'), null);
    });
});

describe('subscribing to a delivery slot', () => {
    const makeSlot = (over = {}) =>
        createSlot({ label: 'Morning 7-8', startTime: '07:00', endTime: '08:00', ...over });

    it('takes the slot and records both its start time and its name', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();
        const { slot } = await makeSlot();

        const { subscription } = await admin.createSubscriptionForCustomer(
            body(customer, milk, { deliveryTime: undefined, deliverySlotId: slot.id })
        );

        const stored = await FoodProductSubscription.findById(subscription.id).lean();
        // deliveryTime carries the window's start, so the occurrence generator and
        // the delivery board keep reading one field whether or not slots are used.
        assert.equal(stored.deliveryTime, '07:00');
        assert.equal(stored.deliverySlot.label, 'Morning 7-8');
        assert.equal(stored.deliverySlot.endTime, '08:00');
        assert.equal(String(stored.deliverySlot.slotId), slot.id);
    });

    it('still accepts a plain time, which is what the admin form has always sent', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        const { subscription } = await admin.createSubscriptionForCustomer(
            body(customer, milk, { deliveryTime: '06:30' })
        );

        const stored = await FoodProductSubscription.findById(subscription.id).lean();
        assert.equal(stored.deliveryTime, '06:30');
        assert.equal(stored.deliverySlot?.slotId ?? null, null);
    });

    it('asks for one or the other rather than saving a delivery with no time', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();

        await expectError(
            () => admin.createSubscriptionForCustomer(body(customer, milk, { deliveryTime: undefined })),
            'delivery slot',
            assert
        );
    });

    it('refuses a slot that has been retired', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();
        const { slot } = await makeSlot();
        await deactivateSlot(slot.id);

        await expectError(
            () => admin.createSubscriptionForCustomer(
                body(customer, milk, { deliveryTime: undefined, deliverySlotId: slot.id })
            ),
            'not available',
            assert
        );
    });
});

describe('admin starts a subscription for a number that has never used the app', () => {
    const newCustomer = ({ address, ...rest } = {}) => ({
        name: 'Meena Joshi',
        phone: '98765 43210',
        address: {
            flatNumber: '4A',
            street: '5th Cross, Indiranagar',
            city: 'Bengaluru',
            state: 'Karnataka',
            zipCode: '560038',
            lat: 12.9784,
            lng: 77.6408,
            ...(address || {})
        },
        ...rest
    });

    const newBody = (item, over = {}) => ({
        restaurantId: String(item.restaurantId),
        itemId: String(item._id),
        quantity: 1,
        frequency: 'daily',
        deliveryTime: '06:00',
        startDate: today(),
        paymentMethod: 'cash',
        newCustomer: newCustomer(),
        ...over
    });

    it('creates the account and its address, and the subscription belongs to them', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);

        const { subscription } = await admin.createSubscriptionForCustomer(newBody(milk));

        const user = await FoodUser.findOne({ phone: '9876543210' }).lean();
        assert.ok(user, 'the number is stored as 10 digits, the way sign-in looks it up');
        assert.equal(user.name, 'Meena Joshi');
        assert.equal(user.addresses.length, 1);
        assert.equal(user.addresses[0].isDefault, true);
        assert.deepEqual(user.addresses[0].location.coordinates, [77.6408, 12.9784]);

        const saved = await FoodProductSubscription.findById(subscription.id).lean();
        assert.equal(String(saved.userId), String(user._id));
        assert.equal(String(saved.addressId), String(user.addresses[0]._id));
    });

    it('uses the existing account when the number is already registered, and does not duplicate the address', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer({ phone: '9876543210', name: 'Meena Joshi' });

        await admin.createSubscriptionForCustomer(newBody(milk));
        await admin.createSubscriptionForCustomer(newBody(milk, { quantity: 2 }));

        const users = await FoodUser.find({ phone: '9876543210' }).lean();
        assert.equal(users.length, 1);
        assert.equal(String(users[0]._id), String(customer._id));
        // the pre-existing Home address plus the one typed here, saved once not twice
        assert.equal(users[0].addresses.length, 2);
    });

    it('refuses a number that is not ten digits', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        await expectError(
            () => admin.createSubscriptionForCustomer(newBody(milk, { newCustomer: newCustomer({ phone: '12345' }) })),
            '10-digit',
            assert
        );
        assert.equal(await FoodUser.countDocuments({}), 0);
    });

    it('refuses an address with no map position instead of saving one that cannot be delivered to', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        await expectError(
            () => admin.createSubscriptionForCustomer(
                newBody(milk, { newCustomer: newCustomer({ address: { lat: undefined, lng: undefined } }) })
            ),
            'map',
            assert
        );
        assert.equal(await FoodUser.countDocuments({}), 0);
    });

    it('asks for a name when the number is new', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        await expectError(
            () => admin.createSubscriptionForCustomer(newBody(milk, { newCustomer: newCustomer({ name: '  ' }) })),
            'name',
            assert
        );
    });

    it('does not leave an account behind when the subscription itself is invalid', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        await expectError(
            () => admin.createSubscriptionForCustomer(newBody(milk, { deliveryTime: undefined })),
            'delivery slot',
            assert
        );
        assert.equal(await FoodUser.countDocuments({}), 0);
    });

    it('refuses a deactivated account on that number', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        await makeCustomer({ phone: '9876543210', isActive: false });
        await expectError(
            () => admin.createSubscriptionForCustomer(newBody(milk)),
            'deactivated',
            assert
        );
    });
});

describe('admin switches a subscription off and on', () => {
    const start = async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const customer = await makeCustomer();
        const { subscription } = await admin.createSubscriptionForCustomer(body(customer, milk));
        return { subscription, customer };
    };
    const scheduledAfterToday = (id) => {
        const t = new Date();
        const startOfToday = new Date(t.getFullYear(), t.getMonth(), t.getDate());
        return FoodSubscriptionOccurrence.countDocuments({
            subscriptionId: id,
            status: 'scheduled',
            scheduledDate: { $gt: startOfToday }
        });
    };

    it('pausing cancels the upcoming deliveries', async () => {
        const { subscription } = await start();
        assert.ok((await scheduledAfterToday(subscription.id)) > 0);

        const out = await admin.setSubscriptionStatus(subscription.id, 'paused');
        assert.equal(out.subscription.status, 'paused');
        assert.equal(await scheduledAfterToday(subscription.id), 0);
    });

    it('switching back on refills the days the pause emptied, from tomorrow', async () => {
        const { subscription } = await start();
        const before = await scheduledAfterToday(subscription.id);
        await admin.setSubscriptionStatus(subscription.id, 'paused');

        const out = await admin.setSubscriptionStatus(subscription.id, 'active');
        assert.equal(out.subscription.status, 'active');
        assert.equal(await scheduledAfterToday(subscription.id), before, 'the fortnight is back, not a gap');

        const t = new Date();
        const startOfToday = new Date(t.getFullYear(), t.getMonth(), t.getDate());
        const earliest = await FoodSubscriptionOccurrence.findOne({ subscriptionId: subscription.id, status: 'scheduled' })
            .sort({ scheduledDate: 1 }).lean();
        assert.ok(new Date(earliest.scheduledDate) > startOfToday, 'nothing is scheduled for a day that has already begun');
    });

    it('cancelling ends it for good', async () => {
        const { subscription } = await start();
        await admin.setSubscriptionStatus(subscription.id, 'cancelled');
        await expectError(() => admin.setSubscriptionStatus(subscription.id, 'active'), 'cancelled', assert);
    });

    it('refuses a status it does not know, and a change to the state it is already in', async () => {
        const { subscription } = await start();
        await expectError(() => admin.setSubscriptionStatus(subscription.id, 'banana'), 'status must be', assert);
        await expectError(() => admin.setSubscriptionStatus(subscription.id, 'active'), 'already active', assert);
    });

    it('reports a subscription that does not exist', async () => {
        await expectError(() => admin.setSubscriptionStatus(String(someId()), 'paused'), 'not found', assert);
    });
});
