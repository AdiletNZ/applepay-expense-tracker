// Тесты логики скрипта: node --test google-sheets/Code.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), context);
const { parseAmount, guessCategory, formatMoney, DEFAULT_CATEGORIES } = context.module.exports;
const categories = Object.entries(DEFAULT_CATEGORIES).map(([c, words]) => [c, words.join(', ')]);

test('parseAmount', () => {
  const cases = [
    ['1 250,50 ₸', 1250.5, 'KZT'],
    ['₸1,250.50', 1250.5, 'KZT'],
    ['5 000 ₸', 5000, 'KZT'],
    ['$12.99', 12.99, 'USD'],
    ['12,99 €', 12.99, 'EUR'],
    ['KZT 5000', 5000, 'KZT'],
    ['1.250 ₽', 1250, 'RUB'],
    ['1,000,000.5', 1000000.5, null],
    ['-3 400 ₸', -3400, 'KZT'],
    [1500, 1500, null],
  ];
  for (const [raw, amount, currency] of cases) {
    assert.deepStrictEqual({ ...parseAmount(raw) }, { amount, currency }, String(raw));
  }
  assert.throws(() => parseAmount('₸'));
});

test('guessCategory', () => {
  const cases = [
    ['MAGNUM CASH&CARRY', 'Продукты'],
    ['Small #123', 'Продукты'],
    ['Yandex Go', 'Такси и транспорт'],
    ['YANDEX EDA', 'Доставка еды'],
    ['Starbucks Dostyk', 'Кафе и рестораны'],
    ['APPLE.COM/BILL', 'Подписки и сервисы'],
    ['Gold Apple', 'Красота'],
    ['Аптека Europharma', 'Здоровье и аптеки'],
    ['Smallville Tools', 'Другое'],
    ['ИП Иванов', 'Другое'],
  ];
  for (const [merchant, category] of cases) assert.strictEqual(guessCategory(merchant, categories, {}), category, merchant);
  assert.strictEqual(guessCategory('  Magnum ', categories, { magnum: 'Хозтовары' }), 'Хозтовары');
});

test('formatMoney', () => {
  assert.strictEqual(formatMoney(5400, 'KZT'), '5 400 ₸');
  assert.strictEqual(formatMoney(1250.5, 'USD'), '1 250,50 $');
});

// ── Мини-макет Google Таблицы для doPost / onEdit ──
function fakeSheet(name, rows) {
  const sheet = {
    rows,
    getName: () => name,
    getLastRow: () => rows.length,
    appendRow: (r) => rows.push([...r]),
    getRange: (row, col, nRows = 1, nCols = 1) => ({
      getValues: () => rows.slice(row - 1, row - 1 + nRows).map((r) => r.slice(col - 1, col - 1 + nCols)),
      getValue: () => rows[row - 1][col - 1],
      setValue: (v) => { rows[row - 1][col - 1] = v; },
      getRow: () => row,
      getColumn: () => col,
      getNumRows: () => nRows,
      getNumColumns: () => nCols,
      getSheet: () => sheet,
    }),
  };
  return sheet;
}

function loadWithSheets() {
  const sheets = {
    'Операции': fakeSheet('Операции', [['Дата', 'Магазин', 'Сумма', 'Валюта', 'Категория', 'Карта']]),
    'Категории': fakeSheet('Категории', [['Категория', 'Ключевые слова'], ...categories]),
    'Правила': fakeSheet('Правила', [['Магазин', 'Категория']]),
  };
  const ss = { getSheetByName: (n) => sheets[n] || null };
  Object.values(sheets).forEach((s) => { s.getParent = () => ss; });
  const ctx = {
    module: { exports: {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
  };
  const src = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8').replace("'ВСТАВЬ_СВОЙ_ТОКЕН';", "'secret';");
  vm.runInNewContext(src, ctx);
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) }, parameter: {} }).text);
  return { ctx, sheets, post };
}

