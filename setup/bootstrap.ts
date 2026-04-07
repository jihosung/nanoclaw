import { spawn } from 'child_process';

import { emitStatus } from './status.js';

function parseStatusBlock(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    line.startsWith('=== NANOCLAW SETUP:'),
  );
  if (start === -1) return {};
  const end = lines.findIndex(
    (line, idx) => idx > start && line === '=== END ===',
  );
  if (end === -1) return {};

  const fields: Record<string, string> = {};
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fields;
}

export async function run(_args: string[]): Promise<void> {
  const cmd = process.platform === 'win32' ? 'bash' : 'bash';

  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    const proc = spawn(cmd, ['setup.sh'], {
      cwd: process.cwd(),
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
    proc.on('error', () => {
      resolve({ code: 127, stdout, stderr: 'failed_to_spawn_bash' });
    });
    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

  const fields = parseStatusBlock(result.stdout);
  if (Object.keys(fields).length > 0) {
    emitStatus('BOOTSTRAP', fields);
    if ((fields.STATUS || 'failed') !== 'success') process.exit(1);
    return;
  }

  emitStatus('BOOTSTRAP', {
    STATUS: result.code === 0 ? 'success' : 'failed',
    ERROR: result.stderr.slice(-500) || 'bootstrap_failed',
    LOG: 'logs/setup.log',
  });
  if (result.code !== 0) process.exit(1);
}
