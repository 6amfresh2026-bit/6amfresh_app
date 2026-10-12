import mongoose from 'mongoose';

/**
 * Named atomic counters, for sequences that must never repeat.
 *
 * The item code is the first user: "PRD" followed by a zero-padded number that
 * has to be unique across the catalogue. Reading the current maximum and adding
 * one is not safe — two admins clicking "Create New" together would both read
 * the same maximum — so the number comes from a single $inc, which Mongo
 * guarantees is atomic.
 */
const counterSchema = new mongoose.Schema(
    {
        _id: { type: String, required: true },
        seq: { type: Number, default: 0 }
    },
    { collection: 'food_counters', versionKey: false }
);

export const FoodCounter = mongoose.model('FoodCounter', counterSchema);

/** Returns the next value of the named sequence, creating it on first use. */
export async function nextSequence(name) {
    const doc = await FoodCounter.findByIdAndUpdate(
        name,
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    ).lean();
    return doc.seq;
}

/** "PRD0000000042" — the vasy-style code the product list shows. */
export async function nextItemCode() {
    const seq = await nextSequence('food_item_code');
    return `PRD${String(seq).padStart(10, '0')}`;
}

/** "SUR-0001" — the readable id shown against each survey. */
export async function nextSurveyId() {
    const seq = await nextSequence('food_survey_id');
    return `SUR-${String(seq).padStart(4, '0')}`;
}
