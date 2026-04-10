// Ported from EJClaw (phj1081/EJClaw) — app-server-client.ts
// Adapted for NanoClaw: removed EJClaw-specific role/reviewer logic.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

import {
  createInitialAppServerTurnState,
  getAppServerTurnResult,
  isAppServerTurnFinished,
  reduceAppServerTurnState,
  type AppServerTurnEvent,
  type AppServerTurnState,
} from './codex-app-server-state.js';

export interface AppServerInputItemText {
  type: 'text';
  text: string;
}

export type AppServerInputItem = AppServerInputItemText;

export interface CodexAppServerThreadOptions {
  cwd: string;
  model?: string;
}

export interface CodexAppServerTurnOptions {
  cwd: string;
  model?: string;
  effort?: string;
  onProgress?: (message: string) => void;
}

export interface CodexAppServerTurnResult {
  state: AppServerTurnState;
  result: string | null;
}

export interface AppServerReasoningEffortOption {
  reasoningEffort: string;
  description?: string;
}

export interface AppServerModelInfo {
  id: string;
  model?: string;
  displayName?: string;
  isDefault?: boolean;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: AppServerReasoningEffortOption[];
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface ActiveTurn {
  threadId: string;
  state: AppServerTurnState;
  onProgress?: (message: string) => void;
  resolve: (value: CodexAppServerTurnResult) => void;
  reject: (reason?: unknown) => void;
}

export interface CodexAppServerClientOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

export class CodexAppServerClient {
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (message: string) => void;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = '';
  private activeTurn: ActiveTurn | null = null;
  private proc: ChildProcessWithoutNullStreams | null = null;

