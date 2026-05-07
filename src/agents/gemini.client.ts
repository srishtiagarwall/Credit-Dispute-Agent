import { Logger } from '@nestjs/common';
import { GoogleGenerativeAI, GenerativeModel, GenerateContentResult } from '@google/generative-ai';

export const GEMINI_MODEL = 'gemini-2.5-pro';

const logger = new Logger('GeminiClient');

const RETRY_DELAYS_MS = [2000, 5000, 10000]; // 3 attempts: 2s, 5s, 10s

export function getGeminiModel(systemInstruction: string): GenerativeModel {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  return new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction,
  });
}

// Wraps generateContent with retry + exponential backoff for transient fetch failures.
// "fetch failed" from Undici is a known intermittent issue with generativelanguage.googleapis.com.
export async function generateWithRetry(
  model: GenerativeModel,
  prompt: string,
): Promise<GenerateContentResult> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await model.generateContent(prompt);
    } catch (err) {
      lastError = err as Error;
      const isFetchError =
        lastError.message.includes('fetch failed') ||
        lastError.message.includes('ECONNRESET') ||
        lastError.message.includes('ETIMEDOUT') ||
        lastError.message.includes('ECONNREFUSED');

      if (!isFetchError || attempt === RETRY_DELAYS_MS.length) {
        throw lastError;
      }

      const delayMs = RETRY_DELAYS_MS[attempt];
      logger.warn(
        `GeminiClient: attempt ${attempt + 1} failed (${lastError.message.slice(0, 80)}…) — retrying in ${delayMs / 1000}s`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
