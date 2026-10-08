// Tick and Mark 前端（繁體中文單頁應用）
import { GET, POST, PUT, PATCH, DEL, uid, IS_DEMO } from './api.js';
import { esc, $, $$, avatar, dexImage, xpBar, petStatus, toast, openDialog, confirmBox, celebrate, ICON, fmtDate, fmtTime, signed } from './ui.js';
import { SPECIES, STAGES, STAGE_LABELS, speciesByKey, petLabel, progressInfo, hungerLevel, hungerMessage, schoolDaysBetween } from '../shared/pet-logic.js';
import { readFileToStudents, textToStudents, ocrImage } from './importer.js';

const app = document.getElementById('app');
const state = { teacher: null, boot: null, cls: null, classId: null, importRows: [], hwCache: null, absent: new Set(), attDate: '', goal: null, missing: new Map() };
const store = {
  get(k, d) { try { const v = localStorage.getItem('tm.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tm.' + k, JSON.stringify(v)); } catch { /* 私密瀏覽 */ } },
};
const room = {
  q: '', sort: store.get('sort', 'seats'), size: store.get('size', 'm'), multi: false, sel: new Set(), quick: store.get('quick', 'menu'),
  mode: 'points', pick: null, justDragged: 0, hwId: null, hwStatus: 'submitted', hwMap: new Map(), hwList: [], picked: new Map(), picking: false,
  get edit() { return this.mode === 'seats'; }, set edit(v) { this.mode = v ? 'seats' : 'points'; },
};
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
let ACT = {};
const go = (h) => { if (location.hash === h) route(); else location.hash = h; };
const thresholds = () => state.boot?.thresholds;
const students = () => state.cls?.students || [];
const groupOf = (s) => state.cls?.groups.find(g => g.id === s.group_id);
const fail = (e) => { if (e.status === 401) { state.teacher = null; go('#/login'); } toast(e.message, { error: true }); };

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el || !app.contains(el)) return;
  const fn = ACT[el.dataset.act]; if (!fn) return;
  e.preventDefault(); Promise.resolve(fn(el, e)).catch(fail);
});
app.addEventListener('submit', (e) => {
  const fn = ACT['submit:' + e.target.dataset.form]; if (!fn) return;
  e.preventDefault(); Promise.resolve(fn(e.target, new FormData(e.target))).catch(fail);
});
window.addEventListener('hashchange', () => route());

// ---------- 版面 ----------
const TABS = [['room', '課室'], ['students', '學生及分組'], ['homework', '功課'], ['exams', '考試'], ['history', '分數紀錄'], ['pets', '寵物'], ['poster', '海報']];
function shell(active, body, { wide = false } = {}) {
  const c = state.cls?.class;
  const classes = state.boot?.classes || [];
  app.innerHTML = `
    ${IS_DEMO ? '<div class="demo-banner">預覽示範：所有學生均為虛構，資料只存在此頁面，重新整理後會還原。</div>' : ''}
    <header class="topbar">
      <div class="topbar-row">
        <a class="brand" href="#/classes"><span class="brand-mark">${ICON.tick}</span><span class="brand-text">Tick and Mark</span></a>
        ${c ? `<select class="input class-switch" id="class-switch" aria-label="切換班別">${classes.map(x => `<option value="${x.id}"${x.id === c.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
        <span class="spacer"></span>
        ${state.teacher?.is_admin ? '<a class="btn ghost sm" href="#/admin">🛡️ 管理</a>' : ''}
        <a class="btn ghost sm" href="#/settings">設定</a>
      </div>
      ${c ? `<nav class="tabs">${TABS.map(([k, l]) => `<a class="tab" href="#/c/${c.id}/${k}"${k === active ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>` : ''}
    </header>
    <main class="${wide ? 'wide' : ''}">${body}</main>`;
  const sw = $('#class-switch');
  if (sw) sw.onchange = () => go(`#/c/${sw.value}/${active}`);
}

// ---------- 路由 ----------
let navSeq = 0; // 防止較慢的舊頁面在新頁面之後才畫出來
async function route() {
  const my = ++navSeq;
  // 載入新頁面期間，舊頁面變淡並暫停操作，免得老師撳咗冇反應
  const slow = setTimeout(() => { if (my === navSeq) document.body.classList.add('loading'); }, 150);
  document.body.dataset.route = 'busy';
  try { await routeInner(my); } finally { clearTimeout(slow); if (my === navSeq) { document.body.classList.remove('loading'); document.body.dataset.route = 'idle'; } }
}
async function routeInner(my) {
  ACT = {}; app.onclick = app.oninput = app.onchange = null;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (!state.teacher) {
      const me = await GET('/auth/me'); state.teacher = me.teacher;
    }
    if (!state.teacher) return renderLogin();
    if (parts[0] === 'login') return go('#/classes');
    if (!state.boot) state.boot = await GET('/bootstrap');
    if (parts[0] === 'c') {
      const id = Number(parts[1]);
      if (state.classId !== id || !state.cls) { const full = await GET(`/classes/${id}/full`); if (my !== navSeq) return; state.cls = full; state.classId = id; room.sel.clear(); room.mode = 'points'; room.pick = null; room.hwId = null; room.hwMap = new Map(); }
      const v = parts[2] || 'room';
      store.set('lastClass', id);
      if (v === 'room') { await loadRoomExtras(); if (my !== navSeq) return; }
      const views = { room: renderRoom, students: renderStudents, homework: renderHomework, exams: renderExams, history: renderHistory, pets: renderPets, poster: renderPoster };
      return await (views[v] || renderRoom)(parts[3] ? Number(parts[3]) : null);
    }
    if (parts[0] === 's') return await renderStudent(Number(parts[1]));
    if (parts[0] === 'settings') return renderSettings();
    if (parts[0] === 'admin') return await renderAdmin();
    return renderHome();
  } catch (e) {
    if (e.status === 404 && parts[0] === 'c') { state.classId = null; state.cls = null; toast(e.message, { error: true }); return go('#/classes'); }
    fail(e);
  }
}
async function loadRoomExtras() {
  const date = todayStr();
  const [att, goal, miss] = await Promise.all([GET(`/classes/${state.classId}/attendance?date=${date}`), GET(`/classes/${state.classId}/goal`), GET(`/classes/${state.classId}/missing-homework`)]);
  state.absent = new Set(att.absent); state.attDate = date; state.goal = goal; setMissing(miss);
}
function setMissing(rows) {
  state.missing = new Map();
  for (const r of rows) { if (!state.missing.has(r.student_id)) state.missing.set(r.student_id, []); state.missing.get(r.student_id).push(r); }
}
async function refreshMissing() {
  setMissing(await GET(`/classes/${state.classId}/missing-homework`));
  drawMissingPill(); drawRoomGrid();
}
const missingOf = (s) => state.missing.get(s.id) || [];
// 寵物提醒交功課的說話
function homeworkMessage(s, list = missingOf(s)) {
  if (!list.length) return '';
  const egg = s.pet?.stage === 'egg';
  if (list.length === 1) return egg ? `主人，交埋「${list[0].title}」我就快啲孵化喇！` : `主人，記得交「${list[0].title}」呀！📕`;
  return egg ? `主人，仲有 ${list.length} 份功課未交，我等緊你呀！` : `主人，仲有 ${list.length} 份功課未交呀！📕`;
}
const present = () => students().filter(s => !state.absent.has(s.id));
const hungerDays = () => state.boot?.hunger_days ?? 3;
const hungerOf = (s) => hungerLevel(s?.pet, hungerDays());
const hungryList = () => students().filter(s => hungerOf(s) > 0).sort((a, b) => hungerOf(b) - hungerOf(a) || byNumber(a, b));
function hungerBubble(s, big = false) {
  const lv = hungerOf(s); if (!lv) return '';
  if (big) {
    const n = schoolDaysBetween(s.pet.last_fed_at || s.pet.assigned_at);
    return `<div class="speech lv${lv}">${esc(hungerMessage(s.pet, lv))}<small>已經 ${n} 個上課日冇加分</small></div>`;
  }
  const egg = s.pet.stage === 'egg';
  return `<span class="hungry-bubble lv${lv}">${lv === 2 ? '幫幫我！' : egg ? '好凍～' : '肚餓～'}</span>`;
}
// 課室卡上的小氣泡：欠交功課及肚餓都有時輪流顯示
function petBubble(s) {
  if (!s.pet || state.absent.has(s.id)) return '';
  const hw = missingOf(s).length; const lv = hungerOf(s);
  const hwText = hw > 1 ? `${hw} 份功課未交📕` : '交功課呀📕';
  const hunger = lv ? (lv === 2 ? '幫幫我！' : s.pet.stage === 'egg' ? '好凍～' : '肚餓～') : '';
  if (hw && lv) return `<span class="hungry-bubble hw swap"><span class="a">${hwText}</span><span class="b">${hunger}</span></span>`;
  if (hw) return `<span class="hungry-bubble hw">${hwText}</span>`;
  return lv ? hungerBubble(s) : '';
}
// 操作完成時老師可能已轉咗頁／轉咗班：只更新仍然是同一班的資料，亦唔好畫返舊頁面
async function reloadClass() { const id = state.classId; if (!id) return; const full = await GET(`/classes/${id}/full`); if (state.classId === id) state.cls = full; }
const hashParts = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
const CLASS_VIEWS = ['room', 'students', 'homework', 'exams', 'history', 'pets', 'poster'];
function here(view, id) {
  const p = hashParts();
  if (CLASS_VIEWS.includes(view)) return p[0] === 'c' && Number(p[1]) === state.classId && !!state.cls && (p[2] || 'room') === view;
  if (view === 'student') return p[0] === 's' && Number(p[1]) === id;
  if (view === 'settings' || view === 'admin') return p[0] === view;
  return !['c', 's', 'settings', 'admin'].includes(p[0]);
}
async function reloadBoot() { state.boot = await GET('/bootstrap'); }

// ---------- 登入 ----------
function renderLogin() {
  const eggs = SPECIES.map(s => dexImage(s.key, 'egg')).join('');
  let mode = 'login';
  const draw = () => {
    app.innerHTML = `<div class="auth"><form class="auth-card" data-form="auth" autocomplete="on">
      <div class="auth-eggs" aria-hidden="true">${eggs}</div>
      <div style="text-align:center"><h1>Tick and Mark</h1><p class="muted" style="margin:4px 0 0">老師專用班級管理 · 學生資料只限登入老師查看</p></div>
      <div class="seg" role="tablist" style="justify-self:center">
        <button type="button" data-act="mode" data-v="login" aria-pressed="${mode === 'login'}">登入</button>
        <button type="button" data-act="mode" data-v="register" aria-pressed="${mode === 'register'}">新老師註冊</button>
      </div>
      ${mode === 'register' ? '<label class="field"><span>老師稱呼</span><input class="input" id="f-name" name="name" required maxlength="40" placeholder="例如：陳老師"></label>' : ''}
      <label class="field"><span>學校電郵</span><input class="input" id="f-email" name="email" type="email" required autocomplete="username" value="${IS_DEMO ? 'demo@tickandmark.hk' : ''}"></label>
      <label class="field"><span>密碼</span><input class="input" id="f-pw" name="password" type="password" required minlength="8" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" value="${IS_DEMO ? 'demo12345' : ''}"></label>
      ${mode === 'register' ? '<label class="field"><span>學校註冊碼（如有）</span><input class="input" id="f-code" name="code" autocomplete="off"></label>' : ''}
      <button class="btn primary" style="min-height:48px">${mode === 'login' ? '登入' : '建立帳戶'}</button>
      ${IS_DEMO ? '<p class="muted small" style="margin:0;text-align:center">示範帳戶已填好，直接按「登入」。</p>' : ''}
    </form></div>`;
  };
  ACT.mode = (el) => { mode = el.dataset.v; draw(); };
  ACT['submit:auth'] = async (_f, fd) => {
    const body = Object.fromEntries(fd);
    const r = await POST(mode === 'login' ? '/auth/login' : '/auth/register', body);
    state.teacher = r.teacher; state.boot = null;
    const last = store.get('lastClass', null);
    go(last ? `#/c/${last}/room` : '#/classes');
  };
  draw();
}

// ---------- 班別首頁 ----------
function renderHome() {
  if (!here('home')) return;
  state.cls = null; state.classId = null;
  const cs = state.boot.classes;
  shell(null, `
    <div class="page-head"><h1>${esc(state.teacher.name)}的班別</h1></div>
    <div class="class-grid">
      ${cs.map(c => `<div class="class-card">
        <div style="display:flex;align-items:baseline;gap:8px"><span class="name">${esc(c.name)}</span><span class="muted small">${esc(c.school_year)}</span></div>
        <div class="stats"><span><b>${c.student_count}</b> 位學生</span><span>寵物 <b>${c.pet_count}</b></span><span>總分 <b>${c.total_score}</b></span></div>
        <div class="row"><a class="btn primary" href="#/c/${c.id}/room">進入課室</a><a class="btn" href="#/c/${c.id}/students">管理學生</a></div>
      </div>`).join('')}
      <form class="class-card" data-form="newclass">
        <h2>新增班別</h2>
        <div class="row"><label class="field"><span>班別</span><input class="input" id="nc-name" name="name" required maxlength="30" placeholder="例如 4A"></label>
        <label class="field"><span>學年</span><input class="input" id="nc-year" name="school_year" placeholder="2026-27" value="2026-27"></label></div>
        <button class="btn blue">建立</button>
      </form>
    </div>
    ${cs.length ? '' : '<div class="empty"><strong>先建立第一個班別</strong>然後到「學生及分組」用 Excel、圖片或貼上名單匯入學生。</div>'}`);
  ACT['submit:newclass'] = async (_f, fd) => {
    const c = await POST('/classes', Object.fromEntries(fd)); await reloadBoot(); toast(`已建立 ${c.name}`); go(`#/c/${c.id}/students`);
  };
}

// ---------- 加減分 ----------
async function givePoints(ids, { delta, tag, reason, quick = false }) {
  const body = { class_id: state.classId, student_ids: [...ids], client_batch_id: uid(), ...(tag ? { tag_id: tag.id } : { delta, reason }) };
  const hungryBefore = new Set([...ids].filter(id => hungerOf(students().find(x => x.id === id)) > 0));
  let res;
  try { res = await POST('/points', body); }
  catch (e) { if (e.status === 0) res = await POST('/points', body); else throw e; } // 斷線重送：同一操作編號，不會重複加分
  for (const r of res.results) {
    const s = students().find(x => x.id === r.student_id);
    if (s) { s.score = r.score; s.pet = r.pet; }
  }
  const label = res.label;
  const d = res.results[0]?.delta ?? 0;
  const fed = new Set(res.results.filter(r => r.xp_gained > 0 && hungryBefore.has(r.student_id)).map(r => r.student_id));
  const remind = new Map(res.results.map(r => [r.student_id, homeworkMessage({ id: r.student_id, pet: r.pet }, state.missing.get(r.student_id) || [])]).filter(([, m]) => m));
  celebrate(res.results, { label, thresholds: thresholds(), quick, fed, remind });
  if (fed.size) drawHungryPill();
  const names = res.results.length > 3 ? `${res.results.length} 位同學` : res.results.map(r => r.name).join('、');
  toast(`${names} ${signed(d)}（${label}）`, { action: () => undoBatch(res.batch_id), actionLabel: '撤銷' });
  if (d > 0) refreshGoal().catch(() => {});
  return res;
}
async function undoBatch(id) {
  const r = await POST(`/batches/${id}/undo`);
  for (const x of r.results) { const s = students().find(s => s.id === x.student_id); if (s) { s.score = x.score; s.pet = x.pet; } }
  toast(`已撤銷：${r.label}`);
  refreshGoal().catch(() => {});
  if (location.hash.includes('/room')) { drawRoomGrid(); drawGroupRow(); } else route();
}

function pointSheet(ids) {
  const list = students().filter(s => ids.includes(s.id));
  const tags = state.boot.tags;
  const title = list.length === 1 ? list[0].name : `${list.length} 位同學`;
  const d = openDialog(`
    <div class="sheet-head">
      ${list.length === 1 ? avatar(list[0], 64) : ''}
      <div style="flex:1;min-width:0"><h2>${esc(title)}</h2>
        <div class="muted small">${list.length === 1 ? `${list[0].number ?? ''}號 · 現有 <b class="num">${list[0].score}</b> 分 · ${esc(petStatus(list[0].pet, thresholds()))}` : esc(list.map(s => s.name).join('、'))}</div></div>
      <button class="btn ghost" data-close aria-label="關閉">✕</button>
    </div>
    <div class="section-label">行為標籤</div>
    <div class="tag-grid">${tags.map(t => `<button class="tag-btn ${t.points > 0 ? 'pos' : 'neg'}" data-tag="${t.id}"><span class="ic">${esc(t.icon)}</span><span>${esc(t.label)}</span><span class="pt">${signed(t.points)}</span></button>`).join('')}</div>
    <div class="section-label">快速加減分</div>
    <div class="quick">${[1, 2, 3, 5].map(n => `<button class="btn pos" data-d="${n}">+${n}</button>`).join('')}${[-1, -2].map(n => `<button class="btn neg" data-d="${n}">${n}</button>`).join('')}</div>
    <form class="row" data-custom><label class="field"><span>自訂原因</span><input class="input" id="pt-reason" name="reason" maxlength="60" placeholder="例如：朗讀出色"></label>
      <label class="field" style="flex:0 0 100px"><span>分數</span><input class="input num" id="pt-delta" name="delta" type="number" min="-100" max="100" value="1" required></label>
      <button class="btn blue">給分</button></form>
    ${list.length === 1 ? `<div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn ghost sm" data-redeem>🎁 兌換獎勵（可用 ${list[0].score - (list[0].spent || 0)} 分）</button><a class="btn ghost sm" href="#/s/${list[0].id}">查看學生資料 →</a></div>` : ''}`);
  const done = async (opts) => {
    $$('button', d).forEach(b => { b.disabled = true; });
    try { await givePoints(ids, opts); d.close(); room.sel.clear(); room.multi = false; if ($('#room-grid')) renderRoom(); }
    catch (e) { fail(e); $$('button', d).forEach(b => { b.disabled = false; }); }
  };
  d.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tag]'); if (t) return done({ tag: tags.find(x => x.id === Number(t.dataset.tag)) });
    const q = e.target.closest('[data-d]'); if (q) return done({ delta: Number(q.dataset.d) });
    if (e.target.closest('[data-redeem]')) { d.close(); openRewards(ids[0]); }
  });
  d.querySelector('[data-custom]').addEventListener('submit', (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    const delta = Number(fd.get('delta')); if (!Number.isInteger(delta) || !delta) return toast('分數須為非零整數', { error: true });
    done({ delta, reason: String(fd.get('reason') || '') });
  });
}

