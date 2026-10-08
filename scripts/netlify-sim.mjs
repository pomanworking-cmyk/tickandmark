// 本機模擬 Netlify 正式環境：靜態網頁（netlify.toml 標頭）＋ Netlify Function（每個實例一次只處理一個請求，
// 多個實例並行，似 AWS Lambda）＋ 模擬 Turso（每次 HTTP 往返加延遲）。用於重現正式網站才出現的問題。
// 用法：node scripts/netlify-sim.mjs [port] [latencyMs] [instances]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startTursoMock } from '../test/turso-mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 3920);
const latency = Number(process.argv[3] || 15);
const nInst = Number(process.argv[4] || 3);

const mock = await startTursoMock({ latency, file: process.env.SIM_DB || null });
process.env.TURSO_DATABASE_URL = mock.url;
process.env.TURSO_AUTH_TOKEN = mock.token;
process.env.REGISTRATION_CODE = process.env.REGISTRATION_CODE || 'TM-TEST';
process.env.ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION || 'true';
process.env.SECURE_COOKIE = 'false'; // 本機用 http

// 多個獨立模組實例（每個有自己的 app／資料庫狀態），模擬多個 Lambda 容器
const instances = [];
for (let i = 0; i < nInst; i++) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'netlify/functions/api.mjs')).href + `?inst=${i}`);
  instances.push({ handler: mod.default, busy: false, queue: [] });
}
function runOnInstance(fn) {
  return new Promise((resolve, reject) => {
    const free = instances.find(x => !x.busy);
    const go = (inst) => { inst.busy = true; fn(inst).then(resolve, reject).finally(() => { inst.busy = false; const next = waiting.shift(); if (next) next(inst); }); };
    if (free) go(free); else waiting.push(go);
  });
}
const waiting = [];

const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)[1];
const HEAD = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': csp };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

export const stats = { api: [] };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
    const t0 = Date.now(); const q0 = mock.stats.requests;
    const resp = await runOnInstance(inst => inst.handler(new Request(url, { method: req.method, headers: req.headers, body }), { ip: '127.0.0.1' }));
    const ms = Date.now() - t0;
    if (process.env.SIM_LOG) console.log(`${req.method} ${url.pathname} ${resp.status} ${ms}ms ~${mock.stats.requests - q0} db`);
    const h = { ...HEAD }; resp.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(resp.status, h); res.end(Buffer.from(await resp.arrayBuffer()));
    return;
  }
  let rel = decodeURIComponent(url.pathname); if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, 'public', rel);
  if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, HEAD); return res.end('Not found'); }
  res.writeHead(200, { ...HEAD, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`Netlify 模擬：http://127.0.0.1:${port}/ （Turso 延遲 ${latency}ms，${nInst} 個 Function 實例）`));
