// Tick and Mark 前端（繁體中文單頁應用）
import { GET, POST, PUT, PATCH, DEL, uid, IS_DEMO } from './api.js';
import { esc, $, $$, avatar, dexImage, xpBar, petStatus, toast, openDialog, confirmBox, celebrate, ICON, fmtDate, fmtTime, signed } from './ui.js';
import { SPECIES, STAGES, STAGE_LABELS, speciesByKey, petLabel, progressInfo } from '../shared/pet-logic.js';
import { readFileToStudents, textToStudents, ocrImage } from './importer.js';

const app = document.getElementById('app');
const state = { teacher: null, boot: null, cls: null, classId: null, importRows: [], hwCache: null };
const store = {
  get(k, d) { try { const v = localStorage.getItem('tm.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tm.' + k, JSON.stringify(v)); } catch { /* 私密瀏覽 */ } },
};
const room = { q: '', sort: store.get('sort', 'number'), size: store.get('size', 'm'), multi: false, sel: new Set() };
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
        <a class="brand" href="#/classes"><span class="brand-mark">${ICON.tick}</span><span>Tick and Mark</span></a>
        ${c ? `<select class="input class-switch" id="class-switch" aria-label="切換班別">${classes.map(x => `<option value="${x.id}"${x.id === c.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
        <span class="spacer"></span>
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
  ACT = {}; app.onclick = app.oninput = app.onchange = null;
  const my = ++navSeq;
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
      if (state.classId !== id || !state.cls) { const full = await GET(`/classes/${id}/full`); if (my !== navSeq) return; state.cls = full; state.classId = id; room.sel.clear(); }
      const v = parts[2] || 'room';
      store.set('lastClass', id);
      const views = { room: renderRoom, students: renderStudents, homework: renderHomework, exams: renderExams, history: renderHistory, pets: renderPets, poster: renderPoster };
      return (views[v] || renderRoom)(parts[3] ? Number(parts[3]) : null);
    }
    if (parts[0] === 's') return renderStudent(Number(parts[1]));
    if (parts[0] === 'settings') return renderSettings();
    return renderHome();
  } catch (e) {
    if (e.status === 404 && parts[0] === 'c') { state.classId = null; state.cls = null; toast(e.message, { error: true }); return go('#/classes'); }
    fail(e);
  }
}
async function reloadClass() { state.cls = await GET(`/classes/${state.classId}/full`); }
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
async function givePoints(ids, { delta, tag, reason }) {
  const body = { class_id: state.classId, student_ids: [...ids], client_batch_id: uid(), ...(tag ? { tag_id: tag.id } : { delta, reason }) };
  let res;
  try { res = await POST('/points', body); }
  catch (e) { if (e.status === 0) res = await POST('/points', body); else throw e; } // 斷線重送：同一操作編號，不會重複加分
  for (const r of res.results) {
    const s = students().find(x => x.id === r.student_id);
    if (s) { s.score = r.score; s.pet = r.pet; }
  }
  const label = res.label;
  const d = res.results[0]?.delta ?? 0;
  if (d > 0) celebrate(res.results, { label, thresholds: thresholds() });
  const names = res.results.length > 3 ? `${res.results.length} 位同學` : res.results.map(r => r.name).join('、');
  toast(`${names} ${signed(d)}（${label}）`, { action: () => undoBatch(res.batch_id), actionLabel: '撤銷' });
  return res;
}
async function undoBatch(id) {
  const r = await POST(`/batches/${id}/undo`);
  for (const x of r.results) { const s = students().find(s => s.id === x.student_id); if (s) { s.score = x.score; s.pet = x.pet; } }
  toast(`已撤銷：${r.label}`);
  if (location.hash.includes('/room')) drawRoomGrid(); else route();
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
    ${list.length === 1 ? `<div style="margin-top:12px;text-align:right"><a class="btn ghost sm" href="#/s/${list[0].id}">查看學生資料 →</a></div>` : ''}`);
  const done = async (opts) => {
    $$('button', d).forEach(b => { b.disabled = true; });
    try { await givePoints(ids, opts); d.close(); room.sel.clear(); room.multi = false; if ($('#room-grid')) renderRoom(); }
    catch (e) { fail(e); $$('button', d).forEach(b => { b.disabled = false; }); }
  };
  d.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tag]'); if (t) return done({ tag: tags.find(x => x.id === Number(t.dataset.tag)) });
    const q = e.target.closest('[data-d]'); if (q) return done({ delta: Number(q.dataset.d) });
  });
  d.querySelector('[data-custom]').addEventListener('submit', (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    const delta = Number(fd.get('delta')); if (!Number.isInteger(delta) || !delta) return toast('分數須為非零整數', { error: true });
    done({ delta, reason: String(fd.get('reason') || '') });
  });
}

// ---------- 課室模式 ----------
function filteredStudents() {
  const q = room.q.trim();
  let list = students().slice();
  if (q) list = /^\d+$/.test(q) ? list.filter(s => String(s.number ?? '').startsWith(q)) : list.filter(s => s.name.includes(q));
  if (room.sort === 'score') list.sort((a, b) => b.score - a.score || (a.number ?? 999) - (b.number ?? 999));
  else if (room.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  return list;
}
function renderRoom() {
  const groups = state.cls.groups;
  shell('room', `
    <div class="room-tools">
      <label class="search">${ICON.search}<input id="room-search" type="search" placeholder="班號或姓名，Enter 加分" autocomplete="off" value="${esc(room.q)}" aria-label="搜尋學生"></label>
      <select class="input" id="room-sort" style="width:auto" aria-label="排序">
        <option value="number">按班號</option><option value="score">按分數</option><option value="name">按姓名</option></select>
      <div class="seg" aria-label="大小">${['s', 'm', 'l'].map(z => `<button data-act="size" data-v="${z}" aria-pressed="${room.size === z}">${{ s: '小', m: '中', l: '大' }[z]}</button>`).join('')}</div>
      <button class="btn" data-act="multi" aria-pressed="${room.multi}">多選</button>
      <button class="btn" data-act="all">全班加分</button>
      <button class="btn" data-act="timer">⏱ 計時</button>
      <button class="btn" data-act="recent">最近操作</button>
    </div>
    ${groups.length ? `<div class="group-row">${groups.map(g => {
      const mem = students().filter(s => s.group_id === g.id);
      return `<span class="group-chip" style="--gc:${esc(g.color)}" data-act="group" data-id="${g.id}"><span class="dot"></span>${esc(g.name)} <span class="num muted">${mem.reduce((a, s) => a + s.score, 0)}</span><span class="plus" data-act="groupplus" data-id="${g.id}">+1</span></span>`;
    }).join('')}</div>` : ''}
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
    if (pick) { pointSheet([pick.id]); room.q = ''; search.value = ''; drawRoomGrid(); }
  });
  $('#room-sort').onchange = (e) => { room.sort = e.target.value; store.set('sort', room.sort); drawRoomGrid(); };
  if (matchMedia('(pointer:fine)').matches) search.focus();

  ACT.size = (el) => { room.size = el.dataset.v; store.set('size', room.size); $$('[data-act=size]').forEach(b => b.setAttribute('aria-pressed', b === el)); drawRoomGrid(); };
  ACT.multi = (el) => { room.multi = !room.multi; if (!room.multi) room.sel.clear(); el.setAttribute('aria-pressed', room.multi); drawRoomGrid(); };
  ACT.all = () => pointSheet(students().map(s => s.id));
  ACT.group = (el, e) => {
    if (e.target.closest('[data-act=groupplus]')) return;
    const ids = students().filter(s => s.group_id === Number(el.dataset.id)).map(s => s.id);
    if (!ids.length) return toast('此小組未有組員，請到「學生及分組」編排');
    pointSheet(ids);
  };
  ACT.groupplus = async (el) => {
    const g = groups.find(x => x.id === Number(el.dataset.id));
    const ids = students().filter(s => s.group_id === g.id).map(s => s.id);
    if (!ids.length) return toast('此小組未有組員');
    await givePoints(ids, { delta: 1, reason: `${g.name} 小組加分` }); renderRoom();
  };
  ACT.stu = (el) => {
    const id = Number(el.dataset.id);
    if (room.multi) { room.sel.has(id) ? room.sel.delete(id) : room.sel.add(id); drawRoomGrid(); }
    else pointSheet([id]);
  };
  ACT.selgo = () => pointSheet([...room.sel]);
  ACT.selclear = () => { room.sel.clear(); drawRoomGrid(); };
  ACT.timer = () => openTimer();
  ACT.recent = () => recentDialog();
  drawRoomGrid();
}
function drawRoomGrid() {
  const grid = $('#room-grid'); if (!grid) return;
  const list = filteredStudents();
  grid.className = `students-grid size-${room.size}`;
  grid.innerHTML = list.length ? list.map(s => {
    const g = groupOf(s);
    return `<div class="stu${room.sel.has(s.id) ? ' sel' : ''}" role="button" tabindex="0" data-act="stu" data-id="${s.id}" ${g ? `style="--gc:${esc(g.color)}"` : ''} aria-label="${esc(s.name)}，${s.score} 分">
      <span class="no">${s.number ?? ''}</span><span class="sc${s.score < 0 ? ' neg' : ''}">${s.score}</span>
      ${avatar(s)}<span class="nm">${esc(s.name)}</span>${g ? '<span class="gbar"></span>' : ''}</div>`;
  }).join('') : `<div class="empty" style="grid-column:1/-1">${students().length ? '<strong>找不到相符的學生</strong>試試輸入班號或姓名中的一個字。' : `<strong>此班未有學生</strong><a href="#/c/${state.classId}/students">到「學生及分組」匯入名單</a>`}</div>`;
  grid.onkeydown = (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.act === 'stu') { e.preventDefault(); ACT.stu(e.target); } };
  const bar = $('#selbar');
  if (bar) bar.innerHTML = room.multi ? `<div class="selbar"><span>已選 <b class="num">${room.sel.size}</b> 位</span>
    <button class="btn sm" data-act="selclear">清除</button><button class="btn primary" data-act="selgo" ${room.sel.size ? '' : 'disabled'}>給分</button></div>` : '';
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
  const sb = $('#timer-start'); if (sb) sb.textContent = timer.running ? '暫停' : '開始';
  let mini = $('.timer-mini');
  const show = (timer.running || timer.done) && !$('#timer-face');
  if (show && !mini) { mini = document.createElement('button'); mini.className = 'timer-mini'; mini.onclick = openTimer; document.body.appendChild(mini); }
  if (mini) { if (!show) mini.remove(); else { mini.textContent = mmss(timer.remain); mini.style.color = timer.done ? 'var(--bad)' : ''; } }
}
function openTimer() {
  const presets = state.boot.timer_presets || [60, 180, 300, 600];
  const d = openDialog(`<div class="sheet-head"><h2>課堂計時</h2><button class="btn ghost" data-close>✕</button></div>
    <div class="timer-face" id="timer-face">${mmss(timer.remain)}</div>
    <div class="row" style="justify-content:center">${presets.map(s => `<button class="btn" data-set="${s}">${s >= 60 ? s / 60 + ' 分鐘' : s + ' 秒'}</button>`).join('')}
      <button class="btn" data-add="60">+1 分鐘</button></div>
    <div class="row" style="justify-content:center"><button class="btn primary" id="timer-start" style="min-width:140px;min-height:56px;font-size:1.2rem">${timer.running ? '暫停' : '開始'}</button>
      <button class="btn" data-reset style="min-height:56px">重設</button><button class="btn" data-fs style="min-height:56px">全螢幕</button></div>`, { full: true, onClose: paintTimer });
  d.addEventListener('click', (e) => {
    const t = e.target;
    if (t.dataset.set) { timer.total = timer.remain = Number(t.dataset.set); timer.running = false; timer.done = false; }
    if (t.dataset.add) { timer.remain += 60; timer.total = Math.max(timer.total, timer.remain); if (timer.running) timer.endAt += 60000; timer.done = false; }
    if (t.id === 'timer-start') {
      if (timer.running) timer.running = false;
      else { if (timer.remain <= 0) timer.remain = timer.total; timer.done = false; timer.running = true; timer.endAt = Date.now() + timer.remain * 1000; timerLoop(); }
    }
    if ('reset' in t.dataset) { timer.running = false; timer.done = false; timer.remain = timer.total; }
    if ('fs' in t.dataset) { (document.fullscreenElement ? document.exitFullscreen() : d.requestFullscreen?.())?.catch?.(() => {}); }
    paintTimer();
  });
}

