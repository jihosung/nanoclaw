import { deleteSession, setRegisteredGroup } from './db.js';
import { AGENT_MODEL, OPENAI_MODEL } from './config.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

export type SessionCommand =
  | { type: 'clear' }
  | { type: 'stop' }
  | { type: 'compact' }
  | { type: 'model'; model: string };

const COMMAND_RE = /^\/(clear|stop|compact|model)(?:\s+(.+))?$/i;

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
    if (cmd === 'model') return { type: 'model', model: arg };
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
  } = deps;

  // Advance cursor so these messages aren't re-processed as agent input
  lastAgentTimestamp[chatJid] = lastMessage.timestamp;
  saveState();

  switch (command.type) {
    case 'clear': {
      queue.closeStdin(chatJid);
      deleteSession(group.folder);
      delete sessions[group.folder];
      logger.info({ group: group.name }, 'Session cleared via /clear command');
      await channel.sendMessage(
        chatJid,
        'Session cleared. Next message starts a new conversation.',
      );
      break;
    }

    case 'stop': {
      const isActive = queue.isActive(chatJid);
      if (isActive) {
        queue.closeStdin(chatJid); // signals turn/interrupt via _close sentinel
        logger.info({ group: group.name }, '/stop command: sent close signal');
        await channel.sendMessage(chatJid, 'Agent stop signal sent.');
      } else {
        await channel.sendMessage(chatJid, 'No active agent to stop.');
      }
      break;
    }

    case 'compact': {
      // Pipe /compact to the active container (Claude Code built-in command).
      // If no container is running, reply with an error — there's nothing to compact.
      const piped = queue.sendMessage(chatJid, '/compact');
      if (!piped) {
        await channel.sendMessage(
          chatJid,
          'No active session to compact. Start a conversation first.',
        );
      }
      break;
    }

    case 'model': {
      if (!command.model) {
        const brain = group.agentProfile?.brain ?? 'claude';
        const override = group.agentProfile?.model;
        const fallback =
          brain === 'codex' ? OPENAI_MODEL || 'o4-mini' : AGENT_MODEL || '(claude default)';
        const display = override
          ? `\`${override}\``
          : `(default → \`${fallback}\`)`;
        await channel.sendMessage(chatJid, `Current model: ${display}`);
        break;
      }
      group.agentProfile = {
        brain: group.agentProfile?.brain ?? 'claude',
        ...group.agentProfile,
        model: command.model,
      };
      setRegisteredGroup(chatJid, group);
      logger.info(
        { group: group.name, model: command.model },
        'Model updated via /model command',
      );
      await channel.sendMessage(
        chatJid,
        `Model set to \`${command.model}\`. Applies from next message.`,
      );
      break;
    }
  }
}
