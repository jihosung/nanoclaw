import { spawn } from 'child_process';

import { NANOCLAW_RESTART_CMD } from './config.js';
import { logger } from './logger.js';

/**
 * Restart the NanoClaw host process.
 * If NANOCLAW_RESTART_CMD is configured, run it detached first.
 * Then exit so supervisors (systemd/launchd/pm2, etc.) can relaunch.
 */
export async function restartHostProcess(): Promise<void> {
  const restartCmd = NANOCLAW_RESTART_CMD.trim();
  if (restartCmd) {
    logger.warn({ restartCmd }, 'Executing configured host restart command');
    const child = spawn(restartCmd, {
      shell: true,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } else {
    logger.warn(
      'NANOCLAW_RESTART_CMD is not set; exiting and relying on supervisor restart policy',
    );
  }

  setTimeout(() => process.exit(0), 300);
}
