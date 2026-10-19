import mongoose from 'mongoose';
import { FoodUser } from '../../../../core/users/user.model.js';
import { FoodRestaurant } from '../models/restaurant.model.js';
import { FoodPosHeldBill } from '../models/posHeldBill.model.js';
import { FoodPosShift } from '../models/posShift.model.js';
import { FoodPosCreditNote } from '../models/posCreditNote.model.js';
import { FoodAdmin } from '../../../../core/admin/admin.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { createOrder } from '../../orders/services/order.service.js';
import { calculateOrderPricing } from '../../orders/services/order-pricing.service.js';
import { FoodOffer } from '../../admin/models/offer.model.js';
import { logger } from '../../../../utils/logger.js';
import { nextSequence } from '../../admin/models/counter.model.js';
import { resolveOrderCartItems } from '../../orders/helpers/order-cart-items.helper.js';
import {
    evaluateCoupon,
    loadCouponCustomerFacts,
    describeCoupon,
    isCustomerScoped
} from '../../orders/services/coupon-eligibility.service.js';
import { updateTransactionStatus } from '../../orders/services/foodTransaction.service.js';
import { FoodOrder } from '../../orders/models/order.model.js';
import { barcodesForItems } from '../../shared/productBarcode.js';

/**
 * The seller's till.
 *
 * Every sale still goes through createOrder — pricing, stock, the transaction
 * ledger, commission — so a counter sale is accounted for exactly like an app
 * order. What this module adds is everything the counter knows that the app
 * does not: who is being served, how they are taking the food, what was typed
 * in as a discount, and how the money actually arrived.
 *
 * Reads (customer lookup, the customer summary panel, the last bill, today's
 * orders) are scoped to the seller's own restaurant without exception: a
 * seller sees their own customers' history with them, never another shop's.
 */