// ---------- 學生及分組 ----------
function renderStudents() {
  const list = students(); const groups = state.cls.groups;
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
      <h2>學生名單</h2>
      ${list.length ? `<div class="table-wrap"><table><thead><tr><th class="num">班號</th><th></th><th>姓名</th><th>小組</th><th class="num">分數</th><th>寵物</th><th></th></tr></thead><tbody>
      ${list.map(s => `<tr><td class="num">${s.number ?? ''}</td><td>${avatar(s, 44)}</td><td><a href="#/s/${s.id}">${esc(s.name)}</a></td>
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
  app.onchange = async (e) => {
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
  const t = navSeq; const list = await GET(`/classes/${state.classId}/homework`); if (t !== navSeq) return;
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
  const t = navSeq; const { homework: h, entries } = await GET(`/homework/${hid}/submissions`); if (t !== navSeq) return;
  const st = new Map(entries.map(e => [e.student_id, e.status]));
  const draw = () => {
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
    const sid = Number(b.dataset.hw); const v = st.get(sid) === b.dataset.v ? null : b.dataset.v;
    try { await PUT(`/homework/${h.id}/submissions`, { entries: [{ student_id: sid, status: v }] }); v ? st.set(sid, v) : st.delete(sid); draw(); } catch (err) { fail(err); }
  };
  ACT.allsub = async () => {
    const entries2 = students().filter(s => !st.has(s.id)).map(s => ({ student_id: s.id, status: 'submitted' }));
    if (!entries2.length) return toast('全部已有紀錄');
    await PUT(`/homework/${h.id}/submissions`, { entries: entries2 }); entries2.forEach(e => st.set(e.student_id, 'submitted')); draw();
  };
  ACT.delhw = async () => { if (await confirmBox(`刪除「${h.title}」及所有提交紀錄？`, { ok: '刪除', danger: true })) { await DEL(`/homework/${h.id}`); app.onclick = null; go(`#/c/${state.classId}/homework`); } };
  window.addEventListener('hashchange', () => { app.onclick = null; }, { once: true });
}

// ---------- 考試 ----------
async function renderExams(eid) {
  if (eid) return renderExamDetail(eid);
  const t = navSeq; const list = await GET(`/classes/${state.classId}/exams`); if (t !== navSeq) return;
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
  const t = navSeq; const { exam: x, scores } = await GET(`/exams/${eid}/scores`); if (t !== navSeq) return;
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
  const t = navSeq; const [batches, events] = await Promise.all([GET(`/classes/${state.classId}/batches?limit=30`), GET(`/classes/${state.classId}/events`)]); if (t !== navSeq) return;
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
        <span class="small muted">${esc(petLabel(s.pet))}${s.pet.nickname ? `「${esc(s.pet.nickname)}」` : ''} · XP ${s.pet.xp}</span>${xpBar(s.pet, th)}</span></a>`).join('') || '<div class="empty">未有學生獲派蛋</div>'}</div></section>
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
  const opts = { period: store.get('pPeriod', 'week'), theme: store.get('pTheme', 'coral'), top: store.get('pTop', 10), title: store.get('pTitle', '本週之星') };
  const since = () => {
    if (opts.period === 'all') return '';
    const d = new Date(); d.setHours(0, 0, 0, 0);
    if (opts.period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); else d.setDate(1);
    return d.toISOString();
  };
  const draw = async () => {
    const t = navSeq; const lb = await GET(`/classes/${state.classId}/leaderboard?since=${encodeURIComponent(since())}`); if (t !== navSeq) return;
    const key = opts.period === 'all' ? 'score' : 'gained';
    const ranked = lb.students.slice().sort((a, b) => b[key] - a[key] || (a.number ?? 99) - (b.number ?? 99));
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
          <div class="podium">${[top3[1], top3[0], top3[2]].map((s, i) => s ? `<div class="p p${[2, 1, 3][i]}">${avatar(s)}
            <div class="base"><div class="rank">${[2, 1, 3][i]}</div><div class="pn">${esc(s.name)}</div><div class="pp">${s[key]} 分</div></div></div>` : '<div></div>').join('')}</div>
          ${rest.length ? `<div class="honor">${rest.map((s, i) => `<div><span class="r">${i + 4}</span>${avatar(s)}<span>${esc(s.name)}</span><span class="g">${s[key]}</span></div>`).join('')}</div>` : ''}
          <div class="garden">${lb.students.filter(s => s.pet).map(s => avatar(s)).join('')}</div>
          <div class="foot">Tick and Mark · 每一分都是進步</div>
        </div></div></div>`);
    $('#po-period').value = opts.period; $('#po-top').value = String(opts.top); $('#po-theme').value = opts.theme;
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

// ---------- 學生資料頁 ----------
async function renderStudent(id) {
  const t = navSeq; const d = await GET(`/students/${id}`); if (t !== navSeq) return;
  const s = d.student; const th = d.thresholds; const pet = s.pet;
  if (state.classId !== d.class.id) { const full = await GET(`/classes/${d.class.id}/full`); if (t !== navSeq) return; state.cls = full; state.classId = d.class.id; }
  const p = pet && progressInfo(pet, th);
  const hwCount = (k) => d.homework.filter(h => h.status === k).length;
  shell(null, `
    <div class="page-head"><a class="btn ghost sm" href="#/c/${d.class.id}/room">← ${esc(d.class.name)} 課室</a>
      <h1>${s.number ?? ''} ${esc(s.name)}</h1><span class="chip gold num" style="font-size:1.1rem">${s.score} 分</span>
      <button class="btn primary" data-act="give">加減分</button></div>
    <div class="profile">
      <section class="pet-card">
        ${avatar(s)}
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

// ---------- 設定 ----------
function renderSettings() {
  const th = thresholds(); const tags = state.boot.tags;
  shell(null, `
    <div class="page-head"><a class="btn ghost sm" href="#/classes">← 班別</a><h1>設定</h1><span class="muted">${esc(state.teacher.name)} · ${esc(state.teacher.email)}</span>
      <button class="btn" data-act="logout">登出</button></div>
    <div class="grid-2" style="align-items:start">
      <section class="panel"><h2>寵物升級門檻（累積 XP）</h2>
        <form class="stack" data-form="th">
          <div class="row">${['baby', 'junior', 'adult', 'evolved'].map(k => `<label class="field"><span>${{ baby: '孵化成寶寶', junior: '少年', adult: '成年', evolved: '進化' }[k]}</span><input class="input num" id="th-${k}" name="${k}" type="number" min="1" value="${th[k]}" required></label>`).join('')}</div>
          <p class="muted small" style="margin:0">調低門檻會令已達標的寵物即時升級；調高門檻不會令寵物退化。扣分及撤銷都不會令寵物倒退。</p>
          <button class="btn primary">儲存門檻</button></form></section>
      <section class="panel"><h2>行為標籤</h2>
        <div class="stack" style="gap:6px">${tags.map(t => `<div class="status-row"><span style="font-size:1.3rem">${esc(t.icon)}</span><span class="who">${esc(t.label)}</span>
          <span class="chip ${t.points > 0 ? 'good' : 'bad'} num">${signed(t.points)}</span><button class="btn sm" data-act="edittag" data-id="${t.id}">修改</button><button class="btn sm danger" data-act="deltag" data-id="${t.id}">刪除</button></div>`).join('')}</div>
        <form class="row" data-form="newtag" style="margin-top:12px"><label class="field" style="flex:0 0 70px"><span>圖示</span><input class="input" id="nt-icon" name="icon" maxlength="4" value="⭐"></label>
          <label class="field"><span>標籤</span><input class="input" id="nt-label" name="label" maxlength="16" required placeholder="例如：主動清潔"></label>
          <label class="field" style="flex:0 0 90px"><span>分數</span><input class="input num" id="nt-pts" name="points" type="number" min="-20" max="20" value="1" required></label><button class="btn blue">新增</button></form></section>
      <section class="panel"><h2>班別</h2>
        <div class="stack" style="gap:6px">${state.boot.classes.map(c => `<div class="status-row"><span class="who">${esc(c.name)} <span class="muted small">${esc(c.school_year)} · ${c.student_count} 人</span></span>
          <button class="btn sm" data-act="renclass" data-id="${c.id}">改名</button><button class="btn sm danger" data-act="delclass" data-id="${c.id}">刪除</button></div>`).join('')}</div></section>
      <section class="panel"><h2>資料一致性檢查</h2><p class="muted small">核對每隻寵物的 XP、階段及每位學生的總分是否與紀錄完全相符。</p>
        <button class="btn" data-act="audit">立即檢查</button><div id="audit-out" style="margin-top:10px"></div></section>
    </div>`);
  ACT['submit:th'] = async (_f, fd) => {
    const r = await PUT('/settings', { thresholds: Object.fromEntries([...fd].map(([k, v]) => [k, Number(v)])) });
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
