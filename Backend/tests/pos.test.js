import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { connectTestDb, disconnectTestDb, expectError, resetDb, someId } from './helpers/db.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodZone } from '../src/modules/food/admin/models/zone.model.js';
import { FoodRestaurant } from '../src/modules/food/restaurant/models/restaurant.model.js';
import { FoodUser } from '../src/core/users/user.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodTransaction } from '../src/modules/food/orders/models/foodTransaction.model.js';
import { FoodPosHeldBill } from '../src/modules/food/restaurant/models/posHeldBill.model.js';
import * as pos from '../src/modules/food/restaurant/services/pos.service.js';

/**
 * The seller's till, end to end through the real order pipeline.
 *
 * These run createOrder for real — stock, pricing, the transaction ledger —
 * because the bugs worth catching are in how a counter sale differs from an
 * app order: it must not wait for acceptance, must not be auto-cancelled at
 * the acceptance deadline, must not price a delivery to the shop's own door,
 * and must record the money as taken.
 */

before(connectTestDb);
after(disconnectTestDb);
beforeEach(resetDb);

const SHOP_LNG = 77.59;
const SHOP_LAT = 12.97;

/** A zone that contains the shop, since every order is zone-checked. */
const makeZone = () =>
    FoodZone.create({
        name: 'Test Zone',
        coordinates: [
            { latitude: 12.9, longitude: 77.5 },
            { latitude: 12.9, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.7 },
            { latitude: 13.05, longitude: 77.5 }
        ]
    });

const makeShop = async (over = {}) => {
    await makeZone();
    return FoodRestaurant.create({
        restaurantName: 'Corner Store',
        ownerName: 'Owner',
        ownerPhone: '9000000001',
        phone: '9000000001',
        status: 'approved',
        addressLine1: '12 Market Road',
        city: 'Bengaluru',
        state: 'Karnataka',
        location: { type: 'Point', coordinates: [SHOP_LNG, SHOP_LAT] },
        ...over
    });
};

const makeProduct = (restaurantId, over = {}) =>
    FoodItem.create({ restaurantId, name: 'Milk', price: 50, stockQty: 20, gstRate: 0, ...over });

const line = (product, quantity = 1, extra = {}) => ({ itemId: String(product._id), quantity, ...extra });

const digitsOnly = (s) => String(s || '').replace(/\D/g, '');

/** Sums of rounded halves need rounding again before comparing to a total. */
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

describe('quote', () => {
    it('prices a counter sale with no delivery or platform fee', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 40 });

        const { pricing, items } = await pos.quotePosOrder(shop._id, { items: [line(milk, 3)] });
        assert.equal(pricing.subtotal, 120);
        assert.equal(pricing.deliveryFee, 0, 'nobody drives a walk-in sale anywhere');
        assert.equal(pricing.deliveryFeeGst, 0);
        assert.equal(pricing.platformFee, 0, 'the platform fee is for app orders');
        assert.equal(pricing.total, 120);
        assert.equal(items[0].amount, 120);
    });

    it('applies flat, percentage and line discounts, extra charges and round-off', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 33 });

        const flat = await pos.quotePosOrder(shop._id, {
            items: [line(milk, 3)], // 99
            flatDiscount: { type: 'flat', value: 9 }
        });
        assert.equal(flat.pricing.manualDiscount, 9);
        assert.equal(flat.pricing.discount, 9);
        assert.equal(flat.pricing.total, 90);

        const percent = await pos.quotePosOrder(shop._id, {
            items: [line(milk, 3)],
            flatDiscount: { type: 'percent', value: 10 }
        });
        assert.equal(percent.pricing.manualDiscount, 9.9);
        assert.equal(percent.pricing.total, 89.1);

        const lines = await pos.quotePosOrder(shop._id, {
            items: [line(milk, 3, { discount: 4 })],
            additionalCharges: 5.5
        });
        assert.equal(lines.pricing.manualDiscount, 4, 'a line discount is part of the manual discount');
        assert.equal(lines.items[0].discount, 4);
        assert.equal(lines.items[0].amount, 95);
        assert.equal(lines.pricing.additionalCharges, 5.5);
        assert.equal(lines.pricing.total, 100.5);

        const rounded = await pos.quotePosOrder(shop._id, {
            items: [line(milk, 3, { discount: 4 })],
            additionalCharges: 5.5,
            roundOff: true
        });
        assert.equal(rounded.pricing.roundOff, 0.5);
        assert.equal(rounded.pricing.total, 101);
    });

    it('never lets a discount take a bill below zero', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 10 });
        const { pricing } = await pos.quotePosOrder(shop._id, {
            items: [line(milk, 1)],
            flatDiscount: { type: 'flat', value: 500 }
        });
        assert.equal(pricing.manualDiscount, 10, 'clamped to the goods');
        assert.equal(pricing.total, 0);
    });

    it('charges GST on the discounted value', async () => {
        const shop = await makeShop();
        const juice = await makeProduct(shop._id, { price: 100, gstRate: 10 });
        const { pricing } = await pos.quotePosOrder(shop._id, {
            items: [line(juice, 1)],
            flatDiscount: { type: 'flat', value: 20 }
        });
        assert.equal(pricing.tax, 8, '10% of 80, not of 100');
        assert.equal(pricing.total, 88);
    });

    it('rejects bad lines and bad types', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        await expectError(() => pos.quotePosOrder(shop._id, { items: [] }), 'At least one item', assert);
        await expectError(() => pos.quotePosOrder(shop._id, { items: [line(milk, 0)] }), 'Quantity', assert);
        await expectError(() => pos.quotePosOrder(shop._id, { items: [line(milk)], orderType: 'drone' }), 'orderType', assert);
        await expectError(
            () => pos.quotePosOrder(shop._id, { items: [line(milk)], flatDiscount: { type: 'percent', value: 120 } }),
            'cannot exceed 100',
            assert
        );
    });
});

