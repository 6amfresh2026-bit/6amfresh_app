import mongoose from 'mongoose';
import { FoodProductSubscription } from '../models/productSubscription.model.js';
import { FoodSubscriptionOccurrence } from '../models/subscriptionOccurrence.model.js';
import { FoodItem } from '../../admin/models/food.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodUser } from '../../../../core/users/user.model.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { createOrder } from '../../orders/services/order.service.js';
import { getSlotForSubscription } from '../../admin/services/deliverySlot.service.js';
import { logger } from '../../../../utils/logger.js';

const DEFAULT_HORIZON_DAYS = 14;

const toObjectId = (value, label = 'Id') => {
    if (!value || !mongoose.Types.ObjectId.isValid(String(value))) {
        throw new ValidationError(`Invalid ${label}`);
    }
    return new mongoose.Types.ObjectId(String(value));
};

const startOfDay = (date) => {
    const d = new Date(date);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
};

const addDays = (date, days) => {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
};

/** Next occurrence date >= from, matching the subscription's recurrence rule. */
function nextOccurrenceOnOrAfter(subscription, from) {
    const start = startOfDay(subscription.startDate);
    let candidate = startOfDay(from) < start ? start : startOfDay(from);

    if (subscription.frequency === 'daily') {
        return candidate;
    }

    if (subscription.frequency === 'weekly') {
        const days = (subscription.daysOfWeek?.length ? subscription.daysOfWeek : [start.getDay()]);
        for (let i = 0; i < 7; i++) {
            if (days.includes(candidate.getDay())) return candidate;
            candidate = addDays(candidate, 1);
        }
        return candidate; // unreachable in practice
    }

    // monthly
    const day = subscription.dayOfMonth || start.getDate();
    let year = candidate.getFullYear();
    let month = candidate.getMonth();
    let result = new Date(year, month, Math.min(day, 28));
    if (result < candidate) {
        month += 1;
        result = new Date(year, month, Math.min(day, 28));
    }
    return result;
}