const ORDER_TYPES = ['dine_in', 'take_away', 'walk_in', 'delivery'];
const TENDER_MODES = ['cash', 'upi', 'card'];
const PAYMENT_MODES = ['cash', 'upi', 'card', 'multiple', 'pay_later'];
const OPEN_ORDER_STATUSES = ['pending_payment', 'cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const digitsOf = (s) => String(s || '').replace(/\D/g, '');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));

/** Marks the synthetic customer a nameless walk-in sale is booked against. */
const walkInPhoneFor = (restaurantId) => `pos-walkin-${String(restaurantId)}`;
const isWalkInPhone = (phone) => String(phone || '').startsWith('pos-walkin-');

// ───────────────────────────── input shaping ─────────────────────────────

function normalizeItems(rawItems) {
    if (!Array.isArray(rawItems) || !rawItems.length) {
        throw new ValidationError('At least one item is required');
    }
    return rawItems.map((raw) => {
        const itemId = String(raw?.itemId || raw?.id || '').trim();
        if (!itemId) throw new ValidationError('Every line needs an itemId');
        const quantity = Number(raw?.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) {
            throw new ValidationError('Quantity must be a whole number of at least 1');
        }
        const discount = Number(raw?.discount) || 0;
        if (discount < 0) throw new ValidationError('A line discount cannot be negative');
        return {
            itemId,
            quantity,
            variantId: String(raw?.variantId || '').trim(),
            discount: round2(discount)
        };
    });
}

function normalizeOrderType(raw) {
    const type = String(raw || 'walk_in').trim().toLowerCase();
    if (!ORDER_TYPES.includes(type)) {
        throw new ValidationError(`orderType must be one of ${ORDER_TYPES.join(', ')}`);
    }
    return type;
}

/**
 * What the cashier typed into the strip, turned into what the pricing engine
 * takes. Line discounts are summed into the manual amount; a percentage is
 * left for the engine, which alone knows the subtotal it applies to.
 */
function pricingInputOf(dto, items) {
    const lineDiscounts = items.reduce((sum, line) => sum + line.discount, 0);
    const flat = dto.flatDiscount && typeof dto.flatDiscount === 'object' ? dto.flatDiscount : {};
    const flatValue = Math.max(0, Number(flat.value) || 0);
    const isPercent = String(flat.type || 'percent') === 'percent';
    if (isPercent && flatValue > 100) throw new ValidationError('A percentage discount cannot exceed 100');

    return {
        couponCode: dto.couponCode ? String(dto.couponCode).trim().toUpperCase() : undefined,
        manualDiscount: round2(lineDiscounts + (isPercent ? 0 : flatValue)),
        manualDiscountPercent: isPercent ? flatValue : 0,
        additionalCharges: Math.max(0, Number(dto.additionalCharges) || 0),
        roundOff: dto.roundOff === true
    };
}

/**
 * The card fields off a tender, trimmed and capped.
 *
 * Only kept for card tenders: a cash line carrying a card holder name is
 * either a mistake or a client bug, and storing it would make the field
 * useless for the reconciliation it exists for.
 */
function cardDetailsOf(raw, mode) {
    if (mode !== 'card' || !raw || typeof raw !== 'object') return {};
    const clip = (v) => String(v || '').trim().slice(0, 120);
    return {
        bankAccount: clip(raw.bankAccount),
        customerBank: clip(raw.customerBank),
        cardHolder: clip(raw.cardHolder),
        transactionNo: clip(raw.transactionNo)
    };
}

/** Which single method the order's payment snapshot names for a split bill. */
function dominantTenderMode(tenders) {
    const totals = new Map();
    for (const t of tenders) totals.set(t.mode, (totals.get(t.mode) || 0) + t.amount);
    let best = 'cash';
    let bestAmount = -1;
    for (const [mode, amount] of totals) {
        if (amount > bestAmount) { best = mode; bestAmount = amount; }
    }
    return best;
}

/**
 * Turns the strip's payment choice into the tender lines the order records.
 *
 * A single mode is one tender for the whole bill and 'pay_later' takes
 * nothing now. 'multiple' is the Pay screen: whatever was received, in
 * whatever mix. Short of the bill, the rest becomes a due against the
 * customer; over it, the excess is change handed back — and change is cash,
 * so it can only be given out of cash that came in.
 */
function resolveTenders(dto, total) {
    const mode = String(dto.paymentMode || dto.paymentMethod || 'cash').trim().toLowerCase();
    if (!PAYMENT_MODES.includes(mode)) {
        throw new ValidationError(`paymentMode must be one of ${PAYMENT_MODES.join(', ')}`);
    }

    if (mode === 'pay_later') {
        return { paymentMode: mode, tenders: [], paymentMethod: 'cash', dueAmount: total, changeGiven: 0 };
    }

    if (mode !== 'multiple') {
        // A single-mode payment normally settles the whole bill, but the card
        // dialog lets the cashier take less than the total — a customer paying
        // part on plastic. What is left is a due, on the same terms as any
        // other short payment.
        const asked = dto.tenders?.[0]?.amount;
        const amount = Number.isFinite(Number(asked)) ? round2(asked) : total;
        if (!(amount > 0)) throw new ValidationError('Payment amount must be above zero');
        if (amount - total > 0.01 && mode !== 'cash') {
            throw new ValidationError(`₹${amount.toFixed(2)} is more than the ₹${total.toFixed(2)} bill — only cash can be over-tendered`);
        }
        return {
            paymentMode: mode,
            tenders: [{ mode, amount, at: new Date(), ...cardDetailsOf(dto.tenders?.[0], mode) }],
            paymentMethod: mode,
            dueAmount: round2(Math.max(0, total - amount)),
            changeGiven: round2(Math.max(0, amount - total))
        };
    }

    const raw = Array.isArray(dto.tenders) ? dto.tenders : [];
    if (!raw.length) throw new ValidationError('A split payment needs at least one tender');
    const tenders = raw.map((t) => {
        const tenderMode = String(t?.mode || '').trim().toLowerCase();
        const amount = round2(t?.amount);
        if (!(amount > 0)) throw new ValidationError('Every tender needs an amount above zero');
        // A credit note is money already held for this customer, redeemed by
        // code. It is a tender like any other but settles from the note's
        // balance, not the drawer, so it carries a code instead of card fields.
        if (tenderMode === 'credit_note') {
            const code = String(t?.code || t?.creditNoteCode || '').trim().toUpperCase();
            if (!code) throw new ValidationError('A credit-note tender needs its code');
            return { mode: tenderMode, amount, at: new Date(), note: String(t?.note || '').slice(0, 300), creditNoteCode: code };
        }
        if (!TENDER_MODES.includes(tenderMode)) {
            throw new ValidationError(`Tender mode must be one of ${TENDER_MODES.join(', ')}, credit_note`);
        }
        return {
            mode: tenderMode,
            amount,
            at: new Date(),
            note: String(t?.note || '').slice(0, 300),
            ...cardDetailsOf(t, tenderMode)
        };
    });
    const received = round2(tenders.reduce((s, t) => s + t.amount, 0));
    const dueAmount = round2(Math.max(0, total - received));
    const changeGiven = round2(Math.max(0, received - total));
    // Change is cash handed back, so it can only come out of cash that came
    // in — never out of a card, UPI or credit-note tender.
    const cashIn = round2(tenders.filter((t) => t.mode === 'cash').reduce((s, t) => s + t.amount, 0));
    if (changeGiven > cashIn + 0.001) {
        throw new ValidationError(`₹${changeGiven.toFixed(2)} change cannot be given — only ₹${cashIn.toFixed(2)} came in as cash`);
    }
    // payment.method must stay a settlement the order schema knows; a credit
    // note is a store adjustment, not one of them, so it never wins the method.
    const settleTenders = tenders.filter((t) => t.mode !== 'credit_note');
    const paymentMethod = settleTenders.length ? dominantTenderMode(settleTenders) : 'cash';
    return { paymentMode: mode, tenders, paymentMethod, dueAmount, changeGiven };
}

// ───────────────────────────── customers ─────────────────────────────

async function loadRestaurant(restaurantId) {
    if (!isId(restaurantId)) throw new NotFoundError('Restaurant not found');
    const restaurant = await FoodRestaurant.findById(restaurantId)
        .select('restaurantName ownerName ownerPhone primaryContactNumber addressLine1 addressLine2 area city state pincode location gstNumber fssaiNumber posEnabled')
        .lean();
    if (!restaurant) throw new NotFoundError('Restaurant not found');
    // Admin can switch POS off per seller — one choke point covers every POS
    // path (quote, create, holds, last bill) since they all load through here.
    if (restaurant.posEnabled === false) {
        throw new ValidationError('Point of Sale is disabled for this store. Contact the admin to enable it.');
    }
    return restaurant;
}

/**
 * Who the bill is for. An id or a phone names a real customer (created on
 * first sight, as before). Neither means an anonymous walk-in, which is
 * booked against one synthetic customer per shop so their history does not
 * pollute any real person's and so the order's userId is still a user.
 */
async function resolveCustomer(restaurantId, dto) {
    if (dto.customerId) {
        if (!isId(dto.customerId)) throw new ValidationError('customerId is not valid');
        const customer = await FoodUser.findById(dto.customerId);
        if (!customer) throw new NotFoundError('Customer not found');
        return customer;
    }

    const phone = digitsOf(dto.customerPhone);
    if (phone) {
        let customer = await FoodUser.findOne({ phone });
        if (!customer) {
            customer = await FoodUser.create({ phone, name: String(dto.customerName || '').trim() || 'Walk-in customer' });
        } else if (dto.customerName && !customer.name) {
            customer.name = String(dto.customerName).trim();
            await customer.save();
        }
        return customer;
    }

    const walkInPhone = walkInPhoneFor(restaurantId);
    const existing = await FoodUser.findOne({ phone: walkInPhone });
    if (existing) return existing;
    return FoodUser.create({ phone: walkInPhone, name: 'Walk in Customer', isVerified: false });
}

/** The shop's own address: where a counter sale is "delivered" to. */
function counterAddressOf(restaurant) {
    const coords = restaurant.location?.coordinates;
    const address = {
        label: 'Other',
        name: restaurant.restaurantName,
        fullName: restaurant.restaurantName,
        street: restaurant.addressLine1 || restaurant.location?.addressLine1 || restaurant.restaurantName,
        additionalDetails: restaurant.addressLine2 || restaurant.location?.addressLine2 || '',
        // The order schema requires a city and state on every address. For a
        // counter sale the address is the shop's own and purely descriptive,
        // so a profile that never filled these in must not block a sale.
        city: restaurant.city || restaurant.location?.city || restaurant.area || 'Not recorded',
        state: restaurant.state || restaurant.location?.state || 'Not recorded',
        zipCode: restaurant.pincode || restaurant.location?.pincode || '',
        phone: restaurant.ownerPhone || restaurant.primaryContactNumber || '',
        location: Array.isArray(coords) && coords.length === 2 ? { type: 'Point', coordinates: coords } : undefined
    };
    if (!address.location) {
        throw new ValidationError('This store has no saved location yet — set it up before taking POS orders');
    }
    return address;
}

/** A POS delivery goes to the customer's saved address; there is nothing else to go on. */
function deliveryAddressOf(customer) {
    const addresses = Array.isArray(customer?.addresses) ? customer.addresses : [];
    const chosen = addresses.find((a) => a?.isDefault) || addresses[0];
    if (!chosen) {
        throw new ValidationError('This customer has no saved address. Ask them to add one in the app, or bill it as take-away.');
    }
    const plain = typeof chosen.toObject === 'function' ? chosen.toObject() : { ...chosen };
    return { ...plain, phone: plain.phone || customer.phone || '' };
}

// ───────────────────────────── quote & sale ─────────────────────────────

/**
 * What the bill will come to, from the same engine that will charge it. The
 * totals strip shows this rather than a client-side sum so that tax, coupon
 * rules and clamping are never approximated twice.
 */
export async function quotePosOrder(restaurantId, dto = {}) {
    const restaurant = await loadRestaurant(restaurantId);
    const items = normalizeItems(dto.items);
    const orderType = normalizeOrderType(dto.orderType);
    const counterSale = orderType !== 'delivery';

    let customer = null;
    if (dto.customerId && isId(dto.customerId)) {
        customer = await FoodUser.findById(dto.customerId).select('phone addresses').lean();
    }
    const deliveryAddress = counterSale ? counterAddressOf(restaurant) : deliveryAddressOf(customer);

    const result = await calculateOrderPricing(
        customer?._id ? String(customer._id) : null,
        {
            restaurantId: String(restaurantId),
            items,
            deliveryAddress,
            ...pricingInputOf(dto, items)
        },
        { skipAvailabilityCheck: true, counterSale }
    );

    const byId = new Map(items.map((line) => [line.itemId, line]));
    return {
        orderType,
        items: (result.items || []).map((line) => {
            const entered = byId.get(String(line.itemId)) || {};
            const gross = round2(line.price * line.quantity);
            return {
                itemId: String(line.itemId),
                name: line.name,
                price: line.price,
                mrp: line.mrp ?? null,
                quantity: line.quantity,
                gstRate: line.gstRate ?? null,
                discount: entered.discount || 0,
                amount: round2(gross - (entered.discount || 0))
            };
        }),
        pricing: result.pricing
    };
}

/**
 * Rings the sale up.
 *
 * The quote runs first so the tenders can be checked against the exact bill
 * before anything is written: a split payment that does not add up is a
 * typo, and the place to catch a typo is before stock moves.
 */
export async function createPosOrder(restaurantId, dto = {}) {
    const restaurant = await loadRestaurant(restaurantId);
    const items = normalizeItems(dto.items);
    const orderType = normalizeOrderType(dto.orderType);
    const counterSale = orderType !== 'delivery';

    const customer = await resolveCustomer(restaurantId, dto);
    const address = counterSale ? counterAddressOf(restaurant) : deliveryAddressOf(customer);

    const quote = await quotePosOrder(restaurantId, { ...dto, customerId: String(customer._id), items });
    const total = round2(quote.pricing?.total);
    if (!(total > 0)) throw new ValidationError('Bill total must be above zero');

    const { paymentMode, tenders, paymentMethod, dueAmount, changeGiven } = resolveTenders(dto, total);
    if (dueAmount > 0 && isWalkInPhone(customer.phone)) {
        throw new ValidationError('Pay later needs a named customer — pick one or enter a phone number');
    }

    // Credit-note tenders spend a stored balance, so they must clear before a
    // single rupee is committed. Load and check each here; redeem only once the
    // order is written, so a failed sale never burns a note.
    const creditNotes = await reserveCreditNoteTenders(restaurantId, tenders);

    const result = await createOrder(String(customer._id), {
        restaurantId: String(restaurantId),
        items,
        address,
        paymentMethod,
        customerName: isWalkInPhone(customer.phone) ? 'Walk in Customer' : customer.name || String(dto.customerName || ''),
        customerPhone: isWalkInPhone(customer.phone) ? '' : customer.phone,
        pricing: pricingInputOf(dto, items),
        pos: {
            orderType,
            tableNo: String(dto.tableNo || ''),
            salesman: String(dto.salesman || ''),
            remarks: String(dto.remarks || ''),
            paymentMode,
            tenders,
            dueAmount,
            changeGiven
        }
    });

    // The tenders were checked against the quote; the order is priced again on
    // the way in. Those two must agree, and when they have not it was because
    // an input the quote honoured did not survive the write — which marked a
    // bill settled for less than it was worth. Reconcile against the order's
    // own total rather than trusting the quote, so a future drift costs a
    // visible balance instead of quiet money.
    const charged = round2(result?.order?.pricing?.total);
    if (Math.abs(charged - total) > 0.01) {
        const received = round2(tenders.reduce((sum, t) => sum + t.amount, 0));
        const realDue = round2(Math.max(0, charged - received));
        logger.error(
            `[pos] quote said ₹${total} but the order priced at ₹${charged} for restaurant ${restaurantId}; ` +
            `reconciled the balance to ₹${realDue}`
        );
        await FoodOrder.updateOne(
            { _id: result.order._id },
            {
                $set: {
                    'pos.dueAmount': realDue,
                    'pos.changeGiven': round2(Math.max(0, received - charged)),
                    'payment.amountDue': realDue,
                    'payment.status': realDue > 0 ? 'cod_pending' : 'paid'
                }
            }
        );
    }

    // The bill number is the order number; kept on the pos block so it
    // survives any future renumbering of order_id.
    const billNo = String(result?.order?.order_id || result?.order?.orderId || '');
    if (result?.order?._id && billNo) {
        await FoodOrder.updateOne({ _id: result.order._id }, { $set: { 'pos.billNo': billNo } });
    }

    // The order stuck, so the reserved credit notes can be drawn down for real.
    await redeemCreditNoteTenders(creditNotes, { orderId: result?.order?._id, billNo });

    const saved = await FoodOrder.findById(result.order._id).lean();
    return { order: result.order, receipt: await withItemBarcodes(toReceipt(saved, restaurant)) };
}

// ───────────────────────────── coupons ─────────────────────────────

/**
 * The coupons this shop can offer on the bill that is open.
 *
 * Admin creates these (a seller can create their own too, scoped to their
 * shop); the till only reads them. Unlike the customer app's list, which hides
 * anything that does not currently apply, every coupon in scope is returned
 * with the reason it cannot be used — a cashier with a customer in front of
 * them needs to be able to say "add ₹120 more and this works", and a coupon
 * that silently vanishes from the list cannot be explained.
 *
 * Eligibility is the pricing engine's own, so a coupon marked usable here will
 * be honoured by the quote that follows.
 */
export async function listPosCoupons(restaurantId, dto = {}) {
    const items = Array.isArray(dto.items) && dto.items.length ? normalizeItems(dto.items) : [];

    // Judged against the goods, exactly as the pricing engine does — a coupon's
    // minimum is a minimum on the items, not on the taxed and rounded total.
    let subtotal = 0;
    if (items.length) {
        const resolved = await resolveOrderCartItems(restaurantId, items);
        subtotal = round2(resolved.reduce((sum, line) => sum + (Number(line.price) || 0) * (Number(line.quantity) || 1), 0));
    }

    const shopId = new mongoose.Types.ObjectId(String(restaurantId));
    const offers = await FoodOffer.find({
        $or: [
            { restaurantScope: 'all' },
            { restaurantScope: 'selected', restaurantIds: shopId },
            { restaurantScope: 'selected', restaurantId: shopId }
        ]
    })
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();

    const customerId = dto.customerId && isId(dto.customerId) ? String(dto.customerId) : null;
    const customer = await loadCouponCustomerFacts(customerId, offers.map((o) => o._id));

    const term = String(dto.search || '').trim().toLowerCase();
    const rows = offers
        .filter((o) => !term || String(o.couponCode).toLowerCase().includes(term))
        .map((offer) => {
            const verdict = evaluateCoupon(offer, { subtotal, restaurantId, customer });
            return {
                id: String(offer._id),
                // An offer has no name field — the code is what it is called,
                // on the receipt and in every report.
                code: offer.couponCode,
                terms: describeCoupon(offer),
                minOrderValue: Number(offer.minOrderValue) || 0,
                endDate: offer.endDate || null,
                createdBy: offer.createdByRole === 'RESTAURANT' ? 'You' : 'Admin',
                discount: verdict.discount,
                eligible: verdict.eligible,
                reason: verdict.reason,
                customerScoped: isCustomerScoped(offer)
            };
        });

    // Split the way the counter thinks about them: what anyone can have, and
    // what depends on who is standing there.
    return {
        subtotal,
        hasCustomer: Boolean(customer),
        coupons: rows.filter((r) => !r.customerScoped),
        customerCoupons: rows.filter((r) => r.customerScoped)
    };
}

// ───────────────────────────── receivables ─────────────────────────────

/**
 * A payment against a pay-later bill. The due drops by the amount; when it
 * reaches zero the order is paid and the ledger's transaction is captured.
 */
export async function recordPosPayment(restaurantId, orderId, dto = {}) {
    if (!isId(orderId)) throw new NotFoundError('Bill not found');
    const order = await FoodOrder.findOne({ _id: orderId, restaurantId, source: 'pos' });
    if (!order) throw new NotFoundError('Bill not found');

    const due = round2(order.pos?.dueAmount);
    if (!(due > 0)) throw new ValidationError('Nothing is due on this bill');

    const mode = String(dto.mode || '').trim().toLowerCase();
    if (!TENDER_MODES.includes(mode)) throw new ValidationError(`mode must be one of ${TENDER_MODES.join(', ')}`);
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new ValidationError('Amount must be above zero');
    if (amount - due > 0.01) throw new ValidationError(`Only ₹${due.toFixed(2)} is due on this bill`);

    order.pos.tenders.push({ mode, amount, at: new Date(), note: String(dto.note || '') });
    order.pos.dueAmount = round2(Math.max(0, due - amount));
    order.payment.amountDue = order.pos.dueAmount;

    const settled = order.pos.dueAmount <= 0.009;
    if (settled) {
        order.pos.dueAmount = 0;
        order.payment.amountDue = 0;
        order.payment.status = 'paid';
        order.payment.method = dominantTenderMode(order.pos.tenders);
        const modes = new Set(order.pos.tenders.map((t) => t.mode));
        order.pos.paymentMode = modes.size > 1 ? 'multiple' : [...modes][0];
    }
    await order.save();

    if (settled) {
        await updateTransactionStatus(order._id, 'pos_payment', {
            status: 'captured',
            note: 'Pay-later bill settled at the counter',
            recordedByRole: 'RESTAURANT',
            recordedById: restaurantId
        }).catch(() => null);
    }

    return { orderId: String(order._id), dueAmount: order.pos.dueAmount, settled, tenders: order.pos.tenders };
}

// ───────────────────────────── customer panel ─────────────────────────────

/**
 * Digits look up a phone anywhere (a new walk-in has never ordered here);
 * letters look up a name only among people who have bought from this shop.
 */
export async function searchPosCustomers(restaurantId, query = '', limit = 10) {
    const q = String(query || '').trim();
    if (!q) return [];
    const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);

    const digits = digitsOf(q);
    let filter;
    if (digits.length >= 4 && digits.length === q.replace(/[\s+\-()]/g, '').length) {
        filter = { phone: new RegExp('^' + digits) };
    } else {
        const userIds = await FoodOrder.distinct('userId', { restaurantId });
        if (!userIds.length) return [];
        filter = { _id: { $in: userIds }, name: new RegExp(escapeRegex(q), 'i') };
    }

    const rows = await FoodUser.find(filter).select('name phone').sort({ name: 1 }).limit(cap).lean();
    return rows
        .filter((u) => !isWalkInPhone(u.phone))
        .map((u) => ({ id: String(u._id), name: u.name || '', phone: u.phone || '' }));
}

