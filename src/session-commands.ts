import { OPENAI_MODEL } from './config.js';
import { readCodexAccountUsage } from './codex-account.js';
import {
  createPendingEffortSelection,
  formatCodexEffortStatus,
  formatCodexModelStatus,
  getPendingEffortSelection,
  getSupportedEffortOptions,
  resolvePendingEffortSelection,
  updateCodexRuntimeState,
} from './codex-runtime-state.js';
import { deleteSession, setRegisteredGroup } from './db.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

export type SessionCommand =
  | { type: 'clear' }
  | { type: 'stop' }
  | { type: 'compact' }
  | { type: 'restart' }
  | { type: 'model'; model: string }
  | { type: 'effort'; effort: string }
  | { type: 'usage' }
  | { type: 'help' };

const COMMAND_RE =
  /^\/(clear|stop|compact|restart|model|effort|usage|help)(?:\s+(.+))?$/i;

/**
 * Scan messages (latest first) for a session command.
 * Bot messages are excluded; human senders (including Discord users where
 * is_from_me is always false) are allowed.
 */
export function extractCommand(messages: NewMessage[]): SessionCommand | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.is_bot_message) continue;
    const m = COMMAND_RE.exec(msg.content.trim());
    if (!m) continue;
    const cmd = m[1].toLowerCase();
    const arg = m[2]?.trim() ?? '';
    if (cmd === 'clear') return { type: 'clear' };
    if (cmd === 'stop') return { type: 'stop' };
    if (cmd === 'compact') return { type: 'compact' };
    if (cmd === 'restart') return { type: 'restart' };
    if (cmd === 'model') return { type: 'model', model: arg };
    if (cmd === 'effort') return { type: 'effort', effort: arg };
    if (cmd === 'usage') return { type: 'usage' };
    if (cmd === 'help') return { type: 'help' };
  }
  return null;
}

export function extractPendingEffortSelection(
  messages: NewMessage[],
  chatJid: string,
): SessionCommand | null {
  if (!getPendingEffortSelection(chatJid)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.is_bot_message) continue;
    const trimmed = msg.content.trim();
    if (!/^\d+$/.test(trimmed)) continue;

    const option = resolvePendingEffortSelection(chatJid, trimmed);
    if (!option) return null;
    return { type: 'effort', effort: option.value };
  }

  return null;
}

export interface CommandDeps {
  chatJid: string;
  group: RegisteredGroup;
  lastMessage: NewMessage;
  sessions: Record<string, string>;
  lastAgentTimestamp: Record<string, string>;
  queue: GroupQueue;
  channel: Channel;
  saveState: () => void;
  markRestartNotice: (chatJid: string, sourceGroup: string) => void;
  restartHost: () => Promise<void>;
}

