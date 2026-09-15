import { validateConfig } from '../src/config/validateEnv.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { connectRedis, closeRedis } from '../src/config/redis.js';
import { config } from '../src/config/env.js';
import { expireExpiredOffers, renewMonthlyOffers, notifyUpcomingMonthlyOffers } from '../src/modules/food/admin/services/admin.service.js';
import { syncExpiredFssaiNotifications } from '../src/modules/food/restaurant/services/fssaiExpiry.service.js';
import { runBillingCatchUp } from '../src/modules/food/restaurant/services/subscriptionBilling.service.js';
import { writeOffExpiredBatches } from '../src/modules/food/orders/services/stockBatch.service.js';
import { hideExpiredProducts } from '../src/modules/food/orders/services/inventory.service.js';
import { dispatchOrdersSellerDidNotAccept } from '../src/modules/food/orders/services/order-dispatch.service.js';
import { logger } from '../src/utils/logger.js';

let expireOffersInterval = null;
let monthlyOfferSweepInterval = null;
let productSubscriptionSweepInterval = null;
let fssaiExpiryInterval = null;
let subscriptionBillingInterval = null;
let autoDeliverInterval = null;
let expiredBatchInterval = null;
let unacceptedDispatchInterval = null;
let stuckOrderInterval = null;

const shutdown = async (signal) => {
    logger.info(`${signal} received, stopping scheduled jobs`);
    if (expireOffersInterval) clearInterval(expireOffersInterval);
    if (monthlyOfferSweepInterval) clearInterval(monthlyOfferSweepInterval);
    if (productSubscriptionSweepInterval) clearInterval(productSubscriptionSweepInterval);
    if (fssaiExpiryInterval) clearInterval(fssaiExpiryInterval);
    if (subscriptionBillingInterval) clearInterval(subscriptionBillingInterval);
    if (autoDeliverInterval) clearInterval(autoDeliverInterval);
    if (expiredBatchInterval) clearInterval(expiredBatchInterval);
    if (unacceptedDispatchInterval) clearInterval(unacceptedDispatchInterval);
    if (stuckOrderInterval) clearInterval(stuckOrderInterval);

    try {
        await disconnectDB();
        await closeRedis();
        logger.info('Scheduled jobs stopped cleanly');
        process.exit(0);
    } catch (err) {
        logger.error(`Scheduled jobs shutdown error: ${err.message}`);
        process.exit(1);
    }
};

