# 05 — 測試

**狀態**：✅ 完成
**最近更新**：2026-10-26

## 目的
每個 electron 模組都有單元測試；打包後的翻譯流程與小窗版面也實際跑過。

## 輸入
- 原始碼

## 輸出
- `pnpm verify`（typecheck＋vitest＋vite build）、Electron smoke test、UI 截圖

## 做法
- `tests/*.test.ts`（每個 electron 模組一份，#5 時共 127 個測試）。
- `pnpm test:electron`（`LINGOMUSE_SMOKE_TEST=1`）、`pnpm test:ui`（`tests/ui-capture.cjs`）。
- #6 用新的 `LINGOMUSE_POPUP_EARLY_TRIGGER` 測試模式，以真的內建引擎端到端驗證。

程式：`tests/`、`package.json`（scripts）

## 相關決策
- D-001（改用 pipeline 格式整理；這一步的設計理由見 README 與 CHANGELOG）

## 待辦
（目前沒有；有新的工作就寫在這裡）

## 紀錄
| 日期 | 內容 |
|---|---|
| 2026-10-26 | 從 README 與 CHANGELOG 整理成步驟檔 |
