import { ipcMain, dialog, BrowserWindow, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  createProject, getProject, listProjects, updateProject, deleteProject,
  createMeeting, getMeeting, listMeetings, updateMeeting, deleteMeeting,
  getSetting, setSetting, SETTING_DEFAULTS,
} from './database.js';
import {
  createProjectDir, createMeetingFiles, moveMeetingDir,
  deleteMeetingFiles, deleteProjectDir, getBaseDir, renameProjectDir, renameMeetingDir,
  readPersonalContext, writePersonalContext,
} from './file-manager.js';
import type { Meeting } from './database.js';
import { getDashboardWindow, getOverlayWindow, createOverlayWindow, closeOverlayWindow, resizeOverlayWindow, type RecordingOptions } from './windows.js';
import { AudioPipeline } from './audio/audio-pipeline.js';
import { ScribeManager, parseJsonObject, type SpeakerName } from './audio/scribe-manager.js';
import { runBatch, createSession } from './llm/provider.js';
import type { LLMSession } from './llm/types.js';
import crypto from 'crypto';

let activePipeline: AudioPipeline | null = null;
let liveSession: LLMSession | null = null;
let scribe: ScribeManager | null = null;
let liveMeetingDir: string | null = null;
let liveAddDirs: string[] = [];
let liveKnowledge = ''; // personal + project context, shared with the research session

// Start the persistent, tool-less live-assist session for a meeting.
// Preloads behavior (mode prompt) + knowledge (personal context, project context.md),
// then warms it so the first real ask is fast. Tokens stream to the overlay.
function startLiveSession(meeting: Meeting): void {
  if (liveSession) { liveSession.close(); liveSession = null; }

  const isProject = !!meeting.project_id;
  // One editable prompt (Settings → Prompts → Assistant); knowledge + tools note appended below.
  const modePrompt = getSetting('prompt_project') || '';
  const personal = readPersonalContext();

  // The meeting is a subfolder; its project root (one level up) holds context.md + sibling meetings.
  const projectRoot = isProject ? path.dirname(meeting.directory_path) : meeting.directory_path;
  let projectContext = '';
  if (isProject) {
    const ctxPath = path.join(projectRoot, 'context.md');
    if (fs.existsSync(ctxPath)) projectContext = fs.readFileSync(ctxPath, 'utf-8');
  }

  // Directories the assistant may read on demand. Granting the project root covers this meeting's
  // own folder, sibling meetings (prior transcripts/summaries), and context.md in one scope.
  const addDirs: string[] = [projectRoot];
  if (isProject && meeting.project_id) {
    const project = getProject(meeting.project_id);
    if (project?.codebase_path && fs.existsSync(project.codebase_path)) {
      addDirs.push(project.codebase_path);
    }
  }

  const knowledge = [
    personal ? `# Personal context\n${personal}` : '',
    projectContext ? `# Project context\n${projectContext}` : '',
  ].filter(Boolean).join('\n\n');

  const systemPrompt = [
    modePrompt,
    knowledge,
    `# Files you can read on demand\nYou have read-only tools (Read/Grep/Glob) over: ${addDirs.join(', ')}.`,
  ].filter(Boolean).join('\n\n');

  liveMeetingDir = meeting.directory_path;
  liveAddDirs = addDirs;
  liveKnowledge = knowledge;

  const session = createSession({
    model: 'haiku', // live tier is Haiku for latency
    cliPath: getSetting('claude_cli_path') || undefined,
    cwd: meeting.directory_path, // neutral cwd — never the dev repo
    systemPrompt,
    addDirs,
    allowedTools: ['Read', 'Grep', 'Glob'],
  });

  // Only two kinds of message reach the live session: the one-time warm-up probe (its reply is
  // swallowed) and user-initiated turns (intents / asks, gated by the overlay's `busy`). Aux
  // context (screenshots, research) is folded into those turns by the overlay, so there is never a
  // second message in flight — nothing to mute, and the CLI can't coalesce concurrent sends.
  let warming = true;
  const toOverlay = (channel: string, payload: unknown) => {
    const o = getOverlayWindow();
    if (o && !o.isDestroyed()) o.webContents.send(channel, payload);
  };
  session.on('token', (t: string) => { if (!warming) toOverlay('assist:token', t); });
  session.on('turn', (f: string) => {
    if (warming) { warming = false; return; }  // swallow the one-time warm-up reply
    toOverlay('assist:turn', f);
  });
  session.on('error', (m: string) => { if (!warming) toOverlay('assist:error', m); });

  session.start();
  session.send('You are now connected for a live meeting. Reply with exactly: READY');
  liveSession = session;
}

function stopLiveSession(): void {
  if (liveSession) { liveSession.close(); liveSession = null; }
  liveMeetingDir = null;
  liveAddDirs = [];
  liveKnowledge = '';
}

// The Scribe: a second warm session that names diarized speakers from the conversation.
// Seeded with the project's known-people roster; its name map is pushed to the overlay
// (which resolves "Participant N" → real name at render time).
function startScribeSession(meeting: Meeting): void {
  if (scribe) { scribe.close(); scribe = null; }
  const projectRoot = meeting.project_id ? path.dirname(meeting.directory_path) : meeting.directory_path;
  const roster = meeting.project_id ? readPeopleBlock(projectRoot) : '';

  const s = new ScribeManager({ cwd: meeting.directory_path, roster });
  s.on('names', (map: Record<number, string>) => {
    const o = getOverlayWindow();
    if (o && !o.isDestroyed()) o.webContents.send('scribe:speakers', map);
  });
  s.on('summary', (text: string) => {
    const o = getOverlayWindow();
    if (o && !o.isDestroyed()) o.webContents.send('scribe:summary', text);
    // Persist each refresh so it survives a crash and seeds the final summary.
    try { fs.writeFileSync(path.join(meeting.directory_path, 'running-summary.md'), text); }
    catch (err) { console.error('[scribe] running-summary write failed:', err); }
  });
  s.start();
  scribe = s;
}

