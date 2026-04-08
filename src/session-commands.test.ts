import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  setRegisteredGroup: vi.fn(),
  updateCodexRuntimeState: vi.fn(),
  readCodexAccountUsage: vi.fn(),
}));

vi.mock('./db.js', () => ({
  deleteSession: mocks.deleteSession,
  setRegisteredGroup: mocks.setRegisteredGroup,
}));

vi.mock('./codex-runtime-state.js', () => ({
  formatCodexModelStatus: vi.fn(() => 'model status'),
  updateCodexRuntimeState: mocks.updateCodexRuntimeState,
}));

vi.mock('./codex-account.js', () => ({
  readCodexAccountUsage: mocks.readCodexAccountUsage,
}));

import { handleSessionCommand } from './session-commands.js';
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
});