// ---------- 課室模式 ----------
// room.sort = 'seats'（座位表）| 'number' | 'score' | 'name'
// room.quick = 'menu'（撳學生彈出選單）| 'd:2'（即時 +2）| 't:5'（即時用標籤 5）
const byNumber = (a, b) => (a.number ?? 999) - (b.number ?? 999) || a.id - b.id;
function filteredStudents() {
  const q = room.q.trim();
  let list = students().slice();
  if (q) list = /^\d+$/.test(q) ? list.filter(s => String(s.number ?? '').startsWith(q)) : list.filter(s => s.name.includes(q));
  if (room.sort === 'score') list.sort((a, b) => b.score - a.score || byNumber(a, b));
  else if (room.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  else list.sort(byNumber);
  return list;
}
// 座位表：已編位的學生留在原位；未編位（或超出每行座位數）的按班號填入空位
function seatLayout(cols) {
  const pos = new Map(); const taken = new Set();
  const list = students().slice().sort(byNumber);
  for (const s of list) {
    if (s.seat_row == null || s.seat_col == null || s.seat_col >= cols) continue;
    const k = `${s.seat_row},${s.seat_col}`; if (taken.has(k)) continue;
    pos.set(s.id, [s.seat_row, s.seat_col]); taken.add(k);
  }
  let i = 0;
  for (const s of list) {
    if (pos.has(s.id)) continue;
    while (taken.has(`${Math.floor(i / cols)},${i % cols}`)) i++;
    pos.set(s.id, [Math.floor(i / cols), i % cols]); taken.add(`${Math.floor(i / cols)},${i % cols}`);
  }
  const rows = Math.max(1, ...[...pos.values()].map(p => p[0] + 1));
  return { pos, rows, cols };
}
const seatCols = () => state.cls.class.seat_cols || 6;
function quickOpts() {
  const q = room.quick || 'menu';
  if (q.startsWith('d:')) return { delta: Number(q.slice(2)) };
  if (q.startsWith('t:')) { const tag = state.boot.tags.find(t => t.id === Number(q.slice(2))); return tag ? { tag } : null; }
  return null;
}
function quickBarHTML() {
  const q = room.quick || 'menu';
  const chip = (key, html, cls = '') => `<button class="qchip ${cls}" data-act="quick" data-q="${key}" aria-pressed="${q === key}">${html}</button>`;
  return `<span class="qlabel">撳學生即時：</span>
    ${chip('menu', '🗂 彈出選單')}
    ${[1, 2, 3].map(n => chip(`d:${n}`, `<b class="num">+${n}</b>`, 'pos')).join('')}
    ${chip('d:-1', '<b class="num">-1</b>', 'neg')}
    ${state.boot.tags.map(t => chip(`t:${t.id}`, `${esc(t.icon)} ${esc(t.label)} <b class="num">${signed(t.points)}</b>`, t.points > 0 ? 'pos' : 'neg')).join('')}`;
}
function seatEditBarHTML() {
  return `<span class="qlabel">編排座位：拖動學生到新位置，或先點一位學生再點另一位／空位</span>
    <span class="seg"><button data-act="cols" data-d="-1" aria-label="每行少一個座位">−</button><button disabled class="num">每行 ${seatCols()} 位</button><button data-act="cols" data-d="1" aria-label="每行多一個座位">＋</button></span>
    <button class="btn sm" data-act="reseat">按班號重新排</button>
    <button class="btn primary sm" data-act="seatdone">完成</button>`;
}
function drawQuickBar() {
  const bar = $('#quick-bar'); if (!bar) return;
  bar.className = 'quick-bar' + (room.mode !== 'points' ? ' editing' : '');
  bar.innerHTML = { points: quickBarHTML, seats: seatEditBarHTML, attend: attendBarHTML, hw: hwBarHTML }[room.mode]();
  const sel = $('#hw-pick', bar);
  if (sel) sel.onchange = () => { if (sel.value === 'new') { sel.value = room.hwId || ''; newHomeworkQuick(); } else selectHomework(Number(sel.value)).catch(fail); };
}
function drawGroupRow() {
  const box = $('#group-row'); if (!box) return;
  box.innerHTML = state.cls.groups.map(g => {
    const mem = students().filter(s => s.group_id === g.id);
    return `<span class="group-chip" style="--gc:${esc(g.color)}" data-act="group" data-id="${g.id}"><span class="dot"></span>${esc(g.name)} <span class="num muted">${mem.reduce((a, s) => a + s.score, 0)}</span><span class="plus" data-act="groupplus" data-id="${g.id}">+1</span></span>`;
  }).join('');
}
function renderRoom() {
  if (!here('room')) return;
  shell('room', `
    <div class="room-tools">
      <label class="search">${ICON.search}<input id="room-search" type="search" placeholder="班號或姓名，Enter 加分" autocomplete="off" value="${esc(room.q)}" aria-label="搜尋學生"></label>
      <select class="input" id="room-sort" style="width:auto" aria-label="排列">
        <option value="seats">座位表</option><option value="number">按班號</option><option value="score">按分數</option><option value="name">按姓名</option></select>
      <div class="seg" aria-label="大小">${['s', 'm', 'l'].map(z => `<button data-act="size" data-v="${z}" aria-pressed="${room.size === z}">${{ s: '小', m: '中', l: '大' }[z]}</button>`).join('')}</div>
      <button class="btn" data-act="multi" aria-pressed="${room.multi}">多選</button>
      <button class="btn" data-act="all">全班加分</button>
    </div>
    <div class="tool-row">
      <button class="tool" data-act="pickone">🎲 抽人</button>
      <button class="tool" data-act="timer">⏱ 計時</button>
      <button class="tool" data-act="noise">🔊 噪音計</button>
      <button class="tool" data-act="regroup">👥 分組</button>
      <button class="tool" data-act="rewards">🎁 兌換</button>
      <button class="tool" data-act="recent">🕘 最近操作</button>
      <button class="tool hungry-pill" data-act="hungry" id="hungry-pill" hidden></button>
      <button class="tool missing-pill" data-act="missinghw" id="missing-pill" hidden></button>
      <button class="goal-pill" data-act="goal" id="goal-pill"></button>
    </div>
    <div class="mode-tabs" role="tablist" aria-label="模式">${[['points', '⭐ 加分'], ['attend', '📋 點名'], ['hw', '📥 收功課'], ['seats', '🪑 編排座位']].map(([k, l]) => `<button class="mode-tab" role="tab" data-act="mode" data-m="${k}" aria-pressed="${room.mode === k}">${l}</button>`).join('')}</div>
    <div id="quick-bar" class="quick-bar"></div>
    ${state.cls.groups.length ? '<div class="group-row" id="group-row"></div>' : ''}
    <div id="room-grid"></div>
    <div id="selbar"></div>`, { wide: true });
  $('#room-sort').value = room.sort;
  const search = $('#room-search');
  search.addEventListener('input', () => { room.q = search.value; drawRoomGrid(); });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); // 防止 Enter 同時按下彈窗內的按鈕
    const list = filteredStudents();
    const exact = /^\d+$/.test(room.q.trim()) ? list.find(s => String(s.number) === room.q.trim()) : null;
    const pick = exact || (list.length === 1 ? list[0] : null);
    if (!pick) return;
    room.q = ''; search.value = '';
    const opts = quickOpts();
    if (opts) quickGive([pick.id]); else { pointSheet([pick.id]); drawRoomGrid(); }
  });
  $('#room-sort').onchange = (e) => { room.sort = e.target.value; store.set('sort', room.sort); drawRoomGrid(); };
  if (matchMedia('(pointer:fine)').matches) search.focus();

  ACT.size = (el) => { room.size = el.dataset.v; store.set('size', room.size); $$('[data-act=size]').forEach(b => b.setAttribute('aria-pressed', b === el)); drawRoomGrid(); };
  ACT.multi = (el) => { if (room.edit) return; room.multi = !room.multi; if (!room.multi) room.sel.clear(); el.setAttribute('aria-pressed', room.multi); drawRoomGrid(); };
  ACT.quick = (el) => { room.quick = el.dataset.q; store.set('quick', room.quick); drawQuickBar(); };
  ACT.all = () => { const ids = present().map(s => s.id); if (!ids.length) return toast('今日全班缺席？請檢查點名'); pointSheet(ids); };
  ACT.mode = (el) => setMode(el.dataset.m);
  ACT.pickone = () => pickOne();
  ACT.noise = () => openNoise();
  ACT.regroup = () => openRegroup();
  ACT.rewards = () => openRewards();
  ACT.goal = () => openGoal();
  ACT.hungry = () => openHungry();
  ACT.missinghw = () => openMissing();
  ACT.hwset = (el) => { room.hwStatus = el.dataset.v; drawQuickBar(); };
  ACT.hwnew = () => newHomeworkQuick();
  ACT.hwfill = (el) => hwFill(el.dataset.v);
  ACT.allpresent = () => saveAbsent(new Set());
  ACT.modedone = () => setMode('points');
  ACT.group = (el, e) => {
    if (e.target.closest('[data-act=groupplus]')) return;
    const ids = present().filter(s => s.group_id === Number(el.dataset.id)).map(s => s.id);
    if (!ids.length) return toast('此小組未有出席的組員');
    if (quickOpts()) quickGive(ids); else pointSheet(ids);
  };
  ACT.groupplus = async (el) => {
    const g = state.cls.groups.find(x => x.id === Number(el.dataset.id));
    const ids = present().filter(s => s.group_id === g.id).map(s => s.id);
    if (!ids.length) return toast('此小組未有出席的組員');
    await givePoints(ids, { delta: 1, reason: `${g.name} 小組加分` }); drawRoomGrid(); drawGroupRow();
  };
  ACT.stu = (el) => {
    const id = Number(el.dataset.id);
    if (room.mode === 'seats') return seatTap(id);
    if (room.mode === 'attend') return toggleAbsent(id);
    if (room.mode === 'hw') return markHw(id);
    if (room.multi) { room.sel.has(id) ? room.sel.delete(id) : room.sel.add(id); drawRoomGrid(); }
    else if (quickOpts()) quickGive([id]);
    else pointSheet([id]);
  };
  ACT.seatcell = (el) => {
    if (!room.edit || room.pick == null) return;
    moveSeat(room.pick, Number(el.dataset.r), Number(el.dataset.c));
  };
  ACT.selgo = () => { const ids = [...room.sel]; if (quickOpts()) { room.sel.clear(); room.multi = false; renderRoom(); quickGive(ids); } else pointSheet(ids); };
  ACT.selclear = () => { room.sel.clear(); drawRoomGrid(); };
  ACT.timer = () => openTimer();
  ACT.recent = () => recentDialog();
  ACT.seatdone = () => { setMode('points'); toast('座位已儲存'); };
  ACT.cols = (el) => {
    const cols = Math.min(12, Math.max(2, seatCols() + Number(el.dataset.d)));
    if (cols === seatCols()) return;
    saveSeats(seatLayout(cols).pos, cols);
  };
  ACT.reseat = async () => {
    if (!(await confirmBox('按班號由前排左邊開始重新排座位？', { ok: '重新排' }))) return;
    const cols = seatCols(); const pos = new Map();
    students().slice().sort(byNumber).forEach((s, i) => pos.set(s.id, [Math.floor(i / cols), i % cols]));
    saveSeats(pos, cols);
  };
  drawQuickBar(); drawGroupRow(); drawGoalPill(); drawHungryPill(); drawMissingPill(); drawRoomGrid();
}
function drawMissingPill() {
  const el = $('#missing-pill'); if (!el) return;
  const n = students().filter(s => missingOf(s).length).length; el.hidden = !n;
  el.innerHTML = `📕 欠交功課 <b class="num">${n}</b>`;
}
function openMissing() {
  const d = openDialog('<div id="ms-body"></div>');
  const draw = () => {
    const list = students().filter(s => missingOf(s).length).sort(byNumber);
    $('#ms-body', d).innerHTML = `<div class="sheet-head"><h2>📕 欠交功課</h2><button class="btn ghost" data-close>✕</button></div>
      <p class="muted small" style="margin-top:0">記錄為「欠交」的功課，寵物會喺課室提醒主人。學生補交後撳「已交」或「遲交」，提醒就會消失。</p>
      ${list.length ? `<div class="stack" style="gap:8px">${list.map(s => `<div class="status-row" style="align-items:flex-start">${avatar(s, 46)}<span class="who">${s.number ?? ''} ${esc(s.name)}
        <span class="ms-say">💬 ${esc(homeworkMessage(s))}</span>
        ${missingOf(s).map(m => `<span class="ms-item"><span>${esc(m.title)}${m.due_date ? ` <span class="muted small">限期 ${fmtDate(m.due_date)}</span>` : ''}</span>
          <span class="seg">${['submitted', 'late', 'excused'].map(k => `<button data-fix="${k}" data-h="${m.homework_id}" data-s="${s.id}">${HW_LABEL[k]}</button>`).join('')}</span></span>`).join('')}</span></div>`).join('')}</div>`
        : '<div class="empty">全部功課都交齊晒 🎉</div>'}`;
  };
  d.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-fix]'); if (!b) return;
    try {
      await PUT(`/homework/${b.dataset.h}/submissions`, { entries: [{ student_id: Number(b.dataset.s), status: b.dataset.fix }] });
      await refreshMissing(); if (room.hwId === Number(b.dataset.h)) await selectHomework(room.hwId);
      toast(`已記錄為「${HW_LABEL[b.dataset.fix]}」`); draw();
    } catch (err) { fail(err); }
  });
  draw();
}
function drawHungryPill() {
  const el = $('#hungry-pill'); if (!el) return;
  const n = hungryList().length; el.hidden = !n;
  el.innerHTML = `🍙 肚餓寵物 <b class="num">${n}</b>`;
}
function openHungry() {
  const list = hungryList();
  const d = openDialog(`<div class="sheet-head"><h2>🍙 肚餓寵物</h2><button class="btn ghost" data-close>✕</button></div>
    <p class="muted small" style="margin-top:0">${hungerDays()} 個上課日冇加分（周末唔計）嘅寵物會肚餓；${hungerDays() * 2} 日或以上會叫主人幫忙。學生只要得到加分就會即刻食飽。</p>
    ${list.length ? `<div class="stack" style="gap:6px">${list.map(s => `<div class="status-row">${avatar(s, 46)}<span class="who">${s.number ?? ''} ${esc(s.name)}<br><span class="small ${hungerOf(s) === 2 ? 'hungry-text2' : 'muted'}">${esc(hungerMessage(s.pet, hungerOf(s)))}・${schoolDaysBetween(s.pet.last_fed_at || s.pet.assigned_at)} 個上課日</span></span>
      ${state.absent.has(s.id) ? '<span class="chip">缺席</span>' : `<button class="btn sm" data-feed="${s.id}">+1 餵佢</button>`}</div>`).join('')}</div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" data-feedall>全部出席同學 +1</button></div>` : '<div class="empty">全部寵物都食飽晒 😋</div>'}`);
  d.addEventListener('click', async (e) => {
    const one = e.target.closest('[data-feed]'); const all = e.target.closest('[data-feedall]');
    if (!one && !all) return;
    const ids = one ? [Number(one.dataset.feed)] : list.filter(s => !state.absent.has(s.id)).map(s => s.id);
    if (!ids.length) return;
    d.close();
    try { await givePoints(ids, { delta: 1, reason: '照顧肚餓寵物', quick: true }); drawRoomGrid(); drawGroupRow(); drawHungryPill(); } catch (err) { fail(err); }
  });
}

// 一撳即加：直接給分並彈出祝賀畫面
let lastQuick = { id: '', at: 0 };
async function quickGive(ids) {
  const opts = quickOpts(); if (!opts) return pointSheet(ids);
  const key = ids.join(',') + '|' + room.quick; const now = Date.now(); // 同一動作、同一學生 350ms 內只算一次
  if (lastQuick.id === key && now - lastQuick.at < 350) return; // 防止手指誤觸兩次
  lastQuick = { id: key, at: now };
  ids.forEach(id => $(`.stu[data-id="${id}"]`)?.classList.add('bump'));
  try { await givePoints(ids, { ...opts, quick: true }); drawRoomGrid(); drawGroupRow(); }
  catch (e) { fail(e); }
}

// ---------- 座位編排 ----------
function seatTap(id) {
  if (Date.now() - (room.justDragged || 0) < 400) return;
  if (room.pick == null) { room.pick = id; drawRoomGrid(); return; }
  if (room.pick === id) { room.pick = null; drawRoomGrid(); return; }
  const target = seatLayout(seatCols()).pos.get(id);
  moveSeat(room.pick, target[0], target[1]);
}
function moveSeat(id, r, c) {
  const cols = seatCols(); const { pos } = seatLayout(cols);
  const from = pos.get(id); if (!from) return;
  const occupant = [...pos].find(([sid, p]) => sid !== id && p[0] === r && p[1] === c)?.[0];
  pos.set(id, [r, c]); if (occupant) pos.set(occupant, from); // 有人坐 → 兩人交換
  room.pick = null;
  saveSeats(pos, cols);
}
async function saveSeats(pos, cols) {
  for (const s of students()) { const p = pos.get(s.id); s.seat_row = p ? p[0] : null; s.seat_col = p ? p[1] : null; }
  state.cls.class.seat_cols = cols;
  drawQuickBar(); drawRoomGrid();
  try {
    const res = await PUT(`/classes/${state.classId}/seats`, { cols, seats: [...pos].map(([student_id, [row, col]]) => ({ student_id, row, col })) });
    state.cls = res; drawRoomGrid();
  } catch (e) { fail(e); await reloadClass(); drawQuickBar(); drawRoomGrid(); }
}
function bindSeatDrag(grid) {
  grid.onpointerdown = (e) => {
    if (!room.edit || e.button > 0) return;
    const card = e.target.closest('.stu'); if (!card) return;
    const id = Number(card.dataset.id); const sx = e.clientX; const sy = e.clientY;
    const rect = card.getBoundingClientRect(); const ox = sx - rect.left; const oy = sy - rect.top;
    let ghost = null; let over = null;
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
        ghost = card.cloneNode(true); ghost.classList.add('drag-ghost'); ghost.style.width = rect.width + 'px';
        document.body.appendChild(ghost); card.classList.add('dragging');
      }
      ev.preventDefault();
      ghost.style.left = (ev.clientX - ox) + 'px'; ghost.style.top = (ev.clientY - oy) + 'px';
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#room-grid [data-r]');
      if (el !== over) { over?.classList.remove('drop-over'); over = el; over?.classList.add('drop-over'); }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (!ghost) return;
      ghost.remove(); card.classList.remove('dragging'); over?.classList.remove('drop-over');
      room.justDragged = Date.now();
      if (over && ev.type === 'pointerup') moveSeat(id, Number(over.dataset.r), Number(over.dataset.c));
    };
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
}