function stopScribeSession(): void {
  if (scribe) { scribe.close(); scribe = null; }
}

// A MediaRecorder webm is written as a live stream, so it has no duration / seek cues — the player
// can't seek and the scrubber jumps to the end. A fast `ffmpeg -c copy` remux (no re-encode) rewrites
// the container with proper duration + cues, making it seekable. ffmpeg is optional: if it isn't
// installed the original (still playable, just not seekable) is left in place.
function remuxRecording(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const fixed = filePath.replace(/\.webm$/i, '.seekable.webm');
  const ff = spawn('ffmpeg', ['-y', '-i', filePath, '-c', 'copy', fixed], { stdio: 'ignore' });
  ff.on('error', (e) => console.warn('[recording] remux skipped (ffmpeg unavailable?):', (e as Error).message));
  ff.on('close', () => {
    // ffmpeg exits NON-ZERO on truncated-but-recoverable recordings (MediaRecorder streams never
    // close cleanly) while still writing a valid seekable remux — so judge by the OUTPUT having a
    // real duration, not by the exit code.
    if (!fs.existsSync(fixed)) return;
    const accept = () => {
      try { fs.renameSync(fixed, filePath); console.log('[recording] remuxed to seekable:', filePath); }
      catch (err) { console.error('[recording] remux replace failed:', err); }
    };
    const reject = () => { try { fs.unlinkSync(fixed); } catch { /* ignore */ } };
    const probe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', fixed], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    probe.stdout.on('data', (d) => { out += d.toString(); });
    probe.on('close', () => { (parseFloat(out.trim()) > 0) ? accept() : reject(); });
    probe.on('error', () => { // no ffprobe — fall back to a size sanity check
      try { (fs.statSync(fixed).size > 1024) ? accept() : reject(); } catch { reject(); }
    });
  });
}

// After a meeting ends, summarize it with a heavy model using the full transcript +
// project context + prior summaries, and suggest a concise meeting name. Runs in the
// background; notifies the dashboard via 'meeting:summary-ready' when done.
async function generateSummary(meeting: Meeting, seedSummary = ''): Promise<void> {
  const dir = meeting.directory_path;
  const transcript = fs.existsSync(path.join(dir, 'transcript.md'))
    ? fs.readFileSync(path.join(dir, 'transcript.md'), 'utf-8')
    : '';

  // Actual participants = the distinct speaker labels in the (reconciled) transcript — NOT names
  // merely mentioned in conversation.
  const participants = [...new Set([...transcript.matchAll(/^\*\*(.+?)\*\*/gm)].map(m => m[1].trim()))];

  const project = meeting.project_id ? getProject(meeting.project_id) : undefined;
  const needsProjectName = !!project && project.name.startsWith('Untitled ');
  const projectRoot = meeting.project_id ? path.dirname(dir) : dir;

  const notify = (projectName: string | null) => {
    const dash = getDashboardWindow();
    if (dash && !dash.isDestroyed()) dash.webContents.send('meeting:summary-ready', meeting.id, projectName, meeting.project_id);
  };

  if (!transcript.trim()) { notify(null); return; } // nothing said — keep the name, no summary

  // Also fold in what was asked/answered live, if a chat log exists.
  const chat = fs.existsSync(path.join(dir, 'chat.md'))
    ? fs.readFileSync(path.join(dir, 'chat.md'), 'utf-8')
    : '';

  // Screenshots carry real content (a problem, slide, error, diagram) that may live ONLY on screen,
  // not in speech — fold their analyses in so they reach the summary even if never asked about live.
  let shots = '';
  try {
    const shotFiles = fs.readdirSync(dir).filter(f => /^screenshot-.*\.md$/.test(f)).sort();
    shots = shotFiles
      .map((f, i) => { try { return `Screenshot ${i + 1}:\n${fs.readFileSync(path.join(dir, f), 'utf-8').trim()}`; } catch { return ''; } })
      .filter(Boolean).join('\n\n');
  } catch { /* no screenshots */ }

  let projectContext = '';
  const ctxPath = path.join(projectRoot, 'context.md');
  if (fs.existsSync(ctxPath)) projectContext = fs.readFileSync(ctxPath, 'utf-8');

  const fmt = needsProjectName
    ? `Respond in EXACTLY this format:\nTITLE: <meeting name, 3-6 words>\nPROJECT: <a concise name for the overall project/topic, 2-4 words>\n---\n<summary markdown>`
    : `Respond in EXACTLY this format:\nTITLE: <meeting name, 3-6 words>\n---\n<summary markdown>`;

  const prompt = [
    `A meeting just ended. Summarize it for me.`,
    projectContext ? `Project context (prior meetings are already rolled up here):\n${projectContext}` : '',
    participants.length ? `The actual participants were: ${participants.join(', ')}. Treat only these as attendees — any other names in the transcript were merely mentioned, not present.` : '',
    seedSummary.trim() ? `A running summary was kept live during the meeting. Use it as your starting point — verify it against the transcript, then refine, correct, and complete it (don't merely copy it):\n${seedSummary}` : '',
    `Transcript:\n${transcript}`,
    chat.trim() ? `Live assistant chat during the meeting (what was asked/answered):\n${chat}` : '',
    shots ? `Screenshots captured during the meeting (on-screen analysis — fold in anything relevant, e.g. a problem, slides, errors or diagrams shown on screen):\n${shots}` : '',
    `Produce a clear, useful markdown summary (key points, decisions, and action items if any), then suggest names as instructed. No quotes.`,
    `IMPORTANT: This is not an agentic task. Do NOT use any tools and do NOT create, write, or edit any files — the app saves your reply itself. Respond with ONLY the summary, in exactly the format below, and nothing else (no preamble, no narration, no permission requests).`,
    fmt,
  ].filter(Boolean).join('\n\n');

  const res = await runBatch(prompt, {
    model: 'sonnet', // heavy model for the summary
    cwd: dir,
    timeoutMs: 180_000,
    // No tools: the transcript, chat, and rolled-up project context are all in the prompt, so
    // the model has everything it needs. Granting file tools makes the agentic CLI try to write
    // the files itself instead of just returning the summary text.
  });

  if (!res.ok || !res.text) { notify(null); return; }

  const segs = res.text.split(/\n-{3,}\s*\n/);
  const head = segs[0] || '';
  const summary = (segs.length > 1 ? segs.slice(1).join('\n---\n') : res.text).trim();
  const title = (head.match(/TITLE:\s*(.+)/)?.[1] || meeting.title).trim();
  const projectName = needsProjectName ? (head.match(/PROJECT:\s*(.+)/)?.[1]?.trim() || null) : null;

  // Write the summary, THEN auto-apply the AI title — which renames the meeting folder
  // (carrying the summary just written). User can edit the title later.
  try { fs.writeFileSync(path.join(dir, 'summary.md'), summary); } catch (err) { console.error('[summary] write failed:', err); }
  let newDir = dir;
  let newPrefix = meeting.file_prefix;
  if (title && title !== meeting.title) {
    const r = renameMeetingDir(dir, title);
    newDir = r.directory_path;
    newPrefix = r.filePrefix;
  }
  updateMeeting(meeting.id, { title, directory_path: newDir, file_prefix: newPrefix });

  notify(projectName);

  // Roll this meeting into the project's rolling context
  if (meeting.project_id) {
    try { await updateProjectContext(meeting.project_id, summary); } catch (err) { console.error('[context] update failed:', err); }
  }
}

