import { spawn } from 'child_process';
import { getSetting } from '../database.js';

/**
 * Wrapper around the `claude` CLI used as Echolect's LLM backend.
 *
 * Why the CLI rather than an HTTP API: it reuses the existing Claude CLI auth, and the agent can
 * read local context (transcript.md, screenshots, project code) directly off disk.
 *
 * This module implements the BATCH path — a one-shot `claude -p` invocation, used for post-meeting
 * work (summaries, context updates) where the ~8s cold start is irrelevant. The low-latency live
 * path is a persistent stream-json session (see claude-session.ts); both sit behind the
 * provider-agnostic interface in provider.ts.
 */

export interface LLMResult {
  ok: boolean;
  text: string;
  error?: string;
  durationMs: number;
}

export interface RunOptions {
  /** Model alias or full id. Defaults to the `llm_model` setting, then 'haiku'. */
  model?: string;
  /** Extra directories the CLI may read (e.g. the meeting folder, project codebase). */
  addDirs?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Tool whitelist (e.g. ['Read','Grep','Glob'] to let it read an image/files). */
  allowedTools?: string[];
  /** Kill the process after this many ms. Defaults to 120s. */
  timeoutMs?: number;
  /** Image file paths to attach (Codex `-i`; Claude reads via the Read tool + path in the prompt). */
  images?: string[];
}

function resolveCliPath(): string {
  return getSetting('claude_cli_path') || 'claude';
}

function resolveModel(explicit?: string): string {
  return explicit || getSetting('llm_model') || 'haiku';
}

/**
 * Run a one-shot prompt through `claude -p`. The prompt is fed via STDIN (not argv)
 * so large transcripts don't hit the OS argument-length limit.
 */
export function runBatch(prompt: string, opts: RunOptions = {}): Promise<LLMResult> {
  const cli = resolveCliPath();
  const model = resolveModel(opts.model);
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const args = ['-p', '--model', model];
  for (const dir of opts.addDirs ?? []) {
    args.push('--add-dir', dir);
  }
  if (opts.allowedTools?.length) {
    args.push('--allowedTools', ...opts.allowedTools);
  }

  const start = Date.now();
  return new Promise<LLMResult>((resolve) => {
    let settled = false;
    const done = (r: LLMResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts.cwd,
      });
    } catch (e) {
      return done({ ok: false, text: '', error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - start });
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, text: '', error: `Timed out after ${timeoutMs}ms`, durationMs: Date.now() - start });
    }, timeoutMs);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (e) => {
      // ENOENT here means the CLI binary wasn't found on PATH
      const hint = (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Claude CLI not found ("${cli}"). Set its path in Settings if it isn't on PATH.`
        : e.message;
      done({ ok: false, text: '', error: hint, durationMs: Date.now() - start });
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - start;
      if (code === 0) {
        done({ ok: true, text: stdout.trim(), durationMs });
      } else {
        done({ ok: false, text: stdout.trim(), error: stderr.trim() || `claude exited with code ${code}`, durationMs });
      }
    });

    // Feed the prompt via stdin, then close it so the CLI knows input is complete.
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
