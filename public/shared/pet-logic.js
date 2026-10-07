// Tick and Mark — 寵物系統共用邏輯（伺服器、瀏覽器、測試共用同一份）
// 規則：StudentPet 是學生寵物的唯一資料來源；畫面只可經 petImageUrl() 取圖。

export const STAGES = ['egg', 'baby', 'junior', 'adult', 'evolved'];
export const STAGE_LABELS = { egg: '蛋', baby: '寶寶', junior: '少年', adult: '成年', evolved: '進化' };

export const SPECIES = [
  { key: 'fire_fox',    name: '火狐狸', element: '火', color: '#e8553d' },
  { key: 'metal_cat',   name: '金貓',   element: '金', color: '#d99a1e' },
  { key: 'wood_deer',   name: '木鹿',   element: '木', color: '#5a9a3a' },
  { key: 'water_otter', name: '水獺',   element: '水', color: '#2f86c9' },
  { key: 'earth_bear',  name: '土熊',   element: '土', color: '#a86a2c' },
  { key: 'metal_bird',  name: '金鳥',   element: '金', color: '#c99419' },
  { key: 'wood_rabbit', name: '木兔',   element: '木', color: '#e07a8f' },
  { key: 'water_koi',   name: '水錦鯉', element: '水', color: '#3156c4' },
];
export const SPECIES_KEYS = SPECIES.map(s => s.key);
export const speciesByKey = Object.fromEntries(SPECIES.map(s => [s.key, s]));

// 達到某階段所需的累積寵物 XP（老師可改）。egg 永遠是 0。
export const DEFAULT_THRESHOLDS = { baby: 5, junior: 20, adult: 50, evolved: 100 };

export function normalizeThresholds(t) {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const k of ['baby', 'junior', 'adult', 'evolved']) {
    const v = Number(t?.[k]);
    if (Number.isFinite(v) && v >= 1) out[k] = Math.round(v);
  }
  // 門檻必須遞增
  if (!(out.baby < out.junior && out.junior < out.adult && out.adult < out.evolved)) {
    throw new Error('升級門檻必須由小至大：孵化 < 少年 < 成年 < 進化');
  }
  return out;
}

export function stageIndex(stage) {
  const i = STAGES.indexOf(stage);
  if (i < 0) throw new Error(`未知階段：${stage}`);
  return i;
}

export function stageForXp(xp, thresholds = DEFAULT_THRESHOLDS) {
  let s = 'egg';
  for (const k of ['baby', 'junior', 'adult', 'evolved']) if (xp >= thresholds[k]) s = k;
  return s;
}

// 寵物階段只會前進，不會倒退（扣分或撤銷都不會令寵物退化）
export function nextStage(currentStage, xp, thresholds) {
  const byXp = stageForXp(xp, thresholds);
  return stageIndex(byXp) > stageIndex(currentStage) ? byXp : currentStage;
}

// 一筆分數事件可否計入寵物 XP：
//  - 必須是正向加分（delta > 0）且屬於課堂加分（kind = 'point'）
//  - 必須在派蛋之後才產生（event.id > pet.baseline_event_id）
//  - 未被撤銷，且未曾入帳（ledger 唯一鍵另外保證）
export function isXpEligible(event, pet) {
  if (!pet) return false;
  if (event.student_id !== pet.student_record_id) return false;
  if (event.kind !== 'point') return false;
  if (!(event.delta > 0)) return false;
  if (event.undone_at) return false;
  return event.id > pet.baseline_event_id;
}

export function progressInfo(pet, thresholds = DEFAULT_THRESHOLDS) {
  const i = stageIndex(pet.stage);
  if (i === STAGES.length - 1) return { next: null, need: 0, pct: 100 };
  const next = STAGES[i + 1];
  const prevNeed = i === 0 ? 0 : thresholds[pet.stage];
  const need = thresholds[next];
  const pct = Math.max(0, Math.min(100, Math.round(((pet.xp - prevNeed) / (need - prevNeed)) * 100)));
  return { next, need, remaining: Math.max(0, need - pet.xp), pct };
}

// 唯一的取圖函數。沒有寵物 → null（顯示姓名縮寫）；資料錯誤 → 直接拋錯，絕不改用其他品種。
export function petImageUrl(pet, base = '') {
  if (!pet) return null;
  if (!speciesByKey[pet.species_key]) throw new Error(`未知品種：${pet.species_key}`);
  stageIndex(pet.stage);
  return `${base}assets/pets/${pet.species_key}/${pet.stage}.webp`;
}

export function petLabel(pet) {
  if (!pet) return '未派蛋';
  const sp = speciesByKey[pet.species_key];
  return pet.stage === 'egg' ? `${sp.name}蛋` : `${sp.name}${STAGE_LABELS[pet.stage]}`;
}

// 平均分配品種（全班派蛋時用），以已有數量最少者優先
export function balancedSpecies(count, existingCounts = {}, rand = Math.random) {
  const counts = Object.fromEntries(SPECIES_KEYS.map(k => [k, existingCounts[k] || 0]));
  const out = [];
  for (let n = 0; n < count; n++) {
    const min = Math.min(...Object.values(counts));
    const pool = SPECIES_KEYS.filter(k => counts[k] === min);
    const pick = pool[Math.floor(rand() * pool.length)];
    counts[pick]++; out.push(pick);
  }
  return out;
}
