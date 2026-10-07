// Tick and Mark 本機／自架伺服器：零第三方依賴（Node 22.13+ 內置 node:sqlite）
// 雲端（Netlify）版本見 netlify/functions/api.mjs，兩者共用 server/app.js。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from './db-sqlite.js';
import { openTurso } from './db-turso.js';
import { createApp } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
};

export function createServer({ db, dbFile = process.env.DB_FILE || path.join(ROOT, 'data', 'tickandmark.db'),
  registrationCode = process.env.REGISTRATION_CODE || '', allowRegistration = process.env.ALLOW_REGISTRATION === 'true',
  secureCookie = process.env.SECURE_COOKIE === 'true', adminEmails = (process.env.ADMIN_EMAILS || '').split(',') } = {}) {
  // 有設定 TURSO_DATABASE_URL 就用 Turso 雲端資料庫，否則用本機 SQLite 檔案
  db ||= process.env.TURSO_DATABASE_URL ? openTurso({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }) : openSqlite(dbFile);
  const app = createApp({ db, registrationCode, allowRegistration, secureCookie, adminEmails });
  // 本機 SQLite 只有一條連線：逐個處理 API 請求，避免交易互相干擾
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

  function serveStatic(req, res) {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const base = path.join(ROOT, 'public');
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        return fs.createReadStream(path.join(base, 'index.html')).pipe(res);
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=604800' : 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  }
  const readBody = (req) => new Promise((ok) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size <= 2e6 + 1) chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    const bodyText = req.method === 'GET' ? '' : await readBody(req);
    const out = await serial(() => app({
      method: req.method, path: url.pathname.slice(4), query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v])),
      bodyText, ip: req.socket.remoteAddress,
    }));
    res.writeHead(out.status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...out.headers });
    res.end(JSON.stringify(out.body));
  });
  server.db = db;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`Tick and Mark 已啟動：http://localhost:${port}`));
}
