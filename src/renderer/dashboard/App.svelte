<script lang="ts">
  import type { Meeting, Project } from '$shared/types/ipc.js';
  import logoMark from '$shared/assets/logo-mark.png';
  import StartDialog from './components/StartDialog.svelte';
  import HomeSearch from './components/HomeSearch.svelte';
  import Modal from './components/Modal.svelte';
  import ProjectList from './components/projects/ProjectList.svelte';
  import ProjectDetail from './components/projects/ProjectDetail.svelte';
  import MeetingDetail from './components/meetings/MeetingDetail.svelte';
  import Settings from './components/Settings.svelte';

  type View = 'projects' | 'settings';
  let view = $state<View>('projects');
  let selectedProjectId = $state<string | null>(null);
  let selectedMeetingId = $state<string | null>(null);
  let projectTab = $state<'context' | 'meetings'>('context');
  let listKey = $state(0);
  let detailKey = $state(0);
  let starting = $state(false);
  let showStart = $state(false);
  let startProjects = $state<Project[]>([]);

  // Startup health-check: surface up-front anything that would silently break a meeting —
  // no Deepgram key → no transcript at all; missing provider CLI → no live assist / summaries.
  type HealthIssue = { id: string; msg: string };
  let healthIssues = $state<HealthIssue[]>([]);
  let dismissedHealth = $state<Record<string, boolean>>({});
  function dismissHealth(id: string) { dismissedHealth = { ...dismissedHealth, [id]: true }; }
  function openSettingsFrom(id: string) {
    view = 'settings'; selectedProjectId = null; selectedMeetingId = null; dismissHealth(id);
  }
  (async () => {
    const issues: HealthIssue[] = [];
    const dgKey = (await window.electronAPI.invoke('settings:get', 'deepgram_api_key')) as string | undefined;
    if (!dgKey?.trim()) {
      issues.push({ id: 'stt', msg: 'No Deepgram API key — transcription is disabled. Add one in Settings.' });
    }
    // Either provider works, so only alarm about the LLM when NEITHER is available. If the
    // selected one is missing but the other is present, suggest switching rather than blocking.
    const det = await window.electronAPI.invoke('providers:detect') as { claude: boolean; codex: boolean };
    const active = (await window.electronAPI.invoke('settings:get', 'llm_provider')) === 'codex' ? 'codex' : 'claude';
    const activeName = active === 'codex' ? 'Codex' : 'Claude';
    const otherName = active === 'codex' ? 'Claude' : 'Codex';
    if (!det.claude && !det.codex) {
      issues.push({ id: 'llm', msg: 'Neither the Claude nor the Codex CLI was detected — live assist, research, screenshots and summaries are disabled. Install one, or set its path in Settings.' });
    } else if (!det[active]) {
      issues.push({ id: 'llm', msg: `${activeName} (your selected provider) wasn't detected, but ${otherName} is available — switch provider in Settings, or set ${activeName}'s path.` });
    }
    healthIssues = issues;
  })();

  // Global "name your new project" prompt — fires wherever you are when a meeting ends
  let showNameProject = $state(false);
  let nameProjectId = $state<string | null>(null);
  let nameProjectVal = $state('');

  window.electronAPI.on('meeting:summary-ready', (_id: unknown, projectName: unknown, projectId: unknown) => {
    if (projectName && projectId) {
      nameProjectId = projectId as string;
      nameProjectVal = projectName as string;
      showNameProject = true;
    }
  });

  async function saveProjectName() {
    if (nameProjectVal.trim() && nameProjectId) {
      await window.electronAPI.invoke('projects:update', nameProjectId, { name: nameProjectVal.trim() });
    }
    showNameProject = false;
    listKey++;
    detailKey++; // renamed folder → remount the open meeting detail so its file paths refresh
  }

  function goHome() {
    view = 'projects';
    selectedProjectId = null;
    selectedMeetingId = null;
  }

  function selectProject(id: string | null) {
    selectedProjectId = id;
    selectedMeetingId = null;
    projectTab = 'context';
  }

  // Jump straight to a meeting (from search) — land back on its project's Meetings tab
  function openMeeting(m: Meeting) {
    selectedProjectId = m.project_id;
    projectTab = 'meetings';
    selectedMeetingId = m.id;
  }

  function backToProjects() {
    selectedProjectId = null;
    selectedMeetingId = null;
    listKey++;
  }

  // Open the start dialog (search a project or start fresh)
  async function openStart() {
    startProjects = (await window.electronAPI.invoke('projects:list')) as Project[];
    showStart = true;
  }

  // Create + start a meeting in the given project
  async function createAndStart(projectId: string) {
    if (starting) return;
    starting = true;
    try {
      const title = 'Meeting - ' + new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      const meeting = (await window.electronAPI.invoke('meetings:create', {
        title, project_id: projectId,
      })) as Meeting;
      await window.electronAPI.invoke('meeting:start', meeting.id, { recordAudio: true, recordScreen: true });
      showStart = false;
      view = 'projects';
      selectedProjectId = projectId;
      selectedMeetingId = meeting.id;
    } finally {
      starting = false;
    }
  }

  // Start in a brand-new, unnamed project (named at the end of the meeting)
  async function startNewProject() {
    if (starting) return;
    const name = 'Untitled ' + Math.random().toString(36).slice(2, 6);
    const proj = (await window.electronAPI.invoke('projects:create', { name })) as Project;
    await createAndStart(proj.id);
  }
