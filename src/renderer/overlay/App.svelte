<script lang="ts">
  import type { Meeting, TranscriptEntry } from '$shared/types/ipc.js';
  import { IPC_CHANNELS } from '$shared/types/ipc.js';
  import { tick } from 'svelte';

  let meeting = $state<Meeting | null>(null);
  let elapsed = $state(0);
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let transcriptEntries = $state<TranscriptEntry[]>([]);
  // Scribe-assigned real names, keyed by participantIndex (1-based: "Participant 2" → key 2).
  // Resolved at render time, so learning a name retro-relabels every past line of that speaker.
  let speakerNames = $state<Record<number, string>>({});
  // Live running summary maintained by the Scribe (markdown).
  let scribeSummary = $state('');
  let showScreenshotToast = $state(false);
  let screenshotToastTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Layout ---
  // At most TWO of the three panels open at once (transcript / assist / summary). Opening a
  // third drops the one opened earliest, so you only ever see a pair.
  type Panel = 'transcript' | 'assist' | 'summary';
  let openPanels = $state<Panel[]>([]);
  const showTranscript = $derived(openPanels.includes('transcript'));
  const showAssist = $derived(openPanels.includes('assist'));
  const showSummary = $derived(openPanels.includes('summary'));
  function togglePanel(p: Panel) {
    if (openPanels.includes(p)) { openPanels = openPanels.filter(x => x !== p); return; }
    const next: Panel[] = [...openPanels, p];
    if (next.length > 2) next.shift();   // drop the oldest-opened to keep at most two
    openPanels = next;
  }
  let micLevel = $state(0);
  let sysLevel = $state(0);
  let overlayOpacity = $state(0.94);

  // Esc collapses all panels back to the bar
  function onOverlayKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') openPanels = [];
  }

  const speakerEntries = $derived(transcriptEntries.filter(e => e.source === 'system'));
  const micEntries = $derived(transcriptEntries.filter(e => e.source === 'mic'));
  // Distinct participant numbers seen so far — drives the rename legend.
  const activeParticipants = $derived(
    [...new Set(speakerEntries.map(e => e.participantIndex))].sort((a, b) => a - b)
  );
  const latest = $derived(transcriptEntries.length ? transcriptEntries[transcriptEntries.length - 1] : null);

  // Auto-scroll the transcript panel(s) to the newest line as it streams in.
  let speakerBody = $state<HTMLElement | null>(null);
  let micBody = $state<HTMLElement | null>(null);
  let tlistEl = $state<HTMLElement | null>(null);
  $effect(() => {
    // Re-run on every transcript change (new line or interim text growth)
    transcriptEntries.length;
    transcriptEntries.at(-1)?.text;
    tick().then(() => {
      for (const el of [speakerBody, micBody, tlistEl]) if (el) el.scrollTop = el.scrollHeight;
    });
  });

  // Panel size — defaults, overridable by drag-to-resize (persists for the session)
  let panelH = $state(332);
  let userW = $state<number | null>(null);

  // Grow/shrink the window to match the open sections, honoring any drag override
  $effect(() => {
    const w = userW ?? (openPanels.length >= 2 ? 1000 : 880);
    const h = 52 + (openPanels.length > 0 ? panelH : 0);
    window.electronAPI.invoke('overlay:resize', w, h);
  });

  // Drag-to-resize from the bottom-right grip. Uses absolute screen coords so the math is
  // immune to the window moving/resizing under the cursor mid-drag.
  let resizing = false, rsX = 0, rsY = 0, rsW = 0, rsH = 0;
  function startResize(e: PointerEvent) {
    resizing = true;
    rsX = e.screenX; rsY = e.screenY;
    rsW = userW ?? (openPanels.length >= 2 ? 1000 : 880);
    rsH = panelH;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onResize(e: PointerEvent) {
    if (!resizing) return;
    const maxW = (window.screen?.availWidth ?? 1920) - 16;
    const maxH = (window.screen?.availHeight ?? 1080) - 52 - 32;
    // Floor at the 880 design width — shrinking below it overlaps the bar contents. Widen freely.
    userW = Math.max(880, Math.min(rsW + (e.screenX - rsX), maxW));
    panelH = Math.max(160, Math.min(rsH + (e.screenY - rsY), maxH));
  }
  function endResize(e: PointerEvent) {
    resizing = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  // --- Live assist (persisted chat) ---
  type ChatMsg = {
    id: number;
    kind: 'sent' | 'answer' | 'event' | 'screenshot' | 'research';
    label?: string;
    text: string;
    streaming?: boolean;
    seq?: number;
    status?: 'analyzing' | 'done' | 'error';
    expanded?: boolean;
  };
  let chat = $state<ChatMsg[]>([]);
  let chatId = 0;
  let streamIdx = -1; // index into `chat` of the answer currently streaming
  let busy = $state(false); // main session is mid-answer — gate new intents to avoid streamIdx conflicts
  let busyTimer: ReturnType<typeof setTimeout> | null = null;

  function clearBusy() {
    busy = false;
    if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  }
  let assistInput = $state('');
  let researchMode = $state(false);
  let chatEl = $state<HTMLDivElement | null>(null);
  let lastSharedCount = 0; // # of finalized transcript entries already sent to the assistant

  // Aux outputs buffered for the NEXT main-session trigger — the documented marks flow: folded
  // into ask()'s composed turn, NOT injected eagerly. Eager injection (assist:context) put two
  // messages in flight at once, which the CLI coalesces — that hung the next answer. Each block
  // is sent once (with the next ask), then lives in the session's history.
  let pendingShots = $state<{ seq: number; time: string; text: string }[]>([]);
  let pendingResearch = $state<{ q: string; text: string }[]>([]);
  let screenshotSeq = 0;
  let researchId: string | null = null;
  let researchIdx = -1; // index into `chat` of the research answer streaming

  const INTENTS = [
    { id: 'answer', label: 'Answer' },
    { id: 'suggest', label: 'Suggest' },
    { id: 'askback', label: 'Ask back' },
    { id: 'explain', label: 'Explain' },
  ];
  const INTENT_KEYS: Record<string, string> = {
    answer: 'intent_answer_prompt', suggest: 'intent_suggest_prompt',
    askback: 'intent_askback_prompt', explain: 'intent_explain_prompt',
  };
  let intentPrompts: Record<string, string> = {};

  async function loadIntentPrompts() {
    for (const [id, key] of Object.entries(INTENT_KEYS)) {
      intentPrompts[id] = (await window.electronAPI.invoke('settings:get', key) as string) ?? '';
    }
  }

  // Resolve a speaker's display name: mic is always "You"; participants resolve to their
  // Scribe-assigned name, falling back to the generic "Participant N" label.
  function nameFor(e: TranscriptEntry): string {
    if (e.source === 'mic') return 'You';
    return speakerNames[e.participantIndex] || e.speaker || 'Them';
  }

  function fmtLine(e: TranscriptEntry): string {
    return `${e.source === 'mic' ? 'Me' : (speakerNames[e.participantIndex] || e.speaker || 'Them')}: ${e.text}`;
  }

  // User renamed a participant from the legend — lock it (Scribe won't override) + optimistic UI.
  async function renameSpeaker(idx: number, value: string) {
    const clean = value.trim();
    const next = { ...speakerNames };
    if (clean) next[idx] = clean; else delete next[idx];
    speakerNames = next;
    await window.electronAPI.invoke('scribe:rename', idx, clean);
  }

  // Live, not-yet-finalized speech (interim). Useful when an intent/screenshot/research fires
  // mid-sentence — but flag it: it's unconfirmed and may be misheard or have the wrong speaker.
  function liveUnconfirmed(): string {
    const lines = transcriptEntries.filter(e => !e.isFinal && e.text.trim()).map(fmtLine).join('\n');
    return lines ? `[Still being spoken — unconfirmed, may be misheard or mis-attributed:\n${lines}]` : '';
  }

  function recentTranscript(n = 6): string {
    const finals = transcriptEntries.filter(e => e.isFinal).slice(-n).map(fmtLine).join('\n');
    const live = liveUnconfirmed();
    return [finals, live].filter(Boolean).join('\n');
  }

  // Persist a chat turn to <meeting>/chat.md so research + the summary can read it.
  function appendChat(heading: string, body: string) {
    if (!meetingId || !body?.trim()) return;
    window.electronAPI.invoke('chat:append', { meetingId, heading, body });
  }

  // Transcript delta since the last trigger + the current unconfirmed (interim) speech, so an
  // intent fired mid-sentence still sees the latest words. Buffered screenshot/research findings
  // are layered on top of this by composeTurn().
  function buildContext(): string {
    const finals = transcriptEntries.filter(e => e.isFinal);
    const delta = finals.slice(lastSharedCount).map(fmtLine).join('\n');
    lastSharedCount = finals.length;   // interim is NOT consumed — it re-shares (confirmed) once finalized
    return [delta, liveUnconfirmed()].filter(Boolean).join('\n');
  }

  // Build the full turn for the live session: labeled sections (conversation / on-screen /
  // research) with the instruction LAST, so the model treats the rest as background and acts on
  // the ask. Only non-empty sections appear. Buffered screenshots/research are consumed here.
  function composeTurn(instruction: string): string {
    const convo = buildContext();
    const shots = pendingShots.map(s => `Screenshot #${s.seq} (${s.time}):\n${s.text}`).join('\n\n');
    const research = pendingResearch.map(r => `Research on "${r.q}":\n${r.text}`).join('\n\n');
    pendingShots = [];
    pendingResearch = [];

    const sections: string[] = [];
    if (convo) sections.push(`— Conversation —\n${convo}`);
    if (shots) sections.push(`— On my screen —\n${shots}\n(These describe what's on my screen — the task or question I need help with may be here, not just spoken.)`);
    if (research) sections.push(`— Research I pulled in —\n${research}`);
    if (sections.length === 0) return instruction;
    return `Here's what's new since my last message.\n\n${sections.join('\n\n')}\n\nNow: ${instruction}`;
  }

  async function scrollChat() {
    await tick();
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  }

  function openAssist() { if (!showAssist) togglePanel('assist'); }

  // `display` is what shows in the chat; `instruction` (+ transcript delta) is what's sent.
  function ask(label: string, instruction: string, display: string) {
    if (!instruction || busy) return; // ignore while the main session is still answering
    const composed = composeTurn(instruction);
    chat.push({ id: ++chatId, kind: 'sent', label, text: display });
    chat.push({ id: ++chatId, kind: 'answer', text: '', streaming: true });
    streamIdx = chat.length - 1;
    busy = true;
    // Safety net: never leave the actions locked if a response hangs (latency can spike).
    if (busyTimer) clearTimeout(busyTimer);
    busyTimer = setTimeout(() => {
      if (streamIdx >= 0) {
        if (!chat[streamIdx].text) chat[streamIdx].text = '⚠ No response — the assistant timed out.';
        chat[streamIdx].streaming = false;
        streamIdx = -1;
      }
      clearBusy();
    }, 120000);
    openAssist();
    window.electronAPI.invoke('assist:send', composed);
    scrollChat();
  }

  function sendAssistInput() {
    const q = assistInput.trim();
    if (!q) return;
    assistInput = '';
    if (researchMode || q.startsWith('/research ')) {
      doResearch(q.replace(/^\/research\s+/, ''));
    } else {
      ask('You', q, q); // typed → show the message
    }
  }

  // Research runs in a SEPARATE all-tools session: answers in chat AND feeds the main session.
  async function doResearch(question: string) {
    if (!question) return;
    // Research also sees buffered screenshots (so it knows what's on screen), but doesn't consume
    // them — the main session still gets them on its next trigger.
    const shotsCtx = pendingShots.map(s => `On screen — Screenshot #${s.seq}:\n${s.text}`).join('\n\n');
    const context = [recentTranscript(), shotsCtx].filter(Boolean).join('\n\n');
    chat.push({ id: ++chatId, kind: 'sent', label: 'Research', text: question });
    chat.push({ id: ++chatId, kind: 'research', text: '', streaming: true });
    researchIdx = chat.length - 1;
    openAssist();
    scrollChat();
    researchId = (await window.electronAPI.invoke('assist:research', { question, context })) as string;
  }

  function triggerIntent(id: string) {
    const label = INTENTS.find(i => i.id === id)?.label ?? 'Ask';
    ask(label, intentPrompts[id], ''); // intent → show just the pill name (no body)
  }

  function setupAssistListeners() {
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.ASSIST_TOKEN, (t: unknown) => {
      if (streamIdx >= 0) { chat[streamIdx].text += t as string; scrollChat(); }
    }));
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.ASSIST_TURN, () => {
      if (streamIdx >= 0) {
        chat[streamIdx].streaming = false;
        const answer = chat[streamIdx]?.text ?? '';
        const sent = chat[streamIdx - 1];
        const heading = sent ? (sent.label === 'You' ? `You: ${sent.text}` : sent.label) : 'Assist';
        appendChat(heading ?? 'Assist', answer);
        streamIdx = -1;
        clearBusy();
      }
    }));
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.ASSIST_ERROR, (m: unknown) => {
      if (streamIdx >= 0) { chat[streamIdx].text = `⚠ ${m as string}`; chat[streamIdx].streaming = false; streamIdx = -1; clearBusy(); }
    }));
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.ASSIST_TRIGGER, (id: unknown) => {
      triggerIntent(id as string);
    }));

    // Research stream → its own bubble, and findings buffered for the main session
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.RESEARCH_TOKEN, (p: unknown) => {
      const { id, text } = p as { id: string; text: string };
      if (id !== researchId || researchIdx < 0) return;
      chat[researchIdx].text += text;
      scrollChat();
    }));
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.RESEARCH_TURN, (p: unknown) => {
      const { id, text } = p as { id: string; text: string };
      if (id !== researchId) return;
      if (researchIdx >= 0) chat[researchIdx].streaming = false;
      const q = chat[researchIdx - 1]?.text ?? '';
      if (text) {
        // Buffer findings for the next trigger (folded into composeTurn) — not eager-injected.
        pendingResearch = [...pendingResearch, { q, text }];
        appendChat(`Research: ${q}`, text);
      }
      researchIdx = -1;
      researchId = null;
    }));
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.RESEARCH_ERROR, (p: unknown) => {
      const { id, error } = p as { id: string; error: string };
      if (id !== researchId || researchIdx < 0) return;
      chat[researchIdx].text = `⚠ ${error}`;
      chat[researchIdx].streaming = false;
      researchIdx = -1;
      researchId = null;
    }));
  }

  // Audio capture state
  let micStream: MediaStream | null = null;
  let systemStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let cleanupListeners: (() => void)[] = [];

  const params = new URLSearchParams(window.location.search);
  const meetingId = params.get('meetingId') ?? '';
  const recordAudio = params.get('recordAudio') === 'true';
  const recordScreen = params.get('recordScreen') === 'true';

  // Recording state — single combined recorder, streamed to disk
  let recorder: MediaRecorder | null = null;

  const TARGET_SAMPLE_RATE = 16000;

  async function load() {
    if (!meetingId) return;
    meeting = (await window.electronAPI.invoke('meetings:get', meetingId)) as Meeting;
    const op = await window.electronAPI.invoke('settings:get', 'overlay_opacity') as string | undefined;
    if (op) overlayOpacity = parseFloat(op) || 0.94;
  }

  function startTimer() {
    elapsed = 0;
    timerInterval = setInterval(() => { elapsed++; }, 1000);
  }

  function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function resample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
    if (inputRate === outputRate) return input;
    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, input.length - 1);
      const frac = srcIndex - low;
      output[i] = input[low] * (1 - frac) + input[high] * frac;
    }
    return output;
  }

  function connectSource(stream: MediaStream, source: 'mic' | 'system'): GainNode | null {
    if (!audioContext) return null;
    // Capture a stable reference + the (immutable) sample rate up front. The hot onaudioprocess
    // callback must NOT read the module-level `audioContext` — it can be reset to null (on stop,
    // or by a dev HMR reload) while these audio nodes are still firing, which would throw on
    // `.sampleRate` and silently kill the STT feed (recording survives, transcript goes empty).
    const ctx = audioContext;
    const inputRate = ctx.sampleRate;
    const sourceNode = ctx.createMediaStreamSource(stream);

    const gainNode = ctx.createGain();
    gainNode.gain.value = source === 'mic' ? 3.0 : 2.0;

    const processor = ctx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);

      // Live level meter (RMS of the raw frame)
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
      const rms = Math.sqrt(sum / inputData.length);
      const lvl = Math.min(1, rms * (source === 'mic' ? 6 : 8));
      if (source === 'mic') micLevel = Math.max(lvl, micLevel * 0.8);
      else sysLevel = Math.max(lvl, sysLevel * 0.8);

      const resampled = resample(inputData, inputRate, TARGET_SAMPLE_RATE);
      // Clamp to [-1, 1] to prevent clipping from gain
      for (let i = 0; i < resampled.length; i++) {
        resampled[i] = Math.max(-1, Math.min(1, resampled[i]));
      }
      window.electronAPI.invoke('audio:data', {
        source,
        samples: Array.from(resampled),
      });
    };

    sourceNode.connect(gainNode);
    gainNode.connect(processor);
    processor.connect(ctx.destination);

    return gainNode;
  }

  async function startAudioCapture() {
    audioContext = new AudioContext();

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    let micGain: GainNode | null = null;
    let systemGain: GainNode | null = null;

    // Mic capture
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micGain = connectSource(micStream, 'mic');
    } catch (err) {
      console.warn('[overlay] Mic capture failed:', err);
    }

    // System audio capture (Electron desktopCapturer via getUserMedia)
    try {
      systemStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // @ts-expect-error Electron-specific mandatory constraint for system audio
          mandatory: { chromeMediaSource: 'desktop' },
        },
        video: {
          // @ts-expect-error Electron requires video constraint for desktop capture
          mandatory: { chromeMediaSource: 'desktop' },
        },
      });

      // Keep the video track alive for the whole meeting regardless of recordScreen —
      // it's the source for prompt-free screenshots. It's only piped into the recorder
      // below when recordScreen is enabled.
      systemGain = connectSource(systemStream, 'system');
    } catch (err) {
      console.warn('[overlay] System audio capture failed:', err);
    }

    // Set up a single combined recorder (video + mic + system audio)
    if ((recordAudio || recordScreen) && audioContext) {
      try {
        const combinedStream = new MediaStream();

        if (recordScreen && systemStream) {
          systemStream.getVideoTracks().forEach(t => combinedStream.addTrack(t));
        }

        const audioDest = audioContext.createMediaStreamDestination();
        if (micGain) micGain.connect(audioDest);
        if (systemGain) systemGain.connect(audioDest);
        audioDest.stream.getAudioTracks().forEach(t => combinedStream.addTrack(t));

        const hasVideo = combinedStream.getVideoTracks().length > 0;
        const mimeType = hasVideo ? 'video/webm;codecs=vp8,opus' : 'audio/webm;codecs=opus';

        await window.electronAPI.invoke('recording:init', { meetingId });

        recorder = new MediaRecorder(combinedStream, { mimeType });
        recorder.ondataavailable = async (e) => {
          if (e.data.size > 0) {
            const buffer = await e.data.arrayBuffer();
            await window.electronAPI.invoke('recording:chunk', {
              meetingId,
              data: Array.from(new Uint8Array(buffer)),
            });
          }
        };
        recorder.start(1000);
        console.log(`[overlay] Combined recording started (${hasVideo ? 'video+audio' : 'audio-only'})`);
      } catch (err) {
        console.warn('[overlay] Recording setup failed:', err);
      }
    }
  }

  function stopAudioCapture() {
    micStream?.getTracks().forEach(t => t.stop());
    systemStream?.getTracks().forEach(t => t.stop());
    micStream = null;
    systemStream = null;
    audioContext?.close();
    audioContext = null;
  }

  function showToast() {
    showScreenshotToast = true;
    if (screenshotToastTimer) clearTimeout(screenshotToastTimer);
    screenshotToastTimer = setTimeout(() => {
      showScreenshotToast = false;
      screenshotToastTimer = null;
    }, 2000);
  }

  // Grab a frame from the screen stream already granted at meeting start — no new prompt.
  async function captureScreenshotFromStream() {
    const track = systemStream?.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') {
      console.warn('[overlay] No live screen track available for screenshot');
      return;
    }
    let blob: Blob | null = null;
    try {
      // Hide the overlay so it isn't in the shot, then let the capture stream settle
      await window.electronAPI.invoke('overlay:set-hidden', true);
      await new Promise((r) => setTimeout(r, 160));

      const video = document.createElement('video');
      video.srcObject = new MediaStream([track]);
      video.muted = true;
      await video.play();
      await new Promise((r) => requestAnimationFrame(() => r(null)));

      const w = video.videoWidth || 1920;
      const h = video.videoHeight || 1080;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(video, 0, 0, w, h);

      video.pause();
      video.srcObject = null;

      blob = ctx ? await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png')) : null;
    } finally {
      await window.electronAPI.invoke('overlay:set-hidden', false);
    }

    try {
      if (!blob) return;
      const buf = await blob.arrayBuffer();
      const result = (await window.electronAPI.invoke(IPC_CHANNELS.SCREENSHOT_SAVE, {
        meetingId,
        data: Array.from(new Uint8Array(buf)),
      })) as { ok: boolean; path?: string };
      if (!result?.ok || !result.path) return;

      showToast();
      const seq = ++screenshotSeq;
      const msgId = ++chatId;
      chat.push({ id: msgId, kind: 'screenshot', seq, text: '', status: 'analyzing', expanded: false });
      openAssist();
      scrollChat();

      // Analyze in a separate session (Read tools) — keeps the live session fast.
      const context = recentTranscript();
      const res = (await window.electronAPI.invoke('assist:analyze-screenshot', {
        path: result.path,
        context,
      })) as { ok: boolean; text: string; error?: string };

      const idx = chat.findIndex(m => m.id === msgId);
      if (idx >= 0) {
        if (res?.ok && res.text) {
          chat[idx].text = res.text;
          chat[idx].status = 'done';
          // Buffer the analysis for the NEXT trigger (folded into composeTurn) — not eager-injected.
          // The session gets the full picture the moment you ask; also persisted to screenshot-*.md
          // (which the end-of-meeting summary reads, so an unconsumed screenshot is never lost).
          pendingShots = [...pendingShots, { seq, time: new Date().toLocaleTimeString(), text: res.text }];
          appendChat(`Screenshot #${seq}`, res.text);
        } else {
          chat[idx].text = res?.error ?? 'Analysis failed';
          chat[idx].status = 'error';
        }
      }
      scrollChat();
    } catch (err) {
      console.warn('[overlay] Screenshot capture failed:', err);
    }
  }

  function setupScreenshotListener() {
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.SCREENSHOT_CAPTURE_REQUEST, () => {
      captureScreenshotFromStream();
    }));
  }

  function setupTranscriptListeners() {
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.SCRIBE_SPEAKERS, (m: unknown) => {
      speakerNames = (m as Record<number, string>) ?? {};
    }));
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.SCRIBE_SUMMARY, (s: unknown) => {
      scribeSummary = (s as string) ?? '';
    }));
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.TRANSCRIPT_NEW_ENTRY, (entry: unknown) => {
      transcriptEntries = [...transcriptEntries, entry as TranscriptEntry];
    }));
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.TRANSCRIPT_UPDATE_ENTRY, (entry: unknown) => {
      const updated = entry as TranscriptEntry;
      transcriptEntries = transcriptEntries.map(e => e.id === updated.id ? updated : e);
    }));
    cleanupListeners.push(window.electronAPI.on(IPC_CHANNELS.TRANSCRIPT_FINALIZE_ENTRY, (entry: unknown) => {
      const finalized = entry as TranscriptEntry;
      const existingIdx = transcriptEntries.findIndex(e => !e.isFinal && e.source === finalized.source);
      if (existingIdx >= 0) {
        transcriptEntries = [
          ...transcriptEntries.slice(0, existingIdx),
          finalized,
          ...transcriptEntries.slice(existingIdx + 1),
        ];
      } else {
        transcriptEntries = [...transcriptEntries, finalized];
      }
    }));
  }

  async function stopMeeting() {
    if (!meetingId) return;
    if (timerInterval) clearInterval(timerInterval);
    cleanupListeners.forEach(fn => fn());

    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder!.onstop = () => resolve();
        recorder!.stop();
      });
    }

    await window.electronAPI.invoke('recording:finish', { meetingId });
    stopAudioCapture();
    await window.electronAPI.invoke('meeting:stop', meetingId);
  }

  load().then(() => {
    startTimer();
    setupTranscriptListeners();
    setupScreenshotListener();
    setupAssistListeners();
    loadIntentPrompts();
    startAudioCapture();
  });
