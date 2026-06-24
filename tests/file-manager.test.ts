import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// file-manager imports `app` from electron only for the default base dir; every test overrides
// that with setBaseDir(), so a minimal mock is enough to let the module import.
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import {
  setBaseDir, getBaseDir, ensureBaseDir,
  createProjectDir, deleteProjectDir,
  createMeetingFiles, moveMeetingDir, renameMeetingDir, deleteMeetingFiles,
  getPersonalContextPath, readPersonalContext, writePersonalContext,
} from '../src/main/file-manager.js';

const MEETING_FILES = ['transcript.md', 'summary.md', 'chat.md'];
const DATE_SUFFIX = /-(\d{8})(?:-\d+)?$/;

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'echolect-fm-'));
  setBaseDir(base);
  ensureBaseDir();
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('file-manager — base + personal context', () => {
  it('ensureBaseDir creates the base dir and a General folder', () => {
    expect(getBaseDir()).toBe(base);
    expect(fs.existsSync(base)).toBe(true);
    expect(fs.existsSync(path.join(base, 'General'))).toBe(true);
  });

  it('writes then reads personal context round-trip', () => {
    expect(readPersonalContext()).toBe('');
    writePersonalContext('# Me\nSenior engineer.');
    expect(getPersonalContextPath()).toBe(path.join(base, 'personal-context.md'));
    expect(readPersonalContext()).toBe('# Me\nSenior engineer.');
  });
});

describe('file-manager — projects', () => {
  it('createProjectDir creates <base>/<name>/context.md', () => {
    const dir = createProjectDir('Acme Corp', 'A client.');
    expect(dir).toBe(path.join(base, 'Acme Corp'));
    expect(fs.existsSync(dir)).toBe(true);
    const ctx = fs.readFileSync(path.join(dir, 'context.md'), 'utf-8');
    expect(ctx).toContain('# Acme Corp');
    expect(ctx).toContain('A client.');
  });

  it('deleteProjectDir removes the project folder', () => {
    createProjectDir('Temp');
    expect(fs.existsSync(path.join(base, 'Temp'))).toBe(true);
    deleteProjectDir('Temp');
    expect(fs.existsSync(path.join(base, 'Temp'))).toBe(false);
  });
});

describe('file-manager — meeting folders', () => {
  it('creates a project meeting as its own subfolder with three empty files', () => {
    createProjectDir('Acme');
    const { directory_path, filePrefix } = createMeetingFiles('Kickoff Call', 'Acme');

    // <base>/Acme/<title>-<YYYYMMDD>/
    expect(path.dirname(directory_path)).toBe(path.join(base, 'Acme'));
    expect(path.basename(directory_path)).toBe(filePrefix);
    expect(filePrefix).toMatch(/^Kickoff Call-\d{8}$/);

    for (const f of MEETING_FILES) {
      const p = path.join(directory_path, f);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.readFileSync(p, 'utf-8')).toBe('');
    }
  });

  it('puts a project-less meeting under General', () => {
    const { directory_path } = createMeetingFiles('Standup', null);
    expect(path.dirname(directory_path)).toBe(path.join(base, 'General'));
  });

  it('gives a colliding meeting (same title, same day) a unique folder', () => {
    createProjectDir('Acme');
    const a = createMeetingFiles('Review', 'Acme');
    const b = createMeetingFiles('Review', 'Acme');
    expect(b.directory_path).not.toBe(a.directory_path);
    expect(fs.existsSync(a.directory_path)).toBe(true);
    expect(fs.existsSync(b.directory_path)).toBe(true);
  });

  it('deleteMeetingFiles removes the meeting folder', () => {
    const { directory_path } = createMeetingFiles('Throwaway', null);
    expect(fs.existsSync(directory_path)).toBe(true);
    deleteMeetingFiles(directory_path);
    expect(fs.existsSync(directory_path)).toBe(false);
  });
});

describe('file-manager — move + rename', () => {
  it('moves a meeting between projects, keeping its folder name and files', () => {
    createProjectDir('A');
    createProjectDir('B');
    const created = createMeetingFiles('Sync', 'A');
    fs.writeFileSync(path.join(created.directory_path, 'transcript.md'), 'hello');

    const moved = moveMeetingDir(created.directory_path, 'B');
    expect(path.dirname(moved.directory_path)).toBe(path.join(base, 'B'));
    expect(moved.filePrefix).toBe(created.filePrefix);          // same folder name
    expect(fs.existsSync(created.directory_path)).toBe(false);  // old gone
    expect(fs.readFileSync(path.join(moved.directory_path, 'transcript.md'), 'utf-8')).toBe('hello');
  });

  it('moves a meeting out to General when given no project', () => {
    createProjectDir('A');
    const created = createMeetingFiles('Sync', 'A');
    const moved = moveMeetingDir(created.directory_path, null);
    expect(path.dirname(moved.directory_path)).toBe(path.join(base, 'General'));
  });

  it('renames a meeting folder while preserving the date suffix', () => {
    createProjectDir('Acme');
    const created = createMeetingFiles('Old Title', 'Acme');
    const date = created.filePrefix.match(DATE_SUFFIX)![1];

    const renamed = renameMeetingDir(created.directory_path, 'New Title');
    expect(renamed.filePrefix).toBe(`New Title-${date}`);       // date preserved
    expect(path.dirname(renamed.directory_path)).toBe(path.join(base, 'Acme'));
    expect(fs.existsSync(created.directory_path)).toBe(false);
    expect(fs.existsSync(renamed.directory_path)).toBe(true);
  });
});
