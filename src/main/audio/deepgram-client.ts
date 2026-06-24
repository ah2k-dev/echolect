import WebSocket from 'ws';

const SAMPLE_RATE = 16000;

// Deepgram only emits UtteranceEnd after `utterance_end_ms` of SILENCE. In continuous speech
// (e.g. a video, or people talking over each other) that pause never comes, so settled text
// would buffer forever as one growing interim blob and nothing would ever finalize — starving
// both the transcript file and the live assistant + Scribe (which are fed finalized lines).
// These cap the buffer by age and size so we finalize mid-stream without waiting for a pause.
const MAX_BUFFER_MS = 4000;
const MAX_BUFFER_WORDS = 20;

export interface DeepgramResult {
  text: string;
  isFinal: boolean;
  /** Diarized speaker index (0,1,2…) when diarization is on; undefined otherwise. */
  speaker?: number;
}

interface DeepgramOptions {
  /** Enable speaker diarization (used on the system/room stream; mic stays single-speaker). */
  diarize?: boolean;
}

interface DiarSegment { speaker: number; text: string; }

export class DeepgramClient {
  readonly name = 'deepgram';
  private apiKey: string;
  private opts: DeepgramOptions;
  private ws: WebSocket | null = null;
  private onResult: ((result: DeepgramResult) => void) | null = null;
  private pendingSegments: string[] = [];   // non-diarized buffer
  private pendingDiar: DiarSegment[] = [];   // diarized buffer (per contiguous-speaker run)
  private pendingStart = 0;                  // ms timestamp the current buffer began (0 = empty)

  constructor(apiKey: string, opts: DeepgramOptions = {}) {
    this.apiKey = apiKey;
    this.opts = opts;
  }

  // Emit the buffered settled text as finals and reset. Diarized: one final per speaker run,
  // after collapsing obvious single-word diarization flips.
  private flushPending(): void {
    if (this.opts.diarize) {
      for (const seg of this.coalesce(this.pendingDiar)) {
        if (seg.text.trim()) this.onResult?.({ text: seg.text.trim(), isFinal: true, speaker: seg.speaker });
      }
      this.pendingDiar = [];
      this.pendingStart = 0;
      return;
    }
    if (this.pendingSegments.length > 0) {
      this.onResult?.({ text: this.pendingSegments.join(' '), isFinal: true });
      this.pendingSegments = [];
    }
    this.pendingStart = 0;
  }

  private diarText(): string {
    return this.pendingDiar.map(s => s.text).join(' ').trim();
  }

  private bufferWordCount(): number {
    const text = this.opts.diarize ? this.diarText() : this.pendingSegments.join(' ');
    const t = text.trim();
    return t ? t.split(/\s+/).length : 0;
  }

  // Finalize now if Deepgram hit a speech endpoint, or the buffer has aged/grown past its cap.
  private shouldFlush(speechFinal: boolean): boolean {
    if (this.pendingStart === 0) return false;
    return speechFinal
      || Date.now() - this.pendingStart >= MAX_BUFFER_MS
      || this.bufferWordCount() >= MAX_BUFFER_WORDS;
  }

  // Collapse diarization noise: a tiny run (≤2 words) wedged between two runs of the SAME other
  // speaker is almost always a mis-attributed word, not a real turn — fold it into them. Also
  // merges adjacent same-speaker runs. Keeps live labels from sprouting phantom participants.
  private coalesce(segs: DiarSegment[]): DiarSegment[] {
    const out: DiarSegment[] = [];
    for (let i = 0; i < segs.length; i++) {
      const text = segs[i].text.trim();
      if (!text) continue;
      const speaker = segs[i].speaker;
      const prev = out[out.length - 1];
      const next = segs[i + 1];
      if (prev && prev.speaker === speaker) { prev.text += ' ' + text; continue; }
      if (prev && next && text.split(/\s+/).length <= 2 && prev.speaker === next.speaker && prev.speaker !== speaker) {
        prev.text += ' ' + text;
        continue;
      }
      out.push({ speaker, text });
    }
    return out;
  }