describe('a counter sale', () => {
    it('is closed the moment it is rung up, and the stock is gone', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 50, stockQty: 10 });

        const { order, receipt } = await pos.createPosOrder(shop._id, {
            items: [line(milk, 2)],
            orderType: 'take_away',
            paymentMode: 'cash',
            salesman: 'Testing',
            remarks: 'no bag'
        });

        const saved = await FoodOrder.findById(order._id).lean();
        assert.equal(saved.source, 'pos');
        assert.equal(saved.orderStatus, 'delivered', 'the customer is holding the bag');
        assert.ok(saved.deliveryState?.deliveredAt, 'delivered right now, on the same field the rider flow stamps');
        assert.equal(saved.acceptanceDeadlineAt, null, 'nothing to accept, so nothing to time out');
        assert.equal(saved.payment.method, 'cash');
        assert.equal(saved.payment.status, 'paid', 'cash across the counter is paid, not COD');
        assert.equal(saved.payment.amountDue, 0);
        assert.equal(saved.pos.orderType, 'take_away');
        assert.equal(saved.pos.salesman, 'Testing');
        assert.equal(saved.pos.remarks, 'no bag');
        assert.equal(saved.pos.paymentMode, 'cash');
        assert.deepEqual(saved.pos.tenders.map((t) => [t.mode, t.amount]), [['cash', 100]]);
        assert.equal(saved.pos.dueAmount, 0);
        assert.equal(saved.pos.billNo, saved.order_id);
        assert.equal(saved.pricing.deliveryFee, 0);
        assert.equal(saved.pricing.total, 100);

        assert.equal(receipt.billNo, saved.order_id);
        assert.equal(receipt.orderTypeLabel, 'Take Away');
        assert.equal(receipt.store.name, 'Corner Store');
        assert.equal(receipt.customer.name, 'Walk in Customer');
        assert.equal(receipt.customer.phone, '', 'the synthetic walk-in has no real number');

        const stock = await FoodItem.findById(milk._id).lean();
        assert.equal(stock.stockQty, 8);

        const txn = await FoodTransaction.findOne({ orderId: saved._id }).lean();
        assert.ok(txn, 'the ledger has the sale');
        assert.equal(txn.status, 'captured');
        assert.equal(txn.paymentMethod, 'cash');
    });

    it('gives change on a cash note, and leaves a due when the note is short', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 50, gstRate: 0 });

        // The keypad path: one cash tender for what was actually handed over.
        const note = await pos.createPosOrder(shop._id, {
            items: [line(milk, 2)], // ₹100
            paymentMode: 'cash',
            tenders: [{ mode: 'cash', amount: 500 }]
        });
        const saved = await FoodOrder.findById(note.order._id).lean();
        assert.equal(saved.pos.tenders[0].amount, 500, 'the drawer took ₹500');
        assert.equal(saved.pos.changeGiven, 400, 'and ₹400 went back');
        assert.equal(saved.payment.status, 'paid');
        assert.equal(saved.pos.dueAmount, 0);
        assert.equal(note.receipt.payment.tendered, 500);
        assert.equal(note.receipt.payment.changeGiven, 400);

        // Short, with somebody to owe it.
        const short = await pos.createPosOrder(shop._id, {
            items: [line(milk, 2)],
            customerPhone: '9866666666',
            paymentMode: 'cash',
            tenders: [{ mode: 'cash', amount: 60 }]
        });
        const shortSaved = await FoodOrder.findById(short.order._id).lean();
        assert.equal(shortSaved.pos.dueAmount, 40);
        assert.equal(shortSaved.payment.status, 'cod_pending');
        assert.equal(shortSaved.pos.changeGiven, 0);

        // Short with nobody to owe it is refused, as the keypad says up front.
        await expectError(
            () => pos.createPosOrder(shop._id, {
                items: [line(milk, 2)], paymentMode: 'cash', tenders: [{ mode: 'cash', amount: 60 }]
            }),
            'named customer',
            assert
        );
    });

    it('charges the bill the till showed, percentage discount and all', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 99, gstRate: 12 });

        const bill = {
            items: [line(milk, 2)],                       // 198
            flatDiscount: { type: 'percent', value: 10 }, // 19.80 off
            paymentMode: 'cash'
        };

        // What the cashier reads off the strip.
        const quoted = await pos.quotePosOrder(shop._id, bill);
        assert.equal(quoted.pricing.manualDiscount, 19.8);

        const { order } = await pos.createPosOrder(shop._id, bill);
        const saved = await FoodOrder.findById(order._id).lean();

        // A percentage flat discount used to be honoured by the quote and
        // dropped on the way in: the order came out at 222 against a till
        // showing 199.20, and the 199.20 taken marked it settled in full.
        assert.equal(saved.pricing.manualDiscount, 19.8, 'the discount survives the write');
        assert.equal(
            saved.pricing.total, quoted.pricing.total,
            'the bill on the record is the bill on the screen'
        );
        assert.equal(saved.pos.tenders[0].amount, quoted.pricing.total);
        assert.equal(saved.pos.dueAmount, 0);
        assert.equal(saved.payment.status, 'paid');
    });

    it('leaves a visible balance rather than quiet money if the two ever disagree', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 100, gstRate: 0 });

        // Stand in for any future drift between quote and write by tendering
        // less than the bill through the split path, which is the same shape
        // the dropped-discount bug produced.
        const { order } = await pos.createPosOrder(shop._id, {
            items: [line(milk, 2)],                       // ₹200
            customerPhone: '9899999999',
            paymentMode: 'multiple',
            tenders: [{ mode: 'cash', amount: 180 }]
        });
        const saved = await FoodOrder.findById(order._id).lean();
        assert.equal(saved.pricing.total, 200);
        assert.equal(saved.pos.dueAmount, 20, 'the shortfall is owed, not absorbed');
        assert.equal(saved.payment.amountDue, 20);
        assert.equal(saved.payment.status, 'cod_pending', 'and the bill is not called settled');
    });

    it('keeps the card details the counter captured', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 100, gstRate: 0 });

        const { order, receipt } = await pos.createPosOrder(shop._id, {
            items: [line(milk, 2)],
            paymentMode: 'card',
            tenders: [{
                mode: 'card',
                amount: 200,
                bankAccount: 'Corner Store · ••••4321',
                customerBank: 'HDFC Bank',
                cardHolder: 'R Kumar',
                transactionNo: 'TXN99881'
            }]
        });

        const [tender] = (await FoodOrder.findById(order._id).lean()).pos.tenders;
        assert.equal(tender.transactionNo, 'TXN99881', 'a chargeback is traced by this');
        assert.equal(tender.cardHolder, 'R Kumar');
        assert.equal(tender.customerBank, 'HDFC Bank');
        assert.equal(tender.bankAccount, 'Corner Store · ••••4321');
        assert.equal(receipt.payment.tenders[0].transactionNo, 'TXN99881', 'and it prints on the bill');
    });

    it('does not hang card details off a cash tender', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 100, gstRate: 0 });

        const { order } = await pos.createPosOrder(shop._id, {
            items: [line(milk)],
            paymentMode: 'cash',
            tenders: [{ mode: 'cash', amount: 100, cardHolder: 'Nobody', transactionNo: 'TXN1' }]
        });
        const [tender] = (await FoodOrder.findById(order._id).lean()).pos.tenders;
        assert.equal(tender.cardHolder, '', 'a cash line carrying a card holder is a client bug, not data');
        assert.equal(tender.transactionNo, '');
    });

    it('leaves a due when the card takes less than the bill, and refuses to over-charge one', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 100, gstRate: 0 });

        // Part on plastic, the rest owed — same rule as any short payment.
        const part = await pos.createPosOrder(shop._id, {
            items: [line(milk, 3)],
            customerPhone: '9855555555',
            paymentMode: 'card',
            tenders: [{ mode: 'card', amount: 200, transactionNo: 'TXNPART' }]
        });
        const saved = await FoodOrder.findById(part.order._id).lean();
        assert.equal(saved.pos.dueAmount, 100);
        assert.equal(saved.payment.status, 'cod_pending');
        assert.equal(saved.pos.tenders[0].amount, 200);

        // And a card cannot hand back change, so it cannot be over-charged.
        await expectError(
            () => pos.createPosOrder(shop._id, {
                items: [line(milk)], paymentMode: 'card', tenders: [{ mode: 'card', amount: 500 }]
            }),
            'more than the',
            assert
        );

        // A short card payment with nobody to owe it is refused outright.
        await expectError(
            () => pos.createPosOrder(shop._id, {
                items: [line(milk, 3)], paymentMode: 'card', tenders: [{ mode: 'card', amount: 50 }]
            }),
            'named customer',
            assert
        );
    });

    it('records a card or UPI tender as paid without touching the gateway', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 50 });

        const { order } = await pos.createPosOrder(shop._id, { items: [line(milk)], paymentMode: 'upi' });
        const saved = await FoodOrder.findById(order._id).lean();
        assert.equal(saved.payment.method, 'upi');
        assert.equal(saved.payment.status, 'paid');
        assert.equal(saved.payment.razorpay?.orderId ?? '', '', 'no gateway order was created');
        assert.equal(saved.orderStatus, 'delivered');

        const card = await pos.createPosOrder(shop._id, { items: [line(milk)], paymentMode: 'card' });
        const cardSaved = await FoodOrder.findById(card.order._id).lean();
        assert.equal(cardSaved.payment.method, 'card', "'card' at the till is a card machine, not razorpay");
        assert.equal(cardSaved.payment.status, 'paid');
    });

    it('on the Pay screen, a short payment leaves a due and an overpayment gives change', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 50 });

        // Short, and nobody to owe it: refused.
        await expectError(
            () => pos.createPosOrder(shop._id, {
                items: [line(milk, 2)],
                paymentMode: 'multiple',
                tenders: [{ mode: 'cash', amount: 60 }, { mode: 'upi', amount: 30 }]
            }),
            'named customer',
            assert
        );
        assert.equal(await FoodOrder.countDocuments({}), 0, 'a refused bill must not move stock');

        // Short, with a customer: the rest is a due.
        const shortPay = await pos.createPosOrder(shop._id, {
            items: [line(milk, 2)], customerPhone: '9811112222',
            paymentMode: 'multiple',
            tenders: [{ mode: 'cash', amount: 60 }, { mode: 'upi', amount: 30 }]
        });
        const shortSaved = await FoodOrder.findById(shortPay.order._id).lean();
        assert.equal(shortSaved.pos.dueAmount, 10);
        assert.equal(shortSaved.payment.status, 'cod_pending');
        assert.equal(shortSaved.payment.amountDue, 10);
        assert.equal(shortSaved.pos.tenders.length, 2, 'what came in is still recorded');

        // Over, in cash: change.
        const over = await pos.createPosOrder(shop._id, {
            items: [line(milk, 1)], paymentMode: 'multiple', tenders: [{ mode: 'cash', amount: 100 }]
        });
        const overSaved = await FoodOrder.findById(over.order._id).lean();
        assert.equal(overSaved.pos.changeGiven, 50);
        assert.equal(overSaved.pos.dueAmount, 0);
        assert.equal(overSaved.payment.status, 'paid');

        // Over, by card: there is no cash to hand back.
        await expectError(
            () => pos.createPosOrder(shop._id, { items: [line(milk, 1)], paymentMode: 'multiple', tenders: [{ mode: 'card', amount: 100 }] }),
            'change cannot be given',
            assert
        );

        const { order } = await pos.createPosOrder(shop._id, {
            items: [line(milk, 2)],
            paymentMode: 'multiple',
            tenders: [{ mode: 'cash', amount: 30 }, { mode: 'upi', amount: 70 }]
        });
        const saved = await FoodOrder.findById(order._id).lean();
        assert.equal(saved.pos.paymentMode, 'multiple');
        assert.equal(saved.payment.method, 'upi', 'the snapshot names the larger tender');
        assert.equal(saved.payment.status, 'paid');
        assert.equal(saved.pos.tenders.length, 2);
    });

    it('still works for the admin panel, which sends paymentMethod', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        const { order } = await pos.createPosOrder(shop._id, {
            customerName: 'Asha', customerPhone: '9876543210', items: [line(milk)], paymentMethod: 'cash'
        });
        const saved = await FoodOrder.findById(order._id).lean();
        assert.equal(saved.source, 'pos');
        assert.equal(saved.customerPhone, '9876543210');
        assert.equal(saved.orderStatus, 'delivered');
    });

    it('books a nameless walk-in against one synthetic customer per shop', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        await pos.createPosOrder(shop._id, { items: [line(milk)] });
        await pos.createPosOrder(shop._id, { items: [line(milk)] });

        const walkIns = await FoodUser.find({ phone: /^pos-walkin-/ }).lean();
        assert.equal(walkIns.length, 1, 'one per shop, reused');
        assert.equal(await FoodOrder.countDocuments({ userId: walkIns[0]._id }), 2);
    });
});

