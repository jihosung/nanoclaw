import fs from 'fs';
import path from 'path';

import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  OutboundAttachment,
  OutboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private typingIntervals: Map<string, ReturnType<typeof setInterval>> =
    new Map();
  private typingVersion: Map<string, number> = new Map();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> -- these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments -- store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            const url = att.url;
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}](${url})`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}](${url})`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}](${url})`;
            } else {
              return `[File: ${att.name || 'file'}](${url})`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context -- include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message -- startMessageLoop() will pick it up
      await this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(
    jid: string,
    message: string | OutboundMessage,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;
      const outbound = normalizeOutboundMessage(message);
      this.appendDeliveryTrace(jid, 'prepare', {
        textLength: outbound.text?.length ?? 0,
        requestedAttachments: outbound.attachments?.length ?? 0,
      });
      const files = this.resolveAttachments(jid, outbound.attachments);
      this.appendDeliveryTrace(jid, 'resolved', {
        resolvedAttachments: files.length,
      });
      const chunks =
        outbound.text && outbound.text.length > 0
          ? splitMessage(outbound.text, 2000)
          : [];

      if (
        outbound.attachments &&
        outbound.attachments.length > 0 &&
        files.length === 0
      ) {
        const errorText =
          'Failed to send attachment(s): no valid files were found in the current group workspace.';
        if (chunks.length > 0) {
          chunks[0] = `${chunks[0]}\n\n${errorText}`;
        } else {
          chunks.push(errorText);
        }
      }

      if (files.length > 0) {
        const firstChunk = chunks.shift();
        await textChannel.send({ content: firstChunk, files });
        this.appendDeliveryTrace(jid, 'sent-with-attachments', {
          files: files.length,
          firstChunkLength: firstChunk?.length ?? 0,
        });
      } else if (chunks.length === 0) {
        logger.warn({ jid }, 'Discord message had no text or valid attachments');
        this.appendDeliveryTrace(jid, 'dropped-empty', {});
        return;
      }

      for (const chunk of chunks) {
        await textChannel.send(chunk);
      }
      if (chunks.length > 0) {
        this.appendDeliveryTrace(jid, 'sent-text-chunks', {
          chunks: chunks.length,
        });
      }

      logger.info(
        {
          jid,
          length: outbound.text?.length ?? 0,
          attachmentCount: files.length,
        },
        'Discord message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
      this.appendDeliveryTrace(jid, 'send-error', {
        error: formatDiscordSendError(err),
      });
      try {
        const channelId = jid.replace(/^dc:/, '');
        const channel = await this.client.channels.fetch(channelId);
        if (channel && 'send' in channel) {
          await (channel as TextChannel).send(
            `Failed to send Discord attachment/message: ${formatDiscordSendError(err)}`,
          );
          this.appendDeliveryTrace(jid, 'fallback-sent', {});
        }
      } catch (fallbackErr) {
        logger.error(
          { jid, err: fallbackErr },
          'Failed to send Discord error fallback message',
        );
        this.appendDeliveryTrace(jid, 'fallback-error', {
          error: formatDiscordSendError(fallbackErr),
        });
      }
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    if (!isTyping) {
      const existing = this.typingIntervals.get(jid);
      if (existing !== undefined) {
        clearInterval(existing);
        this.typingIntervals.delete(jid);
      }
      // Bump version to cancel any in-flight sendTyping() calls
      this.typingVersion.set(jid, (this.typingVersion.get(jid) ?? 0) + 1);
      return;
    }

    // Already typing for this jid
    if (this.typingIntervals.has(jid)) return;

    const version = this.typingVersion.get(jid) ?? 0;

    const sendTyping = async () => {
      // Bail out if setTyping(false) was called since we started
      if ((this.typingVersion.get(jid) ?? 0) !== version) return;
      try {
        const channelId = jid.replace(/^dc:/, '');
        const channel = await this.client!.channels.fetch(channelId);
        if ((this.typingVersion.get(jid) ?? 0) !== version) return;
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
      }
    };

    // Sentinel to handle setTyping(false) arriving before the first await resolves
    this.typingIntervals.set(
      jid,
      null as unknown as ReturnType<typeof setInterval>,
    );

    await sendTyping();

    if (!this.typingIntervals.has(jid)) return;

    const interval = setInterval(sendTyping, 8000);
    this.typingIntervals.set(jid, interval);
  }

  private resolveAttachments(
    jid: string,
    attachments: OutboundAttachment[] | undefined,
  ): AttachmentBuilder[] {
    if (!attachments || attachments.length === 0) return [];

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.warn({ jid }, 'Cannot resolve attachments without registered group');
      return [];
    }

    const groupDir = path.resolve(resolveGroupFolderPath(group.folder));
    return attachments.flatMap((attachment) => {
      const hostPath = resolveAttachmentPath(attachment.path, groupDir);
      if (!hostPath) {
        logger.warn(
          { jid, path: attachment.path },
          'Rejected Discord attachment outside group workspace',
        );
        this.appendDeliveryTrace(jid, 'attachment-rejected', {
          path: attachment.path,
          reason: 'outside-group-workspace',
        });
        return [];
      }
      if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isFile()) {
        logger.warn(
          { jid, path: attachment.path, hostPath },
          'Discord attachment file not found',
        );
        this.appendDeliveryTrace(jid, 'attachment-missing', {
          path: attachment.path,
          hostPath,
        });
        return [];
      }

      try {
        return [
          new AttachmentBuilder(fs.readFileSync(hostPath), {
            name: attachment.name || path.basename(hostPath),
          }),
        ];
      } catch (err) {
        logger.warn(
          { jid, path: attachment.path, hostPath, err },
          'Failed to read Discord attachment file',
        );
        this.appendDeliveryTrace(jid, 'attachment-read-error', {
          path: attachment.path,
          hostPath,
          error: formatDiscordSendError(err),
        });
        return [];
      }
    });
  }

  private appendDeliveryTrace(
    jid: string,
    stage: string,
    details: Record<string, unknown>,
  ): void {
    try {
      const group = this.opts.registeredGroups()[jid];
      if (!group) return;
      const logDir = path.join(resolveGroupFolderPath(group.folder), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'discord-delivery.log');
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        jid,
        stage,
        ...details,
      });
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      // never fail message delivery because of debug logging
    }
  }
}

function normalizeOutboundMessage(
  message: string | OutboundMessage,
): OutboundMessage {
  if (typeof message === 'string') {
    return { text: message };
  }
  return message;
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

function resolveAttachmentPath(
  attachmentPath: string,
  groupDir: string,
): string | null {
  const normalized = attachmentPath.replace(/\\/g, '/');
  let relativePath: string;

  if (normalized === '/workspace/group') {
    return null;
  }

  if (normalized.startsWith('/workspace/group/')) {
    relativePath = path.posix.relative('/workspace/group', normalized);
  } else if (path.isAbsolute(attachmentPath)) {
    return null;
  } else {
    relativePath = attachmentPath;
  }

  const hostPath = path.resolve(groupDir, relativePath);
  const relativeToGroup = path.relative(groupDir, hostPath);
  if (
    relativeToGroup.startsWith('..') ||
    path.isAbsolute(relativeToGroup)
  ) {
    return null;
  }

  return hostPath;
}

function formatDiscordSendError(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message?.trim();
    return message.length > 0 ? message : err.constructor.name;
  }
  return String(err);
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
