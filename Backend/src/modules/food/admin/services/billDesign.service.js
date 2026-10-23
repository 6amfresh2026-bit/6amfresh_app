import mongoose from 'mongoose';

import { BillDesign } from '../models/billDesign.model.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Bill designer — the POS receipt layout, saved per store with an all-stores
 * default behind it.
 *
 * The server keeps the config as handed to it; validation of individual toggles
 * lives with the designer that produces them. A store with nothing saved reads
 * the default; with no default saved either, the built-in "classic" layout.
 */

const oid = (v, label) => {
    if (!mongoose.Types.ObjectId.isValid(String(v || ''))) throw new ValidationError(`Invalid ${label}`);
    return new mongoose.Types.ObjectId(String(v));
};

/** The layout a brand-new install prints with, and what "Reset to classic" restores. */
export const CLASSIC = {
    preset: 'classic',
    paperWidth: 'pos',
    textSize: 'normal',
    font: 'mono',
    dividers: 'dashed',
    headingAlign: 'center',
    boldTotal: true,
    logoUrl: '',
    logoHeight: 44,
    businessName: '',
    tagline: '',
    billTitle: 'TAX INVOICE',
    gstin: '',
    extraHeader: '',
    showStoreName: true,
    showStoreAddress: true,
    showStorePhone: true,
    showBillNo: true,
    showDateTime: true,
    showCashier: true,
    showCustomerName: true,
    showCustomerPhone: true,
    showTable: true,
    showPackSize: true,
    showItemsQty: true,
    showTotalMrp: true,
    showYouSaved: true,
    showGstTable: true,
    showGstIncluded: true,
    showPayment: true,
    showLoyalty: true,
    thankYou: 'Thank you for shopping with us!',
    extraNote: '',
    termsLine: 'Prices include GST · Goods once sold can be returned with this bill',
    showBarcode: true,
};

export async function getDesign(query = {}) {
    const restaurantId = query.restaurantId ? oid(query.restaurantId, 'restaurantId') : null;
    const [own, fallback] = await Promise.all([
        restaurantId ? BillDesign.findOne({ restaurantId }).lean() : null,
        BillDesign.findOne({ restaurantId: null }).lean(),
    ]);
    const doc = own || fallback;
    const config = { ...CLASSIC, ...(doc?.config || {}) };
    return {
        config,
        source: own ? 'store' : fallback ? 'default' : 'classic',
        updatedAt: doc?.updatedAt || null,
    };
}

export async function saveDesign({ restaurantId, config } = {}) {
    if (!config || typeof config !== 'object') throw new ValidationError('A design config is required');
    const rid = restaurantId ? oid(restaurantId, 'restaurantId') : null;
    // Only known keys are stored, so a stray field from the client cannot bloat
    // the document or sneak past the designer's shape.
    const clean = {};
    for (const key of Object.keys(CLASSIC)) if (key in config) clean[key] = config[key];
    const doc = await BillDesign.findOneAndUpdate(
        { restaurantId: rid },
        { $set: { config: clean } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    return { config: { ...CLASSIC, ...(doc.config || {}) }, source: rid ? 'store' : 'default', updatedAt: doc.updatedAt };
}