describe('pay later', () => {
    it('needs a named customer, opens a due, and closes when it is paid off', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 100 });

        await expectError(
            () => pos.createPosOrder(shop._id, { items: [line(milk)], paymentMode: 'pay_later' }),
            'named customer',
            assert
        );

        const { order } = await pos.createPosOrder(shop._id, {
            items: [line(milk, 2)],
            paymentMode: 'pay_later',
            customerName: 'Ravi',
            customerPhone: '9800000000'
        });
        let saved = await FoodOrder.findById(order._id).lean();
        assert.equal(saved.orderStatus, 'delivered', 'they still walked out with it');
        assert.equal(saved.payment.status, 'cod_pending', 'nothing was taken');
        assert.equal(saved.payment.amountDue, 200);
        assert.equal(saved.pos.dueAmount, 200);
        assert.deepEqual(saved.pos.tenders, []);

        await expectError(() => pos.recordPosPayment(shop._id, order._id, { mode: 'cash', amount: 250 }), 'Only ₹200.00', assert);
        await expectError(() => pos.recordPosPayment(shop._id, order._id, { mode: 'cheque', amount: 10 }), 'mode must be', assert);

        const part = await pos.recordPosPayment(shop._id, order._id, { mode: 'cash', amount: 50 });
        assert.equal(part.dueAmount, 150);
        assert.equal(part.settled, false);
        saved = await FoodOrder.findById(order._id).lean();
        assert.equal(saved.payment.status, 'cod_pending', 'part paid is still owed');

        const rest = await pos.recordPosPayment(shop._id, order._id, { mode: 'upi', amount: 150 });
        assert.equal(rest.dueAmount, 0);
        assert.equal(rest.settled, true);
        saved = await FoodOrder.findById(order._id).lean();
        assert.equal(saved.payment.status, 'paid');
        assert.equal(saved.payment.amountDue, 0);
        assert.equal(saved.payment.method, 'upi', 'the larger tender');
        assert.equal(saved.pos.paymentMode, 'multiple');

        const txn = await FoodTransaction.findOne({ orderId: saved._id }).lean();
        assert.equal(txn.status, 'captured', 'the ledger caught up');

        await expectError(() => pos.recordPosPayment(shop._id, order._id, { mode: 'cash', amount: 1 }), 'Nothing is due', assert);
    });

    it('cannot be paid against another shop', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 100 });
        const { order } = await pos.createPosOrder(shop._id, {
            items: [line(milk)], paymentMode: 'pay_later', customerPhone: '9800000000'
        });
        await expectError(() => pos.recordPosPayment(someId(), order._id, { mode: 'cash', amount: 100 }), 'Bill not found', assert);
    });
});