function stepToNext(subscription, currentDate) {
    if (subscription.frequency === 'daily') return addDays(currentDate, 1);
    if (subscription.frequency === 'weekly') return nextOccurrenceOnOrAfter(subscription, addDays(currentDate, 1));
    // monthly
    const d = new Date(currentDate);
    return new Date(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

async function resolveAddress(userId, addressId) {
    const user = await FoodUser.findById(userId).select('addresses').lean();
    const address = (user?.addresses || []).find((a) => String(a._id) === String(addressId));
    if (!address) throw new ValidationError('Saved address not found');
    return address;
}

/** Generates occurrences for one subscription up to (and including) horizonDate. Idempotent. */
async function generateOccurrencesForSubscription(subscription, horizonDate) {
    let cursor = subscription.occurrencesGeneratedUntil
        ? stepToNext(subscription, subscription.occurrencesGeneratedUntil)
        : nextOccurrenceOnOrAfter(subscription, subscription.startDate);

    const toInsert = [];
    let lastDate = subscription.occurrencesGeneratedUntil || null;
    let guard = 0;
    while (startOfDay(cursor) <= startOfDay(horizonDate) && guard < 400) {
        toInsert.push({
            subscriptionId: subscription._id,
            userId: subscription.userId,
            restaurantId: subscription.restaurantId,
            scheduledDate: startOfDay(cursor),
            deliveryTime: subscription.deliveryTime,
        });
        lastDate = cursor;
        cursor = stepToNext(subscription, cursor);
        guard += 1;
    }

    if (toInsert.length) {
        // Unique index on (subscriptionId, scheduledDate) makes this safe to
        // re-run: any occurrence already created is skipped, not duplicated.
        await FoodSubscriptionOccurrence.insertMany(toInsert, { ordered: false }).catch((err) => {
            if (err?.code !== 11000) throw err;
        });
        await FoodProductSubscription.updateOne(
            { _id: subscription._id },
            { $set: { occurrencesGeneratedUntil: lastDate } },
        );
    }

    return { created: toInsert.length };
}

export async function createSubscription(userId, dto) {
    const restaurantId = toObjectId(dto.restaurantId, 'restaurantId');
    const restaurant = await FoodRestaurant.findById(restaurantId).select('_id').lean();
    if (!restaurant) throw new NotFoundError('Restaurant not found');

    const itemId = toObjectId(dto.itemId, 'itemId');
    const item = await FoodItem.findOne({ _id: itemId, restaurantId }).select('name subscriptionEnabled').lean();
    if (!item) throw new ValidationError('Item does not belong to this restaurant');
    if (item.subscriptionEnabled !== true) {
        throw new ValidationError('This product is not available for subscription');
    }

    await resolveAddress(userId, dto.addressId); // throws if not found

    // A slot decides the time; a bare deliveryTime is still honoured for the
    // callers that predate slots. deliveryTime carries the start of the window
    // either way, so nothing downstream has to know which was used.
    const slot = dto.deliverySlotId ? await getSlotForSubscription(dto.deliverySlotId) : null;

    if (dto.frequency === 'weekly' && (!dto.daysOfWeek || !dto.daysOfWeek.length)) {
        throw new ValidationError('daysOfWeek is required for a weekly subscription');
    }
    if (dto.frequency === 'monthly' && !dto.dayOfMonth) {
        throw new ValidationError('dayOfMonth is required for a monthly subscription');
    }

    const subscription = await FoodProductSubscription.create({
        userId,
        restaurantId,
        itemId,
        itemName: item.name || '',
        variantId: dto.variantId || '',
        quantity: dto.quantity || 1,
        frequency: dto.frequency,
        daysOfWeek: dto.frequency === 'weekly' ? dto.daysOfWeek : [],
        dayOfMonth: dto.frequency === 'monthly' ? dto.dayOfMonth : null,
        deliveryTime: slot ? slot.startTime : dto.deliveryTime,
        ...(slot
            ? {
                deliverySlot: {
                    slotId: slot.id,
                    label: slot.label,
                    startTime: slot.startTime,
                    endTime: slot.endTime
                }
            }
            : {}),
        startDate: startOfDay(dto.startDate),
        addressId: dto.addressId,
        paymentMethod: dto.paymentMethod || 'cash',
    });

    const horizon = addDays(new Date(), DEFAULT_HORIZON_DAYS);
    await generateOccurrencesForSubscription(subscription, horizon);

    return { subscription: subscription.toObject() };
}

/**
 * Attaches the current item image / price / MRP / pack-size to each
 * subscription so the customer app renders real product thumbnails and prices.
 * The subscription document itself only stores itemId + a name snapshot.
 */
async function attachItemDetails(subscriptions) {
    const many = Array.isArray(subscriptions);
    const list = many ? subscriptions : [subscriptions];
    const itemIds = [...new Set(list.map((s) => String(s.itemId)).filter(Boolean))];
    if (!itemIds.length) return subscriptions;

    const items = await FoodItem.find({ _id: { $in: itemIds } })
        .select('name image images price mrp otherPrice packSize variants')
        .lean();
    const byId = new Map(items.map((i) => [String(i._id), i]));

    const enrich = (s) => {
        const it = byId.get(String(s.itemId));
        if (!it) return s;
        let price = typeof it.price === 'number' ? it.price : 0;
        const mrp = typeof it.mrp === 'number' ? it.mrp : 0;
        if (s.variantId && Array.isArray(it.variants)) {
            const v = it.variants.find((variant) => String(variant._id) === String(s.variantId));
            if (v && typeof v.price === 'number') price = v.price;
        }
        return {
            ...s,
            itemImage: it.image || (Array.isArray(it.images) && it.images.length ? it.images[0] : ''),
            itemPrice: price,
            itemMrp: mrp,
            itemPackSize: it.packSize || '',
        };
    };

    return many ? list.map(enrich) : enrich(subscriptions);
}

export async function listSubscriptions(userId) {
    const subscriptions = await FoodProductSubscription.find({ userId }).sort({ createdAt: -1 }).lean();
    return { subscriptions: await attachItemDetails(subscriptions) };
}

export async function getSubscription(userId, subscriptionId) {
    const id = toObjectId(subscriptionId, 'subscriptionId');
    const subscription = await FoodProductSubscription.findOne({ _id: id, userId }).lean();
    if (!subscription) throw new NotFoundError('Subscription not found');
    const occurrences = await FoodSubscriptionOccurrence.find({ subscriptionId: id })
        .sort({ scheduledDate: 1 })
        .lean();
    return { subscription: await attachItemDetails(subscription), occurrences };
}

export async function updateSubscription(userId, subscriptionId, dto) {
    const id = toObjectId(subscriptionId, 'subscriptionId');
    const subscription = await FoodProductSubscription.findOne({ _id: id, userId });
    if (!subscription) throw new NotFoundError('Subscription not found');

    if (dto.status !== undefined) subscription.status = dto.status;
    if (dto.quantity !== undefined) subscription.quantity = dto.quantity;
    if (dto.deliveryTime !== undefined) subscription.deliveryTime = dto.deliveryTime;
    if (dto.addressId !== undefined) {
        await resolveAddress(userId, dto.addressId);
        subscription.addressId = dto.addressId;
    }

    await subscription.save();

    if (dto.status === 'cancelled' || dto.status === 'paused') {
        await FoodSubscriptionOccurrence.updateMany(
            { subscriptionId: id, status: 'scheduled', scheduledDate: { $gte: startOfDay(new Date()) } },
            { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: `Subscription ${dto.status}` } },
        );
    }

    return { subscription: subscription.toObject() };
}

export async function deleteSubscription(userId, subscriptionId) {
    const id = toObjectId(subscriptionId, 'subscriptionId');
    const subscription = await FoodProductSubscription.findOne({ _id: id, userId });
    if (!subscription) throw new NotFoundError('Subscription not found');

    await FoodSubscriptionOccurrence.updateMany(
        { subscriptionId: id, status: 'scheduled' },
        { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Subscription deleted' } },
    );
    subscription.status = 'cancelled';
    await subscription.save();

    return { success: true };
}

export async function listOccurrences(userId, subscriptionId) {
    const id = toObjectId(subscriptionId, 'subscriptionId');
    const subscription = await FoodProductSubscription.findOne({ _id: id, userId }).select('_id').lean();
    if (!subscription) throw new NotFoundError('Subscription not found');
    const occurrences = await FoodSubscriptionOccurrence.find({ subscriptionId: id }).sort({ scheduledDate: 1 }).lean();
    return { occurrences };
}

/**
 * Cancels one specific upcoming delivery. Allowed any time up to midnight
 * starting the scheduled delivery day — i.e. "the night before" — after
 * which it's too late, matching the product requirement literally.
 */
export async function cancelOccurrence(userId, subscriptionId, occurrenceId, reason, now = new Date()) {
    const subId = toObjectId(subscriptionId, 'subscriptionId');
    const occId = toObjectId(occurrenceId, 'occurrenceId');

    const occurrence = await FoodSubscriptionOccurrence.findOne({ _id: occId, subscriptionId: subId, userId });
    if (!occurrence) throw new NotFoundError('Scheduled delivery not found');
    if (occurrence.status !== 'scheduled') {
        throw new ValidationError(`This delivery is already ${occurrence.status.replace('_', ' ')}`);
    }

    const cutoff = startOfDay(occurrence.scheduledDate);
    if (now.getTime() >= cutoff.getTime()) {
        throw new ValidationError('Too late to cancel — this can only be cancelled the night before the scheduled delivery');
    }

    occurrence.status = 'cancelled';
    occurrence.cancelledAt = now;
    occurrence.cancelReason = reason || '';
    await occurrence.save();

    return { occurrence: occurrence.toObject() };
}

/** Extends occurrence generation for every active subscription to the rolling horizon. */
export async function generateUpcomingOccurrences(now = new Date(), horizonDays = DEFAULT_HORIZON_DAYS) {
    const horizon = addDays(now, horizonDays);
    const subscriptions = await FoodProductSubscription.find({ status: 'active' }).lean();

    let subscriptionsExtended = 0;
    let occurrencesCreated = 0;
    for (const subscription of subscriptions) {
        const { created } = await generateOccurrencesForSubscription(subscription, horizon);
        if (created > 0) {
            subscriptionsExtended += 1;
            occurrencesCreated += created;
        }
    }
    return { subscriptionsExtended, occurrencesCreated };
}

/** Converts every due, still-scheduled occurrence into a real order. */
export async function placeDueSubscriptionOrders(now = new Date()) {
    const due = await FoodSubscriptionOccurrence.find({
        status: 'scheduled',
        scheduledDate: { $lte: startOfDay(now) },
    }).lean();

    let placed = 0;
    let failed = 0;
    for (const occurrence of due) {
        try {
            const subscription = await FoodProductSubscription.findById(occurrence.subscriptionId).lean();
            if (!subscription || subscription.status !== 'active') {
                await FoodSubscriptionOccurrence.updateOne(
                    { _id: occurrence._id },
                    { $set: { status: 'cancelled', cancelledAt: now, cancelReason: 'Subscription no longer active' } },
                );
                continue;
            }

            const address = await resolveAddress(subscription.userId, subscription.addressId);
            const result = await createOrder(subscription.userId, {
                restaurantId: String(subscription.restaurantId),
                items: [{
                    itemId: String(subscription.itemId),
                    variantId: subscription.variantId || undefined,
                    quantity: subscription.quantity,
                }],
                address,
                paymentMethod: subscription.paymentMethod,
                // The window the customer signed up for, carried onto the order
                // so the rider board and their own screen say the same thing a
                // one-off slot booking would. Snapshotted rather than resolved
                // by id: a slot retired since they subscribed must not fail the
                // order, it just keeps delivering when it always did.
                ...(subscription.deliverySlot?.slotId
                    ? {
                        deliverySlotSnapshot: subscription.deliverySlot,
                        scheduledAt: occurrence.scheduledDate,
                    }
                    : {}),
            });

            await FoodSubscriptionOccurrence.updateOne(
                { _id: occurrence._id },
                { $set: { status: 'order_placed', orderId: result?.order?._id || null } },
            );
            placed += 1;
        } catch (err) {
            failed += 1;
            logger.warn(`placeDueSubscriptionOrders failed for occurrence ${occurrence._id}: ${err?.message || err}`);
            await FoodSubscriptionOccurrence.updateOne(
                { _id: occurrence._id },
                { $set: { status: 'failed', failureReason: String(err?.message || err) } },
            );
        }
    }

    return { placed, failed };
}
