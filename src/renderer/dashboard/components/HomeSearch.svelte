<script lang="ts">
  import type { Project, Meeting } from '$shared/types/ipc.js';

  interface Props {
    onSelectProject: (id: string) => void;
    onSelectMeeting: (m: Meeting) => void;
  }
  let { onSelectProject, onSelectMeeting }: Props = $props();

  let projects = $state<Project[]>([]);
  let meetings = $state<Meeting[]>([]);
  let query = $state('');
  let open = $state(false);
  let active = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);

  const displayName = (n: string) => (n.startsWith('Untitled ') ? 'Untitled' : n);

  async function load() {
    projects = (await window.electronAPI.invoke('projects:list')) as Project[];
    meetings = (await window.electronAPI.invoke('meetings:list')) as Meeting[];
  }
  load();

  function projectName(id: string | null): string {
    const p = projects.find((x) => x.id === id);
    return p ? displayName(p.name) : 'Project';
  }

  type Row =
    | { kind: 'project'; id: string; label: string }
    | { kind: 'meeting'; meeting: Meeting; label: string; sub: string };

  const results = $derived.by<Row[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const pr: Row[] = projects
      .filter((p) => displayName(p.name).toLowerCase().includes(q))
      .slice(0, 5)
      .map((p) => ({ kind: 'project', id: p.id, label: displayName(p.name) }));
    const mt: Row[] = meetings
      .filter((m) => m.title.toLowerCase().includes(q))
      .slice(0, 6)
      .map((m) => ({ kind: 'meeting', meeting: m, label: m.title, sub: projectName(m.project_id) }));
    return [...pr, ...mt];
  });

  // reset highlight whenever the query changes
  $effect(() => {
    query;
    active = 0;
  });

  function choose(row: Row) {
    if (row.kind === 'project') onSelectProject(row.id);
    else onSelectMeeting(row.meeting);
    query = '';
    open = false;
    inputEl?.blur();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open = true;
      active = Math.min(active + 1, results.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (e.key === 'Enter') {
      if (results[active]) choose(results[active]);
    } else if (e.key === 'Escape') {
      open = false;
      inputEl?.blur();
    }
  }
</script>

<div class="search">
  <span class="ic">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
  </span>
  <input
    bind:this={inputEl}
    bind:value={query}
    type="text"
    placeholder="Search projects and meetings…"
    spellcheck="false"
    onfocus={() => (open = true)}
    onblur={() => setTimeout(() => (open = false), 120)}
    onkeydown={onKey}
  />

  {#if open && results.length > 0}
    <div class="drop">
      {#each results as row, i (row.kind === 'project' ? 'p' + row.id : 'm' + row.meeting.id)}
        <button
          class="row"
          class:active={i === active}
          onmouseenter={() => (active = i)}
          onmousedown={(e) => { e.preventDefault(); choose(row); }}
        >
          {#if row.kind === 'project'}
            <span class="rico p"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>
            <span class="rlabel">{row.label}</span>
            <span class="rtag">Project</span>
          {:else}
            <span class="rico m"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></span>
            <span class="rlabel">{row.label}<span class="rsub">in {row.sub}</span></span>
            <span class="rtag">Meeting</span>
          {/if}
        </button>
      {/each}
    </div>
  {:else if open && query.trim()}
    <div class="drop"><div class="none">No matches</div></div>
  {/if}
</div>

<style>
  .search { position: relative; width: 100%; max-width: 460px; margin-top: 22px; }
  .ic { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--text-tertiary); pointer-events: none; display: flex; }
  input {
    width: 100%; height: 44px; padding: 0 16px 0 42px;
    background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 12px;
    font-size: 14px; color: var(--text-primary); outline: none; transition: border-color var(--transition), box-shadow var(--transition);
  }
  input::placeholder { color: var(--text-tertiary); }
  input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-soft); }

  .drop {
    position: absolute; top: calc(100% + 8px); left: 0; right: 0; z-index: 20;
    background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 12px;
    padding: 6px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.42); overflow: hidden;
  }
  .row {
    display: flex; align-items: center; gap: 11px; width: 100%; padding: 9px 10px;
    border-radius: 8px; text-align: left; transition: background var(--transition);
  }
  .row.active { background: var(--accent-soft); }
  .rico { width: 28px; height: 28px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid var(--border); }
  .rico.p { color: var(--text-accent); background: linear-gradient(150deg, var(--accent-soft), transparent); }
  .rico.m { color: var(--teal); background: linear-gradient(150deg, var(--teal-soft), transparent); }
  .rlabel { flex: 1; min-width: 0; font-size: 13.5px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rsub { color: var(--text-tertiary); font-size: 12px; margin-left: 7px; }
  .rtag { flex-shrink: 0; font-family: var(--font-mono); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-tertiary); background: var(--bg-tertiary); padding: 3px 7px; border-radius: 20px; }
  .none { padding: 14px; text-align: center; font-size: 13px; color: var(--text-tertiary); }
</style>
