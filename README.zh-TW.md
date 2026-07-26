# LingoMuse 靈譯

**自然的中英翻譯，完整留在你的電腦。**

[English](README.md) · [繁體中文](README.zh-TW.md) · [官方網站](https://scotteliu.github.io/LingoMuse/) · [隱私政策](PRIVACY.md)

[![授權：MIT](https://img.shields.io/badge/授權-MIT-22251f.svg)](LICENSE)
[![平台：Windows](https://img.shields.io/badge/平台-Windows-5f725d.svg)](#系統需求)
[![雲端費用：0](https://img.shields.io/badge/雲端費用-%240-8ba087.svg)](#零費用設計)

LingoMuse 是一款開源的 Windows 繁體中文／英文翻譯工具。它使用已訓練完成的本機語言模型理解語境、語氣與慣用說法，提供自然譯文、例句、替代說法及用法重點，而且不會把文字傳送到雲端翻譯服務。

## 為什麼選擇 LingoMuse

- **自然且理解語境**：優先處理意思、口吻、禮貌程度與慣用語，避免逐字硬譯。
- **雙擊複製快速翻譯**：在任何軟體選取文字後連按兩次 `Ctrl+C`，立即開啟翻譯小窗。
- **完整的小窗體驗**：可自由縮放、固定在最上層、調整透明度、複製譯文並播放本機英文發音。
- **用例句真正理解用法**：每次翻譯可提供雙語例句、替代說法與精簡的語感說明。
- **完整本機處理**：翻譯只連到 loopback Ollama 引擎；完整離線版連引擎與模型都包含在內。
- **照顧一般辦公電腦**：自動、速度優先與低資源三種模式，在反應速度和記憶體使用之間取得平衡。
- **沒有訂閱或付費 API**：不需要帳號、API 金鑰、信用卡，也沒有按次費用、廣告或遙測。

## 運作方式

```text
選取文字
    ↓  連按兩次 Ctrl+C
LingoMuse 翻譯小窗
    ↓  只走本機 loopback（127.0.0.1）
本機 Ollama + Qwen 模型
    ↓
自然譯文、例句、語感說明與本機發音
```

輕量版只連接 `127.0.0.1:11434` 的本機 Ollama；完整離線版則在 `127.0.0.1:11435` 啟動內建引擎。程式會拒絕遠端引擎網址。

## 電腦效能模式

| 模式 | 適合對象 | 行為 |
| --- | --- | --- |
| 自動 | 大多數電腦 | 依可用記憶體與 CPU 核心數選擇平衡設定 |
| 速度優先 | 效能較好的電腦 | 讓模型保持暖機，縮短連續翻譯等待時間 |
| 低資源 | 辦公或較舊電腦 | 延後載入模型、限制推論執行緒並釋放閒置記憶體 |

## 本機模型選擇

| 模型 | 約略下載大小 | 建議記憶體 | 定位 |
| --- | ---: | --- | --- |
| `qwen3:1.7b` | 1.4 GB | 8 GB RAM | 輕量、快速，預設選擇 |
| `qwen3:4b-instruct` | 2.5 GB | 8–16 GB RAM | 長句與細膩語氣較穩定 |
| `qwen3:8b` | 5.2 GB | 16 GB+ RAM | 語氣與細節更細膩 |

重要或專業內容仍應對照原文核對。

## 零費用設計

LingoMuse 沒有任何付費翻譯端點，軟體本身不會產生訂閱、API 或按次使用費。下載程式、Ollama 或模型時可能會使用一般網路與電力；安裝完成後即可在本機離線翻譯。

## 隱私

- 沒有帳號、遙測、廣告、分析 SDK 或雲端同步。
- 只有在開啟雙擊複製功能並偵測到觸發動作時，程式才會讀取剪貼簿文字。
- 翻譯紀錄只存在裝置上，預設不保存，而且可以立即清除。
- 英文朗讀只使用作業系統標示為本機的語音。
- 翻譯文字只允許送往 loopback 本機引擎。

請閱讀[繁體中文隱私政策](PRIVACY.md)或[英文隱私政策](PRIVACY.en.md)。

## 系統需求

- Windows 10 或 Windows 11，x64
- 從原始碼開發：Node.js 22+、pnpm 10+
- 輕量版：本機 Ollama 與一個支援的模型
- 完整離線版：不需要另外安裝引擎或模型

## 從原始碼建置

```powershell
pnpm install --frozen-lockfile
pnpm verify
pnpm dev
```

建立 Windows 安裝版與免安裝版：

```powershell
pnpm package:win
```

準備並封裝完整離線版：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-offline-runtime.ps1
pnpm package:offline
```

建立專案網站：

```powershell
pnpm site:build
```

## 開源專案

LingoMuse 採用 [MIT License](LICENSE)。歡迎參與開發；請先閱讀[貢獻指南](CONTRIBUTING.md)、遵守[社群行為準則](CODE_OF_CONDUCT.md)，並依照[安全政策](SECURITY.md)回報安全問題。

第三方元件與模型仍適用各自的授權條款，詳見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