const GST_TYPES = ['unregistered', 'registered', 'composition'];
/** 22AAAAA0000A1Z5 — two digits, five letters, four digits, letter, digit/letter, Z, digit/letter. */
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

/**
 * Is this number already somebody's?
 *
 * What the dialog's Verify link asks. At a counter the same customer is
 * entered again and again under slightly different names; saying "this is
 * already Ravi Kumar" before the form is filled in is the cheapest way to stop
 * a duplicate, and phone is this system's unique key for a customer anyway.
 */
export async function lookupPosCustomer(phone) {
    const digits = digitsOf(phone);
    if (digits.length !== 10) throw new ValidationError('Enter a 10-digit mobile number');

    const existing = await FoodUser.findOne({ phone: digits })
        .select('name phone email whatsappPhone gstType gstin dateOfBirth anniversary addresses')
        .lean();
    if (!existing || isWalkInPhone(existing.phone)) return { exists: false };

    const address = (existing.addresses || []).find((a) => a.isDefault) || existing.addresses?.[0] || null;
    return {
        exists: true,
        customer: {
            id: String(existing._id),
            name: existing.name || '',
            phone: existing.phone,
            email: existing.email || '',
            whatsappPhone: existing.whatsappPhone || '',
            gstType: existing.gstType || 'unregistered',
            gstin: existing.gstin || '',
            dateOfBirth: existing.dateOfBirth || null,
            anniversary: existing.anniversary || null,
            addressLine1: address?.street || '',
            country: address?.country || 'India',
            state: address?.state || '',
            city: address?.city || '',
            pinCode: address?.zipCode || ''
        }
    };
}

