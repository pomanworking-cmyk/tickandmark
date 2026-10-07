// 後端驗收測試：同一套情境分別跑「真伺服器 + SQLite」及「預覽用示範後端」，並比較兩者結果一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createServer } from '../server/server.js';
import { createDemoBackend } from '../public/js/demo-backend.js';
import { SPECIES_KEYS, STAGES, petImageUrl, DEFAULT_THRESHOLDS } from '../public/shared/pet-logic.js';

const ROOT = new URL('../public/', import.meta.url);

async function serverClient() {
  const srv = createServer({ dbFile: ':memory:', allowRegistration: true });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const jars = {}; let who = 'A';
  return {
    name: 'server', close: () => srv.close(), db: srv.db, base,
    as(n) { who = n; },
    async req(method, path, body, { raw = false, noCookie = false } = {}) {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-tm': '1', ...(jars[who] && !noCookie ? { cookie: jars[who] } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) jars[who] = sc.split(';')[0];
      const data = await res.json();
      if (raw) return { status: res.status, data };
      if (!res.ok) { const e = new Error(data.error); e.status = res.status; throw e; }
      return data;
    },
  };
}
function demoClient() {
  const be = createDemoBackend(); const sessions = {}; let who = 'A';
  return {
    name: 'demo', close() {}, as(n) { who = n; if (sessions[n]) be.loginAs(sessions[n]); },
    async req(method, path, body) {
      if (sessions[who]) be.loginAs(sessions[who]);
      const r = await be.request(method, path, body);
      if (path.startsWith('/auth/') && r.teacher) sessions[who] = r.teacher.id;
      return r;
    },
  };
}

