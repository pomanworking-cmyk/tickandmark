# Tick and Mark

香港小學老師用的班級管理網站：可拖動編排的座位表、「先揀分數，一撳學生即加」的快速給分、課室加分、行為標籤、小組、計時、最近操作及撤銷、分數歷史、功課提交（可儲存常用功課名稱，下次一按即用）、考試成績、海報，以及八款原創寵物（蛋 → 寶寶 → 少年 → 成年 → 進化）。全部介面為繁體中文，只用淺色粉彩主題（系統深色模式下仍是淺色），手機、平板及課室大螢幕均適用。

**完全獨立，不依賴 Base44 或任何第三方後端。** 伺服器只需 Node.js 22.13 或以上，零 npm 套件（使用 Node 內置 `node:sqlite`）。

## 快速開始

```bash
node --version          # 需要 v22.13 或以上
npm start               # http://localhost:3000
npm test                # 後端驗收測試（伺服器＋示範後端一致性＋40 張圖）
python3 test/e2e.py     # 瀏覽器驗收（需要 Python Playwright 及 openpyxl）
```

第一位註冊的老師可以直接建立帳戶；之後要設定 `REGISTRATION_CODE`（學校註冊碼）或 `ALLOW_REGISTRATION=true` 才可再註冊。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `3000` | 伺服器埠 |
| `DB_FILE` | `data/tickandmark.db` | SQLite 資料庫位置（必須放在持久磁碟） |
| `REGISTRATION_CODE` | 空 | 新老師註冊時須輸入的學校註冊碼 |
| `ALLOW_REGISTRATION` | `false` | `true` = 任何人可註冊 |
| `SECURE_COOKIE` | `false` | 以 HTTPS 部署時設為 `true` |

## 部署

任何能長期運行 Node 並有持久磁碟的主機均可（學校伺服器、VPS、Render、Railway、Fly.io 等）。

```bash
docker build -t tickandmark .
docker run -d -p 3000:3000 -v tm-data:/app/data -e SECURE_COOKIE=true -e REGISTRATION_CODE=換成你的碼 tickandmark
```

前面加 HTTPS（例如 Caddy 或主機自帶的 TLS）。備份只需複製 `DB_FILE`（運行中可用 `sqlite3 data/tickandmark.db ".backup backup.db"`）。

## 私隱及保安

- 所有 `/api` 資料都要登入；每條查詢都以 `teacher_id` 限制，老師之間互相看不到資料。
- 密碼以 scrypt 加鹽雜湊；工作階段 token 只存雜湊，Cookie 為 HttpOnly + SameSite=Lax。
- 寫入要求必須帶 `X-TM: 1` 標頭（防 CSRF）；登入失敗 15 分鐘內最多 10 次。
- 回應帶 CSP、`X-Frame-Options: DENY`、`noindex`；學生資料不會出現在公開頁面。
- Excel／CSV／相片匯入全部在老師瀏覽器內處理；相片文字辨識（Tesseract.js）只從 jsDelivr 下載辨識程式及字庫，相片本身不會上載。

## 寵物系統規則

- `student_pets`（StudentPet）是學生寵物的**唯一資料來源**，`student_record_id` 對應 `students.id`，每名學生最多一隻（UNIQUE）。
- 全站只經 `public/shared/pet-logic.js` 的 `petImageUrl(pet)` 取圖：`assets/pets/{species_key}/{stage}.webp`。未知品種或階段會直接報錯，**絕不改用其他品種的圖**。課室 icon、學生資料頁、寵物頁、海報及加分彈窗都用同一個 `avatar()` 函數，並在畫面上寫入 `data-species`／`data-stage` 方便核對。
- 派蛋時記下當時最大的 `score_events.id`（`baseline_event_id`）。只有之後產生、`delta > 0` 的課堂加分才計入 XP；匯入的舊分數及派蛋前的分數照樣保留在總分，但不會變成 XP。
- `pet_xp_ledger.score_event_id` 是主鍵：同一筆加分在資料庫層面不能入帳兩次。前端每次操作帶 `client_batch_id`，斷線重送不會重複加分。
- 扣分不影響 XP；撤銷會扣回該筆 XP，但階段**不會倒退**；老師調低門檻會即時升級，調高門檻不會退化。
- 孵化前可更換蛋的品種；`nickname`（改名）已可用，`accessories`（飾物）欄位已預留。
- 設定頁的「資料一致性檢查」（`GET /api/audit`）會逐隻核對 XP＝入帳總和、階段與 XP 相符、沒有不應計入的加分，以及每位學生總分＝紀錄總和。

## 檔案結構

```
server/server.js      HTTP 伺服器、登入、靜態檔案
server/api.js         全部業務邏輯及 API
server/schema.sql     資料庫結構（見 docs/database.md）
public/shared/pet-logic.js  寵物規則（伺服器及瀏覽器共用）
public/js/app.js      前端單頁應用
public/js/ui.js       寵物頭像、加分祝賀彈窗、對話框
public/js/importer.js Excel／CSV（含 Big5）／相片／貼上 匯入
public/js/demo-backend.js  預覽用瀏覽器內示範後端（與伺服器規則相同，測試會比對）
public/assets/pets/   8 款 × 5 階段透明背景圖（由你提供的原圖切割）
scripts/build-preview.mjs  生成預覽示範版（單一 HTML，40 張寵物圖以 data URI 內嵌，毋須外部圖片檔）
test/                 驗收測試
```
