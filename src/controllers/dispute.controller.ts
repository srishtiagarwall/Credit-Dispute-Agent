import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  BadRequestException,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { DisputeProducer } from '../queue/dispute.producer';
import { BureauConflict, CreditReport, DisputeGraphState, DisputeLetter } from '../types/graph.state';
import { SubmitDisputeResponse, JobResultResponse } from '../dto/submit-dispute.dto';
import mockCreditReport from '../../mock/credit-report.json';
import mockCibilReport from '../../mock/credit-report-cibil.json';

@Controller()
export class DisputeController {
  private readonly logger = new Logger(DisputeController.name);

  constructor(private readonly disputeProducer: DisputeProducer) {}

  @Get()
  landingPage(@Res() res: Response): void {
    res.setHeader('Content-Type', 'text/html');
    res.send(buildLandingPage(JSON.stringify(mockCreditReport, null, 2)));
  }

  @Post('dispute/submit')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitDispute(@Body() body: Partial<CreditReport>): Promise<SubmitDisputeResponse> {
    let creditReport: CreditReport;

    const isValidReport = body && body.reportId && body.accounts && body.borrower;

    if (isValidReport) {
      creditReport = body as CreditReport;
      this.logger.log('DisputeController: using custom credit report from request body');
    } else {
      creditReport = mockCreditReport as CreditReport;
      this.logger.log('DisputeController: using mock credit report');
    }

    if (!creditReport.reportId || !creditReport.accounts || !creditReport.borrower) {
      throw new BadRequestException('Invalid credit report: missing required fields (reportId, accounts, borrower)');
    }

    const jobId = await this.disputeProducer.enqueueDisputeJob(creditReport);
    this.logger.log(`DisputeController: job ${jobId} queued for reportId=${creditReport.reportId}`);

    return { jobId, status: 'QUEUED', message: 'Processing started' };
  }

  @Post('dispute/submit-multi-bureau')
  @HttpCode(HttpStatus.ACCEPTED)
  async submitMultiBureau(
    @Body() body: { primary?: CreditReport; secondary?: CreditReport },
  ): Promise<SubmitDisputeResponse> {
    const primary = (body?.primary ?? mockCreditReport) as CreditReport;
    const secondary = (body?.secondary ?? mockCibilReport) as CreditReport;

    if (!primary.reportId || !primary.accounts || !primary.borrower) {
      throw new BadRequestException('Invalid primary credit report: missing required fields');
    }
    if (!secondary.reportId || !secondary.accounts || !secondary.borrower) {
      throw new BadRequestException('Invalid secondary credit report: missing required fields');
    }
    if (primary.borrower.pan !== secondary.borrower.pan) {
      throw new BadRequestException(
        `PAN mismatch: primary=${primary.borrower.pan}, secondary=${secondary.borrower.pan}. Both reports must belong to the same borrower.`,
      );
    }

    const jobId = await this.disputeProducer.enqueueDisputeJob(primary, secondary);
    this.logger.log(
      `DisputeController: multi-bureau job ${jobId} queued — ` +
      `${primary.bureau} (${primary.reportId}) + ${secondary.bureau} (${secondary.reportId})`,
    );

    return { jobId, status: 'QUEUED', message: 'Multi-bureau processing started' };
  }

  @Get('dispute/:jobId/result')
  async getResult(@Param('jobId') jobId: string): Promise<JobResultResponse> {
    const queue = this.disputeProducer.getQueue();
    const job = await queue.getJob(jobId);

    if (!job) throw new NotFoundException(`Job ${jobId} not found`);

    const state = await job.getState();
    const returnValue = job.returnvalue as DisputeGraphState | null;

    return {
      jobId,
      jobStatus: state as JobResultResponse['jobStatus'],
      result: returnValue
        ? {
            status: returnValue.status,
            bureauConflicts: returnValue.bureauConflicts ?? [],
            anomalies: returnValue.anomalies ?? [],
            disputes: returnValue.disputes ?? [],
            letters: returnValue.letters ?? [],
            errors: returnValue.errors ?? [],
          }
        : null,
    };
  }

  @Get('dispute/:jobId/result/view')
  async viewResult(@Param('jobId') jobId: string, @Res() res: Response): Promise<void> {
    const queue = this.disputeProducer.getQueue();
    const job = await queue.getJob(jobId);

    if (!job) {
      res.status(404).send('<h2>Job not found</h2>');
      return;
    }

    const state = await job.getState();
    const result = job.returnvalue as DisputeGraphState | null;

    res.setHeader('Content-Type', 'text/html');
    res.send(buildResultPage(jobId, state, result));
  }
}