// Startup catch-up: summarize completed meetings that have a transcript but no summary yet —
// e.g. the app was closed before the background summary finished, or the Claude CLI was
// misconfigured at the time. Idempotent: anything already summarized is skipped. Runs
// sequentially so the rolling-context updates don't race each other.
export async function summarizeMissingMeetings(): Promise<void> {
  for (const m of listMeetings()) {
    if (m.status !== 'completed') continue;
    const tPath = path.join(m.directory_path, 'transcript.md');
    const sPath = path.join(m.directory_path, 'summary.md');
    const transcript = fs.existsSync(tPath) ? fs.readFileSync(tPath, 'utf-8').trim() : '';
    const summary = fs.existsSync(sPath) ? fs.readFileSync(sPath, 'utf-8').trim() : '';
    if (transcript.length > 20 && !summary) {
      console.log(`[catch-up] generating missing summary for "${m.title}"`);
      try { await generateSummary(m); } catch (err) { console.error('[catch-up] failed for', m.id, err); }
    }
  }
}

// Markers delimit the AI-maintained section of a project's context.md. Everything OUTSIDE
// them (the user's overview, JD, notes) is never touched.
const ROLLING_START = '<!-- ROLLING-SUMMARY:START -->';
const ROLLING_END = '<!-- ROLLING-SUMMARY:END -->';

// A second AI-maintained block in context.md: the roster of people seen across the project's
// meetings. Seeds the Scribe (correct spellings + candidates) and grows as new people appear.
const PEOPLE_START = '<!-- PEOPLE:START -->';
const PEOPLE_END = '<!-- PEOPLE:END -->';

function readPeopleBlock(projectRoot: string): string {
  const ctxPath = path.join(projectRoot, 'context.md');
  if (!fs.existsSync(ctxPath)) return '';
  const ctx = fs.readFileSync(ctxPath, 'utf-8');
  const s = ctx.indexOf(PEOPLE_START), e = ctx.indexOf(PEOPLE_END);
  return (s >= 0 && e > s) ? ctx.slice(s + PEOPLE_START.length, e).trim() : '';
}

function writePeopleBlock(projectRoot: string, content: string): void {
  const ctxPath = path.join(projectRoot, 'context.md');
  const ctx = fs.existsSync(ctxPath) ? fs.readFileSync(ctxPath, 'utf-8') : '';
  const block = `${PEOPLE_START}\n${content.trim()}\n${PEOPLE_END}`;
  const s = ctx.indexOf(PEOPLE_START), e = ctx.indexOf(PEOPLE_END);
  const updated = (s >= 0 && e > s)
    ? ctx.slice(0, s) + block + ctx.slice(e + PEOPLE_END.length)
    : ctx.trimEnd() + `\n\n## People\n${block}\n`;
  fs.writeFileSync(ctxPath, updated);
}

// Append newly-confirmed names to the roster (dedup by name, case-insensitive). Code-level
// merge — no LLM call. Names are read from the leading text before any "—" role separator.
function mergePeopleIntoRoster(projectRoot: string, people: { name: string; role?: string }[]): void {
  const existing = readPeopleBlock(projectRoot);
  const have = new Set(
    existing.split('\n')
      .map(l => l.replace(/^[-*]\s*/, '').split('—')[0].trim().toLowerCase())
      .filter(Boolean),
  );
  const additions = people.filter(p => {
    const n = p.name.trim().toLowerCase();
    return n && !have.has(n) && !/^participant\b/.test(n) && n !== 'me' && n !== 'you';
  });
  if (additions.length === 0) return;
  const lines = existing ? [existing.trimEnd()] : [];
  for (const p of additions) lines.push(p.role ? `- ${p.name.trim()} — ${p.role.trim()}` : `- ${p.name.trim()}`);
  writePeopleBlock(projectRoot, lines.join('\n'));
}

