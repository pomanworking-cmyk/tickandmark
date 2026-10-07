// Tick and Mark 伺服器：零第三方依賴（Node 22.13+ 內置 node:sqlite）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApi, HttpError, seedTeacher } from './api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_DAYS = 30;

export function createServer({ dbFile = process.env.DB_FILE || path.join(ROOT, 'data', 'tickandmark.db'),
  registrationCode = process.env.REGISTRATION_CODE || '', allowRegistration = process.env.ALLOW_REGISTRATION === 'true',
  secureCookie = process.env.SECURE_COOKIE === 'true' } = {}) {
  const db = openDb(dbFile);
  const handle = createApi(db);
  const attempts = new Map();

  const hashPw = (pw) => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
  const checkPw = (pw, stored) => {
    const [, salt, hash] = stored.split('$');
    const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64); const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const cookie = (tok, maxAge) => `tm_session=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const newSession = (tid) => {
    const tok = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, teacher_id, expires_at) VALUES (?,?,?)').run(sha(tok), tid, Date.now() + SESSION_DAYS * 864e5);
    return tok;
  };
  const teacherFrom = (req) => {
    const m = /(?:^|;\s*)tm_session=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
    const row = db.prepare('SELECT t.id, t.email, t.name, s.expires_at FROM sessions s JOIN teachers t ON t.id = s.teacher_id WHERE s.token_hash = ?').get(sha(m[1]));
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.id, email: row.email, name: row.name, token: m[1] };
  };

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
  const headers = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob: https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
  };

  function sendJson(res, status, obj, extra = {}) {
    res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
  }
  function serveStatic(req, res) {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let base = path.join(ROOT, 'public');
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) return sendJson(res, 403, { error: '禁止存取' });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { // SPA：其他路徑回到 index.html
        res.writeHead(200, { ...headers, 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        return fs.createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res);
      }
      const ext = path.extname(file);
      res.writeHead(200, { ...headers, 'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=604800' : 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
  }
  const readBody = (req) => new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 2e6) { fail(new HttpError(413, '資料太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(new HttpError(400, '資料格式錯誤')); } });
  });
  function limited(key) {
    const t = Date.now(); const a = (attempts.get(key) || []).filter(x => t - x < 15 * 6e4);
    attempts.set(key, a); return a.length >= 10;
  }

  async function api(req, res, url) {
    const p = url.pathname.slice(4);
    if (req.method !== 'GET' && req.headers['x-tm'] !== '1') throw new HttpError(403, '請求來源不正確'); // 防 CSRF
    const body = req.method === 'GET' ? {} : await readBody(req);

    if (p === '/auth/register' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase(); const name = String(body.name || '').trim().slice(0, 40);
      const pw = String(body.password || '');
      const count = db.prepare('SELECT COUNT(*) n FROM teachers').get().n;
      const codeOk = registrationCode && body.code === registrationCode;
      if (count > 0 && !allowRegistration && !codeOk) throw new HttpError(403, '需要學校提供的註冊碼');
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, '請輸入有效電郵');
      if (!name) throw new HttpError(400, '請輸入老師稱呼');
      if (pw.length < 8) throw new HttpError(400, '密碼最少 8 個字元');
      if (db.prepare('SELECT 1 FROM teachers WHERE email = ?').get(email)) throw new HttpError(409, '此電郵已註冊');
      const r = db.prepare('INSERT INTO teachers (email, name, password_hash) VALUES (?,?,?)').run(email, name, hashPw(pw));
      const tid = Number(r.lastInsertRowid); seedTeacher(db, tid);
      return sendJson(res, 200, { teacher: { id: tid, email, name } }, { 'Set-Cookie': cookie(newSession(tid), SESSION_DAYS * 86400) });
    }
    if (p === '/auth/login' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      const key = `${req.socket.remoteAddress}|${email}`;
      if (limited(key)) throw new HttpError(429, '嘗試次數太多，請 15 分鐘後再試');
      const t = db.prepare('SELECT * FROM teachers WHERE email = ?').get(email);
      if (!t || !checkPw(String(body.password || ''), t.password_hash)) { attempts.get(key).push(Date.now()); throw new HttpError(401, '電郵或密碼不正確'); }
      return sendJson(res, 200, { teacher: { id: t.id, email: t.email, name: t.name } }, { 'Set-Cookie': cookie(newSession(t.id), SESSION_DAYS * 86400) });
    }
    const me = teacherFrom(req);
    if (p === '/auth/me') return sendJson(res, 200, { teacher: me && { id: me.id, email: me.email, name: me.name } });
    if (!me) throw new HttpError(401, '請先登入');
    if (p === '/auth/logout' && req.method === 'POST') {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(me.token));
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
    }
    const out = handle(req.method, p, { tid: me.id, body, query: Object.fromEntries(url.searchParams) });
    return sendJson(res, 200, out);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      return serveStatic(req, res);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      sendJson(res, status, { error: status === 500 ? '伺服器發生錯誤，請稍後再試' : e.message });
    }
  });
  server.db = db;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`Tick and Mark 已啟動：http://localhost:${port}`));
}