describe('customers', () => {
    it('finds a phone anywhere but a name only among this shop\'s customers', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id);
        await FoodUser.create({ phone: '9811111111', name: 'Priya Stranger' });
        await pos.createPosOrder(shop._id, { items: [line(milk)], customerName: 'Priya Regular', customerPhone: '9822222222' });
        await pos.createPosOrder(shop._id, { items: [line(milk)] }); // synthetic walk-in

        const byPhone = await pos.searchPosCustomers(shop._id, '9811');
        assert.deepEqual(byPhone.map((c) => c.name), ['Priya Stranger'], 'a new walk-in has never ordered here');

        const byName = await pos.searchPosCustomers(shop._id, 'priya');
        assert.deepEqual(byName.map((c) => c.name), ['Priya Regular'], 'names are scoped to the shop');

        const walk = await pos.searchPosCustomers(shop._id, 'walk');
        assert.deepEqual(walk, [], 'the synthetic walk-in is not a customer anyone can pick');

        assert.deepEqual(await pos.searchPosCustomers(shop._id, ''), []);
    });

    it('summarises history with this shop only', async () => {
        const shop = await makeShop();
        const other = await makeShop({ restaurantName: 'Other Shop', ownerPhone: '9000000002', phone: '9000000002' });
        const milk = await makeProduct(shop._id, { name: 'Milk', price: 50 });
        const bread = await makeProduct(shop._id, { name: 'Bread', price: 30 });
        const otherItem = await makeProduct(other._id, { name: 'Elsewhere', price: 999 });

        await pos.createPosOrder(shop._id, { items: [line(milk, 1), line(bread, 3)], customerPhone: '9833333333', paymentMode: 'upi' });
        const { order: last } = await pos.createPosOrder(shop._id, {
            items: [line(milk, 1)], customerPhone: '9833333333', paymentMode: 'pay_later'
        });
        await pos.createPosOrder(other._id, { items: [line(otherItem, 5)], customerPhone: '9833333333' });

        const customer = await FoodUser.findOne({ phone: '9833333333' }).lean();
        const summary = await pos.getPosCustomerSummary(shop._id, customer._id);

        assert.equal(summary.totalPurchases, 2, 'the other shop\'s sale is not counted');
        assert.equal(summary.lastBillAmount, 50);
        assert.equal(String(new Date(summary.lastVisitedAt).getTime()), String(new Date(last.createdAt).getTime()));
        assert.equal(summary.mostPurchasedItem, 'Bread');
        assert.equal(summary.lastPaymentMode, 'pay_later');
        assert.equal(summary.duePayment, 50);
        assert.equal(summary.totalSpent, 190);
        assert.equal(summary.loyaltyPoints, null, 'no loyalty programme exists');
    });
});