// 可重現的隨機數，令兩個後端的「平均派蛋」結果相同
function seeded(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

async function scenario(c) {
  const log = [];
  const L = (k, v) => { log.push([k, v]); return v; };
  const realRandom = Math.random; Math.random = seeded(42);
  try {
    c.as('A'); await c.req('POST', '/auth/register', { email: 'chan@school.hk', name: '陳老師', password: 'password123' });
    c.as('B'); await c.req('POST', '/auth/register', { email: 'lee@school.hk', name: '李老師', password: 'password123' });
    c.as('A');
    const boot = await c.req('GET', '/bootstrap');
    const tagPlus = boot.tags.find(t => t.points === 2); const tagMinus = boot.tags.find(t => t.points < 0);
    const classes = {};
    for (const n of ['4A', '4B', '5C']) classes[n] = await c.req('POST', '/classes', { name: n, school_year: '2026-27' });
    // 匯入（含舊分數）
    const names = { '4A': ['陳大文', '李小明', '黃美玲', '張家豪', '何詠琪', '林子軒', '吳嘉欣', '鄭浩然', '梁曉晴'],
      '4B': ['周天佑', '馮凱琳', '蔡志明', '鄧雅雯', '許俊傑', '曾慧敏', '彭啟聰', '蕭嘉怡'], '5C': ['郭家樂', '羅思穎', '謝浩霖', '韓美琪'] };
    const S = {};
    for (const [cn, list] of Object.entries(names)) {
      const r = await c.req('POST', `/classes/${classes[cn].id}/students`, { students: list.map((name, i) => ({ number: i + 1, name, score: i % 3 === 0 ? 12 : 0 })) });
      S[cn] = r.created;
    }
    L('imported-scores', S['4A'].map(s => s.score));

    // 派蛋前的加分：不計入日後的寵物 XP
    const pre = S['4A'][0];
    await c.req('POST', '/points', { class_id: classes['4A'].id, student_ids: [pre.id], delta: 3, client_batch_id: 'pre-1' });

    // 派蛋：4A 平均分配；4B 每人指定一款（八款都有）；5C 第一位土熊
    const a4 = await c.req('POST', '/pets/assign', { student_ids: S['4A'].map(s => s.id), species_key: 'balanced' });
    L('4A-species', a4.created.map(s => s.pet.species_key));
    for (let i = 0; i < S['4B'].length; i++) await c.req('POST', '/pets/assign', { student_ids: [S['4B'][i].id], species_key: SPECIES_KEYS[i] });
    await c.req('POST', '/pets/assign', { student_ids: [S['5C'][0].id], species_key: 'earth_bear' });
    const again = await c.req('POST', '/pets/assign', { student_ids: [S['5C'][0].id], species_key: 'fire_fox' });
    assert.equal(again.skipped, 1, '已有寵物的學生不可再派蛋');

    let full = await c.req('GET', `/classes/${classes['4A'].id}/full`);
    let preStu = full.students.find(s => s.id === pre.id);
    assert.equal(preStu.pet.xp, 0, '派蛋前的分數不計入 XP'); assert.equal(preStu.pet.stage, 'egg');
    assert.equal(preStu.score, 15, '舊分數保留（12 + 3）');

    // 加分 → XP；同一 client_batch_id 重送不重複計算
    const r1 = await c.req('POST', '/points', { class_id: classes['4A'].id, student_ids: [pre.id], delta: 2, client_batch_id: 'b-1' });
    L('r1', r1.results.map(x => [x.delta, x.xp_gained, x.pet.stage, x.pet.xp]));
    const r1b = await c.req('POST', '/points', { class_id: classes['4A'].id, student_ids: [pre.id], delta: 2, client_batch_id: 'b-1' });
    assert.equal(r1b.replayed, true); assert.equal(r1b.results[0].pet.xp, 2); assert.equal(r1b.results[0].score, 17);

    // 扣分不倒退
    const r2 = await c.req('POST', '/points', { class_id: classes['4A'].id, student_ids: [pre.id], tag_id: tagMinus.id, client_batch_id: 'b-2' });
    assert.equal(r2.results[0].xp_gained, 0); assert.equal(r2.results[0].pet.xp, 2); assert.equal(r2.results[0].score, 16);

    // 孵化：再 +3 → XP 5 → 寶寶
    const r3 = await c.req('POST', '/points', { class_id: classes['4A'].id, student_ids: [pre.id], delta: 3, client_batch_id: 'b-3' });
    assert.equal(r3.results[0].pet.stage, 'baby'); assert.equal(r3.results[0].leveled_up, true);
    assert.equal(r3.results[0].pet.species_key, a4.created[0].pet.species_key, '孵化後品種不變');
    L('r3', r3.results[0]);

    // 小組加分（標籤 +2），然後撤銷：XP 扣回，階段不倒退
    const grp = await c.req('POST', `/classes/${classes['4A'].id}/groups`, { name: '藍隊', color: '#3a7bd5' });
    await c.req('PUT', `/groups/${grp.id}/members`, { student_ids: S['4A'].slice(0, 3).map(s => s.id) });
    const g1 = await c.req('POST', '/points', { class_id: classes['4A'].id, student_ids: S['4A'].slice(0, 3).map(s => s.id), tag_id: tagPlus.id, client_batch_id: 'g-1' });
    assert.deepEqual(g1.results.map(r => r.xp_gained), [2, 2, 2]);
    assert.equal(g1.results[0].pet.xp, 7);
    const u = await c.req('POST', `/batches/${g1.batch_id}/undo`);
    assert.equal(u.undone, true); assert.equal(u.results[0].pet.xp, 5); assert.equal(u.results[0].pet.stage, 'baby');
    await assert.rejects(c.req('POST', `/batches/${g1.batch_id}/undo`), /已撤銷/);
    // 撤銷後再撤銷到蛋門檻以下：r3 撤銷 → XP 2 但仍是寶寶（不倒退）
    const u3 = await c.req('POST', `/batches/${r3.batch_id}/undo`);
    assert.equal(u3.results[0].pet.xp, 2); assert.equal(u3.results[0].pet.stage, 'baby');

    // 土熊個案：5C 第一位，蛋 → 寶寶，圖片一定是 earth_bear
    const bear = S['5C'][0];
    let bf = (await c.req('GET', `/students/${bear.id}`)).student;
    assert.equal(petImageUrl(bf.pet), 'assets/pets/earth_bear/egg.webp');
    const rb = await c.req('POST', '/points', { class_id: classes['5C'].id, student_ids: [bear.id], delta: 5, client_batch_id: 'bear-1' });
    assert.equal(petImageUrl(rb.results[0].pet), 'assets/pets/earth_bear/baby.webp');

    // 只可在蛋階段更換品種
    await assert.rejects(c.req('PATCH', `/pets/${rb.results[0].pet.id}`, { species_key: 'fire_fox' }), /已孵化/);
    const b4 = (await c.req('GET', `/classes/${classes['4B'].id}/full`)).students;
    const changed = await c.req('PATCH', `/pets/${b4[0].pet.id}`, { species_key: 'water_koi', nickname: '小錦' });
    assert.equal(changed.pet.species_key, 'water_koi'); assert.equal(changed.pet.nickname, '小錦');
    await c.req('PATCH', `/pets/${b4[0].pet.id}`, { species_key: 'fire_fox' });

    // 4B：八款各自推到五個階段，逐張核對圖片
    const seen = {};
    for (let i = 0; i < 8; i++) {
      const s = b4[i];
      const steps = [0, 5, 15, 30, 50]; // 累積 0, 5, 20, 50, 100
      for (let k = 0; k < 5; k++) {
        let pet;
        if (steps[k]) pet = (await c.req('POST', '/points', { class_id: classes['4B'].id, student_ids: [s.id], delta: steps[k], client_batch_id: `sp-${i}-${k}` })).results[0].pet;
        else pet = (await c.req('GET', `/students/${s.id}`)).student.pet;
        assert.equal(pet.species_key, SPECIES_KEYS[i]); assert.equal(pet.stage, STAGES[k]);
        const url = petImageUrl(pet); assert.equal(url, `assets/pets/${SPECIES_KEYS[i]}/${STAGES[k]}.webp`);
        seen[url] = (seen[url] || 0) + 1;
      }
    }
    assert.equal(Object.keys(seen).length, 40, '八款 × 五階段 = 40 張圖全部用到');

    // 門檻：調低會升級；調高不會令寵物倒退
    const t1 = await c.req('PUT', '/settings', { thresholds: { baby: 1, junior: 2, adult: 12, evolved: 30 } });
    assert.equal(t1.upgraded, 2, '調低門檻：陳大文及土熊升級');
    const t2 = await c.req('PUT', '/settings', { thresholds: { baby: 50, junior: 100, adult: 200, evolved: 400 } });
    assert.equal(t2.upgraded, 0);
    full = await c.req('GET', `/classes/${classes['4A'].id}/full`);
    preStu = full.students.find(s => s.id === pre.id);
    assert.equal(preStu.pet.stage, 'junior', '調高門檻後不倒退');
    await assert.rejects(c.req('PUT', '/settings', { thresholds: { baby: 10, junior: 5, adult: 20, evolved: 30 } }), /由小至大/);
    await c.req('PUT', '/settings', { thresholds: DEFAULT_THRESHOLDS });

    // 功課及考試
    const hw = await c.req('POST', `/classes/${classes['4A'].id}/homework`, { title: '中文作文', subject: '中文', due_date: '2026-10-09' });
    await c.req('PUT', `/homework/${hw.id}/submissions`, { entries: [{ student_id: S['4A'][0].id, status: 'submitted' }, { student_id: S['4A'][1].id, status: 'missing' }] });
    const hwl = await c.req('GET', `/classes/${classes['4A'].id}/homework`);
    assert.equal(hwl[0].submitted, 1); assert.equal(hwl[0].missing, 1);
    const ex = await c.req('POST', `/classes/${classes['4A'].id}/exams`, { title: '上學期測驗', subject: '數學', full_mark: 100, exam_date: '2026-10-05' });
    await c.req('PUT', `/exams/${ex.id}/scores`, { scores: [{ student_id: S['4A'][0].id, score: 88 }, { student_id: S['4A'][1].id, score: 72.5 }] });
    await assert.rejects(c.req('PUT', `/exams/${ex.id}/scores`, { scores: [{ student_id: S['4A'][0].id, score: 120 }] }), /0 至 100/);
    const exl = await c.req('GET', `/classes/${classes['4A'].id}/exams`);
    assert.equal(exl[0].avg, 80.25);

    // 座位表：儲存、讀回、改每行座位數；重複座位及他班學生被拒
    const a4ids = S['4A'].map(s => s.id);
    const seated = await c.req('PUT', `/classes/${classes['4A'].id}/seats`, { cols: 5, seats: a4ids.map((id, i) => ({ student_id: id, row: Math.floor(i / 5), col: i % 5 })) });
    assert.equal(seated.class.seat_cols, 5);
    assert.deepEqual(seated.students.find(x => x.id === a4ids[6]) && [seated.students.find(x => x.id === a4ids[6]).seat_row, seated.students.find(x => x.id === a4ids[6]).seat_col], [1, 1]);
    await assert.rejects(c.req('PUT', `/classes/${classes['4A'].id}/seats`, { seats: [{ student_id: a4ids[0], row: 0, col: 0 }, { student_id: a4ids[1], row: 0, col: 0 }] }), /同一個座位/);
    await assert.rejects(c.req('PUT', `/classes/${classes['4A'].id}/seats`, { seats: [{ student_id: S['4B'][0].id, row: 3, col: 3 }] }), /不屬於此班/);
    await assert.rejects(c.req('PUT', `/classes/${classes['4A'].id}/seats`, { cols: 20, seats: [] }), /2 至 12/);
    const reread = await c.req('GET', `/classes/${classes['4A'].id}/full`);
    assert.equal(reread.students.filter(x => x.seat_row !== null).length, 9, '失敗的更改不會影響已儲存座位');
    L('seats', reread.students.map(x => [x.id, x.seat_row, x.seat_col]));

    // 常用功課範本：預設 4 個、新增、重複略過、刪除
    assert.equal(boot.homework_templates.length, 4, '新老師有 4 個預設常用功課');
    let tpl = await c.req('POST', '/homework-templates', { title: '英文閱讀報告', subject: '英文' });
    assert.equal(tpl.length, 5);
    tpl = await c.req('POST', '/homework-templates', { title: '英文閱讀報告', subject: '英文' });
    assert.equal(tpl.length, 5, '重複範本不會再加');
    tpl = await c.req('DELETE', `/homework-templates/${tpl.find(t => t.title === '中文作文').id}`);
    assert.equal(tpl.length, 4); assert.ok(!tpl.some(t => t.title === '中文作文'));
    await assert.rejects(c.req('POST', '/homework-templates', { title: '  ', subject: '中文' }), /功課名稱/);
    L('templates', tpl);

    // 跨班：不可把 4B 學生放進 4A 的加分
    await assert.rejects(c.req('POST', '/points', { class_id: classes['4A'].id, student_ids: [b4[0].id], delta: 1, client_batch_id: 'x-1' }), /不屬於此班/);

    // 私隱：B 老師看不到 A 的資料
    c.as('B');
    await assert.rejects(c.req('GET', `/classes/${classes['4A'].id}/full`), /找不到資料/);
    await assert.rejects(c.req('GET', `/students/${pre.id}`), /找不到資料/);
    await assert.rejects(c.req('POST', '/points', { class_id: classes['4A'].id, student_ids: [pre.id], delta: 1, client_batch_id: 'evil' }), /找不到資料/);
    assert.equal((await c.req('GET', '/classes')).length, 0);
    const bTpl = await c.req('GET', '/homework-templates');
    assert.ok(!bTpl.some(t => t.title === '英文閱讀報告'), '其他老師看不到我的常用功課');
    await assert.rejects(c.req('DELETE', `/homework-templates/${tpl[0].id}`), /找不到資料/);
    c.as('A');

    const audit = await c.req('GET', '/audit');
    assert.deepEqual(audit.problems, [], '資料一致性自我檢查');
    L('audit-pets', audit.pets);
    const recent = await c.req('GET', `/classes/${classes['4A'].id}/batches?limit=5`);
    L('recent', recent.map(b => [b.label, b.n, !!b.undone_at]));
    // 最終快照（去除時間欄位）
    for (const cn of Object.keys(classes)) {
      const f = await c.req('GET', `/classes/${classes[cn].id}/full`);
      L(`final-${cn}`, f.students.map(s => [s.id, s.name, s.score, s.pet && [s.pet.species_key, s.pet.stage, s.pet.xp, s.pet.baseline_event_id]]));
    }
    return log;
  } finally { Math.random = realRandom; }
}

const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (/_at$/.test(k) ? undefined : x)));

