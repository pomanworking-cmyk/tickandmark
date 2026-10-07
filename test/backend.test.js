// 後端驗收測試：同一套情境分別跑「真伺服器 + SQLite」及「預覽用示範後端」，並比較兩者結果一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createServer } from '../server/server.js';
import { openTurso } from '../server/db-turso.js';
import { startTursoMock } from './turso-mock.js';
import { createDemoBackend } from '../public/js/demo-backend.js';
import { SPECIES_KEYS, STAGES, petImageUrl, DEFAULT_THRESHOLDS } from '../public/shared/pet-logic.js';

const ROOT = new URL('../public/', import.meta.url);

async function serverClient(opts = {}) {
  const srv = createServer({ dbFile: ':memory:', allowRegistration: true, ...opts });
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
    const hs = await c.req('PUT', '/settings', { thresholds: DEFAULT_THRESHOLDS, hunger_days: 2 }); assert.equal(hs.hunger_days, 2);
    assert.equal((await c.req('GET', '/bootstrap')).hunger_days, 2);
    await assert.rejects(c.req('PUT', '/settings', { thresholds: DEFAULT_THRESHOLDS, hunger_days: 99 }), /0 至 30/);
    const fedPet = (await c.req('GET', `/students/${pre.id}`)).student.pet;
    assert.ok(fedPet.last_fed_at, '有加分的寵物記錄最後餵食時間');

    // 功課及考試
    const hw = await c.req('POST', `/classes/${classes['4A'].id}/homework`, { title: '中文作文', subject: '中文', due_date: '2026-10-09' });
    await c.req('PUT', `/homework/${hw.id}/submissions`, { entries: [{ student_id: S['4A'][0].id, status: 'submitted' }, { student_id: S['4A'][1].id, status: 'missing' }] });
    const hwl = await c.req('GET', `/classes/${classes['4A'].id}/homework`);
    assert.equal(hwl[0].submitted, 1); assert.equal(hwl[0].missing, 1);
    const ex = await c.req('POST', `/classes/${classes['4A'].id}/exams`, { title: '上學期測驗', subject: '數學', full_mark: 100, exam_date: '2026-10-05' });
    await c.req('PUT', `/exams/${ex.id}/scores`, { scores: [{ student_id: S['4A'][0].id, score: 88 }, { student_id: S['4A'][1].id, score: 72.5 }] });
    await assert.rejects(c.req('PUT', `/exams/${ex.id}/scores`, { scores: [{ student_id: S['4A'][0].id, score: 120 }] }), /0 至 100/);
    const miss = await c.req('GET', `/classes/${classes['4A'].id}/missing-homework`);
    assert.deepEqual(miss.map(m => [m.student_id, m.title]), [[S['4A'][1].id, '中文作文']], '欠交功課清單');
    L('missing', miss);
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

    // 點名
    const c4a = classes['4A'].id;
    let att = await c.req('PUT', `/classes/${c4a}/attendance`, { date: '2026-10-07', absent: [a4ids[2], a4ids[3]] });
    assert.deepEqual(att.absent, [a4ids[2], a4ids[3]].sort((x, y) => x - y));
    assert.deepEqual((await c.req('GET', `/classes/${c4a}/attendance?date=2026-10-07`)).absent, att.absent);
    assert.deepEqual((await c.req('GET', `/classes/${c4a}/attendance?date=2026-10-08`)).absent, []);
    await assert.rejects(c.req('GET', `/classes/${c4a}/attendance?date=7-10`), /日期/);
    await assert.rejects(c.req('PUT', `/classes/${c4a}/attendance`, { date: '2026-10-07', absent: [S['4B'][0].id] }), /不屬於此班/);

    // 全班合作目標：只計開始後的正向加分，撤銷會扣回
    let goal = await c.req('POST', `/classes/${c4a}/goal`, { title: '全班看電影', target: 10 });
    assert.equal(goal.progress, 0); assert.equal(goal.goal.target, 10);
    await c.req('POST', '/points', { class_id: c4a, student_ids: [a4ids[4], a4ids[5]], delta: 3, client_batch_id: 'goal-1' });
    const gneg = await c.req('POST', '/points', { class_id: c4a, student_ids: [a4ids[4]], delta: -2, client_batch_id: 'goal-2' });
    goal = await c.req('GET', `/classes/${c4a}/goal`); assert.equal(goal.progress, 6, '扣分不減全班目標');
    const g3 = await c.req('POST', '/points', { class_id: c4a, student_ids: [a4ids[6]], delta: 4, client_batch_id: 'goal-3' });
    await c.req('POST', `/batches/${g3.batch_id}/undo`);
    goal = await c.req('GET', `/classes/${c4a}/goal`); assert.equal(goal.progress, 6, '撤銷的加分不計');
    await assert.rejects(c.req('POST', `/classes/${c4a}/goal`, { title: '', target: 10 }), /目標獎勵/);
    goal = await c.req('POST', `/classes/${c4a}/goal`, { title: '全班旅行', target: 50 }); assert.equal(goal.progress, 0, '新目標重新計');
    goal = await c.req('DELETE', `/classes/${c4a}/goal`); assert.equal(goal.goal, null);
    L('goal-neg', gneg.results[0].score);

    // 獎勵兌換：扣可用分數，總分及寵物 XP 不變
    assert.equal(boot.rewards.length, 4);
    const rich = (await c.req('GET', `/students/${a4ids[0]}`)).student;
    const sticker = boot.rewards.find(r => r.cost === 5); const big = boot.rewards.find(r => r.cost === 20);
    const red = await c.req('POST', '/redemptions', { student_id: rich.id, reward_id: sticker.id });
    assert.equal(red.student.score, rich.score, '總分不變'); assert.equal(red.student.spent, 5); assert.equal(red.student.pet.xp, rich.pet.xp, '寵物 XP 不變');
    const poor = (await c.req('GET', `/students/${a4ids[8]}`)).student;
    if (poor.score - poor.spent < 20) await assert.rejects(c.req('POST', '/redemptions', { student_id: poor.id, reward_id: big.id }), /不夠兌換/);
    const und = await c.req('POST', `/redemptions/${red.redemption_id}/undo`); assert.equal(und.student.spent, 0);
    await assert.rejects(c.req('POST', `/redemptions/${red.redemption_id}/undo`), /已撤銷/);
    let rw = await c.req('POST', '/rewards', { title: '玩桌遊', cost: 30, icon: '🎲' }); assert.equal(rw.length, 5);
    rw = await c.req('PATCH', `/rewards/${rw.find(r => r.title === '玩桌遊').id}`, { cost: 25 }); assert.equal(rw.find(r => r.title === '玩桌遊').cost, 25);
    rw = await c.req('DELETE', `/rewards/${rw.find(r => r.title === '玩桌遊').id}`); assert.equal(rw.length, 4);
    L('redemptions', (await c.req('GET', `/classes/${c4a}/redemptions`)).map(r => [r.name, r.title, r.cost, !!r.undone_at]));

    // 重新分組
    const rg = await c.req('PUT', `/classes/${c4a}/regroup`, { groups: [{ name: '第1組', color: '#ffa3ba', student_ids: a4ids.slice(0, 4) }, { name: '第2組', student_ids: a4ids.slice(4) }] });
    assert.equal(rg.groups.length, 2); assert.equal(rg.students.filter(x => x.group_id === rg.groups[0].id).length, 4);
    await assert.rejects(c.req('PUT', `/classes/${c4a}/regroup`, { groups: [{ name: 'A', student_ids: [a4ids[0]] }, { name: 'B', student_ids: [a4ids[0]] }] }), /兩組/);
    L('regroup', rg.groups.map(g => [g.id, g.name, g.color]));

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

    // 管理員：第一位老師（A）是管理員；只見帳戶、使用時間及班別，見不到密碼或學生
    const adm = await c.req('GET', '/admin/teachers');
    assert.equal(adm.teachers.length, 2);
    const ta = adm.teachers.find(t => t.email === 'chan@school.hk');
    assert.equal(ta.is_admin, true); assert.deepEqual(ta.classes.map(x => x.name), ['4A', '4B', '5C']);
    assert.ok(ta.last_login_at && ta.last_seen_at, '有最後登入及使用時間');
    const raw = JSON.stringify(adm);
    assert.ok(!/password|scrypt|陳大文|token/.test(raw), '管理員資料不含密碼、工作階段或學生姓名');
    L('admin', adm.teachers.map(t => [t.name, t.is_admin, t.class_count, t.student_count, t.actions_7d, t.classes.map(x => [x.name, x.student_count])]));
    c.as('B');
    await assert.rejects(c.req('GET', '/admin/teachers'), /只限管理員/);
    assert.equal((await c.req('GET', '/auth/me')).teacher.is_admin, false);
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
      const l = c.db.raw.prepare('SELECT * FROM pet_xp_ledger LIMIT 1').get();
      c.db.raw.prepare('INSERT INTO pet_xp_ledger (score_event_id, pet_id, xp, stage_before, stage_after) VALUES (?,?,?,?,?)').run(l.score_event_id, l.pet_id, l.xp, 'egg', 'egg');
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
  const { openSqlite } = await import('../server/db-sqlite.js');
  const { initSchema } = await import('../server/db-common.js');
  const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE teachers (id INTEGER PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, created_at TEXT);
    CREATE TABLE classes (id INTEGER PRIMARY KEY, teacher_id INTEGER, name TEXT, school_year TEXT NOT NULL DEFAULT '', created_at TEXT);
    CREATE TABLE students (id INTEGER PRIMARY KEY, teacher_id INTEGER, class_id INTEGER, number INTEGER, name TEXT, group_id INTEGER, score INTEGER NOT NULL DEFAULT 0, created_at TEXT);
    INSERT INTO classes (id, teacher_id, name) VALUES (1, 1, '舊班');`);
  old.close();
  const adb = openSqlite(file); await initSchema(adb); const db = adb.raw;
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.ok(cols('classes').includes('seat_cols') && cols('students').includes('seat_row') && cols('students').includes('seat_col'));
  assert.equal(db.prepare('SELECT seat_cols FROM classes WHERE id = 1').get().seat_cols, 6);
  db.close();
});

test('寵物肚餓：只數上課日，加分後即飽', async () => {
  const { hungerLevel, schoolDaysBetween, hungerMessage } = await import('../public/shared/pet-logic.js');
  // 2026-10-09 是星期五；到下星期二（10-13）只隔 2 個上課日（一、二），周末不計
  assert.equal(schoolDaysBetween('2026-10-09T09:00:00+08:00', new Date('2026-10-13T10:00:00+08:00')), 2);
  const pet = { stage: 'baby', assigned_at: '2026-10-01T09:00:00+08:00', last_fed_at: '2026-10-09T09:00:00+08:00' };
  assert.equal(hungerLevel(pet, 3, new Date('2026-10-13T10:00:00+08:00')), 0);
  assert.equal(hungerLevel(pet, 3, new Date('2026-10-14T10:00:00+08:00')), 1);
  assert.equal(hungerLevel(pet, 3, new Date('2026-10-21T10:00:00+08:00')), 2);
  assert.equal(hungerLevel(pet, 0, new Date('2026-10-21T10:00:00+08:00')), 0, '0 = 關閉');
  assert.equal(hungerLevel({ ...pet, last_fed_at: null }, 3, new Date('2026-10-06T10:00:00+08:00')), 1, '未加過分就由派蛋日起計');
  assert.match(hungerMessage({ stage: 'egg' }, 2), /孵化/);
  assert.match(hungerMessage({ stage: 'adult' }, 2), /幫幫我/);
});

test('Turso 雲端資料庫（模擬 HTTP API）通過全部情境，結果與本機 SQLite 完全一致', async () => {
  const mock = await startTursoMock();
  const c = await serverClient({ db: openTurso({ url: mock.url, authToken: mock.token }) });
  try {
    const log = await scenario(c);
    assert.ok(globalThis.__serverLog, '需要先跑伺服器測試');
    assert.deepEqual(strip(log), strip(globalThis.__serverLog));
    assert.ok(mock.stats.requests > 100, '確實經 HTTP 存取資料庫');
  } finally { c.close(); mock.close(); }
});

test('Turso 交易：出錯時整筆回滾', async () => {
  const mock = await startTursoMock();
  const db = openTurso({ url: mock.url, authToken: mock.token });
  try {
    await db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    await db.tx(async () => { await db.run('INSERT INTO t (v) VALUES (?)', 'a'); await db.run('INSERT INTO t (v) VALUES (?)', 'b'); });
    await assert.rejects(db.tx(async () => { await db.run('INSERT INTO t (v) VALUES (?)', 'c'); await db.run('INSERT INTO t (v) VALUES (?)', null); }), /NOT NULL/);
    assert.deepEqual((await db.all('SELECT v FROM t ORDER BY id')).map(r => r.v), ['a', 'b']);
    const r = await db.get('INSERT INTO t (v) VALUES (?) RETURNING id, v', 'd'); assert.deepEqual(r, { id: 3, v: 'd' });
    assert.equal((await db.get('SELECT 1.5 AS f, NULL AS n, ? AS s', '中文')).s, '中文');
    await assert.rejects(openTurso({ url: mock.url, authToken: 'wrong' }).get('SELECT 1'), /401/);
  } finally { mock.close(); }
});

test('Netlify Function：登入、Cookie、防 CSRF、加分及管理員', async () => {
  const mock = await startTursoMock();
  process.env.TURSO_DATABASE_URL = mock.url; process.env.TURSO_AUTH_TOKEN = mock.token; process.env.REGISTRATION_CODE = 'school-2026';
  const { default: handler, config } = await import('../netlify/functions/api.mjs');
  assert.equal(config.path, '/api/*');
  const jar = {};
  const call = async (who, method, path, body) => {
    const res = await handler(new Request(`https://tick.example/api${path}`, { method, headers: { 'content-type': 'application/json', 'x-tm': '1', ...(jar[who] ? { cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined }), { ip: '1.2.3.4' });
    const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
    return { status: res.status, data: await res.json(), cookie: sc };
  };
  try {
    const reg = await call('A', 'POST', '/auth/register', { email: 'head@school.hk', name: '黃主任', password: 'secret-pass-1' });
    assert.equal(reg.status, 200); assert.equal(reg.data.teacher.is_admin, true); assert.match(reg.cookie, /HttpOnly/); assert.match(reg.cookie, /Secure/);
    assert.equal((await call('B', 'POST', '/auth/register', { email: 'b@school.hk', name: '何老師', password: 'secret-pass-2' })).status, 403, '冇註冊碼不能註冊');
    const rb = await call('B', 'POST', '/auth/register', { email: 'b@school.hk', name: '何老師', password: 'secret-pass-2', code: 'school-2026' });
    assert.equal(rb.status, 200); assert.equal(rb.data.teacher.is_admin, false);
    const cls = (await call('B', 'POST', '/classes', { name: '2C' })).data;
    const st = (await call('B', 'POST', `/classes/${cls.id}/students`, { students: [{ number: 1, name: '學生甲' }, { number: 2, name: '學生乙' }] })).data.created;
    await call('B', 'POST', '/pets/assign', { student_ids: st.map(x => x.id), species_key: 'water_koi' });
    const pts = (await call('B', 'POST', '/points', { class_id: cls.id, student_ids: [st[0].id], delta: 5, client_batch_id: 'n-1' })).data;
    assert.equal(pts.results[0].pet.stage, 'baby'); assert.equal(pts.results[0].pet.species_key, 'water_koi');
    // 防 CSRF
    const noHeader = await handler(new Request('https://tick.example/api/classes', { method: 'POST', headers: { cookie: jar.B }, body: '{}' }), {});
    assert.equal(noHeader.status, 403);
    // 私隱：A 看不到 B 的班
    assert.equal((await call('A', 'GET', `/classes/${cls.id}/full`)).status, 404);
    // 管理員
    const adm = await call('A', 'GET', '/admin/teachers');
    assert.equal(adm.status, 200);
    const b = adm.data.teachers.find(t => t.email === 'b@school.hk');
    assert.deepEqual(b.classes.map(x => [x.name, x.student_count]), [['2C', 2]]); assert.equal(b.actions_7d, 1); assert.ok(b.last_seen_at);
    assert.ok(!/password|scrypt|學生甲|token_hash/.test(JSON.stringify(adm.data)));
    assert.equal((await call('B', 'GET', '/admin/teachers')).status, 403);
    // 登入失敗限制
    for (let i = 0; i < 10; i++) await call('X', 'POST', '/auth/login', { email: 'b@school.hk', password: 'wrong' });
    assert.equal((await call('X', 'POST', '/auth/login', { email: 'b@school.hk', password: 'secret-pass-2' })).status, 429);
    assert.equal((await call('B', 'POST', '/auth/logout')).status, 200);
    assert.equal((await call('B', 'GET', '/classes')).status, 401);
  } finally { mock.close(); }
});
