// 示範模式後端：在瀏覽器記憶體內實作與 server/api.js 相同的 API 及規則，
// 只用於預覽連結（沒有真伺服器時）。寵物規則同樣取自 shared/pet-logic.js。
import {
  SPECIES_KEYS, STAGES, DEFAULT_THRESHOLDS, normalizeThresholds, nextStage, stageForXp,
  stageIndex, isXpEligible, balancedSpecies,
} from '../shared/pet-logic.js';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const notFound = () => new HttpError(404, '找不到資料，或你沒有權限查看');
const str = (v, max = 80) => String(v ?? '').trim().slice(0, max);
const int = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const now = () => new Date().toISOString();
const clone = (o) => JSON.parse(JSON.stringify(o));

export function createDemoBackend(initial) {
  const S = initial ? clone(initial) : {
    seq: {}, teachers: [], settings: [], classes: [], groups: [], students: [], behavior_tags: [],
    score_batches: [], score_events: [], student_pets: [], pet_xp_ledger: [], homework: [],
    homework_submissions: [], exams: [], exam_scores: [], homework_templates: [],
  };
  const nextId = (t) => (S.seq[t] = (S.seq[t] || 0) + 1);
  const insert = (t, row) => { const r = { id: nextId(t), created_at: now(), ...row }; S[t].push(r); return r; };
  const own = (t, id, tid) => { const r = S[t].find(x => x.id === id && x.teacher_id === tid); if (!r) throw notFound(); return r; };
  const txn = (fn) => { const snap = clone(S); try { return fn(); } catch (e) { Object.assign(S, snap); throw e; } };

  const settingsOf = (tid) => S.settings.find(s => s.teacher_id === tid);
  const thresholdsOf = (tid) => normalizeThresholds(settingsOf(tid)?.thresholds || DEFAULT_THRESHOLDS);
  const petOf = (sid) => {
    const p = S.student_pets.find(p => p.student_record_id === sid); if (!p) return null;
    const { id, student_record_id, species_key, stage, xp, baseline_event_id, nickname, accessories, assigned_at, hatched_at } = p;
    return clone({ id, student_record_id, species_key, stage, xp, baseline_event_id, nickname, accessories, assigned_at, hatched_at });
  };
  const studentFull = (sid) => { const s = S.students.find(s => s.id === sid); return { ...clone(s), pet: petOf(sid) }; };
  const sortStudents = (a, b) => (a.number == null) - (b.number == null) || (a.number ?? 0) - (b.number ?? 0) || a.id - b.id;
  const studentsOf = (cid) => S.students.filter(s => s.class_id === cid).sort(sortStudents).map(s => studentFull(s.id));
  const tagOf = (id) => S.behavior_tags.find(t => t.id === id);
  const ledgerOf = (eid) => S.pet_xp_ledger.find(l => l.score_event_id === eid);

  function seedTeacher(tid) {
    S.settings.push({ teacher_id: tid, thresholds: { ...DEFAULT_THRESHOLDS }, timer_presets: [60, 180, 300, 600] });
    [['專心上課', 1, '👂'], ['積極舉手', 1, '✋'], ['幫助同學', 2, '🤝'], ['功課認真', 2, '📘'],
      ['收拾整齊', 1, '🧹'], ['欠交功課', -1, '📕'], ['不守秩序', -1, '🔇']]
      .forEach(([label, points, icon], sort) => insert('behavior_tags', { teacher_id: tid, label, points, icon, sort }));
    [['中文作文', '中文'], ['英文默書', '英文'], ['數學工作紙', '數學'], ['常識工作紙', '常識']].forEach(([title, subject]) => addTemplate(tid, title, subject));
  }
  function addTemplate(tid, title, subject) {
    if (!S.homework_templates.some(t => t.teacher_id === tid && t.title === title && t.subject === subject)) insert('homework_templates', { teacher_id: tid, title, subject });
  }
  const listTemplates = (tid) => S.homework_templates.filter(t => t.teacher_id === tid)
    .sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || a.id - b.id)
    .map(({ id, title, subject }) => ({ id, title, subject }));
  function listClasses(tid) {
    return S.classes.filter(c => c.teacher_id === tid).sort((a, b) => a.name.localeCompare(b.name)).map(c => {
      const st = S.students.filter(s => s.class_id === c.id);
      return { ...clone(c), student_count: st.length, total_score: st.reduce((a, s) => a + s.score, 0),
        pet_count: S.student_pets.filter(p => st.some(s => s.id === p.student_record_id)).length };
    });
  }
  function batchResult(bid) {
    const b = S.score_batches.find(b => b.id === bid);
    return {
      batch_id: b.id, label: b.label, undone: !!b.undone_at,
      results: S.score_events.filter(e => e.batch_id === bid).map(e => {
        const s = studentFull(e.student_id); const l = ledgerOf(e.id);
        return { event_id: e.id, student_id: s.id, name: s.name, number: s.number, delta: e.delta, score: s.score,
          xp_gained: l?.xp || 0, stage_before: l?.stage_before || s.pet?.stage || null, stage_after: l?.stage_after || s.pet?.stage || null,
          leveled_up: !!(l && l.stage_before !== l.stage_after), pet: s.pet };
      }),
    };
  }

  const routes = [];
  const on = (method, pattern, fn) => {
    const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
    routes.push({ method, re, keys, fn });
  };

  on('GET', '/bootstrap', ({ tid }) => ({ thresholds: thresholdsOf(tid), timer_presets: settingsOf(tid).timer_presets,
    tags: clone(S.behavior_tags.filter(t => t.teacher_id === tid).sort((a, b) => a.sort - b.sort || a.id - b.id)), classes: listClasses(tid),
    homework_templates: listTemplates(tid) }));
  on('GET', '/homework-templates', ({ tid }) => listTemplates(tid));
  on('POST', '/homework-templates', ({ tid, body }) => { const title = str(body.title, 60); if (!title) throw bad('請輸入功課名稱'); addTemplate(tid, title, str(body.subject, 20)); return listTemplates(tid); });
  on('DELETE', '/homework-templates/:id', ({ tid, p }) => { own('homework_templates', p.id, tid); S.homework_templates = S.homework_templates.filter(t => t.id !== p.id); return listTemplates(tid); });
  on('GET', '/classes', ({ tid }) => listClasses(tid));
  on('POST', '/classes', ({ tid, body }) => { const name = str(body.name, 30); if (!name) throw bad('請輸入班別名稱'); return clone(insert('classes', { teacher_id: tid, name, school_year: str(body.school_year, 20), seat_cols: 6 })); });
  on('PATCH', '/classes/:id', ({ tid, p, body }) => { const c = own('classes', p.id, tid); c.name = str(body.name ?? c.name, 30) || c.name; c.school_year = str(body.school_year ?? c.school_year, 20); return clone(c); });
  on('DELETE', '/classes/:id', ({ tid, p }) => {
    own('classes', p.id, tid);
    const sids = S.students.filter(s => s.class_id === p.id).map(s => s.id);
    S.classes = S.classes.filter(c => c.id !== p.id); S.students = S.students.filter(s => s.class_id !== p.id);
    S.groups = S.groups.filter(g => g.class_id !== p.id); S.student_pets = S.student_pets.filter(x => !sids.includes(x.student_record_id));
    S.score_events = S.score_events.filter(e => e.class_id !== p.id); S.score_batches = S.score_batches.filter(b => b.class_id !== p.id);
    return { ok: true };
  });
  on('GET', '/classes/:id/full', ({ tid, p }) => { const c = own('classes', p.id, tid); return { class: clone(c), students: studentsOf(c.id), groups: clone(S.groups.filter(g => g.class_id === c.id)) }; });

  on('PUT', '/classes/:id/seats', ({ tid, p, body }) => {
    const c = own('classes', p.id, tid);
    const cols = body.cols === undefined ? c.seat_cols : int(body.cols);
    if (!(cols >= 2 && cols <= 12)) throw bad('每行座位數須為 2 至 12');
    const seats = Array.isArray(body.seats) ? body.seats : [];
    const used = new Set();
    for (const st of seats) {
      const r = int(st.row); const col = int(st.col);
      if (!(r >= 0 && r < 30 && col >= 0 && col < cols)) throw bad('座位位置不正確');
      const key = `${r},${col}`; if (used.has(key)) throw bad('同一個座位不可坐兩位學生'); used.add(key);
    }
    txn(() => {
      c.seat_cols = cols;
      S.students.filter(s => s.class_id === c.id).forEach(s => { s.seat_row = null; s.seat_col = null; });
      for (const st of seats) {
        const s = own('students', int(st.student_id), tid);
        if (s.class_id !== c.id) throw bad('學生不屬於此班');
        s.seat_row = int(st.row); s.seat_col = int(st.col);
      }
    });
    return { class: clone(c), students: studentsOf(c.id), groups: clone(S.groups.filter(g => g.class_id === c.id)) };
  });

  on('POST', '/classes/:id/students', ({ tid, p, body }) => {
    const c = own('classes', p.id, tid); const list = Array.isArray(body.students) ? body.students : [];
    if (!list.length) throw bad('沒有學生資料'); if (list.length > 60) throw bad('一次最多匯入 60 名學生');
    return txn(() => {
      const created = [];
      for (const raw of list) {
        const name = str(raw.name, 40); if (!name) continue;
        const number = raw.number === '' || raw.number == null ? null : int(raw.number);
        const score = raw.score === '' || raw.score == null ? 0 : int(raw.score);
        if (Number.isNaN(number) || Number.isNaN(score)) throw bad(`「${name}」的班號或分數不是整數`);
        const s = insert('students', { teacher_id: tid, class_id: c.id, number, name, group_id: null, score, seat_row: null, seat_col: null });
        if (score) insert('score_events', { teacher_id: tid, class_id: c.id, student_id: s.id, batch_id: null, kind: 'import', delta: score, tag_id: null, reason: '保留舊分數（匯入）', undone_at: null });
        created.push(studentFull(s.id));
      }
      return { created };
    });
  });
  on('GET', '/students/:id', ({ tid, p }) => {
    const s = own('students', p.id, tid);
    const events = S.score_events.filter(e => e.student_id === s.id).sort((a, b) => b.id - a.id).slice(0, 300).map(e => {
      const t = tagOf(e.tag_id); const l = ledgerOf(e.id); const b = S.score_batches.find(b => b.id === e.batch_id);
      return { ...clone(e), tag_label: t?.label ?? null, tag_icon: t?.icon ?? null, batch_label: b?.label ?? null,
        xp_gained: l?.xp ?? null, stage_before: l?.stage_before ?? null, stage_after: l?.stage_after ?? null, xp_reversed_at: l?.reversed_at ?? null };
    });
    const homework = S.homework.filter(h => h.class_id === s.class_id).sort((a, b) => b.due_date.localeCompare(a.due_date) || b.id - a.id)
      .map(h => ({ id: h.id, title: h.title, subject: h.subject, due_date: h.due_date, status: S.homework_submissions.find(x => x.homework_id === h.id && x.student_id === s.id)?.status ?? null }));
    const exams = S.exams.filter(x => x.class_id === s.class_id).sort((a, b) => b.exam_date.localeCompare(a.exam_date) || b.id - a.id)
      .map(x => ({ id: x.id, title: x.title, subject: x.subject, full_mark: x.full_mark, exam_date: x.exam_date, score: S.exam_scores.find(e => e.exam_id === x.id && e.student_id === s.id)?.score ?? null }));
    return { student: studentFull(s.id), class: clone(own('classes', s.class_id, tid)), events, homework, exams, thresholds: thresholdsOf(tid) };
  });
  on('PATCH', '/students/:id', ({ tid, p, body }) => {
    const s = own('students', p.id, tid);
    const name = body.name !== undefined ? str(body.name, 40) : s.name; if (!name) throw bad('姓名不可留空');
    const number = body.number !== undefined ? (body.number === '' || body.number === null ? null : int(body.number)) : s.number;
    if (Number.isNaN(number)) throw bad('班號必須是整數');
    let group = s.group_id;
    if (body.group_id !== undefined) { group = body.group_id ? own('groups', int(body.group_id), tid).id : null; if (group && S.groups.find(g => g.id === group).class_id !== s.class_id) throw bad('小組不屬於此班'); }
    Object.assign(s, { name, number, group_id: group }); return studentFull(s.id);
  });
  on('DELETE', '/students/:id', ({ tid, p }) => {
    own('students', p.id, tid); S.students = S.students.filter(s => s.id !== p.id);
    const pet = S.student_pets.find(x => x.student_record_id === p.id);
    S.student_pets = S.student_pets.filter(x => x !== pet); S.score_events = S.score_events.filter(e => e.student_id !== p.id);
    if (pet) S.pet_xp_ledger = S.pet_xp_ledger.filter(l => l.pet_id !== pet.id);
    return { ok: true };
  });

  on('POST', '/classes/:id/groups', ({ tid, p, body }) => { const c = own('classes', p.id, tid); const name = str(body.name, 20); if (!name) throw bad('請輸入小組名稱'); return clone(insert('groups', { teacher_id: tid, class_id: c.id, name, color: str(body.color, 9) || '#8cc4f5' })); });
  on('PATCH', '/groups/:id', ({ tid, p, body }) => { const g = own('groups', p.id, tid); g.name = str(body.name ?? g.name, 20) || g.name; g.color = str(body.color ?? g.color, 9); return clone(g); });
  on('DELETE', '/groups/:id', ({ tid, p }) => { own('groups', p.id, tid); S.groups = S.groups.filter(g => g.id !== p.id); S.students.forEach(s => { if (s.group_id === p.id) s.group_id = null; }); return { ok: true }; });
  on('PUT', '/groups/:id/members', ({ tid, p, body }) => {
    const g = own('groups', p.id, tid);
    txn(() => { S.students.forEach(s => { if (s.group_id === g.id) s.group_id = null; });
      for (const id of (body.student_ids || []).map(int)) { const s = own('students', id, tid); if (s.class_id !== g.class_id) throw bad('學生不屬於此班'); s.group_id = g.id; } });
    return { ok: true };
  });

  on('POST', '/tags', ({ tid, body }) => {
    const label = str(body.label, 16); const points = int(body.points);
    if (!label || !points || Math.abs(points) > 20) throw bad('請輸入標籤名稱，分數為 -20 至 20（不可為 0）');
    const sort = Math.max(0, ...S.behavior_tags.filter(t => t.teacher_id === tid).map(t => t.sort)) + 1;
    return clone(insert('behavior_tags', { teacher_id: tid, label, points, icon: str(body.icon, 4) || '⭐', sort }));
  });
  on('PATCH', '/tags/:id', ({ tid, p, body }) => {
    const t = own('behavior_tags', p.id, tid); const points = body.points !== undefined ? int(body.points) : t.points;
    if (!points || Math.abs(points) > 20) throw bad('分數為 -20 至 20（不可為 0）');
    Object.assign(t, { label: str(body.label ?? t.label, 16) || t.label, points, icon: str(body.icon ?? t.icon, 4) || t.icon }); return clone(t);
  });
  on('DELETE', '/tags/:id', ({ tid, p }) => { own('behavior_tags', p.id, tid); S.behavior_tags = S.behavior_tags.filter(t => t.id !== p.id); S.score_events.forEach(e => { if (e.tag_id === p.id) e.tag_id = null; }); return { ok: true }; });

  on('POST', '/points', ({ tid, body }) => {
    const c = own('classes', int(body.class_id), tid);
    const clientBatch = str(body.client_batch_id, 64); if (!clientBatch) throw bad('缺少操作編號');
    const existing = S.score_batches.find(b => b.teacher_id === tid && b.client_batch_id === clientBatch);
    if (existing) return { ...batchResult(existing.id), replayed: true };
    let delta = int(body.delta); let tag = null;
    if (body.tag_id) { tag = own('behavior_tags', int(body.tag_id), tid); delta = tag.points; }
    if (!delta || Math.abs(delta) > 100) throw bad('分數必須是 -100 至 100 的整數（不可為 0）');
    const ids = [...new Set((body.student_ids || []).map(int))]; if (!ids.length) throw bad('請選擇學生');
    const th = thresholdsOf(tid); const reason = str(body.reason, 60);
    const label = tag ? `${tag.icon} ${tag.label}` : (reason || (delta > 0 ? `加 ${delta} 分` : `扣 ${-delta} 分`));
    const bid = txn(() => {
      const b = insert('score_batches', { teacher_id: tid, class_id: c.id, client_batch_id: clientBatch, label, undone_at: null });
      for (const sid of ids) {
        const s = own('students', sid, tid); if (s.class_id !== c.id) throw bad('學生不屬於此班');
        const event = insert('score_events', { teacher_id: tid, class_id: c.id, student_id: sid, batch_id: b.id, kind: 'point', delta, tag_id: tag?.id ?? null, reason, undone_at: null });
        s.score += delta;
        const pet = S.student_pets.find(x => x.student_record_id === sid);
        if (isXpEligible(event, pet) && !ledgerOf(event.id)) {
          const xp = pet.xp + delta; const stage = nextStage(pet.stage, xp, th);
          S.pet_xp_ledger.push({ score_event_id: event.id, pet_id: pet.id, xp: delta, stage_before: pet.stage, stage_after: stage, reversed_at: null });
          if (pet.stage === 'egg' && stage !== 'egg' && !pet.hatched_at) pet.hatched_at = now();
          Object.assign(pet, { xp, stage, updated_at: now() });
        }
      }
      return b.id;
    });
    return batchResult(bid);
  });
  on('POST', '/batches/:id/undo', ({ tid, p }) => {
    const b = own('score_batches', p.id, tid); if (b.undone_at) throw bad('此操作已撤銷');
    const t = now();
    for (const e of S.score_events.filter(e => e.batch_id === b.id && !e.undone_at)) {
      e.undone_at = t; S.students.find(s => s.id === e.student_id).score -= e.delta;
      const l = S.pet_xp_ledger.find(l => l.score_event_id === e.id && !l.reversed_at);
      if (l) { l.reversed_at = t; const pet = S.student_pets.find(x => x.id === l.pet_id); pet.xp = Math.max(0, pet.xp - l.xp); pet.updated_at = t; }
    }
    b.undone_at = t; return batchResult(b.id);
  });
  on('GET', '/classes/:id/batches', ({ tid, p, q }) => {
    const c = own('classes', p.id, tid); const limit = Math.min(200, int(q.limit) || 20);
    return S.score_batches.filter(b => b.class_id === c.id).sort((a, b) => b.id - a.id).slice(0, limit).map(b => {
      const evs = S.score_events.filter(e => e.batch_id === b.id);
      return { ...clone(b), n: evs.length, delta: Math.min(...evs.map(e => e.delta)), names: evs.map(e => S.students.find(s => s.id === e.student_id)?.name).join('、') };
    }).filter(b => b.n > 0);
  });
  on('GET', '/classes/:id/events', ({ tid, p, q }) => {
    const c = own('classes', p.id, tid); const since = str(q.since, 30);
    return S.score_events.filter(e => e.class_id === c.id && (!since || e.created_at >= since)).sort((a, b) => b.id - a.id).slice(0, 1000).map(e => {
      const s = S.students.find(s => s.id === e.student_id); const t = tagOf(e.tag_id);
      return { id: e.id, student_id: e.student_id, kind: e.kind, delta: e.delta, reason: e.reason, created_at: e.created_at, undone_at: e.undone_at, batch_id: e.batch_id,
        name: s.name, number: s.number, tag_label: t?.label ?? null, tag_icon: t?.icon ?? null, xp_gained: ledgerOf(e.id)?.xp ?? null };
    });
  });
  on('GET', '/classes/:id/leaderboard', ({ tid, p, q }) => {
    const c = own('classes', p.id, tid); const since = str(q.since, 30);
    const g = {}; S.score_events.filter(e => e.class_id === c.id && e.kind === 'point' && !e.undone_at && (!since || e.created_at >= since)).forEach(e => { g[e.student_id] = (g[e.student_id] || 0) + e.delta; });
    return { class: clone(c), students: studentsOf(c.id).map(s => ({ ...s, gained: g[s.id] || 0 })) };
  });

  on('POST', '/pets/assign', ({ tid, body }) => {
    const ids = [...new Set((body.student_ids || []).map(int))]; if (!ids.length) throw bad('請選擇學生');
    const mode = str(body.species_key, 20); if (mode !== 'balanced' && !SPECIES_KEYS.includes(mode)) throw bad('請選擇寵物品種');
    return txn(() => {
      const students = ids.map(id => own('students', id, tid)).filter(s => !petOf(s.id));
      let picks;
      if (mode === 'balanced') {
        const counts = {}; const cls = new Set(students.map(s => s.class_id));
        S.student_pets.forEach(pt => { const s = S.students.find(s => s.id === pt.student_record_id); if (s && cls.has(s.class_id)) counts[pt.species_key] = (counts[pt.species_key] || 0) + 1; });
        picks = balancedSpecies(students.length, counts);
      } else picks = students.map(() => mode);
      const baseline = Math.max(0, ...S.score_events.map(e => e.id));
      const created = students.map((s, i) => {
        insert('student_pets', { teacher_id: tid, student_record_id: s.id, species_key: picks[i], stage: 'egg', xp: 0, baseline_event_id: baseline,
          nickname: null, accessories: [], assigned_at: now(), hatched_at: null, updated_at: now() });
        return studentFull(s.id);
      });
      return { created, skipped: ids.length - students.length };
    });
  });
  on('PATCH', '/pets/:id', ({ tid, p, body }) => {
    const pet = own('student_pets', p.id, tid);
    if (body.species_key !== undefined && body.species_key !== pet.species_key) {
      if (pet.stage !== 'egg') throw bad('寵物已孵化，不可更換品種'); if (!SPECIES_KEYS.includes(body.species_key)) throw bad('未知品種');
      pet.species_key = body.species_key;
    }
    if (body.nickname !== undefined) pet.nickname = str(body.nickname, 12) || null;
    if (body.accessories !== undefined) { if (!Array.isArray(body.accessories)) throw bad('飾物格式錯誤'); pet.accessories = body.accessories.slice(0, 10).map(x => str(x, 30)); }
    pet.updated_at = now(); return studentFull(pet.student_record_id);
  });
  on('DELETE', '/pets/:id', ({ tid, p }) => { own('student_pets', p.id, tid); S.student_pets = S.student_pets.filter(x => x.id !== p.id); S.pet_xp_ledger = S.pet_xp_ledger.filter(l => l.pet_id !== p.id); return { ok: true }; });
  on('PUT', '/settings', ({ tid, body }) => {
    let th; try { th = normalizeThresholds(body.thresholds); } catch (e) { throw bad(e.message); }
    const st = settingsOf(tid); st.thresholds = th;
    if (Array.isArray(body.timer_presets)) st.timer_presets = body.timer_presets.map(int).filter(n => n > 0 && n <= 7200).slice(0, 8);
    let upgraded = 0;
    S.student_pets.filter(x => x.teacher_id === tid).forEach(pet => { const s = nextStage(pet.stage, pet.xp, th); if (s !== pet.stage) { upgraded++; pet.stage = s; pet.hatched_at ||= now(); } });
    return { thresholds: th, upgraded };
  });
  on('GET', '/audit', ({ tid }) => {
    const th = thresholdsOf(tid); const problems = [];
    const pets = S.student_pets.filter(x => x.teacher_id === tid);
    for (const p of pets) {
      const led = S.pet_xp_ledger.filter(l => l.pet_id === p.id);
      const sum = led.filter(l => !l.reversed_at).reduce((a, l) => a + l.xp, 0);
      if (sum !== p.xp) problems.push(`寵物 ${p.id}：XP ${p.xp} 與入帳總和 ${sum} 不符`);
      if (!SPECIES_KEYS.includes(p.species_key)) problems.push(`寵物 ${p.id}：未知品種`);
      if (!STAGES.includes(p.stage)) problems.push(`寵物 ${p.id}：未知階段`);
      else if (stageIndex(p.stage) < stageIndex(stageForXp(p.xp, th))) problems.push(`寵物 ${p.id}：XP 已達 ${stageForXp(p.xp, th)} 但階段仍為 ${p.stage}`);
      const badN = led.filter(l => { const e = S.score_events.find(e => e.id === l.score_event_id); return !e || e.student_id !== p.student_record_id || e.delta <= 0 || e.kind !== 'point' || e.id <= p.baseline_event_id || l.xp !== e.delta; }).length;
      if (badN) problems.push(`寵物 ${p.id}：有 ${badN} 筆不應計入的 XP`);
    }
    for (const s of S.students.filter(s => s.teacher_id === tid)) {
      const sum = S.score_events.filter(e => e.student_id === s.id && !e.undone_at).reduce((a, e) => a + e.delta, 0);
      if (sum !== s.score) problems.push(`學生 ${s.id}：總分 ${s.score} 與紀錄總和 ${sum} 不符`);
    }
    return { pets: pets.length, problems };
  });

  on('GET', '/classes/:id/homework', ({ tid, p }) => {
    const c = own('classes', p.id, tid);
    return S.homework.filter(h => h.class_id === c.id).sort((a, b) => b.due_date.localeCompare(a.due_date) || b.id - a.id).map(h => {
      const subs = S.homework_submissions.filter(x => x.homework_id === h.id); const n = (st) => subs.filter(x => x.status === st).length;
      return { ...clone(h), submitted: n('submitted'), late: n('late'), missing: n('missing'), excused: n('excused') };
    });
  });
  on('POST', '/classes/:id/homework', ({ tid, p, body }) => { const c = own('classes', p.id, tid); const title = str(body.title, 60); if (!title) throw bad('請輸入功課名稱'); return clone(insert('homework', { teacher_id: tid, class_id: c.id, title, subject: str(body.subject, 20), due_date: str(body.due_date, 10) })); });
  on('DELETE', '/homework/:id', ({ tid, p }) => { own('homework', p.id, tid); S.homework = S.homework.filter(h => h.id !== p.id); S.homework_submissions = S.homework_submissions.filter(x => x.homework_id !== p.id); return { ok: true }; });
  on('GET', '/homework/:id/submissions', ({ tid, p }) => { const h = own('homework', p.id, tid); return { homework: clone(h), entries: clone(S.homework_submissions.filter(x => x.homework_id === h.id)) }; });
  on('PUT', '/homework/:id/submissions', ({ tid, p, body }) => {
    const h = own('homework', p.id, tid);
    txn(() => { for (const e of body.entries || []) {
      const s = own('students', int(e.student_id), tid); if (s.class_id !== h.class_id) throw bad('學生不屬於此班');
      S.homework_submissions = S.homework_submissions.filter(x => !(x.homework_id === h.id && x.student_id === s.id));
      if (e.status) { if (!['submitted', 'late', 'missing', 'excused'].includes(e.status)) throw bad('未知提交狀態'); S.homework_submissions.push({ homework_id: h.id, student_id: s.id, status: e.status, updated_at: now() }); }
    } });
    return { ok: true };
  });
  on('GET', '/classes/:id/exams', ({ tid, p }) => {
    const c = own('classes', p.id, tid);
    return S.exams.filter(x => x.class_id === c.id).sort((a, b) => b.exam_date.localeCompare(a.exam_date) || b.id - a.id).map(x => {
      const sc = S.exam_scores.filter(e => e.exam_id === x.id && e.score != null).map(e => e.score);
      return { ...clone(x), n: sc.length, avg: sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : null, max: sc.length ? Math.max(...sc) : null, min: sc.length ? Math.min(...sc) : null };
    });
  });
  on('POST', '/classes/:id/exams', ({ tid, p, body }) => {
    const c = own('classes', p.id, tid); const title = str(body.title, 60); const full = Number(body.full_mark || 100);
    if (!title) throw bad('請輸入考試名稱'); if (!(full > 0 && full <= 1000)) throw bad('滿分須為 1 至 1000');
    return clone(insert('exams', { teacher_id: tid, class_id: c.id, title, subject: str(body.subject, 20), full_mark: full, exam_date: str(body.exam_date, 10) }));
  });
  on('DELETE', '/exams/:id', ({ tid, p }) => { own('exams', p.id, tid); S.exams = S.exams.filter(x => x.id !== p.id); S.exam_scores = S.exam_scores.filter(e => e.exam_id !== p.id); return { ok: true }; });
  on('GET', '/exams/:id/scores', ({ tid, p }) => { const x = own('exams', p.id, tid); return { exam: clone(x), scores: clone(S.exam_scores.filter(e => e.exam_id === x.id)) }; });
  on('PUT', '/exams/:id/scores', ({ tid, p, body }) => {
    const x = own('exams', p.id, tid);
    txn(() => { for (const e of body.scores || []) {
      const s = own('students', int(e.student_id), tid); if (s.class_id !== x.class_id) throw bad('學生不屬於此班');
      S.exam_scores = S.exam_scores.filter(r => !(r.exam_id === x.id && r.student_id === s.id));
      if (e.score === null || e.score === '') continue;
      const v = Number(e.score); if (!(v >= 0 && v <= x.full_mark)) throw bad(`${s.name} 的分數須在 0 至 ${x.full_mark} 之間`);
      S.exam_scores.push({ exam_id: x.id, student_id: s.id, score: v });
    } });
    return { ok: true };
  });

  // 與伺服器相同的登入介面（示範模式不檢查密碼強度以外的東西）
  let session = null;
  function auth(path, body) {
    if (path === '/auth/me') return { teacher: session && clone(S.teachers.find(t => t.id === session)) };
    if (path === '/auth/logout') { session = null; return { ok: true }; }
    if (path === '/auth/register') {
      const email = str(body.email).toLowerCase(); const name = str(body.name, 40);
      if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('請輸入有效電郵'); if (!name) throw bad('請輸入老師稱呼');
      if (String(body.password || '').length < 8) throw bad('密碼最少 8 個字元');
      if (S.teachers.some(t => t.email === email)) throw new HttpError(409, '此電郵已註冊');
      const t = insert('teachers', { email, name, password: String(body.password) }); seedTeacher(t.id); session = t.id;
      return { teacher: { id: t.id, email, name } };
    }
    if (path === '/auth/login') {
      const t = S.teachers.find(t => t.email === str(body.email).toLowerCase() && t.password === String(body.password || ''));
      if (!t) throw new HttpError(401, '電郵或密碼不正確'); session = t.id; return { teacher: { id: t.id, email: t.email, name: t.name } };
    }
    return undefined;
  }

  function handle(method, path, { tid, body = {}, query = {} } = {}) {
    for (const r of routes) {
      if (r.method !== method) continue; const m = path.match(r.re); if (!m) continue;
      const p = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
      return clone(r.fn({ tid, p, body: body || {}, q: query }));
    }
    throw new HttpError(404, '找不到此功能');
  }
  return {
    state: S, handle, HttpError,
    async request(method, path, body) {
      const [p, qs] = path.split('?');
      const a = auth(p, body || {}); if (a !== undefined) return clone(a);
      if (!session) throw new HttpError(401, '請先登入');
      return handle(method, p, { tid: session, body, query: Object.fromEntries(new URLSearchParams(qs || '')) });
    },
    loginAs(id) { session = id; },
  };
}
