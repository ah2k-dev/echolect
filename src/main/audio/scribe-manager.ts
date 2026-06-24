import { EventEmitter } from 'events';
import { createSession } from '../llm/provider.js';
import { getSetting } from '../database.js';
import type { LLMSession } from '../llm/types.js';

export interface SpeakerName {
  name: string;
  /** True once the user has manually renamed this speaker — the Scribe may never override it. */
  locked: boolean;
}

interface ScribeOptions {
  /** Neutral cwd for the spawned session (the meeting folder). */
  cwd?: string;
  /** The project's PEOPLE roster (markdown) — seeds candidate names + spellings. */
  roster?: string;
}

// The running summary refreshes on a SLOWER cadence than naming — naming stays per-utterance,
// the summary only on every Nth finalized utterance or after T ms, whichever comes first. Kept
// snappy enough to feel live without a summary turn on every utterance.
const SUMMARY_EVERY_UTTERANCES = 5;
const SUMMARY_EVERY_MS = 10_000;
const SUMMARY_MARKER = '===SUMMARY===';

/** Strip code fences / prose and parse the first {...} object out of a model reply. */
export function parseJsonObject(text: string): any | null {
  if (!text) return null;
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

/**
 * The Scribe — a warm, fast-tier session that turns Deepgram's generic "Participant N"
 * diarization labels into real names. It's fed each finalized utterance (mic + system),
 * coalesces while it's mid-turn so turns never pile up, and emits a `speakerIndex → name`
 * map the overlay resolves at render time. User renames lock an index so the Scribe can't
 * touch it.
 *
 * Map keys are the 1-based participant number shown in the UI ("Participant 2" → key 2),
 * matching TranscriptEntry.participantIndex. "Me"/mic (index 0) is never named.
 *
 * It ALSO maintains a live running summary on a slower cadence (the Scribe's second job), which
 * seeds the final end-of-meeting summary.
 *
 * Events:
 *   'names'   (Record<number,string>) — the assignment map changed; push to the overlay.
 *   'summary' (string)                — the running summary was updated (markdown).
 */
export class ScribeManager extends EventEmitter {
  private session: LLMSession | null = null;
  private names = new Map<number, SpeakerName>();
  private pending: string[] = [];   // utterances queued while the session is mid-turn
  private busy = false;
  private warming = true;
  private summary = '';             // live running summary (markdown)
  private utterSinceSummary = 0;    // finalized utterances fed since the last summary refresh
  private lastSummaryAt = 0;        // ms timestamp of the last summary refresh

  constructor(private opts: ScribeOptions = {}) { super(); }

  start(): void {
    if (this.session) return;
    const persona = getSetting('prompt_scribe') || '';
    const systemPrompt = [
      persona,
      this.opts.roster ? `# Known people on this project (roster)\nUse these for correct spellings and as candidates.\n${this.opts.roster}` : '',
    ].filter(Boolean).join('\n\n');

    // No tools, no addDirs: pure reasoning over the utterances we feed it. The per-turn
    // instruction (buildTurn) re-states the JSON contract so it holds even if the persona is edited.
    this.session = createSession({
      model: 'haiku',
      cliPath: getSetting('claude_cli_path') || undefined,
      cwd: this.opts.cwd,
      systemPrompt,
    });
    this.session.on('turn', (f: string) => this.onTurn(f));
    this.session.on('error', () => { this.busy = false; this.flush(); });
    this.session.on('close', () => { this.session = null; });

    this.warming = true;
    this.busy = true;
    this.session.start();
    this.session.send('You are the Scribe for a live meeting. Reply with exactly: READY');
  }

  /** Feed one finalized utterance. `label` is "Me" for the user or "Participant N" for others. */
  feedUtterance(label: string, text: string): void {
    if (!text.trim()) return;
    this.pending.push(`${label}: ${text.trim()}`);
    this.utterSinceSummary++;
    this.flush();
  }

  private flush(): void {
    if (!this.session || this.busy || this.pending.length === 0) return;
    const batch = this.pending.join('\n');
    this.pending = [];
    this.busy = true;
    const summaryDue = !this.warming && (
      this.utterSinceSummary >= SUMMARY_EVERY_UTTERANCES ||
      (this.lastSummaryAt > 0 && Date.now() - this.lastSummaryAt >= SUMMARY_EVERY_MS)
    );
    if (summaryDue) { this.utterSinceSummary = 0; this.lastSummaryAt = Date.now(); }
    this.session.send(this.buildTurn(batch, summaryDue));
  }

  private buildTurn(batch: string, summaryDue: boolean): string {
    const locked = [...this.names.entries()]
      .filter(([, v]) => v.locked)
      .map(([i, v]) => `Participant ${i} = ${v.name}`)
      .join('; ');
    const parts = [
      `New utterances since your last reply:`,
      batch,
      locked ? `FIXED by the user — keep these exactly, never reassign: ${locked}` : '',
      `Only name people who actually SPEAK (who have a Participant number in the text). A name merely mentioned in conversation ("tell Omar", "Akhil said…") is NOT a participant — never create or assign one for it.`,
      `Reply with the JSON object (no prose, no code fences): {"assignments":[{"speaker":<participant number>,"name":"<real name>","confidence":"high"}]}. Include a speaker ONLY when you can name them with HIGH confidence. Use an empty array when there is nothing new.`,
    ];
    if (summaryDue) {
      parts.push(
        `Then ALSO refresh the running meeting summary. Current summary:\n${this.summary || '(none yet)'}`,
        `Integrate the new utterances and re-condense — this is a LIVE summary, not a transcript, so keep it tight. Use only these markdown sections, omitting any that are empty: **Discussion**, **Decisions**, **Action items**, **Open questions**.`,
        `After the JSON object, output a line containing exactly ${SUMMARY_MARKER} and then the updated summary markdown.`,
      );
    }
    return parts.filter(Boolean).join('\n\n');
  }

  private onTurn(full: string): void {
    if (this.warming) { this.warming = false; this.busy = false; this.lastSummaryAt = Date.now(); this.flush(); return; }
    this.busy = false;
    this.applyResult(full);
    this.flush();
  }

  private applyResult(text: string): void {
    const markerAt = text.indexOf(SUMMARY_MARKER);
    const head = markerAt >= 0 ? text.slice(0, markerAt) : text;
    const summaryText = markerAt >= 0 ? text.slice(markerAt + SUMMARY_MARKER.length).trim() : '';

    const parsed = parseJsonObject(head);
    if (parsed) {
      let changed = false;
      for (const a of Array.isArray(parsed.assignments) ? parsed.assignments : []) {
        const idx = typeof a?.speaker === 'number' ? a.speaker : parseInt(a?.speaker, 10);
        const name = typeof a?.name === 'string' ? a.name.trim() : '';
        if (!(idx >= 1) || !name) continue;
        if (a?.confidence && a.confidence !== 'high') continue;
        const existing = this.names.get(idx);
        if (existing?.locked) continue;          // never override a user lock
        if (existing?.name === name) continue;
        this.names.set(idx, { name, locked: false });
        changed = true;
      }
      if (changed) this.emit('names', this.snapshot());
    }

    if (summaryText) { this.summary = summaryText; this.emit('summary', summaryText); }
  }

  /** User correction from the overlay legend. Empty name clears the assignment. */
  rename(idx: number, name: string): void {
    const clean = (name || '').trim();
    if (!(idx >= 1)) return;
    if (!clean) this.names.delete(idx);
    else this.names.set(idx, { name: clean, locked: true });
    this.emit('names', this.snapshot());
  }

  snapshot(): Record<number, string> {
    const out: Record<number, string> = {};
    for (const [i, v] of this.names) out[i] = v.name;
    return out;
  }

  /** Live map (incl. lock state) for the end-of-meeting reconciliation. */
  getNames(): Map<number, SpeakerName> { return this.names; }

  /** The latest running summary (markdown) — seeds the final end-of-meeting summary. */
  getSummary(): string { return this.summary; }

  close(): void {
    this.session?.close();
    this.session = null;
    this.pending = [];
  }
}
