"""探索測試：模擬新老師由零開始用（手機及桌面），逐頁撳晒每個按鈕，記錄所有 JavaScript 錯誤、
伺服器錯誤（5xx）及意外的 4xx，並為每頁截圖。用法：python3 test/explore.py [輸出資料夾]"""
import json, os, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'test-output', 'explore')
os.makedirs(OUT, exist_ok=True)
PORT = 3931
tmp = tempfile.mkdtemp()
srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'scripts/netlify-sim.mjs', str(PORT), os.environ.get('SIM_LATENCY', '20')],
                       cwd=ROOT, env={**os.environ, 'SIM_DB': os.path.join(tmp, 'x.db')})
time.sleep(2)
BASE = f'http://127.0.0.1:{PORT}/'
issues = []
shot_n = [0]

def note(kind, msg):
    issues.append({'kind': kind, 'msg': msg}); print(f'[{kind}] {msg}')

def idle(pg, t=30):
    end = time.time() + t
    while time.time() < end:
        if pg.evaluate("document.body.dataset.route === 'idle' && !document.body.classList.contains('loading')"): break
        time.sleep(0.1)
    pg.wait_for_timeout(250)

def goto(pg, url):
    if pg.url != url: pg.evaluate("document.body.dataset.route = 'busy'") if pg.url.startswith(BASE) else None
    pg.goto(url); idle(pg)

def shot(pg, name):
    shot_n[0] += 1; pg.screenshot(path=f'{OUT}/{shot_n[0]:02d}-{name}.png', full_page=True)

def close_overlays(pg):
    for _ in range(3):
        if pg.locator('dialog[open]').count():
            pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
            if pg.locator('dialog[open]').count():
                b = pg.locator('dialog[open] [data-close], dialog[open] button:has-text("取消"), dialog[open] button:has-text("關閉")')
                if b.count(): b.first.click(force=True); pg.wait_for_timeout(200)

def crawl(pg, url, label, skip=()):
    """撳晒頁面上每個 data-act 按鈕（跳過會刪除資料的），每撳一個就重新載入頁面。"""
    goto(pg, url)
    acts = pg.eval_on_selector_all('[data-act]:not([disabled])', "els => [...new Set(els.filter(e => e.offsetParent).map(e => e.dataset.act))]")
    for a in acts:
        if any(k in a for k in ('del', 'logout', 'remove', 'reset', 'clear', 'end')) or a in skip: continue
        goto(pg, url)
        el = pg.locator(f'[data-act="{a}"]:visible').first
        if not el.count(): continue
        n_err = len(issues)
        try:
            el.click(timeout=3000); pg.wait_for_timeout(500); idle(pg)
        except Exception as e:
            note('click', f'{label}: 撳唔到 {a}: {str(e)[:80]}')
        if pg.locator('dialog[open]').count():
            shot(pg, f'{label}-{a}')
        close_overlays(pg)
        if len(issues) > n_err: print(f'   ↳ 發生於 {label} 撳 {a}')

