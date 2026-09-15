/**
 * Is the scheduled-jobs process alive?
 *
 * That process runs separately from the API, and until now nothing could
 * answer this without a shell on the box. It matters more than it used to: an
 * order the seller never accepts gets its rider from a sweep in there, so a
 * scheduler that quietly died means orders that quietly never reach anybody.
 *
 * READ ONLY. Answers from the database, so it works from anywhere that can
 * reach the database -- a laptop, a CI job, a monitoring check.
 *
 *   node scripts/scheduler-status.mjs
 *   node scripts/scheduler-status.mjs --json
 *
 * Exit code is 0 when healthy and 1 when not, so it can be wired to an alert.
 */
import 'dotenv/config';

import { connectDB, disconnectDB } from '../src/config/db.js';
import { FoodSettings } from '../src/modules/food/orders/models/order.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';

const asJson = process.argv.includes('--json');

// The heartbeat rides on a 30-second tick. Two missed beats is noise; four is a
// process that has stopped.
const STALE_AFTER_MS = 2 * 60 * 1000;

const human = (ms) => {
    if (ms === null) return 'never';
    const s = Math.round(ms / 1000);
    if (s < 90) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m} min ago`;
    return `${Math.round(m / 60)} h ago`;
};

async function main() {
    await connectDB();

    const beat = await FoodSettings.findOne({ key: 'scheduler_heartbeat' })
        .select('heartbeatAt heartbeatHost heartbeatPid heartbeatJobs')
        .lean();

    const age = beat?.heartbeatAt ? Date.now() - new Date(beat.heartbeatAt).getTime() : null;
    const healthy = age !== null && age <= STALE_AFTER_MS;

    // The symptom, not just the signal. A heartbeat can be missing simply
    // because the scheduler has not been redeployed since it started writing
    // one, so the backlog is what says whether anything is actually going
    // undone: unaccepted orders should never pile up if the sweep is running.
    const stranded = await FoodOrder.countDocuments({
        orderStatus: 'created',
        'dispatch.status': 'unassigned',
        'dispatch.deliveryPartnerId': null,
        createdAt: { $lte: new Date(Date.now() - 10 * 60 * 1000) },
        $or: [{ scheduledAt: null }, { scheduledAt: { $lte: new Date() } }],
    });

    const result = {
        healthy,
        lastBeatAt: beat?.heartbeatAt || null,
        lastBeatAge: age,
        host: beat?.heartbeatHost || null,
        pid: beat?.heartbeatPid ?? null,
        jobs: beat?.heartbeatJobs || [],
        strandedUnacceptedOrders: stranded,
    };

    if (asJson) {
        console.log(JSON.stringify(result, null, 2));
    } else if (!beat?.heartbeatAt) {
        console.log('SCHEDULER: no heartbeat has ever been recorded.');
        console.log('');
        console.log('Either it is not running, or it is running a build from before');
        console.log('the heartbeat existed. Check the process itself:');
        console.log('   pm2 list                  # or: systemctl status <unit>');
        console.log('   pm2 logs <name> --lines 50');
        console.log('Start it with:  npm run start:scheduler');
        console.log('');
        console.log(`Orders waiting with no rider for over 10 min: ${stranded}`);
        if (stranded > 0) {
            console.log('Those should have been dispatched by the sweep. It is not running.');
        }
    } else {
        console.log(`SCHEDULER: ${healthy ? 'alive' : 'STALE'}`);
        console.log(`   last beat: ${human(age)} (${new Date(beat.heartbeatAt).toISOString()})`);
        console.log(`   on:        ${beat.heartbeatHost || 'unknown host'} pid ${beat.heartbeatPid ?? '?'}`);
        console.log(`   sweeps:    ${(beat.heartbeatJobs || []).join(', ') || 'unknown'}`);
        console.log('');
        console.log(`Orders waiting with no rider for over 10 min: ${stranded}`);
        if (!healthy) {
            console.log('');
            console.log('A beat older than two minutes means the 30-second tick has stopped.');
            console.log('   pm2 logs <name> --lines 50      # look for an unhandled rejection');
            console.log('   npm run start:scheduler         # to bring it back');
        }
    }

    await disconnectDB();
    process.exit(healthy ? 0 : 1);
}

main().catch(async (err) => {
    console.error('scheduler status check failed:', err);
    try {
        await disconnectDB();
    } catch {}
    process.exit(2);
});
