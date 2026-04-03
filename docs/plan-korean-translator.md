# Plan: Korean ↔ English Translator via Gemini API

Translate Korean user messages to English before NanoClaw processes them,
then translate NanoClaw's English reply back to Korean before delivery.

## Architecture

```
Discord (Korean)
  → [translate KO→EN]  ← Gemini 2.5 Flash API
    → NanoClaw agent (English)
      → [translate EN→KO]  ← Gemini 2.5 Flash API
        → Discord (Korean)
```

No extra Docker container needed — translation calls go directly to the Gemini API
from the NanoClaw process.

---

## 1. Gemini API Setup

- Model: **gemini-2.5-flash** — fast, cheap, excellent Korean↔English quality
- API key from Google AI Studio (aistudio.google.com)
- Add to `.env`: `GEMINI_API_KEY=...`
- Use the `@google/generative-ai` npm package (or plain `fetch` to the REST API)

---

## 2. Translation Utility

Add `src/translator.ts`:
- `translateToEnglish(text: string): Promise<string>` — calls Gemini API
- `translateToKorean(text: string): Promise<string>` — calls Gemini API
- Language detection: skip translation if input is already English (heuristic: Unicode Korean block ratio)
- Timeout + fallback: if API call fails, pass through original text unchanged
- System prompt: `"Translate the following text to [language]. Output only the translation, no explanations or labels."`

---

## 3. Pipeline Integration (src/index.ts)

**Incoming (KO → EN):**
```
onMessage callback → detect language → translateToEnglish(prompt) → runAgent(translated)
```

**Outgoing (EN → KO):**
```
streaming callback → translateToKorean(result) → sendMessage(translated)
```

Translation happens in the **NanoClaw process** (not inside the agent container),
so no changes to the container image are needed.

---

## 4. Configuration

Add to `.env`:
```
TRANSLATOR_ENABLED=true
GEMINI_API_KEY=your_key_here
TRANSLATOR_MODEL=gemini-2.5-flash
```

Per-group opt-in: add `"translatorEnabled": true` to the group's entry in the
registered groups config — so only specific channels use translation.

---

## 5. Key Decisions to Resolve

| Decision | Options |
|----------|---------|
| Language detection | Korean Unicode block ratio (U+AC00–U+D7A3), or `franc` npm package |
| Translation scope | All channels, or per-group opt-in |
| Prompt format | System prompt instructing translate-only, no commentary |
| Fallback | Pass-through on API error/timeout |
| Code block handling | Skip translation inside ``` blocks to preserve code |

---

## 6. Implementation Steps

1. Get Gemini API key from aistudio.google.com
2. Add `GEMINI_API_KEY` and `TRANSLATOR_ENABLED` to `.env`
3. Install `@google/generative-ai` npm package
4. Create `src/translator.ts` with Gemini API client
5. Hook `translateToEnglish` into incoming message pipeline in `src/index.ts`
6. Hook `translateToKorean` into outgoing result callback in `src/index.ts`
7. Add per-group `translatorEnabled` flag support
8. Test end-to-end: Korean Discord message → English agent → Korean Discord reply
9. Tune system prompt to ensure clean output (no "Translation:" prefix etc.)
10. Handle edge cases: mixed Korean/English, code blocks, URLs
