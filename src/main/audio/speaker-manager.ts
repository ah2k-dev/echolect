import { randomUUID } from 'crypto';
import type { TranscriptEntry } from '../../renderer/shared/types/ipc.js';

export class SpeakerManager {
  createTranscriptEntry(
    text: string,
    source: 'mic' | 'system',
    isFinal: boolean,
    speakerIndex?: number,
  ): TranscriptEntry {
    // Mic is always the user. System audio is diarized → "Participant N" (1-based); a label the
    // Scribe later refines into real names. Falls back to "Participant" if diarization gives nothing.
    const isUser = source === 'mic';
    const idx = typeof speakerIndex === 'number' ? speakerIndex : null;
    return {
      id: randomUUID(),
      timestamp: Date.now(),
      speaker: isUser ? 'You' : idx !== null ? `Participant ${idx + 1}` : 'Participant',
      speakerType: isUser ? 'user' : 'participant',
      text,
      isFinal,
      source,
      participantIndex: isUser ? 0 : idx !== null ? idx + 1 : 1,
    };
  }

  reset(): void {
    // No state to reset
  }
}