with sync_playwright() as p:
    br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    for vp_name, vp in [('phone', {'width': 390, 'height': 844}), ('desktop', {'width': 1366, 'height': 900})]:
        ctx = br.new_context(viewport=vp, locale='zh-HK', has_touch=vp_name == 'phone', is_mobile=vp_name == 'phone')
        ctx.grant_permissions(['microphone'], origin=BASE.rstrip('/'))
        pg = ctx.new_page()
        pg.on('console', lambda m: note('console', m.text) if m.type == 'error' and 'fonts.g' not in m.text and 'ERR_TUNNEL' not in m.text and 'jsdelivr' not in m.text else None)
        pg.on('pageerror', lambda e: note('js', str(e)))
        def on_resp(r):
            if '/api/' in r.url and r.status >= 500: note('5xx', f'{r.request.method} {r.url} {r.status} {r.text()[:120]}')
        pg.on('response', on_resp)
        pg.on('dialog', lambda d: d.accept())
        pg.goto(BASE); idle(pg); shot(pg, f'{vp_name}-login')
        email = f'{vp_name}@school.hk'
        pg.click('text=新老師註冊')
        pg.fill('#f-name', '測試老師'); pg.fill('#f-email', email); pg.fill('#f-pw', 'Password123')
        if pg.locator('#f-code').count(): pg.fill('#f-code', 'TM-TEST')
        pg.click('button:has-text("建立帳戶")'); idle(pg); pg.wait_for_timeout(500)
        shot(pg, f'{vp_name}-home-empty')
        # 建立班別
        if pg.locator('[data-act="newclass"], button:has-text("新增班別")').count():
            pg.locator('[data-act="newclass"], button:has-text("新增班別")').first.click(); pg.wait_for_timeout(300)
        shot(pg, f'{vp_name}-newclass')
        if pg.locator('input[name=name]').count():
            pg.locator('input[name=name]').first.fill('3A'); pg.keyboard.press('Enter'); idle(pg); pg.wait_for_timeout(600)
        shot(pg, f'{vp_name}-after-class')
        cid = pg.evaluate("fetch('/api/classes').then(r => r.json()).then(c => c[0]?.id)")
        if not cid: note('flow', f'{vp_name}: 建立班別失敗'); continue
        # 空班別的每一頁
        for v in ['room', 'students', 'homework', 'exams', 'history', 'pets', 'poster']:
            goto(pg, BASE + f'#/c/{cid}/{v}'); shot(pg, f'{vp_name}-empty-{v}')
        crawl(pg, BASE + f'#/c/{cid}/room', f'{vp_name}-empty-room')
        # 貼上名單
        goto(pg, BASE + f'#/c/{cid}/students')
        pg.click('[data-tab=paste]'); pg.fill('#imp-text', '\n'.join(f'{i+1} 學生{i+1:02d}' for i in range(28)))
        pg.click('text=讀取名單'); pg.wait_for_selector('text=確認匯入'); pg.click('text=確認匯入'); idle(pg); pg.wait_for_timeout(800)
        shot(pg, f'{vp_name}-students')
        # 全班派蛋
        goto(pg, BASE + f'#/c/{cid}/pets'); shot(pg, f'{vp_name}-pets-before')
        if pg.locator('text=全選').count(): pg.locator('text=全選').first.click()
        btn = pg.locator('text=派蛋給已選學生')
        if btn.count(): btn.first.click(); pg.wait_for_timeout(400); shot(pg, f'{vp_name}-assign-dialog')
        conf = pg.locator('dialog[open] button.primary, dialog[open] button:has-text("派蛋")')
        if conf.count(): conf.last.click(); idle(pg); pg.wait_for_timeout(800)
        close_overlays(pg); shot(pg, f'{vp_name}-pets-after')
        # 課室：撳學生加分
        goto(pg, BASE + f'#/c/{cid}/room'); shot(pg, f'{vp_name}-room')
        for i in range(4):
            pg.locator('#room-grid .stu').nth(i).click(); pg.wait_for_timeout(700); idle(pg)
            if i == 0: shot(pg, f'{vp_name}-room-after-tap')
            close_overlays(pg)
        crawl(pg, BASE + f'#/c/{cid}/room', f'{vp_name}-room')
        for v in ['students', 'homework', 'exams', 'history', 'pets', 'poster']:
            crawl(pg, BASE + f'#/c/{cid}/{v}', f'{vp_name}-{v}'); goto(pg, BASE + f'#/c/{cid}/{v}'); shot(pg, f'{vp_name}-{v}')
        sid = pg.evaluate(f"fetch('/api/classes/{cid}/full').then(r => r.json()).then(c => c.students[0].id)")
        crawl(pg, BASE + f'#/s/{sid}', f'{vp_name}-student'); shot(pg, f'{vp_name}-student')
        crawl(pg, BASE + '#/settings', f'{vp_name}-settings'); shot(pg, f'{vp_name}-settings')
        crawl(pg, BASE + '#/classes', f'{vp_name}-home'); shot(pg, f'{vp_name}-home')
        if vp_name == 'phone':
            goto(pg, BASE + '#/admin'); shot(pg, f'{vp_name}-admin')
        # 檢查橫向溢出（手機）
        for v in ['room', 'students', 'homework', 'pets', 'poster']:
            goto(pg, BASE + f'#/c/{cid}/{v}')
            w = pg.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
            if w[0] > w[1] + 2: note('layout', f'{vp_name} {v}: 頁面闊過螢幕 {w[0]} > {w[1]}')
        ctx.close()
    br.close()
srv.terminate()
json.dump(issues, open(f'{OUT}/issues.json', 'w'), ensure_ascii=False, indent=1)
print(f'\n共 {len(issues)} 個問題')
