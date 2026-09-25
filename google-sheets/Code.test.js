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
