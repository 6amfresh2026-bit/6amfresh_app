/**
 * Finds stock that was handed back to the shelf after the goods had left it.
 *
 * Cancellation outranks every other order status, so a seller or an admin can
 * cancel an order a rider collected ten minutes ago -- and until today every
 * cancellation path called restoreOrderStock unconditionally. Those units were
 * in a bag on a bike. The count went up anyway, so the shop believed it had
 * cover it did not have and could sell the same goods twice.
 *
 * The code no longer does this. Nothing has corrected what it already did,
 * which is what this looks for.
 *
 * READ ONLY. It writes nothing and suggests nothing be written automatically:
 * the physical shelf is the truth here, not this arithmetic. Use it to find
 * which products to count, then correct them through Stock Verification so the
 * ledger records who decided what and when.
 *
 *   node scripts/stock-drift-audit.mjs
 *   node scripts/stock-drift-audit.mjs --json        # machine-readable
 *   node scripts/stock-drift-audit.mjs --since=2026-01-01
 */
import 'dotenv/config';

import { connectDB, disconnectDB } from '../src/config/db.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { FoodItem } from '../src/modules/food/admin/models/food.model.js';
import { FoodStockMovement } from '../src/modules/food/orders/models/stockMovement.model.js';

const COLLECTED = ['picked_up', 'reached_drop', 'delivered'];
const CANCELLED = ['cancelled_by_user', 'cancelled_by_restaurant', 'cancelled_by_admin'];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const sinceArg = args.find((a) => a.startsWith('--since='));
const since = sinceArg ? new Date(sinceArg.split('=')[1]) : null;

/**
 * Whether this order's goods had left the shop before it was cancelled.
 *
 * The same three signals the live guard uses, and for the same reason: the
 * rider app writes deliveryState.pickedUpAt, an admin override writes only the
 * status, and the cancellation itself overwrites that status -- so only the
 * history survives every route.
 */
const wasCollected = (order) =>
    Boolean(order?.deliveryState?.pickedUpAt) ||
    COLLECTED.includes(String(order?.orderStatus || '')) ||
    (order?.statusHistory || []).some(
        (h) => COLLECTED.includes(String(h?.from || '')) || COLLECTED.includes(String(h?.to || '')),
    );

/** What a line actually held: what the picker found, else what was ordered. */
const heldQty = (line) => {
    const adjusted = line?.fulfilledQuantity;
    return adjusted === null || adjusted === undefined
        ? Math.max(0, Number(line?.quantity) || 0)
        : Math.max(0, Number(adjusted) || 0);
};

async function main() {
    await connectDB();

    const filter = {
        orderStatus: { $in: CANCELLED },
        // Only orders that actually gave stock back. An order whose stock was
        // never restored cannot have inflated anything.
        stockRestoredAt: { $ne: null },
    };
    if (since && !Number.isNaN(since.getTime())) filter.updatedAt = { $gte: since };

    const cancelled = await FoodOrder.find(filter)
        .select('order_id orderStatus statusHistory deliveryState items stockRestoredAt updatedAt restaurantId')
        .lean();

    const suspect = cancelled.filter(wasCollected);

    /** itemId -> { units, orders[] } */
    const byItem = new Map();
    for (const order of suspect) {
        for (const line of order.items || []) {
            const id = String(line?.itemId || '');
            if (!id) continue;
            const units = heldQty(line);
            if (units <= 0) continue;
            const entry = byItem.get(id) || { units: 0, name: line.name || '', orders: [] };
            entry.units += units;
            entry.orders.push({
                order: order.order_id || String(order._id),
                units,
                at: order.stockRestoredAt,
                status: order.orderStatus,
            });
            byItem.set(id, entry);
        }
    }

    const rows = [];
    for (const [itemId, entry] of byItem) {
        const item = await FoodItem.findById(itemId).select('name itemCode stockQty restaurantId').lean();
        // The ledger row the bug wrote, if it is still there -- useful when
        // correcting, because it names the moment the count moved.
        const ledger = await FoodStockMovement.countDocuments({
            itemId,
            type: 'sale_return',
            'reference.kind': 'order',
        });
        rows.push({
            itemId,
            name: item?.name || entry.name || '(deleted product)',
            itemCode: item?.itemCode || '',
            currentStockQty: item?.stockQty ?? null,
            unitsWronglyReturned: entry.units,
            impliedTrueStock:
                item?.stockQty === null || item?.stockQty === undefined
                    ? null
                    : item.stockQty - entry.units,
            affectedOrders: entry.orders,
            saleReturnLedgerRows: ledger,
        });
    }

    rows.sort((a, b) => b.unitsWronglyReturned - a.unitsWronglyReturned);

    if (asJson) {
        console.log(JSON.stringify({ scanned: cancelled.length, suspect: suspect.length, rows }, null, 2));
    } else {
        console.log(`Cancelled orders that returned stock: ${cancelled.length}`);
        console.log(`Of those, collected before cancelling:  ${suspect.length}`);
        console.log('');
        if (rows.length === 0) {
            console.log('No drift found. Every cancellation that returned stock was for goods still in the shop.');
        } else {
            console.log('Products to count. "Implied" assumes nothing else moved the number,');
            console.log('which is why it is a starting point for a physical count, not a correction.');
            console.log('');
            for (const r of rows) {
                console.log(`${r.name}${r.itemCode ? ` (${r.itemCode})` : ''}`);
                console.log(
                    `   counted now: ${r.currentStockQty ?? 'untracked'}   ` +
                        `wrongly returned: +${r.unitsWronglyReturned}   ` +
                        `implied: ${r.impliedTrueStock ?? 'n/a'}`,
                );
                for (const o of r.affectedOrders) {
                    console.log(`   - ${o.order}  ${o.units} unit(s)  ${o.status}  ${new Date(o.at).toISOString()}`);
                }
                console.log('');
            }
            console.log(`${rows.length} product(s) affected, ${rows.reduce((n, r) => n + r.unitsWronglyReturned, 0)} unit(s) total.`);
            console.log('Correct them through Stock Verification, so the ledger records the decision.');
        }
    }

    await disconnectDB();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('audit failed:', err);
    try {
        await disconnectDB();
    } catch {}
    process.exit(1);
});
