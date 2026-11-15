// Spent hub: an Apps Script bound to the user's own Ledger (ADR-0006). Bank Messages arrive here from an
// iOS Shortcut (ADR-0007), are parsed with fixed rules plus the user's Rules, and land in Entries.
// No Claude key lives here: anything the rules can't read waits in the Inbox tab for the app.
// Terms follow GLOSSARY.md. The pure part (top) is tested by hub.test.mjs; the Sheets part is at the bottom.

/* ---------- pure: no Apps Script services above the line ---------- */

var KIND_AR = { expense: 'صرفة', income: 'دخل', saving: 'تحويش', withdrawal: 'سحب' };
var SOURCE = { voice: 'صوت', bank: 'رسالة', matched: 'صوت + رسالة' };
var UNKNOWN = '؟';
var ENTRY_HEADERS = ['التاريخ', 'النوع', 'المبلغ', 'العملة', 'بالجنيه', 'البند', 'اللي اتقال', 'ID', 'المصدر', 'التاجر'];
var COL = { date: 0, kind: 1, amount: 2, currency: 3, egp: 4, category: 5, said: 6, id: 7, source: 8, merchant: 9 };

// Merchant text (as the bank writes it) -> Category. The user edits these in the Rules tab; these only seed it.
var STARTER_RULES = [
  ['MOBIL', 'بنزين'], ['TOTAL', 'بنزين'], ['CHILLOUT', 'بنزين'], ['WATANIA', 'بنزين'], ['EMARAT MISR', 'بنزين'], ['MISR PETROLEUM', 'بنزين'],
  ['CARREFOUR', 'بقالة وطلبات البيت'], ['SPINNEYS', 'بقالة وطلبات البيت'], ['HYPER ONE', 'بقالة وطلبات البيت'], ['KAZYON', 'بقالة وطلبات البيت'],
  ['METRO MARKET', 'بقالة وطلبات البيت'], ['SEOUDI', 'بقالة وطلبات البيت'], ['GOURMET', 'بقالة وطلبات البيت'], ['BREADFAST', 'بقالة وطلبات البيت'],
  ['TALABAT', 'خروجات'], ['UBER', 'مواصلات'], ['CAREEM', 'مواصلات'], ['DIDI', 'مواصلات'], ['INDRIVE', 'مواصلات'],
  ['APPLE.COM', 'فواتير واشتراكات'], ['NETFLIX', 'فواتير واشتراكات'], ['SPOTIFY', 'فواتير واشتراكات'], ['ANTHROPIC', 'فواتير واشتراكات'],
  ['CLAUDE', 'فواتير واشتراكات'], ['OPENAI', 'فواتير واشتراكات'], ['VODAFONE', 'فواتير واشتراكات'], ['ORANGE', 'فواتير واشتراكات'],
  ['ETISALAT', 'فواتير واشتراكات'], ['EL EZABY', 'كشف ودواء'], ['SEIF PHARM', 'كشف ودواء'], ['PHARMACY', 'كشف ودواء'],
];

