import type { BrowserWindow } from 'electron';
import type { TranscriptEntry } from '../../renderer/shared/types/ipc.js';
import { IPC_CHANNELS } from '../../renderer/shared/types/ipc.js';

const MAX_BUFFER_SIZE = 200;

interface BufferedMessage {
  channel: string;
  data: TranscriptEntry;
}

export class TranscriptIpcBridge {
  private targets: BrowserWindow[] = [];
  private buffer: BufferedMessage[] = [];

  addTarget(win: BrowserWindow): void {
    this.targets.push(win);
    win.on('closed', () => {
      this.targets = this.targets.filter(w => w !== win);
    });

    // Flush buffered messages to the new window
    if (this.buffer.length > 0) {
      for (const msg of this.buffer) {
        if (!win.isDestroyed()) {
          win.webContents.send(msg.channel, msg.data);
        }
      }
      this.buffer = [];
    }
  }

  sendNewEntry(entry: TranscriptEntry): void {
    this.send(IPC_CHANNELS.TRANSCRIPT_NEW_ENTRY, entry);
  }

  sendUpdateEntry(entry: TranscriptEntry): void {
    this.send(IPC_CHANNELS.TRANSCRIPT_UPDATE_ENTRY, entry);
  }

  sendFinalizeEntry(entry: TranscriptEntry): void {
    this.send(IPC_CHANNELS.TRANSCRIPT_FINALIZE_ENTRY, entry);
  }

  private send(channel: string, data: TranscriptEntry): void {
    const liveTargets = this.targets.filter(w => !w.isDestroyed());
    this.targets = liveTargets;

    if (liveTargets.length === 0) {
      if (this.buffer.length < MAX_BUFFER_SIZE) {
        this.buffer.push({ channel, data });
      }
      return;
    }

    for (const win of liveTargets) {
      win.webContents.send(channel, data);
    }
  }

  destroy(): void {
    this.targets = [];
    this.buffer = [];
  }
}