</script>

<svelte:window onkeydown={onOverlayKeydown} />

<div class="ov" style="--ov-alpha:{overlayOpacity};">
  <div class="bar" style="-webkit-app-region: drag;">
    <div class="bar-left">
      <span class="rec"></span>
      <span class="timer">{formatTime(elapsed)}</span>
    </div>

    <div class="bar-mid">
      <div class="intents">
        {#each INTENTS as it}
          <button class="ipill" disabled={busy} onclick={() => triggerIntent(it.id)}>{it.label}</button>
        {/each}
        <button class="ipill shot" onclick={captureScreenshotFromStream} title="Screenshot">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
        </button>
      </div>

      <div class="latest">
        {#if latest}
          <span class="who" class:me={latest.source === 'mic'}>{nameFor(latest)}</span>
          <span class="latest-text">{latest.text}</span>
        {:else}
          <span class="latest-idle">Listening to the room…</span>
        {/if}
      </div>

      <div class="meters" title="Mic / system audio levels">
        <span class="m mic" style="--l:{micLevel}"></span>
        <span class="m sys" style="--l:{sysLevel}"></span>
      </div>
    </div>

    <div class="bar-right">
      <button class="toggle" class:on={showTranscript} onclick={() => togglePanel('transcript')}>
        Transcript <span class="chev" class:up={showTranscript}>⌄</span>
      </button>
      <button class="toggle" class:on={showSummary} onclick={() => togglePanel('summary')}>
        Summary <span class="chev" class:up={showSummary}>⌄</span>
      </button>
      <button class="toggle" class:on={showAssist} onclick={() => togglePanel('assist')}>
        Assist <span class="chev" class:up={showAssist}>⌄</span>
      </button>
      <button class="stop" onclick={stopMeeting} title="Stop meeting" aria-label="Stop">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      </button>
    </div>
  </div>

  {#if openPanels.length > 0}
    <div class="panels">
      {#if showTranscript}
        <div class="panel tpanel">
          {#if openPanels.length === 1}
            <div class="tcols">
              <div class="tcol">
                <div class="tcol-h them">Speakers</div>
                {#if activeParticipants.length}
                  <div class="legend" title="Rename a speaker — your edits stick">
                    {#each activeParticipants as idx (idx)}
                      <input
                        class="legend-name"
                        value={speakerNames[idx] ?? `Participant ${idx}`}
                        onkeydown={(ev) => { if (ev.key === 'Enter') ev.currentTarget.blur(); }}
                        onchange={(ev) => renameSpeaker(idx, ev.currentTarget.value)}
                      />
                    {/each}
                  </div>
                {/if}
                <div class="tcol-body" bind:this={speakerBody}>
                  {#each speakerEntries as e, i (e.id)}
                    {#if i === 0 || nameFor(speakerEntries[i - 1]) !== nameFor(e)}<div class="ptag">{nameFor(e)}</div>{/if}
                    <p class="tline" class:interim={!e.isFinal}>{e.text}</p>
                  {/each}
                  {#if speakerEntries.length === 0}<p class="tline idle">—</p>{/if}
                </div>
              </div>
              <div class="tcol">
                <div class="tcol-h me">Mic</div>
                <div class="tcol-body" bind:this={micBody}>
                  {#each micEntries as e (e.id)}<p class="tline" class:interim={!e.isFinal}>{e.text}</p>{/each}
                  {#if micEntries.length === 0}<p class="tline idle">—</p>{/if}
                </div>
              </div>
            </div>
          {:else}
            <div class="tlist" bind:this={tlistEl}>
              {#each transcriptEntries as e (e.id)}
                <p class="tmsg" class:me={e.source === 'mic'} class:interim={!e.isFinal}>
                  <span class="tmsg-who">{nameFor(e)}</span>{e.text}
                </p>
              {/each}
              {#if transcriptEntries.length === 0}<p class="tline idle">Listening…</p>{/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if showAssist}
        <div class="panel apanel">
          <div class="chat" bind:this={chatEl}>
            {#if chat.length === 0}
              <div class="chat-empty">Trigger an intent or ask below.<br/>Your prompts and answers persist here for the meeting.</div>
            {/if}
            {#each chat as m (m.id)}
              {#if m.kind === 'sent'}
                {#if m.text}
                  <div class="cmsg typed"><div class="ctext">{m.text}</div></div>
                {:else}
                  <div class="cmsg intent-chip">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    {m.label}
                  </div>
                {/if}
              {:else if m.kind === 'answer'}
                <div class="cmsg answer"><div class="ctext">{m.text}{#if m.streaming}<span class="caret"></span>{/if}</div></div>
              {:else if m.kind === 'research'}
                <div class="cmsg research">
                  <div class="research-head">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    Research
                  </div>
                  <div class="ctext">
                    {#if m.text}{m.text}{#if m.streaming}<span class="caret"></span>{/if}
                    {:else}<span class="researching">Searching…</span>{/if}
                  </div>
                </div>
              {:else if m.kind === 'screenshot'}
                <div class="cmsg shot">
                  <button class="shot-head" onclick={() => { if (m.status !== 'analyzing') m.expanded = !m.expanded; }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
                    <span class="shot-title">Screenshot #{m.seq}</span>
                    <span class="shot-status {m.status}">{m.status === 'analyzing' ? 'analyzing…' : m.status === 'error' ? 'failed' : 'analyzed'}</span>
                    {#if m.status !== 'analyzing'}<span class="shot-chev" class:open={m.expanded}>⌄</span>{/if}
                  </button>
                  {#if m.expanded && m.text}<div class="shot-body">{m.text}</div>{/if}
                </div>
              {:else}
                <div class="cmsg event">{m.text}</div>
              {/if}
            {/each}
          </div>
          <div class="chat-input" style="-webkit-app-region: no-drag;">
            <button
              class="research-toggle"
              class:on={researchMode}
              onclick={() => researchMode = !researchMode}
              title={researchMode ? 'Research mode on — searches the web' : 'Switch to research mode (web)'}
              aria-label="Research mode"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </button>
            <input
              class="cinput"
              placeholder={busy && !researchMode ? 'Assistant is responding…' : researchMode ? 'Research the web…' : 'Ask the assistant…'}
              bind:value={assistInput}
              disabled={busy && !researchMode}
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); sendAssistInput(); } }}
            />
            <button class="csend" onclick={sendAssistInput} disabled={busy && !researchMode} title="Send" aria-label="Send">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      {/if}

      {#if showSummary}
        <div class="panel spanel">
          <div class="tcol-h them">Live summary</div>
          <div class="summary-body">
            {#if scribeSummary.trim()}
              <div class="summary-text">{scribeSummary}</div>
            {:else}
              <p class="tline idle">Building the summary… it refreshes as the meeting goes.</p>
            {/if}
          </div>
        </div>
      {/if}
    </div>
    <div
      class="resize-grip"
      style="-webkit-app-region: no-drag;"
      onpointerdown={startResize}
      onpointermove={onResize}
      onpointerup={endResize}
      title="Drag to resize"
    ></div>
  {/if}

  {#if showScreenshotToast}<div class="screenshot-toast">Screenshot saved</div>{/if}
</div>

<style>
  :global(body) { background: transparent !important; overflow: hidden; }

  .resize-grip {
    position: absolute; bottom: 0; right: 0; width: 18px; height: 18px;
    z-index: 30; cursor: nwse-resize; border-bottom-right-radius: 13px;
    background: linear-gradient(135deg, transparent 55%, rgba(255, 255, 255, 0.28) 55%);
    transition: background 0.15s;
  }
  .resize-grip:hover { background: linear-gradient(135deg, transparent 55%, var(--accent, #8B7CF6) 55%); }

  .ov {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: rgba(15, 17, 23, var(--ov-alpha, 0.94));
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 14px;
    overflow: hidden;
    backdrop-filter: blur(22px);
  }

  /* Only interactive controls block dragging; the rest of the bar is a drag handle. */
  .bar button, .bar input { -webkit-app-region: no-drag; }

  /* ===== Title bar ===== */
  .bar {
    display: flex;
    align-items: center;
    gap: 14px;
    height: 52px;
    padding: 0 12px 0 16px;
    flex-shrink: 0;
    cursor: grab;
  }

  .bar-left { display: flex; align-items: center; gap: 9px; flex-shrink: 0; }
  .rec {
    width: 8px; height: 8px; border-radius: 50%;
    background: #f87171; animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 4px rgba(248,113,113,0.4); }
    50% { opacity: 0.5; box-shadow: 0 0 8px rgba(248,113,113,0.6); }
  }
  .timer { font-family: var(--font-mono); font-size: 13px; font-weight: 500; color: var(--text-secondary); }

  .bar-mid { flex: 1; display: flex; align-items: center; gap: 14px; min-width: 0; }

  .intents { display: flex; gap: 4px; flex-shrink: 0; }
  .ipill {
    padding: 5px 11px;
    font-size: 11.5px; font-weight: 500;
    color: var(--text-secondary);
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 999px;
    transition: all 0.14s ease;
    white-space: nowrap;
  }
  .ipill:hover:not(:disabled) { color: var(--accent); background: var(--accent-soft); border-color: var(--border-focus); }
  .ipill:disabled { opacity: 0.38; cursor: not-allowed; }
  .ipill.shot { display: flex; align-items: center; padding: 5px 9px; }
  .ipill.shot:disabled { opacity: 1; cursor: pointer; }

  .latest { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }
  .who {
    flex-shrink: 0; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    padding: 2px 6px; border-radius: 5px;
    background: rgba(248,113,113,0.14); color: #f8a4a4;
  }
  .who.me { background: var(--accent-soft); color: var(--text-accent); }
  .latest-text {
    font-size: 12.5px; color: var(--text-secondary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
  }
  .latest-idle { font-size: 12px; color: var(--text-tertiary); font-style: italic; }

  .meters { display: flex; gap: 3px; align-items: flex-end; height: 16px; flex-shrink: 0; }
  .m { position: relative; width: 3px; height: 16px; background: rgba(255,255,255,0.09); border-radius: 2px; overflow: hidden; }
  .m::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: 0;
    height: calc(var(--l, 0) * 100%);
    transition: height 0.08s linear;
  }
  .m.mic::after { background: var(--accent); }
  .m.sys::after { background: #f87171; }

  .bar-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .toggle {
    display: flex; align-items: center; gap: 5px;
    padding: 6px 10px; font-size: 12px; font-weight: 500;
    color: var(--text-secondary); border-radius: 8px;
    transition: all 0.14s ease;
  }
  .toggle:hover { color: var(--text-primary); background: rgba(255,255,255,0.05); }
  .toggle.on { color: var(--accent); background: var(--accent-soft); }
  .chev { display: inline-block; font-size: 10px; transition: transform 0.16s ease; }
  .chev.up { transform: rotate(180deg); }

  .stop {
    display: flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 7px;
    background: var(--red-soft); border: 1px solid rgba(248,113,113,0.2); color: var(--red);
    transition: all 0.14s ease;
  }
  .stop:hover { background: var(--red); color: #fff; }

  /* ===== Panels ===== */
  .panels { flex: 1; display: flex; gap: 1px; border-top: 1px solid rgba(255,255,255,0.07); min-height: 0; }
  .panel { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .tpanel { flex: 1; }
  .apanel { flex: 1.25; border-left: 1px solid rgba(255,255,255,0.07); background: rgba(124,138,255,0.04); }
  .spanel { flex: 1; border-left: 1px solid rgba(255,255,255,0.07); background: rgba(248,164,164,0.04); }
  .summary-body { flex: 1; overflow-y: auto; padding: 4px 14px 12px; }
  .summary-text { font-size: 12.5px; line-height: 1.55; color: var(--text-secondary); white-space: pre-wrap; word-break: break-word; }

  /* transcript — two columns */
  .tcols { flex: 1; display: flex; min-height: 0; }
  .tcol { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .tcol + .tcol { border-left: 1px solid rgba(255,255,255,0.06); }
  .tcol-h {
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.07em;
    padding: 8px 14px 5px; color: var(--text-tertiary);
  }
  .tcol-h.them { color: #f8a4a4; }
  .tcol-h.me { color: var(--text-accent); }
  .tcol-body { flex: 1; overflow-y: auto; padding: 0 14px 10px; }
  /* Rename legend — one editable chip per active participant. */
  .legend { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 14px 7px; }
  .legend-name {
    font-size: 11px; font-weight: 600; color: #f8c8c8; max-width: 130px;
    background: rgba(248, 164, 164, 0.10); border: 1px solid rgba(248, 164, 164, 0.22);
    border-radius: 6px; padding: 2px 7px; outline: none; transition: border-color 0.12s, background 0.12s;
  }
  .legend-name:hover { border-color: rgba(248, 164, 164, 0.4); }
  .legend-name:focus { border-color: #f8a4a4; background: rgba(248, 164, 164, 0.16); color: #fff; }
  .ptag { font-size: 10px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; color: #f8a4a4; margin: 8px 0 3px; }
  .tline { font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); margin-bottom: 7px; }
  .tline.idle { color: var(--text-tertiary); }
  .tline.interim { opacity: 0.55; }

  /* transcript — single column when sharing with assist */
  .tlist { flex: 1; overflow-y: auto; padding: 10px 14px; }
  .tmsg { font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); margin-bottom: 8px; }
  .tmsg.interim { opacity: 0.55; }
  .tmsg-who {
    display: inline-block; margin-right: 7px; font-size: 9px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.05em; color: #f8a4a4;
    padding: 1px 5px; border-radius: 4px; background: rgba(248,113,113,0.12);
  }
  .tmsg.me .tmsg-who { color: var(--text-accent); background: var(--accent-soft); }

  /* assist chat */
  .chat { flex: 1; overflow-y: auto; padding: 12px 12px 6px; display: flex; flex-direction: column; gap: 9px; min-height: 0; }
  .chat-empty { margin: auto; text-align: center; font-size: 12px; color: var(--text-tertiary); line-height: 1.6; padding: 0 20px; }

  .cmsg { font-size: 12.5px; line-height: 1.5; }

  .cmsg.typed { align-self: flex-end; max-width: 86%; }
  .cmsg.typed .ctext {
    background: var(--accent-soft); color: var(--text-primary);
    padding: 7px 11px; border-radius: 11px 11px 3px 11px;
    white-space: pre-wrap; word-break: break-word;
  }

  .cmsg.intent-chip {
    align-self: flex-end;
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 11px;
    font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
    color: var(--accent); background: var(--accent-soft);
    border: 1px solid var(--border-focus); border-radius: 999px;
  }
  .cmsg.answer { align-self: flex-start; max-width: 92%; }
  .cmsg.answer .ctext {
    background: rgba(255,255,255,0.05); color: var(--text-primary);
    padding: 8px 12px; border-radius: 11px 11px 11px 3px;
    white-space: pre-wrap; word-break: break-word;
  }
  .cmsg.event {
    align-self: center; font-size: 11px; color: var(--text-tertiary);
    background: rgba(255,255,255,0.04); padding: 4px 10px; border-radius: 999px;
  }

  .cmsg.research { align-self: flex-start; max-width: 92%; }
  .research-head {
    display: inline-flex; align-items: center; gap: 5px; margin-bottom: 3px;
    font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--orange);
  }
  .cmsg.research .ctext {
    background: var(--orange-soft); color: var(--text-primary);
    padding: 8px 12px; border-radius: 3px 11px 11px 11px;
    white-space: pre-wrap; word-break: break-word;
    border: 1px solid rgba(251, 191, 36, 0.18);
  }
  .researching { color: var(--orange); font-style: italic; animation: fadePulse 1.4s ease-in-out infinite; }

  .cmsg.shot { align-self: stretch; }
  .shot-head {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 7px 11px; border-radius: 9px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
    color: var(--text-secondary); transition: background 0.14s ease;
  }
  .shot-head:hover { background: rgba(255,255,255,0.07); }
  .shot-title { font-size: 12px; font-weight: 500; color: var(--text-primary); }
  .shot-status { font-size: 10.5px; }
  .shot-status.analyzing { color: var(--accent); animation: fadePulse 1.4s ease-in-out infinite; }
  .shot-status.done { color: var(--green); }
  .shot-status.error { color: var(--red); }
  .shot-chev { margin-left: auto; font-size: 11px; color: var(--text-tertiary); transition: transform 0.16s ease; }
  .shot-chev.open { transform: rotate(180deg); }
  .shot-body {
    margin-top: 6px; padding: 9px 11px;
    font-size: 12px; line-height: 1.55; color: var(--text-secondary);
    background: var(--bg-primary); border-radius: 9px;
    white-space: pre-wrap; word-break: break-word;
  }
  .caret {
    display: inline-block; width: 6px; height: 13px; margin-left: 1px;
    background: var(--accent); border-radius: 1px; vertical-align: text-bottom;
    animation: blink 1s steps(2) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  .chat-input { display: flex; gap: 7px; padding: 8px 12px 12px; align-items: center; }
  .research-toggle {
    flex-shrink: 0; width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 9px; color: var(--text-secondary); transition: all 0.14s ease;
  }
  .research-toggle:hover { color: var(--orange); border-color: rgba(251,191,36,0.3); }
  .research-toggle.on { background: var(--orange-soft); color: var(--orange); border-color: rgba(251,191,36,0.35); }
  .cinput {
    flex: 1; padding: 8px 12px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08);
    border-radius: 9px; color: var(--text-primary); font-size: 12.5px; outline: none;
    transition: border-color 0.14s ease;
  }
  .cinput:focus { border-color: var(--accent); }
  .cinput::placeholder { color: var(--text-tertiary); }
  .cinput:disabled { opacity: 0.5; cursor: not-allowed; }
  .csend {
    flex-shrink: 0; width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent); color: #fff; border-radius: 9px;
    transition: background 0.14s ease;
  }
  .csend:hover:not(:disabled) { background: var(--accent-hover); }
  .csend:disabled { opacity: 0.4; cursor: not-allowed; }

  .screenshot-toast {
    position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
    padding: 8px 16px; background: rgba(34,197,94,0.92); color: #fff;
    font-size: 12px; font-weight: 500; border-radius: 8px; z-index: 100;
    animation: toastIn 0.2s ease-out;
  }
  @keyframes toastIn {
    from { opacity: 0; transform: translateX(-50%) translateY(8px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