test('伺服器 + SQLite 通過全部情境', async () => {
  const c = await serverClient();
  try {
    const log = await scenario(c);
    // 未登入不能讀取
    const r = await c.req('GET', '/classes', null, { raw: true, noCookie: true });
    assert.equal(r.status, 401);
    // 沒有 x-tm 標頭的寫入被拒（防 CSRF）
    const res = await fetch(c.base + '/classes', { method: 'POST', body: '{}' });
    assert.equal(res.status, 403);
    // 資料庫層面：ledger 主鍵保證同一事件不能入帳兩次
    assert.throws(() => {
      const l = c.db.prepare('SELECT * FROM pet_xp_ledger LIMIT 1').get();
      c.db.prepare('INSERT INTO pet_xp_ledger (score_event_id, pet_id, xp, stage_before, stage_after) VALUES (?,?,?,?,?)').run(l.score_event_id, l.pet_id, l.xp, 'egg', 'egg');
    }, /UNIQUE|PRIMARY/);
    globalThis.__serverLog = log;
  } finally { c.close(); }
});

test('預覽示範後端與伺服器結果完全一致', async () => {
  const c = demoClient();
  const log = await scenario(c);
  assert.ok(globalThis.__serverLog, '需要先跑伺服器測試');
  assert.deepEqual(strip(log), strip(globalThis.__serverLog));
});