  connect(onResult: (result: DeepgramResult) => void): Promise<void> {
    this.onResult = onResult;
    this.pendingSegments = [];
    this.pendingDiar = [];
    this.pendingStart = 0;

    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: 'nova-3',
        language: 'en',
        smart_format: 'true',
        punctuate: 'true',
        interim_results: 'true',
        utterance_end_ms: '1500',
        encoding: 'linear16',
        sample_rate: String(SAMPLE_RATE),
        channels: '1',
      });
      if (this.opts.diarize) params.set('diarize', 'true');

      this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
        headers: { 'Authorization': `Token ${this.apiKey}` },
      });

      this.ws.on('open', () => resolve());

      this.ws.on('error', (err) => {
        if (this.ws?.readyState === WebSocket.CONNECTING) reject(err);
        else console.error('[deepgram] WebSocket error:', err);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'UtteranceEnd') { this.flushPending(); return; }
          if (msg.type !== 'Results') return;

          const alt = msg.channel?.alternatives?.[0];
          const transcript: string = alt?.transcript ?? '';
          const speechFinal = !!msg.speech_final;
          if (!transcript) {
            // Endpoint marker carrying no new text — still flush settled buffer.
            if ((msg.is_final || speechFinal) && this.shouldFlush(true)) this.flushPending();
            return;
          }

          if (this.opts.diarize) {
            this.handleDiarized(alt, transcript, !!msg.is_final, speechFinal);
            return;
          }

          if (msg.is_final) {
            this.pendingSegments.push(transcript.trim());
            if (this.pendingStart === 0) this.pendingStart = Date.now();
            if (this.shouldFlush(speechFinal)) this.flushPending();
            else this.onResult?.({ text: this.pendingSegments.join(' '), isFinal: false });
          } else {
            const accumulated = this.pendingSegments.length
              ? this.pendingSegments.join(' ') + ' ' + transcript.trim()
              : transcript.trim();
            this.onResult?.({ text: accumulated, isFinal: false });
          }
        } catch {
          // Ignore malformed messages
        }
      });

      this.ws.on('close', () => {
        this.flushPending();
        this.ws = null;
      });
    });
  }

  // Accumulate diarized words into contiguous-speaker runs; finalize on an endpoint or buffer
  // cap, otherwise emit the running text as interim.
  private handleDiarized(alt: any, transcript: string, isFinal: boolean, speechFinal: boolean): void {
    if (isFinal) {
      const words: any[] = Array.isArray(alt?.words) ? alt.words : [];
      if (words.length) {
        for (const w of words) {
          const sp: number = typeof w.speaker === 'number' ? w.speaker : 0;
          const t: string = (w.punctuated_word || w.word || '').trim();
          if (!t) continue;
          const last = this.pendingDiar[this.pendingDiar.length - 1];
          if (last && last.speaker === sp) last.text += ' ' + t;
          else this.pendingDiar.push({ speaker: sp, text: t });
        }
      } else {
        // No word-level speakers in this message — keep the text under the latest run.
        const last = this.pendingDiar[this.pendingDiar.length - 1];
        if (last) last.text += ' ' + transcript.trim();
        else this.pendingDiar.push({ speaker: 0, text: transcript.trim() });
      }
      if (this.pendingDiar.length && this.pendingStart === 0) this.pendingStart = Date.now();
      if (this.shouldFlush(speechFinal)) { this.flushPending(); return; }
      const lastSpk = this.pendingDiar[this.pendingDiar.length - 1]?.speaker;
      this.onResult?.({ text: this.diarText(), isFinal: false, speaker: lastSpk });
    } else {
      const acc = this.diarText();
      this.onResult?.({ text: (acc ? acc + ' ' : '') + transcript.trim(), isFinal: false });
    }
  }

  sendAudio(samples: Float32Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const int16 = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    this.ws.send(Buffer.from(int16.buffer));
  }

  close(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      this.ws.close();
      this.ws = null;
    }
    this.onResult = null;
    this.pendingSegments = [];
    this.pendingDiar = [];
    this.pendingStart = 0;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const params = new URLSearchParams({
        model: 'nova-3', encoding: 'linear16', sample_rate: String(SAMPLE_RATE), channels: '1',
      });
      const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
        headers: { 'Authorization': `Token ${this.apiKey}` },
      });
      return await new Promise((resolve) => {
        const timeout = setTimeout(() => { ws.close(); resolve(false); }, 5000);
        ws.on('open', () => { clearTimeout(timeout); ws.close(); resolve(true); });
        ws.on('error', () => { clearTimeout(timeout); resolve(false); });
      });
    } catch {
      return false;
    }
  }
}