// End-of-meeting speaker reconciliation — the ACCURATE pass that rewrites transcript.md from
// generic "Participant N" labels to real names. Runs a strong model over the FULL transcript
// (no streaming guesswork) + the roster + the live Scribe map, honors user-locked names
// absolutely, and stays conservative: anything ambiguous keeps "Participant N". Runs BEFORE
// the summary so the summary reads real names.
async function reconcileSpeakers(
  meeting: Meeting,
  liveNames: Map<number, SpeakerName>,
): Promise<void> {
  const dir = meeting.directory_path;
  const tPath = path.join(dir, 'transcript.md');
  if (!fs.existsSync(tPath)) return;
  let transcript = fs.readFileSync(tPath, 'utf-8');
  if (!transcript.trim()) return;

  const projectRoot = meeting.project_id ? path.dirname(dir) : dir;
  const roster = meeting.project_id ? readPeopleBlock(projectRoot) : '';

  // Which participant numbers actually appear in the file?
  const present = [...new Set([...transcript.matchAll(/^\*\*Participant (\d+)\*\*/gm)].map(m => parseInt(m[1], 10)))];

  // Final map: user-locked names are forced in; the model fills the rest, conservatively.
  const finalMap = new Map<number, string>();
  const lockedNums = new Set<number>();
  for (const [i, v] of liveNames) if (v.locked) { finalMap.set(i, v.name); lockedNums.add(i); }

  if (present.length > 0) {
    const lockedDesc = [...finalMap.entries()].map(([i, n]) => `Participant ${i} = ${n}`).join('; ');
    const guesses = [...liveNames.entries()].filter(([i, v]) => !v.locked && present.includes(i))
      .map(([i, v]) => `Participant ${i} ≈ ${v.name}`).join('; ');

    const prompt = [
      `You are reconciling speaker identities for a finished meeting's transcript. Participants are labelled generically ("Participant 1", "Participant 2", …) from a diarization system that is imperfect — it can be jittery and may even split one real person across two numbers.`,
      roster ? `Known people on this project:\n${roster}` : '',
      lockedDesc ? `FIXED identities — confirmed by the user, you MUST keep these exactly and never reassign their number:\n${lockedDesc}` : '',
      guesses ? `The live assistant's best guesses (HINTS only — verify against the transcript):\n${guesses}` : '',
      `Transcript:\n${transcript}`,
      `For each participant number that appears (${present.join(', ')}), decide the real name. Rules:`,
      `- Assign a real name ONLY when the transcript makes you confident (a self-introduction, being addressed by name, a sign-off). If you are not sure, KEEP it generic — a wrong name is worse than "Participant N".`,
      `- A participant is someone who SPEAKS. Names that are only talked ABOUT but never speak (e.g. "I'll ask Omar", "Akhil sent it") are NOT participants — never use such a name for a speaker unless that person is clearly the one talking.`,
      `- Map two different numbers to the SAME name only when you are sure they are one person (diarization split one voice).`,
      `- Never change a FIXED identity.`,
      `IMPORTANT: This is not an agentic task. Do NOT use any tools and do NOT write any files. Reply with ONLY this JSON object and nothing else (no prose, no code fences): {"map":{"<participant number>":"<real name, or empty string to keep it generic>"}}.`,
    ].filter(Boolean).join('\n\n');

    const res = await runBatch(prompt, { model: 'sonnet', cwd: dir, timeoutMs: 120_000 });
    const parsed = res.ok && res.text ? parseJsonObject(res.text) : null;
    if (parsed?.map && typeof parsed.map === 'object') {
      for (const [k, name] of Object.entries(parsed.map)) {
        const n = parseInt(k, 10);
        if (!(n >= 1) || lockedNums.has(n)) continue;        // never override a user lock
        if (typeof name === 'string' && name.trim()) finalMap.set(n, name.trim());
      }
    }
  }

  // Rewrite the file: substitute ONLY the bolded speaker prefix anchored at line start, so
  // "Participant 2" appearing inside spoken text is never corrupted. "You" is never touched.
  if (finalMap.size > 0) {
    let merges = 0;
    const byName = new Map<string, number>();
    for (const name of finalMap.values()) byName.set(name, (byName.get(name) ?? 0) + 1);
    for (const [name, count] of byName) if (count > 1) { merges++; console.log(`[scribe] merged ${count} diarization indices → "${name}"`); }

    transcript = transcript.replace(/^\*\*Participant (\d+)\*\*/gm, (full, num) => {
      const name = finalMap.get(parseInt(num, 10));
      return name ? `**${name}**` : full;
    });
    try { fs.writeFileSync(tPath, transcript); } catch (err) { console.error('[scribe] transcript normalize failed:', err); }
    console.log(`[scribe] reconciled ${finalMap.size} speaker(s)${merges ? `, ${merges} merge(s)` : ''} for "${meeting.title}"`);
  }

  // Grow the project roster with the ACTUAL participants only (reconciled speakers) — never
  // names that were merely mentioned in conversation.
  if (meeting.project_id && finalMap.size > 0) {
    const people = [...new Set(finalMap.values())].map(name => ({ name }));
    try { mergePeopleIntoRoster(projectRoot, people); } catch (err) { console.error('[scribe] roster merge failed:', err); }
  }
}

