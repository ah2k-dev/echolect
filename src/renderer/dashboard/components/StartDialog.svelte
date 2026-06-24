<script lang="ts">
  import type { Project } from '$shared/types/ipc.js';

  interface Props {
    projects: Project[];
    onPick: (projectId: string) => void;
    onNew: () => void;
    onClose: () => void;
    busy?: boolean;
  }
  let { projects, onPick, onNew, onClose, busy = false }: Props = $props();

  let query = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);

  const displayName = (n: string) => (n.startsWith('Untitled ') ? 'Untitled' : n);
  const filtered = $derived(
    query.trim()
      ? projects.filter(p => displayName(p.name).toLowerCase().includes(query.trim().toLowerCase()))
      : projects
  );

  const TINTS = ['iris', 'teal', 'gold'];
  function tint(name: string): string { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return TINTS[h % TINTS.length]; }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered.length > 0) onPick(filtered[0].id);
      else onNew();
    }
  }

  $effect(() => { inputEl?.focus(); });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="dialog">
    <div class="dhead">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input
        bind:this={inputEl}
        class="dinput"
        placeholder="Search a project, or start fresh…"
        bind:value={query}
        onkeydown={onKeydown}
        disabled={busy}
      />
    </div>

    <div class="dlist">
      {#each filtered as p (p.id)}
        <button class="ditem" onclick={() => onPick(p.id)} disabled={busy}>
          <span class="mono-tile mt-{tint(p.name)}">{displayName(p.name).charAt(0).toUpperCase()}</span>
          <span class="dname">{displayName(p.name)}</span>
          <span class="denter">↵</span>
        </button>
      {/each}
      {#if filtered.length === 0}
        <div class="dnone">No matching project</div>
      {/if}
    </div>

    <button class="dnew" onclick={onNew} disabled={busy}>
      <span class="plus">+</span>
      {busy ? 'Starting…' : 'Start a new project'}
      <span class="dhint">no name needed — you'll name it after</span>
    </button>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(10, 8, 5, 0.55); backdrop-filter: blur(5px); display: flex; align-items: flex-start; justify-content: center; padding-top: 14vh; z-index: 1000; animation: fade 0.14s ease-out; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .dialog { width: 460px; max-width: 92vw; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); overflow: hidden; animation: pop 0.16s cubic-bezier(0.4,0,0.2,1); }
  @keyframes pop { from { opacity: 0; transform: scale(0.97) translateY(-6px); } to { opacity: 1; transform: scale(1) translateY(0); } }

  .dhead { display: flex; align-items: center; gap: 11px; padding: 15px 17px; border-bottom: 1px solid var(--border); color: var(--text-tertiary); }
  .dinput { flex: 1; background: none; border: none; outline: none; font-family: var(--font-sans); font-size: 14.5px; color: var(--text-primary); }
  .dinput::placeholder { color: var(--text-tertiary); }

  .dlist { max-height: 280px; overflow-y: auto; padding: 6px; }
  .ditem { display: flex; align-items: center; gap: 11px; width: 100%; padding: 9px 11px; border-radius: var(--radius-sm); text-align: left; transition: background var(--transition); }
  .ditem:hover { background: var(--bg-hover); }
  .ditem:first-child .denter { opacity: 0.7; }
  .mono-tile { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-family: var(--font-display); font-weight: 700; font-size: 13px; flex-shrink: 0; border: 1px solid var(--border); }
  .mt-iris { background: linear-gradient(150deg, var(--accent-soft), transparent); color: var(--text-accent); }
  .mt-teal { background: linear-gradient(150deg, var(--teal-soft), transparent); color: var(--teal); }
  .mt-gold { background: linear-gradient(150deg, var(--gold-soft), transparent); color: var(--gold); }
  .dname { flex: 1; font-size: 13.5px; font-weight: 500; color: var(--text-primary); }
  .denter { font-family: var(--font-mono); font-size: 12px; color: var(--text-tertiary); opacity: 0; }
  .ditem:hover .denter { opacity: 0.8; }
  .dnone { padding: 18px; text-align: center; font-size: 12.5px; color: var(--text-tertiary); }

  .dnew { display: flex; align-items: center; gap: 9px; width: 100%; padding: 13px 17px; border-top: 1px solid var(--border); font-size: 13.5px; font-weight: 600; color: var(--accent); transition: background var(--transition); }
  .dnew:hover { background: var(--accent-soft); }
  .plus { font-size: 17px; line-height: 1; }
  .dhint { margin-left: auto; font-weight: 400; font-size: 11px; color: var(--text-tertiary); }
</style>
