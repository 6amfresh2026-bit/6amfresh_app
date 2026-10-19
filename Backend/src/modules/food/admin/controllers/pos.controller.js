import { sendResponse } from '../../../../utils/response.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import * as pos from '../../restaurant/services/pos.service.js';

/**
 * Admin-side POS: the same till the seller runs, but for any store the admin
 * picks. Every call names the restaurant it is for — admin has no shop of its
 * own — and otherwise flows through the exact same pos.service the seller uses,
 * so pricing, stock, the register, credit notes and loyalty behave identically.
 */

/** The store this POS call is for: a body field, query param, or header. */
const restaurantOf = (req) => {
    const id = String(
        req.body?.restaurantId || req.query?.restaurantId || req.headers['x-restaurant-id'] || ''
    ).trim();
    if (!id) throw new ValidationError('restaurantId is required');
    return id;
};

/** Thin wrapper: run the service call for the chosen store and send the result. */
const handler = (fn, message, status = 200) => async (req, res, next) => {
    try {
        return sendResponse(res, status, message, await fn(req));
    } catch (err) {
        next(err);
    }
};

// ─── quote & sale ───
export const quoteAdminPosOrderController = handler((req) => pos.quotePosOrder(restaurantOf(req), req.body || {}), 'Quote ready');
export const listAdminPosCouponsController = handler((req) => pos.listPosCoupons(restaurantOf(req), req.body || {}), 'Coupons');
export const createAdminPosOrderController = handler((req) => {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) throw new ValidationError('At least one item is required');
    return pos.createPosOrder(restaurantOf(req), req.body || {});
}, 'POS order created successfully', 201);

// ─── orders & payments ───
export const listAdminPosOrdersController = handler((req) => pos.listPosOrders(restaurantOf(req), req.query || {}), 'POS orders');
export const getLastAdminPosBillController = handler((req) => pos.getLastPosBill(restaurantOf(req)), 'Last bill');
export const getAdminPosBillController = handler((req) => pos.getPosBill(restaurantOf(req), req.params.orderId), 'Bill');
export const recordAdminPosPaymentController = handler((req) => pos.recordPosPayment(restaurantOf(req), req.params.orderId, req.body || {}), 'Payment recorded');

// ─── customers ───
export const searchAdminPosCustomersController = handler((req) => pos.searchPosCustomers(restaurantOf(req), req.query.q, req.query.limit), 'Customers');
export const lookupAdminPosCustomerController = handler((req) => pos.lookupPosCustomer(req.query.phone), 'Lookup');
export const saveAdminPosCustomerController = handler((req) => pos.savePosCustomer(req.body || {}), 'Customer saved');
export const getAdminPosCustomerSummaryController = handler((req) => pos.getPosCustomerSummary(restaurantOf(req), req.params.customerId), 'Customer summary');

// ─── held bills ───
export const holdAdminPosBillController = handler((req) => pos.holdPosBill(restaurantOf(req), req.body || {}), 'Bill held', 201);
export const listAdminHeldBillsController = handler((req) => pos.listHeldBills(restaurantOf(req)), 'Held bills');
export const getAdminHeldBillReceiptController = handler((req) => pos.getHeldBillReceipt(restaurantOf(req), req.params.heldId), 'Held bill');
export const resumeAdminHeldBillController = handler((req) => pos.takeHeldBill(restaurantOf(req), req.params.heldId), 'Bill resumed');
export const discardAdminHeldBillController = handler((req) => pos.discardHeldBill(restaurantOf(req), req.params.heldId), 'Held bill discarded');

// ─── register / shift ───
export const getAdminCurrentShiftController = handler((req) => pos.getCurrentShift(restaurantOf(req)), 'Current register');
export const openAdminShiftController = handler((req) => pos.openShift(restaurantOf(req), req.body || {}), 'Register opened', 201);
export const getAdminShiftSummaryController = handler((req) => pos.getShiftSummary(restaurantOf(req)), 'Register summary');
export const closeAdminShiftController = handler((req) => pos.closeShift(restaurantOf(req), req.body || {}), 'Register closed');
export const recordAdminCashMovementController = handler((req) => pos.recordCashMovement(restaurantOf(req), req.body || {}), 'Cash movement recorded');

// ─── credit notes ───
export const issueAdminCreditNoteController = handler((req) => pos.issueCreditNote(restaurantOf(req), req.body || {}), 'Credit note issued', 201);
export const lookupAdminCreditNoteController = handler((req) => pos.lookupCreditNote(restaurantOf(req), req.params.code), 'Credit note');
export const listAdminCreditNotesController = handler((req) => pos.listCreditNotes(restaurantOf(req), req.query || {}), 'Credit notes');
export const voidAdminCreditNoteController = handler((req) => pos.voidCreditNote(restaurantOf(req), req.params.id), 'Credit note voided');

// ─── loyalty ───
export const getAdminLoyaltyAccountController = handler((req) => pos.getLoyaltyAccount(restaurantOf(req), req.params.userId), 'Loyalty account');

// ─── register report (cash drawer sessions across stores) ───
// Reads across stores, so it takes no restaurantId by default; a restaurantId
// query param narrows it to one store.
export const listAdminPosShiftsController = handler((req) => pos.listPosShifts(req.query || {}), 'Register sessions');
