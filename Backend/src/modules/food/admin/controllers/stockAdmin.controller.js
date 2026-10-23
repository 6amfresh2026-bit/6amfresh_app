import { sendResponse } from '../../../../utils/response.js';
import * as service from '../services/stockAdmin.service.js';
import * as batches from '../../orders/services/stockBatch.service.js';
import * as bulkImport from '../services/stockImport.service.js';
import * as weighed from '../services/weighedItems.service.js';
import * as barcodes from '../services/barcodes.service.js';
import * as billDesign from '../services/billDesign.service.js';
import * as productPricing from '../services/productPricing.service.js';

/** Thin wrappers over stockAdmin.service — Stocks list and Stock Verification. */
const handler = (fn, message, status = 200) => async (req, res, next) => {
    try {
        const data = await fn(req);
        return sendResponse(res, status, message, data);
    } catch (err) {
        next(err);
    }
};

// ─── Stocks ───
export const listStocksController = handler((req) => service.listStocks(req.query || {}), 'Stocks fetched');
export const getStockComparisonController = handler(
    (req) => service.getStoreStockComparison(String(req.query.restaurantIds || '').split(',').map((s) => s.trim()).filter(Boolean)),
    'Store comparison fetched'
);
export const adjustStockController = handler((req) => service.adjustStock(req.body || {}, req.user), 'Stock adjusted');
export const setStockMetaController = handler((req) => service.setStockMeta(req.body || {}), 'Updated');

// ─── Bulk import ───
export const bulkImportCheckController = handler((req) => bulkImport.bulkImportCheck(req.body || {}), 'Import checked');
export const bulkImportCommitController = handler((req) => bulkImport.bulkImportCommit(req.body || {}, req.user), 'Import complete');

// ─── Weighed items & rates ───
export const listWeighedController = handler((req) => weighed.listWeighed(req.query || {}), 'Weighed items fetched');
export const publishWeighedRatesController = handler((req) => weighed.publishRates(req.body || {}), 'Rates published');
export const addWeighedItemController = handler((req) => weighed.addWeighedItem(req.body || {}), 'Weighed item added', 201);

// ─── Barcodes & labels ───
export const listBarcodesController = handler((req) => barcodes.listBarcodes(req.query || {}), 'Barcodes fetched');
export const saveBarcodesController = handler((req) => barcodes.saveBarcodes(req.body || {}), 'Barcodes saved');
export const updateBarcodeController = handler((req) => barcodes.updateBarcode(req.body || {}), 'Barcode updated');

// ─── Bill designer ───
export const getBillDesignController = handler((req) => billDesign.getDesign(req.query || {}), 'Bill design fetched');
export const saveBillDesignController = handler((req) => billDesign.saveDesign(req.body || {}), 'Bill design saved');

// ─── Products & pricing ───
export const listProductPricingController = handler((req) => productPricing.listProductPricing(req.query || {}), 'Pricing fetched');
export const savePricingController = handler((req) => productPricing.savePricing(req.body || {}), 'Pricing saved');
export const pricingLookupsController = handler(() => productPricing.pricingLookups(), 'Lookups fetched');
export const addSizeController = handler((req) => productPricing.addSize(req.body || {}), 'Size added', 201);
export const listMovementsController = handler((req) => service.listMovements(req.query || {}), 'Stock movements fetched');
export const listItemMovementsController = handler(
    (req) => service.listMovements({ ...(req.query || {}), itemId: req.params.itemId }),
    'Stock movements fetched'
);

// ─── Stock verification ───
export const listVerificationsController = handler((req) => service.listVerifications(req.query || {}), 'Verifications fetched');
export const createVerificationController = handler((req) => service.createVerification(req.body || {}, req.user), 'Verification created', 201);
export const getVerificationController = handler((req) => service.getVerification(req.params.id), 'Verification fetched');
export const updateVerificationController = handler((req) => service.updateVerification(req.params.id, req.body || {}), 'Verification updated');
export const completeVerificationController = handler((req) => service.completeVerification(req.params.id, req.user), 'Verification completed — stock updated');
export const cancelVerificationController = handler((req) => service.cancelVerification(req.params.id), 'Verification cancelled');
export const deleteVerificationController = handler((req) => service.deleteVerification(req.params.id), 'Verification deleted');

// ─── Batches ───
/**
 * Receiving an intake, which is the one way stock should enter a batch-tracked
 * product: a quantity with no expiry behind it cannot be picked oldest-first.
 */
export const receiveBatchController = handler(
    (req) => batches.receiveBatch(req.body || {}),
    'Stock received',
    201,
);
export const getBatchSummaryController = handler(
    (req) => batches.getBatchSummary(req.params.itemId, { expiringWithinDays: Number(req.query?.withinDays) || 7 }),
    'Batches fetched',
);
export const listExpiringBatchesController = handler(
    (req) => batches.listExpiringBatches({
        restaurantId: req.query?.restaurantId || null,
        withinDays: Number(req.query?.withinDays) || 7,
    }),
    'Expiring batches fetched',
);
/** Takes expired stock off the shelf. Safe to run repeatedly. */
export const writeOffExpiredController = handler(
    async () => ({ written: await batches.writeOffExpiredBatches({}) }),
    'Expired batches written off',
);
