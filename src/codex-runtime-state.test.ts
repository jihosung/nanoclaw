import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';
import {
  formatCodexModelStatus,
  getExampleCodexModelCommand,
  getCodexRuntimeState,
  getPreferredAvailableModels,
  getPreferredCodexModel,
  readCodexAvailableModelsFromCache,
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
      availableModels: 'gpt-5 (default), gpt-5-mini',
    });

    expect(getCodexRuntimeState('dc:1')).toEqual({
      requestedModel: 'gpt-5',
      availableModels: 'gpt-5 (default), gpt-5-mini',
    });
  });

  it('formats current and available models when runtime info exists', () => {
    _initTestDatabase();

    updateCodexRuntimeState('dc:1', {
      requestedModel: 'gpt-5',
      availableModels: 'gpt-5 (default), gpt-5-mini',
    });

    expect(formatCodexModelStatus('dc:1', 'gpt-5.4')).toBe(
      'Model\n- Current: `gpt-5`\n- Available: gpt-5 (default), gpt-5-mini\n- Change: `/model [model name]`\n- Example: `/model gpt-5`',
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
      availableModels: 'gpt-5.4, gpt-5.4-mini',
    });

    expect(getPreferredCodexModel('dc:1', 'gpt-5.4')).toBe('gpt-5.4');
    expect(getPreferredAvailableModels('dc:1')).toBe(
      'gpt-5.4, gpt-5.4-mini',
    );
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

    expect(getExampleCodexModelCommand('dc:1')).toBe('/model gpt-5.4');
  });
});
