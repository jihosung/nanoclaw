import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  TRANSLATOR_URL,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
  TRANSLATOR_ENABLED,
  TRANSLATOR_MODEL,
} from './config.js';
import { translateToEnglish, translateToKorean } from './translator.js';
import { toUserFacingAgentError } from './agent-errors.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteRegisteredGroup,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { restartHostProcess } from './host-restart.js';
import {
  findChannel,
  formatFinalResultOutbound,
  formatMessages,
  formatOutbound,
} from './router.js';
import {
  clearRestartNotice,
  readRestartNotice,
  writeRestartNotice,
} from './restart-notice.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Channel,
  NewMessage,
  OutboundMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import {
  extractCommand,
  extractPendingEffortSelection,
  handleSessionCommand,
} from './session-commands.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

const LOG_PREVIEW_LEN = 120;
const TYPING_HEARTBEAT_MS = 10000;
const FOLLOW_UP_STALL_MS = 45000;
const FOLLOW_UP_FORCE_KILL_MS = 10000;
const FOLLOW_UP_RECOVERY_NOTICE = '세션을 다시 연결해서 이어서 처리하고 있어.';

function preview(text: string): string {
  return text.length > LOG_PREVIEW_LEN
    ? text.slice(0, LOG_PREVIEW_LEN) + '...'
    : text;
}