export async function handleSessionCommand(
  command: SessionCommand,
  deps: CommandDeps,
): Promise<void> {
  const {
    chatJid,
    group,
    lastMessage,
    sessions,
    lastAgentTimestamp,
    queue,
    channel,
    saveState,
    markRestartNotice,
    restartHost,
  } = deps;

  // Advance cursor so these messages aren't re-processed as agent input
  lastAgentTimestamp[chatJid] = lastMessage.timestamp;
  saveState();

  const effectiveModel = group.agentProfile?.model || OPENAI_MODEL || 'gpt-5.4';

  const sendEffortPrompt = async (
    modelId = effectiveModel,
    intro?: string,
  ): Promise<void> => {
    const pending = createPendingEffortSelection(chatJid, modelId);
    if (!pending) {
      updateCodexRuntimeState(chatJid, {
        pendingEffortSelection: undefined,
      });
      const fallbackLines = [
        intro || `Model set to \`${modelId}\`.`,
        formatCodexEffortStatus(chatJid, modelId, modelId),
      ];
      await channel.sendMessage(chatJid, fallbackLines.join('\n\n'));
      return;
    }

    updateCodexRuntimeState(chatJid, {
      pendingEffortSelection: pending,
    });
    const lines = [
      intro,
      formatCodexEffortStatus(chatJid, modelId, modelId),
    ].filter(Boolean);
    await channel.sendMessage(chatJid, lines.join('\n\n'));
  };

  switch (command.type) {
    case 'clear': {
      const killed = queue.killProcess(chatJid);
      if (!killed) {
        queue.closeStdin(chatJid);
      }
      deleteSession(group.folder);
      delete sessions[group.folder];
      updateCodexRuntimeState(chatJid, {
        pendingEffortSelection: undefined,
      });
      logger.info(
        { group: group.name, killedActiveProcess: killed },
        'Session cleared via /clear command',
      );
      await channel.sendMessage(
        chatJid,
        'Session cleared. Next message starts a new conversation.',
      );
      break;
    }

    case 'stop': {
      const isActive = queue.isActive(chatJid);
      if (isActive) {
        queue.closeStdin(chatJid);
        logger.info({ group: group.name }, '/stop command: sent close signal');
        await channel.sendMessage(chatJid, 'Agent stop signal sent.');
      } else {
        await channel.sendMessage(chatJid, 'No active agent to stop.');
      }
      break;
    }

    case 'compact': {
      const piped = queue.sendMessage(chatJid, '/compact');
      if (!piped) {
        await channel.sendMessage(
          chatJid,
          'No active session to compact. Start a conversation first.',
        );
      }
      break;
    }

    case 'restart': {
      if (!group.isMain) {
        await channel.sendMessage(
          chatJid,
          'The `/restart` command is only allowed in the main channel.',
        );
        break;
      }

      markRestartNotice(chatJid, group.folder);
      await channel.sendMessage(chatJid, 'Host restart requested.');
      await restartHost();
      break;
    }

    case 'model': {
      if (!command.model) {
        await channel.sendMessage(
          chatJid,
          formatCodexModelStatus(chatJid, effectiveModel),
        );
        break;
      }

      group.agentProfile = {
        brain: 'codex',
        ...group.agentProfile,
        model: command.model,
        effort: undefined,
      };
      setRegisteredGroup(chatJid, group);
      updateCodexRuntimeState(chatJid, {
        requestedModel: command.model,
        requestedEffort: undefined,
        pendingEffortSelection: undefined,
      });
      logger.info(
        { group: group.name, model: command.model },
        'Model updated via /model command',
      );
      await sendEffortPrompt(
        command.model,
        `Model set to \`${command.model}\`. Choose the effort for the next message.`,
      );
      break;
    }

    case 'effort': {
      if (!command.effort) {
        await sendEffortPrompt();
        break;
      }

      const pending = getPendingEffortSelection(chatJid);
      const options =
        pending?.model === effectiveModel
          ? pending.options
          : getSupportedEffortOptions(chatJid, effectiveModel);

      let selectedEffort = command.effort;
      if (/^\d+$/.test(command.effort)) {
        const numericSelection = Number.parseInt(command.effort, 10);
        const option = options[numericSelection - 1];
        if (!option) {
          await sendEffortPrompt(
            effectiveModel,
            `\`${command.effort}\` is not a valid effort selection for \`${effectiveModel}\`.`,
          );
          break;
        }
        selectedEffort = option.value;
      }

      if (
        options.length > 0 &&
        !options.some((option) => option.value === selectedEffort)
      ) {
        await sendEffortPrompt(
          effectiveModel,
          `\`${selectedEffort}\` is not supported by \`${effectiveModel}\`.`,
        );
        break;
      }

      group.agentProfile = {
        brain: 'codex',
        ...group.agentProfile,
        model: effectiveModel,
        effort: selectedEffort,
      };
      setRegisteredGroup(chatJid, group);
      updateCodexRuntimeState(chatJid, {
        requestedEffort: selectedEffort,
        pendingEffortSelection: undefined,
      });
      logger.info(
        { group: group.name, model: effectiveModel, effort: selectedEffort },
        'Effort updated via /effort command',
      );
      await channel.sendMessage(
        chatJid,
        `Effort set to \`${selectedEffort}\` for \`${effectiveModel}\`. Applies from next message.`,
      );
      break;
    }

    case 'usage': {
      try {
        const usage = await readCodexAccountUsage();
        await channel.setTyping?.(chatJid, false);
        await channel.sendMessage(chatJid, usage);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await channel.setTyping?.(chatJid, false);
        await channel.sendMessage(
          chatJid,
          `Failed to read Codex account usage: ${message}`,
        );
      }
      break;
    }

    case 'help': {
      const lines = [
        'Commands',
        '- `/help`: Show available commands',
        '- `/clear`: Clear the current conversation session',
        '- `/stop`: Stop the active agent response',
        '- `/compact`: Compact the active session context',
        '- `/restart`: Restart the NanoClaw host process (main channel only)',
        '- `/model`: Show the current model, effort, and available models',
        '- `/model [model name]`: Change the model and open effort selection',
        '- `/effort`: Show the current model effort options',
        '- `/effort [effort]`: Change the reasoning effort for the next message',
        '- `/usage`: Show Codex account usage and reset times',
      ];

      await channel.setTyping?.(chatJid, false);
      await channel.sendMessage(chatJid, lines.join('\n'));
      break;
    }
  }
}
