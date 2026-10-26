# 02 — 雙擊複製擷取

**狀態**：✅ 完成
**最近更新**：2026-10-26

## 目的
在任何程式裡選字、連按兩次 Ctrl+C 就翻譯；只有開啟這個功能且偵測到觸發時才讀剪貼簿。

## 輸入
- 任何程式裡選取的文字

## 輸出
- 送進小窗的待翻文字

## 做法
- `electron/double-copy.mjs`（偵測兩次複製）、`electron/clipboard-capture.mjs`（讀剪貼簿）、`electron/input-policy.mjs`。
- 2026-07-27（#2）：觸發後立刻開小窗，不再固定等 140 ms，慢的剪貼簿寫入者用補讀修正。

程式：`electron/double-copy.mjs`、`electron/clipboard-capture.mjs`

## 相關決策
- D-001（改用 pipeline 格式整理；這一步的設計理由見 README 與 CHANGELOG）

## 待辦
（目前沒有；有新的工作就寫在這裡）

## 紀錄
| 日期 | 內容 |
|---|---|
| 2026-10-26 | 從 README 與 CHANGELOG 整理成步驟檔 |
