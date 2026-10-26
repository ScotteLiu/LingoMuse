# 03 — 快速翻譯小窗

**狀態**：✅ 完成
**最近更新**：2026-10-26

## 目的
不打斷手上工作的置頂小窗，直接看翻譯、聽發音、複製結果；要完整分析再交給主視窗。

## 輸入
- 擷取到的文字

## 輸出
- 小窗：翻譯、發音、複製、語氣說明、例句；可縮放、釘選、調透明度

## 做法
- `src/popup.ts`、`src/popup.css`；位置與大小：`electron/popup-bounds.mjs`、`electron/popup-preferences.mjs`。
- 1.1.0：雙擊複製改開小窗；1.1.1：去掉陰影、八方向縮放、緊湊／寬版版面。
- Unreleased（2026-07-27，#2～#4）：大小重開後保留並貼合螢幕、拖到的位置在小窗開著時保留、自動長高不再跳位置、視覺修飾；125％／150％／200％ 縮放驗過。
- `LINGOMUSE_TIMING=1` 記錄複製到發音的每段時間（`electron/stage-timing.mjs`）。

程式：`src/popup.ts`、`electron/popup-bounds.mjs`、`electron/popup-preferences.mjs`

## 相關決策
- D-001（改用 pipeline 格式整理；這一步的設計理由見 README 與 CHANGELOG）

## 待辦
（目前沒有；有新的工作就寫在這裡）

## 紀錄
| 日期 | 內容 |
|---|---|
| 2026-10-26 | 從 README 與 CHANGELOG 整理成步驟檔 |
