import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import crypto from 'crypto';

let db: Database.Database | null = null;

export interface Project {
  id: string;
  name: string;
  description: string;
  codebase_path: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

export interface Meeting {
  id: string;
  project_id: string | null;
  title: string;
  slug: string;
  status: string;
  directory_path: string;
  file_prefix: string;
  created_at: string;
  updated_at: string;
}

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = Date.now().toString(36) + crypto.randomUUID().slice(0, 4);
  return `${base}-${suffix}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  codebase_path TEXT DEFAULT '',
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  directory_path TEXT NOT NULL,
  file_prefix TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings(project_id);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function initDatabase(dbPath?: string): void {
  const resolvedPath = dbPath ?? path.join(app.getPath('userData'), 'echolect.sqlite');
  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // No Deepgram key is seeded — never ship a key in source. The user sets it in Settings → STT.

  // Seed default prompts, intents, and hotkeys (only if absent — never overwrite the user's edits).
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    if (getSetting(key) === undefined) setSetting(key, value);
  }
}

/**
 * Default values for the live-assist prompts, intents, and hotkeys.
 * Behavior lives in prompts (editable in Settings); knowledge lives in context files.
 */
export const SETTING_DEFAULTS: Record<string, string> = {
  // LLM backend: which provider is active + per-provider model/CLI path.
  llm_provider: 'claude',        // 'claude' | 'codex'
  llm_model: 'haiku',            // Claude model (haiku | sonnet)
  codex_model: '',               // Codex model id ('' → codex default)
  codex_cli_path: '',            // absolute path if `codex` isn't on PATH

  // Overlay appearance
  overlay_opacity: '0.94',

  // The live assistant's full behavior — one editable prompt (persona + how to read the
  // transcript + response rules). Knowledge (personal + project context) and the tools note are
  // appended by code at meeting start. Specific tone (e.g. interview) belongs in context.md.
  prompt_project:
    `You are my real-time meeting copilot. As the meeting runs, I send you the new transcript since you last replied plus a specific ask — answer the question, suggest what to say, give me a question to ask, or explain something. I may also hand you extra context I've pulled in: a description of a screenshot from my screen, or web-research findings. Use all of it to help me in the moment.

You have my personal context and this project's context below (prior meetings are already summarized there). Lean on them so your help is specific to me and this project, not generic.

Reading the transcript: lines marked "Me:" are what I — the person you're helping — said; other labels ("Them:", or a participant's name) are other people in the room. Unless I tell you otherwise, help me with the most recent thing directed at me.

How to respond:
- Lead with the answer. No preamble, no "Sure, here's…", no narrating what you're about to do.
- When you're drafting something for me to say, write it in the first person, as me, and ready to read aloud.
- Keep it tight and speakable — a sentence or two, or a few short bullets. Go longer only when I ask you to explain.
- Stay grounded in my context, the transcript, and any screenshot or research I've shared. If you're unsure or the transcript is ambiguous, say so briefly — never invent facts, names, or numbers.
- You can read the project's files and code on demand, but only when a question truly needs detail beyond what's already in front of you. Otherwise answer directly and fast.`,

  // Intent prompts (per-trigger instruction — the persona carries the universal rules,
  // so these just name the specific ask).
  intent_answer_prompt:
    `Answer the question that's currently on the table for me — work out what's actually being asked from the conversation, not just the last line. Often a question gets asked and then the participant keeps talking (clarifying, adding detail or an example); fold that in and answer the complete question. If several distinct questions are open, cover each briefly.`,
  intent_suggest_prompt:
    `I may not have been asked anything directly. Give me 2–3 short options for what to say next or how to steer the conversation.`,
  intent_askback_prompt:
    `Give me one sharp question to ask right now — to clarify, dig deeper, or move things forward.`,
  intent_explain_prompt:
    `Walk me through the current topic so I can talk it out loud — a clear, structured explanation with points I can expand on. Going a bit longer is fine here.`,

  // Screenshot analysis (separate vision pass — the main assistant only sees this description)
  prompt_screenshot:
    `You are the eyes of a live meeting assistant — the main assistant cannot see the screen, only your description. A screenshot was just captured during a meeting. Read the image carefully and write a thorough, structured account of everything on it that could matter.

Capture content VERBATIM where it carries meaning:
- Questions, prompts, or problem statements — quote them in full.
- Code — reproduce the relevant code, note the language and what it does.
- Errors, stack traces, logs, or terminal output — copy the exact text.
- Diagrams, tables, slides, or documents — lay out their structure and the actual text/labels.
- Relevant UI or application state.

Then interpret it using the recent transcript and project context: what is this — a coding problem to solve, an error to debug, something a participant is presenting, a document under review? State clearly what (if anything) is being asked of me.

Be complete and precise rather than brief; the assistant acts solely on what you write.`,

  // The Scribe (separate fast-tier session that names diarized speakers from the conversation).
  // The per-turn JSON contract is enforced in code; this is the persona/judgment guidance.
  prompt_scribe:
    `You are the Scribe for a live meeting — a fast background helper that works out WHO each speaker is. You never talk to the user; you only return data.

