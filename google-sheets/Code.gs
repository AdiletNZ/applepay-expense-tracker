/**
 * Apple Pay → Google Таблица.
 *
 * Принимает покупки из автоматизации «Транзакция» в iOS «Быстрых командах»,
 * определяет категорию и записывает строку на лист «Операции».
 * Setup guide: README.md (English) / google-sheets/README.ru.md (по-русски).
 */

// ⬇️ Вставь сюда свой секретный токен (тот же, что в Быстрой команде)
const TOKEN = 'ВСТАВЬ_СВОЙ_ТОКЕН';
const TIMEZONE = 'Asia/Almaty';
const DEFAULT_CURRENCY = 'KZT';
const DEFAULT_CATEGORY = 'Другое';

const SHEETS = {
  tx: 'Операции',
  summary: 'Итоги',
  categories: 'Категории',
  rules: 'Правила',
  history: 'История',
  historyCharts: 'История (Диаграммы)',
};
const TX_HEADERS = ['Дата', 'Магазин', 'Сумма', 'Валюта', 'Категория', 'Карта'];
const COL = { date: 1, merchant: 2, amount: 3, currency: 4, category: 5, card: 6 };
const MONEY_FORMAT = '#,##0.##';
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

// ─────────── Запускаются вручную из редактора (они первые в списке функций) ───────────

/**
 * Запусти из редактора после вставки или обновления кода: создаёт недостающие листы,
 * пересобирает «Итоги» и «Историю», включает ночное обновление истории.
 * Покупки, категории и правила не трогает.
 */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TIMEZONE);

  // Категории
  let cats = ss.getSheetByName(SHEETS.categories);
  if (!cats) {
    cats = ss.insertSheet(SHEETS.categories);
    const rows = Object.keys(DEFAULT_CATEGORIES).map((c) => [c, DEFAULT_CATEGORIES[c].join(', ')]);
    rows.push([DEFAULT_CATEGORY, '']);
    cats.getRange(1, 1, 1, 2).setValues([['Категория', 'Ключевые слова в названии магазина (через запятую)']]);
    cats.getRange(2, 1, rows.length, 2).setValues(rows).setWrap(true);
    cats.setColumnWidth(1, 180).setColumnWidth(2, 600).setFrozenRows(1);
    cats.getRange(1, 1, 1, 2).setFontWeight('bold');
  }

  // Правила
  let rules = ss.getSheetByName(SHEETS.rules);
  if (!rules) {
    rules = ss.insertSheet(SHEETS.rules);
    rules.getRange(1, 1, 1, 2).setValues([['Магазин', 'Категория']]).setFontWeight('bold');
    rules.setColumnWidth(1, 240).setColumnWidth(2, 180).setFrozenRows(1);
  }

  // Операции
  let tx = ss.getSheetByName(SHEETS.tx);
  if (!tx) {
    const first = ss.getSheets()[0];
    tx = first.getLastRow() === 0 && first.getName() !== SHEETS.summary ? first.setName(SHEETS.tx) : ss.insertSheet(SHEETS.tx);
    tx.getRange(1, 1, 1, TX_HEADERS.length).setValues([TX_HEADERS]).setFontWeight('bold');
    tx.setFrozenRows(1);
    tx.setColumnWidth(COL.date, 130).setColumnWidth(COL.merchant, 220).setColumnWidth(COL.category, 170);
  }
  tx.getRange('A2:A').setNumberFormat('dd.MM.yyyy HH:mm');
  tx.getRange('C2:C').setNumberFormat('#,##0.##');
  const catRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(cats.getRange('A2:A'), true)
    .setAllowInvalid(true)
    .build();
  tx.getRange('E2:E').setDataValidation(catRule);

  buildSummary_(ss);
  installDailyTrigger_();
  updateHistory();
  ss.setActiveSheet(ss.getSheetByName(SHEETS.summary));
  SpreadsheetApp.flush();
}

/**
 * Пересобирает листы «История» и «История (Диаграммы)» из листа «Операции».
 * Запускается сам каждую ночь, вручную — меню «💳 Трекер → Обновить историю».
 */
