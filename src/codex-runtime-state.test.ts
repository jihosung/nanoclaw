import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';
import {
  createPendingEffortSelection,
  formatCodexModelStatus,
  formatCodexEffortStatus,
  getExampleCodexModelCommand,
  getCodexRuntimeState,
  getPendingEffortSelection,
  getPreferredCodexEffort,
  getPreferredAvailableModels,
  getPreferredCodexModel,
  getSupportedEffortOptions,
  readCodexAvailableModelsFromCache,
  resolvePendingEffortSelection,
  updateCodexRuntimeState,
} from './codex-runtime-state.js';

describe('codex runtime state', () => {
  afterEach(() => {
    _closeDatabase();
  });

  it('stores and retrieves runtime model info per chat', () => {
    _initTestDatabase();

    updateCodexRuntimeState('dc:1', {
      requestedModel: 'gpt-5',
      requestedEffort: 'high',
      availableModels: 'gpt-5 (default), gpt-5-mini',
    });

    expect(getCodexRuntimeState('dc:1')).toEqual({
      requestedModel: 'gpt-5',
      requestedEffort: 'high',
      availableModels: 'gpt-5 (default), gpt-5-mini',
    });
  });

  it('formats current and available models when runtime info exists', () => {
    _initTestDatabase();

    updateCodexRuntimeState('dc:1', {
      requestedModel: 'gpt-5',
      requestedEffort: 'high',
      availableModels: 'gpt-5 (default), gpt-5-mini',
    });

    expect(formatCodexModelStatus('dc:1', 'gpt-5.4')).toBe(
      'Model\n- Current: `gpt-5`\n- Effort: `high`\n- Available: gpt-5 (default), gpt-5-mini\n- Change model: `!model [model name]`\n- Change effort: `!effort`\n- Example: `!model gpt-5`',
    );
  });

  it('falls back to the effective model when runtime info is missing', () => {
    _initTestDatabase();

    expect(formatCodexModelStatus('dc:1', 'gpt-5.4')).toContain(
      '- Current: `gpt-5.4`',
    );
  });

  it('prefers app-server-derived runtime values over fallback values', () => {
    _initTestDatabase();

    updateCodexRuntimeState('dc:1', {
      requestedModel: 'gpt-5.4',
      requestedEffort: 'medium',
      availableModels: 'gpt-5.4, gpt-5.4-mini',
    });

    expect(getPreferredCodexModel('dc:1', 'gpt-5.4')).toBe('gpt-5.4');
    expect(getPreferredCodexEffort('dc:1', 'gpt-5.4')).toBe('medium');
    expect(getPreferredAvailableModels('dc:1')).toBe('gpt-5.4, gpt-5.4-mini');
  });

  it('reads available models from the codex cache file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-'));
    const cachePath = path.join(tempDir, 'models_cache.json');
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        models: [{ slug: 'gpt-5.4' }, { slug: 'gpt-5.4-mini' }],
      }),
    );

    expect(readCodexAvailableModelsFromCache(cachePath)).toBe(
      'gpt-5.4, gpt-5.4-mini',
    );
  });

  it('builds a model change example from the first available model', () => {
    _initTestDatabase();

    updateCodexRuntimeState('dc:1', {
      availableModels: 'gpt-5.4 (default), gpt-5.4-mini',
    });

    expect(getExampleCodexModelCommand('dc:1')).toBe('!model gpt-5.4');
  });

  it('formats effort options from the model catalog', () => {
    _initTestDatabase();

    updateCodexRuntimeState('dc:1', {
      requestedModel: 'gpt-5.4',
      modelCatalog: [
        {
          id: 'gpt-5.4',
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [
            { value: 'low', description: 'Lower latency' },
            { value: 'medium', description: 'Balanced' },
            { value: 'high', description: 'Deeper reasoning' },
          ],
        },
      ],
    });

    expect(getSupportedEffortOptions('dc:1', 'gpt-5.4')).toEqual([
      { value: 'low', description: 'Lower latency' },
      { value: 'medium', description: 'Balanced' },
      { value: 'high', description: 'Deeper reasoning' },
    ]);
    expect(formatCodexEffortStatus('dc:1', 'gpt-5.4')).toBe(
      'Effort\n- Model: `gpt-5.4`\n- Current: `medium`\n- Reply with one number to choose:\n- 1 = `low` - Lower latency\n- 2 = `medium` - Balanced\n- 3 = `high` - Deeper reasoning',
    );
  });

  it('creates and resolves pending effort selections', () => {
    _initTestDatabase();

    updateCodexRuntimeState('dc:1', {
      modelCatalog: [
        {
          id: 'gpt-5.4',
          supportedReasoningEfforts: [
            { value: 'low' },
            { value: 'medium' },
            { value: 'high' },
          ],
        },
      ],
    });

    const pending = createPendingEffortSelection('dc:1', 'gpt-5.4');
    expect(pending).toEqual({
      model: 'gpt-5.4',
      options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
    });

    updateCodexRuntimeState('dc:1', {
      pendingEffortSelection: pending,
    });

    expect(getPendingEffortSelection('dc:1')).toEqual(pending);
    expect(resolvePendingEffortSelection('dc:1', '2')).toEqual({
      value: 'medium',
    });
  });
});
