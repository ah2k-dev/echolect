<script lang="ts">
  import { IPC_CHANNELS } from '$shared/types/ipc.js';
  import { onMount, tick } from 'svelte';

  interface Props {
    anchor: DOMRect;
    title: string;
    currentContent: string;
    allowAttach?: boolean;
    onApply: (content: string) => void;
    onClose: () => void;
  }
  let { anchor, title, currentContent, allowAttach = false, onApply, onClose }: Props = $props();

  type Msg = { role: 'user' | 'assistant' | 'error'; text: string };

  let messages = $state<Msg[]>([]);
  let input = $state('');
  let attachments = $state<string[]>([]);
  let proposed = $state<string | null>(null);
  let showPreview = $state(false);
  let busy = $state(false);
  let applied = $state(false);

  let sessionId: string | null = null;
  let sessionDirsKey = '';
  let streamIdx = -1;
  let listEl: HTMLDivElement;
  let inputEl: HTMLTextAreaElement;
  const cleanups: (() => void)[] = [];

  async function refocus() { await tick(); inputEl?.focus(); }

  // --- positioning (anchored, clamped to viewport) ---
  const WIDTH = 384;
  const EST_H = 460;
  let pos = $state({ top: 0, left: 0 });
  function place() {
    const left = Math.min(Math.max(anchor.left, 10), window.innerWidth - WIDTH - 10);
    let top = anchor.bottom + 8;
    if (top + EST_H > window.innerHeight - 10) {
      top = Math.max(10, anchor.top - EST_H - 8);
    }
    pos = { top, left };
  }

  // --- helpers ---
  const dirOf = (p: string) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return i > 0 ? p.slice(0, i) : p; };
  const baseOf = (p: string) => { const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')); return p.slice(i + 1); };

  const ARTIFACT_RE = /```artifact\s*\n([\s\S]*?)```/g;
  function extractArtifact(text: string): string | null {
    const m = [...text.matchAll(ARTIFACT_RE)];
    return m.length ? m[m.length - 1][1].replace(/\n+$/, '') : null;
  }
  function stripArtifact(text: string): string {
    return text.replace(ARTIFACT_RE, '〔 proposed an updated version ↓ 〕').trim();
  }

  function buildSystemPrompt(): string {
    return [
      `You are helping the user edit a document titled "${title}" used by Echolect, a live meeting assistant app.`,
      ``,
      `Current content:`,
      `---`,
      currentContent || '(empty)',
      `---`,
      ``,
      `Reply briefly. Whenever you propose a new version, output the COMPLETE updated document in ONE fenced block labelled exactly:`,
      '```artifact',
      `<the entire updated document — not a diff>`,
      '```',
      allowAttach
        ? `The user may attach files (e.g. a résumé PDF) — read them with your tools to inform the document.`
        : ``,
    ].join('\n');
  }

  async function ensureSession() {
    const dirs = [...new Set(attachments.map(dirOf))];
    const key = dirs.join('|');
    if (sessionId && key === sessionDirsKey) return;
    // (re)start when attachments change so new dirs are readable
    if (sessionId) { await window.electronAPI.invoke('ai-session:close', sessionId); sessionId = null; }
    sessionDirsKey = key;
    sessionId = await window.electronAPI.invoke('ai-session:start', {
      systemPrompt: buildSystemPrompt(),
      addDirs: dirs,
      allowedTools: allowAttach ? ['Read', 'Grep', 'Glob'] : undefined,
    }) as string;
  }

  async function scrollDown() {
    await tick();
    if (listEl) listEl.scrollTop = listEl.scrollHeight;
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    input = '';
    applied = false;
    busy = true;

    const attachNote = attachments.length
      ? `\n\n[Attached files: ${attachments.join(', ')}]`
      : '';
    messages.push({ role: 'user', text });
    messages.push({ role: 'assistant', text: '' });
    streamIdx = messages.length - 1;
    scrollDown();

    try {
      await ensureSession();
      await window.electronAPI.invoke('ai-session:send', sessionId, text + attachNote);
    } catch {
      messages[streamIdx] = { role: 'error', text: 'Failed to reach the Claude session.' };
      busy = false;
    }
  }

  async function attach() {
    const files = await window.electronAPI.invoke('dialog:select-files') as string[];
    if (files?.length) attachments = [...new Set([...attachments, ...files])];
  }
  function removeAttachment(p: string) { attachments = attachments.filter(a => a !== p); }

  function apply() {
    if (proposed != null) { onApply(proposed); applied = true; }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  onMount(() => {
    place();
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));

    const onToken = window.electronAPI.on(IPC_CHANNELS.AI_SESSION_TOKEN, (p: unknown) => {
      const { id, text } = p as { id: string; text: string };
      if (id !== sessionId || streamIdx < 0) return;
      messages[streamIdx].text += text;
      scrollDown();
    });
    const onTurn = window.electronAPI.on(IPC_CHANNELS.AI_SESSION_TURN, (p: unknown) => {
      const { id, text } = p as { id: string; text: string };
      if (id !== sessionId) return;
      const got = extractArtifact(text);
      if (got != null) { proposed = got; showPreview = true; }
      if (streamIdx >= 0) messages[streamIdx].text = stripArtifact(text) || '…';
      busy = false;
      streamIdx = -1;
      scrollDown();
      refocus();
    });
    const onErr = window.electronAPI.on(IPC_CHANNELS.AI_SESSION_ERROR, (p: unknown) => {
      const { id, error } = p as { id: string; error: string };
      if (id !== sessionId) return;
      messages.push({ role: 'error', text: error });
      busy = false; streamIdx = -1; scrollDown(); refocus();
    });
    cleanups.push(onToken, onTurn, onErr);
    refocus();

    return () => {
      cleanups.forEach(fn => fn());
      if (sessionId) window.electronAPI.invoke('ai-session:close', sessionId);
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<!-- invisible catcher closes on outside click without dimming -->
<button class="catcher" onclick={onClose} aria-label="Close"></button>

<div class="pop" style="top:{pos.top}px; left:{pos.left}px; width:{WIDTH}px;">
  <header class="pop-head">
    <span class="spark">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.8L20 9.7l-5.1 3.7L16 20l-4-3.4L8 20l1.1-6.6L4 9.7l6.1-1.9z"/></svg>
    </span>
    <div class="pop-title">Edit with AI</div>
    <div class="pop-sub">{title}</div>
    <button class="pop-x" onclick={onClose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </header>

  <div class="msgs" bind:this={listEl}>
    {#if messages.length === 0}
      <div class="hint">
        Ask me to tighten, rewrite, or restructure this{allowAttach ? ' — or attach your résumé and I’ll build it' : ''}.
      </div>
    {/if}
    {#each messages as m}
      <div class="msg {m.role}">{m.text}{#if busy && m.role === 'assistant' && m.text === ''}<span class="caret"></span>{/if}</div>
    {/each}
  </div>

  {#if proposed != null}
    <div class="apply-bar">
      <button class="prev-toggle" onclick={() => showPreview = !showPreview}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate({showPreview ? 90 : 0}deg); transition: transform .15s;"><polyline points="9 18 15 12 9 6"/></svg>
        {applied ? 'Applied' : 'Updated version'}
      </button>
      <div class="apply-actions">
        <button class="apply-btn" onclick={apply} disabled={applied}>{applied ? '✓ Applied' : 'Apply'}</button>
      </div>
    </div>
    {#if showPreview}
      <pre class="preview">{proposed}</pre>
    {/if}
  {/if}

  {#if allowAttach}
    <div class="attach-row">
      {#each attachments as a}
        <span class="chip" title={a}>{baseOf(a)}<button class="chip-x" onclick={() => removeAttachment(a)}>×</button></span>
      {/each}
      <button class="attach-btn" onclick={attach}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        Attach
      </button>
    </div>
  {/if}

  <div class="input-row">
    <textarea
      class="pop-input"
      rows="1"
      placeholder={busy ? 'Thinking…' : 'Ask for a change…'}
      bind:value={input}
      bind:this={inputEl}
      disabled={busy}
    ></textarea>
    <button class="send" onclick={send} disabled={busy || !input.trim()} aria-label="Send">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    </button>
  </div>
</div>

<style>
  .catcher {
    position: fixed;
    inset: 0;
    z-index: 900;
    background: transparent;
    cursor: default;
  }

  .pop {
    position: fixed;
    z-index: 901;
    display: flex;
    flex-direction: column;
    max-height: 460px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    animation: pop-in 0.16s cubic-bezier(0.4, 0, 0.2, 1);
    transform-origin: top left;
  }
  @keyframes pop-in {
    from { opacity: 0; transform: scale(0.96) translateY(-6px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .pop-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 12px;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, rgba(124,138,255,0.07), transparent);
  }
  .spark { color: var(--accent); display: flex; }
  .pop-title { font-family: var(--font-heading); font-size: 13px; font-weight: 600; color: var(--text-primary); }
  .pop-sub {
    font-size: 11px; color: var(--text-tertiary);
    margin-left: auto; margin-right: 4px;
    max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pop-x { color: var(--text-tertiary); display: flex; padding: 3px; border-radius: 5px; transition: all var(--transition); }
  .pop-x:hover { background: var(--bg-hover); color: var(--text-primary); }

  .msgs {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    min-height: 90px;
  }
  .hint { font-size: 12px; color: var(--text-tertiary); text-align: center; margin: auto; padding: 0 16px; line-height: 1.5; }

  .msg {
    font-size: 12.5px;
    line-height: 1.5;
    padding: 8px 11px;
    border-radius: 11px;
    max-width: 88%;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.user { align-self: flex-end; background: var(--accent-soft); color: var(--text-primary); border-bottom-right-radius: 3px; }
  .msg.assistant { align-self: flex-start; background: var(--bg-secondary); color: var(--text-secondary); border-bottom-left-radius: 3px; }
  .msg.error { align-self: stretch; background: var(--red-soft); color: var(--red); font-size: 11.5px; }

  .caret {
    display: inline-block; width: 7px; height: 13px;
    background: var(--accent); border-radius: 1px;
    animation: blink 1s steps(2) infinite; vertical-align: text-bottom;
  }
  @keyframes blink { 50% { opacity: 0; } }

  .apply-bar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px;
    background: var(--green-soft);
    border-top: 1px solid rgba(74,222,128,0.18);
  }
  .prev-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 500; color: var(--green); }
  .apply-btn {
    padding: 6px 14px; font-size: 12px; font-weight: 600;
    background: var(--green); color: #06240f; border-radius: 6px;
    transition: filter var(--transition);
  }
  .apply-btn:hover { filter: brightness(1.08); }
  .apply-btn:disabled { opacity: 0.6; cursor: default; }

  .preview {
    margin: 0; padding: 13px 14px; max-height: 210px; overflow: auto;
    font-family: var(--font-sans); font-size: 12.5px; line-height: 1.65;
    color: var(--text-primary); background: var(--bg-primary);
    border-top: 1px solid var(--border); white-space: pre-wrap; word-break: break-word;
  }

  .attach-row {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 8px 12px 0;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; color: var(--text-secondary);
    background: var(--bg-tertiary); border: 1px solid var(--border);
    border-radius: 999px; padding: 3px 4px 3px 9px; max-width: 150px;
  }
  .chip-x { color: var(--text-tertiary); font-size: 14px; line-height: 1; padding: 0 3px; }
  .chip-x:hover { color: var(--red); }
  .attach-btn {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11.5px; font-weight: 500; color: var(--text-secondary);
    background: var(--bg-tertiary); border: 1px solid var(--border);
    border-radius: 999px; padding: 4px 11px; transition: all var(--transition);
  }
  .attach-btn:hover { color: var(--accent); border-color: var(--border-focus); }

  .input-row { display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--border); align-items: flex-end; }
  .pop-input {
    flex: 1; resize: none; max-height: 90px;
    padding: 9px 11px; background: var(--bg-primary);
    border: 1px solid var(--border); border-radius: var(--radius-sm);
    font-size: 12.5px; color: var(--text-primary); outline: none;
    transition: border-color var(--transition), box-shadow var(--transition);
  }
  .pop-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .send {
    flex-shrink: 0; width: 38px; height: 38px; display: flex; align-items: center; justify-content: center;
    background: var(--accent); color: #fff; border-radius: var(--radius-sm); transition: all var(--transition);
  }
  .send:hover { background: var(--accent-hover); }
  .send:disabled { opacity: 0.4; cursor: default; }
</style>