/**
 * Creates the customer the cashier just typed in, or updates the one that
 * number already belongs to.
 *
 * Updates never blank a field the form left empty: the counter sees one
 * screen's worth of a customer, and a cashier who did not retype an email
 * meant "I do not have it", not "delete it".
 *
 * The address is optional and stored without a map pin, because one typed at a
 * counter has no coordinates. That is now allowed — see the model's
 * dropEmptyAddressPoints — but it does mean such an address cannot be
 * delivered to until the customer picks it on a map in the app.
 */
export async function savePosCustomer(dto = {}) {
    const name = String(dto.name || '').trim();
    if (!name) throw new ValidationError('Name is required');

    const phone = digitsOf(dto.phone);
    if (phone.length !== 10) throw new ValidationError('Enter a 10-digit mobile number');

    const whatsapp = digitsOf(dto.whatsappPhone);
    if (whatsapp && whatsapp.length !== 10) throw new ValidationError('WhatsApp number must be 10 digits');

    const gstType = String(dto.gstType || 'unregistered').trim().toLowerCase();
    if (!GST_TYPES.includes(gstType)) throw new ValidationError(`GST type must be one of ${GST_TYPES.join(', ')}`);

    const gstin = String(dto.gstin || '').trim().toUpperCase();
    if (gstType !== 'unregistered' && !gstin) throw new ValidationError('A registered customer needs a GSTIN');
    if (gstin && !GSTIN_PATTERN.test(gstin)) throw new ValidationError('That GSTIN is not in a valid format');

    const email = String(dto.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new ValidationError('That email is not valid');

    const asDate = (raw, label) => {
        if (!raw) return null;
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) throw new ValidationError(`${label} is not a valid date`);
        return d;
    };

    const customer = (await FoodUser.findOne({ phone })) || new FoodUser({ phone });

    customer.name = name;
    customer.countryCode = String(dto.countryCode || '+91').trim() || '+91';
    customer.gstType = gstType;
    // A customer moved back to unregistered keeps no stale GSTIN on their bills.
    customer.gstin = gstType === 'unregistered' ? '' : gstin;
    if (whatsapp) {
        customer.whatsappPhone = whatsapp;
        customer.whatsappCountryCode = String(dto.whatsappCountryCode || '+91').trim() || '+91';
    }
    if (email) customer.email = email;
    const dob = asDate(dto.dateOfBirth, 'Date of birth');
    if (dob) customer.dateOfBirth = dob;
    const anniversary = asDate(dto.anniversary, 'Anniversary date');
    if (anniversary) customer.anniversary = anniversary;

    // An address needs a city and a state to be storable at all, so a partly
    // filled one is kept off the record rather than half-written.
    const line1 = String(dto.addressLine1 || '').trim();
    const city = String(dto.city || '').trim();
    const state = String(dto.state || '').trim();
    if (line1 && city && state) {
        const existing = (customer.addresses || []).find((a) => a.isDefault) || customer.addresses?.[0];
        const fields = {
            label: 'Home',
            street: line1,
            city,
            state,
            country: String(dto.country || 'India').trim() || 'India',
            zipCode: String(dto.pinCode || '').trim(),
            phone,
            isDefault: true
        };
        if (existing) existing.set(fields);
        else customer.addresses.push(fields);
    }

    await customer.save();

    return {
        customer: {
            id: String(customer._id),
            name: customer.name,
            phone: customer.phone,
            email: customer.email || '',
            whatsappPhone: customer.whatsappPhone || '',
            gstType: customer.gstType,
            gstin: customer.gstin || ''
        }
    };
}

