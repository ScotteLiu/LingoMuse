# 07 — 官網與開源文件

**狀態**：✅ 完成
**最近更新**：2026-10-26

## 目的
中英雙語的官網與開源專案文件，讓人看得懂、信得過、能參與。

## 輸入
- README、隱私權政策、第三方授權

## 輸出
- GitHub Pages 網站（`https://scotteliu.github.io/LingoMuse/`）、雙語 README 與隱私權政策、貢獻與安全文件

## 做法
- `site/`（`index.html`、`zh-tw.html`）、`scripts/build-site.mjs` → `_site/`；`.github/workflows/pages.yml` push 到 main 就部署。
- `README.md`／`README.zh-TW.md`、`PRIVACY.md`／`PRIVACY.en.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、`THIRD_PARTY_NOTICES.md`。

程式：`site/`、`scripts/build-site.mjs`、`.github/workflows/pages.yml`

## 相關決策
- D-001（改用 pipeline 格式整理；這一步的設計理由見 README 與 CHANGELOG）

## 待辦
（目前沒有；有新的工作就寫在這裡）

## 紀錄
| 日期 | 內容 |
|---|---|
| 2026-10-26 | 從 README 與 CHANGELOG 整理成步驟檔 |