function stuCard(s, rc) {
  const g = groupOf(s);
  const absent = state.absent.has(s.id);
  const hl = hungerOf(s);
  const cls = ['stu', room.sel.has(s.id) ? 'sel' : '', room.edit && room.pick === s.id ? 'picked' : '', absent ? 'absent' : '', hl ? `hungry h${hl}` : ''].filter(Boolean).join(' ');
  const hw = room.mode === 'hw' ? room.hwMap.get(s.id) : null;
  const badge = absent ? '<span class="ribbon absent">缺席</span>' : hw ? `<span class="ribbon hw-${hw}">${HW_LABEL[hw]}</span>` : '';
  return `<div class="${cls}" role="button" tabindex="0" data-act="stu" data-id="${s.id}"${rc ? ` data-r="${rc[0]}" data-c="${rc[1]}"` : ''} ${g ? `style="--gc:${esc(g.color)}"` : ''} aria-label="${esc(s.name)}，${s.score} 分">
    <span class="no">${s.number ?? ''}</span><span class="sc${s.score < 0 ? ' neg' : ''}">${s.score}</span>
    ${petBubble(s)}${avatar(s)}<span class="nm">${esc(s.name)}</span>${g ? '<span class="gbar"></span>' : ''}${badge}</div>`;
}
function drawRoomGrid() {
  const grid = $('#room-grid'); if (!grid) return;
  const seatMode = room.sort === 'seats' && !room.q.trim();
  if (!students().length) {
    grid.className = 'students-grid'; grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><strong>此班未有學生</strong><a href="#/c/${state.classId}/students">到「學生及分組」匯入名單</a></div>`;
  } else if (seatMode) {
    const { pos, rows, cols } = seatLayout(seatCols());
    const at = new Map([...pos].map(([id, p]) => [`${p[0]},${p[1]}`, id]));
    const byId = new Map(students().map(s => [s.id, s]));
    const totalRows = rows + (room.edit ? 1 : 0); let cells = '';
    for (let r = 0; r < totalRows; r++) for (let c = 0; c < cols; c++) {
      const sid = at.get(`${r},${c}`);
      cells += sid ? stuCard(byId.get(sid), [r, c]) : `<div class="seat-empty" data-act="seatcell" data-r="${r}" data-c="${c}" aria-label="空位"></div>`;
    }
    grid.className = `seat-scroll size-${room.size}`;
    grid.innerHTML = `<div class="seat-board" style="--cols:${cols}"><div class="front">講台 · 白板</div><div class="seats${room.edit ? ' editing' : ''}">${cells}</div></div>`;
  } else {
    const list = filteredStudents();
    grid.className = `students-grid size-${room.size}`;
    grid.innerHTML = list.length ? list.map(s => stuCard(s)).join('') : '<div class="empty" style="grid-column:1/-1"><strong>找不到相符的學生</strong>試試輸入班號或姓名中的一個字。</div>';
  }
  bindSeatDrag(grid);
  grid.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.act === 'stu') { e.preventDefault(); ACT.stu(e.target); } };
  const bar = $('#selbar');
  if (bar) bar.innerHTML = room.multi ? `<div class="selbar"><span>已選 <b class="num">${room.sel.size}</b> 位</span>
    <button class="btn sm" data-act="selclear">清除</button><button class="btn primary" data-act="selgo" ${room.sel.size ? '' : 'disabled'}>${quickOpts() ? '即時給分' : '給分'}</button></div>` : '';
}
async function recentDialog() {
  const rows = await GET(`/classes/${state.classId}/batches?limit=15`);
  const d = openDialog(`<div class="sheet-head"><h2>最近操作</h2><button class="btn ghost" data-close>✕</button></div>
    ${rows.length ? `<div class="stack" style="gap:6px">${rows.map(b => `<div class="status-row">
      <span class="chip ${b.delta > 0 ? 'good' : 'bad'} num">${signed(b.delta)}</span>
      <span class="who"><span>${esc(b.label)}</span><br><span class="muted small">${esc(b.names)} · ${fmtTime(b.created_at)}</span></span>
      ${b.undone_at ? '<span class="chip">已撤銷</span>' : `<button class="btn sm" data-undo="${b.id}">撤銷</button>`}</div>`).join('')}</div>` : '<div class="empty">今堂未有加減分</div>'}`);
  d.addEventListener('click', async (e) => {
    const u = e.target.closest('[data-undo]'); if (!u) return;
    const ok = await confirmBox('撤銷這次加減分？寵物 XP 會一併扣回，但寵物不會退化。', { ok: '撤銷' });
    if (!ok) return; d.close(); undoBatch(Number(u.dataset.undo)).catch(fail);
  });
}

// ---------- 課室模式切換 ----------
async function setMode(m) {
  room.mode = m; room.pick = null;
  if (m !== 'points') { room.multi = false; room.sel.clear(); }
  if (m === 'seats') { room.q = ''; room.sort = 'seats'; }
  if (m === 'hw') {
    await loadHwList();
    if (!room.hwId && room.hwList.length) await selectHomework(room.hwList[0].id);
  }
  renderRoom();
}

// ---------- 點名 ----------
function attendBarHTML() {
  const n = students().length; const a = students().filter(s => state.absent.has(s.id)).length;
  return `<span class="qlabel">點名（${esc(state.attDate)}）：撳學生標記缺席，再撳一次改返出席。缺席的同學不會被抽中，全班及小組加分亦會跳過。</span>
    <span class="chip good">出席 <b class="num">${n - a}</b>／${n}</span>${a ? `<span class="chip bad">缺席 <b class="num">${a}</b></span>` : ''}
    <button class="btn sm" data-act="allpresent">全部出席</button><button class="btn primary sm" data-act="modedone">完成</button>`;
}
function toggleAbsent(id) {
  const next = new Set(state.absent);
  next.has(id) ? next.delete(id) : next.add(id);
  saveAbsent(next);
}
async function saveAbsent(next) {
  const prev = state.absent; state.absent = next; drawQuickBar(); drawRoomGrid();
  try {
    if (state.attDate !== todayStr()) state.attDate = todayStr();
    const r = await PUT(`/classes/${state.classId}/attendance`, { date: state.attDate, absent: [...next] });
    state.absent = new Set(r.absent); drawQuickBar(); drawRoomGrid();
  } catch (e) { state.absent = prev; drawQuickBar(); drawRoomGrid(); fail(e); }
}

// ---------- 座位表收功課 ----------
const HW_LABEL = { submitted: '已交', late: '遲交', missing: '欠交', excused: '豁免' };
async function loadHwList() { room.hwList = await GET(`/classes/${state.classId}/homework`); }
async function selectHomework(id) {
  const r = await GET(`/homework/${id}/submissions`);
  room.hwId = id; room.hwMap = new Map(r.entries.map(e => [e.student_id, e.status]));
  drawQuickBar(); drawRoomGrid();
}
function hwBarHTML() {
  if (!room.hwList.length) return `<span class="qlabel">未有功課。先新增一份，就可以喺座位表逐個撳收功課。</span><button class="btn primary sm" data-act="hwnew">＋ 新功課</button><button class="btn sm" data-act="modedone">完成</button>`;
  const counts = Object.fromEntries(HW_STATUS.map(([k]) => [k, 0])); room.hwMap.forEach(v => { counts[v]++; });
  const none = students().length - room.hwMap.size;
  return `<select class="input" id="hw-pick" style="width:auto;max-width:260px" aria-label="選擇功課">
      ${room.hwList.map(h => `<option value="${h.id}"${h.id === room.hwId ? ' selected' : ''}>${esc(h.title)}${h.due_date ? `（${fmtDate(h.due_date)}）` : ''}</option>`).join('')}<option value="new">＋ 新功課…</option></select>
    <span class="qlabel">撳學生記為：</span>
    ${HW_STATUS.map(([k, l]) => `<button class="qchip hwc hw-${k}" data-act="hwset" data-v="${k}" aria-pressed="${room.hwStatus === k}">${l} <b class="num">${counts[k]}</b></button>`).join('')}
    <span class="chip">未記錄 <b class="num">${none}</b></span>
    <button class="btn sm" data-act="hwfill" data-v="missing">未記錄 → 欠交</button>
    ${state.absent.size ? '<button class="btn sm" data-act="hwfill" data-v="absent">缺席 → 豁免</button>' : ''}
    <button class="btn primary sm" data-act="modedone">完成</button>`;
}
async function markHw(id) {
  if (!room.hwId) return toast('請先選擇或新增功課', { error: true });
  const cur = room.hwMap.get(id); const status = cur === room.hwStatus ? null : room.hwStatus; // 再撳同一狀態 = 清除
  status ? room.hwMap.set(id, status) : room.hwMap.delete(id); drawQuickBar(); drawRoomGrid();
  try { await PUT(`/homework/${room.hwId}/submissions`, { entries: [{ student_id: id, status }] }); refreshMissing().catch(() => {}); }
  catch (e) { fail(e); await selectHomework(room.hwId); }
}
async function hwFill(kind) {
  const ids = kind === 'absent' ? students().filter(s => state.absent.has(s.id)).map(s => s.id) : students().filter(s => !room.hwMap.has(s.id) && !state.absent.has(s.id)).map(s => s.id);
  if (!ids.length) return toast('沒有需要更新的學生');
  const status = kind === 'absent' ? 'excused' : 'missing';
  await PUT(`/homework/${room.hwId}/submissions`, { entries: ids.map(student_id => ({ student_id, status })) });
  await selectHomework(room.hwId); await refreshMissing(); toast(`已把 ${ids.length} 位學生設為「${HW_LABEL[status]}」`);
}
function newHomeworkQuick() {
  const d = openDialog(`<div class="sheet-head"><h2>新增功課</h2><button class="btn ghost" data-close>✕</button></div>
    <div class="tpl-row">${(state.boot.homework_templates || []).map(t => `<span class="tpl"><button type="button" class="use" data-t="${t.id}">${esc(t.title)}${t.subject ? `<small>${esc(t.subject)}</small>` : ''}</button></span>`).join('')}</div>
    <form class="stack" data-f><label class="field"><span>功課名稱</span><input class="input" id="nh-title" name="title" required maxlength="60"></label>
      <div class="row"><label class="field"><span>科目</span><input class="input" id="nh-subj" name="subject" maxlength="20"></label>
      <label class="field"><span>限期</span><input class="input" id="nh-due" name="due_date" type="date" value="${todayStr()}"></label></div>
      <button class="btn primary">新增並開始收功課</button></form>`);
  d.addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b) return; const t = state.boot.homework_templates.find(x => x.id === Number(b.dataset.t)); $('#nh-title', d).value = t.title; $('#nh-subj', d).value = t.subject; });
  d.querySelector('[data-f]').onsubmit = async (e) => {
    e.preventDefault();
    try { const h = await POST(`/classes/${state.classId}/homework`, Object.fromEntries(new FormData(e.target))); d.close(); await loadHwList(); await selectHomework(h.id); toast(`已新增「${h.title}」`); }
    catch (err) { fail(err); }
  };
}

// ---------- 全班合作目標 ----------
function drawGoalPill() {
  const el = $('#goal-pill'); if (!el) return;
  const g = state.goal?.goal;
  if (!g) { el.innerHTML = '🏺 設定全班目標'; el.classList.remove('has'); return; }
  const pct = Math.min(100, Math.round(state.goal.progress / g.target * 100));
  el.classList.add('has');
  el.innerHTML = `🏺 <span class="gt">${esc(g.title)}</span> <b class="num">${state.goal.progress}／${g.target}</b><span class="mini"><i style="width:${pct}%"></i></span>`;
}
async function refreshGoal() {
  if (!state.goal?.goal) return;
  const before = state.goal.progress; const target = state.goal.goal.target;
  state.goal = await GET(`/classes/${state.classId}/goal`); drawGoalPill();
  if (before < target && state.goal.progress >= target) setTimeout(() => goalReached(), 1800);
}
function goalReached() {
  const g = state.goal.goal;
  const el = document.createElement('div'); el.className = 'celebrate goal-win';
  el.innerHTML = `<div class="cele-card"><div style="font-size:4rem">🏆</div><div class="who">全班達成目標！</div><div class="what">「${esc(g.title)}」・${state.goal.progress}／${g.target} 分</div>
    <div class="cele-multi">${present().filter(s => s.pet).slice(0, 12).map(s => `<div class="m">${avatar(s)}</div>`).join('')}</div></div>`;
  document.body.appendChild(el);
  const card = el.querySelector('.cele-card');
  for (let i = 0; i < 28; i++) { const sp = document.createElement('i'); sp.className = 'spark'; const a = Math.PI * 2 * i / 28; const dd = 140 + Math.random() * 120;
    sp.style.cssText = `left:50%;top:30%;--dx:${Math.cos(a) * dd}px;--dy:${Math.sin(a) * dd}px;background:${['var(--gold)', 'var(--accent)', 'var(--sky)', 'var(--mint)', 'var(--lav)'][i % 5]}`; card.appendChild(sp); }
  card.onclick = () => el.remove(); setTimeout(() => el.remove(), 5000);
}
function openGoal() {
  const g = state.goal?.goal; const n = present().length || students().length;
  const pct = g ? Math.min(100, Math.round(state.goal.progress / g.target * 100)) : 0;
  const d = openDialog(`<div class="sheet-head"><h2>全班合作目標</h2><button class="btn ghost" data-close>✕</button></div>
    ${g ? `<div class="jar-wrap"><div class="jar"><div class="fill" style="height:${pct}%"></div><div class="jar-num num">${pct}%</div></div>
      <div><div class="jar-title">${esc(g.title)}</div><p class="num" style="font-size:1.4rem;margin:6px 0"><b>${state.goal.progress}</b>／${g.target} 分</p>
      <p class="muted">${state.goal.progress >= g.target ? '已經達成！🎉' : `仲差 ${g.target - state.goal.progress} 分`}・只計目標開始後全班嘅加分，扣分唔會減少。</p>
      <button class="btn danger sm" data-end>結束目標</button></div></div><div class="section-label">改設新目標</div>` : '<p class="muted">全班一齊儲分，達成後一齊領獎勵。只計開始後嘅加分，扣分唔會減少進度。</p>'}
    <form class="row" data-f><label class="field"><span>獎勵</span><input class="input" id="goal-title" name="title" required maxlength="40" placeholder="例如：全班看電影"></label>
      <label class="field" style="flex:0 0 130px"><span>目標分數</span><input class="input num" id="goal-target" name="target" type="number" min="1" value="${Math.max(20, n * 5)}" required></label>
      <button class="btn primary">${g ? '開始新目標' : '開始'}</button></form>`);
  d.querySelector('[data-f]').onsubmit = async (e) => {
    e.preventDefault();
    try { state.goal = await POST(`/classes/${state.classId}/goal`, Object.fromEntries(new FormData(e.target))); d.close(); drawGoalPill(); toast('全班目標已開始'); } catch (err) { fail(err); }
  };
  d.querySelector('[data-end]')?.addEventListener('click', async () => {
    if (!(await confirmBox('結束這個全班目標？進度紀錄會保留在分數紀錄內。', { ok: '結束', danger: true }))) return;
    try { state.goal = await DEL(`/classes/${state.classId}/goal`); d.close(); drawGoalPill(); } catch (err) { fail(err); }
  });
}

// ---------- 隨機抽人 ----------
function pickedSet() { if (!room.picked.has(state.classId)) room.picked.set(state.classId, new Set()); return room.picked.get(state.classId); }
async function pickOne() {
  if (room.picking) return;
  const pool = present(); if (!pool.length) return toast('沒有出席的學生可以抽', { error: true });
  const used = pickedSet(); let cand = pool.filter(s => !used.has(s.id));
  if (!cand.length) { used.clear(); cand = pool; toast('全部同學都抽過一次，重新開始'); }
  const winner = cand[Math.floor(Math.random() * cand.length)]; used.add(winner.id);
  if (room.mode !== 'points') { room.mode = 'points'; renderRoom(); }
  const cards = cand.map(s => $(`.stu[data-id="${s.id}"]`)).filter(Boolean);
  room.picking = true;
  if (cards.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let delay = 55; let last = null;
    while (delay < 340) {
      const c = cards[Math.floor(Math.random() * cards.length)]; last?.classList.remove('spot'); c.classList.add('spot'); last = c;
      await new Promise(r => setTimeout(r, delay)); delay *= 1.13;
    }
    last?.classList.remove('spot');
  }
  const wc = $(`.stu[data-id="${winner.id}"]`); wc?.classList.add('spot'); wc?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  room.picking = false;
  showPickResult(winner, pool.length, used.size);
}
function showPickResult(s, total, done) {
  const q = quickOpts();
  const d = openDialog(`<div class="pick-result" data-pick="${s.id}">
      <div class="muted small">🎲 抽中咗！</div>${avatar(s, 170)}
      <h2 style="font-size:2rem">${s.number ?? ''} ${esc(s.name)}</h2>
      <div class="muted small">今堂已抽 ${done}／${total} 人（抽過嘅唔會再抽）</div>
      <div class="quick" style="justify-content:center">
        <button class="btn pos" data-d="1">+1</button><button class="btn pos" data-d="2">+2</button>
        ${q ? `<button class="btn pos" data-q>${q.tag ? `${esc(q.tag.icon)} ${esc(q.tag.label)}` : signed(q.delta)}</button>` : ''}
      </div>
      <div class="row" style="justify-content:center"><button class="btn primary" data-again>🎲 再抽一個</button><button class="btn sm" data-reset>重設抽過名單</button><button class="btn ghost sm" data-close>關閉</button></div>
    </div>`, { onClose: () => $(`.stu[data-id="${s.id}"]`)?.classList.remove('spot') });
  d.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-d],[data-q],[data-again],[data-reset]'); if (!b) return;
    if ('again' in b.dataset) { d.close(); return pickOne(); }
    if ('reset' in b.dataset) { pickedSet().clear(); d.close(); return toast('已重設，所有出席同學都可以再抽'); }
    d.close();
    try { await givePoints([s.id], 'q' in b.dataset ? { ...q, quick: true } : { delta: Number(b.dataset.d), reason: '抽中答問題', quick: true }); drawRoomGrid(); drawGroupRow(); }
    catch (err) { fail(err); }
  });
}

// ---------- 獎勵兌換 ----------
async function openRewards(preId = null) {
  let sid = preId; let q = '';
  const recent = await GET(`/classes/${state.classId}/redemptions`).catch(() => []);
  const d = openDialog('<div id="rw-body"></div>');
  const body = $('#rw-body', d);
  const avail = (s) => s.score - (s.spent || 0);
  const draw = () => {
    const rewards = state.boot.rewards || [];
    if (!sid) {
      const list = students().filter(s => !q || s.name.includes(q) || String(s.number) === q);
      body.innerHTML = `<div class="sheet-head"><h2>🎁 兌換獎勵</h2><button class="btn ghost" data-close>✕</button></div>
        <p class="muted small" style="margin-top:0">兌換會扣「可用分數」（總分 − 已兌換），總分紀錄同寵物 XP 都唔會變。</p>
        <input class="input" id="rw-q" placeholder="搜尋班號或姓名" value="${esc(q)}">
        <div class="rw-students">${list.map(s => `<button class="rw-stu" data-s="${s.id}">${avatar(s, 52)}<b>${esc(s.name)}</b><span class="num">可用 ${avail(s)}</span></button>`).join('')}</div>
        ${recent.length ? `<div class="section-label">最近兌換</div><div class="stack" style="gap:6px">${recent.slice(0, 8).map(r => `<div class="status-row"><span class="who">${esc(r.name)} · ${esc(r.title)} <span class="muted small">−${r.cost}・${fmtTime(r.created_at)}</span></span>${r.undone_at ? '<span class="chip">已撤銷</span>' : `<button class="btn sm" data-undo="${r.id}">撤銷</button>`}</div>`).join('')}</div>` : ''}`;
      const inp = $('#rw-q', body); inp.oninput = () => { q = inp.value.trim(); const pos = inp.selectionStart; draw(); const ni = $('#rw-q', body); ni.focus(); ni.setSelectionRange(pos, pos); };
    } else {
      const s = students().find(x => x.id === sid);
      body.innerHTML = `<div class="sheet-head">${avatar(s, 64)}<div style="flex:1;min-width:0"><h2>${esc(s.name)}</h2><div class="muted small">總分 ${s.score}・已兌換 ${s.spent || 0}・<b class="num" style="color:var(--good)">可用 ${avail(s)} 分</b></div></div><button class="btn ghost" data-close>✕</button></div>
        <div class="rw-grid">${rewards.map(r => `<button class="rw-item" data-r="${r.id}" ${avail(s) < r.cost ? 'disabled' : ''}><span class="ic">${esc(r.icon)}</span><b>${esc(r.title)}</b><span class="num">${r.cost} 分</span></button>`).join('') || '<p class="muted">未有獎勵，請到「設定」新增。</p>'}</div>
        <div style="margin-top:12px"><button class="btn ghost sm" data-back>← 揀其他同學</button></div>`;
    }
  };
  d.addEventListener('click', async (e) => {
    const st = e.target.closest('[data-s]'); if (st) { sid = Number(st.dataset.s); return draw(); }
    if (e.target.closest('[data-back]')) { sid = null; return draw(); }
    const un = e.target.closest('[data-undo]');
    if (un) {
      try { const r = await POST(`/redemptions/${un.dataset.undo}/undo`); const s = students().find(x => x.id === r.student.id); if (s) s.spent = r.student.spent;
        const rr = recent.find(x => x.id === Number(un.dataset.undo)); if (rr) rr.undone_at = 'now'; toast('已撤銷兌換'); draw(); } catch (err) { fail(err); }
      return;
    }
    const rb = e.target.closest('[data-r]'); if (!rb || rb.disabled) return;
    const reward = state.boot.rewards.find(r => r.id === Number(rb.dataset.r)); const s = students().find(x => x.id === sid);
    if (!(await confirmBox(`${s.name} 用 ${reward.cost} 分兌換「${reward.title}」？`, { ok: '兌換' }))) return;
    try {
      const r = await POST('/redemptions', { student_id: sid, reward_id: reward.id });
      s.spent = r.student.spent; recent.unshift({ id: r.redemption_id, name: s.name, title: r.title, cost: r.cost, created_at: new Date().toISOString(), undone_at: null });
      body.innerHTML = `<div class="pick-result">${avatar(s, 140)}<div style="font-size:2.6rem">${esc(r.icon)}</div><h2>${esc(s.name)} 兌換咗「${esc(r.title)}」</h2>
        <p class="muted">用咗 ${r.cost} 分・仲有 <b class="num">${avail(s)}</b> 分可以用</p><div class="row" style="justify-content:center"><button class="btn" data-back>再兌換</button><button class="btn primary" data-close>完成</button></div></div>`;
      sid = s.id;
    } catch (err) { fail(err); }
  });
  draw();
}

// ---------- 隨機分組 ----------
const GROUP_COLORS = ['#8cc4f5', '#ffa3ba', '#8ad9b4', '#ffd166', '#cbb8f5', '#ffb38a', '#9fe0e0', '#f5a3d8', '#b8d98a', '#c9c3ff'];
async function openRegroup() {
  let latest = null; // 最近一次考試成績，用於平均能力分組
  try { const ex = await GET(`/classes/${state.classId}/exams`); if (ex.length) { const r = await GET(`/exams/${ex[0].id}/scores`); latest = { title: ex[0].title, scores: new Map(r.scores.map(x => [x.student_id, x.score])) }; } } catch { /* 沒有成績 */ }
  let opts = { n: Math.min(6, Math.max(2, Math.round(students().length / 5))), method: 'random', presentOnly: state.absent.size > 0 };
  let plan = [];
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const build = () => {
    const pool = opts.presentOnly ? present() : students().slice(); const n = Math.min(opts.n, Math.max(1, pool.length));
    const groups = Array.from({ length: n }, () => []);
    if (opts.method === 'seat') {
      const { pos } = seatLayout(seatCols());
      const ordered = pool.slice().sort((a, b) => { const pa = pos.get(a.id); const pb = pos.get(b.id); return pa[0] - pb[0] || pa[1] - pb[1]; });
      const size = Math.ceil(ordered.length / n); ordered.forEach((s, i) => groups[Math.min(n - 1, Math.floor(i / size))].push(s));
    } else if (opts.method === 'ability' && latest) {
      // 蛇形分配：最高分 → 第1組… 再倒轉，令每組能力平均；未有成績的隨機放入
      const scored = shuffle(pool).sort((a, b) => (latest.scores.get(b.id) ?? -1) - (latest.scores.get(a.id) ?? -1));
      scored.forEach((s, i) => { const r = Math.floor(i / n); const k = i % n; groups[r % 2 ? n - 1 - k : k].push(s); });
    } else shuffle(pool).forEach((s, i) => groups[i % n].push(s));
    plan = groups.map((m, i) => ({ name: `第${i + 1}組`, color: GROUP_COLORS[i % GROUP_COLORS.length], members: m }));
  };
  build();
  const d = openDialog('<div id="rg-body"></div>');
  const body = $('#rg-body', d);
  const draw = () => {
    body.innerHTML = `<div class="sheet-head"><h2>👥 分組</h2><button class="btn ghost" data-close>✕</button></div>
      <div class="row" style="align-items:center">
        <label class="field" style="flex:0 0 110px"><span>組數</span><input class="input num" id="rg-n" type="number" min="2" max="10" value="${opts.n}"></label>
        <label class="field"><span>分法</span><select class="input" id="rg-m">
          <option value="random">隨機</option><option value="ability"${latest ? '' : ' disabled'}>平均能力${latest ? `（${esc(latest.title)}）` : '（未有考試成績）'}</option><option value="seat">按座位（就近）</option></select></label>
        <label class="check"><input type="checkbox" id="rg-p" ${opts.presentOnly ? 'checked' : ''}> 只分今日出席學生</label>
      </div>
      <div class="rg-groups">${plan.map(g => `<div class="rg-group" style="--gc:${g.color}"><div class="rg-name"><span class="dot"></span>${g.name} <span class="muted small">${g.members.length} 人</span></div>
        <div class="rg-members">${g.members.map(s => `<span class="rg-m">${avatar(s, 34)}${esc(s.name)}</span>`).join('')}</div></div>`).join('')}</div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-again>🔀 再分一次</button><button class="btn primary" data-apply>套用（取代現有小組）</button></div>`;
    $('#rg-m', body).value = opts.method;
    $('#rg-n', body).onchange = (e) => { opts.n = Math.min(10, Math.max(2, Number(e.target.value) || 2)); build(); draw(); };
    $('#rg-m', body).onchange = (e) => { opts.method = e.target.value; build(); draw(); };
    $('#rg-p', body).onchange = (e) => { opts.presentOnly = e.target.checked; build(); draw(); };
  };
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-again]')) { build(); draw(); }
    if (e.target.closest('[data-apply]')) {
      try {
        state.cls = await PUT(`/classes/${state.classId}/regroup`, { groups: plan.map(g => ({ name: g.name, color: g.color, student_ids: g.members.map(s => s.id) })) });
        d.close(); renderRoom(); toast(`已分成 ${plan.length} 組`);
      } catch (err) { fail(err); }
    }
  });
  draw();
}

// ---------- 浮動小窗口（計時、噪音計）：唔會遮住課室，可以一邊加分一邊用 ----------
function floatWin(id, title, body, { onClose, corner = 0 } = {}) {
  let w = document.getElementById(id);
  if (w) { w.classList.remove('min'); w.style.zIndex = String(++floatWin.z); w.animate?.([{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }], 250); return { el: w, fresh: false }; }
  w = document.createElement('div'); w.className = 'fw'; w.id = id; w.style.zIndex = String(++floatWin.z);
  w.innerHTML = `<div class="fw-head"><span class="fw-title">${title}</span>
      <button class="fw-btn" data-fw="min" title="縮細／放大" aria-label="縮細">▁</button>
      <button class="fw-btn" data-fw="fs" title="全螢幕（投影用）" aria-label="全螢幕">⛶</button>
      <button class="fw-btn" data-fw="close" title="關閉" aria-label="關閉">✕</button></div>
    <div class="fw-body">${body}</div>`;
  if (window.innerWidth < 600) w.classList.add('min'); // 手機預設細窗口，唔遮住學生
  document.body.appendChild(w);
  // 位置：記住老師上次拖到邊度；預設喺右下角
  const saved = store.get('fwpos-' + id, null);
  const place = (x, y) => {
    const mx = Math.max(0, window.innerWidth - w.offsetWidth - 4); const my = Math.max(0, window.innerHeight - w.offsetHeight - 4);
    x = Math.min(Math.max(4, x), mx); y = Math.min(Math.max(4, y), my);
    w.style.left = x + 'px'; w.style.top = y + 'px'; return [x, y];
  };
  if (saved) place(saved[0], saved[1]);
  else place(window.innerWidth - w.offsetWidth - 16, window.innerHeight - w.offsetHeight - 90 - corner * (w.offsetHeight + 12));
  const head = w.querySelector('.fw-head');
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button') || document.fullscreenElement) return;
    e.preventDefault(); w.style.zIndex = String(++floatWin.z);
    const ox = e.clientX - w.offsetLeft; const oy = e.clientY - w.offsetTop; head.setPointerCapture(e.pointerId);
    const move = (ev) => place(ev.clientX - ox, ev.clientY - oy);
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', up);
      store.set('fwpos-' + id, [w.offsetLeft, w.offsetTop]); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', up);
  });
  w.addEventListener('pointerdown', () => { w.style.zIndex = String(++floatWin.z); });
  // 縮細／放大時保持右邊對齊（窗口通常放喺右邊）
  w.querySelector('[data-fw=min]').onclick = () => { const right = w.offsetLeft + w.offsetWidth; w.classList.toggle('min'); store.set('fwpos-' + id, place(right - w.offsetWidth, w.offsetTop)); };
  w.querySelector('[data-fw=fs]').onclick = () => { (document.fullscreenElement ? document.exitFullscreen() : w.requestFullscreen?.())?.catch?.(() => {}); };
  w.querySelector('[data-fw=close]').onclick = () => { if (document.fullscreenElement === w) document.exitFullscreen().catch(() => {}); w.remove(); onClose?.(); };
  window.addEventListener('resize', () => { if (w.isConnected) place(w.offsetLeft, w.offsetTop); });
  return { el: w, fresh: true };
}
floatWin.z = 60;

// ---------- 噪音計 ----------
const noise = { stream: null, ctx: null, raf: 0 };
function stopNoise() {
  cancelAnimationFrame(noise.raf); noise.stream?.getTracks().forEach(t => t.stop()); noise.ctx?.close?.();
  noise.stream = null; noise.ctx = null;
}
function openNoise() {
  let threshold = store.get('noiseTh', 60); let loudSince = 0;
  const { el: d, fresh } = floatWin('fw-noise', '🔊 噪音計', `
    <div class="noise">
      <div class="fw-noise-row"><div class="noise-face" id="nz-face">🤫</div>
        <div class="noise-bar"><i id="nz-bar"></i><span class="noise-th" id="nz-th"></span></div></div>
      <div class="noise-msg" id="nz-msg">撳「開始」用咪高峰聽課室聲量</div>
      <label class="field fw-extra"><span class="small">提示門檻（越低越敏感）：<b id="nz-thv" class="num">${threshold}</b></span><input type="range" id="nz-range" min="20" max="95" value="${threshold}"></label>
      <div class="fw-ctrl"><button class="btn primary sm" id="nz-start">開始</button></div>
      <p class="muted fw-extra fw-note">聲音只喺部機即時分析，唔會錄音或上載；唔會自動扣分。</p>
    </div>`, { onClose: stopNoise, corner: 1 });
  if (!fresh) return;
  const bar = $('#nz-bar', d); const face = $('#nz-face', d); const msg = $('#nz-msg', d); const th = $('#nz-th', d); const btn = $('#nz-start', d);
  const setTh = () => { th.style.left = threshold + '%'; $('#nz-thv', d).textContent = threshold; };
  setTh();
  $('#nz-range', d).oninput = (e) => { threshold = Number(e.target.value); store.set('noiseTh', threshold); setTh(); };
  btn.onclick = async () => {
    if (noise.stream) { // 停止
      stopNoise(); btn.textContent = '開始'; bar.style.width = '0%'; face.textContent = '🤫'; msg.textContent = '已停止'; d.querySelector('.noise').classList.remove('loud'); return;
    }
    try {
      noise.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
      noise.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = noise.ctx.createAnalyser(); an.fftSize = 1024; noise.ctx.createMediaStreamSource(noise.stream).connect(an);
      const buf = new Float32Array(an.fftSize); let level = 0;
      btn.textContent = '停止';
      const loop = () => {
        if (!d.isConnected) return stopNoise();
        an.getFloatTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += v * v;
        const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8); // 約 -100（靜）至 0（極嘈）
        const target = Math.max(0, Math.min(100, (db + 70) * 1.6));
        level = level * 0.85 + target * 0.15;
        bar.style.width = level + '%';
        const loud = level >= threshold;
        if (loud) loudSince ||= performance.now(); else loudSince = 0;
        const tooLoud = loudSince && performance.now() - loudSince > 1200;
        d.querySelector('.noise').classList.toggle('loud', !!tooLoud); d.classList.toggle('alert', !!tooLoud);
        bar.style.background = level < threshold * 0.7 ? 'var(--mint)' : level < threshold ? 'var(--gold)' : 'var(--bad)';
        face.textContent = tooLoud ? '😣' : level < threshold * 0.7 ? '😊' : '😐';
        msg.textContent = tooLoud ? '太嘈喇！請細聲啲 🤫' : level < threshold * 0.7 ? '好安靜，好叻！' : '有少少嘈，留意聲量';
        noise.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      stopNoise(); msg.textContent = '未能使用咪高峰：請允許瀏覽器使用咪高峰。';
    }
  };
}

// ---------- 課堂計時 ----------
const timer = { total: 300, remain: 300, running: false, endAt: 0, tick: null, done: false };
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, .35, .7].forEach(t => { const o = ctx.createOscillator(); const g = ctx.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(.25, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + t + .3); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + .3); });
  } catch { /* 無聲 */ }
}
function timerLoop() {
  clearInterval(timer.tick);
  timer.tick = setInterval(() => {
    if (!timer.running) return;
    timer.remain = Math.round((timer.endAt - Date.now()) / 1000);
    if (timer.remain <= 0) { timer.remain = 0; timer.running = false; timer.done = true; beep(); }
    paintTimer();
  }, 250);
}
function paintTimer() {
  const f = $('#timer-face'); if (f) { f.textContent = mmss(timer.remain); f.classList.toggle('done', timer.done); }
  const sb = $('#timer-start'); if (sb) sb.textContent = timer.running ? '暫停' : timer.done ? '再計' : '開始';
  $('#fw-timer')?.classList.toggle('alert', timer.done);
  // 窗口關咗但仍在計：右下角顯示細時間，撳一下打開
  let mini = $('.timer-mini');
  const show = (timer.running || timer.done) && !$('#fw-timer');
  if (show && !mini) { mini = document.createElement('button'); mini.className = 'timer-mini'; mini.onclick = openTimer; document.body.appendChild(mini); }
  if (mini) { if (!show) mini.remove(); else { mini.textContent = mmss(timer.remain); mini.style.color = timer.done ? 'var(--bad)' : ''; } }
}
function openTimer() {
  const presets = state.boot.timer_presets || [60, 180, 300, 600];
  const { el: d, fresh } = floatWin('fw-timer', '⏱ 計時', `
    <div class="timer-face" id="timer-face">${mmss(timer.remain)}</div>
    <div class="fw-presets fw-extra">${presets.map(s => `<button class="btn sm" data-set="${s}">${s >= 60 ? s / 60 + ' 分' : s + ' 秒'}</button>`).join('')}
      <button class="btn sm" data-add="60">+1 分</button></div>
    <div class="fw-ctrl"><button class="btn primary sm" id="timer-start">${timer.running ? '暫停' : '開始'}</button><button class="btn sm" data-reset>重設</button></div>`,
  { onClose: paintTimer, corner: 0 });
  paintTimer();
  if (!fresh) return;
  d.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t || t.dataset.fw) return;
    if (t.dataset.set) { timer.total = timer.remain = Number(t.dataset.set); timer.running = false; timer.done = false; }
    if (t.dataset.add) { timer.remain += 60; timer.total = Math.max(timer.total, timer.remain); if (timer.running) timer.endAt += 60000; timer.done = false; }
    if (t.id === 'timer-start') {
      if (timer.running) timer.running = false;
      else { if (timer.remain <= 0) timer.remain = timer.total; timer.done = false; timer.running = true; timer.endAt = Date.now() + timer.remain * 1000; timerLoop(); }
    }
    if ('reset' in t.dataset) { timer.running = false; timer.done = false; timer.remain = timer.total; }
    paintTimer();
  });
}

// ---------- 學生及分組 ----------
const stuSel = { classId: null, ids: new Set() }; // 學生名單的批量選擇
function renderStudents() {
  if (!here('students')) return;
  const list = students(); const groups = state.cls.groups;
  if (stuSel.classId !== state.classId) { stuSel.classId = state.classId; stuSel.ids.clear(); }
  for (const id of [...stuSel.ids]) if (!list.some(s => s.id === id)) stuSel.ids.delete(id);
  const rows = state.importRows;
  const existing = new Set(list.map(s => s.name));
  shell('students', `
    <div class="page-head"><h1>${esc(state.cls.class.name)} 學生及分組</h1><span class="chip">${list.length} 位學生</span></div>
    <div class="grid-2">
      <section class="panel">
        <h2>匯入學生名單</h2>
        <label class="drop" id="drop">
          <input type="file" id="imp-file" accept=".xlsx,.csv,.txt,image/*" hidden>
          <strong>上載 Excel／CSV 或名單相片</strong><br><span class="muted small">Excel 第一行可有「班號、姓名、分數」標題；相片會在你的裝置內辨識文字，不會上載。</span>
        </label>
        <div id="ocr-progress" hidden style="margin-top:10px"><div class="muted small">正在辨識相片文字…</div><div class="progress"><i></i></div></div>
        <details style="margin-top:12px"><summary class="btn ghost sm">或直接貼上名單</summary>
          <textarea class="input" id="imp-text" placeholder="每行一位，例如：&#10;1 陳大文&#10;2 李小明 15"></textarea>
          <button class="btn sm" data-act="parsetext" style="margin-top:8px">讀取名單</button></details>
        ${rows.length ? `<div style="margin-top:14px"><div class="row" style="align-items:center"><h3 style="margin-right:auto">核對 ${rows.length} 位學生</h3>
          <button class="btn sm" data-act="clearimp">清除</button><button class="btn primary sm" data-act="doimport">確認匯入</button></div>
          <p class="muted small">可直接修改；「舊分數」會原數保留，但不會變成寵物 XP。橙色表示班內已有同名學生。</p>
          <div class="table-wrap"><table><thead><tr><th>匯入</th><th>班號</th><th>姓名</th><th>舊分數</th></tr></thead><tbody>
          ${rows.map((r, i) => `<tr${existing.has(r.name) ? ' style="background:var(--gold-soft)"' : ''}><td><input type="checkbox" data-imp="${i}" data-k="on" ${r.on !== false ? 'checked' : ''} aria-label="匯入"></td>
            <td><input class="input num" style="width:70px" data-imp="${i}" data-k="number" value="${esc(r.number)}" aria-label="班號"></td>
            <td><input class="input" data-imp="${i}" data-k="name" value="${esc(r.name)}" aria-label="姓名"></td>
            <td><input class="input num" style="width:80px" data-imp="${i}" data-k="score" value="${esc(r.score)}" aria-label="舊分數"></td></tr>`).join('')}
          </tbody></table></div></div>` : ''}
      </section>
      <section class="panel">
        <h2>小組</h2>
        <div class="stack" style="gap:8px">${groups.map(g => `<div class="status-row" style="--gc:${esc(g.color)}">
          <input type="color" value="${esc(g.color)}" data-gcolor="${g.id}" aria-label="顏色" style="width:36px;height:32px;border:none;background:none">
          <span class="who">${esc(g.name)} <span class="muted small">${list.filter(s => s.group_id === g.id).length} 人</span></span>
          <button class="btn sm" data-act="renamegroup" data-id="${g.id}">改名</button><button class="btn sm danger" data-act="delgroup" data-id="${g.id}">刪除</button></div>`).join('') || '<p class="muted">未有小組。建立後在下表為學生選擇小組。</p>'}</div>
        <form class="row" data-form="newgroup" style="margin-top:12px"><label class="field"><span>新小組名稱</span><input class="input" id="ng-name" name="name" maxlength="20" required placeholder="例如：藍鯨隊"></label>
          <input type="color" name="color" value="#8cc4f5" aria-label="顏色" style="width:44px;height:40px;border:none;background:none"><button class="btn blue">新增</button></form>
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <div class="row" style="align-items:center;margin-bottom:8px"><h2 style="margin:0 auto 0 0">學生名單</h2>
        ${list.length ? `<span class="muted small" id="ssel-count">已選 ${stuSel.ids.size} 位</span>
        <button class="btn sm danger" data-act="delsel" id="ssel-del"${stuSel.ids.size ? '' : ' disabled'}>🗑 刪除已選</button>` : ''}</div>
      ${list.length ? `<div class="table-wrap"><table class="stu-table"><thead><tr><th><input type="checkbox" id="ssel-all" aria-label="全選"${stuSel.ids.size && stuSel.ids.size === list.length ? ' checked' : ''}></th><th class="num">班號</th><th></th><th>姓名</th><th>小組</th><th class="num">分數</th><th>寵物</th><th></th></tr></thead><tbody>
      ${list.map(s => `<tr><td><input type="checkbox" data-ssel="${s.id}" aria-label="選擇 ${esc(s.name)}"${stuSel.ids.has(s.id) ? ' checked' : ''}></td><td class="num">${s.number ?? ''}</td><td>${avatar(s, 44)}</td><td><a href="#/s/${s.id}">${esc(s.name)}</a></td>
        <td><select class="input" style="width:auto;min-height:34px" data-sgroup="${s.id}" aria-label="小組"><option value="">—</option>${groups.map(g => `<option value="${g.id}"${g.id === s.group_id ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></td>
        <td class="num">${s.score}</td><td class="small">${esc(petLabel(s.pet))}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-act="editstu" data-id="${s.id}">編輯</button> <button class="btn sm danger" data-act="delstu" data-id="${s.id}">刪除</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty"><strong>未有學生</strong>用上面的匯入工具加入全班名單。</div>'}
      <form class="row" data-form="addone" style="margin-top:12px"><label class="field" style="flex:0 0 90px"><span>班號</span><input class="input num" id="a1-no" name="number" type="number" min="1" max="99"></label>
        <label class="field"><span>逐個加入學生</span><input class="input" id="a1-name" name="name" required maxlength="40" placeholder="學生姓名"></label><button class="btn">加入</button></form>
    </section>`);

  const fileIn = $('#imp-file'); const drop = $('#drop');
  const handleFile = async (file) => {
    if (!file) return;
    try {
      if (file.type.startsWith('image/')) {
        const box = $('#ocr-progress'); box.hidden = false;
        const text = await ocrImage(file, (p) => { box.querySelector('i').style.width = Math.round(p * 100) + '%'; });
        box.hidden = true; $('#imp-text').value = text; $('#imp-text').closest('details').open = true;
        state.importRows = textToStudents(text);
        if (!state.importRows.length) return toast('相片中找不到學生姓名，請在文字框修改後按「讀取名單」', { error: true });
      } else state.importRows = await readFileToStudents(file);
      if (!state.importRows.length) return toast('檔案中找不到「姓名」欄', { error: true });
      toast(`讀到 ${state.importRows.length} 位學生，請核對`); renderStudents();
    } catch (e) { $('#ocr-progress').hidden = true; toast(e.message, { error: true }); }
  };
  fileIn.onchange = () => handleFile(fileIn.files[0]);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handleFile(e.dataTransfer.files[0]); });
  app.oninput = (e) => { const i = e.target.dataset.imp; if (i !== undefined) state.importRows[i][e.target.dataset.k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; };
  const syncSel = () => {
    const n = stuSel.ids.size; const c = $('#ssel-count'); if (c) c.textContent = `已選 ${n} 位`;
    const b = $('#ssel-del'); if (b) b.disabled = !n;
    const all = $('#ssel-all'); if (all) { all.checked = n > 0 && n === list.length; all.indeterminate = n > 0 && n < list.length; }
  };
  syncSel();
  app.onchange = async (e) => {
    if (e.target.id === 'ssel-all') {
      if (e.target.checked) list.forEach(s => stuSel.ids.add(s.id)); else stuSel.ids.clear();
      document.querySelectorAll('[data-ssel]').forEach(cb => { cb.checked = e.target.checked; }); syncSel(); return;
    }
    if (e.target.dataset.ssel) { const id = Number(e.target.dataset.ssel); e.target.checked ? stuSel.ids.add(id) : stuSel.ids.delete(id); syncSel(); return; }
    try {
      if (e.target.dataset.sgroup) { await PATCH(`/students/${e.target.dataset.sgroup}`, { group_id: e.target.value ? Number(e.target.value) : null }); await reloadClass(); toast('已更新小組'); }
      if (e.target.dataset.gcolor) { await PATCH(`/groups/${e.target.dataset.gcolor}`, { color: e.target.value }); await reloadClass(); }
    } catch (err) { fail(err); }
  };
  ACT.parsetext = () => { state.importRows = textToStudents($('#imp-text').value); if (!state.importRows.length) return toast('讀不到名字，請每行輸入一位學生', { error: true }); renderStudents(); };
  ACT.clearimp = () => { state.importRows = []; renderStudents(); };
  ACT.doimport = async () => {
    const pick = state.importRows.filter(r => r.on !== false && String(r.name).trim());
    if (!pick.length) return toast('沒有選擇任何學生', { error: true });
    const r = await POST(`/classes/${state.classId}/students`, { students: pick.map(({ number, name, score }) => ({ number, name, score })) });
    state.importRows = []; await reloadClass(); await reloadBoot();
    toast(`已匯入 ${r.created.length} 位學生。可到「寵物」頁派蛋。`); renderStudents();
  };
  ACT['submit:newgroup'] = async (f, fd) => { await POST(`/classes/${state.classId}/groups`, Object.fromEntries(fd)); await reloadClass(); renderStudents(); };
  ACT['submit:addone'] = async (f, fd) => { await POST(`/classes/${state.classId}/students`, { students: [Object.fromEntries(fd)] }); await reloadClass(); await reloadBoot(); renderStudents(); };
  ACT.renamegroup = (el) => editDialog('小組名稱', groups.find(g => g.id === Number(el.dataset.id)).name, async (v) => { await PATCH(`/groups/${el.dataset.id}`, { name: v }); await reloadClass(); renderStudents(); });
  ACT.delgroup = async (el) => { if (await confirmBox('刪除此小組？組員的分數不受影響。', { ok: '刪除', danger: true })) { await DEL(`/groups/${el.dataset.id}`); await reloadClass(); renderStudents(); } };
  ACT.editstu = (el) => {
    const s = list.find(x => x.id === Number(el.dataset.id));
    const d = openDialog(`<div class="sheet-head"><h2>編輯學生</h2><button class="btn ghost" data-close>✕</button></div>
      <form class="stack" data-f><label class="field"><span>班號</span><input class="input num" id="es-no" name="number" type="number" value="${s.number ?? ''}"></label>
      <label class="field"><span>姓名</span><input class="input" id="es-name" name="name" required maxlength="40" value="${esc(s.name)}"></label><button class="btn primary">儲存</button></form>`);
    d.querySelector('[data-f]').onsubmit = async (e) => { e.preventDefault(); try { await PATCH(`/students/${s.id}`, Object.fromEntries(new FormData(e.target))); d.close(); await reloadClass(); renderStudents(); } catch (err) { fail(err); } };
  };
  ACT.delsel = async () => {
    const ids = [...stuSel.ids]; if (!ids.length) return;
    const names = list.filter(s => stuSel.ids.has(s.id)).map(s => s.name);
    const preview = names.slice(0, 8).join('、') + (names.length > 8 ? ` 等 ${names.length} 位` : '');
    if (!(await confirmBox(`刪除 ${ids.length} 位學生（${preview}）？佢哋嘅分數紀錄、功課、成績及寵物會一併刪除，不能復原。`, { ok: `刪除 ${ids.length} 位`, danger: true }))) return;
    await POST(`/classes/${state.classId}/students/delete`, { student_ids: ids });
    stuSel.ids.clear(); await reloadClass(); await reloadBoot(); toast(`已刪除 ${ids.length} 位學生`); renderStudents();
  };
  ACT.delstu = async (el) => {
    const s = list.find(x => x.id === Number(el.dataset.id));
    if (await confirmBox(`刪除 ${s.name}？其分數紀錄、功課、成績及寵物會一併刪除，不能復原。`, { ok: '刪除', danger: true })) { await DEL(`/students/${s.id}`); await reloadClass(); await reloadBoot(); renderStudents(); }
  };
}
function editDialog(label, value, save) {
  const d = openDialog(`<form class="stack" data-f><label class="field"><span>${esc(label)}</span><input class="input" id="ed-v" name="v" required maxlength="40" value="${esc(value)}"></label>
    <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>取消</button><button class="btn primary">儲存</button></div></form>`);
  d.querySelector('[data-f]').onsubmit = async (e) => { e.preventDefault(); try { await save(new FormData(e.target).get('v')); d.close(); } catch (err) { fail(err); } };
}

// ---------- 功課 ----------
function tplChips() {
  const list = state.boot.homework_templates || [];
  return list.length ? list.map(t => `<span class="tpl"><button type="button" class="use" data-act="usetpl" data-id="${t.id}">${esc(t.title)}${t.subject ? `<small>${esc(t.subject)}</small>` : ''}</button><button type="button" class="del" data-act="deltpl" data-id="${t.id}" aria-label="刪除常用功課 ${esc(t.title)}">✕</button></span>`).join('')
    : '<span class="muted small">未有常用功課。新增功課時勾選「儲存為常用功課」即可加入。</span>';
}
const HW_STATUS = [['submitted', '已交'], ['late', '遲交'], ['missing', '欠交'], ['excused', '豁免']];
async function renderHomework(hid) {
  if (hid) return renderHomeworkDetail(hid);
  if (!here('homework')) return;
  const t = navSeq; const list = await GET(`/classes/${state.classId}/homework`); if (t !== navSeq || !here('homework')) return;
  const n = students().length;
  shell('homework', `
    <div class="page-head"><h1>功課及提交紀錄</h1></div>
    <section class="panel">
      <h2>新增功課</h2>
      <div class="section-label">常用功課（按一下即填好名稱及科目）</div>
      <div class="tpl-row" id="tpl-row">${tplChips()}</div>
      <form class="row" data-form="newhw"><label class="field"><span>功課名稱</span><input class="input" id="hw-title" name="title" required maxlength="60" placeholder="例如：中文作文"></label>
        <label class="field" style="flex:0 1 140px"><span>科目</span><input class="input" id="hw-subj" name="subject" maxlength="20" list="subjects"></label>
        <label class="field" style="flex:0 1 170px"><span>限期</span><input class="input" id="hw-due" name="due_date" type="date"></label>
        <label class="check" style="flex-basis:100%"><input type="checkbox" id="hw-save" name="save_template"> 儲存為常用功課，下次一按就用得</label>
        <button class="btn blue">新增功課</button></form>
    </section>
    <datalist id="subjects"><option>中文</option><option>英文</option><option>數學</option><option>常識</option><option>人文</option><option>科學</option><option>普通話</option><option>視藝</option><option>音樂</option></datalist>
    <div class="stack" style="margin-top:14px;gap:8px">${list.map(h => {
      const total = Math.max(n, 1); const w = (x) => (x / total * 100).toFixed(1) + '%';
      return `<a class="hw-card" href="#/c/${state.classId}/homework/${h.id}"><div class="t"><b>${esc(h.title)}</b><div class="muted small">${esc(h.subject || '—')} · 限期 ${h.due_date ? fmtDate(h.due_date) : '未定'}</div></div>
        <span class="meter" aria-hidden="true"><i style="width:${w(h.submitted)};background:var(--good)"></i><i style="width:${w(h.late)};background:var(--gold)"></i><i style="width:${w(h.missing)};background:var(--bad)"></i><i style="width:${w(h.excused)};background:var(--blue)"></i></span>
        <span class="small"><span class="chip good">已交 ${h.submitted}</span> <span class="chip bad">欠交 ${h.missing}</span> <span class="chip">未記錄 ${Math.max(0, n - h.submitted - h.late - h.missing - h.excused)}</span></span></a>`;
    }).join('') || '<div class="empty"><strong>未有功課</strong>新增後可逐一記錄提交情況。</div>'}</div>`);
  ACT['submit:newhw'] = async (_f, fd) => {
    const body = Object.fromEntries(fd);
    if (body.save_template) state.boot.homework_templates = await POST('/homework-templates', { title: body.title, subject: body.subject });
    const h = await POST(`/classes/${state.classId}/homework`, { title: body.title, subject: body.subject, due_date: body.due_date });
    go(`#/c/${state.classId}/homework/${h.id}`);
  };
  ACT.usetpl = (el) => {
    const t = state.boot.homework_templates.find(x => x.id === Number(el.dataset.id)); if (!t) return;
    $('#hw-title').value = t.title; $('#hw-subj').value = t.subject; $('#hw-save').checked = false;
    const due = $('#hw-due'); if (!due.value) { const d = new Date(); d.setDate(d.getDate() + 1); due.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
    due.focus();
  };
  ACT.deltpl = async (el) => {
    const t = state.boot.homework_templates.find(x => x.id === Number(el.dataset.id)); if (!t) return;
    if (!(await confirmBox(`刪除常用功課「${t.title}」？已建立的功課不受影響。`, { ok: '刪除', danger: true }))) return;
    state.boot.homework_templates = await DEL(`/homework-templates/${t.id}`);
    $('#tpl-row').innerHTML = tplChips();
  };
}
async function renderHomeworkDetail(hid) {
  if (!here('homework')) return;
  const t = navSeq; const { homework: h, entries } = await GET(`/homework/${hid}/submissions`); if (t !== navSeq || !here('homework')) return;
  const st = new Map(entries.map(e => [e.student_id, e.status]));
  const draw = () => {
    if (!here('homework')) return;
    shell('homework', `
      <div class="page-head"><a class="btn ghost sm" href="#/c/${state.classId}/homework">← 功課</a><h1>${esc(h.title)}</h1>
        <span class="muted">${esc(h.subject)} · 限期 ${h.due_date ? fmtDate(h.due_date) : '未定'}</span>
        <button class="btn" data-act="allsub">未記錄的全部設為已交</button><button class="btn danger" data-act="delhw">刪除功課</button></div>
      <div class="row" style="margin-bottom:12px">${HW_STATUS.map(([k, l]) => `<span class="chip">${l} <b class="num">${[...st.values()].filter(v => v === k).length}</b></span>`).join('')}
        <span class="chip">未記錄 <b class="num">${students().length - st.size}</b></span></div>
      <div class="status-grid">${students().map(s => `<div class="status-row">${avatar(s, 40)}<span class="who"><span class="muted num">${s.number ?? ''}</span> ${esc(s.name)}</span>
        <span class="seg">${HW_STATUS.map(([k, l]) => `<button data-hw="${s.id}" data-v="${k}" aria-pressed="${st.get(s.id) === k}">${l}</button>`).join('')}</span></div>`).join('')}</div>`);
  };
  draw();
  app.onclick = async (e) => {
    const b = e.target.closest('[data-hw]'); if (!b) return;
    // 即時更新畫面，再在背景儲存；失敗就還原
    const sid = Number(b.dataset.hw); const prev = st.get(sid); const v = prev === b.dataset.v ? null : b.dataset.v;
    v ? st.set(sid, v) : st.delete(sid); draw();
    try { await PUT(`/homework/${h.id}/submissions`, { entries: [{ student_id: sid, status: v }] }); }
    catch (err) { prev ? st.set(sid, prev) : st.delete(sid); draw(); fail(err); }
  };
  ACT.allsub = async () => {
    const entries2 = students().filter(s => !st.has(s.id)).map(s => ({ student_id: s.id, status: 'submitted' }));
    if (!entries2.length) return toast('全部已有紀錄');
    entries2.forEach(e => st.set(e.student_id, 'submitted')); draw();
    try { await PUT(`/homework/${h.id}/submissions`, { entries: entries2 }); toast(`已將 ${entries2.length} 位設為已交`); }
    catch (err) { entries2.forEach(e => st.delete(e.student_id)); draw(); throw err; }
  };
  ACT.delhw = async () => { if (await confirmBox(`刪除「${h.title}」及所有提交紀錄？`, { ok: '刪除', danger: true })) { await DEL(`/homework/${h.id}`); app.onclick = null; go(`#/c/${state.classId}/homework`); } };
  window.addEventListener('hashchange', () => { app.onclick = null; }, { once: true });
}

// ---------- 考試 ----------
async function renderExams(eid) {
  if (eid) return renderExamDetail(eid);
  if (!here('exams')) return;
  const t = navSeq; const list = await GET(`/classes/${state.classId}/exams`); if (t !== navSeq || !here('exams')) return;
  const f1 = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toString());
  shell('exams', `
    <div class="page-head"><h1>考試成績</h1></div>
    <form class="panel row" data-form="newex"><label class="field"><span>考試名稱</span><input class="input" id="ex-title" name="title" required maxlength="60" placeholder="例如：上學期統一測驗"></label>
      <label class="field" style="flex:0 1 130px"><span>科目</span><input class="input" id="ex-subj" name="subject" maxlength="20" list="subjects2"></label>
      <label class="field" style="flex:0 1 100px"><span>滿分</span><input class="input num" id="ex-full" name="full_mark" type="number" value="100" min="1" max="1000"></label>
      <label class="field" style="flex:0 1 170px"><span>日期</span><input class="input" id="ex-date" name="exam_date" type="date"></label><button class="btn blue">新增考試</button></form>
    <datalist id="subjects2"><option>中文</option><option>英文</option><option>數學</option><option>常識</option><option>人文</option><option>科學</option></datalist>
    <div class="panel" style="margin-top:14px"><div class="table-wrap"><table><thead><tr><th>考試</th><th>科目</th><th>日期</th><th class="num">已輸入</th><th class="num">平均</th><th class="num">最高</th><th class="num">最低</th></tr></thead><tbody>
    ${list.map(x => `<tr><td><a href="#/c/${state.classId}/exams/${x.id}">${esc(x.title)}</a></td><td>${esc(x.subject)}</td><td>${x.exam_date ? fmtDate(x.exam_date) : ''}</td>
      <td class="num">${x.n}／${students().length}</td><td class="num">${f1(x.avg)}</td><td class="num">${f1(x.max)}</td><td class="num">${f1(x.min)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">未有考試</td></tr>'}
    </tbody></table></div></div>`);
  ACT['submit:newex'] = async (_f, fd) => { const x = await POST(`/classes/${state.classId}/exams`, Object.fromEntries(fd)); go(`#/c/${state.classId}/exams/${x.id}`); };
}
async function renderExamDetail(eid) {
  if (!here('exams')) return;
  const t = navSeq; const { exam: x, scores } = await GET(`/exams/${eid}/scores`); if (t !== navSeq || !here('exams')) return;
  const m = new Map(scores.map(s => [s.student_id, s.score]));
  const vals = [...m.values()].filter(v => v != null);
  const bands = [0, 0, 0, 0, 0]; vals.forEach(v => { const p = v / x.full_mark; bands[p >= .9 ? 4 : p >= .75 ? 3 : p >= .6 ? 2 : p >= .5 ? 1 : 0]++; });
  const maxB = Math.max(1, ...bands);
  shell('exams', `
    <div class="page-head"><a class="btn ghost sm" href="#/c/${state.classId}/exams">← 考試</a><h1>${esc(x.title)}</h1><span class="muted">${esc(x.subject)} · 滿分 ${x.full_mark}</span>
      <button class="btn danger" data-act="delex">刪除考試</button></div>
    <div class="grid-2">
      <form class="panel" data-form="scores"><h2>輸入分數</h2><p class="muted small">按 Tab 或 Enter 跳到下一位；留空表示未考。</p>
        <div class="table-wrap"><table><tbody>${students().map(s => `<tr><td class="num muted" style="width:40px">${s.number ?? ''}</td><td>${esc(s.name)}</td>
          <td style="width:120px"><input class="input num" type="number" step="0.5" min="0" max="${x.full_mark}" name="s${s.id}" id="sc-${s.id}" value="${m.get(s.id) ?? ''}" aria-label="${esc(s.name)} 分數"></td></tr>`).join('')}</tbody></table></div>
        <button class="btn primary" style="margin-top:12px">儲存分數</button></form>
      <section class="panel"><h2>分佈</h2>
        <p>平均 <b class="num">${vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—'}</b> · 最高 <b class="num">${vals.length ? Math.max(...vals) : '—'}</b> · 最低 <b class="num">${vals.length ? Math.min(...vals) : '—'}</b> · 及格 <b class="num">${vals.filter(v => v >= x.full_mark / 2).length}／${vals.length}</b></p>
        <div class="stack" style="gap:6px">${['不及格', '50–59%', '60–74%', '75–89%', '90% 以上'].map((l, i) => `<div style="display:grid;grid-template-columns:80px 1fr 30px;gap:8px;align-items:center" class="small">
          <span>${l}</span><span class="xpbar" style="height:14px"><i style="width:${bands[i] / maxB * 100}%;background:${i ? 'var(--blue)' : 'var(--bad)'}"></i></span><b class="num">${bands[i]}</b></div>`).join('')}</div></section>
    </div>`);
  app.querySelectorAll('input[id^=sc-]').forEach((inp, i, all) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); all[i + 1]?.focus(); } }));
  ACT['submit:scores'] = async (_f, fd) => {
    const out = students().map(s => ({ student_id: s.id, score: fd.get('s' + s.id) === '' ? null : Number(fd.get('s' + s.id)) }));
    await PUT(`/exams/${x.id}/scores`, { scores: out }); toast('已儲存分數'); renderExamDetail(eid);
  };
  ACT.delex = async () => { if (await confirmBox(`刪除「${x.title}」及所有分數？`, { ok: '刪除', danger: true })) { await DEL(`/exams/${x.id}`); go(`#/c/${state.classId}/exams`); } };
}

