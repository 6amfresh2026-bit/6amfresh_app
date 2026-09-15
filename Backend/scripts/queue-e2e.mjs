/**
 * End-to-end check of the BullMQ queues, against real Redis and real Mongo.
 *
 * Not a unit test: it enqueues through the same producers the app uses and
 * waits for the actual worker processes to act, so it exercises the one thing
 * unit tests cannot -- whether a worker process can do the work at all. Three
 * separate bugs hid in exactly that gap (a wrong import path, and two workers
 * with no database connection), and every one of them logged the job as
 * "completed" on the way past.
 *
 * Run the workers first, then:  node scripts/queue-e2e.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';

import { connectDB, disconnectDB } from '../src/config/db.js';
import { getRedisClient, connectRedis } from '../src/config/redis.js';
import {
    getOrderQueue,
    getTrackingQueue,
    getNotificationQueue,
    getOtpQueue
} from '../src/queues/index.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';

const results = [];
const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for a condition, rather than guessing how long a worker will take. */
async function waitFor(check, { timeoutMs = 45000, everyMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await sleep(everyMs);
    }
    return null;
}

/** A job is only proof of anything once the worker has finished with it. */
async function waitForJob(queue, jobId, timeoutMs = 45000) {
    return waitFor(
        async () => {
            const job = await queue.getJob(jobId);
            if (!job) return null;
            const state = await job.getState();
            return ['completed', 'failed'].includes(state) ? { job, state } : null;
        },
        { timeoutMs },
    );
}

