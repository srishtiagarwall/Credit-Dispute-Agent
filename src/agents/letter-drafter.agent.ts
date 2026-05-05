import { Logger } from '@nestjs/common';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';
import { Dispute, DisputeLetter, Borrower } from '../types/graph.state';

const logger = new Logger('LetterDrafterAgent');

const SYSTEM_PROMPT = `You are a legal correspondence specialist who drafts formal credit dispute letters on behalf of consumers.

Draft a formal, professional dispute letter for each dispute provided. The letter must:
1. Be addressed to the specific lender or credit bureau
2. Reference the account ID clearly
3. Explain the dispute with factual language
4. Cite the Fair Credit Reporting Act (FCRA) Section 611 as the basis for the dispute
5. Request specific corrective action
6. Include a professional closing requesting written confirmation within 30 days

For each dispute, return a JSON object with exactly these fields:
- letterId: string (a unique identifier you generate, format: LETTER-YYYYMMDD-XXXX)
- lenderName: string
- accountId: string
- subject: string (concise subject line for the letter)
- body: string (the full formal letter text)
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const actionableDisputes = disputes.filter(
    (d) => d.severity === 'HIGH' || d.severity === 'MEDIUM',
  );

  if (actionableDisputes.length === 0) {
    logger.log(`[${new Date().toISOString()}] LetterDrafterAgent: no HIGH/MEDIUM disputes, skipping`);
    return [];
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-pro',
    systemInstruction: SYSTEM_PROMPT,
  });

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
