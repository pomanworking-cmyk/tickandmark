// Netlify Function：處理所有 /api/* 請求。資料存於 Turso（libSQL）雲端資料庫。
// 需要的環境變數（Netlify → Site configuration → Environment variables）：
//   TURSO_DATABASE_URL   例如 libsql://tickandmark-xxxx.turso.io
//   TURSO_AUTH_TOKEN     Turso 資料庫的存取權杖
//   REGISTRATION_CODE    學校註冊碼（第二位老師起註冊時要輸入）
//   ADMIN_EMAILS         （選填）額外管理員電郵，用逗號分隔；第一位註冊的老師自動是管理員
import { createApp } from '../../server/app.js';
import { openTurso } from '../../server/db-turso.js';

let app = null;
const env = (k) => globalThis.Netlify?.env?.get?.(k) ?? process.env[k] ?? '';

function getApp() {
  if (!app) {
    app = createApp({
      db: openTurso({ url: env('TURSO_DATABASE_URL'), authToken: env('TURSO_AUTH_TOKEN') }),
      registrationCode: env('REGISTRATION_CODE'),
      allowRegistration: env('ALLOW_REGISTRATION') === 'true',
      secureCookie: env('SECURE_COOKIE') !== 'false', // Netlify 一律 HTTPS
      adminEmails: env('ADMIN_EMAILS').split(','),
    });
  }
  return app;
}

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

export default async function handler(req, context) {
  if (!env('TURSO_DATABASE_URL')) return json(500, { error: '網站未設定資料庫：請在 Netlify 加入 TURSO_DATABASE_URL 及 TURSO_AUTH_TOKEN' });
  const url = new URL(req.url);
  const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
  const headers = {}; req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  const out = await getApp()({
    method: req.method, path: url.pathname.replace(/^\/api/, ''), query: Object.fromEntries(url.searchParams),
    headers, bodyText, ip: context?.ip || headers['x-nf-client-connection-ip'] || '',
  });
  return json(out.status, out.body, out.headers);
}

export const config = { path: '/api/*' };
