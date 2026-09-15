import 'dotenv/config';
import { Worker } from 'bullmq';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { getBullMQConnection } from '../connection.js';
import { connectDB } from '../../config/db.js';
import { PAYMENT_QUEUE } from '../queue.constants.js';
import { processPaymentJob } from '../processors/payment.processor.js';

const defaultJobOptions = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
};

const startPaymentWorker = async () => {
    if (!config.bullmqEnabled) {
        logger.info('BullMQ is disabled. Payment worker not started.');
        return null;
    }
    // This processor reads and writes through Mongoose. Without a connection
    // the worker starts happily, picks jobs up, and then fails each one ten
    // seconds later with a buffering timeout -- a queue that looks healthy and
    // does nothing.
    await connectDB();
    const connection = getBullMQConnection();
    if (!connection) {
        logger.error('Payment worker: Redis connection unavailable. Exiting.');
        process.exit(1);
    }
    const worker = new Worker(PAYMENT_QUEUE, processPaymentJob, {
        connection,
        concurrency: 5,
        defaultJobOptions
    });
    worker.on('completed', (job) => logger.info(`Payment job ${job.id} completed`));
    worker.on('failed', (job, err) => logger.error(`Payment job ${job?.id} failed: ${err.message}`));
    worker.on('error', (err) => logger.error(`Payment worker error: ${err.message}`));
    logger.info('Payment worker started');
    return worker;
};

const worker = await startPaymentWorker();
if (worker) {
    const shutdown = async () => {
        await worker.close();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
