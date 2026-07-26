# Changelog

## Unreleased

- The popup now appears immediately after a double copy instead of waiting a fixed 140 ms, with a follow-up read that corrects slow clipboard writers.
- The user-resized popup size persists across restarts and is fitted to the active display.
- A popup dragged to a chosen spot stays there for follow-up translations while it remains open; dismissing it restores cursor-following.
- Automatic height changes no longer move the popup to the current cursor position mid-translation.
- Optional stage timing (`LINGOMUSE_TIMING=1`) logs the copy-to-speech pipeline for performance measurement.
- Visual polish for the popup: button hover/pressed/copied feedback, refined titlebar, friendlier empty and error states, and larger body text.
- Verified layouts at 125%, 150%, and 200% Windows display scaling.

## 1.1.1 — 2026-07-15

- Removed both the native Windows shadow and the CSS shadow around the quick-translation popup.
- Added reliable eight-direction resizing for the transparent frameless popup.
- Preserved a user-resized window instead of forcing automatic heights on later translations.
- Added responsive compact and wide layouts, a resize affordance, and resize-boundary tests.

## 1.1.0 — 2026-07-14

- Double-`Ctrl+C` translation now opens in a compact always-on-top popup instead of interrupting the main window.
- Added natural translation, pronunciation, copy, speech, nuance notes, and examples directly in the popup.
- The popup can hand the current result to the main window for the full analysis without translating twice.
- Added independent translation cancellation per window and reliable first-trigger delivery while the popup starts.

## 1.0.0 Full Offline — 2026-07-13

- Added a self-contained Windows x64 distribution with Ollama 0.31.2 and Qwen3 1.7B bundled.
- The embedded engine starts automatically on a dedicated loopback port and exits with LingoMuse.
- Kept CPU and Vulkan inference backends while removing the large CUDA runtimes to reduce the download size.
- Added offline-edition UI, third-party notices, and full packaged translation lifecycle tests.

## 1.0.0 — 2026-07-13

- First public-ready Windows release.
- Natural Traditional Chinese ↔ English translation with local Qwen3 models.
- Double-`Ctrl+C` global translation gesture.
- English speech, adjustable voice rate, examples, alternatives, nuance notes, and usage tips.
- Local-only history, tray support, startup option, model management, and zero-cost onboarding.
