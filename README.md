<div align="center">

<img src="logo-mark.png" width="92" alt="Echolect" />

# Echolect

**Your real-time meeting copilot.**
Transcribe, understand, and get AI help while the conversation is still happening.

[![Download](https://img.shields.io/github/v/release/ah2k-dev/echolect?style=flat-square&label=download&color=2563eb)](https://github.com/ah2k-dev/echolect/releases/latest)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-2563eb?style=flat-square)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-47848F?style=flat-square&logo=electron&logoColor=white)
![Svelte 5](https://img.shields.io/badge/Svelte%205-FF3E00?style=flat-square&logo=svelte&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Platform](https://img.shields.io/badge/Linux%20%C2%B7%20Windows-555?style=flat-square)

</div>

---

Echolect listens alongside you during live meetings. It transcribes audio in real time, figures out **who** is speaking, and surfaces on-demand AI assistance in a floating overlay — then, once the meeting ends, it writes a summary and folds it into a rolling, per-project knowledge base so every future meeting starts with context.

<!-- TODO: add a demo screenshot or GIF here, e.g. ![Echolect](docs/demo.png) -->

## ✨ Features

- **Real-time transcription** — low-latency streaming speech-to-text powered by Deepgram's `nova-3` model.
- **Speaker diarization with automatic naming** — speakers are separated and labelled automatically, their names are inferred from the conversation as it unfolds, and you can rename anyone manually at any time (your edits stick).
- **Floating live-assist overlay** — an always-on-top overlay with on-demand intents — **Answer**, **Suggest**, **Ask back**, **Explain** — triggered by click or hotkey, grounded in the live transcript and your context.
- **Your choice of LLM backend** — runs on the **Claude CLI** or the **OpenAI Codex CLI**, whichever you have installed. Switch providers and models in Settings.
- **Grounded from the first second** — every meeting starts pre-loaded with your personal background, the project's accumulated context, and prior meetings' summaries, so the assistant's help is specific to you and the project from the opening question — not generic.
- **Screenshot capture + AI analysis** — grab what's on your screen with one key; Echolect reads it (problem statements, slides, errors, diagrams, code) and feeds that understanding to the assistant.
- **Live running summary** — a summary panel that keeps refreshing as the meeting progresses, so you always have the gist at a glance.
- **Automatic post-meeting summaries** — key points, decisions, and action items, generated in the background when a meeting ends.
- **Per-project rolling context** — each summary is condensed into the project's accumulating context, so the assistant gets sharper about your work over time.
- **Built-in web research** — ask a question and a separate research session searches the web and reads project files, feeding findings back to the assistant.
- **Seekable recordings** — meetings are recorded and remuxed for proper scrubbing.
- **Projects & organization** — group related meetings, with editable personal and per-project context the assistant reads every time.

## 🚀 Getting Started

### 👤 As a user — install the app

1. **Download** the installer for your OS from the [**Releases**](https://github.com/ah2k-dev/echolect/releases/latest) page:
   - **Windows** — `Echolect-Setup-*.exe`
   - **Linux** — `Echolect-*.AppImage` (portable, runs anywhere) or `echolect_*_amd64.deb` (Debian/Ubuntu)
2. **You'll also need** these — Echolect drives local tools, not cloud APIs:
   - a **[Deepgram](https://deepgram.com) API key** — for transcription
   - the **Claude CLI** (`claude`) **or** the **OpenAI Codex CLI** (`codex`), installed and on your `PATH` — for the AI assist
3. **Launch Echolect**, open **Settings**, add your Deepgram key, and pick your LLM provider — see [Configuration](#️-configuration).

### 🛠️ As a developer — run from source

**Prerequisites:** Node.js 18+, plus the Deepgram key and at least one LLM CLI (Claude or Codex) from the user steps above.

```bash
git clone https://github.com/ah2k-dev/echolect
cd echolect
npm install
npm run dev          # starts Vite + the Electron app — one command
```

`npm run dev` starts the Vite dev server, waits for it, compiles the Electron main process, and launches the app — closing the window stops both.

<details>
<summary><b>Build, test & package</b></summary>

```bash
npm test                # run the test suite (Vitest)
npm run build           # build the renderer bundle
npm run build:electron  # compile the Electron main + preload
npm run package         # build installers via electron-builder
```

**Installers.** `npm run package` builds for your current OS — on Linux it produces an **AppImage** and a **.deb**; on Windows, an **NSIS installer** (all in `release/`). The native `better-sqlite3` module can't be cross-compiled, so the Windows installer is built on a real Windows runner — the CI config lives in [`appveyor.yml`](appveyor.yml). Published builds are uploaded to the [Releases](https://github.com/ah2k-dev/echolect/releases) page.

</details>

## ⚙️ Configuration

On first launch you'll get a welcome screen. Open **Settings** to set up:

| Setting | What it does |
| --- | --- |
| **Speech-to-text** | Paste your **Deepgram API key** (testable from Settings). Required for transcription. |
| **LLM provider** | Choose **Claude** or **Codex**, with model + CLI path for the one you pick. |
| **Personal context** | Editable markdown about you — read in every meeting so help is specific to you. |
| **Project context** | Per-project markdown; Echolect maintains a rolling summary inside it, leaving your own notes untouched. |
| **Prompts** | The assistant's behavior, intents, and other prompts — all editable, with one-click reset. |

Personal and project context are plain markdown the assistant reads on demand — the more you put there, the more grounded its help becomes.

## 🧱 Built With

**Electron** · **Svelte 5** · **TypeScript** · **Vite** · **better-sqlite3** · **Deepgram nova-3** (STT) · **Claude / Codex CLI** (LLM)

## 🗺️ Roadmap

Planned for **v2**:

- **🎙️ Voice control** — drive Echolect hands-free. A configurable wake phrase plus spoken commands ("answer that", "summarize", "screenshot") trigger the assistant without touching the keyboard — so it works even while you're sharing your screen or away from the overlay.
- **🌍 Multilingual support** — transcription, speaker diarization, and assistance in languages beyond English, selectable per meeting.
- **🎛️ Runtime-switchable prompt sets** — save named bundles of the assistant's prompts (e.g. *Technical interview*, *Client call*, *Standup*) and switch between them at meeting start or mid-meeting, with no hand-editing.
- **🪟 Hidden overlay on Windows** — keep the overlay invisible to screen-sharing and recording on Windows, so it stays private during calls.

## 📜 License

Echolect is licensed under the **GNU General Public License v3.0** (GPL-3.0) — see [LICENSE](LICENSE).

<div align="center"><sub>Built by <a href="https://ah2k.dev">ah2k.dev</a></sub></div>
