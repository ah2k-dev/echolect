import { app } from 'electron';
import fs from 'fs';
import path from 'path';

let baseDir: string;

export function getBaseDir(): string {
  if (!baseDir) {
    baseDir = path.join(app.getPath('home'), 'Echolect');
  }
  return baseDir;
}

export function setBaseDir(dir: string): void {
  baseDir = dir;
}

export function ensureBaseDir(): void {
  const base = getBaseDir();
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(path.join(base, 'General'), { recursive: true });
}

// --- Personal context (global knowledge, lives as an editable .md file) ---
// A file (not a DB row) because it's knowledge, not config: editable in any editor and
// readable directly by the Claude CLI via --add-dir. See the live-assist design spec.

export function getPersonalContextPath(): string {
  return path.join(getBaseDir(), 'personal-context.md');
}

export function readPersonalContext(): string {
  const p = getPersonalContextPath();
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

export function writePersonalContext(content: string): void {
  fs.writeFileSync(getPersonalContextPath(), content, 'utf-8');
}

export function createProjectDir(projectName: string, description?: string): string {
  const dir = path.join(getBaseDir(), projectName);
  fs.mkdirSync(dir, { recursive: true });
  const content = description?.trim()
    ? `# ${projectName}\n\n${description.trim()}\n`
    : `# ${projectName}\n`;
  fs.writeFileSync(path.join(dir, 'context.md'), content);
  return dir;
}

function formatDateStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, ' ');
}

/** The folder a meeting lives under: the project dir, or General for project-less meetings. */
function parentDirFor(projectName?: string | null): string {
  return projectName
    ? path.join(getBaseDir(), sanitizeName(projectName))
    : path.join(getBaseDir(), 'General');
}

/** A non-colliding directory path under `parent` for the given folder name. */
function uniqueDir(parent: string, folderName: string): string {
  let dir = path.join(parent, folderName);
  let n = 2;
  while (fs.existsSync(dir)) dir = path.join(parent, `${folderName}-${n++}`);
  return dir;
}

const MEETING_FILES = ['transcript.md', 'summary.md', 'chat.md'];

/**
 * Every meeting is its own SUBFOLDER inside its project (or General):
 *   Echolect/<project>/<title>-<date>/{transcript,summary,chat}.md + screenshots + recording
 *
 * `directory_path` (stored in DB) is the meeting folder; `filePrefix` is its folder name
 * (`<title>-<date>`) — kept for the title/date so renames can preserve the date.
 */
export function createMeetingFiles(meetingName: string, projectName?: string | null): { directory_path: string; filePrefix: string } {
  const parent = parentDirFor(projectName);
  fs.mkdirSync(parent, { recursive: true });
  const folderName = `${sanitizeName(meetingName)}-${formatDateStamp()}`;
  const meetingDir = uniqueDir(parent, folderName);
  fs.mkdirSync(meetingDir, { recursive: true });
  for (const f of MEETING_FILES) fs.writeFileSync(path.join(meetingDir, f), '');
  return { directory_path: meetingDir, filePrefix: path.basename(meetingDir) };
}

/** Move a meeting's folder to a different project (or General), keeping its folder name. */
export function moveMeetingDir(meetingDir: string, projectName?: string | null): { directory_path: string; filePrefix: string } {
  const parent = parentDirFor(projectName);
  fs.mkdirSync(parent, { recursive: true });
  const newDir = uniqueDir(parent, path.basename(meetingDir));
  if (fs.existsSync(meetingDir)) fs.renameSync(meetingDir, newDir);
  else fs.mkdirSync(newDir, { recursive: true });
  return { directory_path: newDir, filePrefix: path.basename(newDir) };
}

export function deleteMeetingFiles(directoryPath: string): void {
  if (fs.existsSync(directoryPath)) fs.rmSync(directoryPath, { recursive: true, force: true });
}

export function deleteProjectDir(projectName: string): void {
  const dir = path.join(getBaseDir(), sanitizeName(projectName));
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Rename a meeting's folder on disk to match a new title (keeps the original date suffix).
 * Returns the new directory path and folder name.
 */
export function renameMeetingDir(meetingDir: string, newTitle: string): { directory_path: string; filePrefix: string } {
  const oldName = path.basename(meetingDir);
  if (!fs.existsSync(meetingDir)) return { directory_path: meetingDir, filePrefix: oldName };
  const dateMatch = oldName.match(/(\d{8})(?:-\d+)?$/);
  const date = dateMatch ? dateMatch[1] : formatDateStamp();
  const newName = `${sanitizeName(newTitle)}-${date}`;
  if (newName === oldName) return { directory_path: meetingDir, filePrefix: oldName };
  const newDir = uniqueDir(path.dirname(meetingDir), newName);
  fs.renameSync(meetingDir, newDir);
  return { directory_path: newDir, filePrefix: path.basename(newDir) };
}

/** Rename a project's folder on disk. Returns the new directory path. */
export function renameProjectDir(oldName: string, newName: string): string {
  const oldDir = path.join(getBaseDir(), oldName);
  const newDir = path.join(getBaseDir(), newName);
  if (oldDir === newDir) return newDir;
  if (fs.existsSync(oldDir)) {
    fs.renameSync(oldDir, newDir);
  } else {
    fs.mkdirSync(newDir, { recursive: true });
  }
  return newDir;
}
