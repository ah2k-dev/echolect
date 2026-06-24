import fs from 'fs';
import path from 'path';
import { SpeakerManager } from './speaker-manager.js';
import { TranscriptIpcBridge } from './transcript-ipc-bridge.js';
import { DeepgramClient } from './deepgram-client.js';
import type { DeepgramResult } from './deepgram-client.js';
import type { TranscriptEntry } from '../../renderer/shared/types/ipc.js';
import type { BrowserWindow } from 'electron';

const DEDUP_WINDOW_MS = 4000;
const DEDUP_OVERLAP_THRESHOLD = 0.5;

interface RecentTranscript {
  text: string;
  timestamp: number;
}

export class AudioPipeline {
  private apiKey: string;
  private speakerManager: SpeakerManager;
  private ipcBridge: TranscriptIpcBridge;

  private micClient: DeepgramClient | null = null;
  private systemClient: DeepgramClient | null = null;
  private isRunning = false;
  private interimEntryIds: Map<string, string> = new Map();
  private transcriptFilePath: string | null = null;
  private recentSystemTranscripts: RecentTranscript[] = [];
  private finalEntryListener: ((entry: TranscriptEntry) => void) | null = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.speakerManager = new SpeakerManager();
    this.ipcBridge = new TranscriptIpcBridge();
  }

  addTargetWindow(win: BrowserWindow): void {
    this.ipcBridge.addTarget(win);
  }

  /** Notified for every finalized transcript entry — the Scribe consumes these for naming. */
  setFinalEntryListener(fn: (entry: TranscriptEntry) => void): void {
    this.finalEntryListener = fn;
  }

  setTranscriptFile(directoryPath: string): void {
    // Every meeting is its own folder now — transcript is always <dir>/transcript.md
    this.transcriptFilePath = path.join(directoryPath, 'transcript.md');
  }

  private appendToTranscriptFile(entry: TranscriptEntry): void {
    if (!this.transcriptFilePath) return;
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const line = `**${entry.speaker}** (${time}): ${entry.text}\n\n`;
    fs.appendFileSync(this.transcriptFilePath, line, 'utf-8');
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.micClient = new DeepgramClient(this.apiKey);                    // single speaker (you)
    this.systemClient = new DeepgramClient(this.apiKey, { diarize: true }); // multiple participants

    try {
      await Promise.all([
        this.micClient.connect((result) => this.onResult(result, 'mic')),
        this.systemClient.connect((result) => this.onResult(result, 'system')),
      ]);
    } catch (err) {
      console.error('[pipeline] Failed to connect to Deepgram:', err);
      throw err;
    }

    this.isRunning = true;
  }

  private onResult(result: DeepgramResult, source: 'mic' | 'system'): void {
    if (!result.text) return;

    // Track system transcripts for dedup
    if (source === 'system' && result.isFinal) {
      this.recentSystemTranscripts.push({ text: result.text, timestamp: Date.now() });
      this.pruneRecentTranscripts();
    }

    // Dedup: skip mic results that echo system audio
    if (source === 'mic' && result.isFinal && this.isDuplicate(result.text)) {
      return;
    }

    if (result.isFinal) {
      this.interimEntryIds.delete(source);
      const entry = this.speakerManager.createTranscriptEntry(result.text, source, true, result.speaker);
      this.ipcBridge.sendFinalizeEntry(entry);
      this.appendToTranscriptFile(entry);
      this.finalEntryListener?.(entry);
    } else {
      const entry = this.speakerManager.createTranscriptEntry(result.text, source, false, result.speaker);
      const existingId = this.interimEntryIds.get(source);
      if (existingId) {
        entry.id = existingId;
        this.ipcBridge.sendUpdateEntry(entry);
      } else {
        this.interimEntryIds.set(source, entry.id);
        this.ipcBridge.sendNewEntry(entry);
      }
    }
  }

  private isDuplicate(micText: string): boolean {
    const micWords = micText.toLowerCase().split(/\s+/);
    if (micWords.length === 0) return false;

    for (const recent of this.recentSystemTranscripts) {
      const sysWords = new Set(recent.text.toLowerCase().split(/\s+/));
      let overlap = 0;
      for (const word of micWords) {
        if (sysWords.has(word)) overlap++;
      }
      if (overlap / micWords.length >= DEDUP_OVERLAP_THRESHOLD) {
        return true;
      }
    }
    return false;
  }

  private pruneRecentTranscripts(): void {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    this.recentSystemTranscripts = this.recentSystemTranscripts.filter(t => t.timestamp > cutoff);
  }

  async feedAudio(samples: Float32Array, source: 'mic' | 'system'): Promise<void> {
    if (!this.isRunning) return;

    if (source === 'mic') {
      this.micClient?.sendAudio(samples);
    } else {
      this.systemClient?.sendAudio(samples);
    }
  }

  stop(): void {
    this.isRunning = false;
    this.micClient?.close();
    this.systemClient?.close();
    this.micClient = null;
    this.systemClient = null;
    this.interimEntryIds.clear();
    this.recentSystemTranscripts = [];
    this.finalEntryListener = null;
  }

  destroy(): void {
    this.stop();
    this.speakerManager.reset();
    this.ipcBridge.destroy();
  }
}
