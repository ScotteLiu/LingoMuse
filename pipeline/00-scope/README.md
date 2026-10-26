# 00 — 需求與範圍

**狀態**：✅ 完成
**最近更新**：2026-10-26

## 目的
給一般人用的繁中 ↔ 英文翻譯工具：翻得自然、附例句與用法；完全在自己電腦上跑、不花錢、普通辦公電腦也跑得動。

## 輸入
- 使用者的翻譯需求（README「Why LingoMuse」）

## 輸出
- Windows 10／11 x64 的 Electron 桌面程式，MIT 開源

## 做法
- 文字只送到 loopback 引擎（`127.0.0.1`），遠端位址一律拒絕。
- 沒有帳號、API key、訂閱、廣告、遙測（README「Zero-cost by design」「Privacy」）。
- 兩種版本：輕量版（用使用者自己的 Ollama）、完整離線版（內含引擎和模型）。

程式：`README.md`、`PRIVACY.md`

## 相關決策
- D-001（改用 pipeline 格式整理；這一步的設計理由見 README 與 CHANGELOG）

## 待辦
（目前沒有；有新的工作就寫在這裡）

## 紀錄
| 日期 | 內容 |
|---|---|
| 2026-10-26 | 從 README 與 CHANGELOG 整理成步驟檔 |
