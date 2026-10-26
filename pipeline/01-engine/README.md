# 01 — 本機翻譯引擎

**狀態**：✅ 完成
**最近更新**：2026-10-26

## 目的
用本機的小模型做出自然、有例句與語氣說明的翻譯，失敗時說清楚原因。

## 輸入
- 要翻的文字、選的模型（預設 `qwen3:1.7b`，可選 `qwen3:4b-instruct`、`qwen3:8b`）

## 輸出
- 結構化結果：翻譯、替代說法、例句、語氣說明

## 做法
- `electron/translation.mjs`：呼叫 Ollama（輕量版 `127.0.0.1:11434`、完整離線版 `127.0.0.1:11435`），驗證回傳結構、限制回應大小。
- `electron/bundled-engine.mjs`、`engine-wait.mjs`：完整離線版的內建引擎跟著 app 啟動和結束。
- `electron/serial-task-queue.mjs`、`translation-cache.mjs`、`security-policy.mjs`（只准 loopback）。
- 2026-07-27：模型輸出不能用時重試一次（#5）；引擎還在開機時等它，不再直接失敗（#6）。

程式：`electron/translation.mjs`、`electron/bundled-engine.mjs`、`electron/engine-wait.mjs`

## 相關決策
- D-001（改用 pipeline 格式整理；這一步的設計理由見 README 與 CHANGELOG）

## 待辦
- [ ] CHANGELOG「Unreleased」補上 #5（模型輸出不能用時重試一次）和 #6（等引擎開機）——這兩個已合併，但 CHANGELOG 還沒寫

## 紀錄
| 日期 | 內容 |
|---|---|
| 2026-10-26 | 從 README 與 CHANGELOG 整理成步驟檔 |
