// 資料庫共用：建立資料表、舊資料庫升級。適用於本機 SQLite 及 Turso（libSQL）。
import { SCHEMA } from './schema.js';

export function splitSql(sql) {
  return sql.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')
    .split(';').map(s => s.trim()).filter(Boolean);
}

export async function initSchema(db) {
  // 先升級舊表（加欄位），再建立缺少的表及索引
  const has = async (t) => !!(await db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t));
  const cols = async (t) => (await db.all(`PRAGMA table_info(${t})`)).map(c => c.name);
  const addCol = async (t, c, def) => { if ((await has(t)) && !(await cols(t)).includes(c)) await db.run(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  await addCol('classes', 'seat_cols', 'INTEGER NOT NULL DEFAULT 6');
  await addCol('settings', 'hunger_days', 'INTEGER NOT NULL DEFAULT 3');
  await addCol('students', 'seat_row', 'INTEGER');
  await addCol('students', 'seat_col', 'INTEGER');
  await addCol('teachers', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  await addCol('teachers', 'last_login_at', 'TEXT');
  await addCol('teachers', 'last_seen_at', 'TEXT');
  const stmts = splitSql(SCHEMA);
  if (db.execMany) await db.execMany(stmts); else for (const stmt of stmts) await db.run(stmt);
}
