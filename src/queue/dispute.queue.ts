import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const DISPUTE_QUEUE_NAME = 'dispute-processing';
export const DISPUTE_JOB_NAME = 'process-credit-report';

export function createRedisConnection(): IORedis {
  return new IORedis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    maxRetriesPerRequest: null, // required by BullMQ
  });
}

export function createDisputeQueue(): Queue {
  const connection = createRedisConnection();
  return new Queue(DISPUTE_QUEUE_NAME, { connection });
}
