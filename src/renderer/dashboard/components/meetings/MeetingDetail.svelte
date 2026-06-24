<script lang="ts">
  import type { Meeting, Project } from '$shared/types/ipc.js';
  import MarkdownEditor from '../MarkdownEditor.svelte';

  interface Props { meetingId: string; onBack: () => void; }
  let { meetingId, onBack }: Props = $props();

  let meeting = $state<Meeting | null>(null);
  let projects = $state<Project[]>([]);
  let editing = $state(false);
  let editTitle = $state('');
  let editProjectId = $state<string>('');
  let transcriptPath = $state('');
  let summaryPath = $state('');
  let chatPath = $state('');
  let fileVersion = $state(0);
  let removeStatusListener: (() => void) | null = null;
  let removeSummaryListener: (() => void) | null = null;
  let summarizing = $state(false);
  let recordAudio = $state(true);
  let recordScreen = $state(true);
  let recordingFiles = $state<string[]>([]);
  let screenshotFiles = $state<string[]>([]);
  let screenshotAnalyses = $state<Record<string, string>>({});
  let tab = $state<'transcript' | 'summary' | 'chat' | 'media'>('transcript');

  async function load() {
    meeting = (await window.electronAPI.invoke('meetings:get', meetingId)) as Meeting;
    projects = (await window.electronAPI.invoke('projects:list')) as Project[];
    if (meeting) {
      computeFilePaths(meeting);
      await loadRecordingFiles();
      await loadScreenshots();
    }
  }

  function computeFilePaths(m: Meeting) {
    const sep = m.directory_path.includes('\\') ? '\\' : '/';
    // Each meeting has its own folder — plain filenames.
    transcriptPath = m.directory_path + sep + 'transcript.md';
    summaryPath = m.directory_path + sep + 'summary.md';
    chatPath = m.directory_path + sep + 'chat.md';
  }

  // Each meeting owns its folder, so every media file in it belongs to this meeting.
  async function loadRecordingFiles() {
    const m = meeting; if (!m) return;
    recordingFiles = (await window.electronAPI.invoke('fs:list-files', m.directory_path, '\\.webm$')) as string[];
  }
  async function loadScreenshots() {
    const m = meeting; if (!m) return;
    screenshotFiles = (await window.electronAPI.invoke('fs:list-files', m.directory_path, 'screenshot.*\\.png$')) as string[];
    // Each screenshot has a paired analysis file (screenshot-<ts>.png → .md). Load them for display.
    const analyses: Record<string, string> = {};
    for (const f of screenshotFiles) {
      const md = (await window.electronAPI.invoke('fs:read-file', filePath(f).replace(/\.png$/i, '.md'))) as string | null;
      if (md && md.trim()) analyses[f] = md;
    }
    screenshotAnalyses = analyses;
  }
  function filePath(filename: string): string {
    if (!meeting) return '';
    const sep = meeting.directory_path.includes('\\') ? '\\' : '/';
    return meeting.directory_path + sep + filename;
  }

  function startEdit() {
    if (!meeting) return;
    editTitle = meeting.title; editProjectId = meeting.project_id ?? '';
    editing = true;
  }
  async function saveEdit() {
    if (!editTitle.trim()) return;
    await window.electronAPI.invoke('meetings:update', meetingId, { title: editTitle.trim(), project_id: editProjectId || null });
    editing = false; await load();
  }
  async function deleteMeeting() {
    if (!confirm('Delete this meeting and its files?')) return;
    await window.electronAPI.invoke('meetings:delete', meetingId);
    onBack();
  }
  function projectName(projectId: string | null): string {
    if (!projectId) return 'General';
    return projects.find((p) => p.id === projectId)?.name ?? 'Unknown';
  }
  async function startMeeting() { await window.electronAPI.invoke('meeting:start', meetingId, { recordAudio, recordScreen }); }
  async function stopMeeting() { await window.electronAPI.invoke('meeting:stop', meetingId); }
  function formatDate(iso: string): string {
    return new Date(iso + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function statusInfo(s: string) {
    if (s === 'active') return { cls: 'live', label: 'Live' };
    if (s === 'completed') return { cls: 'rec', label: 'Recorded' };
    return { cls: 'draft', label: 'Idle' };
  }

  removeStatusListener = window.electronAPI.on('meeting:status-changed', (_meetingId: unknown, newStatus: unknown) => {
    load(); fileVersion++;
    if (newStatus === 'completed') summarizing = true;
  });
  removeSummaryListener = window.electronAPI.on('meeting:summary-ready', (id: unknown) => {
    if (id !== meetingId) return;
    // Refresh the auto-applied title + summary. (Project naming is a global prompt in App.)
    summarizing = false; load(); fileVersion++;
    tab = 'summary';
  });

  load();
</script>

<button class="back" onclick={onBack}>
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
  Meetings
</button>

{#if meeting}
  {@const st = statusInfo(meeting.status)}
  {#if editing}
    <div class="card">
      <form onsubmit={(e) => { e.preventDefault(); saveEdit(); }}>
        <h2 class="ctitle">Edit Meeting</h2>
        <div class="frow"><label class="ffield"><span class="flabel">Title</span><input type="text" class="finput" bind:value={editTitle} required /></label></div>
        <div class="frow"><label class="ffield"><span class="flabel">Project</span>
          <select class="finput" bind:value={editProjectId}><option value="">No project (General)</option>{#each projects as project}<option value={project.id}>{project.name}</option>{/each}</select>
        </label></div>
        <div class="factions"><button type="button" class="btn-g" onclick={() => (editing = false)}>Cancel</button><button type="submit" class="btn-i">Save Changes</button></div>
      </form>
    </div>
  {:else}
    <div class="hero">
      <span class="hdot {st.cls}"></span>
      <div class="hinfo"><h1>{meeting.title}</h1><p>{projectName(meeting.project_id)} · <span class="mono">{formatDate(meeting.created_at)}</span></p></div>
      <div class="hactions">
        {#if meeting.status === 'idle'}
          <label class="rec-t"><input type="checkbox" bind:checked={recordAudio} />Audio</label>
          <label class="rec-t"><input type="checkbox" bind:checked={recordScreen} />Screen</label>
          <button class="btn-i" onclick={startMeeting}><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>Start</button>
        {:else if meeting.status === 'active'}
          <button class="btn-d wide" onclick={stopMeeting}><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>Stop</button>
        {/if}
        <button class="btn-g icon" onclick={startEdit} aria-label="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
        </button>
        <button class="btn-d" onclick={deleteMeeting} aria-label="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
    </div>
  {/if}

  <div class="tabs">
    <button class:on={tab === 'transcript'} onclick={() => tab = 'transcript'}>Transcript</button>
    <button class:on={tab === 'summary'} onclick={() => tab = 'summary'}>Summary{#if summarizing}<span class="spark">✦</span>{/if}</button>
    <button class:on={tab === 'chat'} onclick={() => tab = 'chat'}>Assist</button>
    <button class:on={tab === 'media'} onclick={() => tab = 'media'}>Media <span class="tc">{recordingFiles.length + screenshotFiles.length}</span></button>
  </div>

  {#if tab === 'transcript'}
    {#if transcriptPath}{#key fileVersion}<MarkdownEditor filePath={transcriptPath} label="Transcript" />{/key}{/if}
  {:else if tab === 'summary'}
    {#if summarizing}<div class="sum-hint">✦ Generating summary &amp; suggesting a name…</div>{/if}
    {#if summaryPath}{#key fileVersion}<MarkdownEditor filePath={summaryPath} label="Summary" />{/key}{/if}
  {:else if tab === 'chat'}
    {#if chatPath}{#key fileVersion}<MarkdownEditor filePath={chatPath} label="Assist chat" />{/key}{/if}
  {:else}
    {#if recordingFiles.length === 0 && screenshotFiles.length === 0}
      <div class="empty-inline">No recording or screenshots yet.</div>
    {:else}
      {#if recordingFiles.length > 0}
        <h3 class="mhead">Recording</h3>
        {#each recordingFiles as file}
          <video controls src="media://{filePath(file)}" class="vplayer"><track kind="captions" /></video>
        {/each}
      {/if}
      {#if screenshotFiles.length > 0}
        <h3 class="mhead">Screenshots <span class="tc">{screenshotFiles.length}</span></h3>
        <div class="shots">
          {#each screenshotFiles as file}
            <div class="shot-card">
              <a class="shot" href="media://{filePath(file)}" target="_blank" rel="noreferrer"><img src="media://{filePath(file)}" alt={file} /></a>
              {#if screenshotAnalyses[file]}
                <details class="shot-analysis">
                  <summary>Analysis</summary>
                  <div class="shot-md">{screenshotAnalyses[file]}</div>
                </details>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  {/if}
{/if}

<style>
  .back { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-tertiary); margin-bottom: 22px; transition: color var(--transition); }
  .back:hover { color: var(--accent); }

  .hero { display: flex; align-items: center; gap: 13px; margin-bottom: 24px; }
  .hdot { width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0; background: var(--text-tertiary); }
  .hdot.live { background: var(--red); box-shadow: 0 0 0 4px var(--red-soft); animation: pulse 1.6s infinite; }
  .hdot.rec { background: var(--green); }
  @keyframes pulse { 50% { opacity: .45; } }
  .hinfo { flex: 1; min-width: 0; }
  .hinfo h1 { font-family: var(--font-display); font-weight: 700; font-size: 23px; letter-spacing: -0.02em; color: var(--text-primary); }
  .hinfo p { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px; }
  .mono { font-family: var(--font-mono); color: var(--text-tertiary); }
  .hactions { display: flex; gap: 7px; align-items: center; flex-shrink: 0; }
  .rec-t { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-secondary); cursor: pointer; }
  .rec-t input { accent-color: var(--accent); cursor: pointer; }

  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 22px; }
  .tabs button { position: relative; padding: 9px 14px 13px; font-size: 13.5px; font-weight: 500; color: var(--text-secondary); transition: color var(--transition); display: inline-flex; align-items: center; gap: 6px; }
  .tabs button:hover { color: var(--text-primary); }
  .tabs button.on { color: var(--accent); }
  .tabs button.on::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; background: var(--accent); border-radius: 2px; }
  .tc { font-family: var(--font-mono); font-size: 10px; color: var(--text-tertiary); background: var(--bg-tertiary); padding: 1px 6px; border-radius: 10px; }
  .spark { color: var(--accent); animation: fadePulse 1.6s ease-in-out infinite; }
  @keyframes fadePulse { 0%, 100% { opacity: .6; } 50% { opacity: 1; } }

  .sum-hint { font-size: 12px; color: var(--accent); margin-bottom: 12px; animation: fadePulse 1.6s ease-in-out infinite; }
  .empty-inline { padding: 28px; text-align: center; color: var(--text-tertiary); font-size: 13px; background: var(--bg-secondary); border: 1px dashed var(--border); border-radius: var(--radius-md); }

  .mhead { font-family: var(--font-display); font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 4px 0 12px; display: flex; align-items: center; gap: 8px; }
  .mhead:not(:first-child) { margin-top: 24px; }
  .vplayer { width: 100%; max-height: 320px; border-radius: var(--radius-md); background: #000; border: 1px solid var(--border); }
  .shots { display: flex; flex-direction: column; gap: 14px; }
  .shot-card { border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--bg-secondary); }
  .shot { display: block; }
  .shot img { width: 100%; max-height: 360px; display: block; object-fit: contain; background: #000; }
  .shot-analysis { border-top: 1px solid var(--border); }
  .shot-analysis summary { cursor: pointer; padding: 9px 13px; font-size: 12.5px; font-weight: 600; color: var(--text-accent); user-select: none; list-style: none; }
  .shot-analysis summary::before { content: '▸ '; }
  .shot-analysis[open] summary::before { content: '▾ '; }
  .shot-md { padding: 0 14px 14px; white-space: pre-wrap; font-size: 12.5px; line-height: 1.55; color: var(--text-secondary); max-height: 340px; overflow: auto; }

  /* buttons + form */
  .btn-i { display: inline-flex; align-items: center; gap: 6px; padding: 8px 15px; background: var(--accent); color: #15102a; border-radius: var(--radius-sm); font-size: 12.5px; font-weight: 600; transition: all var(--transition); }
  .btn-i:hover { background: var(--accent-hover); }
  .btn-g { display: inline-flex; align-items: center; gap: 5px; padding: 8px 13px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 12.5px; font-weight: 500; color: var(--text-secondary); transition: all var(--transition); }
  .btn-g:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn-g.icon { width: 34px; padding: 0; justify-content: center; }
  .btn-d { display: inline-flex; align-items: center; justify-content: center; gap: 5px; width: 34px; padding: 0; background: var(--red-soft); border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--red); transition: all var(--transition); }
  .btn-d.wide { width: auto; padding: 8px 13px; font-size: 12.5px; font-weight: 600; }
  .btn-d:hover { background: var(--red); color: #fff; }
  .card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 20px; margin-bottom: 22px; }
  .ctitle { font-family: var(--font-display); font-size: 15px; font-weight: 600; color: var(--text-primary); margin-bottom: 16px; }
  .frow { margin-bottom: 14px; } .ffield { display: flex; flex-direction: column; gap: 5px; }
  .flabel { font-size: 12px; font-weight: 500; color: var(--text-secondary); display: flex; gap: 6px; align-items: center; }
  .opt { font-weight: 400; color: var(--accent); font-size: 11px; }
  .finput { padding: 9px 12px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-primary); outline: none; transition: border-color var(--transition); width: 100%; }
  .finput:focus { border-color: var(--border-focus); }
  .modal-note { font-size: 12.5px; color: var(--text-tertiary); margin-bottom: 14px; line-height: 1.5; }
  .factions { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
</style>
