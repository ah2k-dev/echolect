import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting } from '../database.js';
import type { LLMResult, RunOptions } from './claude-cli.js';

/**
 * One-shot batch path for the Codex backend (summaries, rolling-context, screenshot vision).
 * Mirrors claude-cli's `runBatch` but shells out to `codex exec`:
 *   - prompt via STDIN (so large transcripts don't hit the argv limit)
 *   - `-s read-only` sandbox (can read files + web, can't write/execute mutating commands)
 *   - `-o <file>` writes ONLY the final assistant message (clean output, no agent chatter)
 *   - `--ephemeral` (no session persisted) + `--skip-git-repo-check` (meeting dirs aren't repos)
 *   - `-i <image>` for vision
 * Model is the Codex-specific `codex_model` setting (Claude tier names don't apply); empty → codex default.
 */
function resolveCodexPath(): string {
  return getSetting('codex_cli_path') || 'codex';
}

export function runBatch(prompt: string, opts: RunOptions = {}): Promise<LLMResult> {
  const cli = resolveCodexPath();
  const model = getSetting('codex_model') || '';
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const outFile = path.join(os.tmpdir(), `codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-o', outFile];
  if (opts.cwd) args.push('-C', opts.cwd);
  if (model) args.push('-m', model);
  for (const dir of opts.addDirs ?? []) args.push('--add-dir', dir);
  for (const img of opts.images ?? []) args.push('-i', img);
  args.push('-'); // read the prompt from stdin

  const start = Date.now();
  return new Promise<LLMResult>((resolve) => {
    let settled = false;
    const done = (r: LLMResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.existsSync(outFile) && fs.unlinkSync(outFile); } catch { /* ignore */ }
      resolve(r);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd });
    } catch (e) {
      return done({ ok: false, text: '', error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - start });
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, text: '', error: `Timed out after ${timeoutMs}ms`, durationMs: Date.now() - start });
    }, timeoutMs);

    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      const hint = (e as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Codex CLI not found ("${cli}"). Set its path in Settings.`
        : e.message;
      done({ ok: false, text: '', error: hint, durationMs: Date.now() - start });
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - start;
      // The clean final message is in the -o file; stdout is the human transcript.
      const text = (() => { try { return fs.readFileSync(outFile, 'utf-8').trim(); } catch { return ''; } })();
      if (text) done({ ok: true, text, durationMs });
      else done({ ok: false, text: '', error: stderr.trim() || `codex exited with code ${code} and no output`, durationMs });
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
