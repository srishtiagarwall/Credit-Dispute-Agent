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
    const processedOn = job.processedOn || job.timestamp || Date.now();

    res.setHeader('Content-Type', 'text/html');
    res.send(buildResultPage(jobId, state, result, processedOn));
  }
}

// ─── HTML builders ───────────────────────────────────────────────────────────\n
function buildLandingPage(mockReportJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Credit Dispute Agent</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --radius: 8px;
      --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
      --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; 
      background: var(--bg); 
      color: var(--text-main); 
      line-height: 1.5; 
      -webkit-font-smoothing: antialiased; 
    }
    .topbar { 
      background: var(--surface); 
      border-bottom: 1px solid var(--border); 
      padding: 16px 40px; 
      display: flex; 
      align-items: center; 
      justify-content: space-between; 
      box-shadow: var(--shadow-sm);
    }
    .topbar h1 { 
      font-size: 18px; 
      font-weight: 600; 
      letter-spacing: -0.01em; 
      color: var(--text-main);
    }
    .hero { 
      text-align: center; 
      padding: 80px 24px 64px; 
      max-width: 800px; 
      margin: 0 auto; 
    }
    .hero h2 { 
      font-size: 36px; 
      font-weight: 700; 
      color: var(--text-main); 
      letter-spacing: -0.02em; 
      line-height: 1.2; 
      margin-bottom: 16px; 
    }
    .hero p { 
      font-size: 16px; 
      color: var(--text-muted); 
      max-width: 600px; 
      margin: 0 auto; 
    }
    

    
    .cards { 
      display: grid; 
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); 
      gap: 24px; 
      max-width: 1000px; 
      margin: 0 auto; 
      padding: 0 24px 80px; 
    }
    .card { 
      background: var(--surface); 
      border: 1px solid var(--border); 
      border-radius: var(--radius); 
      padding: 32px; 
      box-shadow: var(--shadow-sm); 
      display: flex; 
      flex-direction: column; 
    }
    .card h3 { 
      font-size: 18px; 
      font-weight: 600; 
      margin-bottom: 8px; 
      color: var(--text-main); 
    }
    .card p { 
      font-size: 14px; 
      color: var(--text-muted); 
      margin-bottom: 24px; 
      flex-grow: 1; 
    }
    
    .btn { 
      display: inline-flex; 
      align-items: center; 
      justify-content: center; 
      padding: 10px 20px; 
      border-radius: 6px; 
      font-size: 14px; 
      font-weight: 500; 
      cursor: pointer; 
      border: 1px solid transparent; 
      width: 100%; 
      transition: all 0.2s ease; 
      font-family: inherit;
    }
    .btn-primary { 
      background: var(--primary); 
      color: white; 
    }
    .btn-primary:hover { 
      background: var(--primary-hover); 
    }
    .btn-outline { 
      background: var(--surface); 
      color: var(--text-main); 
      border-color: var(--border); 
    }
    .btn-outline:hover { 
      background: #f1f5f9; 
    }
    
    textarea { 
      width: 100%; 
      height: 160px; 
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; 
      font-size: 13px; 
      border: 1px solid var(--border); 
      border-radius: 6px; 
      padding: 12px; 
      resize: vertical; 
      color: var(--text-main); 
      background: #f8fafc; 
      margin-bottom: 16px; 
      outline: none; 
    }
    textarea:focus { 
      border-color: var(--primary); 
      background: var(--surface); 
      box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1); 
    }
    .error-msg { 
      color: #dc2626; 
      font-size: 13px; 
      margin-bottom: 12px; 
      display: none; 
      font-weight: 500; 
    }
    
    .spinner-inline { 
      display: none; 
      width: 16px; 
      height: 16px; 
      border: 2px solid rgba(255,255,255,0.3); 
      border-top-color: currentColor; 
      border-radius: 50%; 
      animation: spin 0.6s linear infinite; 
      margin-left: 8px;
    }
    .btn-outline .spinner-inline {
      border-color: rgba(15, 23, 42, 0.2);
      border-top-color: var(--text-main);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="topbar">
    <h1>Credit Dispute System</h1>
  </div>

  <div class="hero">
    <h2>Automated Credit Dispute Resolution</h2>
    <p>Upload a credit report to reconcile bureaus, analyze anomalies, classify disputes, and generate formal correspondence.</p>
  </div>



  <div class="cards">
    <div class="card">
      <h3>Single Bureau Analysis</h3>
      <p>Test the system with a pre-loaded Experian report containing standard anomalies.</p>
      <button class="btn btn-primary" onclick="runMock()" id="mock-btn">
        <span id="mock-label">Run Analysis</span>
        <div class="spinner-inline" id="mock-spinner"></div>
      </button>
    </div>

    <div class="card">
      <h3>Multi-Bureau Comparison</h3>
      <p>Compare Experian and CIBIL reports simultaneously to detect discrepancies.</p>
      <button class="btn btn-primary" onclick="runMultiBureau()" id="multi-btn">
        <span id="multi-label">Compare Bureaus</span>
        <div class="spinner-inline" id="multi-spinner"></div>
      </button>
    </div>

    <div class="card">
      <h3>Custom Data Payload</h3>
      <p>Provide JSON data including <code>reportId</code>, <code>borrower</code>, and <code>accounts</code>.</p>
      <textarea id="custom-json" spellcheck="false">${escapeForHtml(mockReportJson)}</textarea>
      <div class="error-msg" id="custom-error">Invalid JSON format</div>
      <button class="btn btn-outline" onclick="runCustom()" id="custom-btn">
        <span id="custom-label">Process Custom Data</span>
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
      } catch { setLoading('mock', false); }
    }
    async function runMultiBureau() {
      setLoading('multi', true);
      try {
        const res = await fetch('/dispute/submit-multi-bureau', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        window.location.href = '/dispute/' + data.jobId + '/result/view';
      } catch { setLoading('multi', false); }
    }
    async function runCustom() {
      const raw = document.getElementById('custom-json').value.trim();
      const errEl = document.getElementById('custom-error');
      errEl.style.display = 'none';
      let parsed;
      try { parsed = JSON.parse(raw); } catch { errEl.style.display = 'block'; return; }
      setLoading('custom', true);
      try {
        const res = await fetch('/dispute/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) });
        const data = await res.json();
        window.location.href = '/dispute/' + data.jobId + '/result/view';
      } catch { setLoading('custom', false); }
    }
    function setLoading(which, on) {
      document.getElementById(which + '-label').style.display = on ? 'none' : 'inline';
      document.getElementById(which + '-spinner').style.display = on ? 'inline-block' : 'none';
      document.getElementById(which + '-btn').disabled = on;
      document.getElementById(which + '-btn').style.opacity = on ? '0.7' : '1';
      document.getElementById(which + '-btn').style.cursor = on ? 'not-allowed' : 'pointer';
    }
  </script>
</body>
</html>`;
}

function buildResultPage(
  jobId: string,
  jobStatus: string,
  result: DisputeGraphState | null,
  processedOn: number = Date.now()
): string {
  const currentStatus = (result?.status ?? jobStatus).toUpperCase();
  const isDone = currentStatus === 'COMPLETE' || currentStatus === 'COMPLETED' || currentStatus === 'FAILED';
  
  const steps = [
    { key: 'RECONCILING', label: 'Reconciling Bureaus', icon: '1', desc: 'Comparing datasets' },
    { key: 'ANALYZING', label: 'Analyzing Anomalies', icon: '2', desc: 'Scanning for inaccuracies' },
    { key: 'IDENTIFYING', label: 'Classifying Disputes', icon: '3', desc: 'Categorizing severity' },
    { key: 'DRAFTING', label: 'Drafting Letters', icon: '4', desc: 'Generating correspondence' },
    { key: 'COMPLETE', label: 'Finalizing', icon: '5', desc: 'Ready for submission' }
  ];
  
  let activeStepIndex = steps.findIndex(s => s.key === currentStatus);
  if (activeStepIndex === -1) {
    const elapsed = Date.now() - processedOn;
    activeStepIndex = Math.min(3, Math.floor(elapsed / 3000));
  }
  if (isDone) activeStepIndex = 4;

  const conflictsHtml = result?.bureauConflicts?.length
    ? `<div class="section-header">
         <h2>Bureau Conflicts</h2>
         <p>Discrepancies identified across reports</p>
       </div>
       <div class="conflicts-grid">` +
      result.bureauConflicts.map((c: BureauConflict) => {
        return `
        <div class="conflict-item">
          <div class="conflict-top">
            <div class="conflict-field">${escapeHtml(c.conflictField)}</div>
            <span class="badge badge-neutral">Target: ${escapeHtml(c.disputeTarget)}</span>
          </div>
          <div class="conflict-account">Acct: ${escapeHtml(c.accountId)}</div>
          <div class="conflict-compare">
            <div class="compare-side">
              <div class="compare-label">Experian</div>
              <div class="compare-val">${escapeHtml(c.experianValue || '—')}</div>
            </div>
            <div class="compare-side">
              <div class="compare-label">CIBIL</div>
              <div class="compare-val">${escapeHtml(c.cibilValue || '—')}</div>
            </div>
          </div>
          <div class="conflict-reasoning">
            <strong>Analysis:</strong> ${escapeHtml(c.reasoning)}<br>
            <span class="ground-truth">Expected: ${escapeHtml(c.groundTruth)}</span>
          </div>
        </div>`;
      }).join('') + `</div>`
    : '';

  // Match letters to disputes
  const disputesWithLetters = result?.disputes?.map((d: any) => {
    const letter = result?.letters?.find((l: DisputeLetter) => 
      (l.lenderName === d.lenderName || (l.accountId && d.accountId && l.accountId === d.accountId))
    );
    return { ...d, letter };
  }) || [];

  const disputesHtml = disputesWithLetters.length
    ? `<div class="section-header" style="margin-top: 48px; display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 16px;">
         <div>
           <h2>Identified Disputes</h2>
           <p>Anomalies categorized for resolution.</p>
         </div>
         <div class="filter-group">
           <button class="filter-btn active" data-filter="ALL" onclick="filterDisputes('ALL')">All</button>
           <button class="filter-btn" data-filter="HIGH" onclick="filterDisputes('HIGH')">High</button>
           <button class="filter-btn" data-filter="MEDIUM" onclick="filterDisputes('MEDIUM')">Medium</button>
           <button class="filter-btn" data-filter="LOW" onclick="filterDisputes('LOW')">Low</button>
         </div>
       </div>
       <div class="disputes-list">` +
      disputesWithLetters.map((d: any, index: number) => {
        const sevClass = d.severity === 'HIGH' ? 'sev-high' : d.severity === 'MEDIUM' ? 'sev-medium' : 'sev-low';
        const hasLetter = !!d.letter;
        return `
        <div class="dispute-card" data-severity="${d.severity}">
          <div class="dispute-row ${hasLetter ? 'clickable' : ''}" onclick="${hasLetter ? `toggleLetter(${index})` : ''}">
            <div class="dispute-severity">
              <span class="severity-badge ${sevClass}">${escapeHtml(d.severity)}</span>
            </div>
            
            <div class="dispute-main">
              <div class="dispute-header">
                <span class="dispute-lender">${escapeHtml(d.lenderName || d.accountId || 'Unknown Lender')}</span>
              </div>
              ${d.recommendedAction ? `<div class="dispute-action">${escapeHtml(d.recommendedAction)}</div>` : ''}
              ${(d.description || d.anomaly) ? `<div class="dispute-desc">${escapeHtml(d.description || d.anomaly)}</div>` : ''}
            </div>

            ${hasLetter ? `<div class="expand-icon" id="icon-${index}">+</div>` : '<div class="expand-spacer"></div>'}
          </div>
          ${hasLetter ? `
            <div class="letter-container" id="letter-${index}" style="display: none;">
              <div class="letter-subject">${escapeHtml(d.letter.subject)}</div>
              <div class="letter-body">${escapeHtml(d.letter.body)}</div>
            </div>
          ` : ''}
        </div>`;
      }).join('') + `</div>`
    : '';

  const errorsHtml = result?.errors?.length
    ? `<div class="alert alert-error"><strong>Errors:</strong><ul>${result.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Result: Job ${jobId}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --primary: #2563eb;
      --radius: 8px;
      --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; 
      background: var(--bg); 
      color: var(--text-main); 
      line-height: 1.5; 
      -webkit-font-smoothing: antialiased; 
    }
    
    .topbar { 
      background: var(--surface); 
      border-bottom: 1px solid var(--border); 
      padding: 16px 32px; 
      display: flex; 
      align-items: center; 
      justify-content: space-between; 
      position: sticky; 
      top: 0; 
      z-index: 100; 
      box-shadow: var(--shadow-sm);
    }
    .topbar-left { display: flex; flex-direction: column; gap: 4px; }
    .topbar-left h1 { font-size: 16px; font-weight: 600; margin: 0; }
    .sub { font-size: 13px; color: var(--text-muted); display: flex; align-items: center; gap: 12px; }
    
    .status-indicator { 
      display: inline-flex; 
      align-items: center; 
      font-size: 11px; 
      font-weight: 600; 
      padding: 2px 8px; 
      border-radius: 4px; 
      text-transform: uppercase; 
    }
    .status-indicator.is-progress { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .status-indicator.is-done { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    .status-indicator.is-failed { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    
    .back-btn { 
      font-size: 13px; 
      color: var(--text-main); 
      text-decoration: none; 
      border: 1px solid var(--border); 
      padding: 6px 12px; 
      border-radius: 6px; 
      font-weight: 500; 
      background: var(--surface);
    }
    .back-btn:hover { background: #f1f5f9; }
    
    .container { max-width: 1000px; margin: 0 auto; padding: 40px 24px; }
    
    /* Processing Screen */
    .waiting-screen { text-align: center; padding: 60px 0; max-width: 480px; margin: 0 auto; }
    .waiting-screen h2 { font-size: 24px; font-weight: 600; margin-bottom: 8px; }
    .waiting-screen p { color: var(--text-muted); margin-bottom: 40px; font-size: 14px; }
    
    .stepper { 
      display: flex; 
      flex-direction: column; 
      text-align: left; 
      background: var(--surface); 
      padding: 32px; 
      border-radius: var(--radius); 
      border: 1px solid var(--border); 
      box-shadow: var(--shadow-sm); 
    }
    
    .step-item {
      display: flex;
      position: relative;
      padding-bottom: 32px; 
    }
    .step-item:last-child {
      padding-bottom: 0;
    }
    .step-item:not(:last-child)::after {
      content: '';
      position: absolute;
      left: 17px; 
      top: 36px; 
      bottom: 0; 
      width: 2px;
      background: var(--border);
      z-index: 1;
    }
    .step-item.completed:not(:last-child)::after {
      background: var(--primary);
    }
    
    .step-icon {
      width: 36px;
      height: 36px;
      flex-shrink: 0;
      border-radius: 50%;
      background: #f8fafc;
      border: 2px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2;
      margin-right: 16px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-muted);
    }
    .step-content { padding-top: 6px; }
    .step-text { font-size: 15px; font-weight: 600; color: var(--text-main); line-height: 1.2; margin-bottom: 4px; }
    .step-desc { font-size: 13px; color: var(--text-muted); }
    
    .step-item.active .step-icon { border-color: var(--primary); color: var(--primary); background: #eff6ff; }
    .step-item.completed .step-icon { border-color: var(--primary); background: var(--primary); color: white; }

    /* Result Dashboard */
    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 48px; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; box-shadow: var(--shadow-sm); }
    .stat-val { font-size: 32px; font-weight: 700; color: var(--text-main); line-height: 1; margin-bottom: 8px; }
    .stat-label { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; }
    
    .section-header { margin-bottom: 24px; }
    .section-header h2 { font-size: 20px; font-weight: 600; color: var(--text-main); margin-bottom: 4px; }
    .section-header p { font-size: 14px; color: var(--text-muted); }
    
    /* Bureau Conflicts */
    .conflicts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 20px; }
    .conflict-item { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; box-shadow: var(--shadow-sm); }
    .conflict-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .conflict-field { font-size: 14px; font-weight: 600; color: var(--text-main); }
    .conflict-account { font-family: monospace; font-size: 12px; color: var(--text-muted); margin-bottom: 16px; }
    
    .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 4px; border: 1px solid transparent; }
    .badge-neutral { background: #f1f5f9; color: #475569; border-color: #e2e8f0; }
    
    .conflict-compare { display: flex; background: #f8fafc; border-radius: 6px; border: 1px solid var(--border); margin-bottom: 16px; overflow: hidden; }
    .compare-side { flex: 1; padding: 12px; border-right: 1px solid var(--border); }
    .compare-side:last-child { border-right: none; }
    .compare-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 4px; }
    .compare-val { font-size: 13px; font-weight: 500; color: var(--text-main); word-break: break-all; }
    
    .conflict-reasoning { font-size: 13px; color: #334155; line-height: 1.5; background: #f8fafc; padding: 12px; border-radius: 6px; border-left: 2px solid var(--border); }
    .ground-truth { display: block; margin-top: 6px; font-weight: 600; color: #15803d; }
    
    /* Disputes & Filters */
    .filter-group { display: flex; gap: 8px; }
    .filter-btn { padding: 6px 12px; font-size: 12px; font-weight: 500; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); border-radius: 6px; cursor: pointer; transition: all 0.2s; }
    .filter-btn:hover { background: #f1f5f9; }
    .filter-btn.active { background: var(--primary); color: white; border-color: var(--primary); }
    
    .disputes-list { display: flex; flex-direction: column; gap: 12px; }
    .dispute-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-sm); overflow: hidden; }
    
    .dispute-row { 
      padding: 20px; 
      display: flex; 
      align-items: flex-start; 
      gap: 16px; 
      transition: background 0.2s; 
    }
    .dispute-row.clickable { cursor: pointer; }
    .dispute-row.clickable:hover { background: #f8fafc; }
    
    .dispute-severity { flex: 0 0 64px; }
    .severity-badge { 
      display: inline-block; 
      text-align: center; 
      width: 100%; 
      font-size: 10px; 
      font-weight: 600; 
      padding: 3px 6px; 
      border-radius: 4px; 
    }
    .sev-high { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
    .sev-medium { background: #fef3c7; color: #b45309; border: 1px solid #fde68a; }
    .sev-low { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    
    .dispute-main { 
      flex: 1; 
      min-width: 0; 
      display: flex; 
      flex-direction: column; 
      gap: 4px; 
    }
    .dispute-header { display: flex; align-items: center; gap: 12px; }
    .dispute-lender { font-weight: 600; font-size: 15px; color: var(--text-main); }
    
    .dispute-action { font-size: 14px; color: var(--text-main); line-height: 1.5; }
    .dispute-desc { font-size: 13px; color: var(--text-muted); line-height: 1.5; }
    
    .expand-icon { 
      flex: 0 0 24px; 
      height: 24px; 
      display: flex; 
      align-items: center; 
      justify-content: center; 
      border-radius: 50%; 
      background: #f1f5f9;
      color: var(--text-muted); 
      font-size: 14px; 
      line-height: 1; 
      transition: all 0.2s;
    }
    .dispute-row.clickable:hover .expand-icon { background: #e2e8f0; color: var(--text-main); }
    .expand-icon.open { transform: rotate(45deg); background: var(--primary); color: white; }
    .expand-spacer { flex: 0 0 24px; height: 24px; }

    /* Expandable Letters */
    .letter-container { border-top: 1px solid var(--border); background: #f8fafc; padding: 24px; }
    .letter-subject { font-size: 14px; font-weight: 600; color: var(--text-main); margin-bottom: 12px; }
    .letter-body { font-size: 13px; line-height: 1.6; color: #334155; white-space: pre-wrap; font-family: 'Times New Roman', Times, serif; background: white; padding: 20px; border: 1px solid var(--border); border-radius: 6px; box-shadow: inset 0 1px 2px rgba(0,0,0,0.02); }
    
    .alert { padding: 16px; border-radius: 6px; margin-bottom: 24px; font-size: 13px; }
    .alert-error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
    .alert-error ul { margin-top: 8px; padding-left: 20px; }
  </style>
  ${!isDone ? '<meta http-equiv="refresh" content="4">' : ''}
</head>
<body>
  <div class="topbar">
    <div class="topbar-left">
      <h1>Credit Dispute System</h1>
      <div class="sub">
        <span>Job #${jobId.substring(0,8)}</span>
        <span class="status-indicator ${isDone ? (currentStatus === 'FAILED' ? 'is-failed' : 'is-done') : 'is-progress'}">
          ${isDone ? (currentStatus === 'FAILED' ? 'Failed' : 'Completed') : 'Processing'}
        </span>
      </div>
    </div>
    <a href="/" class="back-btn">New Report</a>
  </div>

  <div class="container">
    ${!isDone ? `
      <div class="waiting-screen">
        <h2>Processing Data</h2>
        <p>System is analyzing reports. Page refreshes automatically.</p>
        <div class="stepper">
          ${steps.map((step, i) => `
            <div class="step-item ${i === activeStepIndex ? 'active' : i < activeStepIndex ? 'completed' : ''}">
              <div class="step-icon">${step.icon}</div>
              <div class="step-content">
                <div class="step-text">${step.label}</div>
                <div class="step-desc">${step.desc}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : `
      <div class="summary-grid">
        <div class="stat-card">
          <div class="stat-val">${result?.bureauConflicts?.length ?? 0}</div>
          <div class="stat-label">Conflicts</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${result?.anomalies?.length ?? 0}</div>
          <div class="stat-label">Anomalies</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${result?.disputes?.length ?? 0}</div>
          <div class="stat-label">Disputes</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${result?.letters?.length ?? 0}</div>
          <div class="stat-label">Letters</div>
        </div>
      </div>
      
      ${errorsHtml}
      ${conflictsHtml}
      ${disputesHtml}
    `}
  </div>
  
  <script>
    function filterDisputes(severity) {
      // Update buttons
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === severity);
      });
      
      // Update rows
      document.querySelectorAll('.dispute-card').forEach(card => {
        if (severity === 'ALL' || card.dataset.severity === severity) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    }
    
    function toggleLetter(index) {
      const letter = document.getElementById('letter-' + index);
      const icon = document.getElementById('icon-' + index);
      if (letter) {
        if (letter.style.display === 'none') {
          letter.style.display = 'block';
          if (icon) icon.classList.add('open');
        } else {
          letter.style.display = 'none';
          if (icon) icon.classList.remove('open');
        }
      }
    }
  </script>
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
