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
    const order = await FoodOrder.findById(oId).select('restaurantId').lean();
    if (!order) throw new NotFoundError('Order not found');

    const allowed = process.env.NODE_ENV === 'production' ? ['approved'] : ['approved', 'pending'];
    const partners = await FoodDeliveryPartner.find({ status: { $in: allowed } })
        .select('name phone status availabilityStatus restaurantId')
        .sort({ availabilityStatus: -1, name: 1 })
        .limit(200)
        .lean();

    const storeKey = String(order.restaurantId || '');
    const withLoad = await Promise.all(
        partners.map(async (p) => ({
            ...p,
            isSellerFleet: String(p.restaurantId || '') === storeKey,
            activeOrderCount: await activeOrderCount(p._id)
        }))
    );

    withLoad.sort((a, b) => {
        if (a.isSellerFleet !== b.isSellerFleet) return a.isSellerFleet ? -1 : 1;
        if (a.activeOrderCount !== b.activeOrderCount) return a.activeOrderCount - b.activeOrderCount;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    return { riders: withLoad };
}
