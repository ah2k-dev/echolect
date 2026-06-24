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

// --- Audio & Transcript types ---

export interface TranscriptEntry {
  id: string;
  timestamp: number;
  speaker: string;
  speakerType: 'user' | 'participant';
  text: string;
  isFinal: boolean;
  source: 'mic' | 'system';
  participantIndex: number;
}

export interface VadEvent {
  type: 'speech-start' | 'speech-end';
  timestamp: number;
  source: 'mic' | 'system';
  confidence: number;
}

export interface SttResult {
  text: string;
  isFinal: boolean;
  language: string;
  timestamp: number;
  duration: number;
  source: 'mic' | 'system';
}

export const IPC_CHANNELS = {
  AUDIO_DATA: 'audio:data',
  AUDIO_START: 'audio:start',
  AUDIO_STOP: 'audio:stop',
  RECORDING_SAVE: 'recording:save',
  TRANSCRIPT_NEW_ENTRY: 'transcript:new-entry',
  TRANSCRIPT_UPDATE_ENTRY: 'transcript:update-entry',
  TRANSCRIPT_FINALIZE_ENTRY: 'transcript:finalize-entry',
  SCREENSHOT_CAPTURE_REQUEST: 'screenshot:capture-request',
  SCREENSHOT_SAVE: 'screenshot:save',
  SCREENSHOT_CAPTURED: 'screenshot:captured',
  AI_SESSION_TOKEN: 'ai-session:token',
  AI_SESSION_TURN: 'ai-session:turn',
  AI_SESSION_ERROR: 'ai-session:error',
  AI_SESSION_CLOSED: 'ai-session:closed',
  ASSIST_TOKEN: 'assist:token',
  ASSIST_TURN: 'assist:turn',
  ASSIST_ERROR: 'assist:error',
  ASSIST_TRIGGER: 'assist:trigger',
  RESEARCH_TOKEN: 'research:token',
  RESEARCH_TURN: 'research:turn',
  RESEARCH_ERROR: 'research:error',
  SCRIBE_SPEAKERS: 'scribe:speakers',
  SCRIBE_SUMMARY: 'scribe:summary',
} as const;

// --- Electron API ---

export interface ElectronAPI {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
