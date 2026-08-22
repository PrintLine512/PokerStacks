const { chromium } = require('playwright-core');
const path = require('path');
const url = 'file://' + path.resolve(__dirname, '..', 'index.html');

let fails = 0, passes = 0;
function ok(name, cond, extra){
  if(cond){ passes++; console.log('  PASS  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
const near = (a,b,eps=0.011) => Math.abs(a-b) <= eps;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // Google Fonts недоступны из тестовой песочницы — это не ошибка приложения
  page.on('console', m => { if(m.type() === 'error' && !/ERR_CONNECTION|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('requestfailed', r => { if(!/fonts\.(googleapis|gstatic)\.com/.test(r.url())) errors.push('request failed: ' + r.url()); });

  await page.goto(url);
  await page.waitForTimeout(300);

  console.log('\n— загрузка —');
  ok('нет ошибок JS при старте', errors.length === 0, errors);
  ok('4 игрока по умолчанию', await page.locator('.player').count() === 4);
  ok('первый игрок — «Я»', await page.locator('.player input.txt').first().inputValue() === 'Я');
  ok('банк = 4 × 1000', /4\s?000/.test(await page.locator('#s-pool').textContent()), await page.locator('#s-pool').textContent());
  ok('доля за набор = 1000 ₽', /1\s?000/.test(await page.locator('#s-share').textContent()), await page.locator('#s-share').textContent());

  console.log('\n— режим «по стекам» + набор —');
  const stacks = ['12000','8000','4000','0'];
  for(let i = 0; i < 4; i++){
    const inp = page.locator('.player').nth(i).locator('.p-body input').first();
    await inp.fill(stacks[i]);
  }
  await page.locator('.player').nth(1).locator('input.txt').fill('Аня');
  await page.locator('.player').nth(2).locator('input.txt').fill('Боря');
  await page.locator('.player').nth(3).locator('input.txt').fill('Вова');
  await page.waitForTimeout(120);

  let c = await page.evaluate(() => window.__pf.calc());
  ok('банк 4000', c.pool === 4000, c.pool);
  ok('всего фишек 24000', c.totalStack === 24000, c.totalStack);
  ok('выплата лидеру = 2000 (12000/24000)', near(c.rows[0].payout, 2000), c.rows[0].payout);
  ok('выплата аутсайдеру = 0', near(c.rows[3].payout, 0), c.rows[3].payout);
  ok('сумма выплат = банк', near(c.rows.reduce((a,r)=>a+r.payout,0), c.pool));
  ok('плательщику набора возвращают 3000', near(c.rows[0].setDelta, 3000), c.rows[0].setDelta);
  ok('остальные платят по 1000', near(c.rows[1].setDelta, -1000), c.rows[1].setDelta);
  ok('итог «Я» = 2000 − 1000 + 3000 = 4000', c.rows[0].netInt === 4000, c.rows[0].netInt);
  ok('итог «Вова» = 0 − 1000 − 1000 = −2000', c.rows[3].netInt === -2000, c.rows[3].netInt);
  ok('сумма итогов = 0 (точная)', near(c.rows.reduce((a,r)=>a+r.net,0), 0, 1e-9));
  ok('сумма итогов = 0 (после округления)', c.rows.reduce((a,r)=>a+r.netInt,0) === 0);

  let t = await page.evaluate(() => window.__pf.settle(window.__pf.calc().rows));
  ok('переводы сходятся с итогами', t.reduce((a,x)=>a+x.amt,0) === c.rows.filter(r=>r.netInt>0).reduce((a,r)=>a+r.netInt,0), t);
  ok('число переводов ≤ игроков−1', t.length <= 3, t.length);
  ok('в переводах нет отрицательных сумм', t.every(x => x.amt > 0), t);
  ok('таблица переводов отрисована', await page.locator('.pay-row').count() === t.length);
  ok('колонка «Набор» есть в таблице', (await page.locator('#results-head th').allTextContents()).some(x => x.indexOf('Набор') === 0));

  console.log('\n— некруглые деньги (проверка округления) —');
  await page.locator('#buyin').fill('333');
  await page.waitForTimeout(80);
  c = await page.evaluate(() => window.__pf.calc());
  ok('сумма округлённых итогов всё равно 0', c.rows.reduce((a,r)=>a+r.netInt,0) === 0, c.rows.map(r=>r.netInt));
  t = await page.evaluate(() => window.__pf.settle(window.__pf.calc().rows));
  ok('переводы балансируют и на дробных суммах',
     t.reduce((a,x)=>a+x.amt,0) === c.rows.filter(r=>r.netInt>0).reduce((a,r)=>a+r.netInt,0), {t, nets:c.rows.map(r=>r.netInt)});
  await page.locator('#buyin').fill('1000');
  await page.waitForTimeout(80);

  console.log('\n— режим «по местам» —');
  await page.locator('#mode-places').click();
  await page.waitForTimeout(100);
  c = await page.evaluate(() => window.__pf.calc());
  ok('панель призовых открылась', await page.locator('#places-box').isVisible());
  ok('1 место берёт 50% банка', near(c.rows[0].payout, 2000), c.rows[0].payout);
  ok('2 место берёт 30%', near(c.rows[1].payout, 1200), c.rows[1].payout);
  ok('3 место берёт 20%', near(c.rows[2].payout, 800), c.rows[2].payout);
  ok('4 место без выплаты', near(c.rows[3].payout, 0), c.rows[3].payout);
  ok('сумма выплат = банк', near(c.rows.reduce((a,r)=>a+r.payout,0), c.pool));

  await page.locator('#places .place-field input').first().fill('60');
  await page.waitForTimeout(80);
  c = await page.evaluate(() => window.__pf.calc());
  ok('кривые проценты (60/30/20) нормализуются, банк не раздувается', near(c.rows.reduce((a,r)=>a+r.payout,0), c.pool), c.rows.map(r=>r.payout));
  ok('подсказка о пересчёте показана', (await page.locator('#results-hint').textContent()).includes('пропорционально'));
  await page.locator('#places .place-field input').first().fill('50');
  await page.locator('#mode-stack').click();
  await page.waitForTimeout(80);

  console.log('\n— счётчик фишек —');
  await page.locator('.player').nth(2).locator('button.ghost').click();
  await page.waitForTimeout(80);
  const chipInputs = page.locator('.player').nth(2).locator('.chip-row input');
  ok('4 номинала в панели', await chipInputs.count() === 4);
  await chipInputs.nth(0).fill('4');    // 25 × 4 = 100
  await chipInputs.nth(1).fill('3');    // 100 × 3 = 300
  await chipInputs.nth(3).fill('2');    // 1000 × 2 = 2000
  await page.waitForTimeout(100);
  c = await page.evaluate(() => window.__pf.calc());
  ok('стек посчитан по фишкам = 2400', c.rows[2].p.stack === 2400, c.rows[2].p.stack);
  const stackField = await page.locator('.player').nth(2).locator('.p-body input').first().inputValue();
  ok('поле стека обновилось из фишек', /2\s?400/.test(stackField), stackField);
  ok('стек с пробелом-разделителем парсится обратно', await page.evaluate(() => window.__pf.num('2 400')) === 2400);

  console.log('\n— добавление и удаление игроков —');
  await page.locator('#add-player').click();
  await page.waitForTimeout(80);
  ok('игрок добавлен', await page.locator('.player').count() === 5);
  ok('доля за набор пересчиталась (4000/5)', /800/.test(await page.locator('#s-share').textContent()), await page.locator('#s-share').textContent());
  ok('новый игрок появился в списке плательщиков', await page.locator('#set-payer option').count() === 5);

  await page.locator('.player').first().locator('.del').click();
  await page.waitForTimeout(100);
  ok('игрок удалён', await page.locator('.player').count() === 4);
  c = await page.evaluate(() => window.__pf.calc());
  ok('плательщик набора переназначен, баланс сходится', c.rows.reduce((a,r)=>a+r.netInt,0) === 0 && c.payerOk, {payerOk:c.payerOk, nets:c.rows.map(r=>r.netInt)});

  console.log('\n— выключенный набор —');
  await page.locator('.switch').click();
  await page.waitForTimeout(80);
  c = await page.evaluate(() => window.__pf.calc());
  ok('тумблер выключился', await page.locator('#set-split').isChecked() === false);
  ok('доли за набор обнулены', c.rows.every(r => r.setDelta === 0));
  ok('баланс всё ещё нулевой', c.rows.reduce((a,r)=>a+r.netInt,0) === 0);
  ok('колонка «Набор» скрыта', !(await page.locator('#results-head th').allTextContents()).some(x => x.indexOf('Набор') === 0));
  await page.locator('.switch').click();
  await page.waitForTimeout(80);

  console.log('\n— переименование —');
  await page.locator('.player').first().locator('input.txt').fill('Аня Б.');
  await page.waitForTimeout(80);
  ok('имя обновилось в селекте плательщика', (await page.locator('#set-payer option').allTextContents()).includes('Аня Б.'),
     await page.locator('#set-payer option').allTextContents());

  console.log('\n— сохранение между открытиями —');
  const before = await page.evaluate(() => JSON.stringify(window.__pf.calc().rows.map(r => [r.name, r.p.stack, r.netInt])));
  await page.reload();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => JSON.stringify(window.__pf.calc().rows.map(r => [r.name, r.p.stack, r.netInt])));
  ok('после перезагрузки всё на месте', before === after, { before, after });
  ok('бай-ин сохранился', await page.locator('#buyin').inputValue() !== '', await page.locator('#buyin').inputValue());
  ok('нет ошибок JS после перезагрузки', errors.length === 0, errors);

  console.log('\n— сброс в два клика —');
  const resetBtn = page.locator('#reset');
  await resetBtn.click();
  await page.waitForTimeout(60);
  ok('первый клик просит подтверждения', (await resetBtn.textContent()).includes('Точно'), await resetBtn.textContent());
  ok('данные ещё не стёрты', await page.locator('.player').first().locator('input.txt').inputValue() === 'Аня Б.');
  await resetBtn.click();
  await page.waitForTimeout(120);
  ok('второй клик сбрасывает', await page.locator('.player').first().locator('input.txt').inputValue() === 'Я');
  ok('после сброса 4 игрока', await page.locator('.player').count() === 4);
  ok('после сброса стеки пустые', (await page.evaluate(() => window.__pf.calc().totalStack)) === 0);

  console.log('\n— крайние случаи —');
  ok('нулевые стеки: взносы остаются у владельцев, деньги не пропадают',
     await page.evaluate(() => { const c = window.__pf.calc();
       return c.pending && c.rows.every(r => isFinite(r.netInt)) && c.rows.reduce((a,r)=>a+r.netInt,0) === 0; }));
  ok('в выплатах прочерк, пока стеки не введены',
     (await page.locator('#results td').nth(4).textContent()) === '—', await page.locator('#results td').nth(4).textContent());
  ok('подсказка про стеки показана', (await page.locator('#results-hint').textContent()).includes('стеки'));
  for(let i = 0; i < 3; i++){ await page.locator('.player .del').first().click(); await page.waitForTimeout(60); }
  await page.locator('.player .del').first().click();
  await page.waitForTimeout(120);
  ok('пустой список игроков не роняет приложение', await page.locator('.player').count() === 0);
  ok('подсказка «добавь игроков»', (await page.locator('#results-hint').textContent()).includes('Добавь'));
  ok('переводов нет', (await page.locator('.pays').textContent()).includes('расчёте'));
  await page.locator('#add-player').click();
  await page.waitForTimeout(100);
  c = await page.evaluate(() => window.__pf.calc());
  ok('один игрок: итог нулевой, банк не теряется', c.rows[0].netInt === 0, c.rows.map(r=>r.netInt));

  console.log('\n— инвариант: деньги не появляются и не пропадают —');
  const invariant = await page.evaluate(() => {
    const P = window.__pf, S = P.S, bad = [];
    const rnd = (seed => () => (seed = (seed * 9301 + 49297) % 233280) / 233280)(7);
    for(let iter = 0; iter < 400; iter++){
      S.players = []; S.nextId = 1;
      const n = 1 + Math.floor(rnd() * 8);
      for(let i = 0; i < n; i++)
        S.players.push({ id: S.nextId++, name: '', entries: Math.floor(rnd() * 4), stack: Math.floor(rnd() * rnd() * 40000), chips: [], open: false });
      S.buyIn = Math.floor(rnd() * 3000) + (rnd() < .3 ? 0.5 : 0);
      S.setCost = rnd() < .2 ? 0 : Math.floor(rnd() * 9000);
      S.setSplit = rnd() < .8;
      S.setPayer = S.players[Math.floor(rnd() * n)].id;
      S.mode = rnd() < .5 ? 'stack' : 'places';
      S.places = [Math.floor(rnd() * 80), Math.floor(rnd() * 40), Math.floor(rnd() * 20)];
      const c = P.calc();
      const exact = c.rows.reduce((a, r) => a + r.net, 0);
      const ints = c.rows.reduce((a, r) => a + r.netInt, 0);
      const paid = c.rows.reduce((a, r) => a + r.payout, 0);
      const t = P.settle(c.rows);
      const credits = c.rows.filter(r => r.netInt > 0).reduce((a, r) => a + r.netInt, 0);
      const moved = t.reduce((a, x) => a + x.amt, 0);
      if(Math.abs(exact) > 1e-6) bad.push(['exact', iter, exact]);
      if(ints !== 0) bad.push(['rounded', iter, ints]);
      if(Math.abs(paid - c.pool) > 1e-6) bad.push(['payouts', iter, paid, c.pool]);
      if(moved !== credits) bad.push(['settle', iter, moved, credits]);
      if(c.rows.some(r => !isFinite(r.net) || !isFinite(r.payout))) bad.push(['NaN', iter]);
      if(t.length > Math.max(0, n - 1)) bad.push(['too many transfers', iter, t.length, n]);
    }
    return bad.slice(0, 5);
  });
  ok('400 случайных раскладов: баланс, выплаты и переводы сходятся', invariant.length === 0, invariant);
  await page.reload();
  await page.waitForTimeout(200);

  console.log('\n— вёрстка —');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('нет горизонтальной прокрутки на 390px', overflow <= 1, overflow);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(120);
  const dark = await page.evaluate(() => {
    const b = getComputedStyle(document.body);
    return { bg: b.backgroundColor, fg: b.color };
  });
  ok('тёмная тема: фон непрозрачный и тёмный', dark.bg !== 'rgba(0, 0, 0, 0)' && dark.bg.match(/\d+/g).slice(0,3).map(Number).every(v => v < 60), dark);
  ok('тёмная тема: текст светлый', dark.fg.match(/\d+/g).slice(0,3).map(Number).every(v => v > 150), dark);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(120);
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok('светлая тема: фон светлый', light.match(/\d+/g).slice(0,3).map(Number).every(v => v > 200), light);
  const fontOk = await page.evaluate(() => getComputedStyle(document.querySelector('h1')).fontFamily.includes('Oswald'));
  ok('шрифт заголовка подключён', fontOk);

  await page.screenshot({ path: 'shot-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 900, height: 1000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'shot-desktop.png', fullPage: true });

  console.log('\n— ошибки консоли за весь прогон —');
  ok('консоль чистая', errors.length === 0, errors);

  await browser.close();
  console.log('\n' + (fails ? 'ПРОВАЛЕНО: ' + fails + ' из ' + (fails + passes) : 'ВСЁ ЗЕЛЁНОЕ: ' + passes + ' проверок'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