// One Bank Message -> { kind, amount, currency, merchant, date } | { kind: 'ignore' } | null (can't read it).
// CIB formats: Arabic debit purchase «تم خصم EGP 700.00 … عند MOBIL في 19/03/26»,
// Arabic Withdrawal «تم سحب مبلغ EGP 4000.00 … من CIB MAIN BR في 20/03/26», English credit card
// «charged for EGP 149.99 at APPLE.COM BILL on 14/03/26». Dates are dd/mm/yy.
function parseBankMessage(text) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // Paying the credit card bill moves money between the user's own accounts; the charges already counted (ADR-0007).
  if (/سداد|payment (?:of .* )?(?:has been )?received|thank you for your payment/i.test(t)) return { kind: 'ignore' };
  if (/refund|reversal|استرداد|إلغاء|credited|تم إضافة|تم ايداع|تم إيداع/i.test(t)) return null; // money in: let the app and Claude read it
  // The digits before the point are optional: CIB writes five cents as «USD .05», and skipping it would read the
  // card's limit («EGP 99999») later in the same message as the amount.
  var money = t.match(/\b(EGP|USD)\s*([\d,]*\.?\d+)/i);
  var day = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!money || !day) return null;
  var amount = Number(money[2].replace(/,/g, ''));
  if (!(amount > 0)) return null;
  var y = Number(day[3]); if (y < 100) y += 2000;
  var date = y + '-' + pad2(day[2]) + '-' + pad2(day[1]);
  var m;
  if (/سحب|withdraw|\bATM\b/i.test(t)) {
    m = t.match(/.*(?:^|\s)من\s+(.+?)\s+في\s+\d{1,2}\//) || t.match(/\bat\s+(.+?)\s+on\s+\d{1,2}\//i);
    return { kind: 'withdrawal', amount: amount, currency: money[1].toUpperCase(), merchant: m ? m[1].trim() : '', date: date };
  }
  if (/خصم|charged|purchase|شراء/i.test(t)) {
    m = t.match(/عند\s+(.+?)\s+في\s+\d{1,2}\//) || t.match(/\bat\s+(.+?)\s+on\s+\d{1,2}\//i);
    if (!m) return null;
    return { kind: 'expense', amount: amount, currency: money[1].toUpperCase(), merchant: m[1].trim(), date: date };
  }
  return null;
}

// The longest Rule whose text appears in the Merchant wins ("APPLE.COM BILL" matches "APPLE.COM").
function categoryFor(merchant, rules) {
  var up = String(merchant || '').toUpperCase(), best = null;
  for (var i = 0; i < rules.length; i++) {
    var key = String(rules[i][0] || '').trim().toUpperCase(), cat = String(rules[i][1] || '').trim();
    if (key && cat && up.indexOf(key) !== -1 && (!best || key.length > best.key.length)) best = { key: key, cat: cat };
  }
  return best ? best.cat : null;
}

// A spoken Expense (or Withdrawal) already in the Ledger that this Bank Message is about: same kind, same amount in EGP,
// dates at most a day apart, spoken (not from another Bank Message) and not matched yet. The closest date wins, then the latest row.
function findMatch(rows, egp, date, kindAr) {
  var best = -1, bestGap = 99;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r[COL.kind] !== (kindAr || KIND_AR.expense)) continue;
    var src = String(r[COL.source] || '');
    if (src && src !== SOURCE.voice) continue;
    if (Math.abs(Number(r[COL.egp]) - egp) >= 1) continue;
    var gap = dayGap(String(r[COL.date]).slice(0, 10), date);
    if (gap <= 1 && gap <= bestGap) { best = i; bestGap = gap; }
  }
  return best;
}

// Where the Category stands this month after this Expense, in the Brief's words.
function categoryLine(rows, budgets, cat, month) {
  var spent = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r[COL.kind] === KIND_AR.expense && r[COL.category] === cat && String(r[COL.date]).indexOf(month) === 0) spent += Number(r[COL.egp]) || 0;
  }
  var budget = 0;
  for (var j = 0; j < budgets.length; j++) if (String(budgets[j][0]).trim() === cat) budget = Number(budgets[j][2]) || 0;
  if (!budget) return cat + ': ' + fmt(spent) + ' ج الشهر ده';
  if (spent > budget) return 'عدّيت ميزانية ' + cat + ' بـ ' + fmt(spent - budget) + ' ج';
  return cat + ': فاضل ' + fmt(budget - spent) + ' من ' + fmt(budget);
}