// ---------- 分數紀錄 ----------
async function renderHistory() {
  if (!here('history')) return;
  const t = navSeq; const [batches, events] = await Promise.all([GET(`/classes/${state.classId}/batches?limit=30`), GET(`/classes/${state.classId}/events`)]); if (t !== navSeq || !here('history')) return;
  let who = ''; let kind = '';
  const draw = () => {
    const ev = events.filter(e => (!who || e.student_id === Number(who)) && (!kind || (kind === 'pos' ? e.delta > 0 : kind === 'neg' ? e.delta < 0 : e.kind === 'import')));
    shell('history', `
      <div class="page-head"><h1>分數紀錄</h1></div>
      <div class="grid-2" style="align-items:start">
        <section class="panel"><h2>最近操作</h2>
          <div class="stack" style="gap:6px">${batches.map(b => `<div class="status-row"><span class="chip ${b.delta > 0 ? 'good' : 'bad'} num">${signed(b.delta)}</span>
            <span class="who">${esc(b.label)}<br><span class="muted small">${esc(b.names)} · ${fmtTime(b.created_at)}</span></span>
            ${b.undone_at ? '<span class="chip">已撤銷</span>' : `<button class="btn sm" data-act="undo" data-id="${b.id}">撤銷</button>`}</div>`).join('') || '<div class="empty">未有操作</div>'}</div></section>
        <section class="panel"><h2>分數歷史</h2>
          <div class="row" style="margin-bottom:10px"><label class="field"><span>學生</span><select class="input" id="h-who"><option value="">全班</option>${students().map(s => `<option value="${s.id}"${String(s.id) === who ? ' selected' : ''}>${s.number ?? ''} ${esc(s.name)}</option>`).join('')}</select></label>
            <label class="field"><span>類別</span><select class="input" id="h-kind"><option value="">全部</option><option value="pos"${kind === 'pos' ? ' selected' : ''}>加分</option><option value="neg"${kind === 'neg' ? ' selected' : ''}>扣分</option><option value="import"${kind === 'import' ? ' selected' : ''}>匯入舊分數</option></select></label></div>
          <div class="table-wrap"><table><thead><tr><th>時間</th><th>學生</th><th>原因</th><th class="num">分數</th><th class="num">寵物 XP</th></tr></thead><tbody>
          ${ev.slice(0, 300).map(e => `<tr style="${e.undone_at ? 'opacity:.45;text-decoration:line-through' : ''}"><td class="small">${fmtTime(e.created_at)}</td><td>${esc(e.name)}</td>
            <td class="small">${e.kind === 'import' ? '保留舊分數' : esc(e.tag_label ? `${e.tag_icon} ${e.tag_label}` : e.reason || '')}</td>
            <td class="num" style="color:${e.delta > 0 ? 'var(--good)' : 'var(--bad)'}">${signed(e.delta)}</td><td class="num">${e.xp_gained ? '+' + e.xp_gained : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">沒有紀錄</td></tr>'}
          </tbody></table></div></section>
      </div>`);
    $('#h-who').onchange = (e) => { who = e.target.value; draw(); };
    $('#h-kind').onchange = (e) => { kind = e.target.value; draw(); };
  };
  ACT.undo = async (el) => { if (await confirmBox('撤銷這次加減分？寵物 XP 會扣回，但寵物不會退化。', { ok: '撤銷' })) { await undoBatch(Number(el.dataset.id)); } };
  draw();
}

// ---------- 寵物 ----------
function renderPets() {
  if (!here('pets')) return;
  const th = thresholds();
  const list = students(); const noPet = list.filter(s => !s.pet);
  let pick = 'balanced';
  const counts = {}; list.forEach(s => { if (s.pet) counts[`${s.pet.species_key}/${s.pet.stage}`] = (counts[`${s.pet.species_key}/${s.pet.stage}`] || 0) + 1; });
  shell('pets', `
    <div class="page-head"><h1>${esc(state.cls.class.name)} 寵物</h1>
      <span class="chip gold">孵化 ${th.baby} · 少年 ${th.junior} · 成年 ${th.adult} · 進化 ${th.evolved} XP</span><a class="btn sm" href="#/settings">修改門檻</a></div>
    ${noPet.length ? `<section class="panel"><h2>派蛋（${noPet.length} 位未有寵物）</h2>
      <p class="muted small">每位學生只會看到自己獲派的蛋；派蛋之後的正向加分才會成為寵物 XP，之前的分數照樣保留。孵化前仍可更換品種。</p>
      <div class="species-pick" id="sp-pick"><button data-sp="balanced" aria-pressed="true"><span style="font-size:2rem;line-height:64px">🎲</span>平均分配</button>
        ${SPECIES.map(s => `<button data-sp="${s.key}" aria-pressed="false">${dexImage(s.key, 'egg')}${esc(s.name)}</button>`).join('')}</div>
      <div class="row" style="margin:12px 0"><button class="btn sm" data-act="selall">全選</button><button class="btn sm" data-act="selnone">全不選</button></div>
      <div class="status-grid">${noPet.map(s => `<label class="status-row"><input type="checkbox" data-np="${s.id}" checked> ${avatar(s, 36)}<span class="who">${s.number ?? ''} ${esc(s.name)}</span></label>`).join('')}</div>
      <button class="btn primary" data-act="assign" style="margin-top:12px">派蛋給已選學生</button></section>` : ''}
    <section class="panel"><h2>全班寵物</h2>
      <div class="pet-list">${list.filter(s => s.pet).map(s => `<a class="pet-item" href="#/s/${s.id}">${avatar(s)}<span class="info"><b>${s.number ?? ''} ${esc(s.name)}</b>
        <span class="small muted">${esc(petLabel(s.pet))}${s.pet.nickname ? `「${esc(s.pet.nickname)}」` : ''} · XP ${s.pet.xp}${hungerOf(s) ? ` · <span class="${hungerOf(s) === 2 ? 'hungry-text2' : 'hungry-text'}">${hungerOf(s) === 2 ? '好肚餓' : '肚餓'}</span>` : ''}</span>${xpBar(s.pet, th)}</span></a>`).join('') || '<div class="empty">未有學生獲派蛋</div>'}</div></section>
    <section class="panel"><h2>寵物圖鑑</h2><p class="muted small">數字是本班處於該階段的寵物數目。</p>
      <div class="dex">${SPECIES.map(sp => `<div class="dex-row"><div class="sp">${esc(sp.name)}<small>${sp.element}屬性</small></div>
        ${STAGES.map(st => `<div class="dex-cell">${dexImage(sp.key, st)}<div>${STAGE_LABELS[st]} <b>${counts[`${sp.key}/${st}`] || 0}</b></div></div>`).join('')}</div>`).join('')}</div></section>`);
  const pickBox = $('#sp-pick');
  if (pickBox) pickBox.onclick = (e) => { const b = e.target.closest('[data-sp]'); if (!b) return; pick = b.dataset.sp; $$('[data-sp]', pickBox).forEach(x => x.setAttribute('aria-pressed', x === b)); };
  ACT.selall = () => $$('[data-np]').forEach(c => { c.checked = true; });
  ACT.selnone = () => $$('[data-np]').forEach(c => { c.checked = false; });
  ACT.assign = async () => {
    const ids = $$('[data-np]').filter(c => c.checked).map(c => Number(c.dataset.np));
    if (!ids.length) return toast('請先選擇學生', { error: true });
    const r = await POST('/pets/assign', { student_ids: ids, species_key: pick });
    await reloadClass(); await reloadBoot(); toast(`已為 ${r.created.length} 位學生派蛋`); renderPets();
  };
}

// ---------- 海報 ----------
async function renderPoster() {
  if (!here('poster')) return;
  const opts = { period: store.get('pPeriod', 'week'), theme: store.get('pTheme', 'coral'), top: store.get('pTop', 10), title: store.get('pTitle', '本週之星') };
  const since = () => {
    if (opts.period === 'all') return '';
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (opts.period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); else d.setDate(1);
    return d.toISOString();
  };
  const draw = async () => {
    const t = navSeq; const lb = await GET(`/classes/${state.classId}/leaderboard?since=${encodeURIComponent(since())}`); if (t !== navSeq || !here('poster')) return;
    const key = opts.period === 'all' ? 'score' : 'gained';
    // 只列出有分數的同學（零分唔上榜）
    const ranked = lb.students.filter(s => s[key] > 0).sort((a, b) => b[key] - a[key] || (a.number ?? 99) - (b.number ?? 99));
    const top3 = ranked.slice(0, 3); const rest = ranked.slice(3, Math.max(3, opts.top));
    const periodText = { week: '本週', month: '本月', all: '全學期' }[opts.period];
    const today = new Date();
    shell('poster', `
      <div class="page-head"><h1>海報</h1>
        ${IS_DEMO ? '' : '<button class="btn primary" data-act="print">列印／存成 PDF</button>'}</div>
      <form class="panel row" id="poster-opts">
        <label class="field"><span>標題</span><input class="input" id="po-title" name="title" maxlength="12" value="${esc(opts.title)}"></label>
        <label class="field"><span>計算期間</span><select class="input" id="po-period" name="period"><option value="week">本週加分</option><option value="month">本月加分</option><option value="all">總分</option></select></label>
        <label class="field"><span>榜上人數</span><select class="input" id="po-top" name="top"><option>3</option><option>5</option><option>10</option><option>15</option></select></label>
        <label class="field"><span>主題</span><select class="input" id="po-theme" name="theme"><option value="coral">珊瑚貼紙</option><option value="sky">星空粉藍</option><option value="forest">森林綠意</option></select></label>
      </form>
      <div class="poster-wrap" style="margin-top:14px"><div class="poster theme-${esc(opts.theme)}" id="poster">
        <div class="blob" style="width:340px;height:340px;background:var(--p1);right:-120px;top:-120px"></div>
        <div class="blob" style="width:260px;height:260px;background:var(--p3);left:-110px;top:380px"></div>
        <div class="blob" style="width:300px;height:300px;background:var(--p2);right:-140px;bottom:120px"></div>
        <div style="position:relative">
          <div class="eyebrow">${esc(state.cls.class.name)} · ${periodText}</div>
          <div class="title">${esc(opts.title)}</div>
          <div class="sub">${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日 · 多謝每位同學的努力！</div>
          ${ranked.length ? '' : `<div class="poster-empty">${periodText}仲未有加分紀錄<br><small style="font-weight:600;opacity:.7">加分之後，同學就會出現喺呢度 ✨</small></div>`}
          <div class="podium">${[top3[1], top3[0], top3[2]].map((s, i) => s ? `<div class="p p${[2, 1, 3][i]}">${avatar(s)}
            <div class="base"><div class="rank">${[2, 1, 3][i]}</div><div class="pn">${esc(s.name)}</div><div class="pp">${s[key]} 分</div></div></div>` : '<div></div>').join('')}</div>
          ${rest.length ? `<div class="honor">${rest.map((s, i) => `<div><span class="r">${i + 4}</span>${avatar(s)}<span>${esc(s.name)}</span><span class="g">${s[key]}</span></div>`).join('')}</div>` : ''}
          <div class="garden">${lb.students.filter(s => s.pet).map(s => avatar(s)).join('')}</div>
          <div class="foot">Tick and Mark · 每一分都是進步</div>
        </div></div></div>`);
    $('#po-period').value = opts.period; $('#po-top').value = String(opts.top); $('#po-theme').value = opts.theme;
    fitPoster();
    $('#poster-opts').onchange = (e) => {
      const fd = new FormData(e.currentTarget);
      opts.period = fd.get('period'); opts.top = Number(fd.get('top')); opts.theme = fd.get('theme'); opts.title = String(fd.get('title') || '本週之星');
      store.set('pPeriod', opts.period); store.set('pTop', opts.top); store.set('pTheme', opts.theme); store.set('pTitle', opts.title);
      draw().catch(fail);
    };
  };
  ACT.print = () => window.print();
  await draw();
}
// 海報闊 794px（A4）：螢幕較窄時按比例縮細，免得要左右捲動
function fitPoster() {
  const wrap = $('.poster-wrap'); const p = $('#poster'); if (!wrap || !p) return;
  const k = Math.min(1, wrap.clientWidth / 794);
  p.style.transform = k < 1 ? `scale(${k})` : ''; p.style.margin = k < 1 ? '0' : '';
  wrap.style.height = k < 1 ? `${Math.ceil(p.offsetHeight * k)}px` : '';
}
window.addEventListener('resize', () => fitPoster());

// ---------- 學生資料頁 ----------
async function renderStudent(id) {
  if (!here('student', id)) return;
  const t = navSeq; const d = await GET(`/students/${id}`); if (t !== navSeq || !here('student', id)) return;
  const s = d.student; const th = d.thresholds; const pet = s.pet;
  if (state.classId !== d.class.id) { const full = await GET(`/classes/${d.class.id}/full`); if (t !== navSeq) return; state.cls = full; state.classId = d.class.id; }
  const p = pet && progressInfo(pet, th);
  const hwCount = (k) => d.homework.filter(h => h.status === k).length;
  shell(null, `
    <div class="page-head"><a class="btn ghost sm" href="#/c/${d.class.id}/room">← ${esc(d.class.name)} 課室</a>
      <h1>${s.number ?? ''} ${esc(s.name)}</h1><span class="chip gold num" style="font-size:1.1rem">${s.score} 分</span>${s.spent ? `<span class="chip good">可用 ${s.score - s.spent}・已兌換 ${s.spent}</span>` : ''}
      <button class="btn primary" data-act="give">加減分</button></div>
    <div class="profile">
      <section class="pet-card${hungerOf(s) ? ' hungry h' + hungerOf(s) : ''}">
        ${pet ? hungerBubble(s, true) : ''}${pet && d.homework.some(h => h.status === 'missing') ? `<div class="speech hw">${esc(homeworkMessage(s, d.homework.filter(h => h.status === 'missing')))}<small>${d.homework.filter(h => h.status === 'missing').map(h => esc(h.title)).join('、')}</small></div>` : ''}${avatar(s)}
        ${pet ? `<h2>${esc(petLabel(pet))}${pet.nickname ? `「${esc(pet.nickname)}」` : ''}</h2>
          <div class="muted small">${esc(speciesByKey[pet.species_key].element)}屬性 · 派蛋於 ${fmtDate(pet.assigned_at)}${pet.hatched_at ? ` · 孵化於 ${fmtDate(pet.hatched_at)}` : ''}</div>
          <div style="display:flex;justify-content:space-between" class="small"><span>XP <b class="num">${pet.xp}</b></span><span>${p.next ? `再 ${p.remaining} XP ${pet.stage === 'egg' ? '孵化' : '成為' + STAGE_LABELS[p.next]}` : '已完全進化'}</span></div>
          ${xpBar(pet, th)}
          <div class="timeline">${STAGES.map((st, i) => `<div class="${i <= STAGES.indexOf(pet.stage) ? '' : 'locked'} ${st === pet.stage ? 'cur' : ''}">${dexImage(pet.species_key, st)}<div class="t">${STAGE_LABELS[st]}</div></div>`).join('')}</div>
          <div class="row" style="justify-content:center"><button class="btn sm" data-act="rename">改名</button>${pet.stage === 'egg' ? '<button class="btn sm" data-act="swap">更換蛋</button>' : ''}</div>`
        : `<h2>未派蛋</h2><p class="muted small">到「寵物」頁為這位學生派蛋。派蛋之後的加分才會成為 XP。</p><a class="btn" href="#/c/${d.class.id}/pets">去派蛋</a>`}
      </section>
      <div class="stack">
        <section class="panel"><h2>功課</h2>
          <div class="row">${HW_STATUS.map(([k, l]) => `<span class="chip">${l} <b class="num">${hwCount(k)}</b></span>`).join('')}<span class="chip">共 <b class="num">${d.homework.length}</b> 份</span></div>
          ${d.homework.filter(h => h.status === 'missing' || h.status === 'late').length ? `<p class="small" style="margin-bottom:0">需要跟進：${d.homework.filter(h => h.status === 'missing' || h.status === 'late').map(h => `${esc(h.title)}（${HW_STATUS.find(x => x[0] === h.status)[1]}）`).join('、')}</p>` : ''}</section>
        <section class="panel"><h2>考試成績</h2><div class="table-wrap"><table><tbody>${d.exams.map(x => `<tr><td>${esc(x.title)}</td><td class="muted">${esc(x.subject)}</td><td class="num">${x.score ?? '—'}／${x.full_mark}</td></tr>`).join('') || '<tr><td class="muted">未有成績</td></tr>'}</tbody></table></div></section>
        <section class="panel"><h2>分數歷史</h2><div class="table-wrap"><table><thead><tr><th>時間</th><th>原因</th><th class="num">分數</th><th class="num">寵物 XP</th></tr></thead><tbody>
          ${d.events.map(e => `<tr style="${e.undone_at ? 'opacity:.45;text-decoration:line-through' : ''}"><td class="small">${fmtTime(e.created_at)}</td>
            <td class="small">${e.kind === 'import' ? '保留舊分數（匯入）' : esc(e.tag_label ? `${e.tag_icon} ${e.tag_label}` : e.reason || e.batch_label || '')}${e.stage_before && e.stage_before !== e.stage_after && !e.xp_reversed_at ? ` <span class="chip gold">${e.stage_before === 'egg' ? '孵化' : '升為' + STAGE_LABELS[e.stage_after]}</span>` : ''}</td>
            <td class="num" style="color:${e.delta > 0 ? 'var(--good)' : 'var(--bad)'}">${signed(e.delta)}</td><td class="num">${e.xp_gained && !e.xp_reversed_at ? '+' + e.xp_gained : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">未有紀錄</td></tr>'}
          </tbody></table></div></section>
      </div>
    </div>`);
  ACT.give = () => {
    pointSheet([s.id]);
    const obs = new MutationObserver(() => { if (!document.querySelector('dialog')) { obs.disconnect(); renderStudent(id).catch(fail); } });
    obs.observe(document.body, { childList: true });
  };
  ACT.rename = () => editDialog('寵物名字（最多 12 字，留空即取消）', pet.nickname || '', async (v) => { await PATCH(`/pets/${pet.id}`, { nickname: v }); await reloadClass(); renderStudent(id); });
  ACT.swap = () => {
    const dd = openDialog(`<div class="sheet-head"><h2>更換蛋（未孵化才可更換）</h2><button class="btn ghost" data-close>✕</button></div>
      <div class="species-pick">${SPECIES.map(sp => `<button data-sw="${sp.key}" aria-pressed="${sp.key === pet.species_key}">${dexImage(sp.key, 'egg')}${esc(sp.name)}</button>`).join('')}</div>`);
    dd.onclick = async (e) => { const b = e.target.closest('[data-sw]'); if (!b) return; try { await PATCH(`/pets/${pet.id}`, { species_key: b.dataset.sw }); dd.close(); await reloadClass(); renderStudent(id); } catch (err) { fail(err); } };
  };
}

// ---------- 管理員 ----------
function ago(iso) {
  if (!iso) return '從未';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 2) return '剛剛'; if (m < 60) return `${m} 分鐘前`;
  const h = Math.round(m / 60); if (h < 24) return `${h} 小時前`;
  const d = Math.round(h / 24); return d < 30 ? `${d} 日前` : fmtDate(iso);
}
async function renderAdmin() {
  if (!state.teacher?.is_admin) return go('#/classes');
  state.cls = null; state.classId = null;
  const t = navSeq; const { teachers } = await GET('/admin/teachers'); if (t !== navSeq || !here('admin')) return;
  const weekAgo = Date.now() - 7 * 864e5;
  const active = teachers.filter(x => x.last_seen_at && Date.parse(x.last_seen_at) >= weekAgo).length;
  const sum = (k) => teachers.reduce((a, x) => a + (x[k] || 0), 0);
  shell(null, `
    <div class="page-head"><a class="btn ghost sm" href="#/classes">← 班別</a><h1>🛡️ 管理員</h1></div>
    <p class="admin-note">管理員只可以睇到老師帳戶嘅使用情況同開咗邊啲班；睇唔到任何密碼、學生姓名、分數或者功課紀錄。</p>
    <div class="admin-stats">
      <div><b class="num">${teachers.length}</b><span>位老師</span></div>
      <div><b class="num">${active}</b><span>近 7 日有使用</span></div>
      <div><b class="num">${sum('class_count')}</b><span>個班別</span></div>
      <div><b class="num">${sum('student_count')}</b><span>位學生（只計人數）</span></div>
    </div>
    <div class="admin-list">${teachers.map(x => `<section class="panel admin-teacher">
      <div class="at-head"><div><h2>${esc(x.name)} ${x.is_admin ? '<span class="chip blue">管理員</span>' : ''}</h2><div class="muted small">${esc(x.email)}・${fmtDate(x.created_at)} 註冊</div></div>
        <span class="chip ${x.last_seen_at && Date.parse(x.last_seen_at) >= weekAgo ? 'good' : ''}">最後使用：${esc(ago(x.last_seen_at))}</span></div>
      <div class="at-grid">
        <div><span>最後登入</span><b>${esc(ago(x.last_login_at))}</b></div>
        <div><span>最後加分</span><b>${esc(ago(x.last_points_at))}</b></div>
        <div><span>近 7 日加分次數</span><b class="num">${x.actions_7d}</b></div>
        <div><span>近 30 日加分次數</span><b class="num">${x.actions_30d}</b></div>
      </div>
      <div class="section-label">班別（${x.class_count}）</div>
      <div class="row">${x.classes.map(c => `<span class="chip">${esc(c.name)}${c.school_year ? ` <span class="muted">${esc(c.school_year)}</span>` : ''}・${c.student_count} 人・${fmtDate(c.created_at)} 開</span>`).join('') || '<span class="muted small">未開班</span>'}</div>
    </section>`).join('')}</div>`);
}

// ---------- 設定 ----------
function renderSettings() {
  if (!here('settings')) return;
  const th = thresholds(); const tags = state.boot.tags;
  shell(null, `
    <div class="page-head"><a class="btn ghost sm" href="#/classes">← 班別</a><h1>設定</h1><span class="muted">${esc(state.teacher.name)} · ${esc(state.teacher.email)}</span>
      <button class="btn" data-act="logout">登出</button></div>
    <div class="grid-2" style="align-items:start">
      <section class="panel"><h2>寵物升級門檻（累積 XP）</h2>
        <form class="stack" data-form="th">
          <div class="row">${['baby', 'junior', 'adult', 'evolved'].map(k => `<label class="field"><span>${{ baby: '孵化成寶寶', junior: '少年', adult: '成年', evolved: '進化' }[k]}</span><input class="input num" id="th-${k}" name="${k}" type="number" min="1" value="${th[k]}" required></label>`).join('')}</div>
          <label class="field" style="max-width:320px"><span>幾多個上課日冇加分，寵物就會肚餓（周末唔計）</span>
            <select class="input" id="th-hunger" name="hunger_days">${[0, 2, 3, 4, 5, 7].map(n => `<option value="${n}"${n === hungerDays() ? ' selected' : ''}>${n ? n + ' 日（' + n * 2 + ' 日叫主人幫忙）' : '關閉肚餓提示'}</option>`).join('')}</select></label>
          <p class="muted small" style="margin:0">調低門檻會令已達標的寵物即時升級；調高門檻不會令寵物退化。扣分及撤銷都不會令寵物倒退。</p>
          <button class="btn primary">儲存門檻</button></form></section>
      <section class="panel"><h2>行為標籤</h2>
        <div class="stack" style="gap:6px">${tags.map(t => `<div class="status-row"><span style="font-size:1.3rem">${esc(t.icon)}</span><span class="who">${esc(t.label)}</span>
          <span class="chip ${t.points > 0 ? 'good' : 'bad'} num">${signed(t.points)}</span><button class="btn sm" data-act="edittag" data-id="${t.id}">修改</button><button class="btn sm danger" data-act="deltag" data-id="${t.id}">刪除</button></div>`).join('')}</div>
        <form class="row" data-form="newtag" style="margin-top:12px"><label class="field" style="flex:0 0 70px"><span>圖示</span><input class="input" id="nt-icon" name="icon" maxlength="4" value="⭐"></label>
          <label class="field"><span>標籤</span><input class="input" id="nt-label" name="label" maxlength="16" required placeholder="例如：主動清潔"></label>
          <label class="field" style="flex:0 0 90px"><span>分數</span><input class="input num" id="nt-pts" name="points" type="number" min="-20" max="20" value="1" required></label><button class="btn blue">新增</button></form></section>
      <section class="panel"><h2>🎁 獎勵兌換</h2>
        <p class="muted small" style="margin-top:0">學生用「可用分數」兌換，總分紀錄及寵物 XP 不受影響。</p>
        <div class="stack" style="gap:6px">${(state.boot.rewards || []).map(r => `<div class="status-row"><span style="font-size:1.3rem">${esc(r.icon)}</span><span class="who">${esc(r.title)}</span>
          <span class="chip gold num">${r.cost} 分</span><button class="btn sm" data-act="editreward" data-id="${r.id}">修改</button><button class="btn sm danger" data-act="delreward" data-id="${r.id}">刪除</button></div>`).join('')}</div>
        <form class="row" data-form="newreward" style="margin-top:12px"><label class="field" style="flex:0 0 70px"><span>圖示</span><input class="input" id="nr-icon" name="icon" maxlength="4" value="🎁"></label>
          <label class="field"><span>獎勵</span><input class="input" id="nr-title" name="title" maxlength="20" required placeholder="例如：玩桌遊"></label>
          <label class="field" style="flex:0 0 90px"><span>分數</span><input class="input num" id="nr-cost" name="cost" type="number" min="1" max="1000" value="10" required></label><button class="btn blue">新增</button></form></section>
      <section class="panel"><h2>班別</h2>
        <div class="stack" style="gap:6px">${state.boot.classes.map(c => `<div class="status-row"><span class="who">${esc(c.name)} <span class="muted small">${esc(c.school_year)} · ${c.student_count} 人</span></span>
          <button class="btn sm" data-act="renclass" data-id="${c.id}">改名</button><button class="btn sm danger" data-act="delclass" data-id="${c.id}">刪除</button></div>`).join('')}</div></section>
      <section class="panel"><h2>資料一致性檢查</h2><p class="muted small">核對每隻寵物的 XP、階段及每位學生的總分是否與紀錄完全相符。</p>
        <button class="btn" data-act="audit">立即檢查</button><div id="audit-out" style="margin-top:10px"></div></section>
    </div>`);
  ACT['submit:th'] = async (_f, fd) => {
    const all = Object.fromEntries([...fd].map(([k, v]) => [k, Number(v)]));
    const { hunger_days, ...thr } = all;
    const r = await PUT('/settings', { thresholds: thr, hunger_days });
    await reloadBoot(); state.cls = null; state.classId = null; toast(r.upgraded ? `已儲存，${r.upgraded} 隻寵物即時升級` : '已儲存門檻'); renderSettings();
  };
  ACT['submit:newtag'] = async (_f, fd) => { await POST('/tags', Object.fromEntries(fd)); await reloadBoot(); renderSettings(); };
  ACT.edittag = (el) => {
    const t = tags.find(x => x.id === Number(el.dataset.id));
    const d = openDialog(`<form class="stack" data-f><label class="field"><span>圖示</span><input class="input" id="et-icon" name="icon" maxlength="4" value="${esc(t.icon)}"></label>
      <label class="field"><span>標籤</span><input class="input" id="et-label" name="label" maxlength="16" value="${esc(t.label)}" required></label>
      <label class="field"><span>分數</span><input class="input num" id="et-pts" name="points" type="number" min="-20" max="20" value="${t.points}" required></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>取消</button><button class="btn primary">儲存</button></div></form>`);
    d.querySelector('[data-f]').onsubmit = async (e) => { e.preventDefault(); try { await PATCH(`/tags/${t.id}`, Object.fromEntries(new FormData(e.target))); d.close(); await reloadBoot(); renderSettings(); } catch (err) { fail(err); } };
  };
  ACT['submit:newreward'] = async (_f, fd) => { state.boot.rewards = await POST('/rewards', Object.fromEntries(fd)); renderSettings(); };
  ACT.editreward = (el) => {
    const r = state.boot.rewards.find(x => x.id === Number(el.dataset.id));
    const d = openDialog(`<form class="stack" data-f><label class="field"><span>圖示</span><input class="input" id="er-icon" name="icon" maxlength="4" value="${esc(r.icon)}"></label>
      <label class="field"><span>獎勵</span><input class="input" id="er-title" name="title" maxlength="20" value="${esc(r.title)}" required></label>
      <label class="field"><span>所需分數</span><input class="input num" id="er-cost" name="cost" type="number" min="1" max="1000" value="${r.cost}" required></label>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>取消</button><button class="btn primary">儲存</button></div></form>`);
    d.querySelector('[data-f]').onsubmit = async (e) => { e.preventDefault(); try { state.boot.rewards = await PATCH(`/rewards/${r.id}`, Object.fromEntries(new FormData(e.target))); d.close(); renderSettings(); } catch (err) { fail(err); } };
  };
  ACT.delreward = async (el) => { if (await confirmBox('刪除此獎勵？過往兌換紀錄會保留。', { ok: '刪除', danger: true })) { state.boot.rewards = await DEL(`/rewards/${el.dataset.id}`); renderSettings(); } };
  ACT.deltag = async (el) => { if (await confirmBox('刪除此標籤？過往紀錄會保留分數。', { ok: '刪除', danger: true })) { await DEL(`/tags/${el.dataset.id}`); await reloadBoot(); renderSettings(); } };
  ACT.renclass = (el) => editDialog('班別名稱', state.boot.classes.find(c => c.id === Number(el.dataset.id)).name, async (v) => { await PATCH(`/classes/${el.dataset.id}`, { name: v }); await reloadBoot(); renderSettings(); });
  ACT.delclass = async (el) => {
    const c = state.boot.classes.find(x => x.id === Number(el.dataset.id));
    if (await confirmBox(`刪除 ${c.name}？全班學生、分數、功課、成績及寵物都會刪除，不能復原。`, { ok: '永久刪除', danger: true })) { await DEL(`/classes/${c.id}`); state.cls = null; state.classId = null; await reloadBoot(); renderSettings(); }
  };
  ACT.audit = async () => {
    const r = await GET('/audit');
    $('#audit-out').innerHTML = r.problems.length ? `<div class="chip bad">發現 ${r.problems.length} 個問題</div><ul class="small">${r.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : `<div class="chip good">全部一致（已核對 ${r.pets} 隻寵物）</div>`;
  };
  ACT.logout = async () => { await POST('/auth/logout'); state.teacher = null; state.boot = null; state.cls = null; state.classId = null; go('#/login'); };
}

route();