The transcript labels people generically: "Me" is the person I'm assisting — ignore them, never give them a number. "Participant 1", "Participant 2", … are other people, numbered by a diarization system that is imperfect: it may split one person across two numbers, or briefly swap them.

I feed you new utterances as the meeting runs. When the conversation makes a participant's identity clear — they introduce themselves ("I'm Sarah"), are addressed by name ("Sarah, your take?"), sign off, or are clearly referred to — map that Participant number to their real name. Lean on the known-people roster for correct spellings and as candidates.

Be careful and stable:
- Assign a name ONLY when you are confident. A wrong name is worse than leaving it "Participant N".
- Only people who SPEAK are participants. A name merely mentioned in conversation ("ask Omar", "Akhil sent it") is NOT a participant — never assign it to a speaker.
- Once you've named someone, keep it — don't flip-flop on diarization noise.
- Never change an identity the user has fixed.`,

  // Research session (separate web+files session whose findings feed the main assistant)
  prompt_research:
    `You are my research assistant during a live meeting. I'll give you a question — dig into it with your tools: web search and fetch for anything external, file read for the project's code, transcript, and notes when the question relates to our work. Reason it through and verify rather than guess.

Write a thorough but tight answer the assistant can act on immediately: lead with the direct answer, then the key supporting detail. Cite web sources inline and prefer current, authoritative ones. Your findings are handed back to my live meeting copilot, so make them self-contained and factual.`,

  // Intent hotkeys (Electron accelerators)
  intent_answer_hotkey: 'CmdOrCtrl+Shift+A',
  intent_suggest_hotkey: 'CmdOrCtrl+Shift+D',
  intent_askback_hotkey: 'CmdOrCtrl+Shift+Q',
  intent_explain_hotkey: 'CmdOrCtrl+Shift+E',
};

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Settings ---

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// --- Projects ---

export function createProject(data: { name: string; description?: string; codebase_path?: string }): Project {
  const id = crypto.randomUUID();
  const slug = slugify(data.name);
  const stmt = getDb().prepare(`
    INSERT INTO projects (id, name, description, codebase_path, slug)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, data.name, data.description ?? '', data.codebase_path ?? '', slug);
  return getProject(id)!;
}

export function getProject(id: string): Project | undefined {
  return getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function listProjects(): Project[] {
  return getDb().prepare('SELECT * FROM projects ORDER BY rowid DESC').all() as Project[];
}

export function updateProject(id: string, data: Partial<Pick<Project, 'name' | 'description' | 'codebase_path'>>): Project | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  if (data.codebase_path !== undefined) { fields.push('codebase_path = ?'); values.push(data.codebase_path); }

  if (fields.length === 0) return getProject(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  getDb().prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getProject(id);
}

export function deleteProject(id: string): boolean {
  const result = getDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Meetings ---

export function createMeeting(data: { title: string; project_id?: string | null; directory_path: string; file_prefix?: string }): Meeting {
  const id = crypto.randomUUID();
  const slug = slugify(data.title);
  const stmt = getDb().prepare(`
    INSERT INTO meetings (id, project_id, title, slug, directory_path, file_prefix)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, data.project_id ?? null, data.title, slug, data.directory_path, data.file_prefix ?? '');
  return getMeeting(id)!;
}

export function getMeeting(id: string): Meeting | undefined {
  return getDb().prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Meeting | undefined;
}

export function listMeetings(filters?: { project_id?: string | null }): Meeting[] {
  if (filters?.project_id !== undefined) {
    if (filters.project_id === null) {
      return getDb().prepare('SELECT * FROM meetings WHERE project_id IS NULL ORDER BY created_at DESC').all() as Meeting[];
    }
    return getDb().prepare('SELECT * FROM meetings WHERE project_id = ? ORDER BY created_at DESC').all(filters.project_id) as Meeting[];
  }
  return getDb().prepare('SELECT * FROM meetings ORDER BY rowid DESC').all() as Meeting[];
}

export function updateMeeting(id: string, data: Partial<Pick<Meeting, 'title' | 'project_id' | 'status' | 'directory_path' | 'file_prefix'>>): Meeting | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
  if (data.project_id !== undefined) { fields.push('project_id = ?'); values.push(data.project_id); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  if (data.directory_path !== undefined) { fields.push('directory_path = ?'); values.push(data.directory_path); }
  if (data.file_prefix !== undefined) { fields.push('file_prefix = ?'); values.push(data.file_prefix); }

  if (fields.length === 0) return getMeeting(id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  getDb().prepare(`UPDATE meetings SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getMeeting(id);
}

export function deleteMeeting(id: string): boolean {
  const result = getDb().prepare('DELETE FROM meetings WHERE id = ?').run(id);
  return result.changes > 0;
}
