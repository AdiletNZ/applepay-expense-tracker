/**
 * Apple Pay → Google Таблица.
 *
 * Принимает покупки из автоматизации «Транзакция» в iOS «Быстрых командах»,
 * определяет категорию и записывает строку на лист «Операции».
 * Установка по шагам — в google-sheets/README.md.
 */

// ⬇️ Вставь сюда свой секретный токен (тот же, что в Быстрой команде)
const TOKEN = 'ВСТАВЬ_СВОЙ_ТОКЕН';
const TIMEZONE = 'Asia/Almaty';
const DEFAULT_CURRENCY = 'KZT';
const DEFAULT_CATEGORY = 'Другое';

const SHEETS = { tx: 'Операции', summary: 'Итоги', categories: 'Категории', rules: 'Правила' };
const TX_HEADERS = ['Дата', 'Магазин', 'Сумма', 'Валюта', 'Категория', 'Карта'];
const COL = { date: 1, merchant: 2, amount: 3, currency: 4, category: 5, card: 6 };

// ───────────────────────── Разбор суммы и категории ─────────────────────────

const CURRENCY_SYMBOLS = [
  ['₸', 'KZT'], ['тг', 'KZT'], ['₽', 'RUB'], ['руб', 'RUB'], ['$', 'USD'], ['€', 'EUR'],
  ['£', 'GBP'], ['₺', 'TRY'], ['¥', 'CNY'], ['₩', 'KRW'], ['₴', 'UAH'], ['₾', 'GEL'],
  ['сом', 'KGS'], ['сўм', 'UZS'],
];
const CURRENCY_SIGNS = { KZT: '₸', RUB: '₽', USD: '$', EUR: '€', GBP: '£' };

function detectCurrency(text) {
  const iso = text.match(/\b([A-Z]{3})\b/);
  if (iso) return iso[1];
  const lowered = text.toLowerCase();
  for (const [symbol, code] of CURRENCY_SYMBOLS) {
    if (lowered.includes(symbol)) return code;
  }
  return null;
}

