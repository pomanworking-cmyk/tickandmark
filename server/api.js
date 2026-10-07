// Tick and Mark API（業務邏輯）。所有查詢都限制在登入老師的 teacher_id 內。
import {
  SPECIES_KEYS, STAGES, DEFAULT_THRESHOLDS, normalizeThresholds, nextStage, stageForXp,
  stageIndex, isXpEligible, balancedSpecies,
} from '../public/shared/pet-logic.js';
import { tx } from './db.js';

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const notFound = () => new HttpError(404, '找不到資料，或你沒有權限查看');

const DEFAULT_TAGS = [
  ['專心上課', 1, '👂'], ['積極舉手', 1, '✋'], ['幫助同學', 2, '🤝'], ['功課認真', 2, '📘'],
  ['收拾整齊', 1, '🧹'], ['欠交功課', -1, '📕'], ['不守秩序', -1, '🔇'],
];

const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const int = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const now = () => new Date().toISOString();

export function seedTeacher(db, teacherId) {
  db.prepare('INSERT OR IGNORE INTO settings (teacher_id, thresholds) VALUES (?, ?)')
    .run(teacherId, JSON.stringify(DEFAULT_THRESHOLDS));
  const ins = db.prepare('INSERT INTO behavior_tags (teacher_id, label, points, icon, sort) VALUES (?,?,?,?,?)');
  DEFAULT_TAGS.forEach(([l, p, i], n) => ins.run(teacherId, l, p, i, n));
}

