import { FoodTransaction } from '../models/foodTransaction.model.js';
import { FoodRestaurantCommission } from '../../admin/models/restaurantCommission.model.js';
import { resolveDiscountSplitByCoupon } from '../../shared/discountSplit.util.js';
import mongoose from 'mongoose';

const RESTAURANT_COMMISSION_CACHE_MS = 60 * 1000;
let restaurantCommissionRulesCache = null;
let restaurantCommissionRulesLoadedAt = 0;

async function getActiveRestaurantCommissionRules() {
  const now = Date.now();
  if (
    restaurantCommissionRulesCache &&
    now - restaurantCommissionRulesLoadedAt < RESTAURANT_COMMISSION_CACHE_MS
  ) {
    return restaurantCommissionRulesCache;
  }

  const list = await FoodRestaurantCommission.find({
    status: { $ne: false },
  }).lean();
  restaurantCommissionRulesCache = list || [];
  restaurantCommissionRulesLoadedAt = now;
  return restaurantCommissionRulesCache;
}

export function computeRestaurantCommissionAmount(baseAmount, rule) {
  const safeBase = Math.max(0, Number(baseAmount) || 0);
  if (!Number.isFinite(safeBase) || safeBase < 0) return 0;

  const commissionType = rule?.defaultCommission?.type || 'percentage';
  const commissionValue = Math.max(
    0,
    Number(rule?.defaultCommission?.value ?? 0) || 0
  );

  let commissionAmount = 0;
  if (commissionType === 'percentage') {
    commissionAmount = safeBase * (commissionValue / 100);
  } else if (commissionType === 'amount') {
    commissionAmount = commissionValue;
  }

  // Round to 2 decimals and clamp to [0, base]
  commissionAmount = Math.round((commissionAmount || 0) * 100) / 100;
  commissionAmount = Math.max(0, Math.min(commissionAmount, safeBase));

  return { commissionAmount, commissionType, commissionValue, baseAmount: safeBase };
}

export async function getRestaurantCommissionSnapshot(orderDoc) {
  const baseAmount = Number(orderDoc?.pricing?.subtotal ?? 0) || 0;
  const restaurantIdRaw =
    orderDoc?.restaurantId?._id ?? orderDoc?.restaurantId ?? null;

  if (!restaurantIdRaw) {
    return {
      commissionAmount: 0,
      commissionType: 'percentage',
      commissionValue: 0,
      baseAmount,
    };
  }

  const rules = await getActiveRestaurantCommissionRules();
  const rule =
    rules.find((r) => String(r.restaurantId) === String(restaurantIdRaw)) ||
    // Fallback: accept legacy docs where restaurantId may be stored under `restaurant` / `restaurant_id`
    rules.find((r) => String(r.restaurant || r.restaurant_id || '') === String(restaurantIdRaw)) ||
    null;

  if (!rule) {
    return {
      commissionAmount: 0,
      commissionType: 'percentage',
      commissionValue: 0,
      baseAmount,
    };
  }

  return computeRestaurantCommissionAmount(baseAmount, rule);
}

/**
 * Creates an initial 'pending' transaction when an order is created.
 */
/**
 * The money split for an order, from its pricing as it stands right now.
 *
 * Extracted so the initial transaction and a reprice share one definition.
 * A short pick changes what the customer pays, what the seller is owed and
 * what commission is due, and two copies of this arithmetic would drift into
 * two different answers about the same order.
 */