  constructor(options: CodexAppServerClientOptions) {
    this.cwd = options.cwd;
    this.env = options.env || process.env;
    this.log = options.log;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    // @openai/codex is installed globally in the container image (npm install -g).
    // Spawn the `codex` binary from PATH rather than resolving via require(),
    // which only searches local node_modules and would fail here.
    const mcpArgs = ['/tmp/dist/ipc-mcp-stdio.js'];
    if (this.env.NANOCLAW_CHAT_JID) {
      mcpArgs.push('--chat-jid', this.env.NANOCLAW_CHAT_JID);
    }
    if (this.env.NANOCLAW_GROUP_FOLDER) {
      mcpArgs.push('--group-folder', this.env.NANOCLAW_GROUP_FOLDER);
    }
    if (this.env.NANOCLAW_IS_MAIN) {
      mcpArgs.push('--is-main', this.env.NANOCLAW_IS_MAIN);
    }

    this.proc = spawn(
      'codex',
      [
        '-c',
        'mcp_servers.nanoclaw.command="node"',
        '-c',
        `mcp_servers.nanoclaw.args=${JSON.stringify(mcpArgs)}`,
        'app-server',
      ],
      {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) this.handleStdoutLine(trimmed);
      }
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) this.log(`[app-server] ${trimmed}`);
      }
    });

    this.proc.on('close', (code) => {
      this.rejectAll(new Error(`Codex app-server exited with code ${code ?? 'unknown'}`));
    });

    this.proc.on('error', (error) => {
      this.rejectAll(error);
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'nanoclaw_codex_runner',
        title: 'NanoClaw Codex Runner',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'item/agentMessage/delta',
          'item/plan/delta',
          'item/reasoning/textDelta',
          'item/reasoning/summaryTextDelta',
          'item/reasoning/summaryPartAdded',
        ],
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

  async startOrResumeThread(
    sessionId: string | undefined,
    options: CodexAppServerThreadOptions,
  ): Promise<string> {
    const params = {
      cwd: options.cwd,
      model: options.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'nanoclaw',
    };

    const result = sessionId
      ? await this.request('thread/resume', { threadId: sessionId, ...params })
      : await this.request('thread/start', params);

    const thread = (result as { thread?: { id?: string; model?: string } }).thread;
    if (!thread?.id) {
      throw new Error('Codex app-server did not return a thread id.');
    }
    if (thread.model) {
      this.log(`[app-server] active model: ${thread.model}`);
    }
    return thread.id;
  }

  async startTurn(
    threadId: string,
    input: AppServerInputItem[],
    options: CodexAppServerTurnOptions,
  ): Promise<{
    turnId: string;
    steer: (nextInput: AppServerInputItem[]) => Promise<void>;
    interrupt: () => Promise<void>;
    wait: () => Promise<CodexAppServerTurnResult>;
  }> {
    if (this.activeTurn) {
      throw new Error('A Codex app-server turn is already active.');
    }

    const turnPromise = new Promise<CodexAppServerTurnResult>((resolve, reject) => {
      this.activeTurn = {
        threadId,
        state: createInitialAppServerTurnState(),
        onProgress: options.onProgress,
        resolve,
        reject,
      };
    });

    let turnId = '';
    try {
      const response = (await this.request('turn/start', {
        threadId,
        input,
        cwd: options.cwd,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess', networkAccess: true },
        model: options.model,
        effort: options.effort,
        summary: 'concise',
      })) as { turn?: { id?: string; status?: string } };

      turnId = response.turn?.id || '';
      if (!turnId) throw new Error('Codex app-server did not return a turn id.');

      const activeTurn = this.activeTurn as ActiveTurn | null;
      if (activeTurn !== null) {
        activeTurn.state = reduceAppServerTurnState(activeTurn.state, {
          method: 'turn/started',
          params: { turn: { id: turnId, status: response.turn?.status || 'inProgress' } },
        });
      }
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }

    return {
      turnId,
      steer: async (nextInput) => {
        await this.request('turn/steer', { threadId, input: nextInput, expectedTurnId: turnId });
      },
      interrupt: async () => {
        await this.request('turn/interrupt', { threadId, turnId });
      },
      wait: async () => turnPromise,
    };
  }

  async listModels(): Promise<AppServerModelInfo[]> {
    const result = await this.request('model/list', { limit: 50, includeHidden: false });
    return ((result as { data?: AppServerModelInfo[] }).data) ?? [];
  }

  async readConfig(): Promise<Record<string, unknown>> {
    return (await this.request('config/read', {})) as Record<string, unknown>;
  }

  async startCompaction(threadId: string): Promise<CodexAppServerTurnResult> {
    if (this.activeTurn) {
      throw new Error('A Codex app-server turn is already active.');
    }

    const turnPromise = new Promise<CodexAppServerTurnResult>((resolve, reject) => {
      this.activeTurn = {
        threadId,
        state: createInitialAppServerTurnState(),
        resolve,
        reject,
      };
    });

    try {
      await this.request('thread/compact/start', { threadId });
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }

    return turnPromise;
  }

  private handleStdoutLine(line: string): void {
    let message: JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`[app-server] non-JSON stdout: ${line}`);
      return;
    }

    if (
      typeof (message as JsonRpcResponse).id === 'number' &&
      ('result' in message || 'error' in message) &&
      !('method' in message)
    ) {
      this.handleResponse(message as JsonRpcResponse);
      return;
    }

    if (
      typeof (message as JsonRpcServerRequest).id === 'number' &&
      typeof (message as JsonRpcServerRequest).method === 'string'
    ) {
      this.handleServerRequest(message as JsonRpcServerRequest);
      return;
    }

    if (typeof (message as JsonRpcNotification).method === 'string') {
      this.handleNotification(message as JsonRpcNotification);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
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

  private handleServerRequest(message: JsonRpcServerRequest): void {
    if (message.method.endsWith('/requestApproval')) {
      this.respond(message.id, 'acceptForSession');
      return;
    }
    this.respondError(message.id, -32601, `NanoClaw does not handle server request ${message.method}`);
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (!this.activeTurn) return;

    if (message.method === 'item/completed') {
      const item = (message.params?.item as Record<string, unknown> | undefined) || undefined;
      if (
        item?.type === 'agentMessage' &&
        item.phase !== 'final_answer' &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0
      ) {
        this.activeTurn.onProgress?.(item.text);
      }
    }

    this.activeTurn.state = reduceAppServerTurnState(
      this.activeTurn.state,
      message as AppServerTurnEvent,
    );

    if (!isAppServerTurnFinished(this.activeTurn.state)) return;

    const activeTurn = this.activeTurn;
    this.activeTurn = null;
    activeTurn.resolve({ state: activeTurn.state, result: getAppServerTurnResult(activeTurn.state) });
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();

    if (this.activeTurn) {
      const activeTurn = this.activeTurn;
      this.activeTurn = null;
      activeTurn.reject(error);
    }
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

  private respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private respondError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) {
      throw new Error('Codex app-server stdin is not writable.');
    }
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
}