export function createApi(db) {
  const routes = [];
  const on = (method, pattern, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
    routes.push({ method, re, keys, fn });
  };

  // ---------- 共用查詢 ----------
  const own = (table, id, tid) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND teacher_id = ?`).get(id, tid);
    if (!row) throw notFound();
    return row;
  };
  const thresholdsOf = (tid) => {
    const row = db.prepare('SELECT thresholds FROM settings WHERE teacher_id = ?').get(tid);
    return row ? normalizeThresholds(JSON.parse(row.thresholds)) : { ...DEFAULT_THRESHOLDS };
  };
  const petRow = (p) => p && ({
    id: p.id, student_record_id: p.student_record_id, species_key: p.species_key, stage: p.stage,
    xp: p.xp, baseline_event_id: p.baseline_event_id, nickname: p.nickname,
    accessories: JSON.parse(p.accessories || '[]'), assigned_at: p.assigned_at, hatched_at: p.hatched_at,
  });
  const petOf = (studentId) => petRow(db.prepare('SELECT * FROM student_pets WHERE student_record_id = ?').get(studentId));
  const studentsOf = (classId) => {
    const rows = db.prepare('SELECT * FROM students WHERE class_id = ? ORDER BY number IS NULL, number, id').all(classId);
    const pets = db.prepare('SELECT p.* FROM student_pets p JOIN students s ON s.id = p.student_record_id WHERE s.class_id = ?').all(classId);
    const byStudent = new Map(pets.map(p => [p.student_record_id, petRow(p)]));
    return rows.map(s => ({ ...s, pet: byStudent.get(s.id) || null }));
  };
  const studentFull = (id) => {
    const s = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
    return { ...s, pet: petOf(id) };
  };

  // ---------- 啟動資料 ----------
  on('GET', '/bootstrap', ({ tid }) => ({
    thresholds: thresholdsOf(tid),
    timer_presets: JSON.parse(db.prepare('SELECT timer_presets FROM settings WHERE teacher_id = ?').get(tid)?.timer_presets || '[60,180,300,600]'),
    tags: db.prepare('SELECT * FROM behavior_tags WHERE teacher_id = ? ORDER BY sort, id').all(tid),
    classes: listClasses(tid),
  }));

  function listClasses(tid) {
    return db.prepare(`SELECT c.*,
        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count,
        (SELECT COALESCE(SUM(score),0) FROM students s WHERE s.class_id = c.id) AS total_score,
        (SELECT COUNT(*) FROM student_pets p JOIN students s ON s.id = p.student_record_id WHERE s.class_id = c.id) AS pet_count
      FROM classes c WHERE c.teacher_id = ? ORDER BY c.name`).all(tid);
  }

  // ---------- 班別 ----------
  on('GET', '/classes', ({ tid }) => listClasses(tid));
  on('POST', '/classes', ({ tid, body }) => {
    const name = str(body.name, 30); if (!name) throw bad('請輸入班別名稱');
    const r = db.prepare('INSERT INTO classes (teacher_id, name, school_year) VALUES (?,?,?)').run(tid, name, str(body.school_year, 20));
    return own('classes', Number(r.lastInsertRowid), tid);
  });
  on('PATCH', '/classes/:id', ({ tid, p, body }) => {
    const c = own('classes', p.id, tid);
    db.prepare('UPDATE classes SET name = ?, school_year = ? WHERE id = ?')
      .run(str(body.name ?? c.name, 30) || c.name, str(body.school_year ?? c.school_year, 20), c.id);
    return own('classes', c.id, tid);
  });
  on('DELETE', '/classes/:id', ({ tid, p }) => {
    own('classes', p.id, tid); db.prepare('DELETE FROM classes WHERE id = ?').run(p.id); return { ok: true };
  });
  on('GET', '/classes/:id/full', ({ tid, p }) => {
    const c = own('classes', p.id, tid);
    return {
      class: c,
      students: studentsOf(c.id),
      groups: db.prepare('SELECT * FROM groups WHERE class_id = ? ORDER BY id').all(c.id),
    };
  });

  // ---------- 學生 ----------
  on('POST', '/classes/:id/students', ({ tid, p, body }) => {
    const c = own('classes', p.id, tid);
    const list = Array.isArray(body.students) ? body.students : [];
    if (!list.length) throw bad('沒有學生資料');
    if (list.length > 60) throw bad('一次最多匯入 60 名學生');
    return tx(db, () => {
      const created = [];
      for (const raw of list) {
        const name = str(raw.name, 40); if (!name) continue;
        const number = raw.number === '' || raw.number == null ? null : int(raw.number);
        const score = raw.score === '' || raw.score == null ? 0 : int(raw.score);
        if (Number.isNaN(number) || Number.isNaN(score)) throw bad(`「${name}」的班號或分數不是整數`);
        const r = db.prepare('INSERT INTO students (teacher_id, class_id, number, name, score) VALUES (?,?,?,?,?)')
          .run(tid, c.id, number, name, score);
        const sid = Number(r.lastInsertRowid);
        if (score) {
          db.prepare(`INSERT INTO score_events (teacher_id, class_id, student_id, kind, delta, reason) VALUES (?,?,?,'import',?,?)`)
            .run(tid, c.id, sid, score, '保留舊分數（匯入）');
        }
        created.push(studentFull(sid));
      }
      return { created };
    });
  });
  on('GET', '/students/:id', ({ tid, p }) => {
    const s = own('students', p.id, tid);
    const events = db.prepare(`SELECT e.*, t.label AS tag_label, t.icon AS tag_icon, b.label AS batch_label,
        l.xp AS xp_gained, l.stage_before, l.stage_after, l.reversed_at AS xp_reversed_at
      FROM score_events e LEFT JOIN behavior_tags t ON t.id = e.tag_id LEFT JOIN score_batches b ON b.id = e.batch_id
      LEFT JOIN pet_xp_ledger l ON l.score_event_id = e.id
      WHERE e.student_id = ? ORDER BY e.id DESC LIMIT 300`).all(s.id);
    const homework = db.prepare(`SELECT h.id, h.title, h.subject, h.due_date, hs.status
      FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = ?
      WHERE h.class_id = ? ORDER BY h.due_date DESC, h.id DESC`).all(s.id, s.class_id);
    const exams = db.prepare(`SELECT x.id, x.title, x.subject, x.full_mark, x.exam_date, es.score
      FROM exams x LEFT JOIN exam_scores es ON es.exam_id = x.id AND es.student_id = ?
      WHERE x.class_id = ? ORDER BY x.exam_date DESC, x.id DESC`).all(s.id, s.class_id);
    return { student: studentFull(s.id), class: own('classes', s.class_id, tid), events, homework, exams, thresholds: thresholdsOf(tid) };
  });
  on('PATCH', '/students/:id', ({ tid, p, body }) => {
    const s = own('students', p.id, tid);
    const name = body.name !== undefined ? str(body.name, 40) : s.name;
    if (!name) throw bad('姓名不可留空');
    const number = body.number !== undefined ? (body.number === '' || body.number === null ? null : int(body.number)) : s.number;
    if (Number.isNaN(number)) throw bad('班號必須是整數');
    let group = s.group_id;
    if (body.group_id !== undefined) {
      group = body.group_id ? own('groups', int(body.group_id), tid).id : null;
      if (group && db.prepare('SELECT class_id FROM groups WHERE id = ?').get(group).class_id !== s.class_id) throw bad('小組不屬於此班');
    }
    db.prepare('UPDATE students SET name = ?, number = ?, group_id = ? WHERE id = ?').run(name, number, group, s.id);
    return studentFull(s.id);
  });
  on('DELETE', '/students/:id', ({ tid, p }) => {
    own('students', p.id, tid); db.prepare('DELETE FROM students WHERE id = ?').run(p.id); return { ok: true };
  });

  // ---------- 小組 ----------
  on('POST', '/classes/:id/groups', ({ tid, p, body }) => {
    const c = own('classes', p.id, tid);
    const name = str(body.name, 20); if (!name) throw bad('請輸入小組名稱');
    const r = db.prepare('INSERT INTO groups (teacher_id, class_id, name, color) VALUES (?,?,?,?)').run(tid, c.id, name, str(body.color, 9) || '#5b8def');
    return own('groups', Number(r.lastInsertRowid), tid);
  });
  on('PATCH', '/groups/:id', ({ tid, p, body }) => {
    const g = own('groups', p.id, tid);
    db.prepare('UPDATE groups SET name = ?, color = ? WHERE id = ?').run(str(body.name ?? g.name, 20) || g.name, str(body.color ?? g.color, 9), g.id);
    return own('groups', g.id, tid);
  });
  on('DELETE', '/groups/:id', ({ tid, p }) => { own('groups', p.id, tid); db.prepare('DELETE FROM groups WHERE id = ?').run(p.id); return { ok: true }; });
  on('PUT', '/groups/:id/members', ({ tid, p, body }) => {
    const g = own('groups', p.id, tid);
    const ids = (body.student_ids || []).map(int);
    tx(db, () => {
      db.prepare('UPDATE students SET group_id = NULL WHERE group_id = ?').run(g.id);
      for (const id of ids) {
        const s = own('students', id, tid);
        if (s.class_id !== g.class_id) throw bad('學生不屬於此班');
        db.prepare('UPDATE students SET group_id = ? WHERE id = ?').run(g.id, id);
      }
    });
    return { ok: true };
  });

  // ---------- 行為標籤 ----------
  on('POST', '/tags', ({ tid, body }) => {
    const label = str(body.label, 16); const points = int(body.points);
    if (!label || !points || Math.abs(points) > 20) throw bad('請輸入標籤名稱，分數為 -20 至 20（不可為 0）');
    const sort = (db.prepare('SELECT MAX(sort) m FROM behavior_tags WHERE teacher_id = ?').get(tid).m ?? 0) + 1;
    const r = db.prepare('INSERT INTO behavior_tags (teacher_id, label, points, icon, sort) VALUES (?,?,?,?,?)').run(tid, label, points, str(body.icon, 4) || '⭐', sort);
    return own('behavior_tags', Number(r.lastInsertRowid), tid);
  });
  on('PATCH', '/tags/:id', ({ tid, p, body }) => {
    const t = own('behavior_tags', p.id, tid);
    const points = body.points !== undefined ? int(body.points) : t.points;
    if (!points || Math.abs(points) > 20) throw bad('分數為 -20 至 20（不可為 0）');
    db.prepare('UPDATE behavior_tags SET label = ?, points = ?, icon = ? WHERE id = ?').run(str(body.label ?? t.label, 16) || t.label, points, str(body.icon ?? t.icon, 4) || t.icon, t.id);
    return own('behavior_tags', t.id, tid);
  });
  on('DELETE', '/tags/:id', ({ tid, p }) => { own('behavior_tags', p.id, tid); db.prepare('DELETE FROM behavior_tags WHERE id = ?').run(p.id); return { ok: true }; });

  // ---------- 加減分（核心） ----------
  function batchResult(batchId) {
    const b = db.prepare('SELECT * FROM score_batches WHERE id = ?').get(batchId);
    const evs = db.prepare(`SELECT e.*, l.xp AS xp_gained, l.stage_before, l.stage_after FROM score_events e
      LEFT JOIN pet_xp_ledger l ON l.score_event_id = e.id WHERE e.batch_id = ? ORDER BY e.id`).all(batchId);
    return {
      batch_id: b.id, label: b.label, undone: !!b.undone_at,
      results: evs.map(e => {
        const s = studentFull(e.student_id);
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

  on('POST', '/points', ({ tid, body }) => {
    const c = own('classes', int(body.class_id), tid);
    const clientBatch = str(body.client_batch_id, 64);
    if (!clientBatch) throw bad('缺少操作編號');
    const existing = db.prepare('SELECT id FROM score_batches WHERE teacher_id = ? AND client_batch_id = ?').get(tid, clientBatch);
    if (existing) return { ...batchResult(existing.id), replayed: true }; // 重複提交：不會再加一次

    let delta = int(body.delta); let tag = null;
    if (body.tag_id) { tag = own('behavior_tags', int(body.tag_id), tid); delta = tag.points; }
    if (!delta || Math.abs(delta) > 100) throw bad('分數必須是 -100 至 100 的整數（不可為 0）');
    const ids = [...new Set((body.student_ids || []).map(int))];
    if (!ids.length) throw bad('請選擇學生');
    const th = thresholdsOf(tid);
    const reason = str(body.reason, 60);
    const label = tag ? `${tag.icon} ${tag.label}` : (reason || (delta > 0 ? `加 ${delta} 分` : `扣 ${-delta} 分`));

    const batchId = tx(db, () => {
      const b = db.prepare('INSERT INTO score_batches (teacher_id, class_id, client_batch_id, label) VALUES (?,?,?,?)').run(tid, c.id, clientBatch, label);
      const bid = Number(b.lastInsertRowid);
      for (const sid of ids) {
        const s = own('students', sid, tid);
        if (s.class_id !== c.id) throw bad('學生不屬於此班');
        const r = db.prepare(`INSERT INTO score_events (teacher_id, class_id, student_id, batch_id, kind, delta, tag_id, reason) VALUES (?,?,?,?, 'point', ?,?,?)`)
          .run(tid, c.id, sid, bid, delta, tag?.id ?? null, reason);
        const event = db.prepare('SELECT * FROM score_events WHERE id = ?').get(Number(r.lastInsertRowid));
        db.prepare('UPDATE students SET score = score + ? WHERE id = ?').run(delta, sid);
        const pet = petOf(sid);
        if (isXpEligible(event, pet)) {
          const xp = pet.xp + delta;
          const stage = nextStage(pet.stage, xp, th);
          const ins = db.prepare('INSERT OR IGNORE INTO pet_xp_ledger (score_event_id, pet_id, xp, stage_before, stage_after) VALUES (?,?,?,?,?)')
            .run(event.id, pet.id, delta, pet.stage, stage);
          if (Number(ins.changes) === 1) {
            db.prepare(`UPDATE student_pets SET xp = ?, stage = ?, updated_at = ?,
                hatched_at = CASE WHEN hatched_at IS NULL AND ? <> 'egg' THEN ? ELSE hatched_at END WHERE id = ?`)
              .run(xp, stage, now(), stage, now(), pet.id);
          }
        }
      }
      return bid;
    });
    return batchResult(batchId);
  });

  on('POST', '/batches/:id/undo', ({ tid, p }) => {
    const b = own('score_batches', p.id, tid);
    if (b.undone_at) throw bad('此操作已撤銷');
    tx(db, () => {
      const t = now();
      for (const e of db.prepare('SELECT * FROM score_events WHERE batch_id = ? AND undone_at IS NULL').all(b.id)) {
        db.prepare('UPDATE score_events SET undone_at = ? WHERE id = ?').run(t, e.id);
        db.prepare('UPDATE students SET score = score - ? WHERE id = ?').run(e.delta, e.student_id);
        const l = db.prepare('SELECT * FROM pet_xp_ledger WHERE score_event_id = ? AND reversed_at IS NULL').get(e.id);
        if (l) {
          db.prepare('UPDATE pet_xp_ledger SET reversed_at = ? WHERE score_event_id = ?').run(t, e.id);
          // XP 扣回，但階段不倒退
          db.prepare('UPDATE student_pets SET xp = MAX(0, xp - ?), updated_at = ? WHERE id = ?').run(l.xp, t, l.pet_id);
        }
      }
      db.prepare('UPDATE score_batches SET undone_at = ? WHERE id = ?').run(t, b.id);
    });
    return batchResult(b.id);
  });

  on('GET', '/classes/:id/batches', ({ tid, p, q }) => {
    const c = own('classes', p.id, tid);
    const limit = Math.min(200, int(q.limit) || 20);
    const rows = db.prepare(`SELECT b.*, COUNT(e.id) AS n, MIN(e.delta) AS delta,
        GROUP_CONCAT(s.name, '、') AS names
      FROM score_batches b JOIN score_events e ON e.batch_id = b.id JOIN students s ON s.id = e.student_id
      WHERE b.class_id = ? GROUP BY b.id ORDER BY b.id DESC LIMIT ?`).all(c.id, limit);
    return rows;
  });

  on('GET', '/classes/:id/events', ({ tid, p, q }) => {
    const c = own('classes', p.id, tid);
    const since = str(q.since, 30);
    return db.prepare(`SELECT e.id, e.student_id, e.kind, e.delta, e.reason, e.created_at, e.undone_at, e.batch_id,
        s.name, s.number, t.label AS tag_label, t.icon AS tag_icon, l.xp AS xp_gained
      FROM score_events e JOIN students s ON s.id = e.student_id LEFT JOIN behavior_tags t ON t.id = e.tag_id
      LEFT JOIN pet_xp_ledger l ON l.score_event_id = e.id
      WHERE e.class_id = ? AND (? = '' OR e.created_at >= ?) ORDER BY e.id DESC LIMIT 1000`).all(c.id, since, since);
  });

  // 海報：某日期之後的課堂得分（不含已撤銷及匯入）
  on('GET', '/classes/:id/leaderboard', ({ tid, p, q }) => {
    const c = own('classes', p.id, tid);
    const since = str(q.since, 30);
    const sums = db.prepare(`SELECT student_id, SUM(delta) AS gained FROM score_events
      WHERE class_id = ? AND kind = 'point' AND undone_at IS NULL AND (? = '' OR created_at >= ?) GROUP BY student_id`).all(c.id, since, since);
    const m = new Map(sums.map(r => [r.student_id, r.gained]));
    return { class: c, students: studentsOf(c.id).map(s => ({ ...s, gained: m.get(s.id) || 0 })) };
  });

  // ---------- 寵物 ----------
  on('POST', '/pets/assign', ({ tid, body }) => {
    const ids = [...new Set((body.student_ids || []).map(int))];
    if (!ids.length) throw bad('請選擇學生');
    const mode = str(body.species_key, 20);
    if (mode !== 'balanced' && !SPECIES_KEYS.includes(mode)) throw bad('請選擇寵物品種');
    return tx(db, () => {
      const students = ids.map(id => own('students', id, tid)).filter(s => !petOf(s.id));
      let picks;
      if (mode === 'balanced') {
        const classIds = [...new Set(students.map(s => s.class_id))];
        const counts = {};
        for (const cid of classIds) for (const r of db.prepare(`SELECT p.species_key k, COUNT(*) n FROM student_pets p JOIN students s ON s.id = p.student_record_id WHERE s.class_id = ? GROUP BY k`).all(cid)) counts[r.k] = (counts[r.k] || 0) + r.n;
        picks = balancedSpecies(students.length, counts);
      } else picks = students.map(() => mode);
      const baseline = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM score_events').get().m;
      const created = students.map((s, i) => {
        db.prepare('INSERT INTO student_pets (teacher_id, student_record_id, species_key, baseline_event_id) VALUES (?,?,?,?)').run(tid, s.id, picks[i], baseline);
        return studentFull(s.id);
      });
      return { created, skipped: ids.length - students.length };
    });
  });

  on('PATCH', '/pets/:id', ({ tid, p, body }) => {
    const pet = own('student_pets', p.id, tid);
    if (body.species_key !== undefined && body.species_key !== pet.species_key) {
      if (pet.stage !== 'egg') throw bad('寵物已孵化，不可更換品種');
      if (!SPECIES_KEYS.includes(body.species_key)) throw bad('未知品種');
      db.prepare('UPDATE student_pets SET species_key = ?, updated_at = ? WHERE id = ?').run(body.species_key, now(), pet.id);
    }
    if (body.nickname !== undefined) db.prepare('UPDATE student_pets SET nickname = ?, updated_at = ? WHERE id = ?').run(str(body.nickname, 12) || null, now(), pet.id);
    if (body.accessories !== undefined) {
      if (!Array.isArray(body.accessories)) throw bad('飾物格式錯誤');
      db.prepare('UPDATE student_pets SET accessories = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(body.accessories.slice(0, 10).map(x => str(x, 30))), now(), pet.id);
    }
    return studentFull(pet.student_record_id);
  });

  on('DELETE', '/pets/:id', ({ tid, p }) => {
    own('student_pets', p.id, tid); db.prepare('DELETE FROM student_pets WHERE id = ?').run(p.id); return { ok: true };
  });

  on('PUT', '/settings', ({ tid, body }) => {
    let th;
    try { th = normalizeThresholds(body.thresholds); } catch (e) { throw bad(e.message); }
    let upgraded = 0;
    tx(db, () => {
      db.prepare('UPDATE settings SET thresholds = ? WHERE teacher_id = ?').run(JSON.stringify(th), tid);
      if (Array.isArray(body.timer_presets)) db.prepare('UPDATE settings SET timer_presets = ? WHERE teacher_id = ?').run(JSON.stringify(body.timer_presets.map(int).filter(n => n > 0 && n <= 7200).slice(0, 8)), tid);
      for (const pet of db.prepare('SELECT * FROM student_pets WHERE teacher_id = ?').all(tid)) {
        const st = nextStage(pet.stage, pet.xp, th);
        if (st !== pet.stage) {
          upgraded++;
          db.prepare(`UPDATE student_pets SET stage = ?, updated_at = ?, hatched_at = COALESCE(hatched_at, ?) WHERE id = ?`).run(st, now(), now(), pet.id);
        }
      }
    });
    return { thresholds: th, upgraded };
  });

  // 資料一致性自我檢查（驗收用）
  on('GET', '/audit', ({ tid }) => {
    const th = thresholdsOf(tid); const problems = [];
    const pets = db.prepare('SELECT * FROM student_pets WHERE teacher_id = ?').all(tid);
    for (const p of pets) {
      const sum = db.prepare('SELECT COALESCE(SUM(xp),0) s FROM pet_xp_ledger WHERE pet_id = ? AND reversed_at IS NULL').get(p.id).s;
      if (sum !== p.xp) problems.push(`寵物 ${p.id}：XP ${p.xp} 與入帳總和 ${sum} 不符`);
      if (!SPECIES_KEYS.includes(p.species_key)) problems.push(`寵物 ${p.id}：未知品種`);
      if (!STAGES.includes(p.stage)) problems.push(`寵物 ${p.id}：未知階段`);
      else if (stageIndex(p.stage) < stageIndex(stageForXp(p.xp, th))) problems.push(`寵物 ${p.id}：XP 已達 ${stageForXp(p.xp, th)} 但階段仍為 ${p.stage}`);
      const badLedger = db.prepare(`SELECT COUNT(*) n FROM pet_xp_ledger l JOIN score_events e ON e.id = l.score_event_id
        WHERE l.pet_id = ? AND (e.student_id <> ? OR e.delta <= 0 OR e.kind <> 'point' OR e.id <= ? OR l.xp <> e.delta)`).get(p.id, p.student_record_id, p.baseline_event_id).n;
      if (badLedger) problems.push(`寵物 ${p.id}：有 ${badLedger} 筆不應計入的 XP`);
    }
    for (const s of db.prepare('SELECT * FROM students WHERE teacher_id = ?').all(tid)) {
      const sum = db.prepare('SELECT COALESCE(SUM(delta),0) s FROM score_events WHERE student_id = ? AND undone_at IS NULL').get(s.id).s;
      if (sum !== s.score) problems.push(`學生 ${s.id}：總分 ${s.score} 與紀錄總和 ${sum} 不符`);
    }
    return { pets: pets.length, problems };
  });

  // ---------- 功課 ----------
  on('GET', '/classes/:id/homework', ({ tid, p }) => {
    const c = own('classes', p.id, tid);
    return db.prepare(`SELECT h.*,
        SUM(CASE WHEN hs.status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
        SUM(CASE WHEN hs.status = 'late' THEN 1 ELSE 0 END) AS late,
        SUM(CASE WHEN hs.status = 'missing' THEN 1 ELSE 0 END) AS missing,
        SUM(CASE WHEN hs.status = 'excused' THEN 1 ELSE 0 END) AS excused
      FROM homework h LEFT JOIN homework_submissions hs ON hs.homework_id = h.id
      WHERE h.class_id = ? GROUP BY h.id ORDER BY h.due_date DESC, h.id DESC`).all(c.id);
  });
  on('POST', '/classes/:id/homework', ({ tid, p, body }) => {
    const c = own('classes', p.id, tid); const title = str(body.title, 60);
    if (!title) throw bad('請輸入功課名稱');
    const r = db.prepare('INSERT INTO homework (teacher_id, class_id, title, subject, due_date) VALUES (?,?,?,?,?)').run(tid, c.id, title, str(body.subject, 20), str(body.due_date, 10));
    return own('homework', Number(r.lastInsertRowid), tid);
  });
  on('DELETE', '/homework/:id', ({ tid, p }) => { own('homework', p.id, tid); db.prepare('DELETE FROM homework WHERE id = ?').run(p.id); return { ok: true }; });
  on('GET', '/homework/:id/submissions', ({ tid, p }) => {
    const h = own('homework', p.id, tid);
    return { homework: h, entries: db.prepare('SELECT student_id, status, updated_at FROM homework_submissions WHERE homework_id = ?').all(h.id) };
  });
  on('PUT', '/homework/:id/submissions', ({ tid, p, body }) => {
    const h = own('homework', p.id, tid);
    tx(db, () => {
      for (const e of body.entries || []) {
        const s = own('students', int(e.student_id), tid);
        if (s.class_id !== h.class_id) throw bad('學生不屬於此班');
        if (!e.status) db.prepare('DELETE FROM homework_submissions WHERE homework_id = ? AND student_id = ?').run(h.id, s.id);
        else {
          if (!['submitted', 'late', 'missing', 'excused'].includes(e.status)) throw bad('未知提交狀態');
          db.prepare(`INSERT INTO homework_submissions (homework_id, student_id, status, updated_at) VALUES (?,?,?,?)
            ON CONFLICT(homework_id, student_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`).run(h.id, s.id, e.status, now());
        }
      }
    });
    return { ok: true };
  });

  // ---------- 考試 ----------
  on('GET', '/classes/:id/exams', ({ tid, p }) => {
    const c = own('classes', p.id, tid);
    return db.prepare(`SELECT x.*, COUNT(es.score) AS n, AVG(es.score) AS avg, MAX(es.score) AS max, MIN(es.score) AS min
      FROM exams x LEFT JOIN exam_scores es ON es.exam_id = x.id WHERE x.class_id = ? GROUP BY x.id ORDER BY x.exam_date DESC, x.id DESC`).all(c.id);
  });
  on('POST', '/classes/:id/exams', ({ tid, p, body }) => {
    const c = own('classes', p.id, tid); const title = str(body.title, 60);
    const full = Number(body.full_mark || 100);
    if (!title) throw bad('請輸入考試名稱');
    if (!(full > 0 && full <= 1000)) throw bad('滿分須為 1 至 1000');
    const r = db.prepare('INSERT INTO exams (teacher_id, class_id, title, subject, full_mark, exam_date) VALUES (?,?,?,?,?,?)').run(tid, c.id, title, str(body.subject, 20), full, str(body.exam_date, 10));
    return own('exams', Number(r.lastInsertRowid), tid);
  });
  on('DELETE', '/exams/:id', ({ tid, p }) => { own('exams', p.id, tid); db.prepare('DELETE FROM exams WHERE id = ?').run(p.id); return { ok: true }; });
  on('GET', '/exams/:id/scores', ({ tid, p }) => {
    const x = own('exams', p.id, tid);
    return { exam: x, scores: db.prepare('SELECT student_id, score FROM exam_scores WHERE exam_id = ?').all(x.id) };
  });
  on('PUT', '/exams/:id/scores', ({ tid, p, body }) => {
    const x = own('exams', p.id, tid);
    tx(db, () => {
      for (const e of body.scores || []) {
        const s = own('students', int(e.student_id), tid);
        if (s.class_id !== x.class_id) throw bad('學生不屬於此班');
        if (e.score === null || e.score === '') { db.prepare('DELETE FROM exam_scores WHERE exam_id = ? AND student_id = ?').run(x.id, s.id); continue; }
        const v = Number(e.score);
        if (!(v >= 0 && v <= x.full_mark)) throw bad(`${s.name} 的分數須在 0 至 ${x.full_mark} 之間`);
        db.prepare(`INSERT INTO exam_scores (exam_id, student_id, score) VALUES (?,?,?)
          ON CONFLICT(exam_id, student_id) DO UPDATE SET score = excluded.score`).run(x.id, s.id, v);
      }
    });
    return { ok: true };
  });

  // ---------- 分派 ----------
  return function handle(method, path, { tid, body = {}, query = {} }) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = path.match(r.re); if (!m) continue;
      const p = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
      return r.fn({ tid, p, body: body || {}, q: query });
    }
    throw new HttpError(404, '找不到此功能');
  };
}
