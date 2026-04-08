import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

interface RestartNotice {
  chatJid: string;
  sourceGroup: string;
  requestedAt: string;
}

const RESTART_NOTICE_FILE = path.join(DATA_DIR, 'host-restart-notice.json');

export function writeRestartNotice(chatJid: string, sourceGroup: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload: RestartNotice = {
    chatJid,
    sourceGroup,
    requestedAt: new Date().toISOString(),
  };
  fs.writeFileSync(RESTART_NOTICE_FILE, JSON.stringify(payload, null, 2));
}

export function readRestartNotice(): RestartNotice | null {
  if (!fs.existsSync(RESTART_NOTICE_FILE)) return null;
  try {
    const raw = fs.readFileSync(RESTART_NOTICE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RestartNotice>;
    if (
      typeof parsed.chatJid !== 'string' ||
      typeof parsed.sourceGroup !== 'string' ||
      typeof parsed.requestedAt !== 'string'
    ) {
      return null;
    }
    return {
      chatJid: parsed.chatJid,
      sourceGroup: parsed.sourceGroup,
      requestedAt: parsed.requestedAt,
    };
  } catch {
    return null;
  }
}

export function clearRestartNotice(): void {
  if (!fs.existsSync(RESTART_NOTICE_FILE)) return;
  fs.unlinkSync(RESTART_NOTICE_FILE);
}
