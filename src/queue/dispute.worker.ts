import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker, Job } from 'bullmq';
import { CreditReport, DisputeGraphState } from '../types/graph.state';
import { runDisputeGraph } from '../graph/dispute.graph';
import {
  DISPUTE_JOB_NAME,
  DISPUTE_QUEUE_NAME,
  createRedisConnection,
} from './dispute.queue';

interface DisputeJobData {
  creditReport: CreditReport;
  secondaryReport?: CreditReport;
}

@Injectable()
export class DisputeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DisputeWorker.name);
  private worker: Worker;

  onModuleInit(): void {
    const connection = createRedisConnection();

    this.worker = new Worker(
      DISPUTE_QUEUE_NAME,
      async (job: Job<DisputeJobData>) => {
        if (job.name !== DISPUTE_JOB_NAME) {
          this.logger.warn(`DisputeWorker: unknown job name "${job.name}", skipping`);
          return;
        }
        return this.processJob(job);
      },
      {
        connection,
        concurrency: 2,
      },
    );

    this.worker.on('completed', (job: Job, result: DisputeGraphState) => {
      this.logger.log(
        `[${new Date().toISOString()}] DisputeWorker: job ${job.id} completed — ` +
        `status=${result?.status}, anomalies=${result?.anomalies?.length ?? 0}, ` +
        `disputes=${result?.disputes?.length ?? 0}, letters=${result?.letters?.length ?? 0}`,
      );
    });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      this.logger.error(
        `[${new Date().toISOString()}] DisputeWorker: job ${job?.id ?? 'unknown'} failed — ` +
        `reason=${err.message}`,
      );
    });

    this.logger.log('DisputeWorker: worker started with concurrency=2');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker.close();
    this.logger.log('DisputeWorker: worker closed');
  }

  private async processJob(job: Job<DisputeJobData>): Promise<DisputeGraphState> {
    const { creditReport, secondaryReport } = job.data;

    this.logger.log(
      `[${new Date().toISOString()}] DisputeWorker: processing job ${job.id} ` +
      `for reportId=${creditReport.reportId}` +
      (secondaryReport ? ` + secondary ${secondaryReport.bureau} report` : ''),
    );

    const initialState: DisputeGraphState = {
      creditReport,
      secondaryReport: secondaryReport ?? null,
      bureauConflicts: [],
      anomalies: [],
      disputes: [],
      letters: [],
      errors: [],
      status: secondaryReport ? 'RECONCILING' : 'ANALYZING',
    };

    try {
      const finalState = await runDisputeGraph(initialState);
      return finalState;
    } catch (err) {
      this.logger.error(
        `[${new Date().toISOString()}] DisputeWorker: unhandled error in job ${job.id} — ` +
        `${(err as Error).message}`,
      );
      // Re-throw so BullMQ can apply retry logic
      throw err;
    }
  }
}
