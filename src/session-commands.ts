import { spawn } from 'child_process';

import { OPENAI_MODEL } from './config.js';
import { readCodexAccountUsage } from './codex-account.js';
import {
  formatCodexModelStatus,
  updateCodexRuntimeState,
} from './codex-runtime-state.js';
import {
  deleteSession,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
} from './db.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';

export type SessionCommand =
  | { type: 'clear' }
  | { type: 'stop' }
  | { type: 'compact' }
  | { type: 'model'; model: string }
  | { type: 'usage' }
  | { type: 'help' }
  | { type: 'setup-codex'; args: string };

const COMMAND_RE =
  /^\/(clear|stop|compact|model|usage|help|setup-codex)(?:\s+(.+))?$/i;
const SETUP_STEPS = [
  'timezone',
  'environment',
  'container',
  'groups',
  'register',
  'mounts',
  'service',
  'verify',
] as const;
type SetupStep = (typeof SETUP_STEPS)[number];

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
    if (cmd === 'usage') return { type: 'usage' };
    if (cmd === 'help') return { type: 'help' };
    if (cmd === 'setup-codex') return { type: 'setup-codex', args: arg };
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

    case 'model': {
      if (!command.model) {
        const fallback = OPENAI_MODEL || 'gpt-5.4';
        await channel.sendMessage(
          chatJid,
          formatCodexModelStatus(chatJid, fallback),
        );
        break;
      }

      group.agentProfile = {
        brain: 'codex',
        ...group.agentProfile,
        model: command.model,
      };
      setRegisteredGroup(chatJid, group);
      updateCodexRuntimeState(chatJid, {
        requestedModel: command.model,
      });
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
        '- `/model`: Show the current model and available models',
        '- `/model [model name]`: Change the model for the next message',
        '- `/usage`: Show Codex account usage and reset times',
        '- `/setup-codex`: Show Codex setup command usage',
      ];

      await channel.setTyping?.(chatJid, false);
      await channel.sendMessage(chatJid, lines.join('\n'));
      break;
    }

    case 'setup-codex': {
      if (!group.isMain) {
        await channel.sendMessage(
          chatJid,
          '`/setup-codex` is only available in the main control channel.',
        );
        break;
      }

      const parsed = parseSetupCodexArgs(command.args);
      if (parsed.mode === 'help') {
        await channel.sendMessage(chatJid, formatSetupCodexHelp());
        break;
      }

      if (parsed.mode === 'status') {
        const raw = getRouterState('setup_codex:last_run');
        if (!raw) {
          await channel.sendMessage(
            chatJid,
            'No `/setup-codex run` history yet.\n' + formatSetupCodexHelp(),
          );
          break;
        }
        await channel.sendMessage(chatJid, `Last setup run:\n${raw}`);
        break;
      }

      const extra = parsed.extraArgs.join(' ').trim();
      await channel.setTyping?.(chatJid, false);
      await channel.sendMessage(
        chatJid,
        `Running setup step \`${parsed.step}\`${extra ? ` with args: ${extra}` : ''}...`,
      );

      const result = await runSetupStep(parsed.step, parsed.extraArgs);
      const summary = formatSetupRunSummary(parsed.step, result);
      setRouterState('setup_codex:last_run', summary);
      await channel.sendMessage(chatJid, summary);
      break;
    }
  }
}

function parseSetupCodexArgs(args: string):
  | { mode: 'help' }
  | { mode: 'status' }
  | { mode: 'run'; step: SetupStep; extraArgs: string[] } {
  const trimmed = args.trim();
  if (!trimmed || trimmed === 'help') return { mode: 'help' };
  if (trimmed === 'status') return { mode: 'status' };

  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== 'run' || !tokens[1]) return { mode: 'help' };

  const step = tokens[1] as SetupStep;
  if (!SETUP_STEPS.includes(step)) return { mode: 'help' };

  return { mode: 'run', step, extraArgs: tokens.slice(2) };
}

function formatSetupCodexHelp(): string {
  return [
    '`/setup-codex` commands',
    '- `/setup-codex`: show this help',
    '- `/setup-codex status`: show last run summary',
    '- `/setup-codex run <step> [args...]`: run a setup step',
    `- steps: ${SETUP_STEPS.join(', ')}`,
    '- example: `/setup-codex run environment`',
    '- example: `/setup-codex run container --runtime docker`',
  ].join('\n');
}

async function runSetupStep(
  step: SetupStep,
  extraArgs: string[],
): Promise<{
  exitCode: number | null;
  status: string;
  fields: Record<string, string>;
  stderrTail: string;
}> {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['tsx', 'setup/index.ts', '--step', step, ...extraArgs];

  return await new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      const fields = parseSetupStatusBlock(stdout);
      resolve({
        exitCode: code,
        status: fields.STATUS || (code === 0 ? 'success' : 'failed'),
        fields,
        stderrTail: tail(stderr, 700),
      });
    });
  });
}

function parseSetupStatusBlock(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    line.startsWith('=== NANOCLAW SETUP:'),
  );
  if (start === -1) return {};
  const end = lines.findIndex((line, idx) => idx > start && line === '=== END ===');
  if (end === -1) return {};

  const fields: Record<string, string> = {};
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

function formatSetupRunSummary(
  step: SetupStep,
  result: {
    exitCode: number | null;
    status: string;
    fields: Record<string, string>;
    stderrTail: string;
  },
): string {
  const head = [
    `Setup step: \`${step}\``,
    `Status: \`${result.status}\` (exit: ${result.exitCode ?? 'unknown'})`,
  ];

  const importantKeys = [
    'ERROR',
    'RUNTIME',
    'BUILD_OK',
    'TEST_OK',
    'SERVICE',
    'CREDENTIALS',
    'REGISTERED_GROUPS',
    'LOG',
  ];
  const detail = importantKeys
    .filter((key) => result.fields[key] !== undefined)
    .map((key) => `- ${key}: ${result.fields[key]}`);

  if (result.status !== 'success' && result.stderrTail) {
    detail.push('- stderr (tail):');
    detail.push(result.stderrTail);
  }

  return [...head, ...detail].join('\n');
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}
