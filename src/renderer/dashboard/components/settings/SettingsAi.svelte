<script lang="ts">
  import SettingsStt from './SettingsStt.svelte';
  import SettingsProviders from './SettingsProviders.svelte';
</script>

<div class="set-panel-head">
  <h1 class="set-panel-title">AI</h1>
  <p class="set-panel-sub">The transcription engine and the language model behind summaries &amp; live assist.</p>
</div>

<div class="set-subhead">Speech-to-Text</div>
<SettingsStt />

<div class="set-subhead">LLM Providers</div>
<SettingsProviders />
