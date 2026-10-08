"""瀏覽器端驗收：真伺服器 + 無頭 Chromium。
核對課室 icon、學生資料頁、寵物頁、海報、加分彈窗的圖片，與資料庫 StudentPet 完全一致。
用法：python3 test/e2e.py [輸出資料夾]"""
import json, os, subprocess, sys, tempfile, time, random
import openpyxl
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'test-output')
os.makedirs(OUT, exist_ok=True)
PORT = 3917
tmp = tempfile.mkdtemp()
db = os.path.join(tmp, 'e2e.db')
if os.environ.get('SIM'):  # 模擬 Netlify + Turso：SIM=1 python3 test/e2e.py
    srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'scripts/netlify-sim.mjs', str(PORT), os.environ.get('SIM_LATENCY', '15')], cwd=ROOT, env={**os.environ, 'SIM_DB': db})
    time.sleep(2)
else:
    srv = subprocess.Popen(['node', '--disable-warning=ExperimentalWarning', 'server/server.js'], cwd=ROOT,
                       env={**os.environ, 'PORT': str(PORT), 'DB_FILE': db, 'ALLOW_REGISTRATION': 'true'}, )
    time.sleep(1.2)
BASE = f'http://127.0.0.1:{PORT}/'
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f' — {detail}' if detail else ''))

# 測試用名單檔案
xlsx = os.path.join(tmp, '4A名單.xlsx')
wb = openpyxl.Workbook(); ws = wb.active
ws.append(['班號', '姓名', '分數'])
names4a = ['陳大文', '李小明', '黃美玲', '張家豪', '何詠琪', '林子軒', '吳嘉欣', '鄭浩然', '梁曉晴', '周天佑', '馮凱琳', '蔡志明']
for i, n in enumerate(names4a): ws.append([i + 1, n, (i * 5) % 17])
wb.save(xlsx)
csv = os.path.join(tmp, '4B.csv')
names4b = ['許俊傑', '曾慧敏', '彭啟聰', '蕭嘉怡', '郭家樂', '羅思穎', '謝浩霖', '韓美琪', '唐子健', '馬詩韻']
with open(csv, 'wb') as f: f.write(('學號,姓名\n' + '\n'.join(f'{i+1},{n}' for i, n in enumerate(names4b))).encode('big5'))

def api(page, method, path, body=None):
    return page.evaluate("""async ([m, p, b]) => { const r = await fetch('/api' + p, { method: m, headers: { 'content-type': 'application/json', 'x-tm': '1' }, body: b ? JSON.stringify(b) : undefined }); return r.json(); }""", [method, path, body])

def wait_js(page, expr, timeout=15):
    # CSP 禁止 eval，所以用 evaluate 輪詢
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate(f"() => {expr}"): return
        time.sleep(0.1)
    raise TimeoutError(expr)

def goto(pg, url):
    # 等新頁面完全載入（轉頁期間舊頁面暫停操作）
    if pg.url.startswith(BASE) and pg.url != url: pg.evaluate("document.body.dataset.route = 'busy'")
    pg.goto(url)
    wait_js(pg, "document.body.dataset.route === 'idle'", 30)

def dom_avatars(page, selector):
    return page.eval_on_selector_all(selector, "els => els.map(e => ({ s: e.dataset.student, sp: e.dataset.species, st: e.dataset.stage, src: e.querySelector('img')?.getAttribute('src') || null }))")

def verify_against_db(page, label, avatars, by_id):
    bad = []
    for a in avatars:
        if not a['s']: continue
        stu = by_id.get(int(a['s']))
        pet = stu['pet'] if stu else None
        if pet is None:
            if a['sp'] != 'none' or a['src']: bad.append(f"{a['s']}: 應無寵物但顯示 {a['src']}")
        else:
            exp = f"assets/pets/{pet['species_key']}/{pet['stage']}.webp"
            if a['sp'] != pet['species_key'] or a['st'] != pet['stage'] or a['src'] != exp:
                bad.append(f"{stu['name']}: 資料 {pet['species_key']}/{pet['stage']}，畫面 {a['sp']}/{a['st']} {a['src']}")
    check(f'{label}：{len(avatars)} 個頭像與資料庫一致', not bad and avatars, '; '.join(bad[:5]))