test('八款 × 五階段圖片全部存在、互不相同', () => {
  const hashes = new Set();
  for (const sp of SPECIES_KEYS) for (const st of STAGES) {
    const url = petImageUrl({ species_key: sp, stage: st });
    const buf = fs.readFileSync(new URL(url, ROOT));
    assert.ok(buf.length > 5000, `${url} 太小`);
    assert.equal(buf.subarray(8, 12).toString(), 'WEBP');
    hashes.add(crypto.createHash('sha1').update(buf).digest('hex'));
  }
  assert.equal(hashes.size, 40);
  assert.throws(() => petImageUrl({ species_key: 'dragon', stage: 'baby' }), /未知品種/);
  assert.throws(() => petImageUrl({ species_key: 'fire_fox', stage: 'super' }), /未知階段/);
  assert.equal(petImageUrl(null), null);
});

test('舊資料庫自動升級（加入座位欄位）', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { openDb } = await import('../server/db.js');
  const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE teachers (id INTEGER PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, created_at TEXT);
    CREATE TABLE classes (id INTEGER PRIMARY KEY, teacher_id INTEGER, name TEXT, school_year TEXT NOT NULL DEFAULT '', created_at TEXT);
    CREATE TABLE students (id INTEGER PRIMARY KEY, teacher_id INTEGER, class_id INTEGER, number INTEGER, name TEXT, group_id INTEGER, score INTEGER NOT NULL DEFAULT 0, created_at TEXT);
    INSERT INTO classes (id, teacher_id, name) VALUES (1, 1, '舊班');`);
  old.close();
  const db = openDb(file);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.ok(cols('classes').includes('seat_cols') && cols('students').includes('seat_row') && cols('students').includes('seat_col'));
  assert.equal(db.prepare('SELECT seat_cols FROM classes WHERE id = 1').get().seat_cols, 6);
  db.close();
});
