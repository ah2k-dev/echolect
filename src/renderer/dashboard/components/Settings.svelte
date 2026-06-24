<script lang="ts">
  import SettingsAi from './settings/SettingsAi.svelte';
  import SettingsHotkeys from './settings/SettingsHotkeys.svelte';
  import SettingsPrompts from './settings/SettingsPrompts.svelte';
  import SettingsOverlay from './settings/SettingsOverlay.svelte';

  type Tab = 'ai' | 'hotkeys' | 'prompts' | 'overlay';

  interface Props { onBack: () => void; }
  let { onBack }: Props = $props();

  let tab = $state<Tab>('ai');
  let promptTarget = $state<string | null>(null);

  const tabs: { id: Tab; label: string }[] = [
    { id: 'ai', label: 'AI' },
    { id: 'hotkeys', label: 'Hot Keys' },
    { id: 'prompts', label: 'Prompts' },
    { id: 'overlay', label: 'Overlay' },
  ];

  function go(id: Tab) {
    tab = id;
    if (id !== 'prompts') promptTarget = null;
  }

  function configurePrompt(key: string) {
    promptTarget = key;
    tab = 'prompts';
  }
</script>

<div class="settings">
  <button class="back" onclick={onBack}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
    Back
  </button>
  <h1 class="stitle">Settings</h1>
  <div class="tabbar">
    {#each tabs as t}
      <button class="tab" class:active={tab === t.id} onclick={() => go(t.id)}>{t.label}</button>
    {/each}
  </div>

  <div class="panel">
    {#if tab === 'ai'}
      <SettingsAi />
    {:else if tab === 'hotkeys'}
      <SettingsHotkeys onConfigure={configurePrompt} />
    {:else if tab === 'prompts'}
      {#key promptTarget}
        <SettingsPrompts target={promptTarget} />
      {/key}
    {:else if tab === 'overlay'}
      <SettingsOverlay />
    {/if}
  </div>
</div>

<style>
  .settings {
    max-width: 840px;
    margin: 0 auto;
  }

  .back { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-tertiary); margin-bottom: 18px; transition: color var(--transition); }
  .back:hover { color: var(--accent); }
  .stitle { font-family: var(--font-display); font-weight: 700; font-size: 22px; letter-spacing: -0.02em; color: var(--text-primary); margin-bottom: 20px; }

  .tabbar {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 28px;
  }

  .tab {
    position: relative;
    padding: 10px 16px 13px;
    font-size: 13.5px;
    font-weight: 500;
    color: var(--text-secondary);
    transition: color var(--transition);
  }
  .tab:hover { color: var(--text-primary); }
  .tab.active { color: var(--accent); }
  .tab.active::after {
    content: '';
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: -1px;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--accent);
  }

  .panel {
    padding-bottom: 40px;
  }
</style>
