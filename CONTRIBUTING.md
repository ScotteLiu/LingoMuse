# Contributing to LingoMuse / 參與 LingoMuse

Thank you for helping make private, natural translation available to more people.

感謝你協助我們把自然、重視隱私的翻譯工具帶給更多人。

## English

1. Search existing issues before opening a new one.
2. For a bug, include Windows version, LingoMuse version, performance profile, model, reproduction steps, and non-sensitive logs.
3. Never include private clipboard text, translation history, model files, API credentials, or personal data.
4. Keep each pull request focused. Add or update tests for behavior changes.
5. Run `pnpm verify` before submitting.

For substantial features, open an issue first so the interaction, privacy impact, resource cost, and offline behavior can be discussed.

## 繁體中文

1. 建立新議題前，請先搜尋是否已有相同問題。
2. 回報錯誤時，請附上 Windows 版本、LingoMuse 版本、效能模式、模型、重現步驟與不含敏感資料的記錄。
3. 請勿提供私人剪貼簿文字、翻譯紀錄、模型檔、API 憑證或個人資料。
4. 每個 Pull Request 請聚焦單一主題；修改行為時請同步新增或更新測試。
5. 提交前請執行 `pnpm verify`。

若功能變更較大，請先建立議題，以便討論互動方式、隱私影響、資源使用及離線行為。

## Development / 開發

```powershell
pnpm install --frozen-lockfile
pnpm verify
pnpm dev
```

By contributing, you agree that your contribution may be distributed under the MIT License.

提交貢獻即表示你同意該內容可依 MIT License 發佈。