errors = []
try:
    with sync_playwright() as p:
        br = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = br.new_context(viewport={'width': 1280, 'height': 860}, locale='zh-HK')
        page = ctx.new_page()
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'ERR_TUNNEL_CONNECTION_FAILED' not in m.text else None)  # 測試環境封鎖 Google Fonts
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(BASE)
        page.click('text=新老師註冊')
        page.fill('#f-name', '陳老師'); page.fill('#f-email', 'chan@school.edu.hk'); page.fill('#f-pw', 'Password123')
        page.click('button:has-text("建立帳戶")')
        page.wait_for_selector('text=新增班別')
        check('登入及註冊', True)

        # 未登入的另一個瀏覽器看不到資料
        anon = br.new_context().new_page(); anon.goto(BASE)
        r = anon.evaluate("fetch('/api/classes').then(r => r.status)")
        check('未登入不能讀取學生資料（401）', r == 401, str(r))

        ids = {}
        for cn, year in [('4A', '2026-27'), ('4B', '2026-27'), ('6C', '2026-27')]:
            page.fill('#nc-name', cn); page.click('button:has-text("建立")'); page.wait_for_selector('h1:has-text("學生及分組")')
            ids[cn] = int(page.url.split('/c/')[1].split('/')[0]); goto(page, BASE + '#/classes'); page.wait_for_selector('text=新增班別')

        # Excel 匯入
        goto(page, BASE + f"#/c/{ids['4A']}/students"); page.wait_for_selector('#imp-file', state='attached')
        page.set_input_files('#imp-file', xlsx); page.wait_for_selector('text=確認匯入')
        check('Excel 讀到 12 位學生（含舊分數）', page.locator('[data-k=name]').count() == 12)
        page.screenshot(path=f'{OUT}/import-preview.png', full_page=True)
        page.click('text=確認匯入'); page.wait_for_selector('text=已匯入 12 位學生')
        # Big5 CSV 匯入
        goto(page, BASE + f"#/c/{ids['4B']}/students"); page.wait_for_selector('#imp-file', state='attached')
        page.set_input_files('#imp-file', csv); page.wait_for_selector('text=確認匯入')
        first = page.locator('[data-k=name]').first.input_value()
        check('Big5 CSV 正確解碼中文', first == names4b[0], first)
        page.click('text=確認匯入'); page.wait_for_selector('text=已匯入 10 位學生')
        # 貼上名單
        goto(page, BASE + f"#/c/{ids['6C']}/students"); page.wait_for_selector('#imp-text', state='attached')
        page.click('summary:has-text("貼上")'); page.fill('#imp-text', '1. 葉朗峰\n2 方采盈 8\n3、雷俊言\n4 姚樂怡\n5 歐陽子晴')
        page.click('text=讀取名單'); page.wait_for_selector('text=確認匯入')
        check('貼上名單讀到 5 位（含複姓）', page.locator('[data-k=name]').count() == 5)
        page.click('text=確認匯入'); page.wait_for_selector('text=已匯入 5 位學生')

        old = api(page, 'GET', f"/classes/{ids['4A']}/full")
        check('舊分數保留', [s['score'] for s in old['students']] == [(i * 5) % 17 for i in range(12)])

        # 派蛋前先加分（之後不應計入 XP）
        pre_id = old['students'][0]['id']
        api(page, 'POST', '/points', {'class_id': ids['4A'], 'student_ids': [pre_id], 'delta': 9, 'client_batch_id': 'pre-egg'})

        # 4A：經介面平均派蛋
        goto(page, BASE + f"#/c/{ids['4A']}/pets"); page.wait_for_selector('text=派蛋給已選學生')
        page.click('text=派蛋給已選學生'); page.wait_for_selector('text=已為 12 位學生派蛋')
        # 4B：經介面選土熊給首兩位，其餘平均
        goto(page, BASE + f"#/c/{ids['4B']}/pets"); page.wait_for_selector('text=派蛋給已選學生')
        page.click('text=全不選'); page.locator('[data-np]').nth(0).check(); page.locator('[data-np]').nth(1).check()
        page.click('[data-sp=earth_bear]'); page.click('text=派蛋給已選學生'); page.wait_for_selector('text=已為 2 位學生派蛋')
        page.click('text=派蛋給已選學生'); page.wait_for_selector('text=已為 8 位學生派蛋')
        # 6C：留一位不派蛋
        c6 = api(page, 'GET', f"/classes/{ids['6C']}/full")
        api(page, 'POST', '/pets/assign', {'student_ids': [s['id'] for s in c6['students'][:4]], 'species_key': 'fire_fox'})

        full4a = api(page, 'GET', f"/classes/{ids['4A']}/full")
        pre = next(s for s in full4a['students'] if s['id'] == pre_id)
        check('派蛋前的加分不計入 XP', pre['pet']['xp'] == 0 and pre['score'] == 9, f"xp={pre['pet']['xp']} score={pre['score']}")
        sp4a = sorted(s['pet']['species_key'] for s in full4a['students'])
        check('4A 平均派蛋（八款中每款 1–2 隻）', all(1 <= sp4a.count(k) <= 2 for k in set(sp4a)) and len(set(sp4a)) == 8, str(sp4a))

        # 4B 土熊學生：在課室模式加 5 分 → 孵化。彈窗必須顯示土熊寶寶，不能是其他品種
        full4b = api(page, 'GET', f"/classes/{ids['4B']}/full")
        bear = full4b['students'][0]
        check('4B 第一位資料是土熊蛋', bear['pet']['species_key'] == 'earth_bear' and bear['pet']['stage'] == 'egg')
        goto(page, BASE + f"#/c/{ids['4B']}/room"); page.wait_for_selector('.stu')
        verify_against_db(page, '4B 課室（派蛋後）', dom_avatars(page, '#room-grid .avatar'), {s['id']: s for s in full4b['students']})
        page.fill('#room-search', '1'); page.keyboard.press('Enter')  # 班號 1 + Enter
        page.wait_for_selector('dialog .tag-grid')
        page.screenshot(path=f'{OUT}/room-sheet.png')
        page.click('dialog .quick [data-d="5"]')
        page.wait_for_selector('.celebrate .cele-card')
        cele = page.eval_on_selector('.celebrate', "e => ({ who: e.querySelector('.who')?.textContent, delta: e.querySelector('.delta')?.textContent, sp: e.querySelector('.avatar').dataset.species, st: e.querySelector('.avatar').dataset.stage, src: e.querySelector('.avatar img').getAttribute('src'), lv: e.querySelector('.levelup')?.textContent })")
        page.screenshot(path=f'{OUT}/celebrate-hatch.png')
        bear2 = api(page, 'GET', f"/students/{bear['id']}")['student']
        check('彈窗：姓名、實際加分正確', cele['who'] == bear['name'] and cele['delta'] == '+5', json.dumps(cele, ensure_ascii=False))
        check('彈窗：土熊孵化後顯示土熊寶寶（與資料庫一致）', cele['sp'] == 'earth_bear' == bear2['pet']['species_key'] and cele['st'] == 'baby' == bear2['pet']['stage'] and cele['src'] == 'assets/pets/earth_bear/baby.webp', f"{cele['src']} / 孵化字樣：{cele['lv']}")
        page.click('.celebrate')

        # 多選加分（標籤 +2）：多人彈窗逐一核對
        page.click('[data-act=multi]')
        for i in [2, 3, 4]: page.locator('.stu').nth(i).click()
        page.click('[data-act=selgo]'); page.wait_for_selector('dialog .tag-grid')
        page.click('dialog .tag-btn.pos >> nth=2')  # 幫助同學 +2
        page.wait_for_selector('.celebrate .cele-multi')
        multi = page.eval_on_selector_all('.celebrate .cele-multi .m', "els => els.map(e => ({ s: e.dataset.celeStudent, sp: e.querySelector('.avatar').dataset.species, st: e.querySelector('.avatar').dataset.stage }))")
        page.screenshot(path=f'{OUT}/celebrate-multi.png')
        full4b = api(page, 'GET', f"/classes/{ids['4B']}/full"); by4b = {s['id']: s for s in full4b['students']}
        ok = len(multi) == 3 and all(by4b[int(m['s'])]['pet']['species_key'] == m['sp'] and by4b[int(m['s'])]['pet']['stage'] == m['st'] for m in multi)
        check('多人加分彈窗：每位學生顯示自己的寵物', ok, json.dumps(multi, ensure_ascii=False))
        check('多人加分 XP 各 +2', all(by4b[int(m['s'])]['pet']['xp'] == 2 for m in multi))
        page.click('.celebrate')

        # 扣分不倒退
        before = by4b[bear['id']]['pet']
        page.locator('.stu').first.click(); page.wait_for_selector('dialog .tag-grid'); page.click('dialog .quick [data-d="-2"]')
        page.wait_for_selector('.celebrate.minus .cele-card')
        minus = page.eval_on_selector('.celebrate.minus', "e => ({ d: e.querySelector('.delta').textContent, sp: e.querySelector('.avatar').dataset.species, st: e.querySelector('.avatar').dataset.stage })")
        after = api(page, 'GET', f"/students/{bear['id']}")['student']['pet']
        check('扣分：XP 及階段不變', after['xp'] == before['xp'] and after['stage'] == before['stage'], f"{before['xp']}→{after['xp']} {after['stage']}")
        check('扣分彈出簡短確認（無彩紙），顯示自己寵物', minus['d'] == '-2' and minus['sp'] == 'earth_bear' and minus['st'] == after['stage'] and page.locator('.celebrate .spark').count() == 0, json.dumps(minus))
        page.click('.celebrate .cele-card')

        # 撤銷最近一次 +5 → XP 扣回、階段不倒退
        page.click('[data-act=recent]'); page.wait_for_selector('dialog [data-undo]')
        page.screenshot(path=f'{OUT}/recent.png')
        batches = api(page, 'GET', f"/classes/{ids['4B']}/batches?limit=10")
        plus5 = next(b for b in batches if b['label'] == '加 5 分')
        page.click(f'dialog [data-undo="{plus5["id"]}"]'); page.click('dialog button:has-text("撤銷") >> nth=-1')
        page.wait_for_timeout(500)
        after = api(page, 'GET', f"/students/{bear['id']}")['student']['pet']
        check('撤銷：XP 扣回 5，土熊仍是寶寶（不倒退）', after['xp'] == 0 and after['stage'] == 'baby', f"xp={after['xp']} stage={after['stage']}")

        # 重複提交同一操作：只計一次
        r1 = api(page, 'POST', '/points', {'class_id': ids['4B'], 'student_ids': [bear['id']], 'delta': 3, 'client_batch_id': 'dup-test'})
        r2 = api(page, 'POST', '/points', {'class_id': ids['4B'], 'student_ids': [bear['id']], 'delta': 3, 'client_batch_id': 'dup-test'})
        check('同一筆加分重送不會重複計算', r2.get('replayed') and r2['results'][0]['pet']['xp'] == r1['results'][0]['pet']['xp'] == 3)

        # 一撳即加：先揀「+2」，再撳學生，直接加分並彈出畫面
        goto(page, BASE + f"#/c/{ids['4B']}/room"); page.wait_for_selector('.stu')
        page.click('.qchip[data-q="d:2"]')
        target = api(page, 'GET', f"/classes/{ids['4B']}/full")['students'][5]
        page.click(f'.stu[data-id="{target["id"]}"]')
        page.wait_for_selector(f'.celebrate .cele-card[data-cele-student="{target["id"]}"]')
        q = page.eval_on_selector('.celebrate', "e => ({ d: e.querySelector('.delta').textContent, sp: e.querySelector('.avatar').dataset.species, st: e.querySelector('.avatar').dataset.stage })")
        page.screenshot(path=f'{OUT}/quick-give.png')
        t2 = api(page, 'GET', f"/students/{target['id']}")['student']
        check('一撳即加：沒有選單，直接 +2 並彈出', page.locator('dialog').count() == 0 and q['d'] == '+2' and t2['score'] == target['score'] + 2, json.dumps(q))
        check('一撳即加：彈窗寵物與資料庫一致，XP +2', q['sp'] == t2['pet']['species_key'] and q['st'] == t2['pet']['stage'] and t2['pet']['xp'] == target['pet']['xp'] + 2)
        # 彈窗未關時直接撳另一位（背景不阻擋）
        free_id = page.evaluate("""(tid) => { const c = document.querySelector('.celebrate .cele-card').getBoundingClientRect();
          const hit = (b) => !(b.right < c.left || b.left > c.right || b.bottom < c.top || b.top > c.bottom);
          return +[...document.querySelectorAll('.stu')].find(e => +e.dataset.id !== tid && !hit(e.getBoundingClientRect())).dataset.id; }""", target['id'])
        other = next(x for x in api(page, 'GET', f"/classes/{ids['4B']}/full")['students'] if x['id'] == free_id)
        ob = page.locator(f'.stu[data-id="{other["id"]}"]').bounding_box()
        check('彈窗仍在畫面', page.locator('.celebrate').count() == 1)
        page.mouse.click(ob['x'] + ob['width'] / 2, ob['y'] + ob['height'] / 2)
        page.wait_for_selector(f'.celebrate .cele-card[data-cele-student="{other["id"]}"]')
        check('彈窗未關都可以連續撳下一位', api(page, 'GET', f"/students/{other['id']}")['student']['score'] == other['score'] + 2)
        page.click('.qchip[data-q="d:-1"]'); page.click(f'.stu[data-id="{other["id"]}"]', position={'x': 20, 'y': 12})
        page.wait_for_selector('.celebrate.minus')
        check('一撳即扣 -1', api(page, 'GET', f"/students/{other['id']}")['student']['score'] == other['score'] + 1)
        tagq = next(t for t in api(page, 'GET', '/bootstrap')['tags'] if t['points'] == 2)
        page.click(f'.qchip[data-q="t:{tagq["id"]}"]'); page.click(f'.stu[data-id="{target["id"]}"]', position={'x': 20, 'y': 12})
        page.wait_for_selector(f'.celebrate .cele-card[data-cele-student="{target["id"]}"]')
        check('一撳即用行為標籤', page.inner_text('.celebrate .what').strip().endswith(tagq['label']), page.inner_text('.celebrate .what'))
        page.click('.qchip[data-q="menu"]'); page.wait_for_timeout(2000)

        # 座位表：拖動到空位、點選交換、每行座位數，並重新載入確認已儲存
        page.click('[data-act=mode][data-m=seats]'); page.wait_for_selector('.seats.editing')
        cards = api(page, 'GET', f"/classes/{ids['4B']}/full")['students']
        mover = cards[0]
        empty = page.locator('.seats .seat-empty').last; eb = empty.bounding_box(); er, ec = int(empty.get_attribute('data-r')), int(empty.get_attribute('data-c'))
        mb = page.locator(f'.stu[data-id="{mover["id"]}"]').bounding_box()
        page.mouse.move(mb['x'] + mb['width'] / 2, mb['y'] + mb['height'] / 2); page.mouse.down()
        page.mouse.move(mb['x'] + 40, mb['y'] + 40, steps=4); page.mouse.move(eb['x'] + eb['width'] / 2, eb['y'] + eb['height'] / 2, steps=8)
        page.screenshot(path=f'{OUT}/seat-drag.png'); page.mouse.up(); page.wait_for_timeout(500)
        m2 = next(x for x in api(page, 'GET', f"/classes/{ids['4B']}/full")['students'] if x['id'] == mover['id'])
        check('拖動學生到空位並儲存', (m2['seat_row'], m2['seat_col']) == (er, ec), f"{m2['seat_row']},{m2['seat_col']} 應為 {er},{ec}")
        b_, c_ = cards[1], cards[2]
        page.wait_for_timeout(450)
        page.click(f'.stu[data-id="{b_["id"]}"]'); page.click(f'.stu[data-id="{c_["id"]}"]'); page.wait_for_timeout(500)
        after_s = {x['id']: x for x in api(page, 'GET', f"/classes/{ids['4B']}/full")['students']}
        check('先點後點：兩位學生交換座位', (after_s[b_['id']]['seat_row'], after_s[b_['id']]['seat_col']) == (0, 2) and (after_s[c_['id']]['seat_row'], after_s[c_['id']]['seat_col']) == (0, 1),
              f"{after_s[b_['id']]['seat_row']},{after_s[b_['id']]['seat_col']} / {after_s[c_['id']]['seat_row']},{after_s[c_['id']]['seat_col']}")
        page.click('[data-act=cols][data-d="1"]'); page.wait_for_timeout(500)
        check('每行座位數可調整', api(page, 'GET', f"/classes/{ids['4B']}/full")['class']['seat_cols'] == 7)
        page.screenshot(path=f'{OUT}/seat-edit.png', full_page=True)
        page.click('[data-act=seatdone]')
        page.reload(); page.wait_for_selector('.seats')
        dom_pos = page.eval_on_selector(f'.stu[data-id="{mover["id"]}"]', 'e => [+e.dataset.r, +e.dataset.c]')
        check('重新載入後座位保持', tuple(dom_pos) == (er, ec), str(dom_pos))
        verify_against_db(page, '4B 座位表模式', dom_avatars(page, '#room-grid .avatar'), {x['id']: x for x in api(page, 'GET', f"/classes/{ids['4B']}/full")['students']})
        page.screenshot(path=f'{OUT}/seat-chart.png', full_page=True)

        # ===== 課堂工具（4B）=====
        goto(page, BASE + f"#/c/{ids['4B']}/room"); page.wait_for_selector('.stu')
        roster = api(page, 'GET', f"/classes/{ids['4B']}/full")['students']
        absent_ids = [roster[1]['id'], roster[4]['id']]
        # 1) 點名
        page.click('[data-act=mode][data-m=attend]'); page.wait_for_selector('.quick-bar.editing')
        for sid in absent_ids: page.click(f'.stu[data-id="{sid}"]'); page.wait_for_timeout(250)
        att = api(page, 'GET', f"/classes/{ids['4B']}/attendance?date=" + page.evaluate("(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()"))
        check('點名：缺席紀錄存入資料庫', sorted(att['absent']) == sorted(absent_ids), str(att))
        check('點名：缺席同學顯示灰色及「缺席」', all('absent' in page.get_attribute(f'.stu[data-id="{sid}"]', 'class') for sid in absent_ids))
        page.screenshot(path=f'{OUT}/attendance.png', full_page=True)
        page.click('[data-act=modedone]'); page.click('[data-act=all]'); page.wait_for_selector('dialog .tag-grid')
        check('全班加分自動跳過缺席', page.inner_text('dialog h2').strip() == f"{len(roster) - 2} 位同學", page.inner_text('dialog h2'))
        page.click('dialog [data-close]')
        # 2) 隨機抽人：抽晒出席同學，不重複、不抽缺席
        picks = []
        for _ in range(len(roster) - 2):
            page.click('[data-act=pickone]'); page.wait_for_selector('dialog .pick-result', timeout=8000)
            picks.append(int(page.get_attribute('dialog .pick-result', 'data-pick'))); page.click('dialog [data-close]'); page.wait_for_timeout(150)
        check('隨機抽人：不重複、不抽缺席', len(set(picks)) == len(roster) - 2 and not set(picks) & set(absent_ids), str(picks))
        page.click('[data-act=pickone]'); page.wait_for_selector('dialog .pick-result', timeout=8000)
        page.screenshot(path=f'{OUT}/pick.png')
        winner = int(page.get_attribute('dialog .pick-result', 'data-pick')); before_w = next(x for x in api(page, 'GET', f"/classes/{ids['4B']}/full")['students'] if x['id'] == winner)['score']
        page.click('dialog .pick-result [data-d="1"]'); page.wait_for_selector(f'.celebrate .cele-card[data-cele-student="{winner}"]')
        check('抽中後一撳 +1 並彈出', next(x for x in api(page, 'GET', f"/classes/{ids['4B']}/full")['students'] if x['id'] == winner)['score'] == before_w + 1)
        page.click('.celebrate .cele-card')
        # 3) 座位表收功課
        page.click('[data-act=mode][data-m=hw]'); page.wait_for_selector('[data-act=hwnew]')
        page.click('[data-act=hwnew]'); page.click('dialog .tpl .use >> nth=0'); page.click('dialog button:has-text("新增並開始收功課")')
        page.wait_for_selector('#hw-pick')
        hwid = int(page.input_value('#hw-pick'))
        present_ids = [x['id'] for x in roster if x['id'] not in absent_ids]
        for sid in present_ids[:3]: page.click(f'.stu[data-id="{sid}"]'); page.wait_for_timeout(200)
        page.click('.qchip.hwc[data-v=missing]'); page.click(f'.stu[data-id="{present_ids[3]}"]'); page.wait_for_timeout(200)
        page.click(f'.stu[data-id="{present_ids[4]}"]'); page.wait_for_timeout(200); page.click(f'.stu[data-id="{present_ids[4]}"]'); page.wait_for_timeout(300)
        sub = {e['student_id']: e['status'] for e in api(page, 'GET', f"/homework/{hwid}/submissions")['entries']}
        check('收功課：撳學生記為已交／欠交，再撳清除', all(sub.get(i) == 'submitted' for i in present_ids[:3]) and sub.get(present_ids[3]) == 'missing' and present_ids[4] not in sub, str(sub))
        check('收功課：座位卡顯示狀態', page.inner_text(f'.stu[data-id="{present_ids[0]}"] .ribbon') == '已交')
        page.click('[data-act=hwfill][data-v=absent]'); page.wait_for_timeout(400); page.click('[data-act=hwfill][data-v=missing]'); page.wait_for_timeout(400)
        sub = {e['student_id']: e['status'] for e in api(page, 'GET', f"/homework/{hwid}/submissions")['entries']}
        check('收功課：缺席→豁免、未記錄→欠交', all(sub.get(i) == 'excused' for i in absent_ids) and len(sub) == len(roster) and sub.get(present_ids[4]) == 'missing', str(sub))
        page.screenshot(path=f'{OUT}/homework-seats.png', full_page=True)
        page.click('[data-act=modedone]')
        # 寵物提醒交功課
        page.wait_for_timeout(400)
        miss_ids = [i for i, v in sub.items() if v == 'missing']
        pet_miss = [i for i in miss_ids if next(x for x in roster if x['id'] == i)['pet']]
        check('寵物提醒：欠交學生卡出現「交功課」氣泡', all(page.locator(f'.stu[data-id="{i}"] .hungry-bubble.hw').count() == 1 for i in pet_miss) and pet_miss, str(pet_miss))
        check('寵物提醒：已交學生冇氣泡', page.locator(f'.stu[data-id="{present_ids[0]}"] .hungry-bubble.hw').count() == 0)
        check('寵物提醒：工具列顯示欠交人數', page.inner_text('#missing-pill').strip().endswith(str(len(miss_ids))), page.inner_text('#missing-pill'))
        page.click('#missing-pill'); page.wait_for_selector('dialog [data-fix]'); page.screenshot(path=f'{OUT}/missing-list.png')
        page.click(f'dialog [data-fix="submitted"][data-s="{pet_miss[0]}"]'); page.wait_for_timeout(500)
        check('補交後提醒消失', page.locator(f'.stu[data-id="{pet_miss[0]}"] .hungry-bubble.hw').count() == 0 and {e['student_id']: e['status'] for e in api(page, 'GET', f"/homework/{hwid}/submissions")['entries']}[pet_miss[0]] == 'submitted')
        page.click('dialog [data-close]')
        page.click('.qchip[data-q="d:1"]'); page.click(f'.stu[data-id="{pet_miss[1]}"]', position={'x': 20, 'y': 30})
        page.wait_for_selector(f'.celebrate .cele-card[data-cele-student="{pet_miss[1]}"] .remind-line')
        check('加分彈窗：寵物提醒記得交功課', '中文作文' in page.inner_text('.celebrate .remind-line'), page.inner_text('.celebrate .remind-line'))
        page.screenshot(path=f'{OUT}/missing-remind.png')
        page.click('.celebrate .cele-card'); page.click('.qchip[data-q="menu"]')
        goto(page, BASE + f"#/s/{pet_miss[1]}"); page.wait_for_selector('.pet-card .speech.hw')
        check('學生頁：寵物講出欠交功課', '中文作文' in page.inner_text('.pet-card .speech.hw'))
        goto(page, BASE + f"#/c/{ids['4B']}/room"); wait_js(page, f"document.getElementById('class-switch')?.value === '{ids['4B']}' && !!document.querySelector('#room-grid .stu')")
        # 4) 全班合作目標
        page.click('#goal-pill'); page.fill('#goal-title', '全班看電影'); page.fill('#goal-target', '10'); page.click('dialog button:has-text("開始")')
        page.wait_for_selector('#goal-pill.has')
        page.click('[data-act=multi]')
        for sid in present_ids[:4]: page.click(f'.stu[data-id="{sid}"]')
        page.click('.qchip[data-q="d:3"]'); page.click('[data-act=selgo]')
        page.wait_for_selector('.celebrate.goal-win', timeout=8000)
        page.screenshot(path=f'{OUT}/goal-win.png')
        g = api(page, 'GET', f"/classes/{ids['4B']}/goal")
        check('全班目標：加分計入，達成時彈出慶祝', g['progress'] == 12 and '12' in page.inner_text('#goal-pill'), str(g))
        page.click('.celebrate.goal-win .cele-card'); page.click('.qchip[data-q="menu"]')
        page.click('#goal-pill'); page.wait_for_selector('dialog .jar'); page.screenshot(path=f'{OUT}/goal-jar.png'); page.click('dialog [data-close]')
        # 5) 獎勵兌換
        cur = {x['id']: x for x in api(page, 'GET', f"/classes/{ids['4B']}/full")['students']}
        buyer = max(cur.values(), key=lambda x: x['score'] - x['spent'])
        page.click('[data-act=rewards]'); page.click(f'dialog [data-s="{buyer["id"]}"]'); page.wait_for_selector('dialog .rw-item')
        page.click('dialog .rw-item:not([disabled]) >> nth=0'); page.click('dialog button:has-text("兌換") >> nth=-1')
        page.wait_for_selector('dialog .pick-result'); page.screenshot(path=f'{OUT}/reward.png')
        after_b = next(x for x in api(page, 'GET', f"/classes/{ids['4B']}/full")['students'] if x['id'] == buyer['id'])
        check('兌換：扣可用分數，總分及寵物 XP 不變', after_b['spent'] == buyer['spent'] + 5 and after_b['score'] == buyer['score'] and (after_b['pet'] or {}).get('xp') == (buyer['pet'] or {}).get('xp'), f"spent {buyer['spent']}→{after_b['spent']}")
        page.click('dialog [data-close]')
        # 6) 分組（只分出席學生）
        page.click('[data-act=regroup]'); page.wait_for_selector('dialog .rg-group'); page.fill('#rg-n', '3'); page.dispatch_event('#rg-n', 'change')
        page.wait_for_timeout(200); page.screenshot(path=f'{OUT}/regroup.png'); page.click('dialog [data-apply]'); page.wait_for_timeout(500)
        f = api(page, 'GET', f"/classes/{ids['4B']}/full")
        check('分組：3 組、出席學生全部有組、缺席不分組', len(f['groups']) == 3 and all(x['group_id'] for x in f['students'] if x['id'] in present_ids) and all(x['group_id'] is None for x in f['students'] if x['id'] in absent_ids))
        sizes = sorted(sum(1 for x in f['students'] if x['group_id'] == g['id']) for g in f['groups'])
        check('分組：人數平均', sizes[-1] - sizes[0] <= 1, str(sizes))
        # 7) 噪音計（假咪高峰）
        page.click('[data-act=noise]'); page.click('#nz-start'); page.wait_for_timeout(1500)
        nz = page.evaluate("({ w: parseFloat(document.getElementById('nz-bar').style.width) || 0, msg: document.getElementById('nz-msg').textContent })")
        page.screenshot(path=f'{OUT}/noise.png')
        check('噪音計：讀到咪高峰聲量', nz['w'] > 0 and '未能使用' not in nz['msg'], str(nz))
        page.click('dialog [data-close]')
        api(page, 'PUT', f"/classes/{ids['4B']}/attendance", {'date': att['date'], 'absent': []})

        # 隨機加分令各班處於不同階段，然後逐頁核對
        random.seed(7)
        for cn in ['4A', '4B', '6C']:
            f = api(page, 'GET', f"/classes/{ids[cn]}/full")
            for s in f['students']:
                n = random.choice([0, 3, 6, 21, 40, 60, 110])
                if n: api(page, 'POST', '/points', {'class_id': ids[cn], 'student_ids': [s['id']], 'delta': min(n, 100), 'client_batch_id': f'r-{s["id"]}'})
        for cn in ['4A', '4B', '6C']:
            f = api(page, 'GET', f"/classes/{ids[cn]}/full"); by = {s['id']: s for s in f['students']}
            goto(page, BASE + f"#/c/{ids[cn]}/room"); wait_js(page, f"document.getElementById('class-switch')?.value === '{ids[cn]}' && !!document.querySelector('#room-grid .stu')")
            verify_against_db(page, f'{cn} 課室模式', dom_avatars(page, '#room-grid .avatar'), by)
            goto(page, BASE + f"#/c/{ids[cn]}/pets"); wait_js(page, f"document.getElementById('class-switch')?.value === '{ids[cn]}' && !!document.querySelector('.tab[aria-current=page]')?.href.endsWith('/pets')")
            verify_against_db(page, f'{cn} 寵物頁', dom_avatars(page, '.pet-list .avatar, .status-grid .avatar'), by)
            goto(page, BASE + f"#/c/{ids[cn]}/poster"); page.wait_for_selector('#poster')
            verify_against_db(page, f'{cn} 海報', dom_avatars(page, '#poster .avatar'), by)
            sample = random.sample(f['students'], 2)
            for s in sample:
                goto(page, BASE + f"#/s/{s['id']}"); wait_js(page, f"document.querySelector('.pet-card > .avatar')?.dataset.student === '{s['id']}'")
                av = dom_avatars(page, '.pet-card > .avatar')
                verify_against_db(page, f'{cn} 學生資料頁 {s["name"]}', av, by)
                if s['pet']:
                    tl = page.eval_on_selector_all('.timeline .avatar', 'els => els.map(e => e.dataset.species)')
                    check(f'{cn} {s["name"]} 成長路線只顯示自己的品種', set(tl) == {s['pet']['species_key']}, str(set(tl)))
        goto(page, BASE + f"#/c/{ids['4A']}/room"); page.wait_for_selector('.stu'); page.screenshot(path=f'{OUT}/room-desktop.png', full_page=True)
        goto(page, BASE + f"#/c/{ids['4A']}/poster"); page.wait_for_selector('#poster'); page.wait_for_timeout(300)
        page.locator('#poster').screenshot(path=f'{OUT}/poster.png')
        goto(page, BASE + f"#/s/{pre_id}"); page.wait_for_selector('.pet-card'); page.screenshot(path=f'{OUT}/student.png', full_page=True)
        goto(page, BASE + f"#/c/{ids['4B']}/pets"); page.wait_for_selector('.dex'); page.screenshot(path=f'{OUT}/pets.png', full_page=True)

        # 圖鑑：40 格逐一載入成功
        dex = page.eval_on_selector_all('.dex img', "els => els.map(e => ({ src: e.getAttribute('src'), ok: e.complete && e.naturalWidth > 0 }))")
        page.wait_for_timeout(800)
        dex = page.eval_on_selector_all('.dex img', "els => els.map(e => ({ src: e.getAttribute('src'), ok: e.complete && e.naturalWidth > 0 }))")
        check('圖鑑 40 張圖全部成功載入', len(dex) == 40 and all(d['ok'] for d in dex) and len({d['src'] for d in dex}) == 40, f"{sum(d['ok'] for d in dex)}/{len(dex)}")

        # 功課及考試
        goto(page, BASE + f"#/c/{ids['4A']}/homework"); page.wait_for_selector('#tpl-row .tpl')
        page.click('#tpl-row .use:has-text("數學工作紙")')
        check('按常用功課自動填好名稱及科目', page.input_value('#hw-title') == '數學工作紙' and page.input_value('#hw-subj') == '數學' and page.input_value('#hw-due') != '')
        page.screenshot(path=f'{OUT}/homework-templates.png', full_page=True)
        page.fill('#hw-title', '中文作文'); page.fill('#hw-subj', '中文'); page.fill('#hw-due', '2026-10-15')
        page.fill('#hw-title', '周記'); page.check('#hw-save'); page.click('button:has-text("新增功課")')
        page.wait_for_selector('.status-grid')
        tpls = api(page, 'GET', '/homework-templates')
        check('勾選後儲存為常用功課', any(t['title'] == '周記' and t['subject'] == '中文' for t in tpls), str([t['title'] for t in tpls]))
        goto(page, BASE + f"#/c/{ids['4A']}/homework"); page.wait_for_selector('#tpl-row .use:has-text("周記")')
        page.click('#tpl-row .tpl:has-text("周記") .del'); page.click('dialog button:has-text("刪除")'); page.wait_for_timeout(400)
        check('刪除常用功課', page.locator('#tpl-row .use:has-text("周記")').count() == 0 and not any(t['title'] == '周記' for t in api(page, 'GET', '/homework-templates')))
        page.click('.hw-card >> nth=0'); page.wait_for_selector('.status-grid')
        page.wait_for_selector('.status-grid'); page.locator('[data-v=missing]').nth(1).click(); page.wait_for_timeout(200)
        page.click('text=未記錄的全部設為已交'); page.wait_for_selector('text=已將 11 位設為已交')
        hw = api(page, 'GET', f"/classes/{ids['4A']}/homework")[0]
        check('功課提交紀錄', hw['submitted'] == 11 and hw['missing'] == 1, str(hw))
        page.screenshot(path=f'{OUT}/homework.png', full_page=True)
        goto(page, BASE + f"#/c/{ids['4A']}/exams"); page.fill('#ex-title', '第一次小測'); page.fill('#ex-subj', '數學'); page.click('button:has-text("新增考試")')
        page.wait_for_selector('input[id^=sc-]')
        for i, inp in enumerate(page.locator('input[id^=sc-]').all()): inp.fill(str(50 + i * 4))
        page.click('text=儲存分數'); page.wait_for_selector('text=已儲存分數')
        ex = api(page, 'GET', f"/classes/{ids['4A']}/exams")[0]
        check('考試成績平均', abs(ex['avg'] - 72) < 0.01, str(ex['avg']))

        # 門檻：老師調整
        goto(page, BASE + '#/settings'); page.fill('#th-baby', '3'); page.fill('#th-junior', '10'); page.click('text=儲存門檻'); page.wait_for_timeout(400)
        page.click('text=立即檢查'); page.wait_for_selector('#audit-out .chip')
        audit_text = page.inner_text('#audit-out')
        check('資料一致性檢查：全部一致', '全部一致' in audit_text, audit_text)

        # 肚餓寵物：把 6C 的派蛋及加分時間推前 20 日（直接改資料庫模擬）
        import sqlite3
        con = sqlite3.connect(db); old = "strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 days')"
        c6ids = [x['id'] for x in api(page, 'GET', f"/classes/{ids['6C']}/full")['students']]
        con.execute(f"UPDATE student_pets SET assigned_at = {old} WHERE student_record_id IN ({','.join(map(str, c6ids))})")
        con.execute(f"UPDATE score_events SET created_at = {old} WHERE student_id IN ({','.join(map(str, c6ids))})"); con.commit(); con.close()
        goto(page, BASE + '#/classes'); goto(page, BASE + f"#/c/{ids['6C']}/room"); wait_js(page, f"document.getElementById('class-switch')?.value === '{ids['6C']}' && !!document.querySelector('#room-grid .stu')")
        page.reload(); page.wait_for_selector('#room-grid .stu')
        hungry_cards = page.locator('#room-grid .stu.hungry').count()
        check('肚餓：超過門檻的寵物顯示「幫幫我！」', hungry_cards == 4 and page.locator('#room-grid .hungry-bubble.lv2').count() == 4, str(hungry_cards))
        check('肚餓：未派蛋學生冇提示', page.locator(f'.stu[data-id="{c6ids[4]}"] .hungry-bubble').count() == 0)
        page.screenshot(path=f'{OUT}/hungry-room.png', full_page=True)
        page.click('#hungry-pill'); page.wait_for_selector('dialog [data-feed]'); page.screenshot(path=f'{OUT}/hungry-list.png')
        page.click(f'dialog [data-feed="{c6ids[0]}"]'); page.wait_for_selector(f'.celebrate .cele-card[data-cele-student="{c6ids[0]}"] .fed-bubble')
        page.screenshot(path=f'{OUT}/hungry-fed.png')
        page.click('.celebrate .cele-card')
        check('餵完即飽：提示消失，其餘仍肚餓', page.locator(f'.stu[data-id="{c6ids[0]}"] .hungry-bubble').count() == 0 and page.locator('#room-grid .stu.hungry').count() == 3)
        goto(page, BASE + f"#/s/{c6ids[1]}"); page.wait_for_selector('.pet-card .speech')
        check('學生頁顯示寵物說話', '幫幫我' in page.inner_text('.pet-card .speech') or '孵化' in page.inner_text('.pet-card .speech'), page.inner_text('.pet-card .speech'))
        page.screenshot(path=f'{OUT}/hungry-student.png', full_page=True)

        # 手機及平板
        for name, vp in [('mobile', {'width': 390, 'height': 844}), ('tablet', {'width': 820, 'height': 1180})]:
            m = br.new_context(viewport=vp, storage_state=ctx.storage_state(), color_scheme='dark').new_page()  # 系統深色模式下仍應是淺色
            m.goto(BASE + f"#/c/{ids['4B']}/room"); m.wait_for_selector('.stu')
            sw = m.evaluate('document.documentElement.scrollWidth'); check(f'{name} 無橫向捲動', sw <= vp['width'], str(sw))
            bg = m.evaluate("getComputedStyle(document.body).backgroundColor")
            check(f'{name}（系統深色模式）頁面仍是淺色', bg in ('rgb(255, 247, 249)',), bg)
            m.screenshot(path=f'{OUT}/room-{name}.png')
            m.goto(BASE + f"#/s/{bear['id']}"); m.wait_for_selector('.pet-card'); m.screenshot(path=f'{OUT}/student-{name}.png', full_page=True)

        # 批量刪除學生
        goto(page, BASE + f"#/c/{ids['6C']}/students"); page.wait_for_selector('[data-ssel]')
        before = page.locator('[data-ssel]').count()
        page.locator('[data-ssel]').nth(0).check(); page.locator('[data-ssel]').nth(1).check()
        check('批量刪除：顯示已選 2 位', page.inner_text('#ssel-count') == '已選 2 位' and page.is_enabled('#ssel-del'))
        page.click('#ssel-del'); page.click('dialog button:has-text("刪除 2 位")'); page.wait_for_selector('text=已刪除 2 位學生')
        wait_js(page, f"document.querySelectorAll('[data-ssel]').length === {before - 2}")
        left = api(page, 'GET', f"/classes/{ids['6C']}/full")['students']
        check('批量刪除：資料庫只剩其餘學生', len(left) == before - 2, str(len(left)))
        page.check('#ssel-all'); check('全選', page.inner_text('#ssel-count') == f'已選 {before - 2} 位')
        page.uncheck('#ssel-all')

        # 私隱：另一位老師
        other = br.new_context().new_page(); other.goto(BASE)
        other.evaluate("fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tm': '1' }, body: JSON.stringify({ email: 'lee@school.edu.hk', name: '李老師', password: 'Password123' }) })")
        st = other.evaluate(f"fetch('/api/classes/{ids['4A']}/full').then(r => r.status)")
        check('其他老師不能讀取本班（404）', st == 404, str(st))
        # 管理員頁（第一位註冊的陳老師是管理員）
        goto(page, BASE + '#/admin'); page.wait_for_selector('.admin-teacher')
        txt = page.inner_text('main')
        check('管理員頁：列出全部老師及班別', page.locator('.admin-teacher').count() == 2 and '4A' in txt and '6C' in txt and '李老師' in txt, str(page.locator('.admin-teacher').count()))
        check('管理員頁：唔顯示學生姓名或密碼', not any(n in txt for n in names4a + names4b) and 'Password' not in txt)
        page.screenshot(path=f'{OUT}/admin.png', full_page=True)
        goto(other, BASE + '#/admin'); other.wait_for_timeout(800)
        check('非管理員入唔到管理員頁', other.locator('.admin-teacher').count() == 0 and other.evaluate("fetch('/api/admin/teachers').then(r => r.status)") == 403)
        br.close()
    check('瀏覽器無 JavaScript 錯誤', not errors, ' | '.join(errors[:5]))
finally:
    srv.terminate()
    with open(os.path.join(OUT, 'e2e-results.json'), 'w') as f: json.dump(results, f, ensure_ascii=False, indent=1)
    print(f"\n{sum(1 for r in results if r[1])}/{len(results)} 通過")
