<script lang="ts">
  import type { Project, Meeting } from '$shared/types/ipc.js';
  import Modal from '../Modal.svelte';

  interface Props { onSelect: (id: string) => void; onStart: () => void; }
  let { onSelect, onStart }: Props = $props();

  let projects = $state<Project[]>([]);
  let counts = $state<Record<string, number>>({});
  let showModal = $state(false);
  let formName = $state('');
  let formDescription = $state('');
  let formCodebasePath = $state('');
  let loading = $state(true);

  async function loadProjects() {
    loading = true;
    projects = (await window.electronAPI.invoke('projects:list')) as Project[];
    const all = (await window.electronAPI.invoke('meetings:list')) as Meeting[];
    const c: Record<string, number> = {};
    for (const m of all) if (m.project_id) c[m.project_id] = (c[m.project_id] ?? 0) + 1;
    counts = c;
    loading = false;
  }

  async function createProject() {
    if (!formName.trim()) return;
    await window.electronAPI.invoke('projects:create', {
      name: formName.trim(),
      description: formDescription.trim(),
      codebase_path: formCodebasePath.trim(),
    });
    formName = ''; formDescription = ''; formCodebasePath = '';
    showModal = false;
    await loadProjects();
  }

  function openModal() { formName = ''; formDescription = ''; formCodebasePath = ''; showModal = true; }

  async function pickDirectory() {
    const dir = (await window.electronAPI.invoke('dialog:select-directory')) as string | null;
    if (dir) formCodebasePath = dir;
  }

  function formatDate(iso: string): string {
    return new Date(iso + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  const TINTS = ['iris', 'teal', 'gold'];
  function tint(name: string): string {
    let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return TINTS[h % TINTS.length];
  }
  const displayName = (n: string) => (n.startsWith('Untitled ') ? 'Untitled' : n);

  loadProjects();
</script>

<Modal title="Create Project" open={showModal} onClose={() => (showModal = false)}>
  <form onsubmit={(e) => { e.preventDefault(); createProject(); }}>
    <div class="form-row"><label class="form-field">
      <span class="form-label">Project Name</span>
      <input type="text" class="form-input" bind:value={formName} placeholder="e.g. Acme Corp" required />
    </label></div>
    <div class="form-row"><label class="form-field">
      <span class="form-label">Description <span class="optional">optional</span></span>
      <textarea class="form-input form-textarea" bind:value={formDescription} placeholder="Brief project description…" rows="3"></textarea>
    </label></div>
    <div class="form-row"><div class="form-field">
      <span class="form-label">Codebase Path <span class="optional">optional</span></span>
      <div class="path-row">
        <input type="text" class="form-input path-input" bind:value={formCodebasePath} placeholder="Select a directory…" readonly />
        <button type="button" class="btn-browse" onclick={pickDirectory}>Browse</button>
      </div>
    </div></div>
    <div class="form-footer">
      <button type="button" class="btn-ghost" onclick={() => (showModal = false)}>Cancel</button>
      <button type="submit" class="btn-submit">Create Project</button>
    </div>
  </form>
</Modal>

{#if loading}
  <div class="empty">Loading…</div>
{:else if projects.length === 0}
  <div class="welcome">
    <div class="welcome-ic">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
    </div>
    <h2>Welcome to Echolect</h2>
    <p>Start a meeting to transcribe it live and get AI help in the moment — or create a project to group related meetings and build shared context over time.</p>
    <div class="welcome-actions">
      <button class="wc-start" onclick={onStart}>Start a meeting</button>
      <button class="wc-new" onclick={openModal}>New project</button>
    </div>
  </div>
{:else}
  <div class="grid">
    <button class="pcard addcard" onclick={openModal}>
      <div class="add-ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></div>
      <span class="add-tx">New project</span>
    </button>
    {#each projects as p, i (p.id)}
      <button class="pcard" style="animation-delay:{i * 40}ms" onclick={() => onSelect(p.id)}>
        <div class="pc-top">
          <div class="mono-tile mt-{tint(p.name)}">{displayName(p.name).charAt(0).toUpperCase()}</div>
          <div class="nm">
            <h3>{displayName(p.name)}</h3>
            <div class="sub">{counts[p.id] ?? 0} meeting{(counts[p.id] ?? 0) !== 1 ? 's' : ''}</div>
          </div>
        </div>
        {#if p.description}<div class="pc-desc">{p.description}</div>{/if}
        <div class="pc-foot">
          {#if p.codebase_path}
            <span class="codetag" title={p.codebase_path}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
              {p.codebase_path.split(/[/\\]/).pop()}
            </span>
          {/if}
          <span class="date">{formatDate(p.created_at)}</span>
          <span class="wave">{#each [40, 90, 55, 100, 60] as h}<i style="height:{h}%"></i>{/each}</span>
        </div>
      </button>
    {/each}
  </div>
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px; }

  .addcard { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 11px; border-style: dashed; background: transparent; color: var(--text-tertiary); }
  .addcard:hover { border-color: var(--border-focus); background: var(--accent-soft); color: var(--accent); transform: translateY(-3px); box-shadow: none; }
  .add-ic { width: 42px; height: 42px; border-radius: 12px; border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; transition: border-color var(--transition); }
  .addcard:hover .add-ic { border-color: var(--border-focus); }
  .add-tx { font-family: var(--font-display); font-weight: 600; font-size: 14px; }
  .pcard {
    text-align: left; border: 1px solid var(--border); border-radius: 16px; padding: 18px;
    background: linear-gradient(180deg, rgba(255,255,255,0.018), transparent), var(--bg-secondary);
    transition: all 0.17s; cursor: pointer; animation: fadeUp 0.25s ease-out both;
  }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }
  .pcard:hover { border-color: var(--border-focus); transform: translateY(-3px); box-shadow: 0 14px 38px rgba(0,0,0,.35), 0 0 0 1px var(--accent-soft); }

  .pc-top { display: flex; align-items: center; gap: 13px; margin-bottom: 14px; }
  .mono-tile { width: 42px; height: 42px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-family: var(--font-display); font-weight: 700; font-size: 18px; flex-shrink: 0; border: 1px solid var(--border); }
  .mt-iris { background: linear-gradient(150deg, var(--accent-soft), transparent); color: var(--text-accent); }
  .mt-teal { background: linear-gradient(150deg, var(--teal-soft), transparent); color: var(--teal); }
  .mt-gold { background: linear-gradient(150deg, var(--gold-soft), transparent); color: var(--gold); }
  .nm { min-width: 0; flex: 1; }
  .nm h3 { font-family: var(--font-display); font-weight: 600; font-size: 16px; letter-spacing: -0.01em; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nm .sub { font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); margin-top: 3px; }

  .pc-desc { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 14px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 18px; }

  .pc-foot { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); }
  .codetag { display: inline-flex; align-items: center; gap: 5px; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .date { color: var(--text-tertiary); }
  .wave { display: flex; gap: 2px; align-items: flex-end; height: 15px; margin-left: auto; }
  .wave i { width: 2.5px; border-radius: 1px; background: var(--accent); opacity: 0.5; }

  .empty { display: flex; flex-direction: column; align-items: center; padding: 80px 0; color: var(--text-tertiary); }

  /* First-run / no-projects welcome */
  .welcome { display: flex; flex-direction: column; align-items: center; text-align: center; max-width: 470px; margin: 24px auto 0; padding: 40px 24px; }
  .welcome-ic { width: 56px; height: 56px; border-radius: 16px; display: flex; align-items: center; justify-content: center; color: var(--accent); background: var(--accent-soft); border: 1px solid var(--border); margin-bottom: 18px; }
  .welcome h2 { font-family: var(--font-display); font-weight: 700; font-size: 21px; letter-spacing: -0.02em; color: var(--text-primary); margin-bottom: 10px; }
  .welcome p { font-size: 13.5px; line-height: 1.6; color: var(--text-tertiary); margin-bottom: 24px; }
  .welcome-actions { display: flex; gap: 10px; }
  .wc-start { padding: 10px 20px; background: var(--accent); color: #15102a; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600; transition: all var(--transition); }
  .wc-start:hover { background: var(--accent-hover); }
  .wc-new { padding: 10px 18px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; color: var(--text-secondary); transition: all var(--transition); }
  .wc-new:hover { background: var(--bg-hover); color: var(--text-primary); }

  /* modal form */
  .form-row { margin-bottom: 16px; }
  .form-field { display: flex; flex-direction: column; gap: 6px; }
  .form-label { font-size: 12px; font-weight: 500; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
  .optional { font-weight: 400; color: var(--text-tertiary); font-size: 11px; }
  .form-input { padding: 10px 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-primary); outline: none; transition: border-color var(--transition); width: 100%; }
  .form-input:focus { border-color: var(--border-focus); }
  .form-input::placeholder { color: var(--text-tertiary); }
  .form-textarea { resize: vertical; min-height: 48px; }
  .path-row { display: flex; gap: 8px; }
  .path-input { flex: 1; cursor: default; }
  .btn-browse { padding: 10px 14px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12px; font-weight: 500; color: var(--text-secondary); transition: all var(--transition); white-space: nowrap; }
  .btn-browse:hover { background: var(--bg-hover); color: var(--text-primary); }
  .form-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
  .btn-ghost { padding: 9px 16px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; color: var(--text-secondary); transition: all var(--transition); }
  .btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-submit { padding: 9px 20px; background: var(--accent); color: #15102a; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600; transition: all var(--transition); }
  .btn-submit:hover { background: var(--accent-hover); }
</style>
