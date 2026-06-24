import type { EventEmitter } from 'events';

/**
 * Provider-neutral config for a streaming LLM session. Both the Claude (stream-json) and Codex
 * (app-server) sessions are constructed from this — callers don't know which backend they got.
 */
export interface LLMConfig {
  /** Model alias or id. Required (caller resolves the active provider's default). */
  model: string;
  /** Path to the CLI binary. Defaults to the provider's name on PATH. */
  cliPath?: string;
  /** Working directory for the spawned process (avoid inheriting the dev repo's cwd). */
  cwd?: string;
  /** Persona/knowledge/tools framing prepended to the conversation. */
  systemPrompt?: string;
  /** Directories the session may read (project root, codebase, attachments). */
  addDirs?: string[];
  /** Read-only tool whitelist (e.g. ['Read','Grep','Glob']); maps to a read-only sandbox for Codex. */
  allowedTools?: string[];
  /** Image file paths to attach to the first turn (vision). */
  images?: string[];
}

/**
 * A persistent, streaming LLM session — the warm transport behind the live overlay and research.
 *
 * Events:
 *   'token' (text)      — incremental assistant text
 *   'turn'  (fullText)  — a turn completed (full text for that turn)
 *   'error' (message)
 *   'close' ()          — process exited
 */
export interface LLMSession extends EventEmitter {
  start(): void;
  send(text: string): void;
  close(): void;
}
