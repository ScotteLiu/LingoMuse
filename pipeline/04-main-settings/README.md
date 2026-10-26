# 04 — 主視窗、設定與隱私

**狀態**：✅ 完成
**最近更新**：2026-10-26

## 目的
完整分析與管理：歷史、模型、效能模式、開機啟動；隱私預設保守。

## 輸入
- 使用者設定、小窗交過來的結果

## 輸出
- 主視窗（完整分析、歷史）、系統匣、設定

## 做法
- `src/main.ts`、`src/history.ts`、`src/local-speech.ts`（只用系統回報為本機的語音）。
- `electron/main.mjs`、`settings-store.mjs`、`history-store.mjs`（只存本機、預設關閉、可立即清除）。
- `electron/performance-profile.mjs`：自動／速度優先／低資源三種模式。
- `electron/privacy-defaults.mjs`、`startup-privacy.mjs`、`resume-recovery.mjs`。

程式：`src/main.ts`、`electron/main.mjs`、`electron/settings-store.mjs`、`electron/performance-profile.mjs`

## 相關決策
- D-001（改用 pipeline 格式整理；這一步的設計理由見 README 與 CHANGELOG）

## 待辦
（目前沒有；有新的工作就寫在這裡）

## 紀錄
| 日期 | 內容 |
|---|---|
| 2026-10-26 | 從 README 與 CHANGELOG 整理成步驟檔 |
