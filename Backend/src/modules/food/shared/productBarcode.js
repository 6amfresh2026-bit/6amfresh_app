import mongoose from 'mongoose';
import { FoodItem } from '../admin/models/food.model.js';
import { nextSequence } from '../admin/models/counter.model.js';
import { ValidationError } from '../../../core/auth/errors.js';

/**
 * Barcodes for products that arrive without one.
 *
 * The code is an EAN-13 so any shop scanner reads it: "29" (GS1's range for in-store
 * use, which can never collide with a manufacturer's code), ten digits from an atomic
 * counter, and the check digit. A counter rather than random digits means two sellers
 * generating at once can never get the same code, and the check against existing
 * products only has to catch a code someone typed in by hand.
 */
export const BARCODE_PREFIX = '29';
const BARCODE_COUNTER = 'food_item_barcode';
const MAX_ITEMS_PER_CALL = 500;

/** The EAN-13 check digit for the first twelve digits. */
export const ean13CheckDigit = (first12) => {
    const sum = [...String(first12)].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
    return (10 - (sum % 10)) % 10;
};

export const isValidEan13 = (value) => {
    const v = String(value ?? '');
    return /^\d{13}$/.test(v) && ean13CheckDigit(v.slice(0, 12)) === Number(v[12]);
};

/** The barcode for a counter value. */
export const barcodeFromSequence = (seq) => {
    const digits = `${BARCODE_PREFIX}${String(seq).padStart(10, '0')}`;
    if (digits.length !== 12) throw new Error(`barcode counter ${seq} no longer fits in 12 digits`);
    return `${digits}${ean13CheckDigit(digits)}`;
};

/** A new barcode no product already carries. */
export async function generateBarcode() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const code = barcodeFromSequence(await nextSequence(BARCODE_COUNTER));
        if (!(await FoodItem.exists({ barcode: code }))) return code;
    }
    throw new Error('Could not find an unused barcode');
}

const hasNoBarcode = { $or: [{ barcode: '' }, { barcode: null }, { barcode: { $exists: false } }] };

/**
 * Gives each of the named products a barcode if it has none, and returns the barcode
 * every one of them now has - the label printer needs all of them, not just the new ones.
 *
 * `restaurantId` restricts the call to one seller's products; admins leave it out.
 * Deleted products are ignored. Ids that are not found are simply absent from the result.
 */
export async function assignMissingBarcodes(itemIds, { restaurantId = null } = {}) {
    const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map(String))];
    if (!ids.length) throw new ValidationError('Choose at least one product');
    if (ids.length > MAX_ITEMS_PER_CALL) throw new ValidationError(`Choose at most ${MAX_ITEMS_PER_CALL} products at a time`);
    if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) throw new ValidationError('Invalid product id');

    const scope = { _id: { $in: ids }, isDeleted: { $ne: true } };
    if (restaurantId) scope.restaurantId = restaurantId;

    const items = await FoodItem.find(scope).select('barcode').lean();
    const result = new Map(items.map((it) => [String(it._id), { id: String(it._id), barcode: it.barcode || '', generated: false }]));

    for (const row of result.values()) {
        if (row.barcode) continue;
        const code = await generateBarcode();
        // Conditional, so two requests racing for the same product cannot both write: the
        // loser reads back the winner's code instead of overwriting it.
        const done = await FoodItem.updateOne({ _id: row.id, ...hasNoBarcode }, { $set: { barcode: code } });
        if (done.modifiedCount === 1) {
            row.barcode = code;
            row.generated = true;
        } else {
            const current = await FoodItem.findById(row.id).select('barcode').lean();
            row.barcode = current?.barcode || '';
        }
    }

    return [...result.values()];
}

/**
 * Barcode (or item code, for products that only have that) per product id, for printing
 * item lines on a bill. Missing ids are simply absent.
 */
export async function barcodesForItems(itemIds) {
    const ids = [...new Set((itemIds || []).map(String).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
    if (!ids.length) return new Map();
    const items = await FoodItem.find({ _id: { $in: ids } }).select('barcode itemCode').lean();
    return new Map(items.map((it) => [String(it._id), it.barcode || it.itemCode || '']));
}