export async function computeTransactionAmounts(order) {
    const { commissionAmount = 0 } = await getRestaurantCommissionSnapshot(order).catch(() => ({ commissionAmount: 0 }));
    
    // Split logic - Ensure all values are finite numbers
    const totalCustomerPaid = Number(order.pricing?.total) || 0;
    const riderShare = Number(order.riderEarning) || 0;
    
    // Prefer commission already computed & stored on the order (source of truth for this order),
    // fallback to rule snapshot for older orders.
    const restaurantCommissionFromOrder = Number(order.pricing?.restaurantCommission);
    const restaurantCommission =
        Number.isFinite(restaurantCommissionFromOrder) && restaurantCommissionFromOrder > 0
            ? restaurantCommissionFromOrder
            : (Number(commissionAmount) || 0);

    const discount = Number(order.pricing?.discount) || 0;
    const subtotal = Number(order.pricing?.subtotal) || 0;
    const packagingFee = Number(order.pricing?.packagingFee) || 0;
    const platformFee = Number(order.pricing?.platformFee) || 0;
    const deliveryFee = Number(order.pricing?.deliveryFee) || 0;
    const deliveryFeeGst = Number(order.pricing?.deliveryFeeGst) || 0;
    const tax = Number(order.pricing?.tax) || 0;

    let restaurantNet = subtotal + packagingFee - restaurantCommission;
    let platformNetProfit = platformFee + deliveryFee + deliveryFeeGst + restaurantCommission - riderShare;
    let adminDiscountShare = 0;
    let restaurantDiscountShare = 0;
    let discountAdminBearPercentage = 0;
    let discountRestaurantBearPercentage = 0;

    // Handle discount attribution via the shared split util (single source of truth).
    const couponCode = order.pricing?.couponCode;
    if (discount > 0 && couponCode) {
        const split = await resolveDiscountSplitByCoupon({ couponCode, discount });
        adminDiscountShare = split.adminDiscountShare;
        restaurantDiscountShare = split.restaurantDiscountShare;
        discountAdminBearPercentage = split.adminBearPercentage;
        discountRestaurantBearPercentage = split.restaurantBearPercentage;
    }
    restaurantNet -= restaurantDiscountShare;
    platformNetProfit -= adminDiscountShare;

    // Ensure nets are finite and rounded
    restaurantNet = Math.round((Number(restaurantNet) || 0) * 100) / 100;
    platformNetProfit = Math.round((Number(platformNetProfit) || 0) * 100) / 100;

    return {
        totalCustomerPaid, riderShare, restaurantCommission, discount, subtotal,
        packagingFee, platformFee, deliveryFee, deliveryFeeGst, tax, couponCode,
        restaurantNet, platformNetProfit, adminDiscountShare, restaurantDiscountShare,
        discountAdminBearPercentage, discountRestaurantBearPercentage,
    };
}

export async function createInitialTransaction(order) {
    if (!order) return null;

    const {
        totalCustomerPaid, riderShare, restaurantCommission, discount, subtotal,
        packagingFee, platformFee, deliveryFee, deliveryFeeGst, tax, couponCode,
        restaurantNet, platformNetProfit, adminDiscountShare, restaurantDiscountShare,
        discountAdminBearPercentage, discountRestaurantBearPercentage,
    } = await computeTransactionAmounts(order);

    const transaction = new FoodTransaction({
        orderId: order._id,
        userId: order.userId,
        restaurantId: order.restaurantId,
        deliveryPartnerId: order.dispatch?.deliveryPartnerId,
        paymentMethod: order.payment?.method || 'cash',
        status: order.payment?.status === 'paid' ? 'captured' : 'pending',
        payment: {
            method: String(order.payment?.method || 'cash'),
            status: String(order.payment?.status || 'cod_pending'),
            amountDue: Number(order.payment?.amountDue ?? totalCustomerPaid) || 0,
            razorpay: {
                orderId: String(order.payment?.razorpay?.orderId || ''),
                paymentId: String(order.payment?.razorpay?.paymentId || ''),
                signature: String(order.payment?.razorpay?.signature || ''),
            },
            qr: {
                qrId: String(order.payment?.qr?.qrId || ''),
                imageUrl: String(order.payment?.qr?.imageUrl || ''),
                paymentLinkId: String(order.payment?.qr?.paymentLinkId || ''),
                shortUrl: String(order.payment?.qr?.shortUrl || ''),
                status: String(order.payment?.qr?.status || ''),
                expiresAt: order.payment?.qr?.expiresAt || null,
            }
        },
        pricing: {
            subtotal: subtotal,
            tax: tax,
            packagingFee: packagingFee,
            deliveryFee: deliveryFee,
            deliveryFeeGst: deliveryFeeGst,
            platformFee: platformFee,
            restaurantCommission: restaurantCommission,
            discount: discount,
            couponCode: couponCode ? String(couponCode).toUpperCase() : null,
            total: totalCustomerPaid,
            currency: String(order.pricing?.currency || order.currency || 'INR'),
        },
        amounts: {
            totalCustomerPaid: totalCustomerPaid,
            restaurantShare: Math.max(0, restaurantNet),
            restaurantCommission: restaurantCommission,
            riderShare: riderShare,
            platformNetProfit: platformNetProfit,
            taxAmount: tax,
            adminDiscountShare,
            restaurantDiscountShare,
            discountAdminBearPercentage,
            discountRestaurantBearPercentage
        },
        gateway: {
            razorpayOrderId: order.payment?.razorpay?.orderId,
            qrUrl: order.payment?.qr?.imageUrl
        },
        history: [{
            kind: 'created',
            amount: totalCustomerPaid,
            note: 'Initial transaction created with order'
        }]
    });

    await transaction.save();

    // Link back to the order
    try {
        await mongoose.model('FoodOrder').updateOne(
            { _id: order._id },
            { $set: { transactionId: transaction._id } }
        );
    } catch (err) {
        // Log but don't fail transaction if the backlink fails
    }

    return transaction;
}

