import { Logger } from '@nestjs/common';
import { Anomaly, CreditReport, Dispute } from '../types/graph.state';
import { getGeminiModel, generateWithRetry } from './gemini.client';

const logger = new Logger('DisputeIdentifierAgent');

const SYSTEM_PROMPT = `You are a credit dispute classification specialist. Given a list of credit report anomalies, you must classify each one into a formal dispute and determine the appropriate lender to contact.

For each anomaly, produce a dispute object with exactly these fields:
- accountId: string (same as the anomaly's accountId)
- disputeCategory: string (a clear, formal dispute category such as "Erroneous Late Payment Reporting", "Incorrect Account Status", "Duplicate Account Entry", "Excessive Credit Utilization Reporting", "Unauthorized Hard Inquiry")
- lenderName: string (the name of the lender or bureau responsible — extract from the credit report context)
- severity: "HIGH" | "MEDIUM" | "LOW"
  - HIGH: issues that directly damage credit score significantly (incorrect status, missed payments reported wrongly, unauthorized inquiries)
  - MEDIUM: issues that moderately affect score (late payments, high utilization)
  - LOW: minor or informational issues (duplicate accounts, borderline utilization)
- recommendedAction: string (a specific, actionable step such as "Submit formal dispute to Experian with payment proof" or "Request lender to update account status to ACTIVE")

Return ONLY a valid JSON array. No explanation outside the JSON.`;

function buildUserPrompt(anomalies: Anomaly[], report: CreditReport): string {
  return `Classify the following anomalies into formal disputes. Use the credit report data to look up lender names.

Anomalies:
${JSON.stringify(anomalies, null, 2)}

Credit Report Accounts (for lender reference):
${JSON.stringify(report.accounts.map(a => ({ accountId: a.accountId, lenderName: a.lenderName })), null, 2)}

Inquiries (for lender reference):
${JSON.stringify(report.inquiries, null, 2)}`;
}

export async function runDisputeIdentifierAgent(
  anomalies: Anomaly[],
  report: CreditReport,
): Promise<Dispute[]> {
  const model = getGeminiModel(SYSTEM_PROMPT);

  logger.log(`[${new Date().toISOString()}] DisputeIdentifierAgent: classifying ${anomalies.length} anomalies`);

  const result = await generateWithRetry(model, buildUserPrompt(anomalies, report));
  const rawText = result.response.text().trim();

  logger.log(`[${new Date().toISOString()}] DisputeIdentifierAgent: received response, parsing disputes`);

  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`DisputeIdentifierAgent: could not extract JSON array from response. Raw: ${rawText.slice(0, 200)}`);
  }

  const disputes: Dispute[] = JSON.parse(jsonMatch[0]);
  logger.log(`[${new Date().toISOString()}] DisputeIdentifierAgent: classified ${disputes.length} disputes`);

  return disputes;
}
