import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  setRegisteredGroup: vi.fn(),
  updateCodexRuntimeState: vi.fn(),
  readCodexAccountUsage: vi.fn(),
  createPendingEffortSelection: vi.fn(),
  getPendingEffortSelection: vi.fn(),
  getSupportedEffortOptions: vi.fn(),
  resolvePendingEffortSelection: vi.fn(),
}));

vi.mock('./db.js', () => ({
  deleteSession: mocks.deleteSession,
  setRegisteredGroup: mocks.setRegisteredGroup,
}));

vi.mock('./codex-runtime-state.js', () => ({
  formatCodexModelStatus: vi.fn(() => 'model status'),
  formatCodexEffortStatus: vi.fn(() => 'effort status'),
  createPendingEffortSelection: mocks.createPendingEffortSelection,
  getPendingEffortSelection: mocks.getPendingEffortSelection,
  getPreferredCodexEffort: vi.fn(),
  getSupportedEffortOptions: mocks.getSupportedEffortOptions,
  resolvePendingEffortSelection: mocks.resolvePendingEffortSelection,
  updateCodexRuntimeState: mocks.updateCodexRuntimeState,
}));

vi.mock('./codex-account.js', () => ({
  readCodexAccountUsage: mocks.readCodexAccountUsage,
}));

import {
  extractCommand,
  extractPendingEffortSelection,
  handleSessionCommand,
} from './session-commands.js';
import { NewMessage, RegisteredGroup } from './types.js';

describe('handleSessionCommand clear', () => {
  const group: RegisteredGroup = {
    name: 'Test Group',
    folder: 'discord_test',
    trigger: '@Andy',
    added_at: '2026-04-08T00:00:00.000Z',
  };

  const lastMessage: NewMessage = {
    id: 'm1',
    chat_jid: 'dc:test',
    sender: 'user1',
    sender_name: 'User',
    content: '/clear',
    timestamp: '2026-04-08T09:00:00.000Z',
  };

  beforeEach(() => {
    mocks.deleteSession.mockReset();
    mocks.setRegisteredGroup.mockReset();
    mocks.updateCodexRuntimeState.mockReset();
    mocks.readCodexAccountUsage.mockReset();
    mocks.createPendingEffortSelection.mockReset();
    mocks.getPendingEffortSelection.mockReset();
    mocks.getSupportedEffortOptions.mockReset();
    mocks.resolvePendingEffortSelection.mockReset();
  });

  it('kills an active process and clears the stored session', async () => {
    const sessions: Record<string, string> = { discord_test: 'session-123' };
    const lastAgentTimestamp: Record<string, string> = {};
    const killProcess = vi.fn(() => true);
    const closeStdin = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const saveState = vi.fn();

    await handleSessionCommand(
      { type: 'clear' },
      {
        chatJid: 'dc:test',
        group,
        lastMessage,
        sessions,
        lastAgentTimestamp,
        queue: {
          killProcess,
          closeStdin,
        } as any,
        channel: {
          sendMessage,
        } as any,
        saveState,
        markRestartNotice: vi.fn(),
        restartHost: vi.fn(),
      },
    );

    expect(killProcess).toHaveBeenCalledWith('dc:test');
    expect(closeStdin).not.toHaveBeenCalled();
    expect(mocks.deleteSession).toHaveBeenCalledWith('discord_test');
    expect(sessions.discord_test).toBeUndefined();
    expect(lastAgentTimestamp['dc:test']).toBe(lastMessage.timestamp);
    expect(saveState).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      'dc:test',
      'Session cleared. Next message starts a new conversation.',
    );
  });

  it('recognizes /effort commands', () => {
    expect(
      extractCommand([
        {
          ...lastMessage,
          content: '/effort high',
        },
      ]),
    ).toEqual({ type: 'effort', effort: 'high' });
  });

  it('recognizes pending effort numeric replies', () => {
    mocks.getPendingEffortSelection.mockReturnValue({
      model: 'gpt-5.4',
      options: [{ value: 'low' }, { value: 'medium' }],
    });
    mocks.resolvePendingEffortSelection.mockReturnValue({ value: 'medium' });

    expect(
      extractPendingEffortSelection(
        [
          {
            ...lastMessage,
            content: '2',
          },
        ],
        'dc:test',
      ),
    ).toEqual({ type: 'effort', effort: 'medium' });
  });

  it('opens effort selection after changing models', async () => {
    const sessions: Record<string, string> = {};
    const lastAgentTimestamp: Record<string, string> = {};
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const saveState = vi.fn();
    mocks.createPendingEffortSelection.mockReturnValue({
      model: 'gpt-5.4-mini',
      options: [{ value: 'low' }, { value: 'high' }],
    });

    await handleSessionCommand(
      { type: 'model', model: 'gpt-5.4-mini' },
      {
        chatJid: 'dc:test',
        group: { ...group, agentProfile: { brain: 'codex', model: 'gpt-5.4' } },
        lastMessage: {
          ...lastMessage,
          content: '/model gpt-5.4-mini',
        },
        sessions,
        lastAgentTimestamp,
        queue: {} as any,
        channel: {
          sendMessage,
        } as any,
        saveState,
        markRestartNotice: vi.fn(),
        restartHost: vi.fn(),
      },
    );

    expect(mocks.setRegisteredGroup).toHaveBeenCalledWith(
      'dc:test',
      expect.objectContaining({
        agentProfile: expect.objectContaining({
          model: 'gpt-5.4-mini',
          effort: undefined,
        }),
      }),
    );
    expect(mocks.updateCodexRuntimeState).toHaveBeenCalledWith(
      'dc:test',
      expect.objectContaining({
        requestedModel: 'gpt-5.4-mini',
        requestedEffort: undefined,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'dc:test',
      'Model set to `gpt-5.4-mini`. Choose the effort for the next message.\n\n' +
        'effort status',
    );
  });

  it('sets effort from a numeric selection', async () => {
    const sessions: Record<string, string> = {};
    const lastAgentTimestamp: Record<string, string> = {};
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const saveState = vi.fn();
    mocks.getPendingEffortSelection.mockReturnValue({
      model: 'gpt-5.4',
      options: [{ value: 'low' }, { value: 'high' }],
    });

    await handleSessionCommand(
      { type: 'effort', effort: '2' },
      {
        chatJid: 'dc:test',
        group: { ...group, agentProfile: { brain: 'codex', model: 'gpt-5.4' } },
        lastMessage: {
          ...lastMessage,
          content: '2',
        },
        sessions,
        lastAgentTimestamp,
        queue: {} as any,
        channel: {
          sendMessage,
        } as any,
        saveState,
        markRestartNotice: vi.fn(),
        restartHost: vi.fn(),
      },
    );

    expect(mocks.setRegisteredGroup).toHaveBeenCalledWith(
      'dc:test',
      expect.objectContaining({
        agentProfile: expect.objectContaining({
          model: 'gpt-5.4',
          effort: 'high',
        }),
      }),
    );
    expect(mocks.updateCodexRuntimeState).toHaveBeenCalledWith('dc:test', {
      requestedEffort: 'high',
      pendingEffortSelection: undefined,
    });
    expect(sendMessage).toHaveBeenCalledWith(
      'dc:test',
      'Effort set to `high` for `gpt-5.4`. Applies from next message.',
    );
  });
});
