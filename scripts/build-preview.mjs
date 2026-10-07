// 生成「預覽示範版」單一 HTML（瀏覽器內示範後端，無需伺服器）。
// 用法：node scripts/build-preview.mjs dist/preview
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'preview'));
const order = ['shared/pet-logic.js', 'js/demo-backend.js', 'js/demo-seed.js', 'js/api.js', 'js/ui.js', 'js/importer.js', 'js/app.js'];

const strip = (src) => src
  .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, '');
let js = order.map(f => `// ---- ${f} ----\n${strip(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'))}`).join('\n');
if (/^\s*(import|export)\s/m.test(js)) throw new Error('仍有未處理的 import/export');

// 40 張寵物圖內嵌為 data URI，預覽頁不需讀取外部圖片檔
const images = {};
const petDir = path.join(ROOT, 'public/assets/pets');
for (const sp of fs.readdirSync(petDir).sort()) for (const f of fs.readdirSync(path.join(petDir, sp)).sort()) {
  images[`assets/pets/${sp}/${f}`] = 'data:image/webp;base64,' + fs.readFileSync(path.join(petDir, sp, f)).toString('base64');
}
if (Object.keys(images).length !== 40) throw new Error('寵物圖數目不是 40');
const css = fs.readFileSync(path.join(ROOT, 'public/css/app.css'), 'utf8');
const html = `<title>Tick and Mark</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;800&family=Chiron+Hei+HK:wght@400;600;700;800;900&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Huninn&display=swap">
<meta name="color-scheme" content="light">
<style>
${css}
</style>
<div id="app"><div class="empty">載入中…</div></div>
<script>window.TM_DEMO = true;
window.TM_PET_IMAGES = ${JSON.stringify(images)};</script>
<script type="module">
${js}
</script>
`;
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.rmSync(path.join(out, 'assets'), { recursive: true, force: true });
console.log(`已輸出 ${path.join(out, 'index.html')}（${(html.length / 1024).toFixed(0)} KB），已內嵌 40 張寵物圖`);
