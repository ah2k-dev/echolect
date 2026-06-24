import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import type { LLMConfig, LLMSession } from './types.js';

/**
 * A persistent, streaming Codex session — the warm transport for the live overlay + research on the
 * Codex backend. Drives `codex app-server` over stdio (line-delimited JSON, {method,id,params}):
 *   initialize  →  thread/start (baseInstructions = system prompt, read-only sandbox)  →  per turn: turn/start
 * Streamed notifications:
 *   item/agentMessage/delta {delta}  → 'token'
 *   turn/completed                   → 'turn'
 *   turn/failed | error              → 'error'
 *
 * cliPath + model are the Codex-specific values injected by the provider factory (Claude tier names
 * like "haiku" don't apply here).
 */
export class CodexSession extends EventEmitter implements LLMSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private initId = -1;
  private threadStartId = -1;
  private threadId: string | null = null;
  private ready = false;
  private queue: string[] = [];   // turns requested before the thread is ready
  private turnText = '';
  private closed = false;

  constructor(private readonly config: LLMConfig) {
    super();
  }

  start(): void {
    if (this.proc) return;
    const cli = this.config.cliPath || 'codex';
    this.proc = spawn(cli, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: this.config.cwd });
    this.proc.stdout.on('data', (d) => this.onStdout(d.toString()));
    this.proc.stderr.on('data', () => { /* swallow noisy logs; failures surface via 'error'/'close' */ });
    this.proc.on('error', (e) => {
      const err = e as NodeJS.ErrnoException;
      this.emit('error', err.code === 'ENOENT'
        ? `Codex CLI not found ("${cli}"). Set its path in Settings.`
        : err.message);
    });
    this.proc.on('close', () => { this.closed = true; this.emit('close'); });

    this.initId = this.rpc('initialize', {
      clientInfo: { name: 'echolect', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
  }

  /** Send a user turn. Queues until the thread is ready (after initialize + thread/start). */
  send(text: string): void {
    if (this.closed) return;
    if (!this.proc) this.start();
    if (this.ready && this.threadId) this.startTurn(text);
    else this.queue.push(text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.proc) {
      try { this.proc.stdin.end(); } catch { /* ignore */ }
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }

  private rpc(method: string, params: unknown): number {
    const id = this.nextId++;
    this.proc!.stdin.write(JSON.stringify({ method, id, params }) + '\n');
    return id;
  }

  private startTurn(text: string): void {
    this.turnText = '';
    this.rpc('turn/start', { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }] });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      this.handle(ev);
    }
  }

  private handle(ev: any): void {
    // Request responses
    if (ev.id !== undefined && ev.result !== undefined) {
      if (ev.id === this.initId) {
        this.threadStartId = this.rpc('thread/start', {
          model: this.config.model || undefined,   // undefined → codex default
          cwd: this.config.cwd,
          sandbox: 'read-only',
          baseInstructions: this.config.systemPrompt || undefined,
          ephemeral: true,
        });
      } else if (ev.id === this.threadStartId) {
        this.threadId = ev.result?.thread?.id ?? null;
        this.ready = !!this.threadId;
        if (this.ready) {
          const pending = this.queue;
          this.queue = [];
          for (const t of pending) this.startTurn(t);
        }
      }
      return;
    }
    if (ev.id !== undefined && ev.error) {
      this.emit('error', ev.error?.message || JSON.stringify(ev.error));
      return;
    }
    // Notifications
    switch (ev.method) {
      case 'turn/started':
        this.turnText = '';
        break;
      case 'item/agentMessage/delta': {
        const d = ev.params?.delta;
        if (typeof d === 'string') { this.turnText += d; this.emit('token', d); }
        break;
      }
      case 'turn/completed':
        this.emit('turn', this.turnText);
        break;
      case 'turn/failed':
      case 'error':
        this.emit('error', ev.params?.error?.message || ev.params?.message || 'Codex turn failed');
        break;
    }
  }
}
