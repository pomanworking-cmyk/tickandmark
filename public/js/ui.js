// 介面共用工具：轉義、提示、確認、寵物頭像、加分祝賀。
import { petImageUrl, petLabel, progressInfo, STAGE_LABELS, speciesByKey } from '../shared/pet-logic.js';

export const ASSET_BASE = globalThis.TM_ASSET_BASE || '';
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getMonth() + 1}月${d.getDate()}日`; };
export const fmtTime = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

export const ICON = {
  tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
};

// ---------- 寵物頭像：全站只用這一個函數 ----------
// 有寵物 → 依 StudentPet.species_key + stage 取圖；未派蛋 → 姓名首字。
export function avatar(student, size) {
  const style = size ? ` style="--size:${typeof size === 'number' ? size + 'px' : size}"` : '';
  const pet = student?.pet;
  if (!pet) {
    return `<span class="avatar" data-student="${student?.id ?? ''}" data-species="none" data-stage="none"${style}><span class="initial" aria-label="${esc(student?.name)}（未派蛋）">${esc((student?.name || '?').slice(-1))}</span></span>`;
  }
  if (pet.student_record_id !== student.id) throw new Error('寵物與學生對應錯誤'); // 防止錯配
  return `<span class="avatar" data-student="${student.id}" data-species="${pet.species_key}" data-stage="${pet.stage}"${style}><img src="${petImageUrl(pet, ASSET_BASE)}" alt="${esc(petLabel(pet))}" loading="lazy" draggable="false"></span>`;
}
// 圖鑑用：品種＋階段（不屬於任何學生）
export function dexImage(species_key, stage, extraClass = '') {
  return `<span class="avatar ${extraClass}" data-species="${species_key}" data-stage="${stage}"><img src="${petImageUrl({ species_key, stage }, ASSET_BASE)}" alt="${esc(speciesByKey[species_key].name + STAGE_LABELS[stage])}" loading="lazy"></span>`;
}
export function xpBar(pet, thresholds) {
  if (!pet) return '';
  const p = progressInfo(pet, thresholds);
  return `<div class="xpbar" title="XP ${pet.xp}"><i style="width:${p.pct}%"></i></div>`;
}
export function petStatus(pet, thresholds) {
  if (!pet) return '未派蛋';
  const p = progressInfo(pet, thresholds);
  return p.next ? `${petLabel(pet)} · XP ${pet.xp}／${p.need}` : `${petLabel(pet)} · XP ${pet.xp}（已完全進化）`;
}

// ---------- 提示 ----------
export function toast(msg, { error = false, action, actionLabel, ms = 3200 } = {}) {
  let box = $('.toasts'); if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = 'toast' + (error ? ' err' : '');
  t.innerHTML = `<span style="flex:1">${esc(msg)}</span>`;
  if (action) { const b = document.createElement('button'); b.className = 'btn'; b.textContent = actionLabel; b.onclick = () => { t.remove(); action(); }; t.appendChild(b); }
  box.appendChild(t); while (box.children.length > 2) box.firstElementChild.remove(); setTimeout(() => t.remove(), action ? ms + 3000 : ms);
}

// ---------- 對話框（不使用 alert/confirm） ----------
export function openDialog(html, { full = false, onClose } = {}) {
  const d = document.createElement('dialog'); if (full) d.className = 'full';
  d.innerHTML = `<div class="sheet" tabindex="-1" autofocus>${html}</div>`;
  document.body.appendChild(d);
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); if (e.target.closest('[data-close]')) d.close(); });
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  d.showModal();
  return d;
}
export function confirmBox(message, { ok = '確定', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const d = openDialog(`<p style="font-size:1.05rem;margin:4px 0 18px">${esc(message)}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-close>取消</button><button class="btn ${danger ? 'primary' : 'blue'}" data-ok>${esc(ok)}</button></div>`,
      { onClose: () => { if (!answered) resolve(false); } });
    d.querySelector('[data-ok]').onclick = () => { answered = true; resolve(true); d.close(); };
  });
}

// ---------- 加分祝賀彈窗 ----------
const stageWord = (from, to) => (from === 'egg' ? '孵化了！' : `進化成${STAGE_LABELS[to]}！`);
export function celebrate(results, { label, thresholds }) {
  const pos = results.filter(r => r.delta > 0);
  if (!pos.length) return;
  document.querySelector('.celebrate')?.remove();
  const el = document.createElement('div'); el.className = 'celebrate'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', '加分');
  let inner;
  if (pos.length === 1) {
    const r = pos[0]; const st = { id: r.student_id, name: r.name, pet: r.pet };
    const before = r.pet ? { ...r.pet, xp: r.pet.xp - r.xp_gained, stage: r.stage_before || r.pet.stage } : null;
    const pb = before ? progressInfo(before, thresholds).pct : 0;
    const pa = r.pet ? progressInfo(r.pet, thresholds) : null;
    inner = `<div class="cele-card" data-cele-student="${r.student_id}">
      ${avatar(st)}
      <div class="who">${esc(r.name)}</div>
      <div class="delta num">+${r.delta}</div>
      <div class="what">${esc(label || '')}</div>
      ${r.pet ? `<div class="xpline"><span>${esc(petLabel(r.pet))}${r.pet.nickname ? `「${esc(r.pet.nickname)}」` : ''}</span><span class="num">XP ${r.pet.xp}${pa.next ? '／' + pa.need : ''}</span></div>
        <div class="xpbar"><i style="width:${r.leveled_up ? 0 : pb}%" data-to="${pa.pct}"></i></div>` : '<div class="muted small" style="margin-top:8px">未派蛋，派蛋後的加分才會成為寵物 XP</div>'}
      ${r.leveled_up ? `<div class="levelup">${esc(stageWord(r.stage_before, r.stage_after))}</div>` : ''}
    </div>`;
  } else {
    inner = `<div class="cele-card" style="width:min(640px,100%)">
      <div class="delta num">+${pos[0].delta}</div><div class="what">${esc(label || '')} · ${pos.length} 位同學</div>
      <div class="cele-multi">${pos.map((r, i) => `<div class="m" style="animation-delay:${Math.min(i, 20) * 40}ms" data-cele-student="${r.student_id}">
        ${avatar({ id: r.student_id, name: r.name, pet: r.pet })}<b>${esc(r.name)}</b>${r.leveled_up ? `<span class="lv">${esc(stageWord(r.stage_before, r.stage_after))}</span>` : ''}</div>`).join('')}</div>
    </div>`;
  }
  el.innerHTML = inner;
  document.body.appendChild(el);
  const card = el.querySelector('.cele-card');
  for (let i = 0; i < 18; i++) {
    const s = document.createElement('i'); s.className = 'spark';
    const a = (Math.PI * 2 * i) / 18; const d = 120 + Math.random() * 80;
    s.style.cssText = `left:50%;top:38%;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d}px;background:${['var(--gold)', 'var(--accent)', 'var(--blue)', 'var(--good)'][i % 4]}`;
    card.appendChild(s);
  }
  requestAnimationFrame(() => requestAnimationFrame(() => { const bar = el.querySelector('[data-to]'); if (bar) bar.style.width = bar.dataset.to + '%'; }));
  const close = () => el.remove();
  el.addEventListener('click', close);
  setTimeout(close, pos.length === 1 ? 2600 : 3200);
}