</script>

<div class="app">
  {#if showStart}
    <StartDialog
      projects={startProjects}
      onPick={createAndStart}
      onNew={startNewProject}
      onClose={() => (showStart = false)}
      {starting}
    />
  {/if}

  {#each healthIssues as issue (issue.id)}
    {#if !dismissedHealth[issue.id]}
      <div class="provider-banner">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>{issue.msg}</span>
        <button class="pb-link" onclick={() => openSettingsFrom(issue.id)}>Open Settings</button>
        <button class="pb-x" onclick={() => dismissHealth(issue.id)} title="Dismiss" aria-label="Dismiss">✕</button>
      </div>
    {/if}
  {/each}

  <main class="content">
    <div class="inner">
      {#if view === 'settings'}
        <Settings onBack={goHome} />
      {:else if selectedMeetingId}
        {#key detailKey}
          <MeetingDetail meetingId={selectedMeetingId} onBack={() => (selectedMeetingId = null)} />
        {/key}
      {:else if selectedProjectId}
        <ProjectDetail
          projectId={selectedProjectId}
          bind:tab={projectTab}
          onBack={backToProjects}
          onSelectMeeting={(id) => (selectedMeetingId = id)}
          onStartMeeting={createAndStart}
        />
      {:else}
        <header class="home">
          <div class="corner">
            <button class="ibtn start" onclick={openStart} disabled={starting} title="Start Meeting" aria-label="Start Meeting">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            </button>
            <button
              class="ibtn gear"
              onclick={() => { view = 'settings'; selectedProjectId = null; selectedMeetingId = null; }}
              title="Settings"
              aria-label="Settings"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </div>
          <div class="brand">
            <img src={logoMark} alt="Echolect" />
            <h1>Echolect</h1>
          </div>
          <HomeSearch onSelectProject={selectProject} onSelectMeeting={openMeeting} />
        </header>
        {#key listKey}
          <ProjectList onSelect={selectProject} onStart={openStart} />
        {/key}
      {/if}
    </div>
  </main>

  <footer class="app-footer">
    <button class="credit" title="ah2k.dev" onclick={() => window.electronAPI.invoke('shell:open-external', 'https://ah2k.dev')}>
      Created by <span class="credit-site">ah2k.dev</span>
    </button>
  </footer>
</div>

<Modal title="Name your project" open={showNameProject} onClose={() => (showNameProject = false)}>
  <form onsubmit={(e) => { e.preventDefault(); saveProjectName(); }}>
    <p class="np-note">A meeting just started a new project. Name it — the meeting title was set automatically.</p>
    <label class="np-field">
      <span class="np-label">Project name <span class="np-opt">AI-suggested</span></span>
      <input type="text" class="np-input" bind:value={nameProjectVal} />
    </label>
    <div class="np-actions">
      <button type="button" class="np-ghost" onclick={() => (showNameProject = false)}>Skip</button>
      <button type="submit" class="np-save">Save</button>
    </div>
  </form>
</Modal>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    background: var(--bg-primary);
    background-image: radial-gradient(820px 440px at 90% -10%, rgba(139, 124, 246, 0.07), transparent 60%);
  }
  .content { flex: 1; overflow-y: auto; overflow-x: hidden; }
  .inner { max-width: 1360px; margin: 0 auto; padding: 32px 24px 90px; }

  /* Startup provider health banner */
  .provider-banner {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 18px; font-size: 12.5px; color: #f0dca6; flex-shrink: 0;
    background: rgba(231, 178, 76, 0.12); border-bottom: 1px solid rgba(231, 178, 76, 0.3);
  }
  .provider-banner span { flex: 1; min-width: 0; }
  .pb-link {
    flex-shrink: 0; padding: 4px 11px; border-radius: 7px; font-size: 12px; font-weight: 600;
    color: #15102a; background: #E7B24C; transition: filter var(--transition);
  }
  .pb-link:hover { filter: brightness(1.08); }
  .pb-x { flex-shrink: 0; color: #f0dca6; font-size: 13px; padding: 2px 6px; opacity: 0.7; }
  .pb-x:hover { opacity: 1; }

  /* Home hero — centered logo near the top, action icons in the corner */
  .home { position: relative; display: flex; flex-direction: column; align-items: center; padding: 0 0 36px; }
  .home .brand { display: flex; align-items: center; gap: 12px; }
  .home .brand img { width: 34px; height: 34px; object-fit: contain; }
  .home .brand h1 { font-family: var(--font-display); font-weight: 700; font-size: 30px; letter-spacing: -0.03em; color: var(--text-primary); }

  /* Footer credit */
  .app-footer { flex-shrink: 0; display: flex; justify-content: center; padding: 10px 16px 18px; }
  .credit { font-size: 11px; color: var(--text-tertiary); letter-spacing: 0.01em; transition: color var(--transition); }
  .credit .credit-site { color: var(--text-secondary); font-weight: 500; }
  .credit:hover { color: var(--text-secondary); }
  .credit:hover .credit-site { color: var(--accent); }

  .home .corner { position: absolute; top: 6px; right: 0; display: flex; gap: 8px; }
  .ibtn {
    width: 36px; height: 36px; display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border); border-radius: 10px; color: var(--text-secondary);
    transition: all var(--transition);
  }
  .ibtn.gear:hover { color: var(--accent); border-color: var(--border-focus); background: var(--accent-soft); }
  .ibtn.start {
    background: var(--accent); color: #15102a; border-color: transparent;
    box-shadow: 0 6px 18px rgba(139, 124, 246, 0.24);
  }
  .ibtn.start:hover { background: var(--accent-hover); }
  .ibtn.start:disabled { opacity: 0.6; cursor: not-allowed; }

  .np-note { font-size: 12.5px; color: var(--text-tertiary); margin-bottom: 16px; line-height: 1.5; }
  .np-field { display: flex; flex-direction: column; gap: 6px; }
  .np-label { font-size: 12px; font-weight: 500; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }
  .np-opt { font-weight: 400; color: var(--accent); font-size: 11px; }
  .np-input { padding: 10px 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-primary); outline: none; transition: border-color var(--transition); width: 100%; }
  .np-input:focus { border-color: var(--border-focus); }
  .np-actions { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }
  .np-ghost { padding: 9px 16px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; color: var(--text-secondary); transition: all var(--transition); }
  .np-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
  .np-save { padding: 9px 20px; background: var(--accent); color: #15102a; border-radius: var(--radius-sm); font-size: 13px; font-weight: 600; transition: all var(--transition); }
  .np-save:hover { background: var(--accent-hover); }
</style>