interface FollowUpStallState {
  recoveryCursor: string;
  recoveryRequested: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  forceKillTimer: ReturnType<typeof setTimeout> | null;
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
const typingHeartbeatIntervals = new Map<
  string,
  ReturnType<typeof setInterval>
>();
const followUpStalls = new Map<string, FollowUpStallState>();

const onecli = new OneCLI({ url: ONECLI_URL });

function setTypingState(
  channel: Channel,
  chatJid: string,
  isTyping: boolean,
): void {
  channel
    .setTyping?.(chatJid, isTyping)
    ?.catch((err) =>
      logger.warn(
        { chatJid, err, isTyping },
        'Failed to update typing indicator',
      ),
    );
}

function startTypingHeartbeat(channel: Channel, chatJid: string): void {
  if (!channel.setTyping) return;
  if (typingHeartbeatIntervals.has(chatJid)) return;
  setTypingState(channel, chatJid, true);
  const interval = setInterval(() => {
    setTypingState(channel, chatJid, true);
  }, TYPING_HEARTBEAT_MS);
  typingHeartbeatIntervals.set(chatJid, interval);
}

function touchTypingHeartbeat(channel: Channel, chatJid: string): void {
  if (!channel.setTyping) return;
  if (!typingHeartbeatIntervals.has(chatJid)) {
    startTypingHeartbeat(channel, chatJid);
    return;
  }
  setTypingState(channel, chatJid, true);
}

function stopTypingHeartbeat(channel: Channel, chatJid: string): void {
  const interval = typingHeartbeatIntervals.get(chatJid);
  if (interval) {
    clearInterval(interval);
    typingHeartbeatIntervals.delete(chatJid);
  }
  setTypingState(channel, chatJid, false);
}

function clearFollowUpStall(chatJid: string): FollowUpStallState | undefined {
  const state = followUpStalls.get(chatJid);
  if (!state) return undefined;
  if (state.timer) clearTimeout(state.timer);
  if (state.forceKillTimer) clearTimeout(state.forceKillTimer);
  followUpStalls.delete(chatJid);
  return state;
}

function scheduleFollowUpStall(
  channel: Channel,
  chatJid: string,
  recoveryCursor: string,
): void {
  const existing = clearFollowUpStall(chatJid);
  const state: FollowUpStallState = {
    recoveryCursor: existing?.recoveryCursor || recoveryCursor,
    recoveryRequested: false,
    timer: null,
    forceKillTimer: null,
  };

  state.timer = setTimeout(() => {
    const current = followUpStalls.get(chatJid);
    if (!current) return;
    current.recoveryRequested = true;
    logger.warn({ chatJid }, 'Follow-up stalled, requesting session recovery');
    stopTypingHeartbeat(channel, chatJid);
    queue.closeStdin(chatJid);
    current.forceKillTimer = setTimeout(() => {
      if (queue.isActive(chatJid)) {
        logger.warn(
          { chatJid },
          'Force-killing stalled container for recovery',
        );
        queue.killProcess(chatJid);
      }
    }, FOLLOW_UP_FORCE_KILL_MS);
  }, FOLLOW_UP_STALL_MS);

  followUpStalls.set(chatJid, state);
}

async function gracefulRestartHost(): Promise<void> {
  await queue.shutdown(10000);
  await restartHostProcess();
}

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Seed AGENTS.md for new groups using baseline-reference stubs.
  // main references /workspace/project/groups/main/AGENTS.md.
  // non-main references /workspace/global/AGENTS.md.
  const groupMdFile = path.join(groupDir, 'AGENTS.md');
  if (!fs.existsSync(groupMdFile)) {
    if (group.isMain) {
      const stub = [
        `# ${ASSISTANT_NAME}`,
        ``,
        `This channel follows the main baseline instructions at:`,
        `- /workspace/project/groups/main/AGENTS.md`,
        ``,
        `## Main-Channel-Specific Overrides`,
        `<!-- Add main-channel-specific rules here only when requested. -->`,
        ``,
      ].join('\n');
      fs.writeFileSync(groupMdFile, stub);
      logger.info(
        { folder: group.folder },
        'Created main AGENTS.md baseline stub',
      );
    } else {
      const stub = [
        `# Channel Assistant`,
        ``,
        `This channel follows the global baseline instructions at:`,
        `- /workspace/global/AGENTS.md`,
        ``,
        `## Channel-Specific Overrides`,
        `<!-- Add channel-specific rules here only when requested. -->`,
        ``,
      ].join('\n');
      fs.writeFileSync(groupMdFile, stub);
      logger.info(
        { folder: group.folder },
        'Created non-main AGENTS.md baseline stub',
      );
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

function unregisterGroup(jid: string): void {
  const existing = registeredGroups[jid];
  if (!existing) {
    logger.warn({ jid }, 'Unregister requested for unknown group');
    return;
  }

  if (existing.isMain) {
    logger.warn({ jid }, 'Refusing to unregister main group');
    return;
  }

  queue.killProcess(jid);
  queue.closeStdin(jid);

  deleteSession(existing.folder);
  delete sessions[existing.folder];
  delete lastAgentTimestamp[jid];
  delete registeredGroups[jid];
  deleteRegisteredGroup(jid);
  saveState();

  logger.info(
    { jid, folder: existing.folder, name: existing.name },
    'Group unregistered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  let prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      input: preview(prompt),
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  let promptToRun = prompt;
  let isRecoveryRun = false;
  let shouldRetry = false;
  let recoveryCursorForRetry: string | null = null;

  do {
    shouldRetry = false;
    startTypingHeartbeat(channel, chatJid);
    let hadError = false;
    let outputSentToUser = false;
    let suppressRetry = false;

    const output = await runAgent(
      group,
      promptToRun,
      chatJid,
      async (result) => {
        touchTypingHeartbeat(channel, chatJid);
        if (followUpStalls.has(chatJid)) {
          clearFollowUpStall(chatJid);
        }

        // Streaming output callback ??called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          // Strip <internal>...</internal> blocks ??agent uses these for internal reasoning
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          logger.info(
            { group: group.name, output: preview(text) },
            `Agent output: ${raw.length} chars`,
          );
          if (text) {
            const outText =
              TRANSLATOR_ENABLED && TRANSLATOR_URL
                ? await translateToKorean(
                    text,
                    TRANSLATOR_URL,
                    TRANSLATOR_MODEL,
                  )
                : text;
            const outboundText =
              result.phase === 'final'
                ? formatFinalResultOutbound(chatJid, outText)
                : formatOutbound(outText);
            if (outboundText) {
              await channel.sendMessage(chatJid, outboundText);
            }
            outputSentToUser = true;
          }
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();
        }

        if (result.status === 'success') {
          if (result.result === null) {
            stopTypingHeartbeat(channel, chatJid);
          }
          queue.notifyIdle(chatJid);
        }

        if (result.status === 'error' && result.error) {
          stopTypingHeartbeat(channel, chatJid);
          const userFacingError = toUserFacingAgentError(result.error);
          if (userFacingError) {
            await channel.sendMessage(chatJid, userFacingError.text);
            outputSentToUser = true;
            suppressRetry = userFacingError.suppressRetry;
          }
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
    );

    stopTypingHeartbeat(channel, chatJid);

    const followUpStall = clearFollowUpStall(chatJid);
    if (!isRecoveryRun && followUpStall?.recoveryRequested) {
      const recoveryMessages = getMessagesSince(
        chatJid,
        followUpStall.recoveryCursor,
        ASSISTANT_NAME,
        MAX_MESSAGES_PER_PROMPT,
      );
      if (recoveryMessages.length > 0) {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        recoveryCursorForRetry = followUpStall.recoveryCursor;
        await channel.sendMessage(chatJid, FOLLOW_UP_RECOVERY_NOTICE);
        promptToRun = formatMessages(recoveryMessages, TIMEZONE);
        shouldRetry = true;
        isRecoveryRun = true;
        continue;
      }
    }

    if (output === 'error' || hadError) {
      // If we already sent output to the user, don't roll back the cursor ??    // the user got their response and re-processing would send duplicates.
      if (outputSentToUser) {
        logger.warn(
          { group: group.name, suppressRetry, isRecoveryRun },
          'Agent error after user-visible output, skipping cursor rollback',
        );
        return true;
      }
      const rollbackCursor =
        isRecoveryRun && recoveryCursorForRetry !== null
          ? recoveryCursorForRetry
          : previousCursor;
      // Roll back cursor so retries can re-process these messages
      lastAgentTimestamp[chatJid] = rollbackCursor;
      saveState();
      logger.warn(
        { group: group.name, isRecoveryRun },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }
  } while (shouldRetry);

  if (idleTimer) clearTimeout(idleTimer);
  clearFollowUpStall(chatJid);

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session ??clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected ??clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // Check for session commands before trigger gating so model/effort
          // controls still work when the chat normally requires a mention.
          const command =
            extractCommand(groupMessages) ||
            extractPendingEffortSelection(groupMessages, chatJid);
          if (command) {
            await handleSessionCommand(command, {
              chatJid,
              group,
              lastMessage: groupMessages[groupMessages.length - 1],
              sessions,
              lastAgentTimestamp,
              queue,
              channel,
              saveState,
              markRestartNotice: (jid, sourceGroup) =>
                writeRestartNotice(jid, sourceGroup),
              restartHost: gracefulRestartHost,
            });
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const recoveryCursor = getOrRecoverCursor(chatJid);
          const allPending = getMessagesSince(
            chatJid,
            recoveryCursor,
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              {
                chatJid,
                count: messagesToSend.length,
                input: preview(formatted),
              },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            startTypingHeartbeat(channel, chatJid);
            scheduleFollowUpStall(channel, chatJid, recoveryCursor);
          } else {
            // No active container ??enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: async (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }

      // Translate incoming message to English before storing so all downstream
      // data (DB, session history, memory files) stays in English.
      if (
        TRANSLATOR_ENABLED &&
        TRANSLATOR_URL &&
        !msg.is_from_me &&
        !msg.is_bot_message
      ) {
        msg = {
          ...msg,
          content: await translateToEnglish(
            msg.content,
            TRANSLATOR_URL,
            TRANSLATOR_MODEL,
          ),
        };
        if (msg.reply_to_message_content) {
          msg = {
            ...msg,
            reply_to_message_content: await translateToEnglish(
              msg.reply_to_message_content,
              TRANSLATOR_URL,
              TRANSLATOR_MODEL,
            ),
          };
        }
      }

      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing ??skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  const pendingRestartNotice = readRestartNotice();
  if (pendingRestartNotice) {
    const channel = findChannel(channels, pendingRestartNotice.chatJid);
    if (!channel) {
      logger.warn(
        { chatJid: pendingRestartNotice.chatJid },
        'Restart notice pending but no channel owns JID',
      );
    } else {
      try {
        await channel.sendMessage(
          pendingRestartNotice.chatJid,
          '재시작되었습니다.',
        );
        clearRestartNotice();
      } catch (err) {
        logger.warn(
          { chatJid: pendingRestartNotice.chatJid, err },
          'Failed to deliver restart notice; will retry on next startup',
        );
      }
    }
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, message: string | OutboundMessage) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, message);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    unregisterGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    markRestartNotice: (chatJid, sourceGroup) => {
      writeRestartNotice(chatJid, sourceGroup);
    },
    restartHost: gracefulRestartHost,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
