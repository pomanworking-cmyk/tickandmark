// 預覽用示範資料（全部為虛構學生）。經 API 建立，因此與真實操作同樣遵守寵物規則。
export async function seedDemo(be) {
  const r = (m, p, b) => be.request(m, p, b);
  await r('POST', '/auth/register', { email: 'demo@tickandmark.hk', name: '示範老師', password: 'demo12345' });
  const boot = await r('GET', '/bootstrap');
  const tag = (label) => boot.tags.find(t => t.label === label).id;
  const lists = {
    '3B': ['陳大文', '李小明', '黃美玲', '張家豪', '何詠琪', '林子軒', '吳嘉欣', '鄭浩然', '梁曉晴', '周天佑', '馮凱琳', '蔡志明', '鄧雅雯', '許俊傑', '曾慧敏', '彭啟聰'],
    '5A': ['郭家樂', '羅思穎', '謝浩霖', '韓美琪', '唐子健', '馬詩韻', '葉朗峰', '方采盈', '雷俊言', '姚樂怡'],
  };
  let seq = 0; const bid = () => `seed-${++seq}`;
  for (const [cn, names] of Object.entries(lists)) {
    const c = await r('POST', '/classes', { name: cn, school_year: '2026-27' });
    const { created } = await r('POST', `/classes/${c.id}/students`, { students: names.map((name, i) => ({ number: i + 1, name, score: (i * 7) % 13 })) });
    const groups = [['藍鯨隊', '#8cc4f5'], ['珊瑚隊', '#ffa3ba'], ['竹林隊', '#8ad9b4'], ['向日葵隊', '#ffd166']];
    for (let g = 0; g < groups.length; g++) {
      const grp = await r('POST', `/classes/${c.id}/groups`, { name: groups[g][0], color: groups[g][1] });
      await r('PUT', `/groups/${grp.id}/members`, { student_ids: created.filter((_, i) => i % 4 === g).map(s => s.id) });
    }
    // 留兩位未派蛋，示範派蛋流程
    const withPets = created.slice(0, created.length - 2);
    const keys = ['fire_fox', 'metal_cat', 'wood_deer', 'water_otter', 'earth_bear', 'metal_bird', 'wood_rabbit', 'water_koi'];
    for (let i = 0; i < withPets.length; i++) await r('POST', '/pets/assign', { student_ids: [withPets[i].id], species_key: keys[(i + (cn === '5A' ? 3 : 0)) % 8] });
    // 一些課堂加分，令不同學生處於不同階段
    const plan = [0, 3, 6, 12, 22, 35, 55, 100, 2, 8, 18, 26, 4, 60];
    for (let i = 0; i < withPets.length; i++) if (plan[i]) await r('POST', '/points', { class_id: c.id, student_ids: [withPets[i].id], delta: plan[i], reason: '學期初表現', client_batch_id: bid() });
    await r('POST', '/points', { class_id: c.id, student_ids: [created[1].id, created[2].id, created[5].id], tag_id: tag('積極舉手'), client_batch_id: bid() });
    await r('POST', '/points', { class_id: c.id, student_ids: [created[3].id], tag_id: tag('欠交功課'), client_batch_id: bid() });
    const hw = await r('POST', `/classes/${c.id}/homework`, { title: '中文作文：我的暑假', subject: '中文', due_date: '2026-10-09' });
    await r('PUT', `/homework/${hw.id}/submissions`, { entries: created.map((s, i) => ({ student_id: s.id, status: i % 6 === 5 ? 'missing' : i % 7 === 3 ? 'late' : 'submitted' })) });
    await r('POST', `/classes/${c.id}/homework`, { title: '數學工作紙 3.2', subject: '數學', due_date: '2026-10-12' });
    const ex = await r('POST', `/classes/${c.id}/exams`, { title: '第一次小測', subject: '數學', full_mark: 100, exam_date: '2026-10-05' });
    await r('PUT', `/exams/${ex.id}/scores`, { scores: created.map((s, i) => ({ student_id: s.id, score: 58 + ((i * 17) % 42) })) });
  }
  // 第一班：全班目標、今日一位缺席、一次兌換
  const first = (await r('GET', '/classes')).find(c => c.name === '3B');
  const full = await r('GET', `/classes/${first.id}/full`);
  await r('POST', `/classes/${first.id}/goal`, { title: '全班看電影', target: 150 });
  await r('POST', '/points', { class_id: first.id, student_ids: full.students.slice(0, 8).map(s => s.id), delta: 4, reason: '全班安靜做練習', client_batch_id: bid() });
  const d = new Date(); const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await r('PUT', `/classes/${first.id}/attendance`, { date: today, absent: [full.students[12].id] });
  const rewards = (await r('GET', '/rewards'));
  await r('POST', '/redemptions', { student_id: full.students[7].id, reward_id: rewards[0].id });
  // 示範「肚餓」：把派蛋日及部分同學的加分時間推前（只改示範資料）
  const S = be.state; const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
  S.student_pets.forEach(p => { p.assigned_at = ago(20); });
  const backdate = (sid, days) => S.score_events.filter(e => e.student_id === sid).forEach(e => { e.created_at = ago(days); });
  [full.students[9], full.students[10]].forEach(s => backdate(s.id, 6));   // 肚餓
  [full.students[11], full.students[13]].forEach(s => backdate(s.id, 11)); // 好肚餓，要主人幫忙
  await r('POST', '/auth/logout'); // 預覽由登入頁開始
}
