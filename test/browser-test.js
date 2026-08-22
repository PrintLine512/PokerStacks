const { chromium } = require('playwright-core');
const path = require('path');
const url = 'file://' + path.resolve(__dirname, '..', 'index.html');

let fails = 0, passes = 0;
function ok(name, cond, extra){
  if(cond){ passes++; console.log('  PASS  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra !== undefined ? '  →  ' + JSON.stringify(extra) : '')); }
}
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, channel: process.env.CHROME_PATH ? undefined : 'chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // Google Fonts недоступны из тестовой песочницы — это не ошибка приложения
  page.on('console', m => { if(m.type() === 'error' && !/ERR_CONNECTION|net::/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('requestfailed', r => { if(!/fonts\.(googleapis|gstatic)\.com/.test(r.url())) errors.push('request failed: ' + r.url()); });

  const calc = () => page.evaluate(() => window.__pf.calc());
  const settle = () => page.evaluate(() => window.__pf.settle(window.__pf.calc().rows));
  const hints = () => page.locator('#results-hint').textContent();
  const setPlace = async (i, v) => { await page.locator('.player').nth(i).locator('select.place').selectOption(String(v)); await page.waitForTimeout(60); };
  const setStack = async (i, v) => { await page.locator('.player').nth(i).locator('.p-body input').first().fill(String(v)); await page.waitForTimeout(60); };
  const setEntries = async (i, v) => {
    const st = page.locator('.player').nth(i).locator('.stepper');
    const now = parseInt(await st.locator('.n').textContent(), 10);
    for(let k = now; k < v; k++) await st.locator('button').nth(1).click();
    for(let k = now; k > v; k--) await st.locator('button').first().click();
    await page.waitForTimeout(60);
  };

  await page.goto(url);
  await page.waitForTimeout(300);

  console.log('\n— загрузка —');
  ok('нет ошибок JS при старте', errors.length === 0, errors);
  ok('4 игрока по умолчанию', await page.locator('.player').count() === 4);
  ok('первый игрок — «Я»', await page.locator('.player input.txt').first().inputValue() === 'Я');
  ok('режим «турнир по местам» включён', await page.locator('#mode-places').getAttribute('aria-pressed') === 'true');
  ok('расход «Набор фишек» на месте', await page.locator('.exp').count() === 1);
  ok('доля расходов = 1000 ₽', /1\s?000/.test(await page.locator('#s-share, .stat .v').last().textContent()));
  ok('пока мест нет — подсказка про места', (await hints()).includes('Расставь места'));

  console.log('\n— турнир по местам —');
  await page.locator('.player').nth(1).locator('input.txt').fill('Аня');
  await page.locator('.player').nth(2).locator('input.txt').fill('Боря');
  await page.locator('.player').nth(3).locator('input.txt').fill('Вова');
  await setPlace(0, 1); await setPlace(1, 2); await setPlace(2, 3); await setPlace(3, 4);
  let c = await calc();
  ok('банк = 4 × 1000', c.pool === 4000, c.pool);
  ok('1 место берёт 50% банка', near(c.rows[0].payout, 2000), c.rows[0].payout);
  ok('2 место берёт 30%', near(c.rows[1].payout, 1200), c.rows[1].payout);
  ok('3 место берёт 20%', near(c.rows[2].payout, 800), c.rows[2].payout);
  ok('4 место без выплаты', near(c.rows[3].payout, 0), c.rows[3].payout);
  ok('сумма выплат = банк', near(c.rows.reduce((a, r) => a + r.payout, 0), c.pool));
  ok('«Я» платил за набор → +3000 к итогу', near(c.rows[0].expDelta, 3000), c.rows[0].expDelta);
  ok('итог «Я» = 2000 − 1000 + 3000 = 4000', c.rows[0].netInt === 4000, c.rows[0].netInt);
  ok('итог «Вова» = 0 − 1000 − 1000 = −2000', c.rows[3].netInt === -2000, c.rows[3].netInt);
  ok('сумма итогов = 0', c.rows.reduce((a, r) => a + r.netInt, 0) === 0);
  ok('первое место подсвечено в карточке', await page.locator('.player .rank.win').count() === 1);
  ok('таблица отсортирована по местам',
     (await page.locator('#results td:nth-child(2)').allTextContents()).join() === 'Я,Аня,Боря,Вова',
     await page.locator('#results td:nth-child(2)').allTextContents());
  ok('в таблице нет колонки «Стек»', !(await page.locator('#results-head th').allTextContents()).includes('Стек'));

  console.log('\n— места: крайние случаи —');
  await setPlace(1, 1);
  c = await calc();
  ok('двое на первом месте → предупреждение', (await hints()).includes('делится между ними'));
  ok('банк при этом не раздувается', near(c.rows.reduce((a, r) => a + r.payout, 0), c.pool), c.rows.map(r => r.payout));
  ok('приз за первое место поделён поровну', near(c.rows[0].payout, c.rows[1].payout), [c.rows[0].payout, c.rows[1].payout]);
  await setPlace(1, 2);
  await page.locator('#places .place-field input').first().fill('60');
  await page.waitForTimeout(80);
  c = await calc();
  ok('проценты 60/30/20 нормализуются', near(c.rows.reduce((a, r) => a + r.payout, 0), c.pool), c.rows.map(r => r.payout));
  ok('показана подсказка о пересчёте', (await hints()).includes('пропорционально'));
  await page.locator('#places .place-field input').first().fill('50');
  await page.waitForTimeout(80);

  await page.locator('#places .row-actions button').nth(1).click();  // − место
  await page.waitForTimeout(100);
  c = await calc();
  ok('убрали 3 место — Боря остался без приза', near(c.rows[2].payout, 0), c.rows[2].payout);
  ok('банк всё равно роздан целиком', near(c.rows.reduce((a, r) => a + r.payout, 0), c.pool));
  await page.locator('#places .row-actions button').first().click();  // + место
  await page.waitForTimeout(100);
  await page.locator('#places .place-field input').nth(2).fill('20');
  await page.waitForTimeout(80);

  console.log('\n— ребаи —');
  await setEntries(1, 2);
  c = await calc();
  ok('банк вырос до 5000', c.pool === 5000, c.pool);
  ok('взнос «Ани» = 2000', c.rows[1].contrib === 2000, c.rows[1].contrib);
  ok('сумма итогов всё ещё ноль', c.rows.reduce((a, r) => a + r.netInt, 0) === 0);
  await setEntries(1, 1);

  console.log('\n— делим по стекам —');
  await page.locator('#mode-stack').click();
  await page.waitForTimeout(150);
  ok('поля стеков появились', await page.locator('.player').first().locator('.p-body input').count() === 1);
  await setStack(0, 12000); await setStack(1, 8000); await setStack(2, 4000); await setStack(3, 0);
  c = await calc();
  ok('всего фишек 24000', c.totalStack === 24000, c.totalStack);
  ok('выплата лидеру = 2000 (12000/24000)', near(c.rows[0].payout, 2000), c.rows[0].payout);
  ok('выплата аутсайдеру = 0', near(c.rows[3].payout, 0), c.rows[3].payout);
  ok('сумма выплат = банк', near(c.rows.reduce((a, r) => a + r.payout, 0), c.pool));
  ok('сумма итогов = 0', c.rows.reduce((a, r) => a + r.netInt, 0) === 0);
  ok('курс фишки показан', /0,16/.test(await page.locator('#rate-note').textContent()), await page.locator('#rate-note').textContent());
  let t = await settle();
  ok('переводы сходятся с итогами', t.reduce((a, x) => a + x.amt, 0) === c.rows.filter(r => r.netInt > 0).reduce((a, r) => a + r.netInt, 0), t);
  ok('число переводов ≤ игроков−1', t.length <= 3, t.length);

  console.log('\n— счётчик фишек —');
  await page.locator('.player').nth(2).locator('button.ghost').click();
  await page.waitForTimeout(80);
  const chipInputs = page.locator('.player').nth(2).locator('.chip-row input');
  ok('4 номинала в панели', await chipInputs.count() === 4);
  await chipInputs.nth(0).fill('4');    // 25 × 4 = 100
  await chipInputs.nth(1).fill('3');    // 100 × 3 = 300
  await chipInputs.nth(3).fill('2');    // 1000 × 2 = 2000
  await page.waitForTimeout(120);
  c = await calc();
  ok('стек посчитан по фишкам = 2400', c.rows[2].p.stack === 2400, c.rows[2].p.stack);
  ok('поле стека обновилось', /2\s?400/.test(await page.locator('.player').nth(2).locator('.p-body input').first().inputValue()));
  ok('число с пробелом парсится обратно', await page.evaluate(() => window.__pf.num('2 400')) === 2400);
  await setStack(2, 4000);

  console.log('\n— кэш: каждый выходит когда хочет —');
  await page.locator('#mode-cash').click();
  await page.waitForTimeout(150);
  ok('появилось поле «фишек за закупку»', await page.locator('#chips-field').isVisible());
  ok('курс 1 фишка = 0,2 ₽', /0,2/.test(await page.locator('#rate-note').textContent()), await page.locator('#rate-note').textContent());
  // закупки: Я ×2, Аня ×1, Боря ×1, Вова ×3 = 7000 ₽ = 35 000 фишек
  await setEntries(0, 2); await setEntries(1, 1); await setEntries(2, 1); await setEntries(3, 3);
  await setStack(0, 15000); await setStack(1, 3000); await setStack(2, 0); await setStack(3, 17000);
  c = await calc();
  ok('закуплено 7000 ₽', c.pool === 7000, c.pool);
  ok('фишки сходятся с закупками', near(c.cashDiff, 0), c.cashDiff);
  ok('вышел с 15000 фишек = 3000 ₽', near(c.rows[0].payout, 3000), c.rows[0].payout);
  ok('«Боря» вышел ни с чем = 0 ₽', near(c.rows[2].payout, 0), c.rows[2].payout);
  ok('итог «Я» = 3000 − 2000 + 3000 = 4000', c.rows[0].netInt === 4000, c.rows[0].netInt);
  ok('итог «Вовы» = 3400 − 3000 − 1000 = −600', c.rows[3].netInt === -600, c.rows[3].netInt);
  ok('сумма итогов = 0', c.rows.reduce((a, r) => a + r.netInt, 0) === 0);
  ok('нет предупреждения о расхождении', !(await hints()).includes('больше, чем закуплено'));
  ok('в карточке показан пересчёт в рубли', /3\s?000/.test(await page.locator('.player').first().locator('.p-conv').textContent()),
     await page.locator('.player').first().locator('.p-conv').textContent());
  t = await settle();
  ok('переводы закрывают все долги', t.reduce((a, x) => a + x.amt, 0) === c.rows.filter(r => r.netInt > 0).reduce((a, r) => a + r.netInt, 0), t);

  console.log('\n— кэш: фишки не сошлись —');
  await setStack(3, 19000);   // на 2000 фишек = 400 ₽ больше, чем закуплено
  c = await calc();
  ok('расхождение посчитано', near(c.cashDiff, 400), c.cashDiff);
  ok('показано предупреждение', (await hints()).includes('больше, чем закуплено'), await hints());
  ok('плитка «вышло фишками» подсвечена', await page.locator('.stat.alarm').count() === 1);
  ok('в переводах отмечен непокрытый остаток', (await page.locator('#pays').textContent()).includes('Переводы не закрывают'));
  await setStack(3, 15000);   // теперь на 400 ₽ меньше
  c = await calc();
  ok('недостача тоже ловится', near(c.cashDiff, -400) && (await hints()).includes('меньше, чем закуплено'), c.cashDiff);
  await setStack(3, 17000);

  ok('поле «фишек за закупку» видно только в кэше', await page.locator('#chips-field').isVisible());
  await page.locator('#mode-places').click();
  await page.waitForTimeout(120);
  ok('в турнире поля «фишек за закупку» нет', !(await page.locator('#chips-field').isVisible()));
  ok('в турнире по местам нет полей стека', await page.locator('.player').first().locator('.p-body input').count() === 0);
  await page.locator('#mode-cash').click();
  await page.waitForTimeout(150);
  c = await calc();
  ok('в кэше список отсортирован по выигрышу',
     c.order.map(i => c.rows[i].netInt).every((v, i, a) => i === 0 || a[i - 1] >= v), c.order.map(i => c.rows[i].netInt));

  console.log('\n— общие расходы —');
  await page.locator('#add-exp').click();
  await page.waitForTimeout(80);
  await page.locator('.exp').nth(1).locator('input.txt').fill('Пицца');
  await page.locator('.exp').nth(1).locator('.amt-wrap input').fill('1800');
  await page.locator('.exp').nth(1).locator('select.payer').selectOption({ label: 'Аня' });
  await page.locator('#add-exp').click();
  await page.waitForTimeout(80);
  await page.locator('.exp').nth(2).locator('input.txt').fill('Вода');
  await page.locator('.exp').nth(2).locator('.amt-wrap input').fill('400');
  await page.locator('.exp').nth(2).locator('select.payer').selectOption({ label: 'Боря' });
  await page.waitForTimeout(120);
  c = await calc();
  ok('итого расходов 6200', c.expTotal === 6200, c.expTotal);
  ok('доля 1550 с человека', near(c.share, 1550), c.share);
  ok('«Я» платил 4000 → +2450', near(c.rows[0].expDelta, 2450), c.rows[0].expDelta);
  ok('«Аня» платила 1800 → +250', near(c.rows[1].expDelta, 250), c.rows[1].expDelta);
  ok('«Вова» не платил → −1550', near(c.rows[3].expDelta, -1550), c.rows[3].expDelta);
  ok('доли расходов в сумме дают ноль', near(c.rows.reduce((a, r) => a + r.expDelta, 0), 0, 1e-9));
  ok('сумма итогов = 0', c.rows.reduce((a, r) => a + r.netInt, 0) === 0);
  ok('строка «итого расходов» показана', /6\s?200/.test(await page.locator('#exp-total').textContent()), await page.locator('#exp-total').textContent());
  await page.locator('.exp').nth(2).locator('.del').click();
  await page.locator('.exp').nth(1).locator('.del').click();
  await page.waitForTimeout(120);
  ok('расход удаляется', await page.locator('.exp').count() === 1);

  console.log('\n— игроки —');
  await page.locator('#add-player').click();
  await page.waitForTimeout(100);
  ok('игрок добавлен', await page.locator('.player').count() === 5);
  ok('доля расходов пересчиталась (4000/5)', /800/.test(await page.locator('.stat').last().textContent()), await page.locator('.stat').last().textContent());
  ok('новый игрок появился в списке плательщиков', await page.locator('.exp select.payer option').count() === 5);
  await page.locator('.player').first().locator('.del').click();
  await page.waitForTimeout(120);
  ok('игрок удалён', await page.locator('.player').count() === 4);
  c = await calc();
  ok('плательщик расхода переназначен, баланс сходится',
     c.rows.reduce((a, r) => a + r.netInt, 0) === Math.round(c.cashDiff) && c.hasExp, c.rows.map(r => r.netInt));
  ok('в селекте плательщика нет удалённого игрока', await page.locator('.exp select.payer option').count() === 4);
  await page.locator('.player').first().locator('input.txt').fill('Аня Б.');
  await page.waitForTimeout(80);
  ok('имя обновилось в селекте плательщика', (await page.locator('.exp select.payer option').allTextContents()).includes('Аня Б.'));

  console.log('\n— расходов нет вообще —');
  await page.locator('.exp .del').first().click();
  await page.waitForTimeout(100);
  c = await calc();
  ok('список пуст, показана заглушка', await page.locator('.exp-empty').count() === 1);
  ok('доли расходов обнулены', c.rows.every(r => r.expDelta === 0));
  ok('колонка «Расходы» скрыта', !(await page.locator('#results-head th').allTextContents()).some(x => x.indexOf('Расходы') === 0));
  ok('строка «итого расходов» скрыта', (await page.locator('#exp-total').textContent()).trim() === '');
  await page.locator('#add-exp').click();
  await page.waitForTimeout(80);
  await page.locator('.exp').first().locator('input.txt').fill('Набор фишек');
  await page.locator('.exp').first().locator('.amt-wrap input').fill('4000');
  await page.waitForTimeout(100);

  console.log('\n— сохранение между открытиями —');
  const before = await page.evaluate(() => JSON.stringify({
    mode: window.__pf.S.mode,
    rows: window.__pf.calc().rows.map(r => [r.name, r.p.stack, r.p.place, r.p.entries, r.netInt]),
    exp: window.__pf.S.expenses.map(e => [e.title, e.amount, e.payer])
  }));
  await page.reload();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => JSON.stringify({
    mode: window.__pf.S.mode,
    rows: window.__pf.calc().rows.map(r => [r.name, r.p.stack, r.p.place, r.p.entries, r.netInt]),
    exp: window.__pf.S.expenses.map(e => [e.title, e.amount, e.payer])
  }));
  ok('после перезагрузки всё на месте, включая режим и места', before === after, { before, after });
  ok('нет ошибок JS после перезагрузки', errors.length === 0, errors);

  console.log('\n— сброс в два клика —');
  const resetBtn = page.locator('#reset');
  await resetBtn.click();
  await page.waitForTimeout(60);
  ok('первый клик просит подтверждения', (await resetBtn.textContent()).includes('Точно'));
  ok('данные ещё не стёрты', await page.locator('.player').first().locator('input.txt').inputValue() === 'Аня Б.');
  await resetBtn.click();
  await page.waitForTimeout(150);
  ok('второй клик сбрасывает', await page.locator('.player').first().locator('input.txt').inputValue() === 'Я');
  ok('после сброса 4 игрока', await page.locator('.player').count() === 4);
  ok('после сброса результаты пустые', (await calc()).pending === true);

  console.log('\n— крайние случаи —');
  c = await calc();
  ok('без результатов деньги не пропадают', c.rows.reduce((a, r) => a + r.netInt, 0) === 0 && c.rows.every(r => isFinite(r.netInt)));
  const heads = await page.locator('#results-head th').allTextContents();
  const payCol = heads.findIndex(h => h.indexOf('Выплата') === 0 || h.indexOf('Кэшаут') === 0);
  ok('в выплатах прочерк', payCol > 0 && (await page.locator('#results td').nth(payCol).textContent()) === '—',
     { heads, cell: payCol > 0 ? await page.locator('#results td').nth(payCol).textContent() : null });
  for(let i = 0; i < 4; i++){ await page.locator('.player .del').first().click(); await page.waitForTimeout(60); }
  ok('пустой список игроков не роняет приложение', await page.locator('.player').count() === 0);
  ok('подсказка «добавь игроков»', (await hints()).includes('Добавь'));
  ok('переводов нет', (await page.locator('#pays').textContent()).includes('расчёте'));
  await page.locator('#add-player').click();
  await page.waitForTimeout(100);
  c = await calc();
  ok('один игрок: итог нулевой', c.rows[0].netInt === 0, c.rows.map(r => r.netInt));

  await page.evaluate(() => {
    const P = window.__pf, S = P.S;
    S.expenses = [{ id: 99, title: 'Такси', amount: 900, payer: 12345 }];  // плательщика нет в списке
    P.renderExpenses();
  });
  await page.waitForTimeout(100);
  c = await calc();
  ok('расход без живого плательщика переезжает на первого игрока',
     c.rows.reduce((a, r) => a + r.netInt, 0) === 0 && c.expTotal === 900, [c.expTotal, c.rows.map(r => r.netInt)]);

  console.log('\n— инвариант: деньги не появляются и не пропадают —');
  const invariant = await page.evaluate(() => {
    const P = window.__pf, S = P.S, bad = [];
    const rnd = (seed => () => (seed = (seed * 9301 + 49297) % 233280) / 233280)(7);
    for(let iter = 0; iter < 600; iter++){
      S.mode = ['places', 'stack', 'cash'][iter % 3];
      S.players = []; S.nextId = 1;
      const n = 1 + Math.floor(rnd() * 8);
      for(let i = 0; i < n; i++)
        S.players.push({ id: S.nextId++, name: '', entries: Math.floor(rnd() * 4),
                         stack: Math.floor(rnd() * rnd() * 40000),
                         place: rnd() < .25 ? 0 : 1 + Math.floor(rnd() * (n + 1)),
                         chips: [], open: false });
      S.buyIn = Math.floor(rnd() * 3000) + (rnd() < .3 ? 0.5 : 0);
      S.chipsPerBuyIn = rnd() < .1 ? 0 : Math.floor(rnd() * 20000) + 1;
      S.places = [Math.floor(rnd() * 80), Math.floor(rnd() * 40), Math.floor(rnd() * 20)];
      S.expenses = []; S.nextExpId = 1;
      const ne = Math.floor(rnd() * 4);
      for(let k = 0; k < ne; k++)
        S.expenses.push({ id: S.nextExpId++, title: 'x', amount: Math.floor(rnd() * 7000) + (rnd() < .3 ? 0.5 : 0),
                          payer: S.players[Math.floor(rnd() * n)].id });

      const c = P.calc();
      const exact = c.rows.reduce((a, r) => a + r.net, 0);
      const ints = c.rows.reduce((a, r) => a + r.netInt, 0);
      const paid = c.rows.reduce((a, r) => a + r.payout, 0);
      const t = P.settle(c.rows);
      const credits = c.rows.reduce((a, r) => a + Math.max(0, r.netInt), 0);
      const debts = c.rows.reduce((a, r) => a + Math.max(0, -r.netInt), 0);
      const moved = t.reduce((a, x) => a + x.amt, 0);

      // в турнирных режимах баланс строго нулевой; в кэше он равен расхождению фишек
      if(Math.abs(exact - c.cashDiff) > 1e-6) bad.push(['exact', iter, S.mode, exact, c.cashDiff]);
      if(ints !== Math.round(exact)) bad.push(['rounded', iter, S.mode, ints, exact]);
      if(S.mode !== 'cash' && Math.abs(paid - c.pool) > 1e-6) bad.push(['payouts', iter, S.mode, paid, c.pool]);
      if(moved !== Math.min(credits, debts)) bad.push(['settle', iter, S.mode, moved, credits, debts]);
      if(c.rows.some(r => !isFinite(r.net) || !isFinite(r.payout))) bad.push(['NaN', iter, S.mode]);
      if(t.length > Math.max(0, n - 1)) bad.push(['too many transfers', iter, t.length, n]);
    }
    return bad.slice(0, 5);
  });
  ok('600 случайных раскладов во всех трёх режимах', invariant.length === 0, invariant);

  console.log('\n— расклад из старой версии подхватывается —');
  await page.evaluate(() => {
    localStorage.setItem('domashnyaya-finalka-v1', JSON.stringify({
      buyIn: 500, mode: 'stack', places: [50, 30, 20], denoms: [25, 100, 500, 1000],
      setCost: 4000, setSplit: true, setPayer: 2, nextId: 3,
      players: [{ id: 1, name: 'Старый', entries: 1, stack: 100, chips: [] },
                { id: 2, name: 'Костя',  entries: 1, stack: 300, chips: [] }]
    }));
  });
  await page.reload();
  await page.waitForTimeout(300);
  c = await calc();
  ok('старый «набор» превратился в расход', await page.locator('.exp').count() === 1);
  ok('сумма и плательщик перенесены', c.expTotal === 4000 && near(c.rows[1].expDelta, 2000), [c.expTotal, c.rows.map(r => r.expDelta)]);
  ok('название расхода «Набор фишек»', (await page.locator('.exp input.txt').first().inputValue()) === 'Набор фишек');
  ok('игроки и стеки из старого расклада на месте', c.rows.map(r => r.name).join() === 'Старый,Костя');
  ok('баланс сходится после миграции', c.rows.reduce((a, r) => a + r.netInt, 0) === 0);

  console.log('\n— текст для чата —');
  const txt = await page.evaluate(() => {
    const btn = document.getElementById('copy');
    let captured = '';
    const orig = navigator.clipboard && navigator.clipboard.writeText;
    return new Promise(res => {
      if(orig){
        navigator.clipboard.writeText = t => { captured = t; return Promise.resolve(); };
        btn.click();
        setTimeout(() => { navigator.clipboard.writeText = orig; res(captured); }, 100);
      } else res('');
    });
  });
  ok('в тексте есть банк, игроки и переводы',
     txt.includes('Банк') && txt.includes('Костя') && txt.includes('Расходы'), txt.slice(0, 220));

  console.log('\n— вёрстка —');
  await page.reload();
  await page.waitForTimeout(250);
  for(const mode of ['places', 'stack', 'cash']){
    await page.locator('#mode-' + mode).click();
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok('нет горизонтальной прокрутки на 390px · ' + mode, overflow <= 1, overflow);
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(120);
  const dark = await page.evaluate(() => {
    const b = getComputedStyle(document.body);
    return { bg: b.backgroundColor, fg: b.color };
  });
  ok('тёмная тема: фон тёмный и непрозрачный', dark.bg !== 'rgba(0, 0, 0, 0)' && dark.bg.match(/\d+/g).slice(0, 3).map(Number).every(v => v < 60), dark);
  ok('тёмная тема: текст светлый', dark.fg.match(/\d+/g).slice(0, 3).map(Number).every(v => v > 150), dark);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(120);
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok('светлая тема: фон светлый', light.match(/\d+/g).slice(0, 3).map(Number).every(v => v > 200), light);
  ok('шрифт заголовка подключён', await page.evaluate(() => getComputedStyle(document.querySelector('h1')).fontFamily.includes('Oswald')));

  console.log('\n— ошибки консоли за весь прогон —');
  ok('консоль чистая', errors.length === 0, errors);

  await browser.close();
  console.log('\n' + (fails ? 'ПРОВАЛЕНО: ' + fails + ' из ' + (fails + passes) : 'ВСЁ ЗЕЛЁНОЕ: ' + passes + ' проверок'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
