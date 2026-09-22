import mongoose from 'mongoose';

import { FoodDeliveryPartner } from '../../delivery/models/deliveryPartner.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { FoodOrder } from '../../orders/models/order.model.js';
import {
    CANCELLED_ORDER_STATUSES,
    pushStatusHistory,
    normalizeOrderForClient,
    buildDeliverySocketPayload,
    notifyOwnersActionableAlert
} from '../../orders/services/order.helpers.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { logger } from '../../../../utils/logger.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { AVAILABILITY_LABELS, isDispatchable } from '../../../../constants/deliveryAvailability.js';

/**
 * Seller-wise rider management, from the admin side.
 *
 * A seller could already link riders to themselves by phone number, which
 * assumes the shop knows which riders are theirs and that every rider is
 * reachable that way. The admin runs the fleet across all the shops, so they
 * need the opposite view: who is spare, who belongs to whom, and the ability
 * to move one.
 */

const ACTIVE_STATUSES = [...CANCELLED_ORDER_STATUSES, 'delivered'];

const oid = (value, label) => {
    if (!value || !mongoose.Types.ObjectId.isValid(String(value))) {
        throw new ValidationError(`Invalid ${label}`);
    }
    return new mongoose.Types.ObjectId(String(value));
};

/** Orders a rider is holding right now — what makes them busy or free. */
/** Straight-line km between two points; null when either is unknown. */
function distanceKmFrom(lat1, lng1, lat2, lng2) {
    if (![lat1, lng1, lat2, lng2].every((v) => Number.isFinite(Number(v)))) return null;
    // A rider sitting on the null island has no location, they have a default.
    if (Number(lat2) === 0 && Number(lng2) === 0) return null;
    const toRad = (d) => (Number(d) * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 10) / 10;
}

async function activeOrderCount(partnerId) {
    return FoodOrder.countDocuments({
        'dispatch.deliveryPartnerId': partnerId,
        orderStatus: { $nin: ACTIVE_STATUSES }
    });
}

/**
 * One seller's riders, plus everyone still unattached.
 *
 * Both halves in one call because they are read together: the admin is looking
 * at a shop and deciding who else should be on it, and a separate "spare
 * riders" screen would make them hold the list in their head.
 *
 * Riders attached to a *different* seller are deliberately absent. Moving
 * somebody off another shop's fleet is a decision about that shop, and it
 * should start from that shop's screen rather than be a side effect here.
 */
export async function listSellerFleet(restaurantId) {
    const rId = oid(restaurantId, 'restaurant id');
    const restaurant = await FoodRestaurant.findById(rId).select('restaurantName').lean();
    if (!restaurant) throw new NotFoundError('Seller not found');

    const [assigned, unassigned] = await Promise.all([
        FoodDeliveryPartner.find({ restaurantId: rId })
            .select('name phone status availabilityStatus vehicleType vehicleNumber rating totalDeliveries lastLocationAt')
            .sort({ availabilityStatus: -1, name: 1 })
            .lean(),
        FoodDeliveryPartner.find({ restaurantId: null, status: 'approved' })
            .select('name phone status availabilityStatus vehicleType vehicleNumber')
            .sort({ name: 1 })
            .limit(200)
            .lean()
    ]);

    const fleet = await Promise.all(
        assigned.map(async (partner) => ({
            ...partner,
            activeOrderCount: await activeOrderCount(partner._id)
        }))
    );

    return {
        restaurantId: String(rId),
        restaurantName: restaurant.restaurantName || '',
        fleet,
        available: unassigned
    };
}

/** Puts a rider on this seller's fleet. */
export async function assignRiderToSeller(restaurantId, deliveryPartnerId) {
    const rId = oid(restaurantId, 'restaurant id');
    const pId = oid(deliveryPartnerId, 'delivery partner id');

    const restaurant = await FoodRestaurant.findById(rId).select('_id').lean();
    if (!restaurant) throw new NotFoundError('Seller not found');

    const partner = await FoodDeliveryPartner.findById(pId).select('name status restaurantId').lean();
    if (!partner) throw new NotFoundError('Delivery partner not found');
    if (partner.status !== 'approved') {
        throw new ValidationError('This delivery partner is not approved yet');
    }
    if (partner.restaurantId && String(partner.restaurantId) !== String(rId)) {
        // Named rather than a bare refusal: the admin's next question is always
        // "then whose is it", and answering it here saves a hunt.
        const owner = await FoodRestaurant.findById(partner.restaurantId).select('restaurantName').lean();
        throw new ValidationError(
            `${partner.name || 'That rider'} is already on ${owner?.restaurantName || 'another seller'}'s fleet. ` +
                'Remove them there first.'
        );
    }

    await FoodDeliveryPartner.updateOne({ _id: pId }, { $set: { restaurantId: rId } });
    return listSellerFleet(rId);
}

