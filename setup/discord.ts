import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { emitStatus } from './status.js';
import { run as runRegister } from './register.js';

function parseArgs(args: string[]): {
  token: string;
  channelId: string;
  channelName: string;
  folder: string;
} {
  const result = {
    token: '',
    channelId: '',
    channelName: '',
    folder: 'discord_main',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    if (args[i] === '--channel-id' && args[i + 1]) result.channelId = args[++i];
    if (args[i] === '--channel-name' && args[i + 1]) {
      result.channelName = args[++i];
    }
    if (args[i] === '--folder' && args[i + 1]) result.folder = args[++i];
  }
  return result;
}

function upsertEnv(key: string, value: string): void {
  const envPath = path.join(process.cwd(), '.env');
  const line = `${key}=${value}`;
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${line}\n`);
    return;
  }
  const content = fs.readFileSync(envPath, 'utf-8');
  if (new RegExp(`^${key}=`, 'm').test(content)) {
    fs.writeFileSync(
      envPath,
      content.replace(new RegExp(`^${key}=.*$`, 'm'), line),
    );
  } else {
    fs.writeFileSync(envPath, `${content.trimEnd()}\n${line}\n`);
  }
}

function syncEnvToDataEnv(): void {
  const root = process.cwd();
  const envPath = path.join(root, '.env');
  const targetDir = path.join(root, 'data', 'env');
  const targetPath = path.join(targetDir, 'env');
  if (!fs.existsSync(envPath)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(envPath, targetPath);
}

function normalizeDiscordJid(channelId: string): string {
  return channelId.startsWith('dc:') ? channelId : `dc:${channelId}`;
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const effectiveToken =
    parsed.token ||
    process.env.DISCORD_BOT_TOKEN ||
    envVars.DISCORD_BOT_TOKEN ||
    '';

  if (!effectiveToken) {
    emitStatus('DISCORD', {
      STATUS: 'needs_input',
      ERROR: 'missing_discord_bot_token',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  upsertEnv('DISCORD_BOT_TOKEN', effectiveToken);
  syncEnvToDataEnv();

  if (!parsed.channelId) {
    emitStatus('DISCORD', {
      STATUS: 'needs_input',
      ERROR: 'missing_discord_channel_id',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const jid = normalizeDiscordJid(parsed.channelId);
  const name =
    parsed.channelName?.trim() || `Discord Main (${jid.replace('dc:', '')})`;

  await runRegister([
    '--jid',
    jid,
    '--name',
    name,
    '--folder',
    parsed.folder,
    '--trigger',
    `@${ASSISTANT_NAME}`,
    '--channel',
    'discord',
    '--no-trigger-required',
    '--is-main',
    '--assistant-name',
    ASSISTANT_NAME,
  ]);

  emitStatus('DISCORD', {
    JID: jid,
    NAME: name,
    FOLDER: parsed.folder,
    MAIN: true,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
