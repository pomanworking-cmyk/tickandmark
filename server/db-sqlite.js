// 本機 SQLite（Node 22.13+ 內置 node:sqlite），供自行架設伺服器使用。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openSqlite(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const conv = (args) => args.map(a => (a === undefined ? null : typeof a === 'boolean' ? (a ? 1 : 0) : a));
  let inTx = false;
  return {
    kind: 'sqlite', raw,
    async get(sql, ...args) { return raw.prepare(sql).get(...conv(args)) ?? undefined; },
    async all(sql, ...args) { return raw.prepare(sql).all(...conv(args)); },
    async run(sql, ...args) { const r = raw.prepare(sql).run(...conv(args)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    async tx(fn) {
      if (inTx) return fn();
      raw.exec('BEGIN IMMEDIATE'); inTx = true;
      try { const r = await fn(); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
      finally { inTx = false; }
    },
    close() { raw.close(); },
  };
}
