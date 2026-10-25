import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HelperErrorPayload, HelperNotification, Method, ResponseEnvelope } from '../shared/protocol';
import { DEFAULT_OPERATION_TIMEOUT_MS } from '../shared/protocol';

export class RpcError extends Error {
  constructor(readonly payload: HelperErrorPayload) {
    super(payload.message);
  }
}

export interface HelperClientOptions {
  helperPath: string;
  /** Defaults to the current executable with ELECTRON_RUN_AS_NODE=1. */
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  heartbeatMs?: number;
  onNotification?: (notification: HelperNotification) => void;
  onStderr?: (line: string) => void;
}

interface PendingRequest {
  /** The process instance this request was written to. */
  child: ChildProcessWithoutNullStreams;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * Spawns and talks to the helper. The helper is a short-lived, replaceable
 * process: it is killed on release, restarted on the next request, and it
 * exits by itself when this process disappears (stdin EOF).
 */
export class HelperClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private heartbeat: NodeJS.Timeout | undefined;
  private stdoutBuffer = '';
  private closed = false;

  constructor(private readonly options: HelperClientOptions) {}

  get isRunning(): boolean {
    return this.child !== undefined && !this.child.killed;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.closed) throw new RpcError({ code: 'INTERNAL', message: 'Helper client is closed.' });
    if (this.child && !this.child.killed) return this.child;

    const execPath = this.options.execPath ?? process.execPath;
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), ELECTRON_RUN_AS_NODE: '1' };
    const child = spawn(execPath, [this.options.helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim().length > 0) this.options.onStderr?.(line);
      }
    });
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.stopHeartbeat();
      this.failAllFor(child, { code: 'INTERNAL', message: `Failed to start the DuckDB helper: ${error.message}` });
    });
    child.on('exit', (code, signal) => {
      // A stale instance must not touch the state of its replacement.
      if (this.child !== child) return;
      this.child = undefined;
      this.stopHeartbeat();
      this.failAllFor(child, {
        code: 'INTERNAL',
        message: `DuckDB helper exited unexpectedly (code ${String(code)}, signal ${String(signal)}).`,
      });
    });

    this.child = child;
    this.startHeartbeat();
    return child;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeatMs ?? 1000;
    this.heartbeat = setInterval(() => {
      if (!this.child) return;
      this.request('ping', undefined, 2000).catch(() => undefined);
    }, interval);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let parsed: ResponseEnvelope | HelperNotification;
    try {
      parsed = JSON.parse(line) as ResponseEnvelope | HelperNotification;
    } catch {
      return;
    }

    if ('event' in parsed) {
      this.options.onNotification?.(parsed);
      return;
    }

    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    if (parsed.ok) {
      pending.resolve(parsed.result);
    } else {
      pending.reject(new RpcError(parsed.error ?? { code: 'INTERNAL', message: 'Unknown helper error.' }));
    }
  }

  private failAllFor(child: ChildProcessWithoutNullStreams, payload: HelperErrorPayload): void {
    for (const [id, pending] of this.pending) {
      if (pending.child !== child) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new RpcError(payload));
    }
  }

  request<T>(method: Method, params?: unknown, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, onId?: (id: number) => void): Promise<T> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.ensureChild();
    } catch (error) {
      return Promise.reject(error);
    }

    const id = this.nextId++;
    onId?.(id);
    const effectiveTimeout = Math.max(1000, timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError({ code: 'TIMEOUT', message: `No response from the DuckDB helper within ${effectiveTimeout}ms.` }));
      }, effectiveTimeout + 2000);

      this.pending.set(id, { child, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params, timeoutMs: effectiveTimeout })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new RpcError({ code: 'INTERNAL', message: `Could not write to the DuckDB helper: ${String(error)}` }));
      }
    });
  }

  /**
   * Stops the helper right now (releasing any handle it owns), but keeps the
   * client usable so the next request spawns a fresh helper.
   */
  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.stopHeartbeat();
    if (!child) return;
    this.failAllFor(child, { code: 'CANCELLED', message: 'The DuckDB helper was stopped.' });
    try {
      child.stdin.write(`${JSON.stringify({ id: this.nextId++, method: 'dispose', params: undefined })}\n`);
    } catch {
      // Already gone.
    }

    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 800);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await exited;
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // Ignore.
      }
    }
  }

  /** Final shutdown used from deactivate. */
  async dispose(): Promise<void> {
    this.closed = true;
    await this.shutdown();
  }
}
