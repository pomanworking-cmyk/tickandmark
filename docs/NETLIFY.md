# 用 Netlify ＋ Turso 上線（一步一步）

完成後，你會有一個網址（例如 `https://tickandmark-你的學校.netlify.app`）。每位老師用自己的電郵及密碼登入，各自管理自己的班；你作為第一位註冊的老師，會自動成為**管理員**。

整個網站由兩部分組成：

| 部分 | 用途 | 服務 |
|---|---|---|
| 網站及後端程式 | 畫面、登入、加分等 | Netlify（Functions） |
| 資料庫 | 老師帳戶、學生、分數、寵物 | Turso（雲端 SQLite） |

兩者都有免費方案，一般小學日常使用通常足夠；實際額度以官網為準。

---

## 第一步：建立 Turso 資料庫

1. 到 <https://turso.tech> 註冊帳戶（可用 GitHub 或 Google 登入）。
2. 按 **Create Database**，名稱例如 `tickandmark`。
3. 地區（Location）揀**美國東部**，有 **Ohio（us-east-2）** 就揀佢；因為 Netlify 函數預設喺 Ohio，兩者愈近，加分反應愈快。
4. 建立後，在資料庫頁面複製 **Database URL**（以 `libsql://` 開頭）。
5. 按 **Create Token**（權限要可讀寫），複製產生的 **Token**。這串字等同資料庫鎖匙，**唔好俾任何人睇**，亦唔好貼喺網頁或聊天群組。

> 唔使自己建立資料表：網站第一次運行時會自動建立。

## 第二步：把程式放上 GitHub

1. 到 <https://github.com> 註冊並登入。
2. 右上角 **＋ → New repository**，名稱例如 `tickandmark`，揀 **Private（私人）**，按 **Create repository**。
3. 解壓 `tickandmark-source.zip`，在新倉庫頁面按 **uploading an existing file**，把 `tickandmark` 資料夾**入面**的所有檔案及資料夾拖進去（要見到 `netlify.toml`、`public`、`server`、`netlify` 在最上層），再按 **Commit changes**。

## 第三步：在 Netlify 建立網站

1. 到 <https://app.netlify.com> 用 GitHub 登入。
2. **Add new site → Import an existing project → GitHub**，揀 `tickandmark` 倉庫。
3. 設定頁面會自動讀取 `netlify.toml`（Publish directory：`public`，Functions：`netlify/functions`），Build command 留空即可。
4. 展開 **Environment variables**（或建立後到 **Site configuration → Environment variables**），加入：

| 名稱 | 內容 |
|---|---|
| `TURSO_DATABASE_URL` | 第一步複製的 `libsql://…` 網址 |
| `TURSO_AUTH_TOKEN` | 第一步複製的 Token |
| `REGISTRATION_CODE` | 你自己定的學校註冊碼，例如 `ABC-2026-tm`（同事註冊時要輸入） |
| `ADMIN_EMAILS` | （選填）想多加的管理員電郵，用逗號分隔 |

5. 按 **Deploy**。約一分鐘後會見到網址。之後改了環境變數，要到 **Deploys → Trigger deploy** 重新部署一次先生效。

## 第四步：開始使用

1. 打開網址，按「新老師註冊」，**你第一個註冊**，會自動成為管理員（第一位註冊唔使註冊碼）。
2. 把網址及註冊碼告訴同事；同事註冊時在「學校註冊碼」欄輸入。
3. 你登入後右上角有 **🛡️ 管理**：可以睇到每位老師最後登入、最後使用、近 7／30 日加分次數，以及開了哪些班（班名、人數、開班日期）。
4. 管理員**睇唔到**任何密碼、學生姓名、分數或功課紀錄。密碼以 scrypt 加密儲存，連資料庫管理者都無法還原。

## 常見問題

- **畫面顯示「網站未設定資料庫」**：環境變數未加或打錯名，加好後要 Trigger deploy。
- **顯示「資料庫連線失敗（HTTP 401）」**：Token 錯或已過期，到 Turso 重新建立 Token，更新 `TURSO_AUTH_TOKEN` 後重新部署。
- **同事話註冊唔到**：檢查佢輸入的註冊碼是否與 `REGISTRATION_CODE` 完全相同（大小寫亦要一樣）。
- **想更改學校註冊碼**：改 `REGISTRATION_CODE` 後重新部署；已註冊的老師不受影響。
- **備份**：Turso 有備份及還原功能（視乎方案）；亦可用 Turso CLI 匯出資料庫。
- **自己架設伺服器而不用 Netlify**：見 README（`npm start` 或 Docker）；如果設定了 `TURSO_DATABASE_URL`，自架伺服器同樣會用 Turso。