describe('adding a customer at the counter', () => {
    const form = (over = {}) => ({
        name: 'Ravi Kumar',
        phone: '98765 04321',
        whatsappPhone: '9876504322',
        email: 'ravi@example.com',
        dateOfBirth: '1990-04-11',
        anniversary: '2015-12-01',
        addressLine1: 'Karnavati Platinum, Ghee Kanta',
        country: 'India',
        state: 'Gujarat',
        city: 'Ahmedabad',
        pinCode: '380001',
        gstType: 'unregistered',
        ...over
    });

    it('saves every field the form collects, address and all', async () => {
        const { customer } = await pos.savePosCustomer(form());
        assert.equal(customer.phone, '9876504321', 'spaces and dashes are not part of a number');

        const saved = await FoodUser.findById(customer.id).lean();
        assert.equal(saved.name, 'Ravi Kumar');
        assert.equal(saved.email, 'ravi@example.com');
        assert.equal(saved.whatsappPhone, '9876504322');
        assert.equal(new Date(saved.dateOfBirth).getFullYear(), 1990);
        assert.equal(new Date(saved.anniversary).getFullYear(), 2015);

        const [address] = saved.addresses;
        assert.equal(address.street, 'Karnavati Platinum, Ghee Kanta');
        assert.equal(address.city, 'Ahmedabad');
        assert.equal(address.state, 'Gujarat');
        assert.equal(address.country, 'India');
        assert.equal(address.zipCode, '380001');
        assert.equal(address.isDefault, true);
        // Typed at a counter, not picked off a map. Before the model dropped
        // the half-built Point this threw "Can't extract geo keys" and the
        // whole customer failed to save.
        assert.equal(address.location, undefined, 'no pin, and that is allowed');
    });

    it('updates the customer that number already belongs to, without blanking what was left empty', async () => {
        const first = await pos.savePosCustomer(form());
        const again = await pos.savePosCustomer({ name: 'Ravi K', phone: '9876504321', gstType: 'unregistered' });

        assert.equal(again.customer.id, first.customer.id, 'phone is the identity, so this is the same person');
        const saved = await FoodUser.findById(again.customer.id).lean();
        assert.equal(saved.name, 'Ravi K', 'what was retyped is updated');
        assert.equal(
            saved.email, 'ravi@example.com',
            'a cashier who did not retype the email meant "I do not have it", not "delete it"'
        );
        assert.equal(saved.whatsappPhone, '9876504322');
        assert.equal(await FoodUser.countDocuments({ phone: '9876504321' }), 1, 'and no duplicate');
    });

    it('holds a registered customer to a real GSTIN, and clears it if they stop being one', async () => {
        await expectError(
            () => pos.savePosCustomer(form({ gstType: 'registered' })),
            'needs a GSTIN',
            assert
        );
        await expectError(
            () => pos.savePosCustomer(form({ gstType: 'registered', gstin: '24AAAA' })),
            'not in a valid format',
            assert
        );

        const { customer } = await pos.savePosCustomer(form({ gstType: 'registered', gstin: '24aaacf5319k1ze' }));
        assert.equal(customer.gstin, '24AAACF5319K1ZE', 'stored upper-case, as it is printed');
        assert.equal(customer.gstType, 'registered');

        const back = await pos.savePosCustomer(form({ gstType: 'unregistered' }));
        assert.equal(back.customer.gstin, '', 'an unregistered customer keeps no stale GSTIN on their bills');
    });

    it('refuses what it cannot store', async () => {
        await expectError(() => pos.savePosCustomer(form({ name: '  ' })), 'Name is required', assert);
        await expectError(() => pos.savePosCustomer(form({ phone: '98765' })), '10-digit', assert);
        await expectError(() => pos.savePosCustomer(form({ whatsappPhone: '123' })), 'WhatsApp number must be 10', assert);
        await expectError(() => pos.savePosCustomer(form({ email: 'ravi@' })), 'email is not valid', assert);
        await expectError(() => pos.savePosCustomer(form({ dateOfBirth: 'yesterday' })), 'not a valid date', assert);
        await expectError(() => pos.savePosCustomer(form({ gstType: 'maybe' })), 'GST type must be', assert);
        assert.equal(await FoodUser.countDocuments({}), 0, 'nothing half-written got through');
    });

    it('keeps a half-filled address off the record rather than half-writing it', async () => {
        const { customer } = await pos.savePosCustomer(form({ addressLine1: 'Somewhere', city: '', state: '' }));
        const saved = await FoodUser.findById(customer.id).lean();
        assert.deepEqual(saved.addresses, [], 'city and state are required on an address; without them there is none');
    });

    it('tells the cashier the number is already taken, before the form is filled in', async () => {
        assert.deepEqual(await pos.lookupPosCustomer('9876504321'), { exists: false });

        await pos.savePosCustomer(form());
        const found = await pos.lookupPosCustomer('98765 04321');
        assert.equal(found.exists, true);
        assert.equal(found.customer.name, 'Ravi Kumar');
        assert.equal(found.customer.city, 'Ahmedabad', 'and hands back enough to fill the form in');
        assert.equal(found.customer.pinCode, '380001');

        await expectError(() => pos.lookupPosCustomer('12345'), '10-digit', assert);
    });

    /**
     * The stand-in's "phone" is pos-walkin-<restaurant id>, and how that reads
     * to the lookup depends entirely on how the id's hex falls.
     *
     * Both shops below are pinned rather than generated, because this test used
     * to take whatever ObjectId it was given and assert that stripping it never
     * left ten digits. That is untrue for a couple of percent of ids, and the
     * suite failed on exactly those — the assertion was about the shape of a
     * random number, not about the behaviour being tested.
     */
    const ID_WITH_TEN_DIGITS = '1234567890abcdefabcdefab';
    const ID_WITH_NO_DIGITS = 'abcdefabcdefabcdefabcdef';

    it('cannot surface the synthetic walk-in, whatever its id strips down to', async () => {
        const shop = await makeShop({ _id: new mongoose.Types.ObjectId(ID_WITH_TEN_DIGITS) });
        const milk = await makeProduct(shop._id);
        await pos.createPosOrder(shop._id, { items: [line(milk)] }); // creates the walk-in stand-in

        const walkIn = await FoodUser.findOne({ phone: /^pos-walkin-/ }).lean();
        assert.ok(walkIn, 'the stand-in exists');
        assert.ok(walkIn.phone.startsWith('pos-walkin-'));

        // This id strips to exactly ten digits, so the lookup accepts the
        // number and has to answer honestly instead of being saved by the
        // length check. The stand-in is stored under its pos-walkin- phone,
        // never under the bare digits, so nothing comes back.
        const digits = digitsOnly(walkIn.phone);
        assert.equal(digits.length, 10, 'this id is chosen to reach the lookup, not bounce off it');
        assert.equal((await pos.lookupPosCustomer(digits)).exists, false);

        // And a real customer on that very number is still found — the two are
        // separate records, not one filtered by luck.
        await pos.savePosCustomer({ name: 'Real Person', phone: digits });
        const found = await pos.lookupPosCustomer(digits);
        assert.equal(found.exists, true);
        assert.equal(found.customer.name, 'Real Person');
    });

    it('refuses the stand-in identifier itself as a number', async () => {
        const shop = await makeShop({ _id: new mongoose.Types.ObjectId(ID_WITH_NO_DIGITS) });
        const milk = await makeProduct(shop._id);
        await pos.createPosOrder(shop._id, { items: [line(milk)] });

        const walkIn = await FoodUser.findOne({ phone: /^pos-walkin-/ }).lean();
        await expectError(() => pos.lookupPosCustomer(walkIn.phone), '10-digit', assert);
    });
});

