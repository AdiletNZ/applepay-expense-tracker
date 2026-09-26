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
  installTriggers_(ss);
  updateHistory();
  ss.setActiveSheet(ss.getSheetByName(SHEETS.summary));
  SpreadsheetApp.flush();
}

/**
 * Полностью пересобирает «История» и «История (Диаграммы)».
 * Обычно не нужна: история обновляется сама после каждой покупки и правки.
 * Запускается каждую ночь как страховка и из меню «💳 Трекер → Обновить историю».
 */
function updateHistory() {
  refreshHistory_(SpreadsheetApp.getActiveSpreadsheet(), true);
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

/** Триггер «при изменении» (ставит setup): запоминает категорию и обновляет историю. */
function onTableEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEETS.tx) return;
  learnCategory_(e);
  safeRefresh_(sheet.getParent());
}

/** Триггер «при изменении структуры» (ставит setup): удалили/вставили строки и т.п. */
function onTableChange(e) {
  if (e && e.changeType === 'EDIT') return; // правки ячеек обрабатывает onTableEdit
  safeRefresh_(SpreadsheetApp.getActiveSpreadsheet());
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
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const result = addTransaction_(ss, body);
    safeRefresh_(ss);
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
function learnCategory_(e) {
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

function installTriggers_(ss) {
  const handlers = ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction());
  if (!handlers.includes('updateHistory')) {
    ScriptApp.newTrigger('updateHistory').timeBased().everyDays(1).atHour(3).inTimezone(TIMEZONE).create();
  }
  if (!handlers.includes('onTableEdit')) ScriptApp.newTrigger('onTableEdit').forSpreadsheet(ss).onEdit().create();
  if (!handlers.includes('onTableChange')) ScriptApp.newTrigger('onTableChange').forSpreadsheet(ss).onChange().create();
}

/** Обновляет историю, но никогда не ломает основное действие (покупку, правку). */
function safeRefresh_(ss) {
  try {
    refreshHistory_(ss, false);
  } catch (err) {
    console.error('Не удалось обновить историю: ' + ((err && err.stack) || err));
  }
}

/**
 * Лента «История» пересобирается всегда (это быстро). Кругляши в «Истории (Диаграммы)»
 * считаются формулами, поэтому их лист пересобирается, только когда появился новый месяц
 * или категория (или force).
 */
function refreshHistory_(ss, force) {
  const tx = sheet_(ss, SHEETS.tx);
  const rows = tx.getLastRow() > 1 ? tx.getRange(2, 1, tx.getLastRow() - 1, TX_HEADERS.length).getValues() : [];
  const keyOf = (d) => Utilities.formatDate(d, TIMEZONE, 'yyyy-MM');
  const currentKey = keyOf(new Date());
  const dated = rows.filter((r) => r[0] && typeof r[0].getTime === 'function');

  buildHistorySheet_(resetSheet_(ss, SHEETS.history), buildFeed_(dated, keyOf));

  const months = collectMonths_(dated.map((r) => [keyOf(r[0]), r[COL.category - 1]]));
  const layout = JSON.stringify([currentKey, months]);
  const props = PropertiesService.getDocumentProperties();
  if (force || !ss.getSheetByName(SHEETS.historyCharts) || props.getProperty('chartsLayout') !== layout) {
    buildHistoryChartsSheet_(resetSheet_(ss, SHEETS.historyCharts), planCharts_(months), currentKey);
    props.setProperty('chartsLayout', layout);
  }
  SpreadsheetApp.flush();
}

// ──────────────────────── Итоги и история: разметка ────────────────────────

const TX_SRC = "'" + SHEETS.tx + "'!A2:F";
const SUMMARY_CURRENCY = "'" + SHEETS.summary + "'!$B$2";
const FEED = { headerRow: 4, columns: ['Дата', 'Время', 'Магазин', 'Категория', 'Сумма', 'Валюта', 'Карта'] };
const CHARTS = { firstRow: 4, minBlockRows: 17, gapRows: 2, tableCol: 7, chartWidth: 520, maxChartRows: 17 };
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
 * entries: [["2026-08", "Продукты"], ...] → все месяцы, свежие первыми:
 * [{ key: "2026-08", categories: 5 }, ...]
 */
function collectMonths_(entries) {
  const byMonth = {};
  entries.forEach(([key, category]) => {
    (byMonth[key] = byMonth[key] || {})[String(category)] = true;
  });
  return Object.keys(byMonth)
    .sort()
    .reverse()
    .map((key) => ({ key: key, categories: Object.keys(byMonth[key]).length }));
}

/** Раскладка листа «История (Диаграммы)»: блок на каждый месяц, кругляш слева, итог и категории справа. */
function planCharts_(months) {
  let row = CHARTS.firstRow;
  const blocks = months.map((m) => {
    // заголовок, «всего», пустая строка, шапка таблицы, категории + запас на новые
    const height = Math.max(m.categories + 6, CHARTS.minBlockRows);
    const block = { key: m.key, row: row, height: height };
    row += height + CHARTS.gapRows;
    return block;
  });
  return { blocks: blocks, lastRow: row };
}

/**
 * Лента всех покупок, как история в банковском приложении:
 * свежие сверху, по месяцам, у каждого месяца строка-заголовок.
 * Возвращает строки для листа и где стоят заголовки месяцев (индексы от 0).
 */
function buildFeed_(rows, keyOf) {
  const past = rows.slice().sort((a, b) => b[0].getTime() - a[0].getTime());
  const values = [];
  const headers = [];
  let lastKey = null;
  past.forEach((r) => {
    const key = keyOf(r[0]);
    if (key !== lastKey) {
      if (lastKey !== null) values.push(['', '', '', '', '', '', '']);
      headers.push({ index: values.length, key: key, first: values.length + 1, last: values.length });
      values.push(['📅 ' + monthLabel_(key), '', '', '', '', '', '']);
      lastKey = key;
    }
    // [Дата, Магазин, Сумма, Валюта, Категория, Карта] → [Дата, Время, Магазин, Категория, Сумма, Валюта, Карта]
    values.push([r[0], r[0], r[1], r[4], r[2], r[3], r[5]]);
    headers[headers.length - 1].last = values.length - 1;
  });
  return { values: values, headers: headers };
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

/** Лист «История»: все покупки лентой, свежие сверху. */
function buildHistorySheet_(sheet, feed) {
  const top = FEED.headerRow + 1;
  ensureSize_(sheet, top + feed.values.length + 1, FEED.columns.length);
  sheet.getRange('A1').setValue('История покупок').setFontWeight('bold').setFontSize(16);
  sheet.getRange('A2')
    .setValue('Все покупки, свежие сверху. Обновляется сама после каждой покупки. Категорию меняй на листе «Операции».')
    .setFontColor('#6e6e73')
    .setFontStyle('italic');
  sheet.getRange(FEED.headerRow, 1, 1, FEED.columns.length).setValues([FEED.columns])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(FEED.headerRow);
  sheet.setColumnWidth(1, 150).setColumnWidth(2, 60).setColumnWidth(3, 220).setColumnWidth(4, 170)
    .setColumnWidth(5, 100).setColumnWidth(6, 60).setColumnWidth(7, 120);
  if (!feed.values.length) return;

  sheet.getRange(top, 1, feed.values.length, FEED.columns.length).setValues(feed.values);
  sheet.getRange(top, 1, feed.values.length, 1).setNumberFormat('dd.MM.yyyy');
  sheet.getRange(top, 2, feed.values.length, 1).setNumberFormat('HH:mm');
  sheet.getRange(top, 5, feed.values.length, 1).setNumberFormat(MONEY_FORMAT);
  feed.headers.forEach((h) => {
    const row = top + h.index;
    const first = top + h.first;
    const last = top + h.last;
    sheet.getRange(row, 1, 1, FEED.columns.length).setBackground('#e8f0fe').setFontWeight('bold');
    sheet.getRange(row, 1).setFontSize(12);
    sheet.getRange(row, 5).setFormula('=SUMIF(F' + first + ':F' + last + ',' + SUMMARY_CURRENCY + ',E' + first + ':E' + last + ')');
    sheet.getRange(row, 6).setFormula('=' + SUMMARY_CURRENCY);
  });
}

/**
 * Лист «История (Диаграммы)»: для каждого месяца такой же кругляш, как в «Итогах»,
 * а справа — сколько всего ушло и разбивка по категориям. Свежие месяцы сверху.
 */
function buildHistoryChartsSheet_(sheet, plan, currentKey) {
  const t = CHARTS.tableCol;
  const H = colLetter_(t + 1);
  ensureSize_(sheet, plan.lastRow + 1, t + 3);
  sheet.getRange('A1').setValue('История (Диаграммы)').setFontWeight('bold').setFontSize(16);
  sheet.getRange('A2')
    .setValue(plan.blocks.length
      ? 'Куда уходили деньги по месяцам. Свежие сверху, листай вниз. Обновляется сама.'
      : 'Покупок пока нет — кругляш появится после первой покупки.')
    .setFontColor('#6e6e73')
    .setFontStyle('italic');
  sheet.setColumnWidth(t, 200).setColumnWidth(t + 1, 120).setColumnWidth(t + 2, 60).setColumnWidth(t + 3, 60);

  plan.blocks.forEach((b) => {
    const label = monthLabel_(b.key) + (b.key === currentKey ? ' (текущий)' : '');
    const tableRow = b.row + 3;
    const first = tableRow + 1;
    const last = b.row + b.height - 1;
    sheet.getRange(b.row, t).setNumberFormat('@').setValue('📅 ' + label).setFontWeight('bold').setFontSize(14);
    sheet.getRange(b.row + 1, t).setValue('Всего ушло').setFontColor('#6e6e73');
    sheet.getRange(b.row + 1, t + 1).setFormula('=SUM(' + H + first + ':' + H + last + ')')
      .setNumberFormat(MONEY_FORMAT).setFontWeight('bold').setFontSize(16);
    sheet.getRange(b.row + 1, t + 2).setFormula('=' + SUMMARY_CURRENCY).setFontWeight('bold');
    sheet.getRange(tableRow, t).setFormula(
      categoryQueryFormula_(dateLiteral_(b.key), dateLiteral_(nextMonthKey_(b.key)), SUMMARY_CURRENCY)
    );
    sheet.getRange(tableRow, t + 3).setValue('Доля');
    sheet.getRange(tableRow, t, 1, 4).setFontWeight('bold');
    sheet.getRange(first, t + 3).setFormula(
      '=ARRAYFORMULA(IF(ISNUMBER(' + H + first + ':' + H + last + '),' + H + first + ':' + H + last + '/' + H + (b.row + 1) + ',""))'
    );
    sheet.getRange(first, t + 1, last - first + 1, 1).setNumberFormat(MONEY_FORMAT);
    sheet.getRange(first, t + 3, last - first + 1, 1).setNumberFormat('0%');
    sheet.insertChart(
      sheet.newChart()
        .setChartType(Charts.ChartType.PIE)
        .addRange(sheet.getRange(tableRow, t, last - tableRow + 1, 2))
        .setNumHeaders(1)
        .setOption('title', 'Куда ушли деньги: ' + label)
        .setOption('pieHole', 0.45)
        .setOption('legend', { position: 'right' })
        .setOption('width', CHARTS.chartWidth)
        .setOption('height', Math.min(b.height, CHARTS.maxChartRows) * ROW_PX - 6)
        .setPosition(b.row, 1, 0, 0)
        .build()
    );
  });
}

/** 8 → "H" */
function colLetter_(col) {
  let s = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
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
    planCharts: planCharts_,
    buildFeed: buildFeed_,
    colLetter: colLetter_,
    monthLabel: monthLabel_,
    nextMonthKey: nextMonthKey_,
    categoryQueryFormula: categoryQueryFormula_,
    DEFAULT_CATEGORIES,
  };
}
