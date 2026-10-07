import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// 舊資料庫升級：為已存在的表補上新欄位（新資料庫由 schema.sql 直接建立）
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  if (has('classes') && !cols('classes').includes('seat_cols')) db.exec('ALTER TABLE classes ADD COLUMN seat_cols INTEGER NOT NULL DEFAULT 6');
  if (has('settings') && !cols('settings').includes('hunger_days')) db.exec('ALTER TABLE settings ADD COLUMN hunger_days INTEGER NOT NULL DEFAULT 3');
  if (has('students') && !cols('students').includes('seat_row')) db.exec('ALTER TABLE students ADD COLUMN seat_row INTEGER; ALTER TABLE students ADD COLUMN seat_col INTEGER;');
}