describe('bills', () => {
    it('reports the last bill and today\'s counter sales', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 50 });
        assert.equal(await pos.getLastPosBill(shop._id), null, 'nothing rung up yet');

        await pos.createPosOrder(shop._id, { items: [line(milk, 1)] });
        const { order: second } = await pos.createPosOrder(shop._id, { items: [line(milk, 3)], paymentMode: 'pay_later', customerPhone: '9844444444' });

        const last = await pos.getLastPosBill(shop._id);
        assert.equal(last.billNo, second.order_id);
        assert.equal(last.pricing.total, 150);

        const today = await pos.listPosOrders(shop._id, {});
        assert.equal(today.items.length, 2);
        assert.equal(today.total, 200);
        assert.equal(today.due, 150);

        const dues = await pos.listPosOrders(shop._id, { due: 'true' });
        assert.equal(dues.items.length, 1);

        const stale = await pos.listPosOrders(shop._id, { date: '2020-01-01' });
        assert.equal(stale.items.length, 0);

        const bill = await pos.getPosBill(shop._id, second._id);
        assert.equal(bill.billNo, second.order_id);
        const scanned = await pos.getPosBill(shop._id, second.order_id.toLowerCase());
        assert.equal(scanned.id, String(second._id), 'the printed bill number finds it too');
        await expectError(() => pos.getPosBill(shop._id, 'NOPE-1'), 'Bill not found', assert);
        await expectError(() => pos.getPosBill(someId(), second._id), 'Bill not found', assert);
    });
});

