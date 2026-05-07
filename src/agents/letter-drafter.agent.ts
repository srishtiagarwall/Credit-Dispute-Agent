import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { Dispute, DisputeLetter, Borrower } from '../types/graph.state';
import { getGeminiModel } from './gemini.client';

const logger = new Logger('LetterDrafterAgent');

const SYSTEM_PROMPT = `You are a legal correspondence specialist who drafts formal credit dispute letters on behalf of consumers.

Draft a formal, professional dispute letter for each dispute provided. Rules:
1. Start with the borrower's name and address, then the date, then "To: [LenderName] Dispute Resolution Department" — do NOT write "[Lender Address]" or any placeholder text anywhere in the letter
2. Reference the account ID clearly in the opening paragraph
3. Explain the specific dispute with factual, precise language drawn from the dispute details provided
4. Cite the Consumer Protection Act and the credit bureau's obligation to investigate and correct inaccurate information
5. Request a specific corrective action (e.g., "remove the late payment notation", "update account status to ACTIVE")
6. Close professionally requesting written confirmation of resolution within 30 days
7. IMPORTANT: Never use placeholder text like "[Lender Address]", "[Date]", "[Your Name]", or any bracketed fields — use only the real data provided

For each dispute, return a JSON object with exactly these fields:
- letterId: string (format: LETTER-YYYYMMDD-XXXX where XXXX is a random 4-char alphanumeric)
- lenderName: string
- accountId: string
- subject: string (concise subject line)
- body: string (the full letter text, no placeholders)
- generatedAt: string (current ISO timestamp)

Return ONLY a valid JSON array of letter objects. No explanation outside the JSON.`;

function buildUserPrompt(disputes: Dispute[], borrower: Borrower): string {
  return `Draft formal dispute letters for the following HIGH and MEDIUM severity disputes.

Borrower Information:
- Name: ${borrower.name}
- Address: ${borrower.address}

Disputes requiring letters:
${JSON.stringify(disputes, null, 2)}

Today's date: ${new Date().toISOString().split('T')[0]}`;
}

export async function runLetterDrafterAgent(
  disputes: Dispute[],
  borrower: Borrower,
): Promise<DisputeLetter[]> {
  const actionableDisputes = disputes.filter(
    (d) => d.severity === 'HIGH' || d.severity === 'MEDIUM',
  );

  if (actionableDisputes.length === 0) {
    logger.log(`[${new Date().toISOString()}] LetterDrafterAgent: no HIGH/MEDIUM disputes, skipping`);
    return [];
  }

  const model = getGeminiModel(SYSTEM_PROMPT);

  logger.log(`[${new Date().toISOString()}] LetterDrafterAgent: drafting letters for ${actionableDisputes.length} disputes`);

  const result = await model.generateContent(buildUserPrompt(actionableDisputes, borrower));
  const rawText = result.response.text().trim();

  logger.log(`[${new Date().toISOString()}] LetterDrafterAgent: received response, parsing letters`);

  const jsonMatch = rawText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`LetterDrafterAgent: could not extract JSON array from response. Raw: ${rawText.slice(0, 200)}`);
  }

  const letters: DisputeLetter[] = JSON.parse(jsonMatch[0]);

  // Ensure every letter has a valid UUID-backed letterId
  const normalizedLetters = letters.map((letter) => ({
    ...letter,
    letterId: letter.letterId || `LETTER-${uuidv4()}`,
    generatedAt: letter.generatedAt || new Date().toISOString(),
  }));

  logger.log(`[${new Date().toISOString()}] LetterDrafterAgent: drafted ${normalizedLetters.length} letters`);

  return normalizedLetters;
}
