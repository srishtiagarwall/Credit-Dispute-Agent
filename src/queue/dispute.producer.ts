import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { CreditReport } from '../types/graph.state';
import {
  DISPUTE_JOB_NAME,
  createDisputeQueue,
} from './dispute.queue';

@Injectable()
export class DisputeProducer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DisputeProducer.name);
  private queue: Queue;

  onModuleInit(): void {
    this.queue = createDisputeQueue();
    this.logger.log('DisputeProducer: queue connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    this.logger.log('DisputeProducer: queue connection closed');
  }

  async enqueueDisputeJob(creditReport: CreditReport): Promise<string> {
    const job = await this.queue.add(
      DISPUTE_JOB_NAME,
      { creditReport },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000, // 1s → 2s → 4s
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    );

    this.logger.log(
      `DisputeProducer: enqueued job ${job.id} for reportId=${creditReport.reportId}`,
    );

    return job.id as string;
  }
}
