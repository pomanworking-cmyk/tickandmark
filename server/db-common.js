// 資料庫共用：建立資料表、舊資料庫升級。適用於本機 SQLite 及 Turso（libSQL）。
import { SCHEMA } from './schema.js';

export function splitSql(sql) {
  return sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
}

const UPGRADES = [
  ['classes', 'seat_cols', 'INTEGER NOT NULL DEFAULT 6'],
  ['settings', 'hunger_days', 'INTEGER NOT NULL DEFAULT 3'],
  ['students', 'seat_row', 'INTEGER'],
  ['students', 'seat_col', 'INTEGER'],
  ['teachers', 'is_admin', 'INTEGER NOT NULL DEFAULT 0'],
  ['teachers', 'last_login_at', 'TEXT'],
  ['teachers', 'last_seen_at', 'TEXT'],
];

export async function initSchema(db) {
  // 先升級舊表（加欄位），再建立缺少的表及索引。一次查詢讀取全部現有欄位，減少雲端冷啟動時間。
  let existing;
  try {
    const rows = await db.all("SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table'");
    existing = new Set(rows.map(r => `${r.t}.${r.c}`)); const tables = new Set(rows.map(r => r.t));
    for (const [t, c, def] of UPGRADES) if (tables.has(t) && !existing.has(`${t}.${c}`)) await db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  } catch {
    // 後備：逐個表檢查
    const has = async (t) => !!(await db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t));
    const cols = async (t) => (await db.all(`PRAGMA table_info(${t})`)).map(c => c.name);
    for (const [t, c, def] of UPGRADES) if ((await has(t)) && !(await cols(t)).includes(c)) await db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
  }
  const stmts = splitSql(SCHEMA);
  if (db.execMany) await db.execMany(stmts); else for (const stmt of stmts) await db.run(stmt);
}