// The whole hub decision for one Bank Message. `ledger` is plain data plus three write callbacks, so this runs
// the same in Apps Script and in Node tests. Returns the notification text ('' means: show nothing).
function handleBankMessage(text, ledger) {
  var id = 'b' + hash(String(text).replace(/\s+/g, ' ').trim());
  var rows = ledger.entries;
  for (var i = 0; i < rows.length; i++) if (rows[i][COL.id] === id) return ''; // the Shortcut ran twice for one SMS
  var p = parseBankMessage(text);
  if (!p) { ledger.toInbox(text); return 'وصلت رسالة من البنك ومافهمتهاش؛ اتحفظت في تاب Inbox'; }
  if (p.kind === 'ignore') return '';
  var egp = p.currency === 'USD' ? Math.round(p.amount * (ledger.usdRate || 50)) : p.amount;
  var said = String(text).replace(/\s+/g, ' ').trim();
  if (p.kind === 'withdrawal') {
    var w = findMatch(rows, egp, p.date, KIND_AR.withdrawal);
    if (w !== -1) {
      var wr = rows[w].slice(); while (wr.length < ENTRY_HEADERS.length) wr.push('');
      wr[COL.source] = SOURCE.matched; wr[COL.merchant] = p.merchant;
      ledger.update(w, wr);
      return 'سحبت ' + fmt(egp) + ' ج كاش · اتطابقت مع اللي قلته';
    }
    ledger.append([p.date, KIND_AR.withdrawal, p.amount, p.currency, egp, '', said, id, SOURCE.bank, p.merchant]);
    return 'سحبت ' + fmt(egp) + ' ج كاش' + (p.merchant ? ' · ' + p.merchant : '');
  }
  var at = findMatch(rows, egp, p.date);
  if (at !== -1) {
    var r = rows[at].slice(); while (r.length < ENTRY_HEADERS.length) r.push('');
    r[COL.source] = SOURCE.matched; r[COL.merchant] = p.merchant;
    ledger.update(at, r);
    return fmt(egp) + ' ج · ' + p.merchant + ' اتطابقت مع «' + (r[COL.category] || UNKNOWN) + '»';
  }
  var cat = categoryFor(p.merchant, ledger.rules);
  var row = [p.date, KIND_AR.expense, p.amount, p.currency, egp, cat || UNKNOWN, said, id, SOURCE.bank, p.merchant];
  var note = !cat ? fmt(egp) + ' ج · ' + p.merchant + ' → بند؟ افتح Spent وقول كانت إيه'
    : fmt(egp) + ' ج · ' + p.merchant + ' → ' + cat + '\n' + categoryLine(rows.concat([row]), ledger.budgets, cat, p.date.slice(0, 7));
  ledger.append(row); // after the note: the note counts this row once whether or not append touches `rows`
  return note;
}

// After the user adds a Rule: give every «؟» Expense whose Merchant now has a Rule its Category. Returns changed row indexes.
function recategorize(rows, rules) {
  var changed = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][COL.kind] !== KIND_AR.expense || rows[i][COL.category] !== UNKNOWN) continue;
    var cat = categoryFor(rows[i][COL.merchant], rules);
    if (cat) { rows[i][COL.category] = cat; changed.push(i); }
  }
  return changed;
}

function pad2(n) { return ('0' + Number(n)).slice(-2); }
function dayGap(a, b) {
  var pa = a.split('-'), pb = b.split('-');
  return Math.abs(Date.UTC(+pa[0], pa[1] - 1, +pa[2]) - Date.UTC(+pb[0], pb[1] - 1, +pb[2])) / 864e5;
}
function fmt(n) { // 1234.56 -> "١٬٢٣٥" (Arabic-Indic digits, like the app)
  var s = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  return s.replace(/\d/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[d]; });
}
function hash(s) { // FNV-1a, 32-bit: a stable ID for one SMS text
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/* ---------- Apps Script: the Sheets adapter and the web app ---------- */

// Called by the Shortcut: POST ?token=… with JSON {"text": "<the SMS>"}. Replies with the notification text.
function doPost(e) {
  if (!authorized(e)) return out('');
  var text = '';
  try { text = JSON.parse(e.postData.contents).text; } catch (err) { text = e.parameter.text || (e.postData && e.postData.contents) || ''; }
  if (!String(text).trim()) return out('');
  // No digit at all = not an SMS. Usually the Shortcut sent a variable's name ("Shortcut Input") typed as plain text.
  if (!/[0-9٠-٩]/.test(text)) return out('الاختصار بعت «' + String(text).slice(0, 40) + '» مش نص الرسالة. اختار Shortcut Input كمتغير (أزرق) مش كتابة.');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return out(handleBankMessage(text, openLedger())); }
  finally { lock.releaseLock(); }
}

// GET ?token=… answers "Spent ✓" so the setup can check the URL and token. (The evening Check-in comes in phase 3.)
function doGet(e) { return out(authorized(e) ? 'Spent ✓' : ''); }

// Simple trigger: when the user types a Rule, file the «؟» Expenses it covers.
function onEdit(e) {
  if (!e || e.range.getSheet().getName() !== 'Rules') return;
  var ss = SpreadsheetApp.getActiveSpreadsheet(), entries = ss.getSheetByName('Entries');
  var last = entries.getLastRow(); if (last < 2) return;
  var range = entries.getRange(2, 1, last - 1, ENTRY_HEADERS.length), rows = range.getValues();
  if (recategorize(rows.map(fixDate), readRules(ss)).length) {
    entries.getRange(2, COL.category + 1, rows.length, 1).setValues(rows.map(function (r) { return [r[COL.category]]; }));
  }
}

