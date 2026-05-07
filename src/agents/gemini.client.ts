import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

export const GEMINI_MODEL = 'gemini-1.5-flash';

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
