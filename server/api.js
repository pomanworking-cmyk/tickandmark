// Tick and Mark API（業務邏輯）。所有查詢都限制在登入老師的 teacher_id 內。
import {
  SPECIES_KEYS, STAGES, DEFAULT_THRESHOLDS, normalizeThresholds, nextStage, stageForXp,
  stageIndex, isXpEligible, balancedSpecies,
} from '../public/shared/pet-logic.js';

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const notFound = () => new HttpError(404, '找不到資料，或你沒有權限查看');

const DEFAULT_TAGS = [
  ['專心上課', 1, '👂'], ['積極舉手', 1, '✋'], ['幫助同學', 2, '🤝'], ['功課認真', 2, '📘'],
  ['收拾整齊', 1, '🧹'], ['欠交功課', -1, '📕'], ['不守秩序', -1, '🔇'],
];

const DEFAULT_REWARDS = [['貼紙一張', 5, '⭐'], ['做小老師', 10, '🧑‍🏫'], ['自己揀位一日', 15, '🪑'], ['免抄一次', 20, '📝']];
const DEFAULT_HW_TEMPLATES = [['中文作文', '中文'], ['英文默書', '英文'], ['數學工作紙', '數學'], ['常識工作紙', '常識']];

const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const int = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const now = () => new Date().toISOString();

export async function seedTeacher(db, teacherId) {
  (await db.run('INSERT OR IGNORE INTO settings (teacher_id, thresholds) VALUES (?, ?)', teacherId, JSON.stringify(DEFAULT_THRESHOLDS)));
  await db.batch([
    ...DEFAULT_TAGS.map(([l, p, i], n) => ['INSERT INTO behavior_tags (teacher_id, label, points, icon, sort) VALUES (?,?,?,?,?)', teacherId, l, p, i, n]),
    ...DEFAULT_HW_TEMPLATES.map(([t, sj]) => ['INSERT OR IGNORE INTO homework_templates (teacher_id, title, subject) VALUES (?,?,?)', teacherId, t, sj]),
    ...DEFAULT_REWARDS.map(([t, c, i], n) => ['INSERT INTO rewards (teacher_id, title, cost, icon, sort) VALUES (?,?,?,?,?)', teacherId, t, c, i, n])]);
}
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

const CLASSES_SQL = `SELECT c.*,
    (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count,
    (SELECT COALESCE(SUM(score),0) FROM students s WHERE s.class_id = c.id) AS total_score,
    (SELECT COUNT(*) FROM student_pets p JOIN students s ON s.id = p.student_record_id WHERE s.class_id = c.id) AS pet_count
  FROM classes c WHERE c.teacher_id = ? ORDER BY c.name`;
const TEMPLATES_SQL = 'SELECT id, title, subject FROM homework_templates WHERE teacher_id = ? ORDER BY subject, title, id';
const REWARDS_SQL = 'SELECT id, title, cost, icon, sort FROM rewards WHERE teacher_id = ? ORDER BY sort, id';