function updateHistory() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tx = sheet_(ss, SHEETS.tx);
  const rows = tx.getLastRow() > 1 ? tx.getRange(2, 1, tx.getLastRow() - 1, COL.category).getValues() : [];
  const entries = rows
    .filter((r) => r[0] && typeof r[0].getTime === 'function')
    .map((r) => [Utilities.formatDate(r[0], TIMEZONE, 'yyyy-MM'), r[COL.category - 1]]);
  const currentKey = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM');
  const months = collectMonths_(entries, currentKey);

  const hist = resetSheet_(ss, SHEETS.history);
  const charts = resetSheet_(ss, SHEETS.historyCharts);
  const plan = planHistory_(months);
  buildHistorySheet_(hist, plan, currentKey);
  buildHistoryChartsSheet_(charts, plan);
  SpreadsheetApp.flush();
}

/** Проверка без iPhone: добавляет тестовую покупку. Потом удали строку. */
function testTransaction() {
  const result = addTransaction_(SpreadsheetApp.getActiveSpreadsheet(), {
    merchant: 'Magnum Cash&Carry',
    amount: '5 400 ₸',
    card: 'Тест',
  });
  Logger.log(result.message);
}


// ───────────────────────── Разбор суммы и категории ─────────────────────────

const CURRENCY_SYMBOLS = [
  ['₸', 'KZT'], ['тг', 'KZT'], ['₽', 'RUB'], ['руб', 'RUB'], ['$', 'USD'], ['€', 'EUR'],
  ['£', 'GBP'], ['₺', 'TRY'], ['¥', 'CNY'], ['₩', 'KRW'], ['₴', 'UAH'], ['₾', 'GEL'],
  ['сом', 'KGS'], ['сўм', 'UZS'],
];
const CURRENCY_SIGNS = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€', GBP: '£' };

function detectCurrency_(text) {
  const iso = text.match(/\b([A-Z]{3})\b/);
  if (iso) return iso[1];
  const lowered = text.toLowerCase();
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (lowered.includes(symbol)) return code;
  }
  return null;
}

function normalizeNumber_(num) {
  if (num.includes(',') && num.includes('.')) {
    const decimalSep = num.lastIndexOf(',') > num.lastIndexOf('.') ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? '.' : ',';
    return num.split(thousandsSep).join('').replace(decimalSep, '.');
  }
  for (const sep of [',', '.']) {
    if (num.includes(sep)) {
      const parts = num.split(sep);
      // "12,5" / "12.99" — дробная часть; "1.250" / "1,000,000" — разделитель тысяч
      if (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) return parts[0] + '.' + parts[1];
      return parts.join('');
    }
  }
  return num;
}

