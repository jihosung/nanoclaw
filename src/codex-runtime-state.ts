import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getRouterState, setRouterState } from './db.js';

export interface CodexRuntimeState {
  requestedModel?: string;
  availableModels?: string;
}

interface CodexModelsCache {
  models?: Array<{
    slug?: string;
  }>;
}

function stateKey(chatJid: string): string {
  return `codex_runtime:${chatJid}`;
}

export function getCodexRuntimeState(chatJid: string): CodexRuntimeState {
  const raw = getRouterState(stateKey(chatJid));
  if (!raw) return {};

  try {
    return JSON.parse(raw) as CodexRuntimeState;
  } catch {
    return {};
  }
}

export function updateCodexRuntimeState(
  chatJid: string,
  patch: CodexRuntimeState,
): void {
  const next = {
    ...getCodexRuntimeState(chatJid),
    ...patch,
  };
  setRouterState(stateKey(chatJid), JSON.stringify(next));
}

export function formatCodexModelStatus(
  chatJid: string,
  effectiveModel: string,
): string {
  const current = `\`${getPreferredCodexModel(chatJid, effectiveModel)}\``;

  const lines = ['Model', `- Current: ${current}`];

  const availableModels = getPreferredAvailableModels(chatJid);
  if (availableModels) {
    lines.push(`- Available: ${availableModels}`);
  }

  lines.push(`- Change: \`/model [model name]\``);
  lines.push(`- Example: \`${getExampleCodexModelCommand(chatJid)}\``);

  return lines.join('\n');
}

export function readCodexAvailableModelsFromCache(
  cachePath = path.join(DATA_DIR, 'codex-auth', 'models_cache.json'),
): string | undefined {
  if (!fs.existsSync(cachePath)) return undefined;

  try {
    const parsed = JSON.parse(
      fs.readFileSync(cachePath, 'utf-8'),
    ) as CodexModelsCache;
    const slugs = (parsed.models || [])
      .map((model) => model.slug?.trim())
      .filter((slug): slug is string => !!slug);
    return slugs.length > 0 ? slugs.join(', ') : undefined;
  } catch {
    return undefined;
  }
}

export function getPreferredCodexModel(
  chatJid: string,
  effectiveModel: string,
): string {
  const state = getCodexRuntimeState(chatJid);
  return state.requestedModel || effectiveModel;
}

export function getPreferredAvailableModels(
  chatJid: string,
): string | undefined {
  const state = getCodexRuntimeState(chatJid);
  return state.availableModels || readCodexAvailableModelsFromCache();
}

export function getExampleCodexModelCommand(chatJid: string): string {
  const available = getPreferredAvailableModels(chatJid);
  const firstModel = available
    ?.split(',')
    .map((entry) => entry.trim().replace(/\s+\(default\)$/i, ''))
    .find(Boolean);

  return `/model ${firstModel || 'gpt-5.4'}`;
}
