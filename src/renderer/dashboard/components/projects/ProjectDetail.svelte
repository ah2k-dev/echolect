<script lang="ts">
  import type { Project, Meeting } from '$shared/types/ipc.js';
  import MarkdownEditor from '../MarkdownEditor.svelte';

  interface Props {
    projectId: string;
    onBack: () => void;
    onSelectMeeting: (id: string) => void;
    onStartMeeting: (projectId: string) => void;
    tab?: 'context' | 'meetings';
  }
  let { projectId, onBack, onSelectMeeting, onStartMeeting, tab = $bindable('context') }: Props = $props();

  let project = $state<Project | null>(null);
  let meetings = $state<Meeting[]>([]);
  let contextPath = $state('');
  let editing = $state(false);
  let editName = $state('');
  let editDescription = $state('');
  let editCodebasePath = $state('');
  let meetingQuery = $state('');

  const filteredMeetings = $derived(
    meetingQuery.trim()
      ? meetings.filter((m) => m.title.toLowerCase().includes(meetingQuery.trim().toLowerCase()))
      : meetings,
  );

  async function load() {
    project = (await window.electronAPI.invoke('projects:get', projectId)) as Project;
    meetings = (await window.electronAPI.invoke('meetings:list', { project_id: projectId })) as Meeting[];
    if (project) {
      const baseDir = (await window.electronAPI.invoke('fs:get-base-dir')) as string;
      const sep = baseDir.includes('\\') ? '\\' : '/';
      contextPath = baseDir + sep + project.name + sep + 'context.md';
    }
  }

  function startEdit() {
    if (!project) return;
    editName = project.name; editDescription = project.description; editCodebasePath = project.codebase_path;
    editing = true;
  }
  async function saveEdit() {
    if (!editName.trim()) return;
    await window.electronAPI.invoke('projects:update', projectId, {
      name: editName.trim(), description: editDescription.trim(), codebase_path: editCodebasePath.trim(),
    });
    editing = false; await load();
  }
  async function pickDirectory() {
    const dir = (await window.electronAPI.invoke('dialog:select-directory')) as string | null;
    if (dir) editCodebasePath = dir;
  }
  async function deleteProject() {
    if (!confirm('Delete this project and all its meetings? This cannot be undone.')) return;
    await window.electronAPI.invoke('projects:delete', projectId);
    onBack();
  }
  function formatDate(iso: string): string {
    return new Date(iso + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function statusInfo(s: string) {
    if (s === 'active') return { cls: 'live', label: 'Live' };
    if (s === 'completed') return { cls: 'rec', label: 'Recorded' };
    return { cls: 'draft', label: 'Draft' };
  }
  const TINTS = ['iris', 'teal', 'gold'];
  function tint(name: string): string { let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0; return TINTS[h % TINTS.length]; }
  const displayName = (n: string) => (n.startsWith('Untitled ') ? 'Untitled' : n);

  load();
</script>

<button class="back" onclick={onBack}>
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
  Projects
</button>

{#if project}
  {#if editing}
    <div class="card">
      <form onsubmit={(e) => { e.preventDefault(); saveEdit(); }}>
        <h2 class="ctitle">Edit Project</h2>
        <div class="frow"><label class="ffield"><span class="flabel">Name</span><input type="text" class="finput" bind:value={editName} required /></label></div>
        <div class="frow"><label class="ffield"><span class="flabel">Description</span><textarea class="finput ftext" bind:value={editDescription} rows="2"></textarea></label></div>
        <div class="frow"><div class="ffield"><span class="flabel">Codebase Path</span><div class="prow"><input type="text" class="finput pinput" bind:value={editCodebasePath} readonly /><button type="button" class="btn-g" onclick={pickDirectory}>Browse</button></div></div></div>
        <div class="factions"><button type="button" class="btn-g" onclick={() => (editing = false)}>Cancel</button><button type="submit" class="btn-i">Save Changes</button></div>
      </form>
    </div>
  {:else}
    <div class="hero">
      <div class="mono-tile mt-{tint(project.name)}">{displayName(project.name).charAt(0).toUpperCase()}</div>
      <div class="hinfo">
        <h1>{displayName(project.name)}</h1>
        {#if project.description}<p>{project.description}</p>{/if}
      </div>
      <div class="hactions">
        <button class="btn-start" onclick={() => onStartMeeting(projectId)} title="Start Meeting" aria-label="Start Meeting">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </button>
        <button class="btn-g icon" onclick={startEdit} aria-label="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
        </button>
        <button class="btn-d" onclick={deleteProject} aria-label="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
    <div class="meta">
      {#if project.codebase_path}<span class="chip mono">{project.codebase_path}</span>{/if}
      <span class="chip mono">Created {formatDate(project.created_at)}</span>
    </div>
  {/if}

  <div class="tabs">
    <button class:on={tab === 'context'} onclick={() => tab = 'context'}>Context</button>
    <button class:on={tab === 'meetings'} onclick={() => tab = 'meetings'}>Meetings <span class="tc">{meetings.length}</span></button>
  </div>

  {#if tab === 'context'}
    {#if contextPath}<MarkdownEditor filePath={contextPath} label="Context" />{/if}
  {:else}
    {#if meetings.length === 0}
      <div class="empty-inline">No meetings under this project yet. Hit <b>Start Meeting</b> to begin.</div>
    {:else}
      <div class="msearch">
        <span class="sic"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
        <input bind:value={meetingQuery} type="text" placeholder="Search meetings…" spellcheck="false" />
      </div>
      {#if filteredMeetings.length === 0}
        <div class="empty-inline">No meetings match “{meetingQuery.trim()}”.</div>
      {:else}
        <div class="mgrid">
          {#each filteredMeetings as m (m.id)}
            {@const st = statusInfo(m.status)}
            <button class="mrow" onclick={() => onSelectMeeting(m.id)}>
              <span class="dot {st.cls}"></span>
              <div class="mrinfo"><div class="mrtitle">{m.title}</div><div class="mrwhen mono">{formatDate(m.created_at)}</div></div>
              <span class="pill {st.cls}">{st.label}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
{/if}

<style>
  .back { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-tertiary); margin-bottom: 22px; transition: color var(--transition); }
  .back:hover { color: var(--accent); }

  .hero { display: flex; align-items: center; gap: 15px; margin-bottom: 12px; }
  .mono-tile { width: 48px; height: 48px; border-radius: 13px; display: flex; align-items: center; justify-content: center; font-family: var(--font-display); font-weight: 700; font-size: 21px; flex-shrink: 0; border: 1px solid var(--border); }
  .mt-iris { background: linear-gradient(150deg, var(--accent-soft), transparent); color: var(--text-accent); }
  .mt-teal { background: linear-gradient(150deg, var(--teal-soft), transparent); color: var(--teal); }
  .mt-gold { background: linear-gradient(150deg, var(--gold-soft), transparent); color: var(--gold); }
  .hinfo { flex: 1; min-width: 0; }
  .hinfo h1 { font-family: var(--font-display); font-weight: 700; font-size: 24px; letter-spacing: -0.02em; color: var(--text-primary); }
  .hinfo p { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }
  .hactions { display: flex; gap: 7px; flex-shrink: 0; }

  .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 26px; padding-left: 63px; }
  .chip { display: inline-flex; align-items: center; padding: 4px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 20px; font-size: 11px; color: var(--text-tertiary); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mono { font-family: var(--font-mono); }

  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 22px; }
  .tabs button { position: relative; padding: 9px 14px 13px; font-size: 13.5px; font-weight: 500; color: var(--text-secondary); transition: color var(--transition); }
  .tabs button:hover { color: var(--text-primary); }
  .tabs button.on { color: var(--accent); }
  .tabs button.on::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; background: var(--accent); border-radius: 2px; }
  .tc { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); background: var(--bg-tertiary); padding: 1px 6px; border-radius: 10px; margin-left: 2px; }

  .empty-inline { padding: 28px; text-align: center; color: var(--text-tertiary); font-size: 13px; background: var(--bg-secondary); border: 1px dashed var(--border); border-radius: var(--radius-md); }

  .msearch { position: relative; margin-bottom: 12px; }
  .msearch .sic { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--text-tertiary); pointer-events: none; display: flex; }
  .msearch input { width: 100%; height: 40px; padding: 0 14px 0 38px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); font-size: 13px; color: var(--text-primary); outline: none; transition: border-color var(--transition), box-shadow var(--transition); }
  .msearch input::placeholder { color: var(--text-tertiary); }
  .msearch input:focus { border-color: var(--border-focus); box-shadow: 0 0 0 3px var(--accent-soft); }

  .mgrid { display: flex; flex-direction: column; gap: 5px; }
  .mrow { display: flex; align-items: center; gap: 13px; padding: 13px 15px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); transition: all var(--transition); text-align: left; }
  .mrow:hover { border-color: var(--border-focus); background: var(--bg-tertiary); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-tertiary); }
  .dot.live { background: var(--red); box-shadow: 0 0 0 3px var(--red-soft); }
  .dot.rec { background: var(--green); }
  .mrinfo { flex: 1; min-width: 0; }
  .mrtitle { font-size: 13.5px; font-weight: 500; color: var(--text-primary); }
  .mrwhen { font-size: 11px; color: var(--text-tertiary); margin-top: 1px; }
  .pill { font-family: var(--font-mono); font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; padding: 4px 9px; border-radius: 20px; flex-shrink: 0; }
  .pill.live { color: var(--red); background: var(--red-soft); } .pill.rec { color: var(--green); background: var(--green-soft); } .pill.draft { color: var(--text-tertiary); background: var(--bg-tertiary); }

  /* buttons + form */
  .btn-i { display: inline-flex; align-items: center; gap: 6px; padding: 8px 15px; background: var(--accent); color: #15102a; border-radius: var(--radius-sm); font-size: 12.5px; font-weight: 600; transition: all var(--transition); }
  .btn-i:hover { background: var(--accent-hover); }
  .btn-start { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; background: var(--accent); color: #15102a; border-color: transparent; border-radius: var(--radius-sm); box-shadow: 0 5px 16px rgba(139, 124, 246, 0.22); transition: all var(--transition); }
  .btn-start:hover { background: var(--accent-hover); }
  .btn-g { display: inline-flex; align-items: center; gap: 5px; padding: 8px 13px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12.5px; font-weight: 500; color: var(--text-secondary); transition: all var(--transition); }
  .btn-g:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-g.icon { width: 34px; padding: 0; justify-content: center; }
  .btn-d { display: inline-flex; align-items: center; justify-content: center; width: 34px; padding: 0; background: var(--red-soft); border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--red); transition: all var(--transition); }
  .btn-d:hover { background: var(--red); color: #fff; }
  .card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 20px; margin-bottom: 22px; }
  .ctitle { font-family: var(--font-display); font-size: 15px; font-weight: 600; color: var(--text-primary); margin-bottom: 16px; }
  .frow { margin-bottom: 14px; } .ffield { display: flex; flex-direction: column; gap: 5px; }
  .flabel { font-size: 12px; font-weight: 500; color: var(--text-secondary); }
  .finput { padding: 9px 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-primary); outline: none; transition: border-color var(--transition); width: 100%; }
  .finput:focus { border-color: var(--border-focus); }
  .ftext { resize: vertical; min-height: 44px; } .prow { display: flex; gap: 8px; } .pinput { flex: 1; cursor: default; }
  .factions { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
</style>
