/**
 * The rider location path, end to end, exactly as the rider app drives it.
 *
 * socket 'update-location' -> Redis hot hash -> delayed BullMQ job -> MongoDB.
 *
 * Every stage is asserted separately, because each one has failed silently at
 * least once: the socket layer drops a location with no reply, the hot hash is
 * write-only until a job drains it, and the worker reported "completed" for
 * months while writing nothing. A test that only checked the final document
 * could not say which stage was broken, and a test that only checked the job
 * would have passed throughout.
 *
 * Needs: the API server (Socket.IO), the tracking worker, Redis, Mongo.
 *   BULLMQ_ENABLED=true node scripts/tracking-e2e.mjs
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { io as ioClient } from 'socket.io-client';

import { connectDB, disconnectDB } from '../src/config/db.js';
import { getRedisClient, connectRedis } from '../src/config/redis.js';
import { getTrackingQueue } from '../src/queues/index.js';
import { FoodDeliveryPartner } from '../src/modules/food/delivery/models/deliveryPartner.model.js';
import { FoodOrder } from '../src/modules/food/orders/models/order.model.js';
import { signAccessToken } from '../src/core/auth/token.util.js';

const API = process.env.E2E_API_URL || 'http://localhost:5000';
const LAT = 17.4321;
const LNG = 78.4123;

const results = [];
const record = (name, ok, detail) => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check, { timeoutMs = 60000, everyMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await sleep(everyMs);
    }
    return null;
}

async function main() {
    await connectDB();
    await connectRedis();
    const redis = getRedisClient();
    const queue = getTrackingQueue();

    if (!queue) {
        console.error('Tracking queue unavailable. Run with BULLMQ_ENABLED=true.');
        process.exit(2);
    }

    const rider = await FoodDeliveryPartner.create({
        name: 'Tracking E2E Rider',
        phone: `9${Date.now().toString().slice(-9)}`,
        status: 'approved',
        availabilityStatus: 'online'
    });

    const order = await FoodOrder.create({
        userId: new mongoose.Types.ObjectId(),
        restaurantId: new mongoose.Types.ObjectId(),
        items: [{ itemId: new mongoose.Types.ObjectId(), name: 'Tracking Probe', price: 10, quantity: 1 }],
        pricing: { subtotal: 10, total: 10 },
        payment: { method: 'cash' },
        deliveryAddress: {
            street: 'x',
            city: 'y',
            state: 'z',
            location: { type: 'Point', coordinates: [78.4867, 17.385] }
        },
        orderStatus: 'picked_up',
        dispatch: { status: 'accepted', deliveryPartnerId: rider._id }
    });

    const orderKey = String(order.orderId || order._id);

    // Clean slate, so a stale hash from an earlier run cannot pass this for us.
    await redis.hDel('rider:locations:hot', String(rider._id));
    await redis.hDel('order:locations:hot', orderKey);
    await queue.remove(`sync:loc:${orderKey}`).catch(() => {});

    // ── stage 1: the socket accepts the rider's ping ──────────────────────────
    const token = signAccessToken({ userId: String(rider._id), role: 'DELIVERY_PARTNER' });
    const socket = ioClient(API, { auth: { token }, transports: ['websocket'], reconnection: false });

    const connected = await new Promise((resolve) => {
        socket.on('connect', () => resolve(true));
        socket.on('connect_error', (err) => resolve(`connect_error: ${err.message}`));
        setTimeout(() => resolve('timed out'), 15000);
    });
    record('socket: a delivery partner can connect', connected === true, connected === true ? socket.id : String(connected));
    if (connected !== true) {
        socket.close();
        await cleanup(rider, order, redis, orderKey);
        finish();
        return;
    }

    socket.emit('update-location', {
        orderId: orderKey,
        lat: LAT,
        lng: LNG,
        userId: String(order.userId),
        status: 'on_the_way'
    });

    // ── stage 2: Redis hot storage ───────────────────────────────────────────
    const hot = await waitFor(
        async () => {
            const [r, o] = await Promise.all([
                redis.hGet('rider:locations:hot', String(rider._id)),
                redis.hGet('order:locations:hot', orderKey)
            ]);
            return r && o ? { r: JSON.parse(r), o: JSON.parse(o) } : null;
        },
        { timeoutMs: 15000 },
    );
    record(
        'redis: the ping lands in hot storage for rider and order',
        Boolean(hot) && hot.r.lat === LAT && hot.o.lng === LNG,
        hot ? `rider ${hot.r.lat},${hot.r.lng}` : 'never buffered',
    );

    // ── stage 3: a cold-write job is scheduled ───────────────────────────────
    //
    // The id is deliberately fixed per order so a rider moving fast debounces
    // into one write rather than thousands.
    const job = await waitFor(async () => queue.getJob(`sync:loc:${orderKey}`), { timeoutMs: 15000 });
    record(
        'queue: a debounced sync job is scheduled for this order',
        Boolean(job),
        job ? `jobId ${job.id}, delay ${job.delay}ms` : 'no job scheduled',
    );

    // ── stage 4: the worker writes it to MongoDB ─────────────────────────────
    //
    // Up to the job's own delay plus room for the worker. This is the stage
    // that silently did nothing: no Redis client in the worker process meant
    // the handler returned early and the job completed regardless.
    const wroteRider = await waitFor(
        async () => {
            const fresh = await FoodDeliveryPartner.findById(rider._id).select('lastLocation').lean();
            const c = fresh?.lastLocation?.coordinates;
            return Array.isArray(c) && c.length === 2 ? c : null;
        },
        { timeoutMs: 75000 },
    );
    record(
        'mongo: the rider document receives the location',
        Boolean(wroteRider) && Math.abs(wroteRider[1] - LAT) < 1e-6 && Math.abs(wroteRider[0] - LNG) < 1e-6,
        wroteRider ? `[${wroteRider}]` : 'never written',
    );

    const wroteOrder = await waitFor(
        async () => {
            const fresh = await FoodOrder.findById(order._id).select('lastRiderLocation').lean();
            const c = fresh?.lastRiderLocation?.coordinates;
            return Array.isArray(c) && c.length === 2 ? c : null;
        },
        { timeoutMs: 20000 },
    );
    record(
        'mongo: the order document receives the location',
        Boolean(wroteOrder) && Math.abs(wroteOrder[1] - LAT) < 1e-6,
        wroteOrder ? `[${wroteOrder}]` : 'never written',
    );

    socket.close();
    await cleanup(rider, order, redis, orderKey);
    finish();
}

async function cleanup(rider, order, redis, orderKey) {
    await FoodDeliveryPartner.deleteOne({ _id: rider._id });
    await FoodOrder.deleteOne({ _id: order._id });
    await redis.hDel('rider:locations:hot', String(rider._id));
    await redis.hDel('order:locations:hot', orderKey);
}

function finish() {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    disconnectDB()
        .catch(() => {})
        .finally(() => process.exit(failed.length === 0 ? 0 : 1));
}

main().catch(async (err) => {
    console.error('harness error:', err);
    try {
        await disconnectDB();
    } catch {}
    process.exit(3);
});
