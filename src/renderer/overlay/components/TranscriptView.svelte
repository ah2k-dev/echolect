<script lang="ts">
  import type { TranscriptEntry } from '$shared/types/ipc.js';

  let { entries }: { entries: TranscriptEntry[] } = $props();

  let scrollContainer: HTMLDivElement;

  $effect(() => {
    if (entries.length && scrollContainer) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  });
</script>

<div class="transcript" bind:this={scrollContainer}>
  {#each entries as entry (entry.id)}
    <div class="entry" class:interim={!entry.isFinal}>
      <span class="speaker" class:user={entry.speakerType === 'user'}>
        {entry.speaker}
      </span>
      <span class="text">{entry.text}</span>
    </div>
  {/each}
</div>

<style>
  .transcript {
    flex: 1;
    overflow-y: auto;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.1) transparent;
  }

  .entry {
    font-size: 12px;
    line-height: 1.5;
    transition: opacity 0.2s ease;
  }

  .entry.interim {
    opacity: 0.5;
  }

  .speaker {
    font-weight: 600;
    margin-right: 6px;
    color: var(--accent, #60a5fa);
  }

  .speaker.user {
    color: #34d399;
  }

  .text {
    color: var(--text-primary, #e2e8f0);
  }
</style>
