<script lang="ts">
  interface Props {
    filePath: string;
    label: string;
    readonly?: boolean;
  }

  let { filePath, label, readonly = false }: Props = $props();

  let content = $state('');
  let editing = $state(false);
  let draft = $state('');
  let loaded = $state(false);
  let saving = $state(false);

  async function load() {
    const result = await window.electronAPI.invoke('fs:read-file', filePath) as string | null;
    content = result ?? '';
    loaded = true;
  }

  function startEdit() {
    draft = content;
    editing = true;
  }

  async function save() {
    saving = true;
    await window.electronAPI.invoke('fs:write-file', filePath, draft);
    content = draft;
    editing = false;
    saving = false;
  }

  function cancel() {
    editing = false;
  }

  function renderMarkdown(md: string): string {
    if (!md.trim()) return '';
    let html = md
      // Escape HTML
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Code blocks (fenced)
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="md-code-block"><code>$2</code></pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
      // Headers
      .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold + Italic
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Horizontal rule
      .replace(/^---$/gm, '<hr />')
      // Unordered lists
      .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
      // Paragraphs (double newlines)
      .replace(/\n\n/g, '</p><p>')
      // Single newlines to <br>
      .replace(/\n/g, '<br />');

    // Wrap loose <li> in <ul>
    html = html.replace(/((?:<li>.*?<\/li>\s*(?:<br \/>)?)+)/g, '<ul>$1</ul>');
    html = html.replace(/<ul>\s*<br \/>/g, '<ul>');

    return `<p>${html}</p>`
      .replace(/<p><\/p>/g, '')
      .replace(/<p>(<h[1-4]>)/g, '$1')
      .replace(/(<\/h[1-4]>)<\/p>/g, '$1')
      .replace(/<p>(<pre)/g, '$1')
      .replace(/(<\/pre>)<\/p>/g, '$1')
      .replace(/<p>(<hr \/>)<\/p>/g, '$1')
      .replace(/<p>(<ul>)/g, '$1')
      .replace(/(<\/ul>)<\/p>/g, '$1');
  }

  $effect(() => {
    filePath;
    loaded = false;
    editing = false;
    load();
  });
</script>

<div class="md-editor">
  <div class="md-header">
    <span class="md-label">{label}</span>
    <div class="md-actions">
      {#if editing}
        <button class="md-btn" onclick={cancel}>Cancel</button>
        <button class="md-btn md-btn-save" onclick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      {:else if !readonly}
        <button class="md-btn" onclick={startEdit}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Edit
        </button>
      {/if}
    </div>
  </div>

  {#if !loaded}
    <div class="md-placeholder">Loading...</div>
  {:else if editing}
    <textarea
      class="md-textarea"
      bind:value={draft}
      spellcheck="false"
    ></textarea>
  {:else if content.trim()}
    <div class="md-rendered">
      {@html renderMarkdown(content)}
    </div>
  {:else}
    <div class="md-placeholder">
      {#if readonly}
        Empty
      {:else}
        No content yet.
        <button class="md-link" onclick={startEdit}>Start writing</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .md-editor {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .md-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }

  .md-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .md-actions {
    display: flex;
    gap: 6px;
  }

  .md-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: all var(--transition);
  }

  .md-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .md-btn-save {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .md-btn-save:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .md-btn-save:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .md-textarea {
    width: 100%;
    min-height: 200px;
    padding: 14px;
    background: var(--bg-primary);
    border: none;
    outline: none;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.65;
    color: var(--text-primary);
    resize: vertical;
  }

  .md-rendered {
    padding: 14px;
    font-size: 13px;
    line-height: 1.65;
    color: var(--text-primary);
    min-height: 60px;
  }

  .md-rendered :global(h1) {
    font-family: var(--font-heading);
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 10px;
    color: var(--text-primary);
  }

  .md-rendered :global(h2) {
    font-family: var(--font-heading);
    font-size: 17px;
    font-weight: 700;
    margin: 16px 0 8px;
    color: var(--text-primary);
  }

  .md-rendered :global(h3) {
    font-family: var(--font-heading);
    font-size: 15px;
    font-weight: 600;
    margin: 14px 0 6px;
    color: var(--text-primary);
  }

  .md-rendered :global(h4) {
    font-size: 13px;
    font-weight: 600;
    margin: 12px 0 4px;
    color: var(--text-secondary);
  }

  .md-rendered :global(p) {
    margin: 0 0 8px;
  }

  .md-rendered :global(strong) {
    font-weight: 600;
    color: var(--text-primary);
  }

  .md-rendered :global(em) {
    font-style: italic;
    color: var(--text-secondary);
  }

  .md-rendered :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 12px 0;
  }

  .md-rendered :global(ul) {
    padding-left: 20px;
    margin: 6px 0;
  }

  .md-rendered :global(li) {
    margin: 2px 0;
  }

  .md-rendered :global(.md-code-block) {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    margin: 8px 0;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  .md-rendered :global(.md-inline-code) {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-accent);
  }

  .md-placeholder {
    padding: 28px 14px;
    text-align: center;
    color: var(--text-tertiary);
    font-size: 13px;
  }

  .md-link {
    display: inline;
    padding: 0;
    font-size: 13px;
    color: var(--accent);
    background: none;
    border: none;
    text-decoration: underline;
    cursor: pointer;
  }

  .md-link:hover {
    color: var(--accent-hover);
  }
</style>
