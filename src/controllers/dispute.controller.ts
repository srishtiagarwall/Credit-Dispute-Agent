// dispute controller
import {
  Controller,
  Post,
  Get,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
  InternalServerErrorException,
  NotFoundException,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { DisputeProducer } from '../queue/dispute.producer';
import { CreditReport, DisputeGraphState, DisputeLetter } from '../types/graph.state';
import { SubmitDisputeResponse, JobResultResponse } from '../dto/submit-dispute.dto';

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

  @Get(':jobId/result')
  async getResult(@Param('jobId') jobId: string): Promise<JobResultResponse> {
    const queue = this.disputeProducer.getQueue();
    const job = await queue.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    const state = await job.getState();
    const returnValue = job.returnvalue as DisputeGraphState | null;

    return {
      jobId,
      jobStatus: state as JobResultResponse['jobStatus'],
      result: returnValue
        ? {
            status: returnValue.status,
            anomalies: returnValue.anomalies ?? [],
            disputes: returnValue.disputes ?? [],
            letters: returnValue.letters ?? [],
            errors: returnValue.errors ?? [],
          }
        : null,
    };
  }

  @Get(':jobId/result/view')
  async viewResult(@Param('jobId') jobId: string, @Res() res: Response): Promise<void> {
    const queue = this.disputeProducer.getQueue();
    const job = await queue.getJob(jobId);

    if (!job) {
      res.status(404).send('<h2>Job not found</h2>');
      return;
    }

    const state = await job.getState();
    const result = job.returnvalue as DisputeGraphState | null;

    const html = buildResultPage(jobId, state, result);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }
}

function buildResultPage(
  jobId: string,
  jobStatus: string,
  result: DisputeGraphState | null,
): string {
  const statusColor: Record<string, string> = {
    COMPLETE: '#16a34a',
    FAILED: '#dc2626',
    ANALYZING: '#d97706',
    IDENTIFYING: '#d97706',
    DRAFTING: '#d97706',
  };

  const color = result ? (statusColor[result.status] ?? '#6b7280') : '#6b7280';

  const lettersHtml = result?.letters?.length
    ? result.letters
        .map((l: DisputeLetter) => `
          <div class="letter">
            <div class="letter-header">
              <div>
                <span class="badge">${l.accountId}</span>
                <strong>${l.lenderName}</strong>
              </div>
              <span class="letter-date">${new Date(l.generatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
            </div>
            <div class="letter-subject">${l.subject}</div>
            <pre class="letter-body">${escapeHtml(l.body)}</pre>
          </div>`)
        .join('')
    : '<p class="empty">No letters generated.</p>';

  const errorsHtml = result?.errors?.length
    ? `<div class="errors"><strong>Errors:</strong><ul>${result.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dispute Result — Job ${jobId}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; }
    .topbar { background: #0f172a; color: white; padding: 16px 32px; display: flex; align-items: center; gap: 12px; }
    .topbar h1 { font-size: 18px; font-weight: 600; }
    .topbar .sub { font-size: 13px; color: #94a3b8; }
    .container { max-width: 900px; margin: 32px auto; padding: 0 24px; }
    .summary { background: white; border-radius: 12px; border: 1px solid #e2e8f0; padding: 24px; margin-bottom: 28px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
    .stat { text-align: center; }
    .stat .value { font-size: 32px; font-weight: 700; color: #0f172a; }
    .stat .label { font-size: 12px; color: #64748b; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
    .status-pill { display: inline-block; padding: 4px 12px; border-radius: 99px; font-size: 13px; font-weight: 600; color: white; background: ${color}; }
    .section-title { font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 16px; }
    .letter { background: white; border: 1px solid #e2e8f0; border-radius: 12px; margin-bottom: 20px; overflow: hidden; }
    .letter-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #f1f5f9; background: #f8fafc; }
    .badge { background: #e0f2fe; color: #0369a1; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-right: 8px; }
    .letter-date { font-size: 12px; color: #94a3b8; }
    .letter-subject { padding: 12px 20px; font-weight: 600; font-size: 14px; color: #1e293b; border-bottom: 1px solid #f1f5f9; }
    .letter-body { padding: 20px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; font-family: 'Georgia', serif; color: #374151; }
    .errors { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 20px; font-size: 13px; color: #dc2626; }
    .errors ul { margin-top: 8px; padding-left: 20px; }
    .empty { color: #94a3b8; font-size: 14px; padding: 20px 0; }
    .waiting { text-align: center; padding: 60px; color: #64748b; }
    .waiting .spinner { width: 40px; height: 40px; border: 3px solid #e2e8f0; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  ${jobStatus !== 'completed' ? '<meta http-equiv="refresh" content="5">' : ''}
</head>
<body>
  <div class="topbar">
    <div>
      <h1>Credit Dispute Agent</h1>
      <div class="sub">Job #${jobId} &nbsp;·&nbsp; <span class="status-pill">${result?.status ?? jobStatus.toUpperCase()}</span></div>
    </div>
  </div>

  <div class="container">
    ${jobStatus !== 'completed' && jobStatus !== 'failed' ? `
      <div class="waiting">
        <div class="spinner"></div>
        <p>Agents are processing your credit report…</p>
        <p style="font-size:12px;margin-top:8px;color:#94a3b8">This page refreshes every 5 seconds</p>
      </div>
    ` : `
      <div class="summary">
        <div class="stat"><div class="value">${result?.anomalies?.length ?? 0}</div><div class="label">Anomalies Found</div></div>
        <div class="stat"><div class="value">${result?.disputes?.length ?? 0}</div><div class="label">Disputes Classified</div></div>
        <div class="stat"><div class="value">${result?.letters?.length ?? 0}</div><div class="label">Letters Drafted</div></div>
        <div class="stat"><div class="value">${result?.errors?.length ?? 0}</div><div class="label">Errors</div></div>
      </div>

      ${errorsHtml}

      <div class="section-title">Dispute Letters</div>
      ${lettersHtml}
    `}
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