// ─── HTML builders ───────────────────────────────────────────────────────────

function buildLandingPage(mockReportJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Credit Dispute Agent</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; color: #1e293b; }
    .topbar { background: #0f172a; color: white; padding: 18px 40px; display: flex; align-items: center; justify-content: space-between; }
    .topbar h1 { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
    .topbar .tag { font-size: 11px; background: #6366f1; color: white; padding: 3px 10px; border-radius: 99px; font-weight: 600; }
    .hero { text-align: center; padding: 64px 24px 48px; }
    .hero h2 { font-size: 36px; font-weight: 800; color: #0f172a; letter-spacing: -1px; line-height: 1.15; }
    .hero h2 span { color: #6366f1; }
    .hero p { margin-top: 16px; font-size: 16px; color: #64748b; max-width: 520px; margin-left: auto; margin-right: auto; line-height: 1.6; }
    .pipeline { display: flex; align-items: center; justify-content: center; gap: 0; margin: 40px auto; max-width: 760px; flex-wrap: wrap; }
    .step { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 18px; text-align: center; min-width: 130px; }
    .step .icon { font-size: 22px; margin-bottom: 6px; }
    .step .name { font-size: 12px; font-weight: 700; color: #0f172a; }
    .step .desc { font-size: 11px; color: #94a3b8; margin-top: 2px; }
    .arrow { color: #cbd5e1; font-size: 20px; padding: 0 8px; }
    .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; max-width: 900px; margin: 0 auto; padding: 0 24px 64px; }
    .card { background: white; border: 1px solid #e2e8f0; border-radius: 14px; padding: 28px; }
    .card h3 { font-size: 15px; font-weight: 700; margin-bottom: 6px; color: #0f172a; }
    .card p { font-size: 13px; color: #64748b; margin-bottom: 20px; line-height: 1.5; }
    .btn { display: inline-block; padding: 11px 24px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; width: 100%; text-align: center; }
    .btn-primary { background: #6366f1; color: white; }
    .btn-primary:hover { background: #4f46e5; }
    .btn-outline { background: white; color: #6366f1; border: 1.5px solid #6366f1; }
    .btn-outline:hover { background: #f5f3ff; }
    textarea { width: 100%; height: 200px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; resize: vertical; color: #374151; background: #f8fafc; margin-bottom: 12px; outline: none; }
    textarea:focus { border-color: #6366f1; background: white; }
    .error-msg { color: #dc2626; font-size: 12px; margin-bottom: 10px; display: none; }
    .spinner-inline { display: none; width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.4); border-top-color: white; border-radius: 50%; animation: spin 0.7s linear infinite; margin: 0 auto; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>Credit Dispute Agent</h1>
    <span class="tag">Powered by Gemini + LangGraph</span>
  </div>

  <div class="hero">
    <h2>AI-powered <span>credit dispute</span><br>letters in seconds</h2>
    <p>Upload a credit report. Four AI agents reconcile bureau conflicts, analyze anomalies, classify disputes, and draft formal letters — automatically.</p>

    <div class="pipeline">
      <div class="step"><div class="icon">🏦</div><div class="name">Experian + CIBIL</div><div class="desc">Two bureau inputs</div></div>
      <div class="arrow">→</div>
      <div class="step"><div class="icon">⚡</div><div class="name">Reconciler</div><div class="desc">Diffs bureaus</div></div>
      <div class="arrow">→</div>
      <div class="step"><div class="icon">🔍</div><div class="name">Analyzer</div><div class="desc">Flags anomalies</div></div>
      <div class="arrow">→</div>
      <div class="step"><div class="icon">⚖️</div><div class="name">Classifier</div><div class="desc">Scores disputes</div></div>
      <div class="arrow">→</div>
      <div class="step"><div class="icon">✉️</div><div class="name">Letter Drafter</div><div class="desc">Formal letters</div></div>
    </div>
  </div>

  <div class="cards" style="grid-template-columns: 1fr 1fr 1fr;">
    <div class="card">
      <h3>Single bureau (Experian)</h3>
      <p>Use our pre-loaded Experian mock — late payments, high utilization, unknown inquiries.</p>
      <button class="btn btn-primary" onclick="runMock()">
        <span id="mock-label">Run Single Bureau →</span>
        <div class="spinner-inline" id="mock-spinner"></div>
      </button>
    </div>

    <div class="card">
      <h3>Multi-bureau (Experian + CIBIL)</h3>
      <p>Runs both mock reports through the Reconciler agent — detects cross-bureau conflicts before dispute classification.</p>
      <button class="btn btn-primary" style="background:#7c3aed" onclick="runMultiBureau()">
        <span id="multi-label">Run Multi-Bureau →</span>
        <div class="spinner-inline" id="multi-spinner"></div>
      </button>
    </div>

    <div class="card">
      <h3>Paste your own report</h3>
      <p>Paste a credit report JSON. Must include <code>reportId</code>, <code>borrower</code>, and <code>accounts</code>.</p>
      <textarea id="custom-json" placeholder="Paste credit report JSON here…">${escapeForHtml(mockReportJson)}</textarea>
      <div class="error-msg" id="custom-error">Invalid JSON — please check your input.</div>
      <button class="btn btn-outline" onclick="runCustom()">
        <span id="custom-label">Analyze Report →</span>
        <div class="spinner-inline" id="custom-spinner"></div>
      </button>
    </div>
  </div>

  <script>
    async function runMock() {
      setLoading('mock', true);
      try {
        const res = await fetch('/dispute/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        window.location.href = '/dispute/' + data.jobId + '/result/view';
      } catch {
        setLoading('mock', false);
      }
    }

    async function runMultiBureau() {
      setLoading('multi', true);
      try {
        const res = await fetch('/dispute/submit-multi-bureau', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        window.location.href = '/dispute/' + data.jobId + '/result/view';
      } catch {
        setLoading('multi', false);
      }
    }

    async function runCustom() {
      const raw = document.getElementById('custom-json').value.trim();
      const errEl = document.getElementById('custom-error');
      errEl.style.display = 'none';

      let parsed;
      try { parsed = JSON.parse(raw); } catch {
        errEl.style.display = 'block';
        return;
      }

      setLoading('custom', true);
      try {
        const res = await fetch('/dispute/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed),
        });
        const data = await res.json();
        window.location.href = '/dispute/' + data.jobId + '/result/view';
      } catch {
        setLoading('custom', false);
      }
    }

    function setLoading(which, on) {
      document.getElementById(which + '-label').style.display = on ? 'none' : 'inline';
      document.getElementById(which + '-spinner').style.display = on ? 'block' : 'none';
    }
  </script>
</body>
</html>`;
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
            <div class="letter-subject">${escapeHtml(l.subject)}</div>
            <pre class="letter-body">${escapeHtml(l.body)}</pre>
          </div>`)
        .join('')
    : '<p class="empty">No letters generated.</p>';

  const conflictsHtml = result?.bureauConflicts?.length
    ? `<div class="section-title" style="margin-top:8px">Bureau Conflicts Detected</div>` +
      result.bureauConflicts
        .map((c: BureauConflict) => {
          const targetClass =
            c.disputeTarget === 'EXPERIAN' ? 'target-experian'
            : c.disputeTarget === 'CIBIL' ? 'target-cibil'
            : 'target-both';
          return `
          <div class="conflict-card">
            <div>
              <div class="conflict-field">${escapeHtml(c.conflictField)} — <span style="color:#0f172a">${escapeHtml(c.accountId)}</span></div>
              <div class="conflict-values">
                Experian: <span>${escapeHtml(c.experianValue)}</span>
                vs CIBIL: <span>${escapeHtml(c.cibilValue)}</span>
              </div>
              <div class="conflict-reasoning">${escapeHtml(c.reasoning)}</div>
              <div class="ground-truth">Ground truth: ${c.groundTruth}</div>
            </div>
            <span class="target-badge ${targetClass}">Dispute ${c.disputeTarget}</span>
          </div>`;
        })
        .join('')
    : '';

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
    .topbar { background: #0f172a; color: white; padding: 16px 32px; display: flex; align-items: center; justify-content: space-between; }
    .topbar-left h1 { font-size: 18px; font-weight: 600; }
    .topbar-left .sub { font-size: 13px; color: #94a3b8; margin-top: 2px; }
    .back-btn { font-size: 13px; color: #94a3b8; text-decoration: none; border: 1px solid #334155; padding: 6px 14px; border-radius: 6px; }
    .back-btn:hover { color: white; border-color: #64748b; }
    .status-pill { display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: 12px; font-weight: 600; color: white; background: ${color}; margin-left: 8px; }
    .container { max-width: 900px; margin: 32px auto; padding: 0 24px; }
    .summary { background: white; border-radius: 12px; border: 1px solid #e2e8f0; padding: 24px; margin-bottom: 28px; display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; }
    .conflict-card { background: white; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px 20px; margin-bottom: 12px; display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: start; }
    .conflict-field { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
    .conflict-values { font-size: 13px; color: #0f172a; margin-bottom: 6px; }
    .conflict-values span { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-family: monospace; margin: 0 2px; }
    .conflict-reasoning { font-size: 12px; color: #64748b; line-height: 1.5; }
    .target-badge { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 99px; white-space: nowrap; }
    .target-experian { background: #fef3c7; color: #92400e; }
    .target-cibil { background: #ede9fe; color: #5b21b6; }
    .target-both { background: #fee2e2; color: #991b1b; }
    .ground-truth { font-size: 11px; color: #16a34a; font-weight: 600; margin-top: 4px; }
    .stat { text-align: center; }
    .stat .value { font-size: 32px; font-weight: 700; color: #0f172a; }
    .stat .label { font-size: 12px; color: #64748b; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
    .section-title { font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 16px; }
    .letter { background: white; border: 1px solid #e2e8f0; border-radius: 12px; margin-bottom: 20px; overflow: hidden; }
    .letter-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #f1f5f9; background: #f8fafc; }
    .badge { background: #e0f2fe; color: #0369a1; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-right: 8px; }
    .letter-date { font-size: 12px; color: #94a3b8; }
    .letter-subject { padding: 12px 20px; font-weight: 600; font-size: 14px; color: #1e293b; border-bottom: 1px solid #f1f5f9; }
    .letter-body { padding: 20px; font-size: 13px; line-height: 1.8; white-space: pre-wrap; font-family: 'Georgia', serif; color: #374151; }
    .errors { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 20px; font-size: 13px; color: #dc2626; }
    .errors ul { margin-top: 8px; padding-left: 20px; }
    .empty { color: #94a3b8; font-size: 14px; padding: 20px 0; }
    .waiting { text-align: center; padding: 80px 24px; color: #64748b; }
    .waiting .spinner { width: 44px; height: 44px; border: 3px solid #e2e8f0; border-top-color: #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 20px; }
    .waiting h3 { font-size: 18px; color: #0f172a; margin-bottom: 8px; }
    .waiting .steps { margin-top: 24px; display: flex; justify-content: center; gap: 24px; flex-wrap: wrap; }
    .waiting .step { font-size: 12px; color: #94a3b8; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  ${jobStatus !== 'completed' && jobStatus !== 'failed' ? '<meta http-equiv="refresh" content="4">' : ''}
</head>
<body>
  <div class="topbar">
    <div class="topbar-left">
      <h1>Credit Dispute Agent</h1>
      <div class="sub">Job #${jobId} <span class="status-pill">${result?.status ?? jobStatus.toUpperCase()}</span></div>
    </div>
    <a href="/" class="back-btn">← New Report</a>
  </div>

  <div class="container">
    ${jobStatus !== 'completed' && jobStatus !== 'failed' ? `
      <div class="waiting">
        <div class="spinner"></div>
        <h3>Agents are working…</h3>
        <p>This page refreshes every 4 seconds</p>
        <div class="steps">
          <div class="step">⚡ Reconciling bureaus</div>
          <div class="step">🔍 Analyzing anomalies</div>
          <div class="step">⚖️ Classifying disputes</div>
          <div class="step">✉️ Drafting letters</div>
        </div>
      </div>
    ` : `
      <div class="summary">
        <div class="stat"><div class="value">${result?.bureauConflicts?.length ?? 0}</div><div class="label">Bureau Conflicts</div></div>
        <div class="stat"><div class="value">${result?.anomalies?.length ?? 0}</div><div class="label">Anomalies Found</div></div>
        <div class="stat"><div class="value">${result?.disputes?.length ?? 0}</div><div class="label">Disputes Classified</div></div>
        <div class="stat"><div class="value">${result?.letters?.length ?? 0}</div><div class="label">Letters Drafted</div></div>
        <div class="stat"><div class="value">${result?.errors?.length ?? 0}</div><div class="label">Errors</div></div>
      </div>
      ${errorsHtml}
      ${conflictsHtml}
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

function escapeForHtml(str: string): string {
  return str.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