describe('the printed bill', () => {
    it('carries what was tendered and what went back', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 50, gstRate: 0 });

        const exact = await pos.createPosOrder(shop._id, { items: [line(milk, 2)], paymentMode: 'cash' });
        assert.equal(exact.receipt.payment.tendered, 100);
        assert.equal(exact.receipt.payment.changeGiven, 0);
        assert.equal(exact.receipt.totalQuantity, 2, 'NO OF QTY counts units, not lines');

        const withChange = await pos.createPosOrder(shop._id, {
            items: [line(milk, 1)], paymentMode: 'multiple', tenders: [{ mode: 'cash', amount: 500 }]
        });
        assert.equal(withChange.receipt.pricing.total, 50);
        assert.equal(withChange.receipt.payment.tendered, 500, 'what the customer handed over');
        assert.equal(withChange.receipt.payment.changeGiven, 450, 'and what went back');
    });

    it('splits GST per slab and adds up to the tax actually charged', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { name: 'Milk', price: 100, gstRate: 5 });
        const coffee = await makeProduct(shop._id, { name: 'Coffee', price: 100, gstRate: 12 });

        const { receipt } = await pos.createPosOrder(shop._id, { items: [line(milk, 2), line(coffee, 1)] });
        const summary = receipt.taxSummary;

        assert.deepEqual(summary.map((s) => s.rate), [5, 12], 'one row per slab, lowest first');
        assert.equal(summary[0].taxableValue, 200);
        assert.equal(summary[1].taxableValue, 100);

        // Prices here are exclusive of GST, so the taxable value is the line
        // value itself — not the line value with tax backed out of it.
        assert.equal(
            round(summary.reduce((sum, s) => sum + s.taxableValue, 0)),
            receipt.pricing.subtotal,
            'taxable values must account for the whole subtotal'
        );
        assert.equal(
            round(summary.reduce((sum, s) => sum + s.cgst + s.sgst, 0)),
            receipt.pricing.tax,
            'the summary has to add up to the tax on the bill — it is a filed document'
        );
        assert.ok(summary.every((s) => s.cgst === s.sgst), 'an intra-state sale splits in half');
        assert.ok(summary.every((s) => s.igst === 0));
    });

    it('shrinks the taxable base when a discount is given', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 100, gstRate: 5 });

        const { receipt } = await pos.createPosOrder(shop._id, {
            items: [line(milk, 4)], // 400
            flatDiscount: { type: 'flat', value: 100 }
        });
        assert.equal(receipt.pricing.discount, 100);
        assert.equal(
            round(receipt.taxSummary.reduce((sum, s) => sum + s.taxableValue, 0)),
            300,
            'tax is charged on what was actually paid for the goods'
        );
        assert.equal(
            round(receipt.taxSummary.reduce((sum, s) => sum + s.cgst + s.sgst, 0)),
            receipt.pricing.tax
        );
    });

    it('names the place of supply from the store', async () => {
        const shop = await makeShop({ gstNumber: '29AAACT1234A1Z5' });
        const milk = await makeProduct(shop._id);
        const { receipt } = await pos.createPosOrder(shop._id, { items: [line(milk)] });
        assert.equal(receipt.store.state, 'Karnataka');
        assert.equal(receipt.store.gstNumber, '29AAACT1234A1Z5');
    });
});

