import { getSetting } from '../database.js';
import { ClaudeSession } from './claude-session.js';
import { CodexSession } from './codex-session.js';
import { runBatch as claudeRunBatch, type RunOptions, type LLMResult } from './claude-cli.js';
import { runBatch as codexRunBatch } from './codex-cli.js';
import type { LLMConfig, LLMSession } from './types.js';

export type Provider = 'claude' | 'codex';

/** The backend the user has selected (Settings → Provider radios). Defaults to Claude. */
export function activeProvider(): Provider {
  return getSetting('llm_provider') === 'codex' ? 'codex' : 'claude';
}

/** Create a streaming session on the active provider (live overlay, research). The factory injects
 *  the provider-specific CLI path + model (Claude tier names don't apply to Codex). */
export function createSession(cfg: LLMConfig): LLMSession {
  if (activeProvider() === 'codex') {
    return new CodexSession({
      ...cfg,
      cliPath: getSetting('codex_cli_path') || 'codex',
      model: getSetting('codex_model') || '',
    });
  }
  return new ClaudeSession({ ...cfg, cliPath: cfg.cliPath || getSetting('claude_cli_path') || undefined });
}

/** Run a one-shot prompt on the active provider (screenshot, summary, rolling-context). */
export function runBatch(prompt: string, opts: RunOptions = {}): Promise<LLMResult> {
  return activeProvider() === 'codex' ? codexRunBatch(prompt, opts) : claudeRunBatch(prompt, opts);
}
