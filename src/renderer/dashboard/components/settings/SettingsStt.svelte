<script lang="ts">
  let apiKey = $state('');
  let showKey = $state(false);
  let saving = $state(false);
  let testing = $state(false);
  let msg = $state<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const k = await window.electronAPI.invoke('settings:get', 'deepgram_api_key') as string | undefined;
    apiKey = k ?? '';
  }

  async function save() {
    saving = true; msg = null;
    try {
      await window.electronAPI.invoke('settings:set', 'deepgram_api_key', apiKey.trim());
      msg = { ok: true, text: 'API key saved' };
    } catch { msg = { ok: false, text: 'Failed to save API key' }; }
    saving = false;
  }

  async function test() {
    testing = true; msg = null;
    try {
      const r = await window.electronAPI.invoke('settings:test-deepgram', apiKey.trim()) as { ok: boolean; error?: string };
      msg = r?.ok ? { ok: true, text: 'Connection successful' } : { ok: false, text: `Connection failed${r?.error ? `: ${r.error}` : ''}` };
    } catch { msg = { ok: false, text: 'Connection test failed' }; }
    testing = false;
  }

  load();
</script>

<div class="set-card">
  <div class="set-card-head">
    <div class="set-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
      </svg>
    </div>
    <div>
      <div class="set-card-title">Deepgram</div>
      <div class="set-card-desc">Nova streaming model — used during every meeting.</div>
    </div>
    <span class="set-card-badge">Active</span>
  </div>

  <div class="set-field">
    <span class="set-label">API Key</span>
    <div class="key-row">
      {#if showKey}
        <input type="text" class="set-input set-mono" bind:value={apiKey} placeholder="Enter your Deepgram API key" />
      {:else}
        <input type="password" class="set-input set-mono" bind:value={apiKey} placeholder="Enter your Deepgram API key" />
      {/if}
      <button type="button" class="eye" onclick={() => showKey = !showKey} title={showKey ? 'Hide' : 'Show'}>
        {#if showKey}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        {/if}
      </button>
    </div>
  </div>

  <div class="set-actions">
    <button class="set-btn" onclick={save} disabled={saving || !apiKey.trim()}>{saving ? 'Saving…' : 'Save'}</button>
    <button class="set-btn-ghost" onclick={test} disabled={testing || !apiKey.trim()}>{testing ? 'Testing…' : 'Test Connection'}</button>
  </div>

  {#if msg}<div class="set-msg" class:ok={msg.ok} class:err={!msg.ok}>{msg.text}</div>{/if}
</div>

<style>
  .key-row { display: flex; gap: 8px; }
  .eye {
    flex-shrink: 0;
    width: 42px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    transition: all var(--transition);
  }
  .eye:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>
