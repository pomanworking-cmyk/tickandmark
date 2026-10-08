// 連線層：正式版連接伺服器；預覽版（window.TM_DEMO）使用瀏覽器內的示範後端。
import { createDemoBackend } from './demo-backend.js';
import { seedDemo } from './demo-seed.js';

export const IS_DEMO = !!globalThis.TM_DEMO;
let demoReady = null;

function getDemo() {
  demoReady ||= (async () => {
    const be = createDemoBackend(); await seedDemo(be);
    globalThis.__tmDemoState = be.state; // 供驗收腳本核對
    return be;
  })();
  return demoReady;
}

export async function api(method, path, body) {
  if (IS_DEMO) {
    const be = await getDemo();
    try { return await be.request(method, path, body); }
    catch (e) { const err = new Error(e.message); err.status = e.status || 500; throw err; }
  }
  // 讀取，以及帶 client_batch_id 的加分（伺服器會防重複）可以安全地自動重試一次
  const safe = method === 'GET' || (path === '/points' && body?.client_batch_id);
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method, credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-tm': '1' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      if (safe && attempt === 0) { await new Promise(r => setTimeout(r, 600)); continue; }
      const err = new Error('網絡連線中斷，請檢查網絡後再試'); err.status = 0; throw err;
    }
    if (safe && attempt === 0 && [502, 503, 504].includes(res.status)) { await new Promise(r => setTimeout(r, 600)); continue; }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error || (res.status >= 500 ? '伺服器暫時未能回應，請稍後再試' : '發生錯誤')); err.status = res.status; throw err;
    }
    return data ?? {};
  }
}

export const GET = (p) => api('GET', p);
export const POST = (p, b) => api('POST', p, b || {});
export const PUT = (p, b) => api('PUT', p, b || {});
export const PATCH = (p, b) => api('PATCH', p, b || {});
export const DEL = (p) => api('DELETE', p);

export function uid() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}
