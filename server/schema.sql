-- Tick and Mark 資料庫結構（SQLite）。所有資料都以 teacher_id 分隔，只限登入老師本人讀寫。

CREATE TABLE IF NOT EXISTS teachers (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  teacher_id  INTEGER PRIMARY KEY REFERENCES teachers(id) ON DELETE CASCADE,
  thresholds  TEXT NOT NULL,              -- JSON {baby, junior, adult, evolved}
  timer_presets TEXT NOT NULL DEFAULT '[60,180,300,600]'
);

CREATE TABLE IF NOT EXISTS classes (
  id          INTEGER PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,               -- 例如 4A
  school_year TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#5b8def'
);

-- Student
CREATE TABLE IF NOT EXISTS students (
  id          INTEGER PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  number      INTEGER,                     -- 班號
  name        TEXT NOT NULL,
  group_id    INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  score       INTEGER NOT NULL DEFAULT 0,  -- 由 score_events 計出的總分（快取）
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);

CREATE TABLE IF NOT EXISTS behavior_tags (
  id          INTEGER PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  points      INTEGER NOT NULL,
  icon        TEXT NOT NULL DEFAULT '⭐',
  sort        INTEGER NOT NULL DEFAULT 0
);

-- 一次操作（可包含多名學生），用於「最近操作」及撤銷；client_batch_id 防止重複提交
CREATE TABLE IF NOT EXISTS score_batches (
  id              INTEGER PRIMARY KEY,
  teacher_id      INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class_id        INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  client_batch_id TEXT NOT NULL,
  label           TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  undone_at       TEXT,
  UNIQUE (teacher_id, client_batch_id)
);

CREATE TABLE IF NOT EXISTS score_events (
  id          INTEGER PRIMARY KEY,         -- 單調遞增，用於判斷是否在派蛋之後
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  batch_id    INTEGER REFERENCES score_batches(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('point','import')),
  delta       INTEGER NOT NULL,
  tag_id      INTEGER REFERENCES behavior_tags(id) ON DELETE SET NULL,
  reason      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  undone_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_student ON score_events(student_id, id);
CREATE INDEX IF NOT EXISTS idx_events_class ON score_events(class_id, id);

-- StudentPet：學生寵物唯一資料來源（每名學生最多一隻）
CREATE TABLE IF NOT EXISTS student_pets (
  id                INTEGER PRIMARY KEY,
  teacher_id        INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  student_record_id INTEGER NOT NULL UNIQUE REFERENCES students(id) ON DELETE CASCADE,
  species_key       TEXT NOT NULL CHECK (species_key IN
                      ('fire_fox','metal_cat','wood_deer','water_otter','earth_bear','metal_bird','wood_rabbit','water_koi')),
  stage             TEXT NOT NULL DEFAULT 'egg' CHECK (stage IN ('egg','baby','junior','adult','evolved')),
  xp                INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
  baseline_event_id INTEGER NOT NULL DEFAULT 0,  -- 派蛋時最大的 score_events.id；只計之後的加分
  nickname          TEXT,                         -- 預留：改名
  accessories       TEXT NOT NULL DEFAULT '[]',   -- 預留：飾物 JSON
  assigned_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  hatched_at        TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 寵物 XP 入帳紀錄：score_event_id 為主鍵，同一筆加分永遠只能入帳一次
CREATE TABLE IF NOT EXISTS pet_xp_ledger (
  score_event_id INTEGER PRIMARY KEY REFERENCES score_events(id) ON DELETE CASCADE,
  pet_id         INTEGER NOT NULL REFERENCES student_pets(id) ON DELETE CASCADE,
  xp             INTEGER NOT NULL CHECK (xp > 0),
  stage_before   TEXT NOT NULL,
  stage_after    TEXT NOT NULL,
  reversed_at    TEXT
);

CREATE TABLE IF NOT EXISTS homework (
  id          INTEGER PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  due_date    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS homework_submissions (
  homework_id INTEGER NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('submitted','late','missing','excused')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (homework_id, student_id)
);

CREATE TABLE IF NOT EXISTS exams (
  id          INTEGER PRIMARY KEY,
  teacher_id  INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  class_id    INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  full_mark   REAL NOT NULL DEFAULT 100,
  exam_date   TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS exam_scores (
  exam_id     INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  score       REAL,
  PRIMARY KEY (exam_id, student_id)
);