const start = async () => {
    try {
        validateConfig();
        await connectDB();
        if (config.redisEnabled) {
            await connectRedis();
        }

        const orderService = await import('../src/modules/food/orders/services/order.service.js');

        const runStuckOrderWatchdog = async () => {
            try {
                await orderService.recoverStuckOrders();
            } catch (err) {
                logger.error(`Scheduled jobs watchdog error: ${err.message}`);
            }
        };

        /**
         * Closes trips a rider picked up but never marked delivered.
         *
         * autoDeliverStaleOrders already existed and was never called from
         * anywhere, so orders stuck after pickup sat open indefinitely: the
         * rider could not take another job and the customer kept seeing a live
         * order. It only touches post-pickup states — an order nobody ever
         * collected is the acceptance-window expiry's problem, not this one's,
         * because recording it as delivered would credit a seller and a rider
         * for goods that never moved.
         *
         * Every 15 minutes against a 4-hour cutoff, so the sweep granularity is
         * far finer than the thing it is looking for.
         */
        const runAutoDeliver = async () => {
            try {
                const closed = await orderService.autoDeliverStaleOrders();
                if (closed > 0) logger.info(`Auto-closed ${closed} stale delivered order(s)`);
            } catch (err) {
                logger.error(`Auto-deliver sweep error: ${err.message}`);
            }
        };

        /**
         * Takes expired stock out of the count.
         *
         * Not the thing that stops expired stock being sold — allocateFefo
         * refuses to pick an expired batch whether or not this has run, and
         * that is the actual guard. This is the bookkeeping half: until a batch
         * is written off its units still sit in stockQty, so the shop believes
         * it has cover it does not have and can sell stock nothing can fulfil.
         *
         * Hourly. Expiry is a date, so finer granularity buys nothing.
         */
        const runExpiredBatchWriteOff = async () => {
            try {
                const written = await writeOffExpiredBatches({});
                if (written > 0) logger.warn(`Wrote off ${written} expired stock batch(es)`);
            } catch (err) {
                logger.error(`Expired batch sweep error: ${err.message}`);
            }
            try {
                // The other half of the same job: a product carrying its own
                // expiry has no batches to write off, just a date that has
                // passed. Separately caught so a failure in one sweep does not
                // leave the other unrun.
                const hidden = await hideExpiredProducts({});
                if (hidden > 0) logger.warn(`Hid ${hidden} expired product(s) from the storefront`);
            } catch (err) {
                logger.error(`Expired product sweep error: ${err.message}`);
            }
        };

        /**
         * An order the seller never answered still needs a rider.
         *
         * Every 30 seconds because the cap it enforces is measured in minutes:
         * a sweep on a slower cadence would add most of its own interval to the
         * wait, which the customer pays for.
         */
        const runUnacceptedOrderDispatch = async () => {
            try {
                const dispatched = await dispatchOrdersSellerDidNotAccept({});
                if (dispatched > 0) {
                    logger.warn(`Dispatched ${dispatched} order(s) the seller had not accepted in time`);
                }
            } catch (err) {
                logger.error(`Unaccepted-order dispatch sweep error: ${err.message}`);
            }
        };

        const runExpire = async () => {
            try {
                await expireExpiredOffers();
            } catch (err) {
                logger.error(`Expire offers error: ${err.message}`);
            }
        };

        const runFssaiExpirySync = async () => {
            try {
                await syncExpiredFssaiNotifications();
            } catch (err) {
                logger.error(`FSSAI expiry sync error: ${err.message}`);
            }
        };

        const runMonthlyOfferSweep = async () => {
            try {
                await renewMonthlyOffers();
                await notifyUpcomingMonthlyOffers();
            } catch (err) {
                logger.error(`Monthly offer sweep error: ${err.message}`);
            }
        };

        const runProductSubscriptionSweep = async () => {
            try {
                const { generateUpcomingOccurrences, placeDueSubscriptionOrders } = await import('../src/modules/food/user/services/productSubscription.service.js');
                await generateUpcomingOccurrences();
                await placeDueSubscriptionOrders();
            } catch (err) {
                logger.error(`Product subscription sweep error: ${err.message}`);
            }
        };

        const runSubscriptionBilling = async () => {
            try {
                // Idempotent: bills only closed, not-yet-invoiced calendar months.
                await runBillingCatchUp();
            } catch (err) {
                logger.error(`Monthly subscription billing error: ${err.message}`);
            }
        };

        await runStuckOrderWatchdog();
        await runExpire();
        await runMonthlyOfferSweep();
        await runProductSubscriptionSweep();
        await runFssaiExpirySync();
        await runSubscriptionBilling();
        await runAutoDeliver();
        await runExpiredBatchWriteOff();
        await runUnacceptedOrderDispatch();

        expireOffersInterval = setInterval(runExpire, 5 * 60 * 1000);
        monthlyOfferSweepInterval = setInterval(runMonthlyOfferSweep, 60 * 60 * 1000);
        productSubscriptionSweepInterval = setInterval(runProductSubscriptionSweep, 60 * 60 * 1000);
        fssaiExpiryInterval = setInterval(runFssaiExpirySync, 60 * 60 * 1000);
        subscriptionBillingInterval = setInterval(runSubscriptionBilling, 6 * 60 * 60 * 1000);
        autoDeliverInterval = setInterval(runAutoDeliver, 15 * 60 * 1000);
        expiredBatchInterval = setInterval(runExpiredBatchWriteOff, 60 * 60 * 1000);
        unacceptedDispatchInterval = setInterval(runUnacceptedOrderDispatch, 30 * 1000);
        // Ran once at startup only, so a dispatch that wedged an hour later
        // stayed wedged until someone restarted the process.
        stuckOrderInterval = setInterval(runStuckOrderWatchdog, 2 * 60 * 1000);

        logger.info('Scheduled jobs runner started');
    } catch (err) {
        logger.error(`Failed to start scheduled jobs runner: ${err.message}`);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await start();