/** The "Customer Details" panel: this customer's history with this shop only. */
export async function getPosCustomerSummary(restaurantId, userId) {
    if (!isId(userId)) throw new NotFoundError('Customer not found');
    const customer = await FoodUser.findById(userId).select('name phone').lean();
    if (!customer) throw new NotFoundError('Customer not found');

    const scope = {
        restaurantId: new mongoose.Types.ObjectId(String(restaurantId)),
        userId: new mongoose.Types.ObjectId(String(userId)),
        orderStatus: { $nin: OPEN_ORDER_STATUSES }
    };

    const [last, totals, top] = await Promise.all([
        FoodOrder.findOne(scope).sort({ createdAt: -1 }).select('createdAt pricing.total payment.method pos.paymentMode').lean(),
        FoodOrder.aggregate([
            { $match: scope },
            { $group: { _id: null, count: { $sum: 1 }, spent: { $sum: { $ifNull: ['$pricing.total', 0] } }, due: { $sum: { $ifNull: ['$pos.dueAmount', 0] } } } }
        ]),
        FoodOrder.aggregate([
            { $match: scope },
            { $unwind: '$items' },
            { $group: { _id: '$items.name', qty: { $sum: '$items.quantity' } } },
            { $sort: { qty: -1, _id: 1 } },
            { $limit: 1 }
        ])
    ]);

    const agg = totals[0] || { count: 0, spent: 0, due: 0 };
    return {
        id: String(customer._id),
        name: customer.name || '',
        phone: isWalkInPhone(customer.phone) ? '' : customer.phone || '',
        lastVisitedAt: last?.createdAt || null,
        lastBillAmount: last ? round2(last.pricing?.total) : null,
        mostPurchasedItem: top[0]?._id || null,
        lastPaymentMode: last ? (last.pos?.paymentMode || last.payment?.method || null) : null,
        duePayment: round2(agg.due),
        totalPurchases: agg.count,
        totalSpent: round2(agg.spent),
        // No loyalty programme exists in this system; the panel shows a dash.
        loyaltyPoints: null
    };
}

// ───────────────────────────── bills & orders ─────────────────────────────

const ORDER_TYPE_LABEL = { dine_in: 'Dine In', take_away: 'Take Away', walk_in: 'Walk In', delivery: 'Delivery' };

/**
 * The GST summary a printed bill has to carry, grouped by rate.
 *
 * This mirrors computeItemsTax deliberately, line for line. Prices here are
 * exclusive of GST — the tax is added on top of the line value, not backed out
 * of it — and a discount reduces the taxable base pro rata across every line.
 * Getting that backwards prints a taxable value that disagrees with the tax
 * actually charged, on a document a shop files.
 *
 * The split is CGST + SGST in equal halves, which holds because a counter sale
 * is always intra-state: the customer is standing in the shop. IGST is carried
 * at zero so the printed table keeps the shape an accountant expects.
 */
function taxSummaryOf({ items = [], pricing = {} } = {}) {
    const subtotal = Number(pricing.subtotal) || 0;
    if (!(subtotal > 0)) return [];

    const discount = Number(pricing.discount) || 0;
    const taxableShare = Math.max(0, subtotal - discount) / subtotal;

    const byRate = new Map();
    for (const line of items) {
        // null and undefined mean "no slab of its own" — the same distinction
        // computeItemsTax draws, since Number(null) is 0 and would silently
        // make every untagged item tax-free.
        const own = line?.gstRate;
        const rate = own !== null && own !== undefined && Number.isFinite(Number(own)) ? Number(own) : 0;
        const lineValue = (Number(line.price) || 0) * (Number(line.quantity) || 1);
        const taxable = lineValue * taxableShare;

        const row = byRate.get(rate) || { rate, taxableValue: 0, cgst: 0, sgst: 0, cess: 0, igst: 0 };
        row.taxableValue += taxable;
        byRate.set(rate, row);
    }

    const rows = [...byRate.values()].sort((a, b) => a.rate - b.rate);
    for (const row of rows) {
        const tax = row.taxableValue * (row.rate / 100);
        row.taxableValue = round2(row.taxableValue);
        row.cgst = round2(tax / 2);
        row.sgst = round2(tax / 2);
    }

    // The charge rounds the whole tax to a rupee once; summing the halves back
    // up need not land on the same figure. A tax invoice whose summary does not
    // add up to the tax charged is the kind of thing an auditor stops on, so
    // the difference goes onto the largest slab rather than being left to drift.
    const charged = Number(pricing.tax) || 0;
    const summed = rows.reduce((sum, r) => sum + r.cgst + r.sgst, 0);
    const drift = round2(charged - summed);
    if (drift !== 0 && rows.length) {
        const biggest = rows.reduce((a, b) => (b.taxableValue > a.taxableValue ? b : a));
        biggest.cgst = round2(biggest.cgst + drift / 2);
        biggest.sgst = round2(biggest.sgst + drift / 2);
    }

    return rows;
}

/**
 * Adds each line's barcode (or item code, for products that only have that) so the bill
 * can print it under the item. Takes one receipt or a list; looks the products up once.
 * Read from the product, not the order, so bills printed before a barcode was assigned
 * pick it up on reprint.
 */
export async function withItemBarcodes(receipts) {
    const list = (Array.isArray(receipts) ? receipts : [receipts]).filter(Boolean);
    const ids = list.flatMap((r) => (r.items || []).map((it) => it.itemId));
    const codes = await barcodesForItems(ids);
    for (const receipt of list) {
        for (const it of receipt.items || []) it.barcode = codes.get(String(it.itemId)) || '';
    }
    return receipts;
}