/** "1 250,50 ₸" → { amount: 1250.5, currency: 'KZT' } */
function parseAmount_(value) {
  if (typeof value === 'number') return { amount: Math.round(value * 100) / 100, currency: null };
  const text = String(value);
  const currency = detectCurrency_(text);
  const match = text.replace(/[\s   '’]/g, '').match(/-?\d[\d.,]*/);
  if (!match) throw new Error('Не удалось найти сумму в "' + text + '"');
  const amount = parseFloat(normalizeNumber_(match[0].replace(/[.,]+$/, '')));
  return { amount: Math.round(amount * 100) / 100, currency: currency };
}

function merchantKey_(merchant) {
  return String(merchant).toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

function escapeRegExp_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * categories: [[категория, 'ключ1, ключ2']...] в порядке приоритета
 * learned: { 'magnum': 'Хозтовары' } — правила, выученные после ручной правки
 */
function guessCategory_(merchant, categories, learned) {
  const key = merchantKey_(merchant);
  if (learned && learned[key]) return learned[key];
  for (const [category, keywords] of categories) {
    const words = String(keywords || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    for (const word of words) {
      const re = new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegExp_(word) + '(?![\\p{L}\\p{N}_])', 'u');
      if (re.test(key)) return category;
    }
  }
  return DEFAULT_CATEGORY;
}

function formatMoney_(amount, currency) {
  const [whole, frac] = Math.abs(amount).toFixed(2).split('.');
  let text = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  if (frac !== '00') text += ',' + frac;
  return (amount < 0 ? '-' : '') + text + ' ' + (CURRENCY_SIGNS[currency] || currency);
}

// ───────────────────────────── Веб-приложение ─────────────────────────────

/** Сюда стучится Быстрая команда. */
function doPost(e) {
  try {
    const body = parseBody_(e);
    const token = body.token || (e && e.parameter && e.parameter.token);
    if (TOKEN === 'ВСТАВЬ_СВОЙ_ТОКЕН') throw new Error('Впиши свой токен в начало скрипта (константа TOKEN)');
    if (token !== TOKEN) return json_({ ok: false, error: 'Неверный токен' });
    const result = addTransaction_(SpreadsheetApp.getActiveSpreadsheet(), body);
    return json_(Object.assign({ ok: true }, result));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/** Открой ссылку веб-приложения в браузере — если видишь «работает», всё ок. */
function doGet() {
  return json_({ ok: true, message: 'Трекер трат работает ✅' });
}

function parseBody_(e) {
  if (e && e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (_) {
      // не JSON — значит, форма
    }
  }
  return (e && e.parameter) || {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function addTransaction_(ss, tx) {
  const merchant = String(tx.merchant || '').trim();
  if (!merchant) throw new Error('Не передан магазин (merchant)');
  if (tx.amount === undefined || tx.amount === '') throw new Error('Не передана сумма (amount)');
  const parsed = parseAmount_(tx.amount);
  const currency = String(tx.currency || parsed.currency || DEFAULT_CURRENCY).toUpperCase();
  const category = guessCategory_(merchant, readCategories_(ss), readRules_(ss));
  const date = tx.date ? new Date(tx.date) : new Date();
  const when = isNaN(date.getTime()) ? new Date() : date;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sheet_(ss, SHEETS.tx).appendRow([when, merchant, parsed.amount, currency, category, tx.card || '']);
  } finally {
    lock.releaseLock();
  }
  return {
    category: category,
    amount: parsed.amount,
    currency: currency,
    message: category + ': ' + formatMoney_(parsed.amount, currency) + ' — ' + merchant,
  };
}

function readCategories_(ss) {
  const sheet = ss.getSheetByName(SHEETS.categories);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().filter((r) => r[0]);
}

function readRules_(ss) {
  const sheet = ss.getSheetByName(SHEETS.rules);
  const rules = {};
  if (!sheet || sheet.getLastRow() < 2) return rules;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach((r) => {
    if (r[0] && r[1]) rules[merchantKey_(r[0])] = String(r[1]);
  });
  return rules;
}

function sheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Нет листа «' + name + '». Запусти функцию setup.');
  return sheet;
}

// ────────────────────── Обучение: ручная смена категории ──────────────────────

/**
 * Поменял категорию у покупки на листе «Операции» → магазин запоминается
 * на листе «Правила», а все его покупки получают эту категорию.
 */
function onEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();
  if (sheet.getName() !== SHEETS.tx || range.getColumn() !== COL.category || range.getRow() < 2) return;
  if (range.getNumRows() !== 1 || range.getNumColumns() !== 1) return;
  const category = String(e.value || '').trim();
  if (!category) return;
  const merchant = sheet.getRange(range.getRow(), COL.merchant).getValue();
  if (!merchant) return;
  const key = merchantKey_(merchant);
  const ss = sheet.getParent();

  const rules = sheet_(ss, SHEETS.rules);
  const existing = rules.getLastRow() > 1 ? rules.getRange(2, 1, rules.getLastRow() - 1, 1).getValues() : [];
  const idx = existing.findIndex((r) => merchantKey_(r[0]) === key);
  if (idx >= 0) rules.getRange(idx + 2, 2).setValue(category);
  else rules.appendRow([merchant, category]);

  const n = sheet.getLastRow() - 1;
  const data = sheet.getRange(2, COL.merchant, n, COL.category - COL.merchant + 1).getValues();
  data.forEach((row, i) => {
    const cat = row[COL.category - COL.merchant];
    if (merchantKey_(row[0]) === key && cat !== category) sheet.getRange(i + 2, COL.category).setValue(category);
  });
}

// ─────────────────────────── Меню и расписание ───────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('💳 Трекер')
    .addItem('🔄 Обновить историю', 'updateHistory')
    .addItem('⚙️ Перенастроить таблицу', 'setup')
    .addToUi();
}

function installDailyTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'updateHistory');
  if (!exists) {
    ScriptApp.newTrigger('updateHistory').timeBased().everyDays(1).atHour(3).inTimezone(TIMEZONE).create();
  }
}

// ──────────────────────── Итоги и история: разметка ────────────────────────

const TX_SRC = "'" + SHEETS.tx + "'!A2:F";
const SUMMARY_CURRENCY = "'" + SHEETS.summary + "'!$B$2";
const HISTORY = { tableHeaderRow: 4, minBlockRows: 15, gapRows: 1 };
const CHART_GRID = { firstRow: 4, cellRows: 18, chartRows: 16, leftCol: 1, rightCol: 8, width: 660, height: 336 };
const ROW_PX = 21;

/** "2026-08" → "Август 2026" */
function monthLabel_(key) {
  const [y, m] = key.split('-').map(Number);
  return MONTHS_RU[m - 1] + ' ' + y;
}

/** "2026-12" → "2027-01" */
function nextMonthKey_(key) {
  const [y, m] = key.split('-').map(Number);
  return m === 12 ? y + 1 + '-01' : y + '-' + String(m + 1).padStart(2, '0');
}

/**
 * entries: [["2026-08", "Продукты"], ...] → прошлые месяцы (без текущего), свежие первыми:
 * [{ key: "2026-08", categories: 5 }, ...]
 */
function collectMonths_(entries, currentKey) {
  const byMonth = {};
  entries.forEach(([key, category]) => {
    if (key >= currentKey) return;
    (byMonth[key] = byMonth[key] || {})[String(category)] = true;
  });
  return Object.keys(byMonth)
    .sort()
    .reverse()
    .map((key) => ({ key: key, categories: Object.keys(byMonth[key]).length }));
}

/**
 * Где что лежит на листе «История»: сверху таблица «По месяцам»
 * (строка текущего месяца + прошлые), ниже — блок на каждый прошлый месяц.
 */
function planHistory_(months) {
  const tableFirstRow = HISTORY.tableHeaderRow + 1;
  let row = tableFirstRow + months.length + 1 + 2;
  const blocks = months.map((m, i) => {
    // заголовок + шапка таблицы + категории + запас на новые категории
    const height = Math.max(m.categories + 4, HISTORY.minBlockRows);
    const block = { key: m.key, row: row, height: height, tableRow: tableFirstRow + 1 + i };
    row += height + HISTORY.gapRows;
    return block;
  });
  return { tableFirstRow: tableFirstRow, tableLastRow: tableFirstRow + months.length, blocks: blocks };
}

/** Формула QUERY: траты по категориям между двумя датами в валюте из «Итогов». */
function categoryQueryFormula_(fromExpr, toExpr, currencyExpr) {
  return '=IFERROR(QUERY(' + TX_SRC + ',"select E, sum(C), count(C) where A >= "&' + fromExpr +
    '&" and A < "&' + toExpr + '&" and D = \'"&' + currencyExpr + '&"\' group by E order by sum(C) desc ' +
    'label E \'Категория\', sum(C) \'Сумма\', count(C) \'Покупок\'",0),"Нет покупок")';
}

function dateLiteral_(key) {
  return '"date \'' + key + '-01\'"';
}

/** Лист «Итоги»: только текущий месяц. */
function buildSummary_(ss) {
  const existing = ss.getSheetByName(SHEETS.summary);
  const currency = existing ? String(existing.getRange('B2').getValue() || DEFAULT_CURRENCY) : DEFAULT_CURRENCY;
  const sum = existing ? resetSheet_(ss, SHEETS.summary) : ss.insertSheet(SHEETS.summary, 0);

  sum.getRange('A1:A3').setValues([['Месяц'], ['Валюта'], ['Всего']]).setFontWeight('bold');
  sum.getRange('B1').setFormula('=TODAY()').setNumberFormat('mmmm yyyy').setFontWeight('bold');
  sum.getRange('B2').setValue(currency).setNote('Валюта, по которой считаются итоги и история (KZT, USD, …)');
  sum.getRange('B3').setFormula('=SUM(B6:B)').setNumberFormat(MONEY_FORMAT).setFontWeight('bold').setFontSize(14);
  // Служебные ячейки: границы текущего месяца в формате, который понимает QUERY
  sum.getRange('Z1').setFormula('=DATE(YEAR(B1),MONTH(B1),1)');
  sum.getRange('Z2').setFormula('="date \'"&YEAR(Z1)&"-"&RIGHT("0"&MONTH(Z1),2)&"-01\'"');
  sum.getRange('Z3').setFormula('="date \'"&YEAR(EDATE(Z1,1))&"-"&RIGHT("0"&MONTH(EDATE(Z1,1)),2)&"-01\'"');
  sum.hideColumns(26);

  sum.getRange('A5').setFormula(categoryQueryFormula_('Z2', 'Z3', 'B2'));
  sum.getRange('D5').setValue('Доля');
  sum.getRange('D6').setFormula('=ARRAYFORMULA(IF(ISNUMBER(B6:B40),B6:B40/B3,""))');
  sum.getRange('B6:B').setNumberFormat(MONEY_FORMAT);
  sum.getRange('D6:D').setNumberFormat('0%');
  sum.getRange('A5:D5').setFontWeight('bold');
  sum.setColumnWidth(1, 190);
  sum.insertChart(
    sum.newChart()
      .setChartType(Charts.ChartType.PIE)
      .addRange(sum.getRange('A5:B30'))
      .setNumHeaders(1)
      .setOption('title', 'Куда уходят деньги в этом месяце')
      .setOption('pieHole', 0.45)
      .setOption('legend', { position: 'right' })
      .setOption('width', 520)
      .setOption('height', 340)
      .setPosition(1, 6, 0, 0)
      .build()
  );
  return sum;
}

/** Лист «История»: таблица «По месяцам» + блок с категориями и диаграммой на каждый прошлый месяц. */
function buildHistorySheet_(sheet, plan, currentKey) {
  sheet.getRange('A1').setValue('История трат').setFontWeight('bold').setFontSize(16);
  sheet.getRange('A2')
    .setValue('Прошлые месяцы, свежие сверху. Обновляется сама каждую ночь; вручную — меню «💳 Трекер → Обновить историю».')
    .setFontColor('#6e6e73')
    .setFontStyle('italic');
  sheet.setColumnWidth(1, 220).setColumnWidth(2, 120).setColumnWidth(3, 70).setColumnWidth(4, 70);

  const lastBlock = plan.blocks[plan.blocks.length - 1];
  ensureSize_(sheet, lastBlock ? lastBlock.row + lastBlock.height + 1 : 20, 26);

  // Таблица «По месяцам»: из неё строится диаграмма трендов
  const h = HISTORY.tableHeaderRow;
  sheet.getRange(h - 1, 1).setValue('По месяцам').setFontWeight('bold').setFontSize(13);
  sheet.getRange(h, 1, 1, 2).setValues([['Месяц', 'Всего']]).setFontWeight('bold');
  const labels = [[monthLabel_(currentKey) + ' (текущий)']].concat(plan.blocks.map((b) => [monthLabel_(b.key)]));
  sheet.getRange(plan.tableFirstRow, 1, labels.length, 1).setNumberFormat('@').setValues(labels);
  const totals = [["='" + SHEETS.summary + "'!B3"]].concat(plan.blocks.map((b) => ['=B' + b.row]));
  sheet.getRange(plan.tableFirstRow, 2, totals.length, 1).setFormulas(totals).setNumberFormat(MONEY_FORMAT);

  plan.blocks.forEach((b) => {
    const first = b.row + 2;
    const last = b.row + b.height - 1;
    const label = monthLabel_(b.key);
    sheet.getRange(b.row, 1, 1, 4).setBackground('#f1f3f4');
    sheet.getRange(b.row, 1).setNumberFormat('@').setValue(label).setFontWeight('bold').setFontSize(13);
    sheet.getRange(b.row, 2).setFormula('=SUM(B' + first + ':B' + last + ')')
      .setNumberFormat(MONEY_FORMAT).setFontWeight('bold').setFontSize(13);
    sheet.getRange(b.row, 3).setFormula('=' + SUMMARY_CURRENCY).setFontWeight('bold');
    sheet.getRange(b.row + 1, 1).setFormula(
      categoryQueryFormula_(dateLiteral_(b.key), dateLiteral_(nextMonthKey_(b.key)), SUMMARY_CURRENCY)
    );
    sheet.getRange(b.row + 1, 4).setValue('Доля');
    sheet.getRange(b.row + 1, 1, 1, 4).setFontWeight('bold');
    sheet.getRange(first, 4).setFormula(
      '=ARRAYFORMULA(IF(ISNUMBER(B' + first + ':B' + last + '),B' + first + ':B' + last + '/B' + b.row + ',""))'
    );
    sheet.getRange(first, 2, b.height - 2, 1).setNumberFormat(MONEY_FORMAT);
    sheet.getRange(first, 4, b.height - 2, 1).setNumberFormat('0%');
    sheet.insertChart(
      sheet.newChart()
        .setChartType(Charts.ChartType.PIE)
        .addRange(sheet.getRange(b.row + 1, 1, b.height - 1, 2))
        .setNumHeaders(1)
        .setOption('title', label)
        .setOption('pieHole', 0.45)
        .setOption('legend', { position: 'right' })
        .setOption('width', 440)
        .setOption('height', b.height * ROW_PX - 6)
        .setPosition(b.row, 6, 0, 0)
        .build()
    );
  });
}

/**
 * Лист «История (Диаграммы)»: только диаграммы, по две в ряд.
 * Первая — «Траты по месяцам», рядом — последний прошедший месяц, дальше — более старые.
 * Данные для каждой диаграммы копируются формулой в скрытые столбцы справа.
 */
function buildHistoryChartsSheet_(sheet, plan) {
  const hist = "'" + SHEETS.history + "'!";
  sheet.getRange('A1').setValue('История (Диаграммы)').setFontWeight('bold').setFontSize(16);
  sheet.getRange('A2')
    .setValue(plan.blocks.length
      ? 'Листай вниз: свежие месяцы сверху. Цифры по категориям — на листе «История».'
      : 'Прошлых месяцев пока нет — история появится 1-го числа следующего месяца.')
    .setFontColor('#6e6e73')
    .setFontStyle('italic');

  const items = [{ trend: true }].concat(plan.blocks);
  ensureSize_(sheet, CHART_GRID.firstRow + Math.ceil(items.length / 2) * CHART_GRID.cellRows, 30);
  items.forEach((item, i) => {
    const row = CHART_GRID.firstRow + Math.floor(i / 2) * CHART_GRID.cellRows;
    const col = i % 2 === 0 ? CHART_GRID.leftCol : CHART_GRID.rightCol;
    const dataCol = i % 2 === 0 ? 26 : 29; // Z:AA для левых, AC:AD для правых
    const dataCell = sheet.getRange(row + 1, dataCol);
    const builder = sheet.newChart().setPosition(row + 1, col, 0, 0)
      .setOption('width', CHART_GRID.width)
      .setOption('height', CHART_GRID.height);

    if (item.trend) {
      sheet.getRange(row, col).setValue('📈 Траты по месяцам').setFontWeight('bold').setFontSize(13);
      // последние 12 месяцев; в таблице свежие сверху, поэтому ось развёрнута
      dataCell.setFormula('=ARRAY_CONSTRAIN(' + hist + 'A' + HISTORY.tableHeaderRow + ':B' + plan.tableLastRow + ',13,2)');
      builder.setChartType(Charts.ChartType.COLUMN)
        .addRange(sheet.getRange(row + 1, dataCol, 13, 2))
        .setNumHeaders(1)
        .setOption('title', 'Траты по месяцам')
        .setOption('legend', { position: 'none' })
        .setOption('hAxis', { direction: -1 });
    } else {
      sheet.getRange(row, col).setFormula(
        '="' + monthLabel_(item.key) + ' — "&TEXT(' + hist + 'B' + item.row + ',"#,##0")&" "&' + SUMMARY_CURRENCY
      ).setFontWeight('bold').setFontSize(13);
      const rows = Math.min(item.height - 1, CHART_GRID.chartRows);
      dataCell.setFormula(
        '=ARRAY_CONSTRAIN(' + hist + 'A' + (item.row + 1) + ':B' + (item.row + item.height - 1) + ',' + rows + ',2)'
      );
      builder.setChartType(Charts.ChartType.PIE)
        .addRange(sheet.getRange(row + 1, dataCol, rows, 2))
        .setNumHeaders(1)
        .setOption('title', monthLabel_(item.key))
        .setOption('pieHole', 0.45)
        .setOption('legend', { position: 'right' });
    }
    sheet.insertChart(builder.build());
  });
  sheet.hideColumns(26, 5);
}

/** Добавляет строки/столбцы, если лист меньше нужного (новый лист — 1000×26). */
function ensureSize_(sheet, rows, cols) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < cols) sheet.insertColumnsAfter(sheet.getMaxColumns(), cols - sheet.getMaxColumns());
}