describe('held bills', () => {
    it('parks a cart without touching stock, and resuming removes the hold', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 50, stockQty: 5 });

        const { held } = await pos.holdPosBill(shop._id, {
            items: [{ itemId: String(milk._id), name: 'Milk', price: 50, quantity: 2 }],
            orderType: 'dine_in',
            tableNo: 'T4',
            customerName: 'Asha'
        });
        assert.equal((await FoodItem.findById(milk._id).lean()).stockQty, 5, 'a hold is not a sale');
        assert.equal(held.tableNo, 'T4');

        const list = await pos.listHeldBills(shop._id);
        assert.equal(list.length, 1);
        assert.equal(list[0].estimatedTotal, 100);
        assert.deepEqual(await pos.listHeldBills(someId()), [], 'another shop sees nothing');

        const resumed = await pos.takeHeldBill(shop._id, held._id);
        assert.equal(resumed.items[0].quantity, 2);
        assert.equal(await FoodPosHeldBill.countDocuments({}), 0, 'either parked or on screen, never both');
        await expectError(() => pos.takeHeldBill(shop._id, held._id), 'Held bill not found', assert);

        await expectError(() => pos.holdPosBill(shop._id, { items: [] }), 'nothing on the bill', assert);
    });

    it('numbers each hold in sequence, per shop', async () => {
        const shop = await makeShop();
        const other = await makeShop({ restaurantName: 'Other', ownerPhone: '9000000002', phone: '9000000002' });
        const milk = await makeProduct(shop._id, { price: 50 });
        const theirs = await makeProduct(other._id, { price: 50 });

        const first = await pos.holdPosBill(shop._id, { items: [line(milk)] });
        const second = await pos.holdPosBill(shop._id, { items: [line(milk, 2)] });
        const elsewhere = await pos.holdPosBill(other._id, { items: [line(theirs)] });

        assert.equal(first.held.holdNo, 'HOLD1');
        assert.equal(second.held.holdNo, 'HOLD2', 'the number a cashier reads out to find it again');
        assert.equal(elsewhere.held.holdNo, 'HOLD1', 'another shop counts its own');
    });

    it('prices the slip through the real engine, and prints it as not a sale', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { name: 'Milk', price: 100, gstRate: 5 });
        const coffee = await makeProduct(shop._id, { name: 'Coffee', price: 100, gstRate: 12 });

        const { receipt } = await pos.holdPosBill(shop._id, {
            items: [line(milk, 2), line(coffee, 1, { discount: 10 })],
            salesman: 'Testing',
            flatDiscount: { type: 'flat', value: 20 }
        });

        assert.equal(receipt.billNo, 'HOLD1');
        assert.equal(receipt.salesman, 'Testing', 'the cashier is named on the slip');
        assert.equal(receipt.pricing.subtotal, 300);
        assert.equal(receipt.pricing.discount, 30, 'the line discount and the flat one together');
        assert.equal(receipt.totalQuantity, 3, 'pieces purchased');
        assert.equal(receipt.discountedLines, 1, 'discount items');

        // Nothing has been taken, and the slip has to be unmistakable about it.
        assert.deepEqual(receipt.payment.tenders, []);
        assert.equal(receipt.payment.tendered, 0);
        assert.equal(receipt.payment.status, 'held');

        assert.deepEqual(receipt.taxSummary.map((t) => t.rate), [5, 12]);
        assert.equal(
            round(receipt.taxSummary.reduce((s, t) => s + t.cgst + t.sgst, 0)),
            receipt.pricing.tax,
            'a parked bill still has to add up'
        );

        // And the stored snapshot matches what was printed, so a reprint agrees.
        const saved = await FoodPosHeldBill.findById(receipt.id).lean();
        assert.equal(saved.pricing.total, receipt.pricing.total);
        assert.equal(saved.items[0].gstRate, 5, 'the slab is snapshotted for the tax summary');
    });

    it('reprints a parked slip without disturbing the hold', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 50 });
        const { held } = await pos.holdPosBill(shop._id, { items: [line(milk, 2)] });

        const again = await pos.getHeldBillReceipt(shop._id, held._id);
        assert.equal(again.billNo, held.holdNo);
        assert.equal(again.pricing.total, held.pricing.total);
        assert.equal(await FoodPosHeldBill.countDocuments({}), 1, 'reprinting is not resuming');

        await expectError(() => pos.getHeldBillReceipt(someId(), held._id), 'Held bill not found', assert);
    });

    it('prices the slip from the catalogue, not from what the client claimed', async () => {
        const shop = await makeShop();
        const milk = await makeProduct(shop._id, { price: 50 });

        const { receipt } = await pos.holdPosBill(shop._id, {
            // A client sending its own price must not be able to set the slip's.
            items: [{ itemId: String(milk._id), quantity: 2, name: 'Free Milk', price: 1 }]
        });
        assert.equal(receipt.items[0].price, 50);
        assert.equal(receipt.items[0].name, 'Milk');
        assert.equal(receipt.pricing.total, 100);
    });
});
