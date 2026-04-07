import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ONECLI_URL } from '../src/config.js';
import { emitStatus } from './status.js';
import { commandExists } from './platform.js';

function parseArgs(args: string[]): {
  runtime: string;
  mode: string;
  token: string;
  apiKey: string;
} {
  const result = { runtime: '', mode: '', token: '', apiKey: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) result.runtime = args[++i];
    if (args[i] === '--mode' && args[i + 1]) result.mode = args[++i];
    if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
    if (args[i] === '--api-key' && args[i + 1]) result.apiKey = args[++i];
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

function hasOnecliAnthropicSecret(): boolean {
  try {
    const output = execSync('onecli secrets list', { encoding: 'utf-8' });
    return /anthropic/i.test(output);
  } catch {
    return false;
  }
}

function createOnecliSecret(value: string): boolean {
  try {
    execSync(
      `onecli secrets create --name Anthropic --type anthropic --value ${JSON.stringify(value)} --host-pattern api.anthropic.com`,
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (!parsed.runtime || !parsed.mode) {
    emitStatus('CREDENTIALS', {
      STATUS: 'needs_input',
      ERROR: 'missing_runtime_or_mode',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  if (parsed.runtime === 'docker') {
    upsertEnv('ONECLI_URL', ONECLI_URL);

    if (commandExists('onecli')) {
      try {
        execSync(`onecli config set api-host ${JSON.stringify(ONECLI_URL)}`, {
          stdio: 'ignore',
        });
      } catch {
        // Ignore; list/create may still work with existing host setting.
      }

      const value =
        parsed.mode === 'subscription' ? parsed.token : parsed.apiKey;
      if (value) {
        if (!createOnecliSecret(value)) {
          emitStatus('CREDENTIALS', {
            RUNTIME: parsed.runtime,
            MODE: parsed.mode,
            CREDENTIALS: 'missing',
            STATUS: 'failed',
            ERROR: 'onecli_secret_create_failed',
            LOG: 'logs/setup.log',
          });
          process.exit(1);
        }
      }

      const hasSecret = hasOnecliAnthropicSecret();
      emitStatus('CREDENTIALS', {
        RUNTIME: parsed.runtime,
        MODE: parsed.mode,
        CREDENTIALS: hasSecret ? 'configured' : 'missing',
        STATUS: hasSecret ? 'success' : 'needs_input',
        LOG: 'logs/setup.log',
      });
      if (!hasSecret) process.exit(1);
      return;
    }

    // Fallback when onecli is not installed yet.
    if (parsed.mode === 'subscription' && parsed.token) {
      upsertEnv('CLAUDE_CODE_OAUTH_TOKEN', parsed.token);
      emitStatus('CREDENTIALS', {
        RUNTIME: parsed.runtime,
        MODE: parsed.mode,
        CREDENTIALS: 'configured_env_fallback',
        STATUS: 'success',
        LOG: 'logs/setup.log',
      });
      return;
    }
    if (parsed.mode === 'api_key' && parsed.apiKey) {
      upsertEnv('ANTHROPIC_API_KEY', parsed.apiKey);
      emitStatus('CREDENTIALS', {
        RUNTIME: parsed.runtime,
        MODE: parsed.mode,
        CREDENTIALS: 'configured_env_fallback',
        STATUS: 'success',
        LOG: 'logs/setup.log',
      });
      return;
    }

    emitStatus('CREDENTIALS', {
      RUNTIME: parsed.runtime,
      MODE: parsed.mode,
      CREDENTIALS: 'missing',
      STATUS: 'needs_input',
      ERROR: 'onecli_not_found_or_secret_missing',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  if (parsed.runtime === 'apple-container') {
    if (parsed.mode === 'subscription' && parsed.token) {
      upsertEnv('CLAUDE_CODE_OAUTH_TOKEN', parsed.token);
      emitStatus('CREDENTIALS', {
        RUNTIME: parsed.runtime,
        MODE: parsed.mode,
        CREDENTIALS: 'configured',
        STATUS: 'success',
        LOG: 'logs/setup.log',
      });
      return;
    }
    if (parsed.mode === 'api_key' && parsed.apiKey) {
      upsertEnv('ANTHROPIC_API_KEY', parsed.apiKey);
      emitStatus('CREDENTIALS', {
        RUNTIME: parsed.runtime,
        MODE: parsed.mode,
        CREDENTIALS: 'configured',
        STATUS: 'success',
        LOG: 'logs/setup.log',
      });
      return;
    }
    emitStatus('CREDENTIALS', {
      RUNTIME: parsed.runtime,
      MODE: parsed.mode,
      CREDENTIALS: 'missing',
      STATUS: 'needs_input',
      ERROR: 'token_or_api_key_required',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  emitStatus('CREDENTIALS', {
    RUNTIME: parsed.runtime,
    MODE: parsed.mode,
    STATUS: 'failed',
    ERROR: 'unknown_runtime',
    LOG: 'logs/setup.log',
  });
  process.exit(1);
}
