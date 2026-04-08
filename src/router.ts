import {
  RESULT_MENTION_DISCORD_USER_ID,
  RESULT_MENTION_DISPLAY_TEXT,
} from './config.js';
import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

const NOTIFY_USER_TAG_RE = /\s*<notify_user\s*\/>\s*$/i;

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const { text } = parseNotifyUserTag(stripInternalTags(rawText));
  if (!text) return '';
  return stripControlledMentions(text);
}

export function formatFinalResultOutbound(
  jid: string,
  rawText: string,
): string {
  const { text: content, notifyUser } = parseNotifyUserTag(
    stripInternalTags(rawText),
  );
  const text = stripControlledMentions(content);
  if (!text) return '';
  if (jid.startsWith('dc:')) {
    const userId = RESULT_MENTION_DISCORD_USER_ID.trim();
    if (!userId || !notifyUser) return text;
    const mention = `<@${userId}>`;
    if (text.startsWith(mention)) return text;
    return `${mention} ${text}`;
  }
  return text;
}

export function parseNotifyUserTag(text: string): {
  text: string;
  notifyUser: boolean;
} {
  const notifyUser = NOTIFY_USER_TAG_RE.test(text);
  return {
    text: text.replace(NOTIFY_USER_TAG_RE, '').trim(),
    notifyUser,
  };
}

function stripControlledMentions(text: string): string {
  let cleaned = text;

  const userId = RESULT_MENTION_DISCORD_USER_ID.trim();
  if (userId) {
    const discordMentionRe = new RegExp(`<@!?${escapeRegex(userId)}>`, 'gi');
    cleaned = cleaned.replace(discordMentionRe, '').trim();
  }

  const displayText = RESULT_MENTION_DISPLAY_TEXT.trim();
  if (displayText) {
    const escaped = escapeRegex(
      displayText.startsWith('@') ? displayText : `@${displayText}`,
    );
    cleaned = cleaned.replace(new RegExp(escaped, 'gi'), '').trim();
  }

  return cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
