<script lang="ts">
  import { onMount, tick } from 'svelte';
  import AiEditPopover from './AiEditPopover.svelte';
  import Modal from '../Modal.svelte';

  interface Props {
    target?: string | null;
  }
  let { target = null }: Props = $props();

  type Sub = 'modes' | 'personal' | 'intents' | 'tools';

  const modes = [
    { key: 'prompt_project', label: 'Assistant', desc: 'persona, transcript-reading & response rules.' },
  ];
  const tools = [
    { key: 'prompt_research', label: 'Research', desc: 'How the separate web-research session answers (web search + file read). Its findings feed the main assistant.' },
    { key: 'prompt_screenshot', label: 'Screenshot analysis', desc: 'How a captured screenshot is read and described. The main assistant acts only on this description.' },
    { key: 'prompt_scribe', label: 'Scribe (speaker naming)', desc: 'How the background Scribe identifies participants from the conversation and names them. Its map relabels "Participant N" → real names live and in the saved transcript.' },
  ];
  const personal = {
    key: 'personal_context',
    label: 'Personal Context',
    desc: 'Your resume / background. Injected into every meeting, every mode.',
    placeholder: 'Paste your resume or a summary of your background…',
  };
  const intentFields = [
    { key: 'intent_answer_prompt', label: 'Answer', desc: 'Sent when you trigger the Answer hotkey.' },
    { key: 'intent_suggest_prompt', label: 'Suggest', desc: 'Sent when you trigger the Suggest hotkey.' },
    { key: 'intent_askback_prompt', label: 'Ask back', desc: 'Sent when you trigger the Ask-back hotkey.' },
    { key: 'intent_explain_prompt', label: 'Explain', desc: 'Sent when you trigger the Explain hotkey.' },
  ];

  const subtabs: { id: Sub; label: string }[] = [
    { id: 'modes', label: 'Persona' },
    { id: 'personal', label: 'Personal Context' },
    { id: 'intents', label: 'Intents' },
    { id: 'tools', label: 'Research & Vision' },
  ];

  // Mode + intent + tool prompts are behavior config → DB. Personal context is knowledge → a file.
  const dbKeys = [...modes.map(m => m.key), ...intentFields.map(i => i.key), ...tools.map(t => t.key)];

  function subFor(key: string | null): Sub {
    if (!key) return 'modes';
    if (key.startsWith('intent_')) return 'intents';
    if (key === 'personal_context') return 'personal';
    if (key === 'prompt_research' || key === 'prompt_screenshot' || key === 'prompt_scribe') return 'tools';
    return 'modes';
  }

  let sub = $state<Sub>(subFor(target));
  let values = $state<Record<string, string>>({});
  let highlight = $state<string | null>(null);
  let saving = $state(false);
  let msg = $state<{ ok: boolean; text: string } | null>(null);

  // AI edit popover
  let editing = $state<{ key: string; title: string; allowAttach: boolean; anchor: DOMRect } | null>(null);
  function openEdit(e: MouseEvent, key: string, title: string, allowAttach: boolean) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    editing = { key, title, allowAttach, anchor: rect };
  }

  async function load() {
    for (const k of dbKeys) {
      const v = await window.electronAPI.invoke('settings:get', k) as string | undefined;
      values[k] = v ?? '';
    }
    values[personal.key] = (await window.electronAPI.invoke('personal-context:get') as string) ?? '';
  }

  async function save() {
    saving = true; msg = null;
    try {
      for (const k of dbKeys) {
        await window.electronAPI.invoke('settings:set', k, values[k] ?? '');
      }
      await window.electronAPI.invoke('personal-context:set', values[personal.key] ?? '');
      msg = { ok: true, text: 'Prompts saved' };
    } catch { msg = { ok: false, text: 'Failed to save prompts' }; }
    saving = false;
  }

  // Restore-defaults modal: pick which prompts to reset (personal context is never touched).
  const restorable = [...modes, ...intentFields, ...tools];
  let showRestore = $state(false);
  let restoreSel = $state<Record<string, boolean>>({});

  function openRestore() {
    restoreSel = Object.fromEntries(restorable.map(p => [p.key, true]));
    showRestore = true;
  }

  async function doRestore() {
    const keys = restorable.map(p => p.key).filter(k => restoreSel[k]);
    if (!keys.length) { showRestore = false; return; }
    saving = true; msg = null;
    try {
      await window.electronAPI.invoke('settings:reset-prompts', keys);
      for (const k of keys) {
        values[k] = (await window.electronAPI.invoke('settings:get', k) as string) ?? '';
      }
      msg = { ok: true, text: `Restored ${keys.length} prompt${keys.length > 1 ? 's' : ''} to default` };
    } catch { msg = { ok: false, text: 'Failed to restore defaults' }; }
    saving = false; showRestore = false;
  }

  onMount(async () => {
    await load();
    if (target) {
      sub = subFor(target);
      await tick();
      const el = document.getElementById(`prompt-${target}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        highlight = target;
        setTimeout(() => { highlight = null; }, 1600);
      }
    }
  });
</script>

{#snippet fieldLabel(key: string, label: string, desc: string, allowAttach: boolean)}
  <span class="set-label">
    {label} <span class="set-hint">— {desc}</span>
    <button class="ai-edit" onclick={(e) => openEdit(e, key, label, allowAttach)} title="Edit with AI">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.8L20 9.7l-5.1 3.7L16 20l-4-3.4L8 20l1.1-6.6L4 9.7l6.1-1.9z"/></svg>
      AI
    </button>
  </span>
{/snippet}

<div class="set-panel-head">
  <h1 class="set-panel-title">Prompts</h1>
  <p class="set-panel-sub">The assistant's behavior. Knowledge (resume, project notes) lives here too — context files hold the rest.</p>
</div>

<div class="subtabs">
  {#each subtabs as t}
    <button class="subtab" class:active={sub === t.id} onclick={() => sub = t.id}>{t.label}</button>
  {/each}
</div>

{#if sub === 'modes'}
  <div class="set-card">
    <div class="set-card-desc" style="margin-bottom:14px;">The full behavior of the live assistant in every meeting. Your personal + project context is injected automatically — no need to repeat it here.</div>
    {#each modes as m}
      <div class="set-field" id={`prompt-${m.key}`} class:flash={highlight === m.key}>
        {@render fieldLabel(m.key, m.label, m.desc, false)}
        <textarea class="set-textarea" rows="14" bind:value={values[m.key]}></textarea>
      </div>
    {/each}
  </div>
{:else if sub === 'personal'}
  <div class="set-card">
    <div class="set-field" id={`prompt-${personal.key}`} class:flash={highlight === personal.key}>
      {@render fieldLabel(personal.key, personal.label, personal.desc, true)}
      <textarea class="set-textarea" rows="12" placeholder={personal.placeholder} bind:value={values[personal.key]}></textarea>
    </div>
  </div>
{:else if sub === 'intents'}
  <div class="set-card">
    <div class="set-card-desc" style="margin-bottom:14px;">Each is layered on the live transcript when you press the matching hotkey.</div>
    {#each intentFields as i}
      <div class="set-field" id={`prompt-${i.key}`} class:flash={highlight === i.key}>
        {@render fieldLabel(i.key, i.label, i.desc, false)}
        <textarea class="set-textarea" rows="3" bind:value={values[i.key]}></textarea>
      </div>
    {/each}
  </div>
{:else if sub === 'tools'}
  <div class="set-card">
    <div class="set-card-desc" style="margin-bottom:14px;">These run as separate sessions; their output is fed back to the main assistant.</div>
    {#each tools as t}
      <div class="set-field" id={`prompt-${t.key}`} class:flash={highlight === t.key}>
        {@render fieldLabel(t.key, t.label, t.desc, false)}
        <textarea class="set-textarea" rows="7" bind:value={values[t.key]}></textarea>
      </div>
    {/each}
  </div>
{/if}

<div class="set-actions" style="margin-top: 16px; display: flex; gap: 10px; align-items: center;">
  <button class="set-btn" onclick={save} disabled={saving}>{saving ? 'Saving…' : 'Save prompts'}</button>
  <button class="set-btn ghost" onclick={openRestore} disabled={saving}>Restore defaults…</button>
</div>
{#if msg}<div class="set-msg" class:ok={msg.ok} class:err={!msg.ok}>{msg.text}</div>{/if}

{#if editing}
  <AiEditPopover
    anchor={editing.anchor}
    title={editing.title}
    currentContent={values[editing.key] ?? ''}
    allowAttach={editing.allowAttach}
    onApply={(c) => { values[editing!.key] = c; }}
    onClose={() => editing = null}
  />
{/if}

<Modal title="Restore default prompts" open={showRestore} onClose={() => (showRestore = false)}>
  <p class="rd-note">Pick which prompts to reset to their built-in defaults. <b>Personal Context is never affected.</b> Any edits to the selected prompts will be lost.</p>
  <div class="rd-list">
    {#each restorable as p}
      <label class="rd-row">
        <input type="checkbox" bind:checked={restoreSel[p.key]} />
        <span>{p.label}</span>
      </label>
    {/each}
  </div>
  <div class="rd-actions">
    <button type="button" class="set-btn ghost" onclick={() => (showRestore = false)}>Cancel</button>
    <button type="button" class="set-btn" onclick={doRestore} disabled={saving}>Restore selected</button>
  </div>
</Modal>

<style>
  .subtabs {
    display: flex;
    gap: 4px;
    padding: 3px;
    margin-bottom: 18px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    width: fit-content;
  }
  .subtab {
    padding: 6px 14px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--text-secondary);
    border-radius: 6px;
    transition: all var(--transition);
  }
  .subtab:hover { color: var(--text-primary); }
  .subtab.active {
    background: var(--bg-elevated);
    color: var(--text-primary);
    box-shadow: var(--shadow-sm);
  }

  .set-field { scroll-margin-top: 20px; border-radius: var(--radius-sm); }
  .set-label { align-items: center; }
  .flash { animation: flash 1.6s ease-out; }
  @keyframes flash {
    0% { box-shadow: 0 0 0 8px var(--accent-soft); background: var(--accent-soft); }
    100% { box-shadow: 0 0 0 0 transparent; background: transparent; }
  }

  .ai-edit {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 3px 9px;
    transition: all var(--transition);
  }
  .ai-edit:hover { border-color: var(--border-focus); filter: brightness(1.1); }

  .set-btn.ghost {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }
  .set-btn.ghost:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--border-focus); }

  .rd-note { font-size: 12.5px; color: var(--text-tertiary); line-height: 1.5; margin-bottom: 14px; }
  .rd-list { display: flex; flex-direction: column; gap: 2px; margin-bottom: 18px; }
  .rd-row { display: flex; align-items: center; gap: 9px; padding: 8px 10px; border-radius: var(--radius-sm); font-size: 13px; color: var(--text-primary); cursor: pointer; transition: background var(--transition); }
  .rd-row:hover { background: var(--bg-tertiary); }
  .rd-row input { accent-color: var(--accent); width: 15px; height: 15px; }
  .rd-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