/**
 * Takes a rider off a seller's fleet.
 *
 * Refused while they are carrying that seller's orders: unlinking mid-delivery
 * leaves an order assigned to somebody the shop can no longer see, which is the
 * one state nobody can fix from a screen.
 */
export async function removeRiderFromSeller(restaurantId, deliveryPartnerId) {
    const rId = oid(restaurantId, 'restaurant id');
    const pId = oid(deliveryPartnerId, 'delivery partner id');

    const partner = await FoodDeliveryPartner.findOne({ _id: pId, restaurantId: rId }).select('name').lean();
    if (!partner) throw new NotFoundError('That rider is not on this seller\'s fleet');

    const carrying = await activeOrderCount(pId);
    if (carrying > 0) {
        throw new ValidationError(
            `${partner.name || 'That rider'} is still carrying ${carrying} order(s) for this seller. ` +
                'Finish or reassign them first.'
        );
    }

    await FoodDeliveryPartner.updateOne({ _id: pId }, { $set: { restaurantId: null } });
    return listSellerFleet(rId);
}

/**
 * Admin assigns any rider to any order.
 *
 * Wider than the seller's own version on purpose. The seller may only pick
 * from their own fleet; the admin is the escalation path when that fleet is
 * out, so they can reach a rider the shop has no relationship with.
 */
export async function adminAssignOrderToRider(orderId, deliveryPartnerId, adminId) {
    const oId = oid(orderId, 'order id');
    const pId = oid(deliveryPartnerId, 'delivery partner id');

    const order = await FoodOrder.findById(oId);
    if (!order) throw new NotFoundError('Order not found');
    if (CANCELLED_ORDER_STATUSES.includes(order.orderStatus) || order.orderStatus === 'delivered') {
        throw new ValidationError(`Order cannot be assigned — it is already ${order.orderStatus}`);
    }
    if (order.dispatch?.status === 'accepted') {
        throw new ValidationError('A rider has already accepted this order. De-assign them first.');
    }

    const partner = await FoodDeliveryPartner.findById(pId).select('name status').lean();
    if (!partner) throw new NotFoundError('Delivery partner not found');
    if (partner.status !== 'approved' && process.env.NODE_ENV === 'production') {
        throw new ValidationError('This delivery partner is not approved yet');
    }

    order.dispatch.status = 'assigned';
    order.dispatch.assignmentMode = 'manual';
    order.dispatch.assignedByRole = 'ADMIN';
    order.dispatch.deliveryPartnerId = pId;
    order.dispatch.assignedAt = new Date();
    order.dispatch.dispatchingAt = undefined;
    pushStatusHistory(order, {
        byRole: 'ADMIN',
        byId: adminId,
        from: order.orderStatus,
        to: order.orderStatus,
        note: `Delivery partner manually assigned by admin: ${partner.name || pId}`
    });
    await order.save();

    // Fire-and-forget, same as every other assignment notice: a rider who
    // misses it still finds the order in their list, and a push failure must
    // not undo an assignment the admin has already made.
    void (async () => {
        try {
            const io = getIO();
            if (io) {
                io.to(rooms.delivery(String(pId))).emit('order_assigned', buildDeliverySocketPayload(order, null));
            }
            await notifyOwnersActionableAlert(
                [{ ownerType: 'DELIVERY_PARTNER', ownerId: String(pId) }],
                {
                    title: 'An order has been assigned to you',
                    body: `Order #${order.order_id || order._id} is yours — head to the store.`,
                    data: {
                        type: 'order_assigned',
                        orderId: String(order._id),
                        orderMongoId: String(order._id)
                    }
                }
            );
        } catch (err) {
            logger.warn(`Admin assignment notice failed for order ${order._id}: ${err?.message || err}`);
        }
    })();

    return { order: normalizeOrderForClient(order) };
}

/**
 * Riders an admin may put on this order, nearest-ish first.
 *
 * The seller's own fleet is listed first because that is who should normally
 * take it; everyone else follows, so the admin can reach outside the fleet when
 * it is empty without that being the default thing their eye lands on.
 */
