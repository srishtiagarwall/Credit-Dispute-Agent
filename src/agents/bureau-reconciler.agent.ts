import { Logger } from '@nestjs/common';
import { BureauConflict, CreditReport } from '../types/graph.state';
import { getGeminiModel, generateWithRetry } from './gemini.client';

const logger = new Logger('BureauReconcilerAgent');

const SYSTEM_PROMPT = `You are a credit bureau reconciliation specialist. Your job is to compare two credit reports for the same borrower from different bureaus (Experian and CIBIL) and identify every data conflict.

For each conflict found, you must:
1. Identify WHICH field differs between the two reports
2. Determine which bureau's data is more likely correct (the "ground truth") using this reasoning hierarchy:
   - Payment history: if one bureau shows late payments and the other shows on-time, the one showing LATE payments is more likely to be wrong (lenders rarely under-report, but bureaus sometimes fail to receive corrections)
   - Account status: if one says CLOSED and the other says ACTIVE, check the balance — zero balance + CLOSED is more credible; if payments are ongoing, ACTIVE is more credible
   - Account status WRITTEN_OFF vs ACTIVE: WRITTEN_OFF is a severe negative that requires explicit lender action — if payments are consistently on-time, ACTIVE is almost certainly the ground truth
   - Missing account: if an account appears in one report but not the other, it is a reporting gap — mark as a conflict requiring investigation
   - Balance/credit limit discrepancy: flag if difference exceeds 5% of the higher value
   - Unresolvable: when both could be right (e.g. different inquiry dates, borderline balances)
3. Specify which bureau to dispute: EXPERIAN (if Experian has wrong data), CIBIL (if CIBIL has wrong data), or BOTH

Conflict field types you may use:
- accountStatus
- balance
- creditLimit
- paymentHistory
- accountMissing (account exists in one bureau but not the other)
- inquiryMissing (inquiry exists in one bureau but not the other)

Return ONLY a valid JSON array. Each object must have exactly these fields:
- accountId: string (use the account/inquiry ID from whichever report has it; for missing accounts use the known ID)
- conflictField: one of the field types above
- experianValue: string (what Experian reports for this field; "NOT_PRESENT" if missing from Experian)
- cibilValue: string (what CIBIL reports for this field; "NOT_PRESENT" if missing from CIBIL)
- groundTruth: "EXPERIAN" | "CIBIL" | "UNRESOLVABLE"
- reasoning: string (1-2 sentences explaining why you chose this ground truth)
- disputeTarget: "EXPERIAN" | "CIBIL" | "BOTH"

Do not include conflicts where both bureaus agree. No explanation outside the JSON array.`;

function buildUserPrompt(experian: CreditReport, cibil: CreditReport): string {
  return `Compare these two credit reports for the same borrower and return all conflicts as a JSON array.

EXPERIAN REPORT (reportId: ${experian.reportId}, score: ${experian.creditScore}):
${JSON.stringify(experian, null, 2)}

CIBIL REPORT (reportId: ${cibil.reportId}, score: ${cibil.creditScore}):
${JSON.stringify(cibil, null, 2)}`;
}

export async function runBureauReconcilerAgent(
  experianReport: CreditReport,
  cibilReport: CreditReport,
): Promise<BureauConflict[]> {
  if (experianReport.borrower.pan !== cibilReport.borrower.pan) {
    throw new Error(
      `BureauReconcilerAgent: PAN mismatch — reports are not for the same borrower ` +
      `(${experianReport.borrower.pan} vs ${cibilReport.borrower.pan})`,
    );
  }

  const model = getGeminiModel(SYSTEM_PROMPT);

  logger.log(
    `[${new Date().toISOString()}] BureauReconcilerAgent: comparing ` +
    `${experianReport.bureau} (score=${experianReport.creditScore}) vs ` +
    `${cibilReport.bureau} (score=${cibilReport.creditScore})`,
  );

  const result = await generateWithRetry(model, buildUserPrompt(experianReport, cibilReport));
  const rawText = result.response.text().trim();

  logger.log(`[${new Date().toISOString()}] BureauReconcilerAgent: received response, parsing conflicts`);

  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(
      `BureauReconcilerAgent: could not extract JSON array from response. Raw: ${rawText.slice(0, 200)}`,
    );
  }

  const conflicts: BureauConflict[] = JSON.parse(jsonMatch[0]);

  logger.log(
    `[${new Date().toISOString()}] BureauReconcilerAgent: found ${conflicts.length} conflicts — ` +
    `${conflicts.filter(c => c.disputeTarget === 'EXPERIAN').length} dispute Experian, ` +
    `${conflicts.filter(c => c.disputeTarget === 'CIBIL').length} dispute CIBIL, ` +
    `${conflicts.filter(c => c.disputeTarget === 'BOTH').length} dispute both`,
  );

  return conflicts;
}