/**
 * Re-splits the money after an order's bill changed under it.
 *
 * A short pick or a substitution reprices the order, and the settlement side
 * reads `amounts` on the transaction in preference to `pricing` on the order —
 * so without this the seller would keep being charged commission on goods they
 * never sold, and the payout would describe a basket that was never delivered.
 *
 * Leaves a settled transaction alone: once the money has moved, a correction
 * is a credit note rather than a silent rewrite of history.
 */
export async function repriceTransactionForOrder(order) {
    if (!order?._id) return null;

    const transaction = await FoodTransaction.findOne({ orderId: order._id });
    if (!transaction) return null;
    if (String(transaction.status) === 'settled') return transaction;

    const a = await computeTransactionAmounts(order);

    transaction.pricing = {
        ...(transaction.pricing?.toObject?.() || transaction.pricing || {}),
        subtotal: a.subtotal,
        tax: a.tax,
        packagingFee: a.packagingFee,
        deliveryFee: a.deliveryFee,
        deliveryFeeGst: a.deliveryFeeGst,
        platformFee: a.platformFee,
        restaurantCommission: a.restaurantCommission,
        discount: a.discount,
        total: a.totalCustomerPaid,
    };
    transaction.amounts = {
        ...(transaction.amounts?.toObject?.() || transaction.amounts || {}),
        totalCustomerPaid: a.totalCustomerPaid,
        restaurantShare: Math.max(0, a.restaurantNet),
        restaurantCommission: a.restaurantCommission,
        riderShare: a.riderShare,
        platformNetProfit: a.platformNetProfit,
        taxAmount: a.tax,
        adminDiscountShare: a.adminDiscountShare,
        restaurantDiscountShare: a.restaurantDiscountShare,
    };
    if (transaction.payment) {
        transaction.payment.amountDue = Number(order.payment?.amountDue ?? a.totalCustomerPaid) || 0;
    }
    transaction.history.push({
        kind: 'created',
        amount: a.totalCustomerPaid,
        note: 'Re-split after the order was repriced at the shelf',
    });

    await transaction.save();
    return transaction;
}

/**
 * Updates transaction status (captured, settled, etc) and appends to history.
 */
export async function updateTransactionStatus(orderId, kind, details = {}) {
    const query = { orderId };
    const transaction = await FoodTransaction.findOne(query);
    if (!transaction) return null;

    if (details.status) transaction.status = details.status;
    if (details.razorpayPaymentId) transaction.gateway.razorpayPaymentId = details.razorpayPaymentId;
    if (details.razorpaySignature) transaction.gateway.razorpaySignature = details.razorpaySignature;
    
    transaction.history.push({
        kind,
        amount: transaction.amounts.totalCustomerPaid,
        at: new Date(),
        note: details.note || `Transaction updated: ${kind}`,
        recordedBy: { role: details.recordedByRole || 'SYSTEM', id: details.recordedById }
    });

    await transaction.save();

    return transaction;
}

/**
 * Updates the rider in the transaction when an order is accepted.
 */
export async function updateTransactionRider(orderId, riderId) {
    const query = { orderId };
    return await FoodTransaction.findOneAndUpdate(
        query,
        { $set: { deliveryPartnerId: riderId } },
        { new: true }
    );
}

/**
 * Marks restaurant as settled in the finance record.
 */
export async function settleRestaurant(orderId, adminId) {
    return await updateTransactionStatus(orderId, 'settled', {
        status: 'captured', // Ensure it's marked as captured if it was pending cash
        note: 'Restaurant payout settled by admin',
        recordedByRole: 'ADMIN',
        recordedById: adminId
    });
}