export async function listAssignableRiders(orderId) {
    const oId = oid(orderId, 'order id');
    const order = await FoodOrder.findById(oId)
        .select('restaurantId dispatch.deliveryPartnerId dispatch.reassignments')
        .lean();
    if (!order) throw new NotFoundError('Order not found');

    // Distance is measured from the pickup, not from the customer: the first
    // thing this rider has to do is reach the shop.
    const store = order.restaurantId
        ? await FoodRestaurant.findById(order.restaurantId).select('location').lean()
        : null;
    const storeLng = store?.location?.coordinates?.[0];
    const storeLat = store?.location?.coordinates?.[1];
    const haveStorePoint = Number.isFinite(storeLat) && Number.isFinite(storeLng)
        && !(storeLat === 0 && storeLng === 0);

    const allowed = process.env.NODE_ENV === 'production' ? ['approved'] : ['approved', 'pending'];
    const partners = await FoodDeliveryPartner.find({ status: { $in: allowed } })
        .select('name phone status availabilityStatus restaurantId lastLat lastLng lastLocationAt')
        .limit(200)
        .lean();

    const storeKey = String(order.restaurantId || '');
    const currentPartnerKey = String(order.dispatch?.deliveryPartnerId || '');

    const withLoad = await Promise.all(
        partners.map(async (p) => {
            const availability = p.availabilityStatus || 'offline';
            return {
                ...p,
                isSellerFleet: String(p.restaurantId || '') === storeKey,
                // The rider already on the order is listed but never offered as
                // a destination; reassigning to the same person is a no-op the
                // service rejects anyway.
                isCurrent: String(p._id) === currentPartnerKey,
                availabilityStatus: availability,
                availabilityLabel: AVAILABILITY_LABELS[availability] || availability,
                // Only 'online' can be dispatched to. A paused rider can still
                // be chosen deliberately -- that is a human decision -- but the
                // panel has to say so rather than letting it look normal.
                isDispatchable: isDispatchable(availability),
                distanceKm: haveStorePoint ? distanceKmFrom(storeLat, storeLng, p.lastLat, p.lastLng) : null,
                activeOrderCount: await activeOrderCount(p._id)
            };
        })
    );

    withLoad.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? 1 : -1;
        if (a.isDispatchable !== b.isDispatchable) return a.isDispatchable ? -1 : 1;
        if (a.isSellerFleet !== b.isSellerFleet) return a.isSellerFleet ? -1 : 1;
        // Nearest first once the categories match; a rider whose location is
        // unknown sorts after every rider whose location is known.
        const da = a.distanceKm === null ? Infinity : a.distanceKm;
        const db = b.distanceKm === null ? Infinity : b.distanceKm;
        if (da !== db) return da - db;
        if (a.activeOrderCount !== b.activeOrderCount) return a.activeOrderCount - b.activeOrderCount;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    // The history rides along with the picker because it is read in the same
    // place and by the same decision: an order that has already bounced twice
    // is not a candidate for a third guess.
    const entries = order.dispatch?.reassignments || [];
    const nameIds = [
        ...new Set(
            entries
                .flatMap((e) => [e.fromPartnerId, e.toPartnerId])
                .filter(Boolean)
                .map(String)
        )
    ];
    const nameById = new Map(
        nameIds.length
            ? (await FoodDeliveryPartner.find({ _id: { $in: nameIds } }).select('name').lean())
                .map((p) => [String(p._id), p.name || ''])
            : []
    );

    const history = entries.map((e) => ({
        at: e.at || null,
        reason: e.reason || '',
        byRole: e.byRole || 'ADMIN',
        fromName: e.fromPartnerId ? nameById.get(String(e.fromPartnerId)) || 'Unknown rider' : '',
        toName: e.toPartnerId ? nameById.get(String(e.toPartnerId)) || 'Unknown rider' : ''
    }));

    return { riders: withLoad, pickupKnown: haveStorePoint, history };
}

/**
 * Moves a live order from one rider to another, in one action.
 *
 * adminAssignOrderToRider deliberately refuses an order a rider has already
 * accepted, because silently taking work off somebody mid-trip is not an
 * assignment. But that is exactly the case ops needs when a rider goes on
 * break, breaks down or cannot collect, and making them de-assign first left
 * the order unassigned in between -- visible to the auto-dispatch sweep, which
 * could hand it to somebody else before the admin finished choosing.
 *
 * So this does both halves itself, and records why.
 */