test('doPost пишет строку и возвращает сообщение', () => {
  const { sheets, post } = loadWithSheets();
  assert.deepStrictEqual(post({ token: 'wrong', merchant: 'x', amount: '1' }), { ok: false, error: 'Неверный токен' });
  const res = post({ token: 'secret', merchant: 'Magnum', amount: '5 400 ₸', card: 'Kaspi Gold' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.message, 'Продукты: 5 400 ₸ — Magnum');
  const row = sheets['Операции'].rows[1];
  assert.deepStrictEqual(row.slice(1), ['Magnum', 5400, 'KZT', 'Продукты', 'Kaspi Gold']);
  assert.ok(!isNaN(row[0].getTime())); // Date из другого vm-контекста, поэтому без instanceof
  assert.strictEqual(post({ token: 'secret', merchant: 'Magnum', amount: 'abc' }).ok, false);
});

test('ручная смена категории запоминается', () => {
  const { ctx, sheets, post } = loadWithSheets();
  post({ token: 'secret', merchant: 'ИП Ахметов', amount: '2000' });
  post({ token: 'secret', merchant: 'ип  ахметов', amount: '1000' });
  const tx = sheets['Операции'];
  ctx.onEdit({ range: tx.getRange(2, 5), value: 'Хозтовары' });
  assert.deepStrictEqual(sheets['Правила'].rows[1], ['ИП Ахметов', 'Хозтовары']);
  assert.strictEqual(tx.rows[2][4], 'Хозтовары'); // прошлая покупка тоже обновилась
  assert.strictEqual(post({ token: 'secret', merchant: 'ИП АХМЕТОВ', amount: '1' }).category, 'Хозтовары');
  ctx.onEdit({ range: tx.getRange(2, 5), value: 'Подарки' });
  assert.strictEqual(sheets['Правила'].rows.length, 2); // правило обновилось, а не задублировалось
  assert.strictEqual(sheets['Правила'].rows[1][1], 'Подарки');
});

// ── История: чистая логика ──
test('monthLabel / nextMonthKey', () => {
  const { monthLabel, nextMonthKey } = context.module.exports;
  assert.strictEqual(monthLabel('2026-08'), 'Август 2026');
  assert.strictEqual(nextMonthKey('2026-08'), '2026-09');
  assert.strictEqual(nextMonthKey('2026-12'), '2027-01');
});

test('collectMonths: только прошлые месяцы, свежие первыми', () => {
  const { collectMonths } = context.module.exports;
  const months = collectMonths(
    [['2026-08', 'Продукты'], ['2026-10', 'Кафе'], ['2026-09', 'Кафе'], ['2026-08', 'Такси'], ['2026-08', 'Продукты']],
    '2026-10'
  );
  assert.deepStrictEqual(JSON.parse(JSON.stringify(months)), [
    { key: '2026-09', categories: 1 },
    { key: '2026-08', categories: 2 },
  ]);
});

test('planHistory: блоки не пересекаются и помещают все категории', () => {
  const { planHistory } = context.module.exports;
  const plan = planHistory([{ key: '2026-09', categories: 3 }, { key: '2026-08', categories: 20 }]);
  assert.strictEqual(plan.tableFirstRow, 5);
  assert.strictEqual(plan.tableLastRow, 7);
  const [sep, aug] = plan.blocks;
  assert.ok(sep.row > plan.tableLastRow);
  assert.ok(aug.row >= sep.row + sep.height);
  assert.ok(aug.height >= 20 + 3);
  assert.strictEqual(sep.tableRow, 6);
});

// ── Макет Google Таблицы с проверкой границ, чтобы прогнать setup/updateHistory целиком ──
function chain(extra = {}) {
  const p = new Proxy(extra, { get: (t, k) => (k in t ? t[k] : () => p) });
  return p;
}

function colIndex(letters) {
  return letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

function makeSpreadsheet(txRows) {
  const sheets = [];
  const log = { formulas: [], triggers: 0 };
  const ss = {
    getSheetByName: (n) => sheets.find((s) => s.getName() === n) || null,
    getSheets: () => sheets,
    getNumSheets: () => sheets.length,
    insertSheet: (name, idx) => {
      const s = makeSheet(name);
      sheets.splice(idx === undefined ? sheets.length : idx, 0, s);
      return s;
    },
    setSpreadsheetTimeZone: () => {},
    setActiveSheet: (s) => s,
  };
  function makeSheet(name, rows = []) {
    let maxRows = 1000;
    let maxCols = 26;
    const charts = [];
    const sheet = {
      rows,
      charts,
      getName: () => name,
      setName: (n) => { name = n; return sheet; },
      getParent: () => ss,
      getLastRow: () => rows.length,
      getMaxRows: () => maxRows,
      getMaxColumns: () => maxCols,
      insertRowsAfter: (_, n) => { maxRows += n; },
      insertColumnsAfter: (_, n) => { maxCols += n; },
      hideColumns: (c, n = 1) => { assert.ok(c + n - 1 <= maxCols, `${name}: hideColumns вне листа`); },
      showColumns: () => {},
      getCharts: () => charts.slice(),
      removeChart: (c) => charts.splice(charts.indexOf(c), 1),
      insertChart: (c) => charts.push(c),
      newChart: () => chain({ build: () => ({}) }),
      appendRow: (r) => rows.push(r),
      getRange: (a, b, nr = 1, nc = 1) => {
        let row = a;
        let col = b;
        if (typeof a === 'string') {
          const m = a.match(/^([A-Z]+)(\d*)/);
          col = colIndex(m[1]);
          row = Number(m[2] || 1);
        }
        assert.ok(row + nr - 1 <= maxRows && col + nc - 1 <= maxCols, `${name}: диапазон ${a},${b} вне листа ${maxRows}×${maxCols}`);
        const range = chain({
          getValues: () => rows.slice(row - 1, row - 1 + nr).map((r) => r.slice(col - 1, col - 1 + nc)),
          getValue: () => (rows[row - 1] || [])[col - 1],
          setFormula: (f) => { log.formulas.push([name, f]); return range; },
          setFormulas: (fs) => { fs.flat().forEach((f) => log.formulas.push([name, f])); return range; },
        });
        return range;
      },
    };
    [
      'clear', 'clearNotes', 'setColumnWidth', 'setFrozenRows',
    ].forEach((m) => { sheet[m] = () => sheet; });
    return sheet;
  }
  const first = makeSheet('Лист1');
  sheets.push(first);
  if (txRows) {
    first.setName('Операции');
    first.rows.push(['Дата', 'Магазин', 'Сумма', 'Валюта', 'Категория', 'Карта'], ...txRows);
  }
  return { ss, log };
}

function loadWithSpreadsheet(ss, log, now) {
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(now); }
  }
  const ctx = {
    module: { exports: {} },
    Date: FakeDate,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss,
      newDataValidation: () => chain(),
      flush: () => {},
    },
    Charts: { ChartType: { PIE: 'PIE', COLUMN: 'COLUMN' } },
    Utilities: {
      formatDate: (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' })
        .format(d).slice(0, 7),
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => chain({ create: () => { log.triggers += 1; } }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), ctx);
  return ctx;
}

test('setup на пустой таблице создаёт все листы', () => {
  const { ss, log } = makeSpreadsheet();
  const ctx = loadWithSpreadsheet(ss, log, '2026-10-15T10:00:00+05:00');
  ctx.setup();
  assert.deepStrictEqual(ss.getSheets().map((s) => s.getName()),
    ['Итоги', 'Операции', 'Категории', 'Правила', 'История', 'История (Диаграммы)']);
  assert.strictEqual(log.triggers, 1);
  // без прошлых месяцев: только диаграмма трендов
  assert.strictEqual(ss.getSheetByName('История (Диаграммы)').charts.length, 1);
  assert.strictEqual(ss.getSheetByName('Итоги').charts.length, 1);
});

test('updateHistory строит блоки и диаграммы для прошлых месяцев', () => {
  const d = (s) => new Date(s);
  const { ss, log } = makeSpreadsheet([
    [d('2026-08-03T12:00:00+05:00'), 'Magnum', 5400, 'KZT', 'Продукты', ''],
    [d('2026-08-31T23:30:00+05:00'), 'Wolt', 3000, 'KZT', 'Доставка еды', ''], // ещё август по Алматы
    [d('2026-09-10T12:00:00+05:00'), 'Zara', 25000, 'KZT', 'Одежда и покупки', ''],
    [d('2026-10-01T09:00:00+05:00'), 'Starbucks', 2300, 'KZT', 'Кафе и рестораны', ''], // текущий
  ]);
  const ctx = loadWithSpreadsheet(ss, log, '2026-10-15T10:00:00+05:00');
  ctx.setup();
  const hist = ss.getSheetByName('История');
  const charts = ss.getSheetByName('История (Диаграммы)');
  assert.strictEqual(hist.charts.length, 2); // сентябрь + август
  assert.strictEqual(charts.charts.length, 3); // тренд + 2 месяца
  const histFormulas = log.formulas.filter(([n]) => n === 'История').map(([, f]) => f).join('\n');
  assert.match(histFormulas, /A >= "&"date '2026-09-01'"&" and A < "&"date '2026-10-01'"/);
  assert.match(histFormulas, /A >= "&"date '2026-08-01'"&" and A < "&"date '2026-09-01'"/);
  assert.doesNotMatch(histFormulas, /date '2026-10-01'"&" and A < /); // текущий месяц не в истории

  // повторный запуск не плодит диаграммы
  ctx.updateHistory();
  assert.strictEqual(hist.charts.length, 2);
  assert.strictEqual(charts.charts.length, 3);
});
