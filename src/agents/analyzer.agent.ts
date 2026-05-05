import { Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Anomaly, CreditReport } from '../types/graph.state';

const logger = new Logger('AnalyzerAgent');

const SYSTEM_PROMPT = `You are a credit report analysis expert. Your job is to examine a credit report and flag all anomalies that could be grounds for a credit dispute.

You must detect the following anomaly types:
- LATE_PAYMENT: Any account with payment status LATE_30, LATE_60, LATE_90, or MISSED
- INCORRECT_STATUS: Account status that contradicts the payment history (e.g., marked WRITTEN_OFF despite consistent on-time payments)
- DUPLICATE_ACCOUNT: Accounts from the same lender opened within 30 days of each other with similar characteristics
- HIGH_UTILIZATION: Credit card accounts where balance exceeds 85% of credit limit
- UNKNOWN_INQUIRY: Hard inquiries where the purpose is "Unknown" or unexplained

Return ONLY a valid JSON array of anomaly objects. Each object must have exactly these fields:
- accountId: string (the account or inquiry ID)
- issueType: one of LATE_PAYMENT | INCORRECT_STATUS | DUPLICATE_ACCOUNT | HIGH_UTILIZATION | UNKNOWN_INQUIRY
- rawDetail: string (a concise explanation of why this is flagged)

Do not include any explanation outside the JSON array.`;

function buildUserPrompt(report: CreditReport): string {
  return `Analyze the following credit report and return all anomalies as a JSON array.

Credit Report:
${JSON.stringify(report, null, 2)}`;
}

export async function runAnalyzerAgent(
  report: CreditReport,
): Promise<Anomaly[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-pro',
    systemInstruction: SYSTEM_PROMPT,
  });

  logger.log(`[${new Date().toISOString()}] AnalyzerAgent: sending request to Gemini`);

  const result = await model.generateContent(buildUserPrompt(report));
  const rawText = result.response.text().trim();

  logger.log(`[${new Date().toISOString()}] AnalyzerAgent: received response, parsing anomalies`);

  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`AnalyzerAgent: could not extract JSON array from response. Raw: ${rawText.slice(0, 200)}`);
  }

  const anomalies: Anomaly[] = JSON.parse(jsonMatch[0]);
  logger.log(`[${new Date().toISOString()}] AnalyzerAgent: found ${anomalies.length} anomalies`);

  return anomalies;
}
