# LingoMuse

## Handoff / 接手先讀

1. [`STATUS.md`](STATUS.md)：現在、下一個動作、卡住／依賴。
2. [`AGENTS.md`](AGENTS.md)：這個專案的規則。
3. [`pipeline/PIPELINE.md`](pipeline/PIPELINE.md)：步驟與狀態。
4. Latest [`logs/conversations/`](logs/conversations/) record.

**Natural Chinese–English translation that stays entirely on your computer.**

[English](README.md) · [繁體中文](README.zh-TW.md) · [Website](https://scotteliu.github.io/LingoMuse/) · [Privacy](PRIVACY.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-22251f.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows-5f725d.svg)](#requirements)
[![Cloud cost: $0](https://img.shields.io/badge/Cloud%20cost-%240-8ba087.svg)](#zero-cost-by-design)

LingoMuse is an open-source Windows translation companion for Traditional Chinese and English. It uses a local, already-trained language model to produce context-aware translations, examples, alternatives, and usage notes without sending your text to a cloud translation service.

## Why LingoMuse

- **Natural, context-aware translation** — prioritizes meaning, tone, politeness, and idiomatic phrasing instead of rigid word-for-word output.
- **Double-copy quick translation** — select text in any application and press `Ctrl+C` twice to open a compact translation window.
- **A complete quick window** — resize it, pin it above other windows, adjust opacity, copy results, and play local English pronunciation.
- **Examples that teach usage** — translations include bilingual examples, alternatives, and concise nuance notes.
- **Fully local processing** — translation runs through a loopback-only Ollama engine. The full offline edition bundles both the engine and model.
- **Designed for ordinary office computers** — automatic, speed-first, and low-resource performance profiles balance response time and memory use.
- **No subscription or paid API** — no account, API key, credit card, per-request fee, advertising, or telemetry.

## How it works

```text
Selected text
    ↓  Ctrl+C twice
LingoMuse quick window
    ↓  loopback only (127.0.0.1)
Local Ollama + Qwen model
    ↓
Natural translation, examples, notes, and local speech
```

The lightweight edition connects only to a local Ollama instance at `127.0.0.1:11434`. The full offline edition runs its bundled engine at `127.0.0.1:11435`. Remote engine addresses are rejected.

## Performance profiles

| Profile | Best for | Behavior |
| --- | --- | --- |
| Automatic | Most computers | Selects a balanced configuration from available memory and CPU cores |
| Speed first | Faster computers | Keeps the model warm for the quickest repeated translations |
| Low resource | Office and older PCs | Delays model loading, limits inference threads, and releases idle memory |

## Local model options

| Model | Approximate download | Suggested memory | Positioning |
| --- | ---: | --- | --- |
| `qwen3:1.7b` | 1.4 GB | 8 GB RAM | Lightweight and fast; default |
| `qwen3:4b-instruct` | 2.5 GB | 8–16 GB RAM | More stable for longer sentences |
| `qwen3:8b` | 5.2 GB | 16 GB+ RAM | Finer tone and nuance |

Important or professional material should still be checked against the original text.

## Zero-cost by design

LingoMuse contains no paid translation endpoint. The program itself creates no subscription, API, or usage charge. Normal electricity and internet costs may apply when downloading the application, Ollama, or a model; translation is offline after local installation is complete.

## Privacy

- No account, telemetry, advertising, analytics SDK, or cloud sync.
- Clipboard text is read only after double-copy translation is enabled and the trigger is detected.
- Translation history stays on the device, is disabled by default, and can be cleared immediately.
- English speech uses only voices reported by the operating system as local.
- Translation text is accepted only by a loopback engine address.

Read the [English privacy policy](PRIVACY.en.md) or [Traditional Chinese privacy policy](PRIVACY.md).

## Requirements

- Windows 10 or Windows 11, x64
- Node.js 22+ and pnpm 10+ for source development
- Lightweight edition: a local Ollama installation and one supported model
- Full offline edition: no separate engine or model installation

## Build from source

```powershell
pnpm install --frozen-lockfile
pnpm verify
pnpm dev
```

Build the Windows installer and portable edition:

```powershell
pnpm package:win
```

Prepare and package the complete offline edition:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-offline-runtime.ps1
pnpm package:offline
```

Build the project website:

```powershell
pnpm site:build
```

## Open-source project

LingoMuse is released under the [MIT License](LICENSE). Contributions are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security issues through [SECURITY.md](SECURITY.md).

Third-party components and model licenses remain governed by their respective terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

