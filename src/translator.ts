/**
 * Korean ↔ English translator using a local Ollama model.
 * Hooked into the NanoClaw message pipeline in src/index.ts.
 */
import { logger } from './logger.js';

const KOREAN_BLOCK_START = 0xac00;
const KOREAN_BLOCK_END = 0xd7a3;
const KOREAN_MIN_CHARS = 2;
const API_TIMEOUT_MS = 30_000;

function containsKorean(text: string): boolean {
  let count = 0;
  for (const c of text) {
    const cp = c.codePointAt(0) ?? 0;
    if (cp >= KOREAN_BLOCK_START && cp <= KOREAN_BLOCK_END) {
      count++;
      if (count >= KOREAN_MIN_CHARS) return true;
    }
  }
  return false;
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

async function callOllama(
  baseUrl: string,
  model: string,
  prompt: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { message?: { content?: string } };
    return (data.message?.content ?? '').trim();
  } finally {
    clearTimeout(timeout);
  }
}

const PREVIEW_LEN = 80;
function preview(text: string): string {
  return text.length > PREVIEW_LEN ? text.slice(0, PREVIEW_LEN) + '…' : text;
}

export async function translateToEnglish(
  text: string,
  translatorUrl: string,
  model: string,
): Promise<string> {
  if (!containsKorean(text)) {
    logger.info(
      { preview: preview(text) },
      '[translator] KO→EN skipped (no Korean detected)',
    );
    return text;
  }

  const { stripped, blocks } = stripCodeBlocks(text);

  try {
    logger.info({ input: preview(stripped) }, '[translator] KO→EN start');
    const prompt = `Translate the following text to English. Output only the translation, no explanations or labels.\n\n${stripped}`;
    const translated = await callOllama(translatorUrl, model, prompt);
    const result = restoreCodeBlocks(translated, blocks);
    logger.info(
      { input: preview(stripped), output: preview(result) },
      '[translator] KO→EN done',
    );
    return result;
  } catch (err) {
    logger.warn(
      { err, input: preview(stripped) },
      '[translator] KO→EN failed, using original text',
    );
    return text;
  }
}

export async function translateToKorean(
  text: string,
  translatorUrl: string,
  model: string,
): Promise<string> {
  const { stripped, blocks } = stripCodeBlocks(text);

  try {
    logger.info({ input: preview(stripped) }, '[translator] EN→KO start');
    const prompt = `Translate the following text to Korean. Output only the translation, no explanations or labels.\n\n${stripped}`;
    const translated = await callOllama(translatorUrl, model, prompt);
    const result = restoreCodeBlocks(translated, blocks);
    logger.info(
      { input: preview(stripped), output: preview(result) },
      '[translator] EN→KO done',
    );
    return result;
  } catch (err) {
    logger.warn(
      { err, input: preview(stripped) },
      '[translator] EN→KO failed, using original text',
    );
    return text;
  }
}
