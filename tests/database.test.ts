import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock electron before importing database module
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return path.join(os.tmpdir(), 'meeting-assistant-test-db');
      if (key === 'home') return os.tmpdir();
      return os.tmpdir();
    },
  },
}));

import {
  initDatabase, closeDatabase,
  createProject, getProject, listProjects, updateProject, deleteProject,
  createMeeting, getMeeting, listMeetings, updateMeeting, deleteMeeting,
} from '../src/main/database.js';

let dbPath: string;

beforeEach(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-test-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  initDatabase(dbPath);
});

afterEach(() => {
  closeDatabase();
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    // Clean up WAL/SHM files
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
  }
});

describe('Projects CRUD', () => {
  it('should create and retrieve a project', () => {
    const project = createProject({ name: 'Test Project', description: 'A test' });
    expect(project.id).toBeDefined();
    expect(project.name).toBe('Test Project');
    expect(project.description).toBe('A test');
    expect(project.slug).toMatch(/^test-project-/);

    const fetched = getProject(project.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe('Test Project');
  });

  it('should list projects in descending creation order', () => {
    createProject({ name: 'Alpha' });
    createProject({ name: 'Beta' });
    const list = listProjects();
    expect(list.length).toBe(2);
    // Most recent first
    expect(list[0].name).toBe('Beta');
    expect(list[1].name).toBe('Alpha');
  });

  it('should update a project', () => {
    const project = createProject({ name: 'Original' });
    const updated = updateProject(project.id, { name: 'Updated', description: 'New desc' });
    expect(updated!.name).toBe('Updated');
    expect(updated!.description).toBe('New desc');
    // Slug should remain unchanged
    expect(updated!.slug).toBe(project.slug);
  });

  it('should delete a project', () => {
    const project = createProject({ name: 'To Delete' });
    const deleted = deleteProject(project.id);
    expect(deleted).toBe(true);
    expect(getProject(project.id)).toBeUndefined();
  });

  it('should generate unique slugs', () => {
    const p1 = createProject({ name: 'Same Name' });
    // Slug has timestamp suffix so should be unique even with same name
    const p2 = createProject({ name: 'Same Name' });
    expect(p1.slug).not.toBe(p2.slug);
  });
});

describe('Meetings CRUD', () => {
  it('should create and retrieve a meeting', () => {
    const meeting = createMeeting({
      title: 'Kickoff',
      directory_path: '/tmp/meetings/kickoff',
    });
    expect(meeting.id).toBeDefined();
    expect(meeting.title).toBe('Kickoff');
    expect(meeting.status).toBe('idle');
    expect(meeting.project_id).toBeNull();

    const fetched = getMeeting(meeting.id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe('Kickoff');
  });

  it('should create a meeting with project_id', () => {
    const project = createProject({ name: 'Proj' });
    const meeting = createMeeting({
      title: 'Sprint',
      project_id: project.id,
      directory_path: '/tmp/meetings/sprint',
    });
    expect(meeting.project_id).toBe(project.id);
  });

  it('should list all meetings', () => {
    createMeeting({ title: 'M1', directory_path: '/tmp/m1' });
    createMeeting({ title: 'M2', directory_path: '/tmp/m2' });
    const list = listMeetings();
    expect(list.length).toBe(2);
  });

  it('should filter meetings by project_id', () => {
    const project = createProject({ name: 'Proj' });
    createMeeting({ title: 'M1', project_id: project.id, directory_path: '/tmp/m1' });
    createMeeting({ title: 'M2', directory_path: '/tmp/m2' });

    const projectMeetings = listMeetings({ project_id: project.id });
    expect(projectMeetings.length).toBe(1);
    expect(projectMeetings[0].title).toBe('M1');

    const generalMeetings = listMeetings({ project_id: null });
    expect(generalMeetings.length).toBe(1);
    expect(generalMeetings[0].title).toBe('M2');
  });

  it('should update a meeting', () => {
    const meeting = createMeeting({ title: 'Old', directory_path: '/tmp/old' });
    const updated = updateMeeting(meeting.id, { title: 'New', status: 'active' });
    expect(updated!.title).toBe('New');
    expect(updated!.status).toBe('active');
  });

  it('should delete a meeting', () => {
    const meeting = createMeeting({ title: 'Del', directory_path: '/tmp/del' });
    expect(deleteMeeting(meeting.id)).toBe(true);
    expect(getMeeting(meeting.id)).toBeUndefined();
  });

  it('should set project_id to null when project is deleted (ON DELETE SET NULL)', () => {
    const project = createProject({ name: 'Proj' });
    const meeting = createMeeting({ title: 'M', project_id: project.id, directory_path: '/tmp/m' });
    deleteProject(project.id);
    const updated = getMeeting(meeting.id);
    expect(updated!.project_id).toBeNull();
  });
});
