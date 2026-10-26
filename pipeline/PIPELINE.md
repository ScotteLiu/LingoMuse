# Pipeline 總表

**最近更新**：2026-10-26 — 改用 pipeline 格式整理（D-001）：照 README 的架構切成 00～07；現況 1.1.1 已發佈，CHANGELOG「Unreleased」的小窗改進已合併、還沒發版。

狀態：⬜ 未開始 · 🟡 進行中 · ✅ 完成 · ⛔ 卡住 · ➖ 不需要

| # | 步驟 | 狀態 | 輸入 | 輸出 | 細節 |
|---|---|---|---|---|---|
| 00 | 需求與範圍 | ✅ | 使用者的翻譯需求 | 完全離線、零費用的中英翻譯工具 | [00-scope](00-scope/README.md) |
| 01 | 本機翻譯引擎 | ✅ | 要翻的文字 | 自然翻譯＋例句＋用法說明（本機 Ollama＋Qwen3） | [01-engine](01-engine/README.md) |
| 02 | 雙擊複製擷取 | ✅ | 任何程式裡選取的文字 | 連按兩次 Ctrl+C 觸發翻譯 | [02-double-copy](02-double-copy/README.md) |
| 03 | 快速翻譯小窗 | ✅ | 擷取到的文字 | 置頂小窗：翻譯、發音、複製、例句 | [03-popup](03-popup/README.md) |
| 04 | 主視窗、設定與隱私 | ✅ | 使用者設定 | 完整分析、歷史、效能模式、模型管理、隱私預設 | [04-main-settings](04-main-settings/README.md) |
| 05 | 測試 | ✅ | 原始碼 | vitest 單元測試、Electron smoke、UI 截圖 | [05-tests](05-tests/README.md) |
| 06 | 打包與發佈 | ✅ | 建置結果 | 安裝檔、免安裝版、完整離線版 | [06-packaging](06-packaging/README.md) |
| 07 | 官網與開源文件 | ✅ | README、隱私權政策 | 雙語 GitHub Pages 網站、開源文件 | [07-site-docs](07-site-docs/README.md) |

## 流向

```
選取文字 ─ 02 連按兩次 Ctrl+C ─ 03 快速翻譯小窗 ─┐
04 主視窗（完整分析、歷史、設定）──────────────┴─ 01 本機引擎（127.0.0.1，Ollama＋Qwen3）
05 測試 ─ 06 打包（安裝檔／免安裝／完整離線版）─ 07 官網與開源文件
```

## 目前的阻塞

（無）

## 歷史

| 日期 | 變更 |
|---|---|
| 2026-10-26 | 改用 pipeline 格式整理（D-001）；之前的版本歷史在 CHANGELOG.md |
