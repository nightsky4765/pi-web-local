# Pi Web Local

一個使用 [Pi Coding Agent](https://pi.dev) SDK 製作的非官方本機 Web 介面。

> 本專案不是 Pi 官方產品。Pi Coding Agent 採用 MIT License。

## 功能

- 串流聊天回覆
- 從剪貼簿貼上、拖曳或選擇圖片
- 顯示思考內容與工具執行狀態
- 搜尋並切換已認證的模型
- 使用自訂選單切換思考等級
- 生成期間可直接「插嘴」，讓 Pi 在目前工具完成後調整方向
- 中止生成
- 使用 Pi 原生 Session 保存並恢復對話
- 預設只監聽 `127.0.0.1`
- 預設只啟用 `read`、`grep`、`find`、`ls` 唯讀工具
- 響應式深色介面、環境光暈、按鈕漣漪及減少動態效果支援

## 需求

- Node.js 22.19 或更新版本
- 已經在 Pi 完成模型登入或設定 API Key

## 安裝與開發

```bash
npm install
npm run dev
```

開啟 <http://127.0.0.1:4321>。

## 建置與執行

```bash
npm run build
npm start
```

## 設定

所有設定都透過環境變數處理，程式內沒有固定磁碟或使用者路徑。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `4321` | HTTP Port |
| `HOST` | `127.0.0.1` | 監聽位址；不建議開放到 LAN |
| `PI_WEB_WORKSPACE` | `process.cwd()` | Agent 唯讀工具的工作目錄 |

PowerShell 範例：

```powershell
$env:PORT=9000
$env:PI_WEB_WORKSPACE="相對或絕對的專案路徑"
npm start
```

## 圖片限制

- PNG、JPEG、WebP、GIF
- 單張最多 8 MB
- 每次最多 5 張
- 圖片直接以 Base64 傳給本機後端，不會寫入專案暫存目錄

## 安全

- API Key 只由後端透過 Pi 的認證機制取得，不會送到瀏覽器。
- 預設拒絕非本機來源連線。
- 預設不提供命令執行或檔案寫入工具。
- 請勿把 Pi 的 `auth.json`、Session 或私人檔案提交到版本控制。

## 自動版本與 Release

推送到 `main` 後，GitHub Actions 會自動驗證專案、更新 `CHANGELOG.md`、建立版本標籤並發布 GitHub Release。

版本規則：

- 第一版：`v1.0`
- 一般小改動：次版本加 0.1，例如 `v1.0` → `v1.1`
- 大改動：主版本加 1，例如 `v1.4` → `v2.0`

一般提交使用 Conventional Commits，例如 `feat: ...` 或 `fix: ...`。大改動請使用 `feat!: ...`，或在 commit body 加入 `BREAKING CHANGE:`。

## 授權

本專案使用 MIT License。Pi Coding Agent 的著作權與商標歸其原作者所有。