/** The shape a printed receipt and the "Last Bill" box read from. */
export function toReceipt(order, restaurant = null) {
    if (!order) return null;
    const pricing = order.pricing || {};
    return {
        id: String(order._id),
        billNo: order.pos?.billNo || order.order_id || order.orderId || String(order._id).slice(-6).toUpperCase(),
        createdAt: order.createdAt,
        orderType: order.pos?.orderType || 'walk_in',
        orderTypeLabel: ORDER_TYPE_LABEL[order.pos?.orderType] || 'Walk In',
        tableNo: order.pos?.tableNo || '',
        salesman: order.pos?.salesman || '',
        remarks: order.pos?.remarks || '',
        store: restaurant
            ? {
                name: restaurant.restaurantName || '',
                address: [restaurant.addressLine1, restaurant.area, restaurant.city, restaurant.pincode].filter(Boolean).join(', '),
                phone: restaurant.ownerPhone || restaurant.primaryContactNumber || '',
                gstNumber: restaurant.gstNumber || '',
                fssaiNumber: restaurant.fssaiNumber || '',
                // Printed as the place of supply, which a tax invoice must name.
                state: restaurant.state || ''
            }
            : null,
        customer: {
            name: order.customerName || 'Walk in Customer',
            phone: isWalkInPhone(order.customerPhone) ? '' : order.customerPhone || ''
        },
        items: (order.items || []).map((line) => ({
            itemId: String(line.itemId || ''),
            name: line.name,
            variantName: line.variantName || '',
            quantity: line.quantity,
            price: line.price,
            discount: line.discount || 0,
            gstRate: line.gstRate ?? null,
            amount: round2(line.price * line.quantity - (line.discount || 0))
        })),
        pricing: {
            subtotal: round2(pricing.subtotal),
            tax: round2(pricing.tax),
            discount: round2(pricing.discount),
            manualDiscount: round2(pricing.manualDiscount),
            couponCode: pricing.couponCode || null,
            additionalCharges: round2(pricing.additionalCharges),
            roundOff: round2(pricing.roundOff),
            total: round2(pricing.total)
        },
        /** Printed as "NO OF QTY", which is what a shop counts a bill by. */
        totalQuantity: round2((order.items || []).reduce((sum, l) => sum + (Number(l.quantity) || 0), 0)),
        taxSummary: taxSummaryOf(order),
        payment: {
            mode: order.pos?.paymentMode || order.payment?.method || 'cash',
            method: order.payment?.method || 'cash',
            status: order.payment?.status || '',
            tenders: order.pos?.tenders || [],
            // What the customer handed over and what went back: the till drawer
            // has to reconcile against these, not against the bill total.
            tendered: round2((order.pos?.tenders || []).reduce((sum, t) => sum + (Number(t.amount) || 0), 0)),
            changeGiven: round2(order.pos?.changeGiven),
            dueAmount: round2(order.pos?.dueAmount)
        }
    };
}

export async function getLastPosBill(restaurantId) {
    const [order, restaurant] = await Promise.all([
        FoodOrder.findOne({ restaurantId, source: 'pos' }).sort({ createdAt: -1 }).lean(),
        loadRestaurant(restaurantId)
    ]);
    return withItemBarcodes(toReceipt(order, restaurant));
}

/** By id, or by the bill number printed on the receipt — that is what gets scanned. */
export async function getPosBill(restaurantId, ref) {
    const key = String(ref || '').trim();
    if (!key) throw new NotFoundError('Bill not found');
    const filter = { restaurantId, source: 'pos' };
    if (isId(key)) filter._id = key;
    else filter.$or = [{ 'pos.billNo': key.toUpperCase() }, { order_id: key.toUpperCase() }];

    // The bill is checked first so that asking for another shop's bill says
    // "not found" and nothing about whether that shop exists.
    const order = await FoodOrder.findOne(filter).lean();
    if (!order) throw new NotFoundError('Bill not found');
    return withItemBarcodes(toReceipt(order, await loadRestaurant(restaurantId)));
}

/** Today's counter sales by default; a date narrows to that day, `all` lifts it. */
export async function listPosOrders(restaurantId, query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
    const filter = { restaurantId, source: 'pos' };

    if (String(query.date || '') !== 'all') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(query.date || ''));
        const base = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
        const start = new Date(base.getFullYear(), base.getMonth(), base.getDate());
        const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
        filter.createdAt = { $gte: start, $lte: end };
    }
    if (String(query.due) === 'true') filter['pos.dueAmount'] = { $gt: 0 };

    const rows = await FoodOrder.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    const items = await withItemBarcodes(rows.map((o) => toReceipt(o)));
    return {
        items,
        total: round2(items.reduce((s, r) => s + r.pricing.total, 0)),
        due: round2(items.reduce((s, r) => s + r.payment.dueAmount, 0))
    };
}

// ───────────────────────────── held bills ─────────────────────────────

export async function holdPosBill(restaurantId, dto = {}) {
    const rawItems = Array.isArray(dto.items) ? dto.items : [];
    if (!rawItems.length) throw new ValidationError('There is nothing on the bill to hold');

    const restaurant = await loadRestaurant(restaurantId);

    // Priced through the same engine the sale will use, so the slip handed to
    // the customer and the totals strip they just watched agree. The client
    // sends what it has; none of it is trusted for the figures.
    const quote = await quotePosOrder(restaurantId, dto);
    const quotedById = new Map(quote.items.map((line) => [String(line.itemId), line]));

    const items = rawItems.map((raw) => {
        const itemId = String(raw?.itemId || raw?.id || '').trim();
        const quoted = quotedById.get(itemId);
        return {
            itemId,
            name: quoted?.name || String(raw?.name || ''),
            // Carried through the park so the resumed line looks like the one
            // that was parked. The quote knows the MRP; the item code only
            // reaches us from the till, which read it off the product search.
            itemCode: String(raw?.itemCode || ''),
            mrp: quoted?.mrp ?? (Number.isFinite(Number(raw?.mrp)) ? Number(raw.mrp) : null),
            variantId: String(raw?.variantId || ''),
            price: quoted ? quoted.price : Math.max(0, Number(raw?.price) || 0),
            quantity: Math.max(1, parseInt(raw?.quantity, 10) || 1),
            discount: quoted ? quoted.discount : Math.max(0, Number(raw?.discount) || 0),
            gstRate: quoted?.gstRate ?? null
        };
    });
    if (items.some((line) => !line.itemId)) throw new ValidationError('Every line needs an itemId');

    const seq = await nextSequence(`pos_hold_${String(restaurantId)}`);

    const held = await FoodPosHeldBill.create({
        restaurantId,
        holdNo: `HOLD${seq}`,
        customer: {
            userId: dto.customerId && isId(dto.customerId) ? dto.customerId : null,
            name: String(dto.customerName || ''),
            phone: digitsOf(dto.customerPhone)
        },
        orderType: normalizeOrderType(dto.orderType),
        tableNo: String(dto.tableNo || ''),
        salesman: String(dto.salesman || ''),
        remarks: String(dto.remarks || ''),
        items,
        flatDiscount: {
            type: String(dto.flatDiscount?.type || 'percent') === 'flat' ? 'flat' : 'percent',
            value: Math.max(0, Number(dto.flatDiscount?.value) || 0)
        },
        additionalCharges: Math.max(0, Number(dto.additionalCharges) || 0),
        roundOff: dto.roundOff === true,
        couponCode: String(dto.couponCode || ''),
        estimatedTotal: round2(quote.pricing?.total),
        pricing: {
            subtotal: round2(quote.pricing?.subtotal),
            tax: round2(quote.pricing?.tax),
            discount: round2(quote.pricing?.discount),
            additionalCharges: round2(quote.pricing?.additionalCharges),
            roundOff: round2(quote.pricing?.roundOff),
            total: round2(quote.pricing?.total)
        },
        heldBy: String(dto.salesman || '')
    });

    const saved = held.toObject();
    return { held: { ...saved, id: String(saved._id) }, receipt: await withItemBarcodes(heldToReceipt(saved, restaurant)) };
}

/**
 * A parked bill in the shape the printer takes.
 *
 * Same shape as a sale's receipt so one template prints both — what differs is
 * that nothing has been tendered, which is exactly what the slip has to make
 * unmistakable.
 */
