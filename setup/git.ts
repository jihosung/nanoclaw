import { execSync } from 'child_process';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  let output = '';
  try {
    output = execSync('git remote -v', { encoding: 'utf-8' });
  } catch (err) {
    logger.error({ err }, 'git remote -v failed');
    emitStatus('GIT', {
      STATUS: 'failed',
      ERROR: 'git_remote_check_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const hasOrigin = /\borigin\b/.test(output);
  const hasUpstream = /\bupstream\b/.test(output);
  const originIsUpstream =
    /origin\s+.*qwibitai\/nanoclaw(\.git)?\s+\(fetch\)/.test(output);

  let action = 'none';
  if (!hasUpstream) {
    try {
      execSync(
        'git remote add upstream https://github.com/qwibitai/nanoclaw.git',
        {
          stdio: 'ignore',
        },
      );
      action = 'upstream_added';
    } catch {
      action = 'upstream_add_failed';
    }
  } else {
    action = 'already_configured';
  }

  emitStatus('GIT', {
    HAS_ORIGIN: hasOrigin,
    HAS_UPSTREAM: hasUpstream,
    ORIGIN_IS_QWIBITAI: originIsUpstream,
    ACTION: action,
    STATUS: action === 'upstream_add_failed' ? 'failed' : 'success',
    LOG: 'logs/setup.log',
  });

  if (action === 'upstream_add_failed') process.exit(1);
}