export function createApi(db) {
  const routes = [];
  const on = (method, pattern, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
    routes.push({ method, re, keys, fn });
  };

  // ---------- 共用查詢 ----------
  const own = async (table, id, tid) => {
    const row = (await db.get(`SELECT * FROM ${table} WHERE id = ? AND teacher_id = ?`, id, tid));
    if (!row) throw notFound();
    return row;
  };
  const thresholdsOf = async (tid) => {
    const row = (await db.get('SELECT thresholds FROM settings WHERE teacher_id = ?', tid));
    return row ? normalizeThresholds(JSON.parse(row.thresholds)) : { ...DEFAULT_THRESHOLDS };
  };
  const petRow = (p) => p && ({
    id: p.id, student_record_id: p.student_record_id, species_key: p.species_key, stage: p.stage,
    xp: p.xp, baseline_event_id: p.baseline_event_id, nickname: p.nickname,
    accessories: JSON.parse(p.accessories || '[]'), assigned_at: p.assigned_at, hatched_at: p.hatched_at, last_fed_at: p.last_fed_at ?? null,
  });
  const PET_SELECT = `SELECT p.*, (SELECT MAX(e.created_at) FROM pet_xp_ledger l JOIN score_events e ON e.id = l.score_event_id
      WHERE l.pet_id = p.id AND l.reversed_at IS NULL) AS last_fed_at FROM student_pets p`;
  const petOf = async (studentId) => petRow((await db.get(`${PET_SELECT} WHERE p.student_record_id = ?`, studentId)));
  const studentsOf = async (classId) => {
    const rows = (await db.all(`SELECT s.*, (SELECT COALESCE(SUM(cost),0) FROM redemptions r WHERE r.student_id = s.id AND r.undone_at IS NULL) AS spent
      FROM students s WHERE s.class_id = ? ORDER BY s.number IS NULL, s.number, s.id`, classId));
    const pets = (await db.all(`${PET_SELECT} JOIN students s ON s.id = p.student_record_id WHERE s.class_id = ?`, classId));
    const byStudent = new Map(pets.map(p => [p.student_record_id, petRow(p)]));
    return rows.map(s => ({ ...s, pet: byStudent.get(s.id) || null }));
  };
  const inList = (ids) => ids.map(() => '?').join(',') || 'NULL';
  const STUDENT_SELECT = `SELECT s.*, (SELECT COALESCE(SUM(cost),0) FROM redemptions r WHERE r.student_id = s.id AND r.undone_at IS NULL) AS spent FROM students s`;
  // 一次過讀取多位學生及其寵物（減少雲端資料庫來回次數）
  const studentsByIds = async (ids) => {
    if (!ids.length) return new Map();
    const rows = await db.all(`${STUDENT_SELECT} WHERE s.id IN (${inList(ids)})`, ...ids);
    const pets = await db.all(`${PET_SELECT} WHERE p.student_record_id IN (${inList(ids)})`, ...ids);
    const pm = new Map(pets.map(p => [p.student_record_id, petRow(p)]));
    return new Map(rows.map(r => [r.id, { ...r, pet: pm.get(r.id) || null }]));
  };
  // 一次查詢核對多位學生屬於此老師（及此班）；任何一位不符即報錯
  const ownStudents = async (ids, tid, classId = null) => {
    if (!ids.length) return new Map();
    const rows = await db.all(`SELECT * FROM students WHERE teacher_id = ? AND id IN (${inList(ids)})`, tid, ...ids);
    const m = new Map(rows.map(r => [r.id, r]));
    for (const id of ids) { const s = m.get(id); if (!s) throw notFound(); if (classId != null && s.class_id !== classId) throw bad('學生不屬於此班'); }
    return m;
  };
  const studentFull = async (id) => {
    const s = (await db.get(`SELECT s.*, (SELECT COALESCE(SUM(cost),0) FROM redemptions r WHERE r.student_id = s.id AND r.undone_at IS NULL) AS spent
      FROM students s WHERE s.id = ?`, id));
    return { ...s, pet: await petOf(id) };
  };

  // ---------- 啟動資料 ----------
  // 一次 HTTP 請求讀取全部啟動資料（雲端資料庫每次來回都需要時間）
  on('GET', '/bootstrap', async ({ tid }) => {
    const [st, tags, classes, tpls, rewards] = await db.batch([
      ['SELECT thresholds, hunger_days, timer_presets FROM settings WHERE teacher_id = ?', tid],
      ['SELECT * FROM behavior_tags WHERE teacher_id = ? ORDER BY sort, id', tid],
      [CLASSES_SQL, tid], [TEMPLATES_SQL, tid], [REWARDS_SQL, tid]]);
    const row = st.rows[0];
    return {
      thresholds: row ? normalizeThresholds(JSON.parse(row.thresholds)) : { ...DEFAULT_THRESHOLDS },
      hunger_days: row?.hunger_days ?? 3,
      timer_presets: JSON.parse(row?.timer_presets || '[60,180,300,600]'),
      tags: tags.rows, classes: classes.rows, homework_templates: tpls.rows, rewards: rewards.rows,
    };
  });
  const listTemplates = async (tid) => (await db.all(TEMPLATES_SQL, tid));

  // ---------- 常用功課範本 ----------
  on('GET', '/homework-templates', async ({ tid }) => await listTemplates(tid));
  on('POST', '/homework-templates', async ({ tid, body }) => {
    const title = str(body.title, 60); if (!title) throw bad('請輸入功課名稱');
    (await db.run('INSERT OR IGNORE INTO homework_templates (teacher_id, title, subject) VALUES (?,?,?)', tid, title, str(body.subject, 20)));
    return await listTemplates(tid);
  });
  on('DELETE', '/homework-templates/:id', async ({ tid, p }) => {
    await own('homework_templates', p.id, tid); (await db.run('DELETE FROM homework_templates WHERE id = ?', p.id)); return await listTemplates(tid);
  });

  async function listClasses(tid) { return (await db.all(CLASSES_SQL, tid)); }

  // ---------- 班別 ----------
  on('GET', '/classes', async ({ tid }) => await listClasses(tid));
  on('POST', '/classes', async ({ tid, body }) => {
    const name = str(body.name, 30); if (!name) throw bad('請輸入班別名稱');
    const r = (await db.run('INSERT INTO classes (teacher_id, name, school_year) VALUES (?,?,?)', tid, name, str(body.school_year, 20)));
    return await own('classes', Number(r.lastInsertRowid), tid);
  });
  on('PATCH', '/classes/:id', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid);
    (await db.run('UPDATE classes SET name = ?, school_year = ? WHERE id = ?', str(body.name ?? c.name, 30) || c.name, str(body.school_year ?? c.school_year, 20), c.id));
    return await own('classes', c.id, tid);
  });
  on('DELETE', '/classes/:id', async ({ tid, p }) => {
    await own('classes', p.id, tid); (await db.run('DELETE FROM classes WHERE id = ?', p.id)); return { ok: true };
  });
  on('GET', '/classes/:id/full', async ({ tid, p }) => {
    const [cr, rows, pets, groups] = await db.batch([
      ['SELECT * FROM classes WHERE id = ? AND teacher_id = ?', p.id, tid],
      [`${STUDENT_SELECT} WHERE s.class_id = ? AND s.teacher_id = ? ORDER BY s.number IS NULL, s.number, s.id`, p.id, tid],
      [`${PET_SELECT} JOIN students s ON s.id = p.student_record_id WHERE s.class_id = ? AND s.teacher_id = ?`, p.id, tid],
      ['SELECT * FROM groups WHERE class_id = ? AND teacher_id = ? ORDER BY id', p.id, tid]]);
    const c = cr.rows[0]; if (!c) throw notFound();
    const byStudent = new Map(pets.rows.map(x => [x.student_record_id, petRow(x)]));
    return { class: c, students: rows.rows.map(s => ({ ...s, pet: byStudent.get(s.id) || null })), groups: groups.rows };
  });

  // ---------- 點名 ----------
  on('GET', '/classes/:id/attendance', async ({ tid, p, q }) => {
    const c = await own('classes', p.id, tid); if (!isDate(q.date)) throw bad('日期格式不正確');
    return { date: q.date, absent: (await db.all('SELECT student_id FROM attendance WHERE class_id = ? AND date = ? ORDER BY student_id', c.id, q.date)).map(r => r.student_id) };
  });
  on('PUT', '/classes/:id/attendance', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid); if (!isDate(body.date)) throw bad('日期格式不正確');
    const ids = [...new Set((body.absent || []).map(int))];
    await ownStudents(ids, tid, c.id);
    await db.tx(async () => {
      await db.batch([['DELETE FROM attendance WHERE class_id = ? AND date = ?', c.id, body.date],
        ...ids.map(id => ["INSERT INTO attendance (teacher_id, class_id, student_id, date, status) VALUES (?,?,?,?, 'absent')", tid, c.id, id, body.date])]);
    });
    return { date: body.date, absent: ids.sort((a, b) => a - b) };
  });

  // ---------- 全班合作目標 ----------
  const goalOf = async (cid) => {
    const g = (await db.get('SELECT * FROM class_goals WHERE class_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', cid));
    if (!g) return { goal: null, progress: 0 };
    const progress = (await db.get("SELECT COALESCE(SUM(delta),0) n FROM score_events WHERE class_id = ? AND kind = 'point' AND delta > 0 AND undone_at IS NULL AND id > ?", cid, g.baseline_event_id)).n;
    return { goal: { id: g.id, title: g.title, target: g.target, created_at: g.created_at }, progress };
  };
  on('GET', '/classes/:id/goal', async ({ tid, p }) => await goalOf((await own('classes', p.id, tid)).id));
  on('POST', '/classes/:id/goal', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid); const title = str(body.title, 40); const target = int(body.target);
    if (!title) throw bad('請輸入目標獎勵，例如「全班看電影」');
    if (!(target >= 1 && target <= 100000)) throw bad('目標分數須為 1 至 100000');
    await db.tx(async () => {
      (await db.run('UPDATE class_goals SET ended_at = ? WHERE class_id = ? AND ended_at IS NULL', now(), c.id));
      const base = (await db.get('SELECT COALESCE(MAX(id),0) m FROM score_events')).m;
      (await db.run('INSERT INTO class_goals (teacher_id, class_id, title, target, baseline_event_id) VALUES (?,?,?,?,?)', tid, c.id, title, target, base));
    });
    return await goalOf(c.id);
  });
  on('DELETE', '/classes/:id/goal', async ({ tid, p }) => {
    const c = await own('classes', p.id, tid);
    (await db.run('UPDATE class_goals SET ended_at = ? WHERE class_id = ? AND ended_at IS NULL', now(), c.id));
    return await goalOf(c.id);
  });

  // ---------- 獎勵兌換 ----------
  const listRewards = async (tid) => (await db.all(REWARDS_SQL, tid));
  on('GET', '/rewards', async ({ tid }) => await listRewards(tid));
  on('POST', '/rewards', async ({ tid, body }) => {
    const title = str(body.title, 20); const cost = int(body.cost);
    if (!title || !(cost >= 1 && cost <= 1000)) throw bad('請輸入獎勵名稱，所需分數為 1 至 1000');
    const sort = ((await db.get('SELECT MAX(sort) m FROM rewards WHERE teacher_id = ?', tid)).m ?? 0) + 1;
    (await db.run('INSERT INTO rewards (teacher_id, title, cost, icon, sort) VALUES (?,?,?,?,?)', tid, title, cost, str(body.icon, 4) || '🎁', sort));
    return await listRewards(tid);
  });
  on('PATCH', '/rewards/:id', async ({ tid, p, body }) => {
    const r = await own('rewards', p.id, tid); const cost = body.cost !== undefined ? int(body.cost) : r.cost;
    if (!(cost >= 1 && cost <= 1000)) throw bad('所需分數為 1 至 1000');
    (await db.run('UPDATE rewards SET title = ?, cost = ?, icon = ? WHERE id = ?', str(body.title ?? r.title, 20) || r.title, cost, str(body.icon ?? r.icon, 4) || r.icon, r.id));
    return await listRewards(tid);
  });
  on('DELETE', '/rewards/:id', async ({ tid, p }) => { await own('rewards', p.id, tid); (await db.run('DELETE FROM rewards WHERE id = ?', p.id)); return await listRewards(tid); });
  on('POST', '/redemptions', async ({ tid, body }) => {
    const s = await own('students', int(body.student_id), tid); const r = await own('rewards', int(body.reward_id), tid);
    return db.tx(async () => {
      const cur = await studentFull(s.id);
      if (cur.score - cur.spent < r.cost) throw bad(`${s.name} 可用分數只有 ${cur.score - cur.spent} 分，不夠兌換「${r.title}」（${r.cost} 分）`);
      const ins = (await db.run('INSERT INTO redemptions (teacher_id, class_id, student_id, reward_id, title, cost) VALUES (?,?,?,?,?,?)', tid, s.class_id, s.id, r.id, r.title, r.cost));
      return { redemption_id: Number(ins.lastInsertRowid), title: r.title, icon: r.icon, cost: r.cost, student: await studentFull(s.id) };
    });
  });
  on('POST', '/redemptions/:id/undo', async ({ tid, p }) => {
    const r = await own('redemptions', p.id, tid); if (r.undone_at) throw bad('此兌換已撤銷');
    (await db.run('UPDATE redemptions SET undone_at = ? WHERE id = ?', now(), r.id));
    return { student: await studentFull(r.student_id) };
  });
  on('GET', '/classes/:id/redemptions', async ({ tid, p }) => {
    const c = await own('classes', p.id, tid);
    return (await db.all(`SELECT r.id, r.student_id, s.name, r.title, r.cost, r.created_at, r.undone_at FROM redemptions r JOIN students s ON s.id = r.student_id
      WHERE r.class_id = ? ORDER BY r.id DESC LIMIT 100`, c.id));
  });

  // ---------- 重新分組（一次過取代全班小組） ----------
  on('PUT', '/classes/:id/regroup', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid); const groups = Array.isArray(body.groups) ? body.groups : [];
    if (!groups.length || groups.length > 20) throw bad('組數須為 1 至 20');
    const seen = new Set(); const members = [];
    for (const g of groups) {
      const name = str(g.name, 20); if (!name) throw bad('小組名稱不可留空');
      const sids = (g.student_ids || []).map(int);
      for (const sid of sids) { if (seen.has(sid)) throw bad('同一位學生不可同時在兩組'); seen.add(sid); }
      members.push({ name, color: str(g.color, 9) || '#8cc4f5', sids });
    }
    await ownStudents([...seen], tid, c.id);
    await db.tx(async () => {
      const res = await db.batch([['UPDATE students SET group_id = NULL WHERE class_id = ?', c.id], ['DELETE FROM groups WHERE class_id = ?', c.id],
        ...members.map(g => ['INSERT INTO groups (teacher_id, class_id, name, color) VALUES (?,?,?,?) RETURNING id', tid, c.id, g.name, g.color])]);
      const gids = res.slice(2).map(r => r.rows[0].id);
      await db.batch(members.flatMap((g, i) => g.sids.map(sid => ['UPDATE students SET group_id = ? WHERE id = ?', gids[i], sid])));
    });
    return { class: await own('classes', c.id, tid), students: await studentsOf(c.id), groups: (await db.all('SELECT * FROM groups WHERE class_id = ? ORDER BY id', c.id)) };
  });

  // ---------- 座位表 ----------
  on('PUT', '/classes/:id/seats', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid);
    const cols = body.cols === undefined ? c.seat_cols : int(body.cols);
    if (!(cols >= 2 && cols <= 12)) throw bad('每行座位數須為 2 至 12');
    const seats = Array.isArray(body.seats) ? body.seats : [];
    const used = new Set();
    for (const st of seats) {
      const r = int(st.row); const col = int(st.col);
      if (!(r >= 0 && r < 30 && col >= 0 && col < cols)) throw bad('座位位置不正確');
      const key = `${r},${col}`; if (used.has(key)) throw bad('同一個座位不可坐兩位學生'); used.add(key);
    }
    await ownStudents(seats.map(st => int(st.student_id)), tid, c.id);
    await db.tx(async () => {
      await db.batch([['UPDATE classes SET seat_cols = ? WHERE id = ?', cols, c.id], ['UPDATE students SET seat_row = NULL, seat_col = NULL WHERE class_id = ?', c.id],
        ...seats.map(st => ['UPDATE students SET seat_row = ?, seat_col = ? WHERE id = ?', int(st.row), int(st.col), int(st.student_id)])]);
    });
    return { class: await own('classes', c.id, tid), students: await studentsOf(c.id), groups: (await db.all('SELECT * FROM groups WHERE class_id = ? ORDER BY id', c.id)) };
  });

  // ---------- 學生 ----------
  on('POST', '/classes/:id/students', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid);
    const list = Array.isArray(body.students) ? body.students : [];
    if (!list.length) throw bad('沒有學生資料');
    if (list.length > 60) throw bad('一次最多匯入 60 名學生');
    const rowsIn = [];
    for (const raw of list) {
      const name = str(raw.name, 40); if (!name) continue;
      const number = raw.number === '' || raw.number == null ? null : int(raw.number);
      const score = raw.score === '' || raw.score == null ? 0 : int(raw.score);
      if (Number.isNaN(number) || Number.isNaN(score)) throw bad(`「${name}」的班號或分數不是整數`);
      rowsIn.push({ name, number, score });
    }
    return db.tx(async () => {
      // 先逐位加入學生（保持次序），再一次過記錄舊分數；全部一次 HTTP 請求完成
      const res = await db.batch(rowsIn.map(r => ['INSERT INTO students (teacher_id, class_id, number, name, score) VALUES (?,?,?,?,?) RETURNING id', tid, c.id, r.number, r.name, r.score]));
      const ids = res.map(r => r.rows[0].id);
      await db.batch(rowsIn.flatMap((r, i) => r.score ? [[`INSERT INTO score_events (teacher_id, class_id, student_id, kind, delta, reason) VALUES (?,?,?,'import',?,?)`, tid, c.id, ids[i], r.score, '保留舊分數（匯入）']] : []));
      const full = await studentsByIds(ids);
      return { created: ids.map(id => full.get(id)) };
    });
  });
  on('GET', '/students/:id', async ({ tid, p }) => {
    const s = await own('students', p.id, tid);
    const events = (await db.all(`SELECT e.*, t.label AS tag_label, t.icon AS tag_icon, b.label AS batch_label,
        l.xp AS xp_gained, l.stage_before, l.stage_after, l.reversed_at AS xp_reversed_at
      FROM score_events e LEFT JOIN behavior_tags t ON t.id = e.tag_id LEFT JOIN score_batches b ON b.id = e.batch_id
      LEFT JOIN pet_xp_ledger l ON l.score_event_id = e.id
      WHERE e.student_id = ? ORDER BY e.id DESC LIMIT 300`, s.id));
    const homework = (await db.all(`SELECT h.id, h.title, h.subject, h.due_date, hs.status
      FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = ?
      WHERE h.class_id = ? ORDER BY h.due_date DESC, h.id DESC`, s.id, s.class_id));
    const exams = (await db.all(`SELECT x.id, x.title, x.subject, x.full_mark, x.exam_date, es.score
      FROM exams x LEFT JOIN exam_scores es ON es.exam_id = x.id AND es.student_id = ?
      WHERE x.class_id = ? ORDER BY x.exam_date DESC, x.id DESC`, s.id, s.class_id));
    return { student: await studentFull(s.id), class: await own('classes', s.class_id, tid), events, homework, exams, thresholds: await thresholdsOf(tid) };
  });
  on('PATCH', '/students/:id', async ({ tid, p, body }) => {
    const s = await own('students', p.id, tid);
    const name = body.name !== undefined ? str(body.name, 40) : s.name;
    if (!name) throw bad('姓名不可留空');
    const number = body.number !== undefined ? (body.number === '' || body.number === null ? null : int(body.number)) : s.number;
    if (Number.isNaN(number)) throw bad('班號必須是整數');
    let group = s.group_id;
    if (body.group_id !== undefined) {
      group = body.group_id ? (await own('groups', int(body.group_id), tid)).id : null;
      if (group && (await db.get('SELECT class_id FROM groups WHERE id = ?', group)).class_id !== s.class_id) throw bad('小組不屬於此班');
    }
    (await db.run('UPDATE students SET name = ?, number = ?, group_id = ? WHERE id = ?', name, number, group, s.id));
    return await studentFull(s.id);
  });
  // 刪除學生及其所有紀錄。逐個表明確刪除，即使資料庫未開啟外鍵連鎖刪除亦不會留下孤兒紀錄
  const deleteStudents = (ids) => {
    const L = inList(ids);
    return db.tx(() => db.batch([
      [`DELETE FROM pet_xp_ledger WHERE pet_id IN (SELECT id FROM student_pets WHERE student_record_id IN (${L}))`, ...ids],
      [`DELETE FROM pet_xp_ledger WHERE score_event_id IN (SELECT id FROM score_events WHERE student_id IN (${L}))`, ...ids],
      ...['student_pets:student_record_id', 'score_events:student_id', 'homework_submissions:student_id', 'exam_scores:student_id', 'attendance:student_id', 'redemptions:student_id', 'students:id']
        .map(x => { const [t, c] = x.split(':'); return [`DELETE FROM ${t} WHERE ${c} IN (${L})`, ...ids]; })]));
  };
  on('DELETE', '/students/:id', async ({ tid, p }) => {
    await own('students', p.id, tid); await deleteStudents([p.id]); return { ok: true };
  });
  // 批量刪除學生（分數紀錄、功課、成績、寵物一併刪除）
  on('POST', '/classes/:id/students/delete', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid);
    const ids = [...new Set((body.student_ids || []).map(int))];
    if (!ids.length) throw bad('請選擇學生');
    await ownStudents(ids, tid, c.id);
    await deleteStudents(ids);
    return { deleted: ids.length };
  });

  // ---------- 小組 ----------
  on('POST', '/classes/:id/groups', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid);
    const name = str(body.name, 20); if (!name) throw bad('請輸入小組名稱');
    const r = (await db.run('INSERT INTO groups (teacher_id, class_id, name, color) VALUES (?,?,?,?)', tid, c.id, name, str(body.color, 9) || '#8cc4f5'));
    return await own('groups', Number(r.lastInsertRowid), tid);
  });
  on('PATCH', '/groups/:id', async ({ tid, p, body }) => {
    const g = await own('groups', p.id, tid);
    (await db.run('UPDATE groups SET name = ?, color = ? WHERE id = ?', str(body.name ?? g.name, 20) || g.name, str(body.color ?? g.color, 9), g.id));
    return await own('groups', g.id, tid);
  });
  on('DELETE', '/groups/:id', async ({ tid, p }) => { await own('groups', p.id, tid); (await db.run('DELETE FROM groups WHERE id = ?', p.id)); return { ok: true }; });
  on('PUT', '/groups/:id/members', async ({ tid, p, body }) => {
    const g = await own('groups', p.id, tid);
    const ids = (body.student_ids || []).map(int);
    await ownStudents(ids, tid, g.class_id);
    await db.tx(async () => {
      await db.batch([['UPDATE students SET group_id = NULL WHERE group_id = ?', g.id], ...ids.map(id => ['UPDATE students SET group_id = ? WHERE id = ?', g.id, id])]);
    });
    return { ok: true };
  });

  // ---------- 行為標籤 ----------
  on('POST', '/tags', async ({ tid, body }) => {
    const label = str(body.label, 16); const points = int(body.points);
    if (!label || !points || Math.abs(points) > 20) throw bad('請輸入標籤名稱，分數為 -20 至 20（不可為 0）');
    const sort = ((await db.get('SELECT MAX(sort) m FROM behavior_tags WHERE teacher_id = ?', tid)).m ?? 0) + 1;
    const r = (await db.run('INSERT INTO behavior_tags (teacher_id, label, points, icon, sort) VALUES (?,?,?,?,?)', tid, label, points, str(body.icon, 4) || '⭐', sort));
    return await own('behavior_tags', Number(r.lastInsertRowid), tid);
  });
  on('PATCH', '/tags/:id', async ({ tid, p, body }) => {
    const t = await own('behavior_tags', p.id, tid);
    const points = body.points !== undefined ? int(body.points) : t.points;
    if (!points || Math.abs(points) > 20) throw bad('分數為 -20 至 20（不可為 0）');
    (await db.run('UPDATE behavior_tags SET label = ?, points = ?, icon = ? WHERE id = ?', str(body.label ?? t.label, 16) || t.label, points, str(body.icon ?? t.icon, 4) || t.icon, t.id));
    return await own('behavior_tags', t.id, tid);
  });
  on('DELETE', '/tags/:id', async ({ tid, p }) => { await own('behavior_tags', p.id, tid); (await db.run('DELETE FROM behavior_tags WHERE id = ?', p.id)); return { ok: true }; });

  // ---------- 加減分（核心） ----------
  async function batchResult(batchId) {
    const IN_BATCH = '(SELECT student_id FROM score_events WHERE batch_id = ?)';
    const [br, er, sr, pr] = await db.batch([
      ['SELECT * FROM score_batches WHERE id = ?', batchId],
      [`SELECT e.*, l.xp AS xp_gained, l.stage_before, l.stage_after FROM score_events e
      LEFT JOIN pet_xp_ledger l ON l.score_event_id = e.id WHERE e.batch_id = ? ORDER BY e.id`, batchId],
      [`${STUDENT_SELECT} WHERE s.id IN ${IN_BATCH}`, batchId],
      [`${PET_SELECT} WHERE p.student_record_id IN ${IN_BATCH}`, batchId]]);
    const b = br.rows[0]; const evs = er.rows;
    const pm = new Map(pr.rows.map(x => [x.student_record_id, petRow(x)]));
    const studs = new Map(sr.rows.map(r => [r.id, { ...r, pet: pm.get(r.id) || null }]));
    return {
      batch_id: b.id, label: b.label, undone: !!b.undone_at,
      results: evs.map((e, _i, _a, s = studs.get(e.student_id)) => {
        return {
          event_id: e.id, student_id: s.id, name: s.name, number: s.number, delta: e.delta, score: s.score,
          xp_gained: e.xp_gained || 0, stage_before: e.stage_before || s.pet?.stage || null,
          stage_after: e.stage_after || s.pet?.stage || null,
          leveled_up: !!(e.stage_before && e.stage_after && e.stage_before !== e.stage_after),
          pet: s.pet,
        };
      }),
    };
  }

  on('POST', '/points', async ({ tid, body }) => {
    const clientBatch = str(body.client_batch_id, 64);
    // 一次讀取：班別、是否重複提交、標籤、升級門檻
    const [cr, ex, tg, thr] = await db.batch([
      ['SELECT * FROM classes WHERE id = ? AND teacher_id = ?', int(body.class_id), tid],
      ['SELECT id FROM score_batches WHERE teacher_id = ? AND client_batch_id = ?', tid, clientBatch],
      ['SELECT * FROM behavior_tags WHERE id = ? AND teacher_id = ?', body.tag_id ? int(body.tag_id) : -1, tid],
      ['SELECT thresholds FROM settings WHERE teacher_id = ?', tid]]);
    const c = cr.rows[0]; if (!c) throw notFound();
    if (!clientBatch) throw bad('缺少操作編號');
    const existing = ex.rows[0];
    if (existing) return { ...(await batchResult(existing.id)), replayed: true }; // 重複提交：不會再加一次

    let delta = int(body.delta); let tag = null;
    if (body.tag_id) { tag = tg.rows[0]; if (!tag) throw notFound(); delta = tag.points; }
    if (!delta || Math.abs(delta) > 100) throw bad('分數必須是 -100 至 100 的整數（不可為 0）');
    const ids = [...new Set((body.student_ids || []).map(int))];
    if (!ids.length) throw bad('請選擇學生');
    const th = thr.rows[0] ? normalizeThresholds(JSON.parse(thr.rows[0].thresholds)) : { ...DEFAULT_THRESHOLDS };
    const reason = str(body.reason, 60);
    const label = tag ? `${tag.icon} ${tag.label}` : (reason || (delta > 0 ? `加 ${delta} 分` : `扣 ${-delta} 分`));

    let batchId;
    try { batchId = await db.tx(async () => {
      const [b, sr, pr] = await db.batch([
        ['INSERT INTO score_batches (teacher_id, class_id, client_batch_id, label) VALUES (?,?,?,?) RETURNING id', tid, c.id, clientBatch, label],
        [`SELECT id, class_id FROM students WHERE teacher_id = ? AND id IN (${inList(ids)})`, tid, ...ids],
        [`SELECT * FROM student_pets WHERE student_record_id IN (${inList(ids)})`, ...ids]]);
      const bid = b.rows[0].id;
      const owned = new Map(sr.rows.map(r => [r.id, r]));
      const pets = new Map(pr.rows.map(p => [p.student_record_id, p]));
      for (const sid of ids) { const s = owned.get(sid); if (!s) throw notFound(); if (s.class_id !== c.id) throw bad('學生不屬於此班'); }
      // 一次 HTTP 請求寫入全部分數紀錄及總分；再一次寫入寵物 XP（交易內，資料不會被其他請求改動）
      const res = await db.batch(ids.flatMap(sid => [
        [`INSERT INTO score_events (teacher_id, class_id, student_id, batch_id, kind, delta, tag_id, reason) VALUES (?,?,?,?, 'point', ?,?,?) RETURNING *`, tid, c.id, sid, bid, delta, tag?.id ?? null, reason],
        ['UPDATE students SET score = score + ? WHERE id = ?', delta, sid]]));
      const xpStmts = [];
      ids.forEach((sid, i) => {
        const event = res[i * 2].rows[0]; const pet = pets.get(sid);
        if (!isXpEligible(event, pet)) return;
        const xp = pet.xp + delta; const stage = nextStage(pet.stage, xp, th);
        // score_event_id 是主鍵：同一筆加分在資料庫層面只可入帳一次
        xpStmts.push(['INSERT INTO pet_xp_ledger (score_event_id, pet_id, xp, stage_before, stage_after) VALUES (?,?,?,?,?)', event.id, pet.id, delta, pet.stage, stage]);
        xpStmts.push([`UPDATE student_pets SET xp = ?, stage = ?, updated_at = ?,
                hatched_at = CASE WHEN hatched_at IS NULL AND ? <> 'egg' THEN ? ELSE hatched_at END WHERE id = ?`, xp, stage, now(), stage, now(), pet.id]);
      });
      await db.batch(xpStmts);
      return bid;
    }); } catch (e) {
      // 同一操作差不多同時送了兩次（例如網絡慢時重送）：第二次當作重複提交
      if (!/UNIQUE/i.test(e.message) || !/client_batch_id/.test(e.message)) throw e;
      const again = await db.get('SELECT id FROM score_batches WHERE teacher_id = ? AND client_batch_id = ?', tid, clientBatch);
      if (!again) throw e;
      return { ...(await batchResult(again.id)), replayed: true };
    }
    return await batchResult(batchId);
  });

  on('POST', '/batches/:id/undo', async ({ tid, p }) => {
    const b = await own('score_batches', p.id, tid);
    if (b.undone_at) throw bad('此操作已撤銷');
    await db.tx(async () => {
      const t = now();
      const [evs, ls] = await db.batch([['SELECT * FROM score_events WHERE batch_id = ? AND undone_at IS NULL', b.id],
        ['SELECT l.* FROM pet_xp_ledger l JOIN score_events e ON e.id = l.score_event_id WHERE e.batch_id = ? AND e.undone_at IS NULL AND l.reversed_at IS NULL', b.id]]);
      const ledger = new Map(ls.rows.map(l => [l.score_event_id, l]));
      const stmts = [];
      for (const e of evs.rows) {
        stmts.push(['UPDATE score_events SET undone_at = ? WHERE id = ?', t, e.id], ['UPDATE students SET score = score - ? WHERE id = ?', e.delta, e.student_id]);
        const l = ledger.get(e.id);
        // XP 扣回，但階段不倒退
        if (l) stmts.push(['UPDATE pet_xp_ledger SET reversed_at = ? WHERE score_event_id = ?', t, e.id], ['UPDATE student_pets SET xp = MAX(0, xp - ?), updated_at = ? WHERE id = ?', l.xp, t, l.pet_id]);
      }
      stmts.push(['UPDATE score_batches SET undone_at = ? WHERE id = ?', t, b.id]);
      await db.batch(stmts);
    });
    return await batchResult(b.id);
  });

  on('GET', '/classes/:id/batches', async ({ tid, p, q }) => {
    const c = await own('classes', p.id, tid);
    const limit = Math.min(200, int(q.limit) || 20);
    const rows = (await db.all(`SELECT b.*, COUNT(e.id) AS n, MIN(e.delta) AS delta,
        GROUP_CONCAT(s.name, '、') AS names
      FROM score_batches b JOIN score_events e ON e.batch_id = b.id JOIN students s ON s.id = e.student_id
      WHERE b.class_id = ? GROUP BY b.id ORDER BY b.id DESC LIMIT ?`, c.id, limit));
    return rows;
  });

  on('GET', '/classes/:id/events', async ({ tid, p, q }) => {
    const c = await own('classes', p.id, tid);
    const since = str(q.since, 30);
    return (await db.all(`SELECT e.id, e.student_id, e.kind, e.delta, e.reason, e.created_at, e.undone_at, e.batch_id,
        s.name, s.number, t.label AS tag_label, t.icon AS tag_icon, l.xp AS xp_gained
      FROM score_events e JOIN students s ON s.id = e.student_id LEFT JOIN behavior_tags t ON t.id = e.tag_id
      LEFT JOIN pet_xp_ledger l ON l.score_event_id = e.id
      WHERE e.class_id = ? AND (? = '' OR e.created_at >= ?) ORDER BY e.id DESC LIMIT 1000`, c.id, since, since));
  });

  // 海報：某日期之後的課堂得分（不含已撤銷及匯入）
  on('GET', '/classes/:id/leaderboard', async ({ tid, p, q }) => {
    const c = await own('classes', p.id, tid);
    const since = str(q.since, 30);
    const sums = (await db.all(`SELECT student_id, SUM(delta) AS gained FROM score_events
      WHERE class_id = ? AND kind = 'point' AND undone_at IS NULL AND (? = '' OR created_at >= ?) GROUP BY student_id`, c.id, since, since));
    const m = new Map(sums.map(r => [r.student_id, r.gained]));
    return { class: c, students: (await studentsOf(c.id)).map(s => ({ ...s, gained: m.get(s.id) || 0 })) };
  });

  // ---------- 寵物 ----------
  on('POST', '/pets/assign', async ({ tid, body }) => {
    const ids = [...new Set((body.student_ids || []).map(int))];
    if (!ids.length) throw bad('請選擇學生');
    const mode = str(body.species_key, 20);
    if (mode !== 'balanced' && !SPECIES_KEYS.includes(mode)) throw bad('請選擇寵物品種');
    return db.tx(async () => {
      const owned = await ownStudents(ids, tid);
      const has = new Set((await db.all(`SELECT student_record_id FROM student_pets WHERE student_record_id IN (${inList(ids)})`, ...ids)).map(r => r.student_record_id));
      const students = ids.map(id => owned.get(id)).filter(s => !has.has(s.id));
      let picks;
      if (mode === 'balanced') {
        const classIds = [...new Set(students.map(s => s.class_id))];
        const counts = {};
        for (const cid of classIds) for (const r of (await db.all(`SELECT p.species_key k, COUNT(*) n FROM student_pets p JOIN students s ON s.id = p.student_record_id WHERE s.class_id = ? GROUP BY k`, cid))) counts[r.k] = (counts[r.k] || 0) + r.n;
        picks = balancedSpecies(students.length, counts);
      } else picks = students.map(() => mode);
      const baseline = (await db.get('SELECT COALESCE(MAX(id), 0) m FROM score_events')).m;
      await db.batch(students.map((s, i) => ['INSERT INTO student_pets (teacher_id, student_record_id, species_key, baseline_event_id) VALUES (?,?,?,?)', tid, s.id, picks[i], baseline]));
      const full = await studentsByIds(students.map(s => s.id));
      return { created: students.map(s => full.get(s.id)), skipped: ids.length - students.length };
    });
  });

  on('PATCH', '/pets/:id', async ({ tid, p, body }) => {
    const pet = await own('student_pets', p.id, tid);
    if (body.species_key !== undefined && body.species_key !== pet.species_key) {
      if (pet.stage !== 'egg') throw bad('寵物已孵化，不可更換品種');
      if (!SPECIES_KEYS.includes(body.species_key)) throw bad('未知品種');
      (await db.run('UPDATE student_pets SET species_key = ?, updated_at = ? WHERE id = ?', body.species_key, now(), pet.id));
    }
    if (body.nickname !== undefined) (await db.run('UPDATE student_pets SET nickname = ?, updated_at = ? WHERE id = ?', str(body.nickname, 12) || null, now(), pet.id));
    if (body.accessories !== undefined) {
      if (!Array.isArray(body.accessories)) throw bad('飾物格式錯誤');
      (await db.run('UPDATE student_pets SET accessories = ?, updated_at = ? WHERE id = ?', JSON.stringify(body.accessories.slice(0, 10).map(x => str(x, 30))), now(), pet.id));
    }
    return await studentFull(pet.student_record_id);
  });

  on('DELETE', '/pets/:id', async ({ tid, p }) => {
    await own('student_pets', p.id, tid); (await db.run('DELETE FROM student_pets WHERE id = ?', p.id)); return { ok: true };
  });

  on('PUT', '/settings', async ({ tid, body }) => {
    let th;
    try { th = normalizeThresholds(body.thresholds); } catch (e) { throw bad(e.message); }
    let upgraded = 0;
    await db.tx(async () => {
      (await db.run('UPDATE settings SET thresholds = ? WHERE teacher_id = ?', JSON.stringify(th), tid));
      if (body.hunger_days !== undefined) {
        const hd = int(body.hunger_days); if (!(hd >= 0 && hd <= 30)) throw bad('肚餓提示日數須為 0 至 30（0 = 關閉）');
        (await db.run('UPDATE settings SET hunger_days = ? WHERE teacher_id = ?', hd, tid));
      }
      if (Array.isArray(body.timer_presets)) (await db.run('UPDATE settings SET timer_presets = ? WHERE teacher_id = ?', JSON.stringify(body.timer_presets.map(int).filter(n => n > 0 && n <= 7200).slice(0, 8)), tid));
      for (const pet of (await db.all('SELECT * FROM student_pets WHERE teacher_id = ?', tid))) {
        const st = nextStage(pet.stage, pet.xp, th);
        if (st !== pet.stage) {
          upgraded++;
          (await db.run(`UPDATE student_pets SET stage = ?, updated_at = ?, hatched_at = COALESCE(hatched_at, ?) WHERE id = ?`, st, now(), now(), pet.id));
        }
      }
    });
    return { thresholds: th, upgraded, hunger_days: (await db.get('SELECT hunger_days FROM settings WHERE teacher_id = ?', tid)).hunger_days };
  });

  // 資料一致性自我檢查（驗收用）
  on('GET', '/audit', async ({ tid }) => {
    const th = await thresholdsOf(tid); const problems = [];
    const pets = (await db.all('SELECT * FROM student_pets WHERE teacher_id = ?', tid));
    const ledgerSum = new Map((await db.all('SELECT l.pet_id, SUM(l.xp) s FROM pet_xp_ledger l JOIN student_pets p ON p.id = l.pet_id WHERE p.teacher_id = ? AND l.reversed_at IS NULL GROUP BY l.pet_id', tid)).map(r => [r.pet_id, r.s]));
    const badCount = new Map((await db.all(`SELECT l.pet_id, COUNT(*) n FROM pet_xp_ledger l JOIN score_events e ON e.id = l.score_event_id JOIN student_pets p ON p.id = l.pet_id
        WHERE p.teacher_id = ? AND (e.student_id <> p.student_record_id OR e.delta <= 0 OR e.kind <> 'point' OR e.id <= p.baseline_event_id OR l.xp <> e.delta) GROUP BY l.pet_id`, tid)).map(r => [r.pet_id, r.n]));
    for (const p of pets) {
      const sum = ledgerSum.get(p.id) || 0;
      if (sum !== p.xp) problems.push(`寵物 ${p.id}：XP ${p.xp} 與入帳總和 ${sum} 不符`);
      if (!SPECIES_KEYS.includes(p.species_key)) problems.push(`寵物 ${p.id}：未知品種`);
      if (!STAGES.includes(p.stage)) problems.push(`寵物 ${p.id}：未知階段`);
      else if (stageIndex(p.stage) < stageIndex(stageForXp(p.xp, th))) problems.push(`寵物 ${p.id}：XP 已達 ${stageForXp(p.xp, th)} 但階段仍為 ${p.stage}`);
      const badLedger = badCount.get(p.id) || 0;
      if (badLedger) problems.push(`寵物 ${p.id}：有 ${badLedger} 筆不應計入的 XP`);
    }
    const evSum = new Map((await db.all('SELECT student_id, SUM(delta) s FROM score_events WHERE teacher_id = ? AND undone_at IS NULL GROUP BY student_id', tid)).map(r => [r.student_id, r.s]));
    for (const s of (await db.all('SELECT * FROM students WHERE teacher_id = ?', tid))) {
      const sum = evSum.get(s.id) || 0;
      if (sum !== s.score) problems.push(`學生 ${s.id}：總分 ${s.score} 與紀錄總和 ${sum} 不符`);
    }
    return { pets: pets.length, problems };
  });

  // ---------- 功課 ----------
  on('GET', '/classes/:id/homework', async ({ tid, p }) => {
    const c = await own('classes', p.id, tid);
    return (await db.all(`SELECT h.*,
        SUM(CASE WHEN hs.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
        SUM(CASE WHEN hs.status = 'late' THEN 1 ELSE 0 END) AS late,
        SUM(CASE WHEN hs.status = 'missing' THEN 1 ELSE 0 END) AS missing,
        SUM(CASE WHEN hs.status = 'excused' THEN 1 ELSE 0 END) AS excused
      FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id = h.id
      WHERE h.class_id = ? GROUP BY h.id ORDER BY h.due_date DESC, h.id DESC`, c.id));
  });
  // 欠交功課（寵物會提醒主人）
  on('GET', '/classes/:id/missing-homework', async ({ tid, p }) => {
    const c = await own('classes', p.id, tid);
    return (await db.all(`SELECT hs.student_id, h.id AS homework_id, h.title, h.subject, h.due_date FROM homework_submissions hs JOIN homework h ON h.id = hs.homework_id
      WHERE h.class_id = ? AND hs.status = 'missing' ORDER BY h.due_date, h.id, hs.student_id`, c.id));
  });
  on('POST', '/classes/:id/homework', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid); const title = str(body.title, 60);
    if (!title) throw bad('請輸入功課名稱');
    const r = (await db.run('INSERT INTO homework (teacher_id, class_id, title, subject, due_date) VALUES (?,?,?,?,?)', tid, c.id, title, str(body.subject, 20), str(body.due_date, 10)));
    return await own('homework', Number(r.lastInsertRowid), tid);
  });
  on('DELETE', '/homework/:id', async ({ tid, p }) => { await own('homework', p.id, tid); (await db.run('DELETE FROM homework WHERE id = ?', p.id)); return { ok: true }; });
  on('GET', '/homework/:id/submissions', async ({ tid, p }) => {
    const h = await own('homework', p.id, tid);
    return { homework: h, entries: (await db.all('SELECT student_id, status, updated_at FROM homework_submissions WHERE homework_id = ?', h.id)) };
  });
  on('PUT', '/homework/:id/submissions', async ({ tid, p, body }) => {
    const h = await own('homework', p.id, tid);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    await ownStudents(entries.map(e => int(e.student_id)), tid, h.class_id);
    for (const e of entries) if (e.status && !['submitted', 'late', 'missing', 'excused'].includes(e.status)) throw bad('未知提交狀態');
    await db.tx(async () => {
      await db.batch(entries.map(e => (!e.status
        ? ['DELETE FROM homework_submissions WHERE homework_id = ? AND student_id = ?', h.id, int(e.student_id)]
        : [`INSERT INTO homework_submissions (homework_id, student_id, status, updated_at) VALUES (?,?,?,?)
            ON CONFLICT(homework_id, student_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`, h.id, int(e.student_id), e.status, now()])));
    });
    return { ok: true };
  });

  // ---------- 考試 ----------
  on('GET', '/classes/:id/exams', async ({ tid, p }) => {
    const c = await own('classes', p.id, tid);
    return (await db.all(`SELECT x.*, COUNT(es.score) AS n, AVG(es.score) AS avg, MAX(es.score) AS max, MIN(es.score) AS min
      FROM exams x LEFT JOIN exam_scores es ON es.exam_id = x.id WHERE x.class_id = ? GROUP BY x.id ORDER BY x.exam_date DESC, x.id DESC`, c.id));
  });
  on('POST', '/classes/:id/exams', async ({ tid, p, body }) => {
    const c = await own('classes', p.id, tid); const title = str(body.title, 60);
    const full = Number(body.full_mark || 100);
    if (!title) throw bad('請輸入考試名稱');
    if (!(full > 0 && full <= 1000)) throw bad('滿分須為 1 至 1000');
    const r = (await db.run('INSERT INTO exams (teacher_id, class_id, title, subject, full_mark, exam_date) VALUES (?,?,?,?,?,?)', tid, c.id, title, str(body.subject, 20), full, str(body.exam_date, 10)));
    return await own('exams', Number(r.lastInsertRowid), tid);
  });
  on('DELETE', '/exams/:id', async ({ tid, p }) => { await own('exams', p.id, tid); (await db.run('DELETE FROM exams WHERE id = ?', p.id)); return { ok: true }; });
  on('GET', '/exams/:id/scores', async ({ tid, p }) => {
    const x = await own('exams', p.id, tid);
    return { exam: x, scores: (await db.all('SELECT student_id, score FROM exam_scores WHERE exam_id = ?', x.id)) };
  });
  on('PUT', '/exams/:id/scores', async ({ tid, p, body }) => {
    const x = await own('exams', p.id, tid);
    const list = Array.isArray(body.scores) ? body.scores : [];
    const owned = await ownStudents(list.map(e => int(e.student_id)), tid, x.class_id);
    const stmts = list.map((e) => {
      const s = owned.get(int(e.student_id));
      if (e.score === null || e.score === '') return ['DELETE FROM exam_scores WHERE exam_id = ? AND student_id = ?', x.id, s.id];
      const v = Number(e.score);
      if (!(v >= 0 && v <= x.full_mark)) throw bad(`${s.name} 的分數須在 0 至 ${x.full_mark} 之間`);
      return [`INSERT INTO exam_scores (exam_id, student_id, score) VALUES (?,?,?)
          ON CONFLICT(exam_id, student_id) DO UPDATE SET score = excluded.score`, x.id, s.id, v];
    });
    await db.tx(async () => { await db.batch(stmts); });
    return { ok: true };
  });

  // ---------- 分派 ----------
  return async function handle(method, path, { tid, body = {}, query = {} }) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re); if (!m) continue;
      const p = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
      return await r.fn({ tid, p, body: body || {}, q: query });
    }
    throw new HttpError(404, '找不到此功能');
  };
}
