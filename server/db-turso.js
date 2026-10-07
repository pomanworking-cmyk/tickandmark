// Turso（libSQL）雲端資料庫：用官方 HTTP API v2（/v2/pipeline），不需安裝任何套件。
// 規格：https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md 及 HRANA_3_SPEC.md
export function openTurso({ url, authToken, fetchImpl = globalThis.fetch }) {
  if (!url) throw new Error('未設定 TURSO_DATABASE_URL');
  const base = url.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  let txStream = null; // 交易進行中：{ baton, baseUrl }

  const enc = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    return { type: 'text', value: String(v) };
  };
  const dec = (v) => {
    switch (v?.type) {
      case 'integer': return Number(v.value);
      case 'float': return Number(v.value);
      case 'text': return v.value;
      case 'blob': return v.base64;
      default: return null;
    }
  };
  async function pipeline(requests, stream = null) {
    const target = `${stream?.baseUrl || base}/v2/pipeline`;
    const res = await fetchImpl(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) },
      body: JSON.stringify({ baton: stream?.baton ?? null, requests }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`資料庫連線失敗（HTTP ${res.status}）${res.status === 401 ? '：請檢查 TURSO_AUTH_TOKEN' : ''} ${text.slice(0, 120)}`);
    }
    const body = await res.json();
    if (stream) { stream.baton = body.baton ?? null; if (body.base_url) stream.baseUrl = body.base_url; }
    return body.results;
  }
  async function execute(sql, args) {
    const stmt = { sql, args: args.map(enc), want_rows: true };
    const results = txStream
      ? await pipeline([{ type: 'execute', stmt }], txStream)
      : await pipeline([{ type: 'execute', stmt }, { type: 'close' }]);
    const r = results[0];
    if (!r || r.type === 'error') {
      const e = new Error(r?.error?.message || '資料庫錯誤'); e.code = r?.error?.code; throw e;
    }
    const res = r.response.result;
    const names = res.cols.map(c => c.name);
    return {
      rows: res.rows.map(row => Object.fromEntries(row.map((v, i) => [names[i], dec(v)]))),
      changes: Number(res.affected_row_count || 0),
      lastInsertRowid: res.last_insert_rowid == null ? null : Number(res.last_insert_rowid),
    };
  }
  return {
    kind: 'turso',
    async get(sql, ...args) { return (await execute(sql, args)).rows[0]; },
    async all(sql, ...args) { return (await execute(sql, args)).rows; },
    async run(sql, ...args) { const r = await execute(sql, args); return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }; },
    // 多句不需回傳結果的語句，一次 HTTP 請求送出（用於建立資料表，減少冷啟動時間）
    async execMany(sqls) {
      const results = await pipeline([...sqls.map(sql => ({ type: 'execute', stmt: { sql, want_rows: false } })), { type: 'close' }]);
      const err = results.find(r => r.type === 'error'); if (err) throw new Error(err.error?.message || '資料庫錯誤');
    },
    async tx(fn) {
      if (txStream) return fn();
      txStream = { baton: null, baseUrl: null };
      const stream = txStream;
      try {
        await execute('BEGIN IMMEDIATE', []);
        const result = await fn();
        await execute('COMMIT', []);
        return result;
      } catch (e) {
        try { await execute('ROLLBACK', []); } catch { /* 連線已斷，伺服器會自動回滾 */ }
        throw e;
      } finally {
        txStream = null;
        try { await pipeline([{ type: 'close' }], stream); } catch { /* 忽略 */ }
      }
    },
  };
}
