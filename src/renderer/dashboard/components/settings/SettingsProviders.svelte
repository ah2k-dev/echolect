<script lang="ts">
  type Provider = 'claude' | 'codex';

  let provider = $state<Provider>('claude');
  let claudeModel = $state('haiku');
  let claudeCliPath = $state('');
  let codexModel = $state('');
  let codexCliPath = $state('');
  let installed = $state<{ claude: boolean; codex: boolean }>({ claude: true, codex: true });
  let saving = $state(false);
  let testing = $state(false);
  let msg = $state<{ ok: boolean; text: string } | null>(null);

  async function load() {
    provider = (await window.electronAPI.invoke('settings:get', 'llm_provider') as string) === 'codex' ? 'codex' : 'claude';
    claudeModel = (await window.electronAPI.invoke('settings:get', 'llm_model') as string) || 'haiku';
    claudeCliPath = (await window.electronAPI.invoke('settings:get', 'claude_cli_path') as string) ?? '';
    codexModel = (await window.electronAPI.invoke('settings:get', 'codex_model') as string) ?? '';
    codexCliPath = (await window.electronAPI.invoke('settings:get', 'codex_cli_path') as string) ?? '';
    installed = await window.electronAPI.invoke('providers:detect') as { claude: boolean; codex: boolean };
    // Never silently switch providers — keep the chosen one and warn if it isn't detected.
    if (!installed[provider]) {
      msg = { ok: false, text: `${provider === 'codex' ? 'Codex' : 'Claude'} isn't detected — set its CLI path below. It won't fall back to the other provider.` };
    }
  }

  async function selectProvider(p: Provider) {
    if (!installed[p]) return;
    provider = p;
    await window.electronAPI.invoke('settings:set', 'llm_provider', p);
    msg = { ok: true, text: `${p === 'claude' ? 'Claude' : 'Codex'} is now the active backend` };
  }

  async function save() {
    saving = true; msg = null;
    try {
      await window.electronAPI.invoke('settings:set', 'llm_provider', provider);
      await window.electronAPI.invoke('settings:set', 'llm_model', claudeModel.trim() || 'haiku');
      await window.electronAPI.invoke('settings:set', 'claude_cli_path', claudeCliPath.trim());
      await window.electronAPI.invoke('settings:set', 'codex_model', codexModel.trim());
      await window.electronAPI.invoke('settings:set', 'codex_cli_path', codexCliPath.trim());
      installed = await window.electronAPI.invoke('providers:detect') as { claude: boolean; codex: boolean };
      msg = { ok: true, text: 'Provider settings saved' };
    } catch { msg = { ok: false, text: 'Failed to save' }; }
    saving = false;
  }

  async function test() {
    testing = true; msg = null;
    try {
      await save();
      const r = await window.electronAPI.invoke('llm:test', provider === 'claude' ? claudeModel.trim() : codexModel.trim()) as {
        ok: boolean; text: string; error?: string; durationMs: number;
      };
      const secs = (r.durationMs / 1000).toFixed(1);
      msg = r.ok
        ? { ok: true, text: `${provider === 'claude' ? 'Claude' : 'Codex'} responded in ${secs}s — "${r.text}"` }
        : { ok: false, text: `Failed (${secs}s): ${r.error ?? 'unknown error'}` };
    } catch { msg = { ok: false, text: 'Test failed' }; }
    testing = false;
  }

  load();
</script>

<div class="set-card" class:on={provider === 'claude'} class:dim={!installed.claude}>
  <div class="set-card-head">
    <input type="radio" class="prov-radio" name="provider" checked={provider === 'claude'} disabled={!installed.claude} onchange={() => selectProvider('claude')} aria-label="Use Claude" />
    <div class="set-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
    </div>
    <div>
      <div class="set-card-title">Claude CLI</div>
      <div class="set-card-desc">Runs the local <code>claude</code> CLI — reads meeting files &amp; code directly.</div>
    </div>
    {#if provider === 'claude'}<span class="set-card-badge">Active</span>{:else if !installed.claude}<span class="set-card-badge soon">Not found</span>{/if}
  </div>

  <div class="set-field">
    <span class="set-label">Model</span>
    <select class="set-select" bind:value={claudeModel}>
      <option value="haiku">Haiku — fastest, best for live</option>
      <option value="sonnet">Sonnet 4.6 — stronger, slower</option>
    </select>
  </div>
  <div class="set-field">
    <span class="set-label">CLI Path <span class="set-optional">optional</span></span>
    <input type="text" class="set-input set-mono" bind:value={claudeCliPath} placeholder="claude (uses PATH)" />
    <span class="set-hint">Only set this if <code>claude</code> isn't on your PATH.</span>
  </div>
</div>

<div class="set-card" class:on={provider === 'codex'} class:dim={!installed.codex}>
  <div class="set-card-head">
    <input type="radio" class="prov-radio" name="provider" checked={provider === 'codex'} disabled={!installed.codex} onchange={() => selectProvider('codex')} aria-label="Use Codex" />
    <div class="set-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>
    </div>
    <div>
      <div class="set-card-title">Codex CLI</div>
      <div class="set-card-desc">Runs the local <code>codex</code> CLI via its app-server — full live + research + vision.</div>
    </div>
    {#if provider === 'codex'}<span class="set-card-badge">Active</span>{:else if !installed.codex}<span class="set-card-badge soon">Not found</span>{/if}
  </div>

  <div class="set-field">
    <span class="set-label">Model <span class="set-optional">optional</span></span>
    <input type="text" class="set-input set-mono" bind:value={codexModel} placeholder="blank = codex default (e.g. gpt-5.5)" />
    <span class="set-hint">Codex model id — leave blank to use your codex default. Use <b>Test</b> to verify.</span>
  </div>
  <div class="set-field">
    <span class="set-label">CLI Path <span class="set-optional">optional</span></span>
    <input type="text" class="set-input set-mono" bind:value={codexCliPath} placeholder="codex (uses PATH)" />
    <span class="set-hint">Set the absolute path if <code>codex</code> isn't on your PATH.</span>
  </div>
</div>

<div class="set-actions">
  <button class="set-btn" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
  <button class="set-btn-ghost" onclick={test} disabled={testing}>{testing ? 'Testing…' : `Test ${provider === 'claude' ? 'Claude' : 'Codex'}`}</button>
</div>
{#if msg}<div class="set-msg" class:ok={msg.ok} class:err={!msg.ok}>{msg.text}</div>{/if}

<style>
  .set-card.on { border-color: var(--border-focus); box-shadow: 0 0 0 1px var(--accent-soft); }
  .set-card.dim { opacity: 0.55; }
  .prov-radio { width: 16px; height: 16px; accent-color: var(--accent); flex-shrink: 0; margin-right: 2px; cursor: pointer; }
  .prov-radio:disabled { cursor: not-allowed; }
</style>
