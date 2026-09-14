import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, resetDb, someId } from './helpers/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodTransaction } from '../src/modules/food/orders/models/foodTransaction.model.js';
import { restoreOrderStock } from '../src/modules/food/orders/services/inventory.service.js';
import { sanitizeOrderForExternal, sanitizeOrderForDeliveryPartner } from '../src/modules/food/orders/services/order.helpers.js';
import { createInitialTransaction } from '../src/modules/food/orders/services/foodTransaction.service.js';
import {
    adjustOrderFulfilment,
    listSubstitutesForItem,
    deliveredQty
} from '../src/modules/food/orders/services/order-fulfilment.service.js';

/**
 * Short picks and substitutions.
 *
 * The most common real event in a grocery business, and until now the only
 * expressible answers were "deliver everything" or "cancel the lot". The
 * customer wanted ten things, nine are there, and they would like those nine.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const STORE = someId();

const product = (over = {}) =>
    FoodItem.create({
        restaurantId: STORE,
        name: 'Amul Milk 1L',
        price: 100,
        stockQty: 10,
        gstRate: 0,
        ...over
    });

const orderOf = (lines, over = {}) =>
    FoodOrder.create({
        userId: someId(),
        restaurantId: STORE,
        items: lines,
        deliveryAddress: {
            street: '1 Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            location: { type: 'Point', coordinates: [77.59, 12.97] }
        },
        pricing: {
            subtotal: lines.reduce((s, l) => s + l.price * l.quantity, 0),
            deliveryFee: 20,
            platformFee: 5,
            tax: 0,
            discount: 0,
            total: lines.reduce((s, l) => s + l.price * l.quantity, 0) + 25
        },
        payment: { method: 'cash', status: 'cod_pending' },
        orderStatus: 'confirmed',
        stockReservedAt: new Date(),
        substitutionPreference: 'allow',
        ...over
    });

const line = (item, quantity = 1, over = {}) => ({
    itemId: String(item._id),
    name: item.name,
    price: item.price,
    quantity,
    gstRate: item.gstRate ?? null,
    ...over
});

describe('a short pick', () => {
    it('charges for what arrives and leaves the fees alone', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 3)]); // ₹300 goods + ₹25 fees

        const res = await adjustOrderFulfilment(order._id, {
            lines: [{ itemId: String(milk._id), fulfilledQuantity: 2 }]
        });

        // The rider still rode and the platform still ran; only the goods change.
        assert.equal(res.pricing.subtotal, 200);
        assert.equal(res.pricing.total, 225);
        assert.equal(res.fulfillment.shortfallAmount, 100);
        assert.equal(res.fulfillment.status, 'partial');
    });

    it('keeps saying what the customer actually ordered', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 3)]);
        await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 1 }] });

        const fresh = await FoodOrder.findById(order._id).lean();
        assert.equal(fresh.items[0].quantity, 3, 'overwriting this would erase the evidence anything went short');
        assert.equal(fresh.items[0].fulfilledQuantity, 1);
    });

    it('puts the units nobody is getting back on the shelf', async () => {
        const milk = await product({ stockQty: 7 });
        const order = await orderOf([line(milk, 3)]);
        await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 1 }] });

        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 9, 'two unsold units are available again');
    });

    it('reduces what the rider collects on a cash order', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 2)]);
        const res = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 1 }] });

        assert.equal(res.amountDue, 125);
        assert.equal(res.refundDue, 0);
        assert.equal((await FoodOrder.findById(order._id).lean()).payment.amountDue, 125);
    });

    it('owes a refund on an order already paid for', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 2)], { payment: { method: 'razorpay', status: 'paid' } });
        const res = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 1 }] });

        assert.equal(res.refundDue, 100);
        assert.equal(res.amountDue, 0);
    });

    it('scales a coupon rather than withdrawing it', async () => {
        // Telling someone who lost one item that they have also lost their ₹50
        // off is a worse outcome than the shortfall.
        const milk = await product();
        const order = await orderOf([line(milk, 4)], {
            pricing: { subtotal: 400, deliveryFee: 20, platformFee: 5, tax: 0, discount: 100, total: 325 }
        });

        const res = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 2 }] });
        assert.equal(res.pricing.subtotal, 200);
        assert.equal(res.pricing.discount, 50, 'half the goods, half the discount');
        assert.equal(res.pricing.total, 175);
    });

    it('never lets the bill go negative', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 2)], {
            pricing: { subtotal: 200, deliveryFee: 0, platformFee: 0, tax: 0, discount: 200, total: 0 }
        });
        const res = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 1 }] });
        assert.ok(res.pricing.total >= 0);
        assert.ok(res.pricing.discount <= res.pricing.subtotal);
    });

    it('reports the shortfall against the original bill, not the last change', async () => {
        // Short-picked, then substituted. Refunding only the second delta would
        // underpay the customer by the first one.
        const lacto = await product({ name: 'Lactose Free Milk', price: 120, stockQty: 5 });
        const milk = await product({ stockQty: 9, substituteItemIds: [lacto._id] });
        const order = await orderOf([line(milk, 3)]); // ₹300 goods + ₹25 fees = ₹325

        const first = await adjustOrderFulfilment(order._id, {
            lines: [{ itemId: String(milk._id), fulfilledQuantity: 2 }]
        });
        assert.equal(first.fulfillment.shortfallAmount, 100);

        const second = await adjustOrderFulfilment(order._id, {
            lines: [{ itemId: String(milk._id), substituteItemId: String(lacto._id), quantity: 2 }]
        });
        // ₹325 originally; now 2 × ₹120 + ₹25 = ₹265.
        assert.equal(second.pricing.total, 265);
        assert.equal(second.fulfillment.shortfallAmount, 60, 'cumulative against ₹325, not against ₹225');
        assert.equal(second.fulfillment.originalTotal, 325);
    });

    it('recharges the seller commission on the goods that were actually sold', async () => {
        // Left alone, a store short by one item would still pay commission on
        // the item it never sold.
        const milk = await product();
        const order = await orderOf([line(milk, 4)], {
            pricing: {
                subtotal: 400, deliveryFee: 20, platformFee: 5, tax: 0,
                discount: 0, restaurantCommission: 40, total: 425
            }
        });

        const res = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 2 }] });
        assert.equal(res.pricing.subtotal, 200);
        assert.notEqual(res.pricing.restaurantCommission, 40, 'commission must not still describe the basket that was ordered');
        assert.ok(res.pricing.restaurantCommission <= 40);
    });

    it('re-splits the settlement, which reads the transaction before the order', async () => {
        // restaurantPayout reads amounts.restaurantCommission in preference to
        // pricing.restaurantCommission, so repricing the order alone would
        // leave the seller's payout describing a basket never delivered.
        const milk = await product();
        const order = await orderOf([line(milk, 4)], {
            pricing: { subtotal: 400, deliveryFee: 20, platformFee: 5, tax: 0, discount: 0, restaurantCommission: 40, total: 425 }
        });
        await createInitialTransaction(order);
        const before = await FoodTransaction.findOne({ orderId: order._id }).lean();
        assert.equal(before.amounts.totalCustomerPaid, 425);

        await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 2 }] });

        const after = await FoodTransaction.findOne({ orderId: order._id }).lean();
        assert.equal(after.amounts.totalCustomerPaid, 225, 'the ledger follows the bill');
        assert.equal(after.pricing.subtotal, 200);
        assert.ok(after.amounts.restaurantShare < before.amounts.restaurantShare);
    });

    it('leaves a settled transaction alone, because that is a credit note', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 2)]);
        await createInitialTransaction(order);
        await FoodTransaction.updateOne({ orderId: order._id }, { $set: { status: 'settled' } });

        await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 1 }] });

        const after = await FoodTransaction.findOne({ orderId: order._id }).lean();
        assert.equal(after.amounts.totalCustomerPaid, 225, 'money already moved; history is not rewritten');
    });

    it('actually gives the money back on a prepaid order', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 2)], {
            userId: someId(),
            payment: { method: 'wallet', status: 'paid' }
        });

        const res = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 1 }] });
        assert.equal(res.refund.status, 'processed');
        assert.equal(res.refund.amount, 100);

        const fresh = await FoodOrder.findById(order._id).lean();
        assert.equal(fresh.payment.refund.status, 'processed');
        assert.equal(fresh.payment.refund.amount, 100);
        assert.equal(fresh.payment.status, 'paid', 'only part came back; the payment is not "refunded"');
    });

    it('refunds only the difference when an order goes short twice', async () => {
        // shortfallAmount is cumulative against the original bill, so paying it
        // out again on the second adjustment refunds the first shortfall twice.
        const milk = await product({ stockQty: 20 });
        const order = await orderOf([line(milk, 4)], {
            pricing: { subtotal: 400, deliveryFee: 0, platformFee: 0, tax: 0, discount: 0, total: 400 },
            payment: { method: 'wallet', status: 'paid' }
        });

        const first = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 3 }] });
        assert.equal(first.refund.amount, 100, 'bill 400 -> 300');

        const second = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 2 }] });
        assert.equal(second.refund.amount, 100, 'bill 300 -> 200: another 100, not the cumulative 200');

        const fresh = await FoodOrder.findById(order._id).lean();
        assert.equal(fresh.fulfillment.shortfallAmount, 200, 'owed in total');
        assert.equal(fresh.payment.refund.amount, 200, 'returned in total — and no more');
    });

    it('retries the whole outstanding amount after a refund failed', async () => {
        const milk = await product({ stockQty: 20 });
        const order = await orderOf([line(milk, 4)], {
            pricing: { subtotal: 400, deliveryFee: 0, platformFee: 0, tax: 0, discount: 0, total: 400 },
            payment: { method: 'wallet', status: 'paid', refund: { status: 'failed', amount: 0 } }
        });
        const res = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 3 }] });
        assert.equal(res.refund.amount, 100, 'a failed refund is not money given back');
    });

    it('does not hand back the same units twice when a short-picked order is cancelled', async () => {
        // Four taken, two returned at the shelf. Cancelling must return the
        // two the order is still holding, not the four originally ordered.
        const milk = await product({ stockQty: 10 });
        await FoodItem.updateOne({ _id: milk._id }, { $inc: { stockQty: -4 } });
        const order = await orderOf([line(milk, 4)], {
            pricing: { subtotal: 400, deliveryFee: 0, platformFee: 0, tax: 0, discount: 0, total: 400 }
        });

        await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 2 }] });
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 8, 'two came back at the shelf');

        await restoreOrderStock(await FoodOrder.findById(order._id));
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 10, 'back where it started — not 12');
    });

    it('gives back a substituted line correctly on cancellation', async () => {
        const lacto = await product({ name: 'Lactose Free Milk', price: 120, stockQty: 5 });
        const milk = await product({ stockQty: 10, substituteItemIds: [lacto._id] });
        await FoodItem.updateOne({ _id: milk._id }, { $inc: { stockQty: -2 } });
        const order = await orderOf([line(milk, 2)]);

        await adjustOrderFulfilment(order._id, {
            lines: [{ itemId: String(milk._id), substituteItemId: String(lacto._id), quantity: 2 }]
        });
        await new Promise((r) => setTimeout(r, 200));

        await restoreOrderStock(await FoodOrder.findById(order._id));
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 10, 'the original was already returned at the swap');
        assert.equal((await FoodItem.findById(lacto._id).lean()).stockQty, 5, 'the replacement comes back too');
    });

    it('puts replacement stock back when the substitution cannot go through', async () => {
        // Swapping the only line to a replacement, then emptying it, leaves
        // nothing to deliver — the claimed replacement must not be stranded.
        const lacto = await product({ name: 'Lactose Free Milk', price: 120, stockQty: 5 });
        const milk = await product({ stockQty: 10, substituteItemIds: [lacto._id] });
        const order = await orderOf([line(milk, 1)]);

        await assert.rejects(
            adjustOrderFulfilment(order._id, {
                lines: [
                    { itemId: String(milk._id), substituteItemId: String(lacto._id), quantity: 1 },
                    { itemId: String(lacto._id), fulfilledQuantity: 0 }
                ]
            })
        );
        await new Promise((r) => setTimeout(r, 200));
        assert.equal((await FoodItem.findById(lacto._id).lean()).stockQty, 5, 'claimed and then released');
    });

    it('refuses to empty the order, because that is a cancellation', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 2)]);
        await assert.rejects(
            adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 0 }] }),
            /cancel the order instead/i
        );
    });

    it('refuses to deliver more than was ordered', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 2)]);
        await assert.rejects(
            adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 5 }] }),
            /only 2 were ordered/i
        );
    });

    it('refuses once the rider has the goods', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 2)], {
            orderStatus: 'picked_up',
            deliveryState: { pickedUpAt: new Date() }
        });
        await assert.rejects(
            adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 1 }] }),
            /return rather than a short pick|already collected/i
        );
    });

    it('leaves the shelf alone when the adjustment is rejected', async () => {
        const milk = await product({ stockQty: 7 });
        const order = await orderOf([line(milk, 2)]);
        await assert.rejects(adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 9 }] }));
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 7);
    });
});

describe('a substitution', () => {
    it('swaps the line, takes the replacement off the shelf and puts the original back', async () => {
        const lacto = await product({ name: 'Lactose Free Milk', price: 120, stockQty: 5 });
        const milk = await product({ stockQty: 4, substituteItemIds: [lacto._id] });
        const order = await orderOf([line(milk, 2)]);

        const res = await adjustOrderFulfilment(order._id, {
            lines: [{ itemId: String(milk._id), substituteItemId: String(lacto._id), quantity: 2 }]
        });

        assert.equal(res.fulfillment.status, 'substituted');
        assert.equal(res.pricing.subtotal, 240, 'charged at the replacement price');
        assert.equal((await FoodItem.findById(lacto._id).lean()).stockQty, 3);
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 6);

        const fresh = await FoodOrder.findById(order._id).lean();
        const swapped = fresh.items.find((l) => l.substitutedForItemId);
        assert.equal(swapped.name, 'Lactose Free Milk');
        assert.equal(swapped.substitutedForName, 'Amul Milk 1L', 'the invoice has to say what it stood in for');
        assert.equal(deliveredQty(fresh.items[0]), 0, 'the original line delivers nothing');
    });

    it('refuses to swap when the customer asked for a refund instead', async () => {
        // Silence is not consent: a substitution spends the customer's money on
        // something they did not choose.
        const lacto = await product({ name: 'Lactose Free Milk', price: 120, stockQty: 5 });
        const milk = await product({ substituteItemIds: [lacto._id] });
        const order = await orderOf([line(milk, 1)], { substitutionPreference: 'refund' });

        await assert.rejects(
            adjustOrderFulfilment(order._id, {
                lines: [{ itemId: String(milk._id), substituteItemId: String(lacto._id) }]
            }),
            /asked for a refund instead/i
        );
    });

    it('defaults to refund when the cart said nothing', async () => {
        const lacto = await product({ name: 'Lactose Free Milk', price: 120, stockQty: 5 });
        const milk = await product({ substituteItemIds: [lacto._id] });
        const order = await FoodOrder.create({
            userId: someId(), restaurantId: STORE,
            items: [line(milk, 1)],
            deliveryAddress: { street: '1 Road', city: 'Bengaluru', state: 'Karnataka', location: { type: 'Point', coordinates: [77.59, 12.97] } },
            pricing: { subtotal: 100, total: 125, deliveryFee: 20, platformFee: 5 },
            payment: { method: 'cash' }, orderStatus: 'confirmed'
        });
        assert.equal(order.substitutionPreference, 'refund');
        await assert.rejects(
            adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), substituteItemId: String(lacto._id) }] }),
            /asked for a refund instead/i
        );
    });

    it('only allows a replacement the product itself nominates', async () => {
        // A category is nowhere near a good enough guess to spend the
        // customer's money on.
        const unrelated = await product({ name: 'Soap', price: 50 });
        const milk = await product({ substituteItemIds: [] });
        const order = await orderOf([line(milk, 1)]);

        await assert.rejects(
            adjustOrderFulfilment(order._id, {
                lines: [{ itemId: String(milk._id), substituteItemId: String(unrelated._id) }]
            }),
            /not listed as a replacement/i
        );
    });

    it('refuses a replacement from another store', async () => {
        const foreign = await FoodItem.create({ restaurantId: someId(), name: 'Milk', price: 90, stockQty: 5 });
        const milk = await product({ substituteItemIds: [foreign._id] });
        const order = await orderOf([line(milk, 1)]);

        await assert.rejects(
            adjustOrderFulfilment(order._id, {
                lines: [{ itemId: String(milk._id), substituteItemId: String(foreign._id) }]
            }),
            /same store/i
        );
    });

    it('refuses a replacement that is out of stock too', async () => {
        const empty = await product({ name: 'Soy Milk', price: 110, stockQty: 0 });
        const milk = await product({ substituteItemIds: [empty._id] });
        const order = await orderOf([line(milk, 1)]);

        await assert.rejects(
            adjustOrderFulfilment(order._id, {
                lines: [{ itemId: String(milk._id), substituteItemId: String(empty._id) }]
            }),
            /out of stock|Only \d+ left/i
        );
    });
});

describe('what the picker may offer instead', () => {
    it('lists the nominated replacements and whether each is on the shelf', async () => {
        const a = await product({ name: 'Soy Milk', price: 110, stockQty: 4 });
        const b = await product({ name: 'Oat Milk', price: 130, stockQty: 0 });
        const milk = await product({ substituteItemIds: [a._id, b._id] });

        const res = await listSubstitutesForItem(milk._id);
        const byName = new Map(res.substitutes.map((s) => [s.name, s]));
        assert.equal(byName.get('Soy Milk').inStock, true);
        assert.equal(byName.get('Oat Milk').inStock, false);
    });

    it('returns nothing for a product with no nominations', async () => {
        const milk = await product();
        assert.deepEqual((await listSubstitutesForItem(milk._id)).substitutes, []);
    });
});

describe('what the rider and the customer are shown', () => {
    it('states the quantity actually being delivered, not the one ordered', async () => {
        // Every screen renders item.quantity. Left as the ordered figure, a
        // rider collects four when two are going, and an invoice shows
        // 4 x 149 against a bill charging for two.
        const milk = await product();
        const order = await orderOf([line(milk, 4)]);
        await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 2 }] });

        const view = sanitizeOrderForExternal(await FoodOrder.findById(order._id));
        assert.equal(view.items[0].quantity, 2, 'what goes in the bag');
        assert.equal(view.items[0].orderedQuantity, 4, 'what was asked for, still available to show');
        assert.equal(view.items[0].wasShortPicked, true);
    });

    it('keeps the line total honest against the repriced bill', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 4)], {
            pricing: { subtotal: 400, deliveryFee: 0, platformFee: 0, tax: 0, discount: 0, total: 400 }
        });
        const res = await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(milk._id), fulfilledQuantity: 2 }] });

        const view = sanitizeOrderForExternal(await FoodOrder.findById(order._id));
        const lineTotal = view.items.reduce((sum, l) => sum + l.price * l.quantity, 0);
        assert.equal(lineTotal, res.pricing.subtotal, 'an invoice built from these lines adds up to the bill');
    });

    it('drops a line the shelf could not supply at all from the picking list', async () => {
        const milk = await product();
        const soap = await product({ name: 'Soap', price: 50 });
        const order = await orderOf([line(milk, 2), line(soap, 1)]);
        await adjustOrderFulfilment(order._id, { lines: [{ itemId: String(soap._id), fulfilledQuantity: 0 }] });

        const forRider = sanitizeOrderForDeliveryPartner(await FoodOrder.findById(order._id));
        assert.deepEqual(forRider.items.map((i) => i.name), ['Amul Milk 1L'], 'nothing to collect, nothing listed');

        const stored = await FoodOrder.findById(order._id).lean();
        assert.equal(stored.items.length, 2, 'but the order itself still records what was asked for');
    });

    it('leaves an untouched order exactly as it was', async () => {
        const milk = await product();
        const order = await orderOf([line(milk, 3)]);
        const view = sanitizeOrderForExternal(await FoodOrder.findById(order._id));
        assert.equal(view.items[0].quantity, 3);
        assert.equal(view.items[0].orderedQuantity, undefined, 'nothing invented for an order that never went short');
    });
});
