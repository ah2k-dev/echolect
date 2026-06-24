import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import type { LLMConfig, LLMSession } from './types.js';

/**
 * A persistent, streaming `claude` session over the stream-json protocol.
 *
 * Pay the CLI cold-start once, then feed user messages and stream token deltas back.
 * This is the reusable transport behind BOTH the AI-edit popover (tools on, slower)
 * and the future live meeting assist (tools off, fast). Callers build their own system
 * prompt / config; this module stays artifact-agnostic.
 *
 * Events:
 *   'token' (text)      — incremental assistant text
 *   'turn'  (fullText)  — a turn completed (full text for that turn)
 *   'error' (message)
 *   'close' ()          — process exited
 */
/** Claude's session config is the provider-neutral one (images are read via the Read tool). */
export type ClaudeSessionConfig = LLMConfig;

export class ClaudeSession extends EventEmitter implements LLMSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private turnText = '';
  private streamedThisTurn = false;
  private closed = false;

  constructor(private readonly config: ClaudeSessionConfig) {
    super();
  }

  start(): void {
    if (this.proc) return;

    const args = [
      '-p',
      '--model', this.config.model,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];
    // NOTE: --add-dir and --allowedTools are variadic; keep them followed by another
    // flag (or end of args) so they don't swallow the next value. Input arrives via
    // stdin (stream-json), so there is no positional prompt for them to eat.
    for (const dir of this.config.addDirs ?? []) {
      args.push('--add-dir', dir);
    }
    if (this.config.allowedTools?.length) {
      args.push('--allowedTools', ...this.config.allowedTools);
    }
    if (this.config.systemPrompt) {
      args.push('--append-system-prompt', this.config.systemPrompt);
    }

    this.proc = spawn(this.config.cliPath || 'claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.cwd,
    });

    this.proc.stdout.on('data', (d) => this.onStdout(d.toString()));
    this.proc.stderr.on('data', () => { /* swallow noisy CLI logs; surfaced via 'error' on failure */ });
    this.proc.on('error', (e) => {
      const err = e as NodeJS.ErrnoException;
      this.emit('error', err.code === 'ENOENT'
        ? `Claude CLI not found ("${this.config.cliPath || 'claude'}"). Set its path in Settings.`
        : err.message);
    });
    this.proc.on('close', () => { this.closed = true; this.emit('close'); });
  }

  /** Send a user message. Starts the session lazily if needed. */
  send(text: string): void {
    if (this.closed) return;
    if (!this.proc) this.start();
    this.turnText = '';
    this.streamedThisTurn = false;
    const msg = { type: 'user', message: { role: 'user', content: text } };
    this.proc!.stdin.write(JSON.stringify(msg) + '\n');
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

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      this.handleEvent(ev);
    }
  }

  private handleEvent(ev: any): void {
    // Incremental text deltas (from --include-partial-messages)
    if (ev?.type === 'stream_event') {
      const delta = ev.event?.delta;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.turnText += delta.text;
        this.streamedThisTurn = true;
        this.emit('token', delta.text);
      }
      return;
    }

    // Fallback: a full assistant message (if deltas weren't emitted for some reason)
    if (ev?.type === 'assistant' && !this.streamedThisTurn) {
      const parts = ev.message?.content;
      if (Array.isArray(parts)) {
        const text = parts.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('');
        if (text) { this.turnText += text; this.emit('token', text); }
      }
      return;
    }

    // Turn finished
    if (ev?.type === 'result') {
      const full = this.turnText || (typeof ev.result === 'string' ? ev.result : '');
      this.emit('turn', full);
    }
  }
}