export async function adminReassignOrder(orderId, deliveryPartnerId, reason, adminId) {
    const oId = oid(orderId, 'order id');
    const pId = oid(deliveryPartnerId, 'delivery partner id');
    const why = String(reason || '').trim();
    if (why.length < 3) {
        // The reason is the whole value of the history; an empty one makes the
        // record indistinguishable from noise.
        throw new ValidationError('A reason is required to reassign an order');
    }

    const order = await FoodOrder.findById(oId);
    if (!order) throw new NotFoundError('Order not found');
    if (CANCELLED_ORDER_STATUSES.includes(order.orderStatus) || order.orderStatus === 'delivered') {
        throw new ValidationError(`Order cannot be reassigned — it is already ${order.orderStatus}`);
    }
    if (order.deliveryState?.pickedUpAt) {
        // Past pickup the goods are on the road with the first rider; handing
        // the order to somebody else does not hand them the bag.
        throw new ValidationError('This order has already been picked up and cannot be reassigned');
    }

    const fromPartnerId = order.dispatch?.deliveryPartnerId || null;
    if (fromPartnerId && String(fromPartnerId) === String(pId)) {
        throw new ValidationError('That rider already has this order');
    }

    const partner = await FoodDeliveryPartner.findById(pId).select('name status availabilityStatus').lean();
    if (!partner) throw new NotFoundError('Delivery partner not found');
    if (partner.status !== 'approved' && process.env.NODE_ENV === 'production') {
        throw new ValidationError('This delivery partner is not approved yet');
    }

    const previous = fromPartnerId
        ? await FoodDeliveryPartner.findById(fromPartnerId).select('name').lean()
        : null;

    if (fromPartnerId) {
        order.dispatch.offeredTo = order.dispatch.offeredTo || [];
        order.dispatch.offeredTo.push({ partnerId: fromPartnerId, at: new Date(), action: 'deassigned' });
    }

    order.dispatch.status = 'assigned';
    order.dispatch.assignmentMode = 'manual';
    order.dispatch.assignedByRole = 'ADMIN';
    order.dispatch.deliveryPartnerId = pId;
    order.dispatch.assignedAt = new Date();
    order.dispatch.acceptedAt = undefined;
    order.dispatch.dispatchingAt = undefined;

    order.dispatch.reassignments = order.dispatch.reassignments || [];
    order.dispatch.reassignments.push({
        at: new Date(),
        fromPartnerId: fromPartnerId || null,
        toPartnerId: pId,
        reason: why,
        byRole: 'ADMIN',
        byId: adminId || null
    });

    pushStatusHistory(order, {
        byRole: 'ADMIN',
        byId: adminId,
        from: order.orderStatus,
        to: order.orderStatus,
        note: `Reassigned from ${previous?.name || 'unassigned'} to ${partner.name || pId}: ${why}`
    });

    await order.save();

    // Both riders are told, and neither notice is allowed to undo a
    // reassignment the admin has already made.
    void (async () => {
        try {
            const io = getIO();
            if (io) {
                io.to(rooms.delivery(String(pId))).emit('order_assigned', buildDeliverySocketPayload(order, null));
                if (fromPartnerId) {
                    io.to(rooms.delivery(String(fromPartnerId))).emit('order_unassigned', {
                        orderId: String(order._id)
                    });
                }
            }
            await notifyOwnersActionableAlert(
                [{ ownerType: 'DELIVERY_PARTNER', ownerId: String(pId) }],
                {
                    title: 'An order has been assigned to you',
                    body: `Order #${order.order_id || order._id} is yours — head to the store.`,
                    data: { type: 'order_assigned', orderId: String(order._id), orderMongoId: String(order._id) }
                }
            );
            if (fromPartnerId) {
                await notifyOwnersActionableAlert(
                    [{ ownerType: 'DELIVERY_PARTNER', ownerId: String(fromPartnerId) }],
                    {
                        title: 'An order was moved off you',
                        body: `Order #${order.order_id || order._id} has been reassigned.`,
                        data: { type: 'order_unassigned', orderId: String(order._id) }
                    }
                );
            }
        } catch (err) {
            logger.warn(`Reassignment notice failed for order ${order._id}: ${err?.message || err}`);
        }
    })();

    return {
        order: normalizeOrderForClient(order),
        from: previous ? { id: String(fromPartnerId), name: previous.name || '' } : null,
        to: { id: String(pId), name: partner.name || '' },
        reason: why
    };
}
