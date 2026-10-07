// 學生名單匯入：Excel (.xlsx)、CSV（UTF-8 或 Big5）、圖片文字辨識、直接貼上。
// 檔案全部在老師的裝置內處理，不會上載原檔。

const CJK = /[㐀-鿿]/;

// ---------- CSV ----------
export function decodeText(buf) {
  const utf = new TextDecoder('utf-8').decode(buf);
  if (!utf.includes('\uFFFD')) return utf.replace(/^\uFEFF/, '');
  try { return new TextDecoder('big5').decode(buf); } catch { return utf; } // 香港 Excel 常見 Big5 CSV
}
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  const delim = (text.split('\n')[0].match(/\t/g)?.length || 0) > (text.split('\n')[0].match(/,/g)?.length || 0) ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

// ---------- XLSX（內置精簡 zip 讀取，不用外部程式庫） ----------
async function unzip(buf) {
  const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('檔案不是有效的 .xlsx');
  const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(p + 10, true); const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true); const elen = dv.getUint16(p + 30, true); const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    files[name] = { method, csize, off };
    p += 46 + nlen + elen + clen;
  }
  return async (name) => {
    const f = files[name]; if (!f) return null;
    const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
    const data = u8.subarray(start, start + f.csize);
    if (f.method === 0) return new TextDecoder().decode(data);
    const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(ds).text();
  };
}
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
export async function parseXlsx(buf) {
  const read = await unzip(buf);
  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const shared = [];
  const ss = await read('xl/sharedStrings.xml');
  if (ss) for (const si of xml(ss).getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  // 第一張工作表
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = await read('xl/workbook.xml'); const rels = await read('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = xml(wb).getElementsByTagName('sheet')[0];
    const rid = first?.getAttribute('r:id') || first?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const rel = [...xml(rels).getElementsByTagName('Relationship')].find(r => r.getAttribute('Id') === rid);
    if (rel) { const t = rel.getAttribute('Target'); sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t; }
  }
  const sheet = await read(sheetPath); if (!sheet) throw new Error('找不到工作表');
  const rows = [];
  for (const r of xml(sheet).getElementsByTagName('row')) {
    const row = [];
    for (const c of r.getElementsByTagName('c')) {
      const t = c.getAttribute('t'); const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let val = v;
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
      row[colIndex(c.getAttribute('r') || 'A')] = val;
    }
    rows.push([...row].map(x => x ?? ''));
  }
  return rows.filter(r => r.some(c => String(c).trim()));
}

// ---------- 由表格找出 班號 / 姓名 / 舊分數 ----------
export function rowsToStudents(rows) {
  if (!rows.length) return [];
  const H = { number: /班號|學號|座號|編號|^no\.?$|number|^#$/i, name: /姓名|名字|中文名|學生|name/i, score: /分數|積分|總分|score|points/i };
  let hi = rows.findIndex(r => r.some(c => H.name.test(String(c).trim())));
  let cols = {};
  if (hi >= 0) {
    rows[hi].forEach((c, i) => { const s = String(c).trim(); for (const k of Object.keys(H)) if (cols[k] === undefined && H[k].test(s)) { cols[k] = i; break; } });
    if (cols.name === undefined) hi = -1;
  }
  if (hi < 0) { // 沒有標題列：猜欄位
    const width = Math.max(...rows.map(r => r.length));
    for (let i = 0; i < width; i++) {
      const vals = rows.map(r => String(r[i] ?? '').trim()).filter(Boolean);
      if (cols.name === undefined && vals.filter(v => CJK.test(v) || /^[A-Za-z][A-Za-z .'-]+$/.test(v)).length >= vals.length * .6) cols.name = i;
      else if (cols.number === undefined && vals.every(v => /^\d{1,3}$/.test(v))) cols.number = i;
    }
  }
  if (cols.name === undefined) return [];
  return rows.slice(hi + 1).map(r => ({
    number: cols.number !== undefined ? String(r[cols.number] ?? '').trim().replace(/\.0$/, '') : '',
    name: String(r[cols.name] ?? '').trim(),
    score: cols.score !== undefined ? String(r[cols.score] ?? '').trim().replace(/\.0$/, '') : '',
  })).filter(s => s.name);
}

// ---------- 貼上 / 文字辨識結果 → 名單 ----------
export function textToStudents(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/[|｜]/g, ' ').trim(); if (!line) continue;
    // 例：「12. 陳大文 35」「12 陳大文」「陳大文」「12 Chan Tai Man」
    const m = line.match(/^(\d{1,3})?\s*[.、:：)\-]?\s*([㐀-鿿·]{2,6}|[A-Za-z][A-Za-z .'-]{1,40}?)\s*(-?\d{1,4})?\s*$/);
    if (m) out.push({ number: m[1] || '', name: m[2].replace(/\s+/g, ' ').trim(), score: m[3] || '' });
    else {
      // 一行多個名字（例如名單相片）
      for (const name of line.match(/[㐀-鿿]{2,4}/g) || []) out.push({ number: '', name, score: '' });
    }
  }
  return out;
}

export async function readFileToStudents(file) {
  const buf = await file.arrayBuffer();
  const n = file.name.toLowerCase();
  if (n.endsWith('.xlsx')) return rowsToStudents(await parseXlsx(buf));
  if (n.endsWith('.csv') || n.endsWith('.txt') || n.endsWith('.tsv')) {
    const text = decodeText(buf); const rows = parseCsv(text);
    const st = rowsToStudents(rows); return st.length ? st : textToStudents(text);
  }
  if (n.endsWith('.xls')) throw new Error('舊式 .xls 未能讀取，請在 Excel 選「另存新檔」→ .xlsx 或 .csv');
  throw new Error('只支援 .xlsx、.csv 或圖片');
}

// ---------- 圖片文字辨識（Tesseract.js，在瀏覽器內運行） ----------
let tessLoading = null;
function loadTesseract() {
  if (globalThis.Tesseract) return Promise.resolve(globalThis.Tesseract);
  tessLoading ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    s.onload = () => ok(globalThis.Tesseract); s.onerror = () => { tessLoading = null; fail(new Error('未能載入文字辨識工具，請檢查網絡，或改用 Excel／貼上名單')); };
    document.head.appendChild(s);
  });
  return tessLoading;
}
export async function ocrImage(file, onProgress) {
  const T = await loadTesseract();
  const res = await T.recognize(file, 'chi_tra+eng', { logger: m => { if (m.status === 'recognizing text') onProgress?.(m.progress); } });
  return res.data.text.replace(/(?<=[㐀-鿿]) (?=[㐀-鿿])/g, ''); // 中文字之間的多餘空格
}