// Run once from the editor (▶ setup): adds the hub's tabs and columns and makes the secret token.
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTabs(ss);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('token')) props.setProperty('token', Utilities.getUuid().replace(/-/g, ''));
  Logger.log('Token: ' + props.getProperty('token'));
  Logger.log('After Deploy → New deployment (Web app, Execute as: Me, Who has access: Anyone), the Shortcut URL is:');
  Logger.log((ScriptApp.getService().getUrl() || '<the web app URL>') + '?token=' + props.getProperty('token'));
}

function authorized(e) {
  var token = PropertiesService.getScriptProperties().getProperty('token');
  return !!token && e && e.parameter && e.parameter.token === token;
}
function out(text) { return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.TEXT); }

function ensureTabs(ss) {
  var entries = ss.getSheetByName('Entries');
  var head = entries.getRange(1, 1, 1, ENTRY_HEADERS.length).getValues()[0];
  if (head[COL.source] !== ENTRY_HEADERS[COL.source]) entries.getRange(1, COL.source + 1, 1, 2).setValues([[ENTRY_HEADERS[COL.source], ENTRY_HEADERS[COL.merchant]]]);
  if (!ss.getSheetByName('Rules')) {
    var rules = ss.insertSheet('Rules'); rules.setRightToLeft(true); rules.setFrozenRows(1);
    rules.getRange(1, 1, 1, 2).setValues([['التاجر فيه', 'البند']]);
    rules.getRange(2, 1, STARTER_RULES.length, 2).setValues(STARTER_RULES);
    styleHead(rules, [220, 190]);
  }
  if (!ss.getSheetByName('Inbox')) {
    var inbox = ss.insertSheet('Inbox'); inbox.setRightToLeft(true); inbox.setFrozenRows(1);
    inbox.getRange(1, 1, 1, 3).setValues([['وصلت', 'الرسالة', 'اتعالجت']]);
    styleHead(inbox, [135, 560, 90]);
    inbox.getRange('B2:B').setWrap(true);
  }
}

// The same header look the app gives the other tabs (app/layout.js).
function styleHead(sh, widths) {
  sh.getRange(1, 1, 1, widths.length).setBackground('#0d1715').setFontColor('#eef3f1').setFontWeight('bold').setHorizontalAlignment('center');
  sh.setTabColor('#b06f00');
  for (var i = 0; i < widths.length; i++) sh.setColumnWidth(i + 1, widths[i]);
}

function openLedger() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureTabs(ss);
  var entries = ss.getSheetByName('Entries'), last = entries.getLastRow();
  var rows = last < 2 ? [] : entries.getRange(2, 1, last - 1, ENTRY_HEADERS.length).getValues().map(fixDate);
  var budgets = ss.getSheetByName('Budgets');
  var rate = Number(ss.getSheetByName('Settings').getRange('B3').getValue());
  return {
    entries: rows,
    rules: readRules(ss),
    budgets: budgets.getLastRow() < 2 ? [] : budgets.getRange(2, 1, budgets.getLastRow() - 1, 3).getValues(),
    usdRate: rate > 1 ? rate : null,
    // The date cell is text, the same way the app writes it (RAW), so month filters and SUMIFS wildcards work.
    append: function (row) {
      var range = entries.getRange(entries.getLastRow() + 1, 1, 1, row.length);
      range.getCell(1, 1).setNumberFormat('@');
      range.setValues([row]);
    },
    update: function (i, row) { entries.getRange(i + 2, 1, 1, row.length).setValues([row]); },
    toInbox: function (text) { ss.getSheetByName('Inbox').appendRow([Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd HH:mm'), text, '']); },
  };
}
function readRules(ss) {
  var sh = ss.getSheetByName('Rules');
  return !sh || sh.getLastRow() < 2 ? [] : sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
}
// A date the user typed in the sheet comes back as a Date; the app writes text. Normalize to "yyyy-MM-dd".
function fixDate(r) {
  if (r[COL.date] instanceof Date) r[COL.date] = Utilities.formatDate(r[COL.date], 'Africa/Cairo', 'yyyy-MM-dd');
  return r;
}
