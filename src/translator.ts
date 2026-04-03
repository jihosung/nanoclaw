/**
 * Korean ↔ English translator using Gemini 2.5 Flash.
 * Hooked into the NanoClaw message pipeline in src/index.ts.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

import { logger } from './logger.js';

const KOREAN_BLOCK_START = 0xac00;
const KOREAN_BLOCK_END = 0xd7a3;
const KOREAN_RATIO_THRESHOLD = 0.1;
const API_TIMEOUT_MS = 10_000;

function containsKorean(text: string): boolean {
  const chars = [...text];
  if (chars.length === 0) return false;
  const koreanCount = chars.filter((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp >= KOREAN_BLOCK_START && cp <= KOREAN_BLOCK_END;
  }).length;
  return koreanCount / chars.length >= KOREAN_RATIO_THRESHOLD;
}

function stripCodeBlocks(text: string): { stripped: string; blocks: string[] } {
  const blocks: string[] = [];
  const stripped = text.replace(/```[\s\S]*?```/g, (match) => {
    blocks.push(match);
    return `\x00CODEBLOCK${blocks.length - 1}\x00`;
  });
  return { stripped, blocks };
}

function restoreCodeBlocks(text: string, blocks: string[]): string {
  return text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => blocks[parseInt(i)]);
}

async function callGemini(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const genModel = genAI.getGenerativeModel({ model });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const result = await genModel.generateContent(prompt);
    return result.response.text().trim();
  } finally {
    clearTimeout(timeout);
  }
}

export async function translateToEnglish(
  text: string,
  apiKey: string,
  model: string,
): Promise<string> {
  if (!containsKorean(text)) return text;

  const { stripped, blocks } = stripCodeBlocks(text);

  try {
    const prompt = `Translate the following text to English. Output only the translation, no explanations or labels.\n\n${stripped}`;
    const translated = await callGemini(apiKey, model, prompt);
    return restoreCodeBlocks(translated, blocks);
  } catch (err) {
    logger.warn({ err }, 'translateToEnglish failed, using original text');
    return text;
  }
}

export async function translateToKorean(
  text: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const { stripped, blocks } = stripCodeBlocks(text);

  try {
    const prompt = `Translate the following text to Korean. Output only the translation, no explanations or labels.\n\n${stripped}`;
    const translated = await callGemini(apiKey, model, prompt);
    return restoreCodeBlocks(translated, blocks);
  } catch (err) {
    logger.warn({ err }, 'translateToKorean failed, using original text');
    return text;
  }
}
