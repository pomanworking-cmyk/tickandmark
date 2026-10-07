// 測試用：模擬 Turso 的 HTTP API v2（/v2/pipeline），背後用 node:sqlite。
// 依照官方規格（HTTP_V2_SPEC.md、HRANA_3_SPEC.md）實作 baton 串流、值編碼及錯誤格式。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function startTursoMock({ token = 'test-token' } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'turso-')), 'db.sqlite');
  const streams = new Map(); // baton -> connection
  const stats = { requests: 0, statements: 0 };
  const open = () => { const c = new DatabaseSync(file); c.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;'); return c; };
  const decArg = (v) => (v.type === 'integer' ? Number(v.value) : v.type === 'float' ? v.value : v.type === 'text' ? v.value : v.type === 'blob' ? Buffer.from(v.base64, 'base64') : null);
  const encVal = (v) => (v === null || v === undefined ? { type: 'null' } : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
    : typeof v === 'bigint' ? { type: 'integer', value: v.toString() } : Buffer.isBuffer(v) || v instanceof Uint8Array ? { type: 'blob', base64: Buffer.from(v).toString('base64') } : { type: 'text', value: String(v) });

  function exec(conn, stmt) {
    stats.statements++;
    const st = conn.prepare(stmt.sql);
    const args = (stmt.args || []).map(decArg);
    const cols = st.columns();
    let rows = [];
    if (cols.length) rows = st.all(...args); else st.run(...args);
    const meta = conn.prepare('SELECT changes() AS c, last_insert_rowid() AS r').get();
    return {
      cols: cols.map(c => ({ name: c.name, decltype: c.type ?? null })),
      rows: rows.map(r => cols.map(c => encVal(r[c.name]))),
      affected_row_count: cols.length && !/^\s*(insert|update|delete)/i.test(stmt.sql) ? 0 : Number(meta.c),
      last_insert_rowid: meta.r == null ? null : String(meta.r),
      rows_read: 0, rows_written: 0, query_duration_ms: 0,
    };
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v2/pipeline') { res.writeHead(404); return res.end('not found'); }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('unauthorized'); }
    let data = ''; req.on('data', c => { data += c; });
    req.on('end', () => {
      stats.requests++;
      const body = JSON.parse(data);
      let conn; let baton = body.baton;
      if (baton) { conn = streams.get(baton); if (!conn) { res.writeHead(400); return res.end('invalid baton'); } streams.delete(baton); }
      else conn = open();
      let closed = false;
      const results = body.requests.map((r) => {
        try {
          if (r.type === 'execute') return { type: 'ok', response: { type: 'execute', result: exec(conn, r.stmt) } };
          if (r.type === 'close') { closed = true; return { type: 'ok', response: { type: 'close' } }; }
          return { type: 'error', error: { message: `unsupported ${r.type}` } };
        } catch (e) { return { type: 'error', error: { message: e.message, code: e.code || 'SQLITE_ERROR' } }; }
      });
      let newBaton = null;
      if (closed) { try { if (conn.isTransaction) conn.exec('ROLLBACK'); } catch { /* */ } conn.close(); }
      else { newBaton = crypto.randomBytes(8).toString('hex'); streams.set(newBaton, conn); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ baton: newBaton, base_url: null, results }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, token, stats, close: () => { for (const c of streams.values()) c.close(); server.close(); } };
}
