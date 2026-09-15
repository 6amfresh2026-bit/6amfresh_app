import 'dotenv/config';
import { Worker } from 'bullmq';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getBullMQConnection } from '../connection.js';
import { connectDB } from '../../config/db.js';
import { ORDER_QUEUE } from '../queue.constants.js';
import { processOrderJob } from '../processors/order.processor.js';

const defaultJobOptions = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
};

const startOrderWorker = async () => {
    if (!config.bullmqEnabled) {
        logger.info('BullMQ is disabled. Order worker not started.');
        return null;
    }
    // Every order job reads and writes orders. Without this the worker connects
    // to Redis, picks jobs up happily, and then fails each one with a Mongoose
    // buffering timeout ten seconds later -- so dispatch retries, scheduled
    // order activation and acceptance timeouts all silently did nothing.
    await connectDB();
    const connection = getBullMQConnection();
    if (!connection) {
        logger.error('Order worker: Redis connection unavailable. Exiting.');
        process.exit(1);
    }
    const worker = new Worker(ORDER_QUEUE, processOrderJob, {
        connection,
        concurrency: 5,
        defaultJobOptions
    });
    worker.on('completed', (job) => logger.info(`Order job ${job.id} completed`));
    worker.on('failed', (job, err) => logger.error(`Order job ${job?.id} failed: ${err.message}`));
    worker.on('error', (err) => logger.error(`Order worker error: ${err.message}`));
    logger.info('Order worker started');
    return worker;
};

const worker = await startOrderWorker();
if (worker) {
    const shutdown = async () => {
        await worker.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
