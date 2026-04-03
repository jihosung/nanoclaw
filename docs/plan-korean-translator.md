# Plan: Korean ↔ English Local LLM Translator

Translate Korean user messages to English before NanoClaw processes them,
then translate NanoClaw's English reply back to Korean before delivery.

## Architecture

```
Discord (Korean)
  → [translate KO→EN]  ← local LLM (Ollama in Docker)
    → NanoClaw agent (English)
      → [translate EN→KO]  ← local LLM (Ollama in Docker)
        → Discord (Korean)
```

---

## 1. Local LLM Service (Ollama)

- Run **Ollama** as a persistent Docker container (separate from NanoClaw agent containers)
- Expose HTTP API at `http://host.docker.internal:11434` (accessible from NanoClaw process and agent containers)
- Recommended model: **EXAONE-3.5** or **Qwen2.5** — both strong at Korean↔English
- Ollama persists models on a named Docker volume — survives restarts

**Docker run:**
```bash
docker run -d --name ollama \
  -p 11434:11434 \
  -v ollama_data:/root/.ollama \
  --restart unless-stopped \
  ollama/ollama
```

---

## 2. Translation Utility

Add `src/translator.ts`:
- `translateToEnglish(text: string): Promise<string>` — calls Ollama API
- `translateToKorean(text: string): Promise<string>` — calls Ollama API
- Language detection: skip translation if input is already English (heuristic: ASCII ratio or `franc` library)
- Timeout + fallback: if Ollama is unavailable, pass through original text

Ollama chat API endpoint: `POST http://localhost:11434/api/generate`

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
TRANSLATOR_URL=http://localhost:11434
TRANSLATOR_MODEL=exaone3.5:latest
```

Per-group opt-in: add `"translatorEnabled": true` to the group's entry in the
registered groups config — so only specific channels use translation.

---

## 5. Key Decisions to Resolve

| Decision | Options |
|----------|---------|
| Model | EXAONE-3.5 (Korean-specialized), Qwen2.5-7B (multilingual), Gemma3 |
| Language detection | ASCII ratio heuristic, `franc` npm package, or ask LLM |
| Translation scope | All channels, or per-channel opt-in |
| Prompt format | System prompt instructing translate-only, no commentary |
| Fallback | Pass-through on timeout, or error message to user |

---

## 6. Implementation Steps

1. Start Ollama container + pull translation model
2. Create `src/translator.ts` with Ollama API client
3. Add env config (`TRANSLATOR_ENABLED`, `TRANSLATOR_URL`, `TRANSLATOR_MODEL`)
4. Hook `translateToEnglish` into incoming message pipeline in `src/index.ts`
5. Hook `translateToKorean` into outgoing result callback in `src/index.ts`
6. Add per-group `translatorEnabled` flag support
7. Test end-to-end: Korean Discord message → English agent → Korean Discord reply
8. Tune prompt to ensure translator outputs clean text only (no "Translation:" prefix etc.)
