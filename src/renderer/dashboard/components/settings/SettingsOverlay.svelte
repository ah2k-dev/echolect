<script lang="ts">
  let opacity = $state(0.94);
  let saving = $state(false);
  let msg = $state<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const v = await window.electronAPI.invoke('settings:get', 'overlay_opacity') as string | undefined;
    if (v) opacity = parseFloat(v) || 0.94;
  }

  async function save() {
    saving = true; msg = null;
    try {
      await window.electronAPI.invoke('settings:set', 'overlay_opacity', String(opacity));
      msg = { ok: true, text: 'Saved — applies to your next meeting' };
    } catch { msg = { ok: false, text: 'Failed to save' }; }
    saving = false;
  }

  load();
</script>

<div class="set-panel-head">
  <h1 class="set-panel-title">Overlay</h1>
  <p class="set-panel-sub">Appearance of the in-meeting overlay bar.</p>
</div>

<div class="set-card">
  <div class="set-card-head">
    <div class="set-card-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="6" rx="2"/><path d="M3 15h18" opacity="0.5"/></svg>
    </div>
    <div>
      <div class="set-card-title">Background opacity</div>
      <div class="set-card-desc">Lower it to see through the overlay to whatever's behind it.</div>
    </div>
  </div>

  <div class="set-field">
    <div class="op-row">
      <input type="range" class="op-slider" min="0.5" max="1" step="0.02" bind:value={opacity} />
      <span class="op-val">{Math.round(opacity * 100)}%</span>
    </div>
    <div class="op-preview" style="--a:{opacity};"><span>Overlay preview</span></div>
  </div>

  <div class="set-actions">
    <button class="set-btn" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
  </div>

  {#if msg}<div class="set-msg" class:ok={msg.ok} class:err={!msg.ok}>{msg.text}</div>{/if}
</div>

<style>
  .op-row { display: flex; align-items: center; gap: 14px; }
  .op-slider { flex: 1; accent-color: var(--accent); cursor: pointer; }
  .op-val {
    font-family: var(--font-mono); font-size: 13px; font-weight: 500;
    color: var(--text-primary); min-width: 44px; text-align: right;
  }
  .op-preview {
    margin-top: 14px; height: 54px; border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background:
      linear-gradient(rgba(15,17,23,var(--a)), rgba(15,17,23,var(--a))),
      repeating-conic-gradient(var(--bg-tertiary) 0% 25%, var(--bg-primary) 0% 50%) 50% / 18px 18px;
    display: flex; align-items: center; justify-content: center;
  }
  .op-preview span { font-size: 12px; color: var(--text-secondary); }
</style>
