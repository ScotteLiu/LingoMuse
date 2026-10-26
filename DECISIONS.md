# 決策紀錄

格式：每條一個編號，不刪除；被推翻的標「已被 D-00N 取代」。

**之前的設計決定**寫在 README（「Why LingoMuse」「Zero-cost by design」「Privacy」）、CHANGELOG.md 和各 PR 的 commit 說明。從 2026-10-26 起新的決定記在這裡。

---

## D-001 — 改用 pipeline 格式整理專案文件
- **日期**：2026-10-26
- **誰決定**：使用者（「好的，你想幫我去轉，然後順序由你來定，開始吧」——所有專案轉成 ai-standard 的 pipeline 格式）
- **決定**：加 `pipeline/PIPELINE.md`＋每步一份 README（照 README 的架構切成 00 範圍、01 本機翻譯引擎、02 雙擊複製擷取、03 快速翻譯小窗、04 主視窗設定與隱私、05 測試、06 打包與發佈、07 官網與開源文件）、`DECISIONS.md`、`logs/conversations/`。**原本的 README、CHANGELOG、程式都不動**；pipeline 文件是索引，細節還是以 README／CHANGELOG 為準。
- **理由**：讓專案儀表板（project-dashboard）看得到進度和下一步；所有專案同一套格式。
- **待確認**：步驟的切法、各步的狀態與待辦是 Claude 從 README／CHANGELOG／git log 整理的。
