import fs from 'fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface RateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

interface RateLimitEntry {
  limitId?: string;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

interface RateLimitsResponse {
  rateLimits?: RateLimitEntry;
  rateLimitsByLimitId?: Record<string, RateLimitEntry>;
}

class HostCodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;

  async start(): Promise<void> {
    if (this.proc) return;

    const codexHome = path.join(DATA_DIR, 'codex-auth');
    const { command, args } = resolveCodexCommand();
    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      HOME: process.env.HOME || os.homedir(),
      USERPROFILE: process.env.USERPROFILE || os.homedir(),
    };

    this.proc = spawn(command, [...args, 'app-server'], {
      cwd: process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleStdoutLine(trimmed);
      }
    });

    this.proc.on('close', (code) => {
      this.rejectAll(
        new Error(`Codex app-server exited with code ${code ?? 'unknown'}`),
      );
    });
    this.proc.on('error', (error) => {
      this.rejectAll(error);
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'nanoclaw_host_usage',
        title: 'NanoClaw Host Usage',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized', {});
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }

  async readRateLimits(): Promise<RateLimitsResponse> {
    return (await this.request(
      'account/rateLimits/read',
      {},
    )) as RateLimitsResponse;
  }

  private handleStdoutLine(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof message.id !== 'number') return;

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(
        new Error(
          message.error.message ||
            `${pending.method} failed with JSON-RPC error ${message.error.code ?? 'unknown'}`,
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) {
      throw new Error('Codex app-server stdin is not writable.');
    }
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function resolveCodexCommand(): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command: 'codex', args: [] };
  }

  const appData = process.env.APPDATA;
  if (appData) {
    const jsEntry = path.join(
      appData,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    );
    if (fs.existsSync(jsEntry)) {
      return {
        command: process.execPath,
        args: [jsEntry],
      };
    }
  }

  return { command: 'codex', args: [] };
}

function formatBar(percent?: number, width = 10): string {
  if (typeof percent !== 'number' || Number.isNaN(percent)) {
    return '░'.repeat(width);
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatPercent(percent?: number): string {
  if (typeof percent !== 'number' || Number.isNaN(percent)) return '--%';
  return `${Math.round(percent)}%`;
}

function toResetTimestampMs(resetsAt?: number): number | null {
  if (typeof resetsAt !== 'number' || Number.isNaN(resetsAt)) return null;
  return resetsAt * 1000;
}

function formatTimeLeft(resetsAt?: number): string {
  const targetMs = toResetTimestampMs(resetsAt);
  if (!targetMs) return 'reset time unavailable';

  let remainingMs = targetMs - Date.now();
  if (remainingMs <= 0) return 'reset passed';

  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  const days = Math.floor(remainingMs / dayMs);
  remainingMs -= days * dayMs;
  const hours = Math.floor(remainingMs / hourMs);
  remainingMs -= hours * hourMs;
  const minutes = Math.floor(remainingMs / minuteMs);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push('0m');
  return `${parts.slice(0, 2).join(' ')}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatResetAtLabel(resetsAt?: number): string | null {
  const targetMs = toResetTimestampMs(resetsAt);
  if (!targetMs) return null;

  const now = new Date();
  const target = new Date(targetMs);
  const sameDay =
    now.getFullYear() === target.getFullYear() &&
    now.getMonth() === target.getMonth() &&
    now.getDate() === target.getDate();

  if (sameDay) {
    return `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  }

  const weekday = target.toLocaleDateString('en-US', { weekday: 'short' });
  return `${pad2(target.getHours())}:${pad2(target.getMinutes())} in ${pad2(target.getMonth() + 1)}/${pad2(target.getDate())}(${weekday})`;
}

function formatResetSummary(resetsAt?: number): string {
  const relative = formatTimeLeft(resetsAt);
  const absolute = formatResetAtLabel(resetsAt);
  if (!absolute) return `resets in ${relative}`;
  return `resets in ${relative} (${absolute})`;
}

function formatWindowDuration(windowDurationMins?: number): string | null {
  if (
    typeof windowDurationMins !== 'number' ||
    Number.isNaN(windowDurationMins) ||
    windowDurationMins <= 0
  ) {
    return null;
  }

  if (windowDurationMins % (60 * 24) === 0) {
    return `${windowDurationMins / (60 * 24)}d`;
  }
  if (windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60}h`;
  }
  return `${windowDurationMins}m`;
}

function getEntries(response: RateLimitsResponse): Array<[string, RateLimitEntry]> {
  if (response.rateLimitsByLimitId) {
    return Object.entries(response.rateLimitsByLimitId);
  }
  if (response.rateLimits?.limitId) {
    return [[response.rateLimits.limitId, response.rateLimits]];
  }
  return [];
}

function formatWindowLine(
  label: string,
  window: RateLimitWindow | null | undefined,
): string {
  const duration = formatWindowDuration(window?.windowDurationMins);
  const titledLabel = duration ? `${label} (${duration})` : label;
  if (!window) {
    return titledLabel ? `${titledLabel}: unavailable` : 'unavailable';
  }
  return titledLabel
    ? `${titledLabel}[${formatBar(window.usedPercent)}] ${formatPercent(window.usedPercent)}`
    : `[${formatBar(window.usedPercent)}] ${formatPercent(window.usedPercent)}`;
}

export function formatRateLimitsMessage(response: RateLimitsResponse): string {
  const entries = getEntries(response);

  if (entries.length === 0) {
    return 'No rate limit data returned from Codex account.';
  }

  const lines = ['Codex account usage:'];
  for (const [, entry] of entries) {
    const primary = entry.primary ?? null;
    const secondary = entry.secondary ?? null;

    lines.push(
      `${formatWindowLine('Primary', primary)} | ` +
        formatResetSummary(primary?.resetsAt),
    );
    lines.push(
      `${formatWindowLine('Secondary', secondary)} | ` +
        formatResetSummary(secondary?.resetsAt),
    );
  }
  return lines.join('\n');
}

export async function readCodexAccountUsage(): Promise<string> {
  const client = new HostCodexAppServerClient();
  await client.start();
  try {
    const response = await client.readRateLimits();
    return formatRateLimitsMessage(response);
  } finally {
    await client.close();
  }
}