export function heldToReceipt(held, restaurant = null) {
    if (!held) return null;
    const pricing = held.pricing || {};
    const items = (held.items || []).map((line) => ({
        itemId: String(line.itemId || ''),
        name: line.name,
        variantName: '',
        quantity: line.quantity,
        price: line.price,
        discount: line.discount || 0,
        gstRate: line.gstRate ?? null,
        amount: round2(line.price * line.quantity - (line.discount || 0))
    }));

    return {
        id: String(held._id || ''),
        billNo: held.holdNo || '',
        createdAt: held.createdAt || new Date(),
        orderType: held.orderType || 'walk_in',
        orderTypeLabel: ORDER_TYPE_LABEL[held.orderType] || 'Walk In',
        tableNo: held.tableNo || '',
        salesman: held.salesman || held.heldBy || '',
        remarks: held.remarks || '',
        store: restaurant
            ? {
                name: restaurant.restaurantName || '',
                address: [restaurant.addressLine1, restaurant.area, restaurant.city, restaurant.pincode].filter(Boolean).join(', '),
                phone: restaurant.ownerPhone || restaurant.primaryContactNumber || '',
                gstNumber: restaurant.gstNumber || '',
                fssaiNumber: restaurant.fssaiNumber || '',
                state: restaurant.state || ''
            }
            : null,
        customer: { name: held.customer?.name || 'Walk in Customer', phone: held.customer?.phone || '' },
        items,
        pricing: {
            subtotal: round2(pricing.subtotal),
            tax: round2(pricing.tax),
            discount: round2(pricing.discount),
            manualDiscount: 0,
            couponCode: held.couponCode || null,
            additionalCharges: round2(pricing.additionalCharges),
            roundOff: round2(pricing.roundOff),
            total: round2(pricing.total)
        },
        totalQuantity: round2(items.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0)),
        /** How many lines were knocked down, which the slip states separately. */
        discountedLines: items.filter((l) => (Number(l.discount) || 0) > 0).length,
        taxSummary: taxSummaryOf({ items, pricing }),
        // Nothing has been taken. An empty tender list is the honest answer and
        // the template keys off it to leave the money block out entirely.
        payment: { mode: '', method: '', status: 'held', tenders: [], tendered: 0, changeGiven: 0, dueAmount: 0 }
    };
}

export async function listHeldBills(restaurantId) {
    const rows = await FoodPosHeldBill.find({ restaurantId }).sort({ createdAt: -1 }).limit(100).lean();
    return rows.map((h) => ({ ...h, id: String(h._id) }));
}

/** Reprints a parked bill's slip without disturbing the hold. */
export async function getHeldBillReceipt(restaurantId, heldId) {
    if (!isId(heldId)) throw new NotFoundError('Held bill not found');
    const held = await FoodPosHeldBill.findOne({ _id: heldId, restaurantId }).lean();
    if (!held) throw new NotFoundError('Held bill not found');
    return withItemBarcodes(heldToReceipt(held, await loadRestaurant(restaurantId)));
}

/** Resuming removes the hold: a bill is either parked or on the screen, never both. */
export async function takeHeldBill(restaurantId, heldId) {
    if (!isId(heldId)) throw new NotFoundError('Held bill not found');
    const held = await FoodPosHeldBill.findOneAndDelete({ _id: heldId, restaurantId }).lean();
    if (!held) throw new NotFoundError('Held bill not found');
    return { ...held, id: String(held._id) };
}

export async function discardHeldBill(restaurantId, heldId) {
    if (!isId(heldId)) throw new NotFoundError('Held bill not found');
    const res = await FoodPosHeldBill.deleteOne({ _id: heldId, restaurantId });
    if (!res.deletedCount) throw new NotFoundError('Held bill not found');
    return { deleted: true };
}

// ───────────────────────────── register / shift ─────────────────────────────

const SHIFT_CANCELLED = ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];

/** Readable per-store per-day shift code, e.g. "SH1-20261016-01". */
async function nextShiftCode(restaurantId) {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const seq = await nextSequence(`pos_shift_${restaurantId}_${ymd}`);
    return `SH1-${ymd}-${String(seq).padStart(2, '0')}`;
}

/** Cash taken in and bills rung up since the shift opened (cash tenders only). */
async function computeShiftCash(restaurantId, since) {
    const orders = await FoodOrder.find({
        restaurantId,
        source: 'pos',
        createdAt: { $gte: since },
        orderStatus: { $nin: SHIFT_CANCELLED }
    }).select('pos').lean();

    let cashSales = 0;
    for (const o of orders) {
        for (const t of (o.pos?.tenders || [])) {
            if (t?.mode === 'cash') cashSales += Number(t.amount) || 0;
        }
    }
    return { cashSales: round2(cashSales), billsCount: orders.length };
}

const expectedCashOf = (shift, cashSales) =>
    round2((shift.openingCash || 0) + cashSales + (shift.cashReceived || 0) - (shift.cashOut || 0) - (shift.refunds || 0));

const countedFromDenoms = (denoms = {}) =>
    round2(Object.entries(denoms).reduce((sum, [note, count]) => sum + (Number(note) || 0) * (Number(count) || 0), 0));

/** The open register for this store, or null. */
export async function getCurrentShift(restaurantId) {
    await loadRestaurant(restaurantId);
    const shift = await FoodPosShift.findOne({ restaurantId, status: 'open' }).lean();
    return { shift: shift || null };
}

/** Open a register with a starting float. Only one may be open per store. */
export async function openShift(restaurantId, dto = {}) {
    await loadRestaurant(restaurantId);
    const existing = await FoodPosShift.findOne({ restaurantId, status: 'open' }).lean();
    if (existing) return { shift: existing, alreadyOpen: true };

    const shift = await FoodPosShift.create({
        restaurantId,
        shiftCode: await nextShiftCode(restaurantId),
        cashierName: String(dto.cashierName || '').trim(),
        openingCash: Math.max(0, Number(dto.openingCash) || 0)
    });
    return { shift: shift.toObject() };
}

/** The open register plus live cash sales, bill count and expected cash. */
export async function getShiftSummary(restaurantId) {
    await loadRestaurant(restaurantId);
    const shift = await FoodPosShift.findOne({ restaurantId, status: 'open' }).lean();
    if (!shift) return { shift: null };
    const { cashSales, billsCount } = await computeShiftCash(restaurantId, shift.openedAt);
    return { shift: { ...shift, cashSales, billsCount, expectedCash: expectedCashOf(shift, cashSales) } };
}

/** Count the drawer and close the register, recording the difference. */
export async function closeShift(restaurantId, dto = {}) {
    await loadRestaurant(restaurantId);
    const shift = await FoodPosShift.findOne({ restaurantId, status: 'open' });
    if (!shift) throw new ValidationError('No open register to close');

    const { cashSales, billsCount } = await computeShiftCash(restaurantId, shift.openedAt);
    const expectedCash = expectedCashOf(shift, cashSales);
    const denominations = dto.denominations && typeof dto.denominations === 'object' ? dto.denominations : {};
    const countedCash = Number.isFinite(Number(dto.countedCash)) ? round2(dto.countedCash) : countedFromDenoms(denominations);
    const difference = round2(countedCash - expectedCash);

    // A drawer that doesn't balance can only be closed with a reason and a
    // manager's approval — so a short till is never signed off silently.
    let closeReason = '';
    let closeApprovedBy = '';
    if (difference !== 0) {
        closeReason = String(dto.reason || '').trim();
        if (!closeReason) throw new ValidationError('A reason is required to close with a cash difference');

        const managerId = String(dto.managerId || '').trim();
        const managerPassword = String(dto.managerPassword || '');
        if (!managerId || !managerPassword) throw new ValidationError('A manager must approve closing with a difference');

        const manager = await FoodAdmin.findOne({ email: managerId.toLowerCase() });
        const ok = manager && manager.isDeleted !== true && manager.isActive !== false && (await manager.comparePassword(managerPassword));
        if (!ok) throw new ValidationError('Manager approval failed — check the ID and password');
        closeApprovedBy = manager.email;
    }

    shift.status = 'closed';
    shift.closedAt = new Date();
    shift.cashSales = cashSales;
    shift.billsCount = billsCount;
    shift.expectedCash = expectedCash;
    shift.countedCash = countedCash;
    shift.denominations = denominations;
    shift.difference = difference;
    shift.closeReason = closeReason;
    shift.closeApprovedBy = closeApprovedBy;
    await shift.save();
    return { shift: shift.toObject() };
}