// Merge a new meeting summary into the project's concise rolling context, condensing so it
// doesn't grow unboundedly (it's injected into every live session).
async function updateProjectContext(projectId: string, newSummary: string): Promise<void> {
  const ctxPathFor = (name: string) => path.join(getBaseDir(), name, 'context.md');
  const proj0 = getProject(projectId);
  if (!proj0) return;

  const readPath = ctxPathFor(proj0.name);
  const ctx = fs.existsSync(readPath) ? fs.readFileSync(readPath, 'utf-8') : '';

  const startIdx = ctx.indexOf(ROLLING_START);
  const endIdx = ctx.indexOf(ROLLING_END);
  const existing = (startIdx >= 0 && endIdx > startIdx)
    ? ctx.slice(startIdx + ROLLING_START.length, endIdx).trim()
    : '';

  const prompt = [
    `You maintain a CONCISE rolling summary of a project across its meetings. It is injected into every live session, so it must stay short and well-structured.`,
    `Current rolling summary:\n${existing || '(none yet)'}`,
    `Newest meeting summary:\n${newSummary}`,
    `Produce an UPDATED rolling summary that integrates the newest meeting: project state, key decisions, open questions, and outstanding action items. Merge and condense older items — do not let it grow unboundedly.`,
    `IMPORTANT: This is not an agentic task. Do NOT use any tools and do NOT write or edit any files — the app saves your reply itself. Output ONLY the markdown for the rolling summary (no preamble, no code fences, no narration).`,
  ].join('\n\n');

  const res = await runBatch(prompt, { model: 'sonnet', cwd: path.join(getBaseDir(), proj0.name), timeoutMs: 150_000 });
  if (!res.ok || !res.text) { console.error('[context] rolling-update returned nothing:', res.error); return; }

  const block = `${ROLLING_START}\n${res.text.trim()}\n${ROLLING_END}`;
  const updated = (startIdx >= 0 && endIdx > startIdx)
    ? ctx.slice(0, startIdx) + block + ctx.slice(endIdx + ROLLING_END.length)
    : ctx.trimEnd() + `\n\n## Rolling Summary\n${block}\n`;

  // Re-resolve the path in case the project was renamed while the model ran
  const proj1 = getProject(projectId);
  fs.writeFileSync(ctxPathFor(proj1 ? proj1.name : proj0.name), updated);
}

// Is a CLI available? Absolute path → the file exists; bare name → it resolves on PATH (--version).
function detectCli(cli: string): Promise<boolean> {
  return new Promise((res) => {
    if (cli.includes('/')) return res(fs.existsSync(cli));
    let done = false;
    const c = spawn(cli, ['--version'], { stdio: 'ignore' });
    const finish = (v: boolean) => { if (!done) { done = true; res(v); } };
    c.on('error', () => finish(false));
    c.on('close', (code) => finish(code === 0));
    setTimeout(() => { try { c.kill(); } catch { /* ignore */ } finish(false); }, 5000);
  });
}

// The renderer's generic fs IPC must not read/write arbitrary paths. Allowed roots = the app's
// base dir (meeting/project files) + each project's configured codebase path (so a future
// in-UI code read still works). Everything else is rejected.
function fsAllowedRoots(): string[] {
  const roots = [path.resolve(getBaseDir())];
  for (const p of listProjects()) {
    const c = p.codebase_path?.trim();
    if (c) { try { roots.push(path.resolve(c)); } catch { /* ignore */ } }
  }
  return roots;
}
export function fsPathAllowed(target: string): boolean {
  try {
    const resolved = path.resolve(target);
    return fsAllowedRoots().some(root => resolved === root || resolved.startsWith(root + path.sep));
  } catch { return false; }
}

