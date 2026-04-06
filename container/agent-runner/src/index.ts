/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CodexAppServerClient,
  type AppServerInputItem,
} from './codex-app-server-client.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const SCRIPT_TIMEOUT_MS = 30_000;
const CODEX_GROUP_DIR = '/workspace/group';

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }

      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }

      setTimeout(poll, IPC_POLL_MS);
    };

    poll();
  });
}

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          resolve(null);
          return;
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          resolve(null);
          return;
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            resolve(null);
            return;
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function executeAppServerTurn(
  client: CodexAppServerClient,
  threadId: string,
  prompt: string,
  model: string,
  effort: string,
  retryCount = 0,
): Promise<{ result: string | null; error?: string; closed: boolean }> {
  let lastProgressMessage: string | null = null;
  let closed = false;

  const activeTurn = await client.startTurn(
    threadId,
    [{ type: 'text', text: prompt }] satisfies AppServerInputItem[],
    {
      cwd: CODEX_GROUP_DIR,
      model: model || undefined,
      effort: effort || undefined,
      onProgress: (message) => {
        const trimmed = message.trim();
        if (!trimmed || trimmed === lastProgressMessage) return;
        lastProgressMessage = trimmed;
        writeOutput({
          status: 'success',
          result: trimmed,
          newSessionId: threadId,
        });
      },
    },
  );

  let polling = true;
  const pollDuringTurn = async () => {
    if (!polling) return;

    if (shouldClose()) {
      log('Close sentinel during Codex turn, interrupting');
      polling = false;
      closed = true;
      try {
        await activeTurn.interrupt();
      } catch {
        /* ignore */
      }
      return;
    }

    const messages = drainIpcInput();
    if (messages.length > 0) {
      const merged = messages.join('\n');
      log(`Steering Codex turn with ${messages.length} IPC message(s)`);
      try {
        await activeTurn.steer([{ type: 'text', text: merged }]);
      } catch (err) {
        log(`turn/steer failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    setTimeout(() => void pollDuringTurn(), IPC_POLL_MS);
  };
  setTimeout(() => void pollDuringTurn(), IPC_POLL_MS);

  try {
    const { state, result } = await activeTurn.wait();

    if (state.status === 'completed') {
      return { result, closed };
    }
    if (state.status === 'interrupted' && closed) {
      return { result, closed };
    }
    if (state.status === 'interrupted' && retryCount < 1) {
      log('Codex turn interrupted unexpectedly, retrying once');
      return executeAppServerTurn(
        client,
        threadId,
        prompt,
        model,
        effort,
        retryCount + 1,
      );
    }

    return {
      result,
      error: state.errorMessage || `Codex turn finished with status ${state.status}`,
      closed,
    };
  } finally {
    polling = false;
  }
}

async function runCodexBrain(containerInput: ContainerInput): Promise<void> {
  const codexModel = process.env.OPENAI_MODEL || '';
  const codexEffort = process.env.CODEX_EFFORT || '';
  log(
    `Codex brain starting (app-server, session: ${containerInput.sessionId || 'new'})`,
  );
  log(`Codex model: ${codexModel || 'default'}`);

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  const client = new CodexAppServerClient({ cwd: CODEX_GROUP_DIR, log });
  await client.start();

  try {
    try {
      const models = await client.listModels();
      const modelNames = models
        .map((model) => `${model.id}${model.isDefault ? ' (default)' : ''}`)
        .join(', ');
      log(`Codex available models: ${modelNames}`);
    } catch (err) {
      log(`model/list failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let threadId: string;
    try {
      threadId = await client.startOrResumeThread(containerInput.sessionId, {
        cwd: CODEX_GROUP_DIR,
        model: codexModel || undefined,
      });
      log(
        containerInput.sessionId
          ? `App-server thread resumed (${threadId})`
          : `App-server thread started (${threadId})`,
      );
    } catch (err) {
      if (!containerInput.sessionId) throw err;
      log(`Resume failed, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
      threadId = await client.startOrResumeThread(undefined, {
        cwd: CODEX_GROUP_DIR,
        model: codexModel || undefined,
      });
      log(`App-server thread restarted (${threadId})`);
    }

    try {
      const config = await client.readConfig();
      log(`Codex config/read: ${JSON.stringify(config)}`);
    } catch (err) {
      log(
        `Codex config/read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    while (true) {
      log(`Starting Codex turn (thread: ${threadId})...`);
      const { result, error, closed } = await executeAppServerTurn(
        client,
        threadId,
        prompt,
        codexModel,
        codexEffort,
      );

      if (error) {
        log(`Codex turn error: ${error}`);
        writeOutput({
          status: 'error',
          result: result || null,
          newSessionId: threadId,
          error,
        });
      } else {
        writeOutput({
          status: 'success',
          result: result || null,
          newSessionId: threadId,
        });
      }

      if (closed) {
        log('Codex brain: close sentinel consumed during turn, exiting');
        break;
      }

      writeOutput({ status: 'success', result: null, newSessionId: threadId });
      log('Codex turn done, waiting for next IPC message...');

      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Codex brain: close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars)`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Codex brain error: ${errorMessage}`);
    writeOutput({ status: 'error', result: null, error: errorMessage });
    process.exit(1);
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* ignore */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  try {
    const settingsPath = path.join(
      process.env.HOME || '/home/node',
      '.nanoclaw-agent',
      'settings.json',
    );
    const settingsEnv = (
      JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        env?: Record<string, string>;
      }
    ).env;

    if (settingsEnv) {
      for (const [key, value] of Object.entries(settingsEnv)) {
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    /* settings.json absent or unreadable */
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  if (containerInput.script && containerInput.isScheduledTask) {
    log('Running task script...');
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({ status: 'success', result: null });
      return;
    }

    containerInput = {
      ...containerInput,
      prompt:
        `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n` +
        containerInput.prompt,
    };
  }

  await runCodexBrain(containerInput);
}

main().catch((err) => {
  writeOutput({
    status: 'error',
    result: null,
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