/** Record cash paid into or out of the open drawer during the shift. */
export async function recordCashMovement(restaurantId, dto = {}) {
    await loadRestaurant(restaurantId);
    const shift = await FoodPosShift.findOne({ restaurantId, status: 'open' });
    if (!shift) throw new ValidationError('Open a register before moving cash');

    const type = String(dto.type || '').trim().toLowerCase();
    if (type !== 'in' && type !== 'out') throw new ValidationError('type must be "in" or "out"');
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new ValidationError('Amount must be above zero');

    if (type === 'in') shift.cashReceived = round2((shift.cashReceived || 0) + amount);
    else {
        // Can't take out more than the drawer holds (opening + sales + in − out).
        const { cashSales } = await computeShiftCash(restaurantId, shift.openedAt);
        const available = round2((shift.openingCash || 0) + cashSales + (shift.cashReceived || 0) - (shift.cashOut || 0));
        if (amount > available) throw new ValidationError(`Only ₹${available.toFixed(2)} is in the drawer`);
        shift.cashOut = round2((shift.cashOut || 0) + amount);
    }
    await shift.save();

    const { cashSales, billsCount } = await computeShiftCash(restaurantId, shift.openedAt);
    return { shift: { ...shift.toObject(), cashSales, billsCount, expectedCash: expectedCashOf(shift, cashSales) } };
}

// ───────────────────────────── credit notes ─────────────────────────────

const CREDIT_NOTE_OPEN = ['active', 'partially_redeemed'];

/** Readable per-store per-day credit-note code, e.g. "CN-20261019-01". */
async function nextCreditNoteCode(restaurantId) {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const seq = await nextSequence(`pos_cn_${restaurantId}_${ymd}`);
    return `CN-${ymd}-${String(seq).padStart(2, '0')}`;
}

/**
 * Issue a credit note against this store — usually for returned goods. The
 * amount becomes a spendable balance the customer redeems on a later bill.
 */
export async function issueCreditNote(restaurantId, dto = {}) {
    await loadRestaurant(restaurantId);
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new ValidationError('Credit note amount must be above zero');

    let sourceOrderId = null;
    let sourceBillNo = '';
    if (dto.sourceOrderId && isId(dto.sourceOrderId)) {
        const src = await FoodOrder.findOne({ _id: dto.sourceOrderId, restaurantId }).select('order_id pos.billNo').lean();
        if (!src) throw new NotFoundError('That order was not found at this store');
        sourceOrderId = src._id;
        sourceBillNo = src.pos?.billNo || src.order_id || '';
    }

    const note = await FoodPosCreditNote.create({
        restaurantId,
        code: await nextCreditNoteCode(restaurantId),
        amount,
        balance: amount,
        reason: String(dto.reason || '').trim().slice(0, 300),
        customerPhone: digitsOf(dto.customerPhone),
        customerName: String(dto.customerName || '').trim(),
        sourceOrderId,
        sourceBillNo,
        issuedBy: String(dto.issuedBy || '').trim()
    });
    return { creditNote: note.toObject() };
}

/** Look one note up by code to show its balance before it is applied. */
export async function lookupCreditNote(restaurantId, code) {
    await loadRestaurant(restaurantId);
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) throw new ValidationError('Enter a credit-note code');
    const note = await FoodPosCreditNote.findOne({ restaurantId, code: clean }).lean();
    if (!note) throw new NotFoundError('No credit note with that code at this store');
    return { creditNote: note };
}

/** Credit notes for this store, newest first, optionally filtered by status. */
export async function listCreditNotes(restaurantId, query = {}) {
    await loadRestaurant(restaurantId);
    const filter = { restaurantId };
    const status = String(query.status || '').trim().toLowerCase();
    if (status === 'open') filter.status = { $in: CREDIT_NOTE_OPEN };
    else if (['active', 'partially_redeemed', 'redeemed', 'void'].includes(status)) filter.status = status;
    const phone = digitsOf(query.customerPhone);
    if (phone) filter.customerPhone = phone;
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const notes = await FoodPosCreditNote.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    return { creditNotes: notes };
}

/** Void an unspent note (e.g. issued by mistake). Partly used ones can't be voided. */
export async function voidCreditNote(restaurantId, id) {
    await loadRestaurant(restaurantId);
    if (!isId(id)) throw new NotFoundError('Credit note not found');
    const note = await FoodPosCreditNote.findOne({ _id: id, restaurantId });
    if (!note) throw new NotFoundError('Credit note not found');
    if (note.status === 'void') return { creditNote: note.toObject() };
    if (note.redemptions.length || note.balance !== note.amount) {
        throw new ValidationError('This note has already been used and cannot be voided');
    }
    note.status = 'void';
    note.balance = 0;
    note.voidedAt = new Date();
    await note.save();
    return { creditNote: note.toObject() };
}

/**
 * Load and check the credit notes behind any credit_note tenders on a sale,
 * before the order is written. Returns the live docs keyed to their tender
 * amount so the sale can redeem them once it sticks. Throws if any code is
 * unknown, closed, or short of balance.
 */
async function reserveCreditNoteTenders(restaurantId, tenders) {
    const lines = (tenders || []).filter((t) => t.mode === 'credit_note');
    if (!lines.length) return [];

    // Sum per code first, so two lines quoting one note can't each pass on the
    // full balance and together overspend it.
    const wanted = new Map();
    for (const t of lines) wanted.set(t.creditNoteCode, round2((wanted.get(t.creditNoteCode) || 0) + t.amount));

    const reserved = [];
    for (const [code, amount] of wanted) {
        const note = await FoodPosCreditNote.findOne({ restaurantId, code });
        if (!note) throw new ValidationError(`Credit note ${code} was not found at this store`);
        if (!CREDIT_NOTE_OPEN.includes(note.status)) {
            throw new ValidationError(`Credit note ${code} is ${note.status === 'void' ? 'void' : 'already fully redeemed'}`);
        }
        if (amount > round2(note.balance) + 0.001) {
            throw new ValidationError(`Credit note ${code} has only ₹${round2(note.balance).toFixed(2)} left`);
        }
        reserved.push({ note, amount });
    }
    return reserved;
}

/** Draw the reserved amount off each note and close it when it hits zero. */
async function redeemCreditNoteTenders(reserved, { orderId = null, billNo = '' } = {}) {
    for (const { note, amount } of (reserved || [])) {
        note.balance = round2(Math.max(0, note.balance - amount));
        note.redemptions.push({ orderId: orderId || null, billNo: billNo || '', amount, at: new Date() });
        note.status = note.balance <= 0.001 ? 'redeemed' : 'partially_redeemed';
        await note.save();
    }
}
