import { sendResponse } from '../../../../utils/response.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    quotePosOrder,
    listPosCoupons,
    createPosOrder,
    recordPosPayment,
    searchPosCustomers,
    lookupPosCustomer,
    savePosCustomer,
    getPosCustomerSummary,
    getLastPosBill,
    getPosBill,
    listPosOrders,
    holdPosBill,
    listHeldBills,
    getHeldBillReceipt,
    takeHeldBill,
    discardHeldBill,
    getCurrentShift,
    openShift,
    getShiftSummary,
    closeShift,
    recordCashMovement,
    issueCreditNote,
    lookupCreditNote,
    listCreditNotes,
    voidCreditNote,
    getLoyaltyAccount
} from '../services/pos.service.js';

/** Every handler here acts as the signed-in seller, on their own shop only. */
const shopOf = (req) => req.user.userId;

/**
 * The body with who is at the till. A POS user (cashier login) is taken from the session; whatever
 * a client sends as _actor is thrown away, so a bill can never be pinned on someone else.
 */
const withActor = (req) => {
    const { _actor, ...body } = req.body || {};
    return req.user?.posUserId ? {
            ...body,
            _actor: {
                id: req.user.posUserId,
                name: req.user.posUserName || '',
                permissions: req.user.posPermissions || [],
                limits: req.user.posLimits || {}
            }
        } : body;
};

export const quotePosOrderController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Quote ready', await quotePosOrder(shopOf(req), withActor(req)));
    } catch (err) {
        next(err);
    }
};

export const listPosCouponsController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Coupons', await listPosCoupons(shopOf(req), req.body || {}));
    } catch (err) {
        next(err);
    }
};

export const createPosOrderController = async (req, res, next) => {
    try {
        const { items } = req.body || {};
        if (!Array.isArray(items) || !items.length) {
            throw new ValidationError('At least one item is required');
        }
        return sendResponse(res, 201, 'POS order created successfully', await createPosOrder(shopOf(req), withActor(req)));
    } catch (err) {
        next(err);
    }
};

export const recordPosPaymentController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Payment recorded', await recordPosPayment(shopOf(req), req.params.orderId, req.body || {}));
    } catch (err) {
        next(err);
    }
};

export const searchPosCustomersController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Customers', await searchPosCustomers(shopOf(req), req.query.q, req.query.limit));
    } catch (err) {
        next(err);
    }
};

export const lookupPosCustomerController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Lookup', await lookupPosCustomer(req.query.phone));
    } catch (err) {
        next(err);
    }
};

export const savePosCustomerController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Customer saved', await savePosCustomer(req.body || {}));
    } catch (err) {
        next(err);
    }
};

export const getPosCustomerSummaryController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Customer summary', await getPosCustomerSummary(shopOf(req), req.params.customerId));
    } catch (err) {
        next(err);
    }
};

export const getLastPosBillController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Last bill', await getLastPosBill(shopOf(req)));
    } catch (err) {
        next(err);
    }
};

export const getPosBillController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Bill', await getPosBill(shopOf(req), req.params.orderId));
    } catch (err) {
        next(err);
    }
};

export const listPosOrdersController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'POS orders', await listPosOrders(shopOf(req), req.query || {}));
    } catch (err) {
        next(err);
    }
};

export const holdPosBillController = async (req, res, next) => {
    try {
        return sendResponse(res, 201, 'Bill held', await holdPosBill(shopOf(req), req.body || {}));
    } catch (err) {
        next(err);
    }
};

export const listHeldBillsController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Held bills', await listHeldBills(shopOf(req)));
    } catch (err) {
        next(err);
    }
};

export const getHeldBillReceiptController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Held bill', await getHeldBillReceipt(shopOf(req), req.params.heldId));
    } catch (err) {
        next(err);
    }
};

export const takeHeldBillController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Bill resumed', await takeHeldBill(shopOf(req), req.params.heldId));
    } catch (err) {
        next(err);
    }
};

export const discardHeldBillController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Held bill discarded', await discardHeldBill(shopOf(req), req.params.heldId));
    } catch (err) {
        next(err);
    }
};

export const getCurrentShiftController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Current register', await getCurrentShift(shopOf(req)));
    } catch (err) {
        next(err);
    }
};

export const openShiftController = async (req, res, next) => {
    try {
        return sendResponse(res, 201, 'Register opened', await openShift(shopOf(req), withActor(req)));
    } catch (err) {
        next(err);
    }
};

export const getShiftSummaryController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Register summary', await getShiftSummary(shopOf(req)));
    } catch (err) {
        next(err);
    }
};

export const closeShiftController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Register closed', await closeShift(shopOf(req), withActor(req)));
    } catch (err) {
        next(err);
    }
};

export const recordCashMovementController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Cash movement recorded', await recordCashMovement(shopOf(req), withActor(req)));
    } catch (err) {
        next(err);
    }
};

export const issueCreditNoteController = async (req, res, next) => {
    try {
        return sendResponse(res, 201, 'Credit note issued', await issueCreditNote(shopOf(req), withActor(req)));
    } catch (err) {
        next(err);
    }
};

export const lookupCreditNoteController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Credit note', await lookupCreditNote(shopOf(req), req.params.code));
    } catch (err) {
        next(err);
    }
};

export const listCreditNotesController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Credit notes', await listCreditNotes(shopOf(req), req.query || {}));
    } catch (err) {
        next(err);
    }
};

export const voidCreditNoteController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Credit note voided', await voidCreditNote(shopOf(req), req.params.id));
    } catch (err) {
        next(err);
    }
};

export const getLoyaltyAccountController = async (req, res, next) => {
    try {
        return sendResponse(res, 200, 'Loyalty account', await getLoyaltyAccount(shopOf(req), req.params.userId));
    } catch (err) {
        next(err);
    }
};