function normalizeNumber(num) {
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
function parseAmount(value) {
  if (typeof value === 'number') return { amount: Math.round(value * 100) / 100, currency: null };
  const text = String(value);
  const currency = detectCurrency(text);
  const match = text.replace(/[\s   '’]/g, '').match(/-?\d[\d.,]*/);
  if (!match) throw new Error('Не удалось найти сумму в "' + text + '"');
  const amount = parseFloat(normalizeNumber(match[0].replace(/[.,]+$/, '')));
  return { amount: Math.round(amount * 100) / 100, currency: currency };
}

function merchantKey(merchant) {
  return String(merchant).toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * categories: [[категория, 'ключ1, ключ2']...] в порядке приоритета
 * learned: { 'magnum': 'Хозтовары' } — правила, выученные после ручной правки
 */
function guessCategory(merchant, categories, learned) {
  const key = merchantKey(merchant);
  if (learned && learned[key]) return learned[key];
  for (const [category, keywords] of categories) {
    const words = String(keywords || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    for (const word of words) {
      const re = new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegExp(word) + '(?![\\p{L}\\p{N}_])', 'u');
      if (re.test(key)) return category;
    }
  }
  return DEFAULT_CATEGORY;
}

function formatMoney(amount, currency) {
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
    const result = addTransaction(SpreadsheetApp.getActiveSpreadsheet(), body);
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

function addTransaction(ss, tx) {
  const merchant = String(tx.merchant || '').trim();
  if (!merchant) throw new Error('Не передан магазин (merchant)');
  if (tx.amount === undefined || tx.amount === '') throw new Error('Не передана сумма (amount)');
  const parsed = parseAmount(tx.amount);
  const currency = String(tx.currency || parsed.currency || DEFAULT_CURRENCY).toUpperCase();
  const category = guessCategory(merchant, readCategories_(ss), readRules_(ss));
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
    message: category + ': ' + formatMoney(parsed.amount, currency) + ' — ' + merchant,
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
    if (r[0] && r[1]) rules[merchantKey(r[0])] = String(r[1]);
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
  const key = merchantKey(merchant);
  const ss = sheet.getParent();

  const rules = sheet_(ss, SHEETS.rules);
  const existing = rules.getLastRow() > 1 ? rules.getRange(2, 1, rules.getLastRow() - 1, 1).getValues() : [];
  const idx = existing.findIndex((r) => merchantKey(r[0]) === key);
  if (idx >= 0) rules.getRange(idx + 2, 2).setValue(category);
  else rules.appendRow([merchant, category]);

  const n = sheet.getLastRow() - 1;
  const data = sheet.getRange(2, COL.merchant, n, COL.category - COL.merchant + 1).getValues();
  data.forEach((row, i) => {
    const cat = row[COL.category - COL.merchant];
    if (merchantKey(row[0]) === key && cat !== category) sheet.getRange(i + 2, COL.category).setValue(category);
  });
}

// ───────────────────────────── Первичная настройка ─────────────────────────────

/** Запусти один раз из редактора: создаёт листы, формулы и диаграмму. Данные не трогает. */
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

  // Итоги
  let sum = ss.getSheetByName(SHEETS.summary);
  if (!sum) {
    sum = ss.insertSheet(SHEETS.summary, 0);
    const src = "'" + SHEETS.tx + "'!A2:F";
    sum.getRange('A1:A3').setValues([['Месяц'], ['Валюта'], ['Всего']]).setFontWeight('bold');
    sum.getRange('B1')
      .setFormula('=TODAY()')
      .setNumberFormat('mmmm yyyy')
      .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).build())
      .setNote('Нажми дважды и выбери любой день нужного месяца. Вернуть текущий месяц: впиши =TODAY()');
    sum.getRange('B2').setValue(DEFAULT_CURRENCY);
    sum.getRange('B3').setFormula('=SUM(B6:B)').setNumberFormat('#,##0.##').setFontWeight('bold').setFontSize(14);
    // Служебные ячейки: границы выбранного месяца в формате, который понимает QUERY
    sum.getRange('Z1').setFormula('=DATE(YEAR(B1),MONTH(B1),1)');
    sum.getRange('Z2').setFormula('="date \'"&YEAR(Z1)&"-"&RIGHT("0"&MONTH(Z1),2)&"-01\'"');
    sum.getRange('Z3').setFormula('="date \'"&YEAR(EDATE(Z1,1))&"-"&RIGHT("0"&MONTH(EDATE(Z1,1)),2)&"-01\'"');
    sum.hideColumns(26);
    sum.getRange('A5').setFormula(
      '=IFERROR(QUERY(' + src + ',"select E, sum(C), count(C) where A >= "&Z2&" and A < "&Z3&" and D = \'"&B2&"\' ' +
      'group by E order by sum(C) desc label E \'Категория\', sum(C) \'Сумма\', count(C) \'Покупок\'",0),"Пока нет покупок")'
    );
    sum.getRange('E5').setFormula(
      '=IFERROR(QUERY(' + src + ',"select year(A), month(A)+1, sum(C) where A is not null and D = \'"&B2&"\' ' +
      'group by year(A), month(A)+1 order by year(A) desc, month(A)+1 desc ' +
      'label year(A) \'Год\', month(A)+1 \'Месяц\', sum(C) \'Всего за месяц\'",0),"")'
    );
    sum.getRange('B6:B').setNumberFormat('#,##0.##');
    sum.getRange('G6:G').setNumberFormat('#,##0.##');
    sum.getRange('A5:G5').setFontWeight('bold');
    sum.setColumnWidth(1, 190).setColumnWidth(7, 130);
    sum.insertChart(
      sum.newChart()
        .setChartType(Charts.ChartType.PIE)
        .addRange(sum.getRange('A5:B25'))
        .setNumHeaders(1)
        .setOption('title', 'Куда уходят деньги')
        .setOption('pieHole', 0.45)
        .setOption('legend', { position: 'right' })
        .setPosition(1, 9, 0, 0)
        .build()
    );
  }
  ss.setActiveSheet(sum);
  SpreadsheetApp.flush();
}

/** Проверка без iPhone: добавляет тестовую покупку. Потом удали строку. */
function testTransaction() {
  const result = addTransaction(SpreadsheetApp.getActiveSpreadsheet(), {
    merchant: 'Magnum Cash&Carry',
    amount: '5 400 ₸',
    card: 'Тест',
  });
  Logger.log(result.message);
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
  module.exports = { parseAmount, guessCategory, formatMoney, merchantKey, DEFAULT_CATEGORIES };
}
