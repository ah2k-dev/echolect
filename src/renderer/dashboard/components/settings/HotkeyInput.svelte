<script lang="ts">
  // Reusable global-shortcut capture chip. Click to arm, press a combo to set.
  interface Props {
    value: string;
  }
  let { value = $bindable() }: Props = $props();

  let capturing = $state(false);
  let error = $state('');

  function display(accel: string): string {
    return accel
      .replace('CmdOrCtrl', 'Ctrl')
      .replace('CommandOrControl', 'Ctrl')
      .split('+');
  }

  function onKeydown(e: KeyboardEvent) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    const key = e.key;
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return;
    if (key === 'Escape') { capturing = false; error = ''; return; }

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('CmdOrCtrl');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    if (parts.length === 0) {
      error = 'Use at least one modifier (Ctrl / Shift / Alt)';
      return;
    }
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    value = parts.join('+');
    capturing = false;
    error = '';
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="wrap">
  <button
    type="button"
    class="chip"
    class:capturing
    onclick={() => { capturing = !capturing; error = ''; }}
    title={capturing ? 'Press a key combination — Esc to cancel' : 'Click to change shortcut'}
  >
    {#if capturing}
      <span class="pulse"></span>
      <span class="prompt">Press keys…</span>
    {:else if value}
      {#each display(value) as part}
        <kbd>{part}</kbd>
      {/each}
    {:else}
      <span class="prompt unset">Click to set</span>
    {/if}
  </button>
  {#if error}<span class="err">{error}</span>{/if}
</div>

<style>
  .wrap {
    display: inline-flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-start;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 34px;
    padding: 4px 10px;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
  }
  .chip:hover { border-color: var(--border-focus); }
  .chip.capturing {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  kbd {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    color: var(--text-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 5px;
    padding: 4px 7px;
  }

  .prompt {
    font-size: 12px;
    color: var(--accent);
    font-style: italic;
  }
  .prompt.unset {
    color: var(--text-tertiary);
    font-style: normal;
  }

  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 var(--accent-soft); }
    50% { opacity: 0.5; box-shadow: 0 0 0 4px transparent; }
  }

  .err {
    font-size: 11px;
    color: var(--red);
  }
</style>