async function main() {
    await connectDB();
    await connectRedis();

    const orderQueue = getOrderQueue();
    const trackingQueue = getTrackingQueue();
    const notificationQueue = getNotificationQueue();
    const otpQueue = getOtpQueue();

    if (!orderQueue || !trackingQueue) {
        console.error('Queues unavailable. Run with BULLMQ_ENABLED=true and Redis up.');
        process.exit(2);
    }

    // ── tracking: Redis hot storage must reach Mongo ──────────────────────────
    //
    // The real assertion is the write, not the job finishing. This processor
    // opens its own database connection lazily, and that lazy path is the thing
    // under test: if it did not work the job would still complete.
    const rider = await FoodDeliveryPartner.create({
        name: 'Queue E2E Rider',
        phone: `9${Date.now().toString().slice(-9)}`,
        status: 'approved'
    });
    const order = await FoodOrder.create({
        userId: new mongoose.Types.ObjectId(),
        restaurantId: new mongoose.Types.ObjectId(),
        items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Probe', price: 10, quantity: 1 }],
        pricing: { subtotal: 10, total: 10 },
        payment: { method: 'cash' },
        deliveryAddress: {
            street: 'x',
            city: 'y',
            state: 'z',
            location: { type: 'Point', coordinates: [78.4867, 17.385] }
        }
    });

    const redis = getRedisClient();
    const coords = JSON.stringify({ lat: 17.4001, lng: 78.4002, timestamp: Date.now() });
    await redis.hSet('rider:locations:hot', String(rider._id), coords);
    await redis.hSet('order:locations:hot', String(order.orderId || order._id), coords);

    const trackJobId = `e2e:track:${Date.now()}`;
    await trackingQueue.add(
        'sync-hot-locations',
        { userId: String(rider._id), orderId: String(order.orderId || order._id) },
        { jobId: trackJobId, removeOnComplete: false },
    );

    const tracked = await waitFor(async () => {
        const fresh = await FoodDeliveryPartner.findById(rider._id).select('lastLocation').lean();
        return fresh?.lastLocation?.coordinates?.length === 2 ? fresh : null;
    });
    record(
        'tracking: rider location reaches MongoDB',
        Boolean(tracked),
        tracked ? `coordinates ${JSON.stringify(tracked.lastLocation.coordinates)}` : 'never written',
    );

    // ── order: every action the processor claims to handle ────────────────────
    //
    // A wrong import path failed all three identically and still reported
    // "completed", so each is asserted on its effect, never on the job state.
    const stuck = await FoodOrder.create({
        userId: new mongoose.Types.ObjectId(),
        restaurantId: new mongoose.Types.ObjectId(),
        items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Probe', price: 10, quantity: 1 }],
        pricing: { subtotal: 10, total: 10 },
        payment: { method: 'cash' },
        deliveryAddress: {
            street: 'x',
            city: 'y',
            state: 'z',
            location: { type: 'Point', coordinates: [78.4867, 17.385] }
        },
        orderStatus: 'created',
        acceptanceDeadlineAt: new Date(Date.now() - 60 * 1000),
        dispatch: { status: 'unassigned' }
    });

    const acceptJobId = `e2e:accept:${stuck._id}`;
    await orderQueue.add(
        'process-order',
        {
            action: 'ORDER_ACCEPTANCE_TIMEOUT_CHECK',
            orderMongoId: String(stuck._id),
            orderId: String(stuck._id)
        },
        { jobId: acceptJobId, removeOnComplete: false },
    );

    const expired = await waitFor(async () => {
        const fresh = await FoodOrder.findById(stuck._id).select('orderStatus').lean();
        return fresh && fresh.orderStatus !== 'created' ? fresh : null;
    });
    record(
        'order: an unaccepted order past its deadline is closed',
        Boolean(expired),
        expired ? `status ${expired.orderStatus}` : 'still "created"',
    );

    // The dispatch retry: the action the fleet accept-deadline rides on.
    const dispatchJobId = `e2e:dispatch:${Date.now()}`;
    await orderQueue.add(
        'process-order',
        {
            action: 'DISPATCH_TIMEOUT_CHECK',
            orderMongoId: String(order._id),
            orderId: String(order._id),
            attempt: 1
        },
        { jobId: dispatchJobId, removeOnComplete: false },
    );
    const dispatchDone = await waitForJob(orderQueue, dispatchJobId);
    // This order is not dispatchable, so the correct outcome is a clean run that
    // decides to do nothing. What must never happen is a thrown module error --
    // which is exactly what used to happen, silently.
    record(
        'order: DISPATCH_TIMEOUT_CHECK runs without a module error',
        dispatchDone?.state === 'completed' && !dispatchDone.job.failedReason,
        dispatchDone ? `state ${dispatchDone.state}${dispatchDone.job.failedReason ? `: ${dispatchDone.job.failedReason}` : ''}` : 'never ran',
    );

    const scheduledJobId = `e2e:scheduled:${Date.now()}`;
    await orderQueue.add(
        'process-order',
        {
            action: 'SCHEDULED_ORDER_ACTIVATE',
            orderMongoId: String(order._id),
            orderId: String(order._id)
        },
        { jobId: scheduledJobId, removeOnComplete: false },
    );
    const scheduledDone = await waitForJob(orderQueue, scheduledJobId);
    record(
        'order: SCHEDULED_ORDER_ACTIVATE runs without a module error',
        scheduledDone?.state === 'completed' && !scheduledDone.job.failedReason,
        scheduledDone ? `state ${scheduledDone.state}${scheduledDone.job.failedReason ? `: ${scheduledDone.job.failedReason}` : ''}` : 'never ran',
    );

    // ── notification and otp: placeholders, and the claim is that they are ────
    //
    // Asserted rather than assumed. If either grows real work later, this is
    // where the missing database connection will surface.
    for (const [label, queue] of [
        ['notification', notificationQueue],
        ['otp', otpQueue]
    ]) {
        if (!queue) {
            record(`${label}: queue available`, false, 'queue missing');
            continue;
        }
        const id = `e2e:${label}:${Date.now()}`;
        await queue.add(`${label}-probe`, { probe: true }, { jobId: id, removeOnComplete: false });
        const done = await waitForJob(queue, id, 20000);
        const returned = done?.job?.returnvalue;
        record(
            `${label}: worker processes a job cleanly`,
            done?.state === 'completed' && returned?.processed === true,
            done ? `state ${done.state}, returned ${JSON.stringify(returned)}` : 'never ran',
        );
    }

    // ── tidy up after ourselves ───────────────────────────────────────────────
    await FoodDeliveryPartner.deleteOne({ _id: rider._id });
    await FoodOrder.deleteMany({ _id: { $in: [order._id, stuck._id] } });
    await redis.hDel('rider:locations:hot', String(rider._id));
    await redis.hDel('order:locations:hot', String(order.orderId || order._id));

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    await disconnectDB();
    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
    console.error('harness error:', err);
    try {
        await disconnectDB();
    } catch {}
    process.exit(3);
});
