<script lang="ts">
  import HotkeyInput from './HotkeyInput.svelte';

  interface Props {
    onConfigure: (promptKey: string) => void;
  }
  let { onConfigure }: Props = $props();

  const SCREENSHOT_DEFAULT = 'CmdOrCtrl+Shift+S';

  const intents = [
    { label: 'Answer',   key: 'intent_answer_hotkey',  prompt: 'intent_answer_prompt',  desc: 'Answer the interviewer directly' },
    { label: 'Suggest',  key: 'intent_suggest_hotkey', prompt: 'intent_suggest_prompt', desc: 'Suggest what to say or how to steer' },
    { label: 'Ask back', key: 'intent_askback_hotkey', prompt: 'intent_askback_prompt', desc: 'A sharp question to ask them' },
    { label: 'Explain',  key: 'intent_explain_hotkey', prompt: 'intent_explain_prompt', desc: 'A fuller explanation to talk through' },
  ];

  let screenshot = $state(SCREENSHOT_DEFAULT);
  let keys = $state<Record<string, string>>(Object.fromEntries(intents.map(i => [i.key, ''])));
  let saving = $state(false);
  let msg = $state<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const s = await window.electronAPI.invoke('settings:get', 'screenshot_hotkey') as string | undefined;
    screenshot = s || SCREENSHOT_DEFAULT;
    for (const i of intents) {
      const v = await window.electronAPI.invoke('settings:get', i.key) as string | undefined;
      keys[i.key] = v || '';
    }
  }

  async function save() {
    saving = true; msg = null;
    try {
      await window.electronAPI.invoke('settings:set', 'screenshot_hotkey', screenshot);
      for (const i of intents) {
        await window.electronAPI.invoke('settings:set', i.key, keys[i.key]);
      }
      msg = { ok: true, text: 'Shortcuts saved — applies to your next meeting' };
    } catch { msg = { ok: false, text: 'Failed to save shortcuts' }; }
    saving = false;
  }

  load();
</script>

<div class="set-panel-head">
  <h1 class="set-panel-title">Hot Keys</h1>
  <p class="set-panel-sub">Global shortcuts active during a meeting. Each intent uses its own prompt.</p>
</div>

<div class="set-card">
  <div class="set-card-head">
    <div class="set-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h0M10 10h0M14 10h0M18 10h0M6 14h0M18 14h0"/><path d="M10 14h4"/>
      </svg>
    </div>
    <div>
      <div class="set-card-title">Capture</div>
      <div class="set-card-desc">Screen capture into the meeting folder.</div>
    </div>
  </div>

  <div class="hk-row">
    <div class="hk-meta">
      <div class="hk-name">Screenshot</div>
      <div class="hk-desc">Save a screenshot of the current screen</div>
    </div>
    <HotkeyInput bind:value={screenshot} />
  </div>
</div>

<div class="set-card">
  <div class="set-card-head">
    <div class="set-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
    </div>
    <div>
      <div class="set-card-title">Live Assist Intents</div>
      <div class="set-card-desc">Each key triggers a response using its prompt. Edit prompts via <strong>Configure</strong>.</div>
    </div>
  </div>

  {#each intents as i}
    <div class="hk-row">
      <div class="hk-meta">
        <div class="hk-name">{i.label}</div>
        <div class="hk-desc">{i.desc}</div>
      </div>
      <div class="hk-controls">
        <HotkeyInput bind:value={keys[i.key]} />
        <button class="configure" onclick={() => onConfigure(i.prompt)} title="Edit this intent's prompt">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          Configure
        </button>
      </div>
    </div>
  {/each}
</div>

<div class="set-actions" style="margin-top: 16px;">
  <button class="set-btn" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save shortcuts'}</button>
</div>
{#if msg}<div class="set-msg" class:ok={msg.ok} class:err={!msg.ok}>{msg.text}</div>{/if}

<style>
  .hk-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 0;
    border-top: 1px solid var(--border-light);
  }
  .hk-row:first-of-type { border-top: none; }
  .hk-meta { flex: 1; min-width: 0; }
  .hk-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
  .hk-desc { font-size: 11.5px; color: var(--text-tertiary); margin-top: 1px; }
  .hk-controls { display: flex; align-items: center; gap: 8px; }

  .configure {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 11px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
    white-space: nowrap;
  }
  .configure:hover { background: var(--accent-soft); color: var(--accent); border-color: var(--border-focus); }
</style>