export function registerIpcHandlers(): void {
  // --- Settings ---

  ipcMain.handle('settings:get', (_e, key: string) => getSetting(key));

  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    setSetting(key, value);
    return true;
  });

  // Which LLM backends are installed (absolute path exists, or the bare name resolves on PATH).
  ipcMain.handle('providers:detect', async () => {
    const [claude, codex] = await Promise.all([
      detectCli(getSetting('claude_cli_path') || 'claude'),
      detectCli(getSetting('codex_cli_path') || 'codex'),
    ]);
    return { claude, codex };
  });

  // Open a link in the user's real browser (e.g. the ah2k.dev credit) — never in-app.
  ipcMain.handle('shell:open-external', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return true;
  });

  // Reset the given prompts to their built-in defaults (personal context is a file, untouched).
  // Only known prompt keys are honored.
  const RESETTABLE_PROMPTS = new Set([
    'prompt_project', 'prompt_research', 'prompt_screenshot', 'prompt_scribe',
    'intent_answer_prompt', 'intent_suggest_prompt', 'intent_askback_prompt', 'intent_explain_prompt',
  ]);
  ipcMain.handle('settings:reset-prompts', (_e, keys: string[]) => {
    for (const k of keys || []) {
      if (RESETTABLE_PROMPTS.has(k) && SETTING_DEFAULTS[k] !== undefined) setSetting(k, SETTING_DEFAULTS[k]);
    }
    return true;
  });

  // Test a Deepgram API key from the main process (renderer fetch is blocked by CORS)
  ipcMain.handle('settings:test-deepgram', async (_e, key: string) => {
    try {
      const res = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { Authorization: `Token ${key}` },
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  });

  // --- Personal context (file-backed knowledge) ---

  ipcMain.handle('personal-context:get', () => readPersonalContext());

  ipcMain.handle('personal-context:set', (_e, content: string) => {
    writePersonalContext(content);
    return true;
  });

  // --- LLM (Claude CLI) ---

  // Quick health check for the Settings page: round-trips a trivial prompt and reports latency.
  ipcMain.handle('llm:test', async (_e, model?: string) => {
    return runBatch('Reply with exactly: OK', { model, timeoutMs: 30_000 });
  });

  // --- AI sessions (persistent streaming Claude sessions, reused by edit popover & live assist) ---

  const aiSessions = new Map<string, LLMSession>();

  ipcMain.handle('ai-session:start', (e, cfg: { model?: string; systemPrompt?: string; addDirs?: string[]; allowedTools?: string[] }) => {
    const id = crypto.randomUUID();
    const session = createSession({
      model: cfg.model || getSetting('llm_model') || 'haiku',
      cliPath: getSetting('claude_cli_path') || undefined,
      cwd: getBaseDir(), // neutral cwd — avoid the dev repo's CLAUDE.md
      systemPrompt: cfg.systemPrompt,
      addDirs: cfg.addDirs,
      allowedTools: cfg.allowedTools,
    });
    const sender = e.sender;
    const safeSend = (channel: string, payload: unknown) => {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    };
    session.on('token', (text: string) => safeSend('ai-session:token', { id, text }));
    session.on('turn', (text: string) => safeSend('ai-session:turn', { id, text }));
    session.on('error', (error: string) => safeSend('ai-session:error', { id, error }));
    session.on('close', () => safeSend('ai-session:closed', { id }));
    session.start();
    aiSessions.set(id, session);
    return id;
  });

  ipcMain.handle('ai-session:send', (_e, id: string, text: string) => {
    aiSessions.get(id)?.send(text);
    return true;
  });

  ipcMain.handle('ai-session:close', (_e, id: string) => {
    const s = aiSessions.get(id);
    if (s) { s.close(); aiSessions.delete(id); }
    return true;
  });

  // Analyze a captured screenshot in a SEPARATE one-shot session (Read tools) so the live
  // session stays fast. Returns a short text analysis that the overlay buffers as context.
  ipcMain.handle('assist:analyze-screenshot', async (_e, payload: { path: string; context: string }) => {
    const dir = path.dirname(payload.path);
    const instruction = getSetting('prompt_screenshot') ||
      `Read the screenshot and describe everything relevant on it in detail, quoting on-screen text verbatim where it matters.`;
    const prompt = [
      instruction,
      liveKnowledge,                                                  // personal + project context (in-domain reading)
      payload.context ? `Recent meeting transcript:\n${payload.context}` : '',
      `The screenshot image is at ${payload.path} — read it. Return ONLY your description as text; do NOT write or edit any files (the app saves your reply itself).`,
    ].filter(Boolean).join('\n\n');

    const res = await runBatch(prompt, {
      model: getSetting('llm_model') || 'haiku',
      cwd: dir,
      addDirs: [dir],
      allowedTools: ['Read', 'Grep', 'Glob'],     // Claude reads the image via Read
      images: [payload.path],                       // Codex attaches it via -i
      timeoutMs: 90_000,
    });

    // Persist the full analysis next to the PNG (screenshot-<ts>.png → screenshot-<ts>.md) so it
    // lives on the timeline and the live/research/summary sessions can re-read it on demand.
    if (res.ok && res.text) {
      try { fs.writeFileSync(payload.path.replace(/\.png$/i, '.md'), res.text); } catch (err) { console.error('[screenshot] md write failed:', err); }
    }
    return res;
  });

  // Save a screenshot captured by the overlay renderer (reuses the meeting's screen stream)
  ipcMain.handle('screenshot:save', (_e, payload: { meetingId: string; data: number[] }) => {
    const meeting = getMeeting(payload.meetingId);
    if (!meeting) return { ok: false, error: 'Meeting not found' };
    // Each meeting has its own folder now, so a plain name is unambiguous.
    const filename = `screenshot-${Date.now()}.png`;
    const filePath = path.join(meeting.directory_path, filename);
    fs.writeFileSync(filePath, Buffer.from(payload.data));
    console.log(`[screenshot] Saved: ${filePath}`);

    // Drop a marker into the transcript at the moment of capture so the screenshot is anchored
    // on the timeline. It links the analysis file (written when analysis completes).
    try {
      const time = new Date().toLocaleTimeString();
      const marker = `**[📷 Screenshot]** (${time}): captured — analysis in ${filename.replace(/\.png$/i, '.md')}\n\n`;
      fs.appendFileSync(path.join(meeting.directory_path, 'transcript.md'), marker, 'utf-8');
    } catch (err) { console.error('[screenshot] transcript marker failed:', err); }

    return { ok: true, path: filePath };
  });

  // Append one entry to the meeting's live-assist chat log (<dir>/chat.md). Written from the
  // renderer because it owns the clean chat (intent labels, answers, screenshot/research text).
  // Research and the end-of-meeting summary read this file for conversation context.
  ipcMain.handle('chat:append', (_e, payload: { meetingId: string; heading: string; body: string }) => {
    const meeting = getMeeting(payload.meetingId);
    if (!meeting || !payload.body?.trim()) return false;
    const time = new Date().toLocaleTimeString();
    const block = `## ${time} · ${payload.heading}\n${payload.body.trim()}\n\n`;
    try { fs.appendFileSync(path.join(meeting.directory_path, 'chat.md'), block, 'utf-8'); } catch (err) { console.error('[chat] append failed:', err); }
    return true;
  });

  // --- Projects ---

  ipcMain.handle('projects:list', () => listProjects());

  ipcMain.handle('projects:get', (_e, id: string) => getProject(id));

  ipcMain.handle('projects:create', (_e, data: { name: string; description?: string; codebase_path?: string }) => {
    const project = createProject(data);
    createProjectDir(project.name, data.description);
    return project;
  });

  ipcMain.handle('projects:update', (_e, id: string, data: { name?: string; description?: string; codebase_path?: string }) => {
    const existing = getProject(id);
    // Renaming a project must move its folder on disk and repoint its meetings.
    if (existing && data.name && data.name.trim() && data.name.trim() !== existing.name) {
      const newDir = renameProjectDir(existing.name, data.name.trim());
      // The whole project folder moved; repoint each meeting to its subfolder under the new root.
      for (const m of listMeetings({ project_id: id })) {
        updateMeeting(m.id, { directory_path: path.join(newDir, path.basename(m.directory_path)) });
      }
    }
    return updateProject(id, data);
  });

  ipcMain.handle('projects:delete', (_e, id: string) => {
    const project = getProject(id);
    if (!project) return false;

    // Delete all meetings in DB that belong to this project
    const meetings = listMeetings({ project_id: id });
    for (const meeting of meetings) {
      deleteMeeting(meeting.id);
    }

    deleteProject(id);
    deleteProjectDir(project.name);
    return true;
  });

  // --- Meetings ---

  ipcMain.handle('meetings:list', (_e, filters?: { project_id?: string | null }) => listMeetings(filters));

  ipcMain.handle('meetings:get', (_e, id: string) => getMeeting(id));

  ipcMain.handle('meetings:create', (_e, data: { title: string; project_id?: string | null }) => {
    let projectName: string | null = null;
    if (data.project_id) {
      const project = getProject(data.project_id);
      projectName = project?.name ?? null;
    }

    const result = createMeetingFiles(data.title, projectName);

    return createMeeting({
      title: data.title,
      project_id: data.project_id ?? null,
      directory_path: result.directory_path,
      file_prefix: result.filePrefix,
    });
  });

  ipcMain.handle('meetings:update', (_e, id: string, data: { title?: string; project_id?: string | null; status?: string }) => {
    const meeting = getMeeting(id);
    if (!meeting) return undefined;

    const updateData: Record<string, unknown> = { ...data };

    // If project_id is changing, move the meeting's folder to the new project (or General).
    if (data.project_id !== undefined && data.project_id !== meeting.project_id) {
      const project = data.project_id ? getProject(data.project_id) : null;
      const result = moveMeetingDir(meeting.directory_path, project?.name ?? null);
      updateData.directory_path = result.directory_path;
      updateData.file_prefix = result.filePrefix;
    } else if (data.title && data.title.trim() && data.title.trim() !== meeting.title) {
      // Title changed (no project move) → rename the meeting folder on disk to match
      const result = renameMeetingDir(meeting.directory_path, data.title.trim());
      updateData.directory_path = result.directory_path;
      updateData.file_prefix = result.filePrefix;
    }

    return updateMeeting(id, updateData as Parameters<typeof updateMeeting>[1]);
  });

  ipcMain.handle('meetings:delete', (_e, id: string) => {
    const meeting = getMeeting(id);
    if (!meeting) return false;
    deleteMeetingFiles(meeting.directory_path);
    return deleteMeeting(id);
  });

  // --- File read/write ---

  ipcMain.handle('fs:read-file', (_e, filePath: string) => {
    if (!fsPathAllowed(filePath) || !fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  });

  ipcMain.handle('fs:write-file', (_e, filePath: string, content: string) => {
    if (!fsPathAllowed(filePath)) return false;
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  });

  ipcMain.handle('fs:list-files', (_e, dirPath: string, pattern?: string) => {
    if (!fsPathAllowed(dirPath) || !fs.existsSync(dirPath)) return [];
    const entries = fs.readdirSync(dirPath);
    if (pattern) {
      const regex = new RegExp(pattern);
      return entries.filter(e => regex.test(e));
    }
    return entries;
  });

  ipcMain.handle('fs:get-base-dir', () => getBaseDir());

  // --- Meeting lifecycle ---

  ipcMain.handle('meeting:start', async (_e, meetingId: string, opts?: RecordingOptions) => {
    const meeting = getMeeting(meetingId);
    const updated = updateMeeting(meetingId, { status: 'active' });
    createOverlayWindow(meetingId, opts);

    // Get the dashboard out of the way for the live meeting
    const dash0 = getDashboardWindow();
    if (dash0 && !dash0.isDestroyed()) dash0.minimize();

    // Start audio pipeline
    const apiKey = getSetting('deepgram_api_key');
    if (!apiKey) {
      throw new Error('Deepgram API key not configured. Please set it in Settings.');
    }
    if (activePipeline) {
      activePipeline.destroy();
    }
    activePipeline = new AudioPipeline(apiKey);
    if (meeting) {
      activePipeline.setTranscriptFile(meeting.directory_path);
    }
    // Feed every finalized utterance to the Scribe (mic = "Me", system = "Participant N").
    activePipeline.setFinalEntryListener((entry) => {
      scribe?.feedUtterance(entry.source === 'mic' ? 'Me' : entry.speaker, entry.text);
    });
    const overlay = getOverlayWindow();
    if (overlay) {
      activePipeline.addTargetWindow(overlay);
    }
    const dashboard = getDashboardWindow();
    if (dashboard && !dashboard.isDestroyed()) {
      activePipeline.addTargetWindow(dashboard);
      dashboard.webContents.send('meeting:status-changed', meetingId, 'active');
    }
    try {
      await activePipeline.start();
      console.log('[meeting:start] Audio pipeline started successfully');
    } catch (err) {
      console.error('[meeting:start] Failed to start audio pipeline:', err);
    }

    // Start the live-assist session (preloaded + warmed)
    if (meeting) {
      try {
        startLiveSession(meeting);
        console.log('[meeting:start] Live assist session started');
      } catch (err) {
        console.error('[meeting:start] Failed to start live session:', err);
      }
      try {
        startScribeSession(meeting);
        console.log('[meeting:start] Scribe session started');
      } catch (err) {
        console.error('[meeting:start] Failed to start scribe session:', err);
      }
    }

    return updated;
  });

  // Forward a composed live-assist message (transcript delta + instruction) to the session.
  // Its reply IS shown to the user, so enqueue a non-muted flag for this turn.
  ipcMain.handle('assist:send', (_e, text: string) => {
    if (!liveSession) return false;
    liveSession.send(text);
    return true;
  });

  // Overlay speaker legend → the user renamed a participant. Locks that index so the Scribe
  // can never override it; the name persists into the project roster at meeting end.
  ipcMain.handle('scribe:rename', (_e, idx: number, name: string) => {
    scribe?.rename(idx, name);
    return true;
  });

  // Research: a SEPARATE all-tools session (web + read) that answers in chat AND whose
  // findings get fed back to the main session as context. Doesn't block the live session.
  const researchSessions = new Map<string, LLMSession>();
  ipcMain.handle('assist:research', (e, payload: { question: string; context: string }) => {
    const id = crypto.randomUUID();
    const systemPrompt = [
      getSetting('prompt_research') ||
        `You are a research assistant during a live meeting. Use your tools (web search, fetch, file read) to answer the question thoroughly. Be concise but complete; cite key sources inline.`,
      liveAddDirs.length
        ? `You can also read local files — the project's code, prior transcripts and summaries — under: ${liveAddDirs.join(', ')}. Use them when the question relates to the project.`
        : '',
      liveMeetingDir
        ? `This meeting's full transcript is at ${path.join(liveMeetingDir, 'transcript.md')} and the live assistant chat so far (what's already been asked/answered) is at ${path.join(liveMeetingDir, 'chat.md')} — read them when the question relates to the ongoing discussion.`
        : '',
      liveKnowledge, // personal + project context, so research reasons with full awareness
      payload.context ? `Recent meeting context (last lines):\n${payload.context}` : '',
    ].filter(Boolean).join('\n\n');

    const session = createSession({
      model: 'sonnet', // research favors quality over latency
      cliPath: getSetting('claude_cli_path') || undefined,
      cwd: liveMeetingDir || undefined,
      systemPrompt,
      addDirs: liveAddDirs,
      allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'],
    });

    const sender = e.sender;
    const safeSend = (ch: string, p: unknown) => { if (!sender.isDestroyed()) sender.send(ch, p); };
    session.on('token', (t: string) => safeSend('research:token', { id, text: t }));
    session.on('turn', (f: string) => {
      safeSend('research:turn', { id, text: f });
      session.close();
      researchSessions.delete(id);
    });
    session.on('error', (m: string) => safeSend('research:error', { id, error: m }));

    session.start();
    session.send(payload.question);
    researchSessions.set(id, session);
    return id;
  });

  // Resize the overlay window as its sections expand/collapse
  ipcMain.handle('overlay:resize', (_e, w: number, h: number) => {
    resizeOverlayWindow(w, h);
    return true;
  });

  // Hide the overlay momentarily so it's not in a screenshot (content protection isn't
  // honored on every Wayland setup). showInactive keeps it from stealing focus.
  ipcMain.handle('overlay:set-hidden', (_e, hidden: boolean) => {
    const o = getOverlayWindow();
    if (!o || o.isDestroyed()) return false;
    if (hidden) o.hide();
    else o.showInactive();
    return true;
  });

  ipcMain.handle('meeting:stop', (_e, meetingId: string) => {
    // Stop audio pipeline
    if (activePipeline) {
      activePipeline.destroy();
      activePipeline = null;
    }
    stopLiveSession();

    // Capture the Scribe's final map + running summary before closing it.
    const scribeNames = scribe ? new Map(scribe.getNames()) : new Map<number, SpeakerName>();
    const scribeSummary = scribe ? scribe.getSummary() : '';
    stopScribeSession();

    const updated = updateMeeting(meetingId, { status: 'completed' });
    closeOverlayWindow();
    const dashboard = getDashboardWindow();
    if (dashboard && !dashboard.isDestroyed()) {
      dashboard.restore();
      dashboard.focus();
      dashboard.webContents.send('meeting:status-changed', meetingId, 'completed');
    }

    // Reconcile speaker names into transcript.md (accurate pass), THEN summarize — both heavy,
    // both background. Summary runs after reconciliation so it reads real names.
    const stopped = getMeeting(meetingId);
    if (stopped) {
      reconcileSpeakers(stopped, scribeNames)
        .catch(err => console.error('[scribe] reconcile failed:', err))
        .then(() => generateSummary(stopped, scribeSummary))
        .catch(err => console.error('[summary] failed:', err));
    }

    return updated;
  });

  // --- Audio data from renderer ---

  ipcMain.handle('audio:data', async (_e, data: { source: 'mic' | 'system'; samples: number[] }) => {
    if (activePipeline) {
      const float32 = new Float32Array(data.samples);
      await activePipeline.feedAudio(float32, data.source);
    }
  });

  // --- Recording (streamed to disk) ---

  const activeRecordings = new Map<string, fs.WriteStream>();

  ipcMain.handle('recording:init', (_e, payload: { meetingId: string }) => {
    const meeting = getMeeting(payload.meetingId);
    if (!meeting) return false;
    const filePath = path.join(meeting.directory_path, 'recording.webm');
    const stream = fs.createWriteStream(filePath);
    activeRecordings.set(payload.meetingId, stream);
    console.log(`[recording] Initialized: ${filePath}`);
    return true;
  });

  ipcMain.handle('recording:chunk', (_e, payload: { meetingId: string; data: number[] }) => {
    const stream = activeRecordings.get(payload.meetingId);
    if (!stream) return false;
    stream.write(Buffer.from(payload.data));
    return true;
  });

  ipcMain.handle('recording:finish', (_e, payload: { meetingId: string }) => {
    const stream = activeRecordings.get(payload.meetingId);
    if (stream) {
      const meeting = getMeeting(payload.meetingId);
      const filePath = meeting ? path.join(meeting.directory_path, 'recording.webm') : null;
      // Remux only after the stream is fully flushed to disk.
      stream.end(() => { if (filePath) remuxRecording(filePath); });
      activeRecordings.delete(payload.meetingId);
      console.log(`[recording] Finalized for meeting ${payload.meetingId}`);
    }
    return true;
  });

  // --- Dialogs ---

  ipcMain.handle('dialog:select-directory', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:select-files', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });
}
