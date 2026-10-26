# 06 — 打包與發佈

**狀態**：✅ 完成
**最近更新**：2026-10-26

## 目的
做出一般人下載就能用的 Windows 版本，包括不必另外裝任何東西的完整離線版。

## 輸入
- 建置結果、（完整離線版）Ollama 執行檔與模型

## 輸出
- NSIS 安裝檔、免安裝版、完整離線版（Ollama 0.31.2＋Qwen3 1.7B，CPU／Vulkan）

## 做法
- `pnpm package:win`（electron-builder nsis＋portable）。
- 完整離線版：`scripts/prepare-offline-runtime.ps1` → `pnpm package:offline`（`electron-builder.offline.yml`、`offline/edition.json`）；拿掉 CUDA runtime 縮小下載。
- 已發佈：1.0.0（2026-07-13）、1.0.0 Full Offline、1.1.0、1.1.1（2026-07-15；`package.json` 的 version）。

程式：`package.json`、`electron-builder.offline.yml`、`scripts/prepare-offline-runtime.ps1`

## 相關決策
- D-001（改用 pipeline 格式整理；這一步的設計理由見 README 與 CHANGELOG）

## 待辦
- [ ] 發下一版：CHANGELOG「Unreleased」的小窗改進與 #5／#6 已合併到 main，還沒發版（`package.json` 仍是 1.1.1；推測，請確認）

## 紀錄
| 日期 | 內容 |
|---|---|
| 2026-10-26 | 從 README 與 CHANGELOG 整理成步驟檔 |
