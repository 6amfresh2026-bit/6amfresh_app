import mongoose from 'mongoose';
import { FoodDeliveryPartner } from '../../delivery/models/deliveryPartner.model.js';
import { FoodOrder } from '../../orders/models/order.model.js';
import {
    CANCELLED_ORDER_STATUSES,
    pushStatusHistory,
    normalizeOrderForClient,
    buildDeliverySocketPayload,
    notifyOwnersActionableAlert,
} from '../../orders/services/order.helpers.js';
import { getIO, rooms } from '../../../../config/socket.js';
import { logger } from '../../../../utils/logger.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';

const ACTIVE_ORDER_STATUSES_EXCLUDING_DELIVERED = [...CANCELLED_ORDER_STATUSES, 'delivered'];

/** Rider's current workload: orders assigned to them that aren't done or cancelled. */
async function countActiveOrders(deliveryPartnerId) {
    return FoodOrder.countDocuments({
        'dispatch.deliveryPartnerId': deliveryPartnerId,
        orderStatus: { $nin: ACTIVE_ORDER_STATUSES_EXCLUDING_DELIVERED },
    });
}

/** Links an existing, already-approved delivery partner into this seller's own fleet. */
export async function linkDeliveryPartner(restaurantId, phone) {
    const partner = await FoodDeliveryPartner.findOne({ phone: String(phone || '').trim() });
    if (!partner) throw new NotFoundError('No delivery partner found with that phone number');
    if (partner.status !== 'approved') {
        throw new ValidationError('This delivery partner is not yet approved');
    }
    if (partner.restaurantId && String(partner.restaurantId) !== String(restaurantId)) {
        throw new ValidationError('This delivery partner is already linked to another seller');
    }

    partner.restaurantId = restaurantId;
    await partner.save();
    return { partner: partner.toObject() };
}

export async function unlinkDeliveryPartner(restaurantId, deliveryPartnerId) {
    const result = await FoodDeliveryPartner.updateOne(
        { _id: deliveryPartnerId, restaurantId },
        { $set: { restaurantId: null, availabilityStatus: 'offline' } },
    );
    if (result.matchedCount === 0) {
        throw new NotFoundError('Delivery partner not found in your fleet');
    }
    return { success: true };
}

/** This seller's own riders, each with their current workload for manual-assignment picking. */
export async function listFleet(restaurantId) {
    const partners = await FoodDeliveryPartner.find({ restaurantId })
        .select('name phone availabilityStatus vehicleType vehicleNumber lastLat lastLng lastLocationAt rating totalDeliveries')
        .sort({ availabilityStatus: -1, name: 1 })
        .lean();

    const withWorkload = await Promise.all(
        partners.map(async (partner) => ({
            ...partner,
            activeOrderCount: await countActiveOrders(partner._id),
        })),
    );

    return { fleet: withWorkload };
}

/**
 * Manually assigns one of the seller's own riders to a confirmed order — the
 * only assignment path for a restaurant running a manual-only fleet, since
 * tryAutoAssign() skips such restaurants entirely (order-dispatch.service.js).
 */
export async function assignDeliveryPartnerManually(restaurantId, orderId, deliveryPartnerId, actorId) {
    if (!mongoose.Types.ObjectId.isValid(String(orderId))) throw new ValidationError('Invalid order id');
    if (!mongoose.Types.ObjectId.isValid(String(deliveryPartnerId))) throw new ValidationError('Invalid delivery partner id');

    const order = await FoodOrder.findOne({ _id: orderId, restaurantId });
    if (!order) throw new NotFoundError('Order not found');
    if (CANCELLED_ORDER_STATUSES.includes(order.orderStatus) || order.orderStatus === 'delivered') {
        throw new ValidationError(`Order cannot be assigned — it is already ${order.orderStatus}`);
    }
    if (order.dispatch?.status === 'accepted') {
        throw new ValidationError('Order already accepted by a delivery partner');
    }

    const partner = await FoodDeliveryPartner.findOne({ _id: deliveryPartnerId, restaurantId }).select('status').lean();
    if (!partner) throw new ValidationError('This delivery partner is not part of your fleet');
    if (partner.status !== 'approved') throw new ValidationError('Delivery partner not available');

    order.dispatch.status = 'assigned';
    order.dispatch.assignmentMode = 'manual';
    order.dispatch.assignedByRole = 'RESTAURANT';
    order.dispatch.deliveryPartnerId = new mongoose.Types.ObjectId(deliveryPartnerId);
    order.dispatch.assignedAt = new Date();
    order.dispatch.dispatchingAt = undefined;
    pushStatusHistory(order, {
        byRole: 'RESTAURANT',
        byId: actorId,
        from: order.orderStatus,
        to: order.orderStatus,
        note: 'Delivery partner manually assigned by seller',
    });
    await order.save();

    // The rider has to be told. Auto-dispatch shouts at every eligible rider and
    // races them to accept; this is the opposite — one named rider has been
    // handed one order — so it says that rather than "new order available", and
    // there is no countdown to win.
    //
    // Fire-and-forget: a rider who misses the alert still sees the order in
    // their list, and a notification failure must not undo an assignment the
    // seller has already made.
    void (async () => {
        try {
            const payload = buildDeliverySocketPayload(order, null);
            const io = getIO();
            if (io) {
                io.to(rooms.delivery(String(deliveryPartnerId))).emit('order_assigned', payload);
            }
            await notifyOwnersActionableAlert(
                [{ ownerType: 'DELIVERY_PARTNER', ownerId: String(deliveryPartnerId) }],
                {
                    title: 'An order has been assigned to you',
                    body: `Order #${order.order_id || order.orderId || order._id} is yours — head to the store.`,
                    data: {
                        type: 'order_assigned',
                        orderId: String(order._id),
                        orderMongoId: String(order._id),
                    },
                },
            );
        } catch (err) {
            logger.warn(`Manual assignment notice failed for order ${order._id}: ${err?.message || err}`);
        }
    })();

    return { order: normalizeOrderForClient(order) };
}
