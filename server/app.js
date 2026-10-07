// Tick and Mark 請求處理（與平台無關）：登入、工作階段、防 CSRF、管理員、業務 API。
// 本機伺服器（server.js）及 Netlify Function（netlify/functions/api.mjs）共用。
import crypto from 'node:crypto';
import { createApi, HttpError, seedTeacher } from './api.js';
import { initSchema } from './db-common.js';

const SESSION_DAYS = 30;
const SEEN_THROTTLE_MS = 5 * 60 * 1000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPw(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64); const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createApp({ db, registrationCode = '', allowRegistration = false, secureCookie = false, adminEmails = [] }) {
  const handle = createApi(db);
  const admins = new Set(adminEmails.map(e => e.trim().toLowerCase()).filter(Boolean));
  let ready = null;
  const init = () => (ready ||= initSchema(db).catch((e) => { ready = null; throw e; }));

  const cookie = (tok, maxAge) => `tm_session=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureCookie ? '; Secure' : ''}`;
  const publicTeacher = (t) => t && ({ id: t.id, email: t.email, name: t.name, is_admin: !!t.is_admin || admins.has(String(t.email).toLowerCase()) });

  async function newSession(tid) {
    const tok = crypto.randomBytes(32).toString('base64url');
    await db.run('INSERT INTO sessions (token_hash, teacher_id, expires_at) VALUES (?,?,?)', sha(tok), tid, Date.now() + SESSION_DAYS * 864e5);
    await db.run('UPDATE teachers SET last_login_at = ?, last_seen_at = ? WHERE id = ?', nowIso(), nowIso(), tid);
    return tok;
  }
  async function teacherFrom(headers) {
    const m = /(?:^|;\s*)tm_session=([^;]+)/.exec(headers.cookie || ''); if (!m) return null;
    const row = await db.get(`SELECT t.id, t.email, t.name, t.is_admin, t.last_seen_at, s.expires_at FROM sessions s JOIN teachers t ON t.id = s.teacher_id WHERE s.token_hash = ?`, sha(m[1]));
    if (!row || row.expires_at < Date.now()) return null;
    if (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > SEEN_THROTTLE_MS) {
      await db.run('UPDATE teachers SET last_seen_at = ? WHERE id = ?', nowIso(), row.id); // 管理員可見「最後使用時間」
    }
    return { ...row, token: m[1] };
  }
  async function tooManyAttempts(key) {
    const since = Date.now() - 15 * 60 * 1000;
    const r = await db.get('SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND at > ?', key, since);
    return (r?.n || 0) >= 10;
  }

  // 管理員：只回傳老師帳戶資料、使用時間及班別概況；不含密碼、學生姓名或分數紀錄
  async function adminTeachers() {
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
    const teachers = await db.all(`SELECT t.id, t.name, t.email, t.is_admin, t.created_at, t.last_login_at, t.last_seen_at,
        (SELECT COUNT(*) FROM classes c WHERE c.teacher_id = t.id) AS class_count,
        (SELECT COUNT(*) FROM students s WHERE s.teacher_id = t.id) AS student_count,
        (SELECT COUNT(*) FROM score_batches b WHERE b.teacher_id = t.id AND b.created_at >= ?) AS actions_7d,
        (SELECT COUNT(*) FROM score_batches b WHERE b.teacher_id = t.id AND b.created_at >= ?) AS actions_30d,
        (SELECT MAX(b.created_at) FROM score_batches b WHERE b.teacher_id = t.id) AS last_points_at
      FROM teachers t ORDER BY t.created_at, t.id`, weekAgo, monthAgo);
    const classes = await db.all(`SELECT c.id, c.teacher_id, c.name, c.school_year, c.created_at,
        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count
      FROM classes c ORDER BY c.teacher_id, c.name, c.id`);
    return teachers.map(t => ({
      ...t, is_admin: !!t.is_admin || admins.has(String(t.email).toLowerCase()),
      classes: classes.filter(c => c.teacher_id === t.id).map(({ teacher_id, ...c }) => c),
    }));
  }

  async function route({ method, path, query, headers, body, ip }) {
    if (path === '/auth/register' && method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase(); const name = String(body.name || '').trim().slice(0, 40);
      const pw = String(body.password || '');
      const count = (await db.get('SELECT COUNT(*) AS n FROM teachers')).n;
      const codeOk = registrationCode && body.code === registrationCode;
      if (count > 0 && !allowRegistration && !codeOk) throw new HttpError(403, '需要學校提供的註冊碼');
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, '請輸入有效電郵');
      if (!name) throw new HttpError(400, '請輸入老師稱呼');
      if (pw.length < 8) throw new HttpError(400, '密碼最少 8 個字元');
      if (await db.get('SELECT 1 AS x FROM teachers WHERE email = ?', email)) throw new HttpError(409, '此電郵已註冊');
      // 第一位註冊的老師自動成為管理員
      const r = await db.run('INSERT INTO teachers (email, name, password_hash, is_admin) VALUES (?,?,?,?)', email, name, hashPw(pw), count === 0 ? 1 : 0);
      const tid = Number(r.lastInsertRowid);
      await seedTeacher(db, tid);
      const t = await db.get('SELECT id, email, name, is_admin FROM teachers WHERE id = ?', tid);
      return { status: 200, body: { teacher: publicTeacher(t) }, cookie: cookie(await newSession(tid), SESSION_DAYS * 86400) };
    }
    if (path === '/auth/login' && method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      const key = sha(`${ip || ''}|${email}`);
      if (await tooManyAttempts(key)) throw new HttpError(429, '嘗試次數太多，請 15 分鐘後再試');
      const t = await db.get('SELECT * FROM teachers WHERE email = ?', email);
      if (!t || !checkPw(String(body.password || ''), t.password_hash)) {
        await db.run('INSERT INTO login_attempts (key, at) VALUES (?,?)', key, Date.now());
        await db.run('DELETE FROM login_attempts WHERE at < ?', Date.now() - 864e5);
        throw new HttpError(401, '電郵或密碼不正確');
      }
      await db.run('DELETE FROM login_attempts WHERE key = ?', key);
      return { status: 200, body: { teacher: publicTeacher(t) }, cookie: cookie(await newSession(t.id), SESSION_DAYS * 86400) };
    }
    const me = await teacherFrom(headers);
    if (path === '/auth/me') return { status: 200, body: { teacher: publicTeacher(me) } };
    if (!me) throw new HttpError(401, '請先登入');
    if (path === '/auth/logout' && method === 'POST') {
      await db.run('DELETE FROM sessions WHERE token_hash = ?', sha(me.token));
      return { status: 200, body: { ok: true }, cookie: cookie('', 0) };
    }
    if (path === '/admin/teachers' && method === 'GET') {
      if (!publicTeacher(me).is_admin) throw new HttpError(403, '只限管理員');
      return { status: 200, body: { teachers: await adminTeachers() } };
    }
    return { status: 200, body: await handle(method, path, { tid: me.id, body, query }) };
  }

  // req: { method, path（不含 /api）, query, headers（小寫鍵）, bodyText, ip }
  return async function handleRequest(req) {
    try {
      if (req.method !== 'GET' && req.headers['x-tm'] !== '1') throw new HttpError(403, '請求來源不正確'); // 防 CSRF
      if ((req.bodyText || '').length > 2e6) throw new HttpError(413, '資料太大');
      let body = {};
      if (req.method !== 'GET' && req.bodyText) { try { body = JSON.parse(req.bodyText); } catch { throw new HttpError(400, '資料格式錯誤'); } }
      await init();
      const out = await route({ ...req, body: body || {} });
      return { status: out.status, body: out.body, headers: out.cookie ? { 'Set-Cookie': out.cookie } : {} };
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return { status, body: { error: status === 500 ? '伺服器發生錯誤，請稍後再試' : e.message }, headers: {} };
    }
  };
}
