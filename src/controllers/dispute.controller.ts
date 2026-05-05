import {
  Controller,
  Post,
  HttpCode,
  HttpStatus,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DisputeProducer } from '../queue/dispute.producer';
import { CreditReport } from '../types/graph.state';
import { SubmitDisputeResponse } from '../dto/submit-dispute.dto';

@Controller('dispute')
export class DisputeController {
  private readonly logger = new Logger(DisputeController.name);

  constructor(private readonly disputeProducer: DisputeProducer) {}

  @Post('submit')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitDispute(): Promise<SubmitDisputeResponse> {
    const reportPath = path.resolve(process.cwd(), 'mock', 'credit-report.json');

    let creditReport: CreditReport;
    try {
      const raw = fs.readFileSync(reportPath, 'utf-8');
      creditReport = JSON.parse(raw) as CreditReport;
    } catch (err) {
      this.logger.error(`DisputeController: failed to load credit report — ${(err as Error).message}`);
      throw new InternalServerErrorException('Could not load credit report');
    }

    const jobId = await this.disputeProducer.enqueueDisputeJob(creditReport);

    this.logger.log(
      `DisputeController: job ${jobId} queued for reportId=${creditReport.reportId}`,
    );

    return {
      jobId,
      status: 'QUEUED',
      message: 'Processing started',
    };
  }
}