/** Очищает лист (данные, форматы, заметки, диаграммы) или создаёт его в конце. */
function resetSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) return ss.insertSheet(name, ss.getNumSheets());
  sheet.getCharts().forEach((c) => sheet.removeChart(c));
  const all = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
  all.clearDataValidations();
  sheet.clear();
  sheet.clearNotes();
  sheet.showColumns(1, sheet.getMaxColumns());
  return sheet;
}

const DEFAULT_CATEGORIES = {
  "Доставка еды": [
    "wolt",
    "glovo",
    "yandex eats",
    "yandex eda",
    "яндекс еда",
    "chocofood",
    "delivery club"
  ],
  "Кафе и рестораны": [
    "starbucks",
    "coffee",
    "кофе",
    "coffee boom",
    "costa",
    "kfc",
    "burger",
    "hardee's",
    "hardees",
    "mcdonald's",
    "mcdonalds",
    "dodo",
    "додо",
    "pizza",
    "пицца",
    "del papa",
    "salam bro",
    "tanuki",
    "cafe",
    "café",
    "кафе",
    "restaurant",
    "ресторан",
    "bar",
    "бар",
    "doner",
    "донер",
    "шаурма",
    "sushi",
    "суши"
  ],
  "Продукты": [
    "magnum",
    "small",
    "galmart",
    "anvar",
    "arbuz",
    "metro",
    "ramstore",
    "toimart",
    "интерфуд",
    "market",
    "маркет",
    "supermarket",
    "супермаркет",
    "grocery",
    "продукты",
    "азбука вкуса",
    "пятёрочка",
    "пятерочка",
    "перекрёсток",
    "перекресток",
    "магнит",
    "вкусвилл",
    "lidl",
    "aldi",
    "carrefour",
    "spar"
  ],
  "Такси и транспорт": [
    "yandex go",
    "yandex taxi",
    "яндекс go",
    "яндекс такси",
    "indrive",
    "indriver",
    "uber",
    "bolt",
    "taxi",
    "такси",
    "onay",
    "авиа",
    "air astana",
    "fly arystan",
    "scat",
    "airport",
    "аэропорт"
  ],
  "Авто и топливо": [
    "helios",
    "sinooil",
    "kazmunaygas",
    "kmg",
    "qazaq oil",
    "gazprom",
    "газпром",
    "lukoil",
    "лукойл",
    "shell",
    "азс",
    "fuel",
    "parking",
    "парковка",
    "автомойка",
    "car wash"
  ],
  "Здоровье и аптеки": [
    "europharma",
    "biosfera",
    "аптека",
    "apteka",
    "pharmacy",
    "sadykhan",
    "invivo",
    "олимп",
    "clinic",
    "клиника",
    "dent",
    "стоматология"
  ],
  "Одежда и покупки": [
    "zara",
    "h&m",
    "bershka",
    "pull&bear",
    "lc waikiki",
    "defacto",
    "koton",
    "uniqlo",
    "adidas",
    "nike",
    "mango",
    "massimo dutti",
    "sulpak",
    "technodom",
    "mechta",
    "мечта",
    "wildberries",
    "ozon",
    "lamoda",
    "ikea",
    "leroy",
    "mega",
    "dostyk plaza"
  ],
  "Подписки и сервисы": [
    "apple.com",
    "itunes",
    "netflix",
    "spotify",
    "youtube",
    "google",
    "yandex plus",
    "яндекс плюс",
    "chatgpt",
    "openai",
    "anthropic",
    "claude",
    "icloud",
    "kinopoisk",
    "кинопоиск",
    "ivi"
  ],
  "Связь и интернет": [
    "beeline",
    "kcell",
    "activ",
    "tele2",
    "altel",
    "kazakhtelecom",
    "мтс",
    "megafon",
    "мегафон"
  ],
  "Развлечения": [
    "kinopark",
    "chaplin",
    "cinema",
    "кино",
    "kinoteatr",
    "steam",
    "playstation",
    "xbox",
    "боулинг",
    "bowling",
    "концерт",
    "ticketon",
    "kassir"
  ],
  "Спорт": [
    "fitness",
    "фитнес",
    "gym",
    "invictus",
    "world class",
    "спортзал",
    "decathlon"
  ],
  "Красота": [
    "барбершоп",
    "barbershop",
    "barber",
    "салон",
    "salon",
    "beauty",
    "letu",
    "лэтуаль",
    "gold apple",
    "золотое яблоко"
  ]
};

if (typeof module !== 'undefined') {
  module.exports = {
    parseAmount: parseAmount_,
    guessCategory: guessCategory_,
    formatMoney: formatMoney_,
    merchantKey: merchantKey_,
    collectMonths: collectMonths_,
    planHistory: planHistory_,
    monthLabel: monthLabel_,
    nextMonthKey: nextMonthKey_,
    categoryQueryFormula: categoryQueryFormula_,
    DEFAULT_CATEGORIES,
  };
}
