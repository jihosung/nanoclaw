import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getRouterState, setRouterState } from './db.js';

export interface CodexRuntimeState {
  requestedModel?: string;
  requestedEffort?: string;
  availableModels?: string;
  modelCatalog?: CodexModelCatalogEntry[];
  pendingEffortSelection?: PendingEffortSelection;
}

export interface CodexReasoningEffortOption {
  value: string;
  description?: string;
}

export interface CodexModelCatalogEntry {
  id: string;
  displayName?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: CodexReasoningEffortOption[];
}

export interface PendingEffortSelection {
  model: string;
  options: CodexReasoningEffortOption[];
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
  const currentModel = getPreferredCodexModel(chatJid, effectiveModel);
  const current = `\`${currentModel}\``;

  const lines = ['Model', `- Current: ${current}`];
  const effort = getPreferredCodexEffort(chatJid, effectiveModel);
  if (effort) {
    lines.push(`- Effort: \`${effort}\``);
  }

  const availableModels = getPreferredAvailableModels(chatJid);
  if (availableModels) {
    lines.push(`- Available: ${availableModels}`);
  }

  lines.push(`- Change model: \`/model [model name]\``);
  lines.push(`- Change effort: \`/effort\``);
  lines.push(`- Example: \`${getExampleCodexModelCommand(chatJid)}\``);

  return lines.join('\n');
}

export function formatCodexEffortStatus(
  chatJid: string,
  effectiveModel: string,
  targetModel = getPreferredCodexModel(chatJid, effectiveModel),
): string {
  const currentEffort = getPreferredCodexEffort(chatJid, targetModel);
  const options = getSupportedEffortOptions(chatJid, targetModel);
  const lines = ['Effort', `- Model: \`${targetModel}\``];

  if (currentEffort) {
    lines.push(`- Current: \`${currentEffort}\``);
  }

  if (options.length === 0) {
    lines.push(
      '- Options unavailable. Start a Codex run first so NanoClaw can fetch model metadata.',
    );
    return lines.join('\n');
  }

  lines.push('- Reply with one number to choose:');
  for (const [index, option] of options.entries()) {
    const description = option.description ? ` - ${option.description}` : '';
    lines.push(`- ${index + 1} = \`${option.value}\`${description}`);
  }

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

export function getPreferredCodexEffort(
  chatJid: string,
  effectiveModel: string,
): string | undefined {
  const state = getCodexRuntimeState(chatJid);
  if (state.requestedEffort) return state.requestedEffort;

  const currentModel = getPreferredCodexModel(chatJid, effectiveModel);
  return getModelCatalogEntry(chatJid, currentModel)?.defaultReasoningEffort;
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

export function getModelCatalog(chatJid: string): CodexModelCatalogEntry[] {
  return getCodexRuntimeState(chatJid).modelCatalog || [];
}

export function getModelCatalogEntry(
  chatJid: string,
  modelId: string,
): CodexModelCatalogEntry | undefined {
  return getModelCatalog(chatJid).find((entry) => entry.id === modelId);
}

export function getSupportedEffortOptions(
  chatJid: string,
  modelId: string,
): CodexReasoningEffortOption[] {
  return (
    getModelCatalogEntry(chatJid, modelId)?.supportedReasoningEfforts || []
  );
}

export function getPendingEffortSelection(
  chatJid: string,
): PendingEffortSelection | undefined {
  return getCodexRuntimeState(chatJid).pendingEffortSelection;
}

export function createPendingEffortSelection(
  chatJid: string,
  modelId: string,
): PendingEffortSelection | undefined {
  const options = getSupportedEffortOptions(chatJid, modelId);
  if (options.length === 0) return undefined;

  return {
    model: modelId,
    options,
  };
}

export function resolvePendingEffortSelection(
  chatJid: string,
  content: string,
): CodexReasoningEffortOption | undefined {
  const pending = getPendingEffortSelection(chatJid);
  if (!pending) return undefined;

  const selection = Number.parseInt(content.trim(), 10);
  if (!Number.isFinite(selection) || selection < 1) return undefined;
  return pending.options[selection - 1];
}
