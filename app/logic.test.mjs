// Run: node app/logic.test.mjs
import assert from 'node:assert/strict';
import { monthModel, standing, brief, toEntry, rowToEntry, entryToRow, rowToCategory, categoryToRow, DEFAULT_CATEGORIES, findBankMatch, today, monthRows } from './logic.js';

const fmt = n => String(Math.round(n));
const cats = [
  { name: 'البيت', type: 'fixed', budget: 12000, setAside: 0 },
  { name: 'بنزين', type: 'variable', budget: 1000, setAside: 0 },
  { name: 'ملابس', type: 'periodic', budget: 1200, setAside: 4200 },
  { name: 'مواصلات', type: 'variable', budget: 0, setAside: 0 },
  { name: 'أخرى', type: 'variable', budget: 0, setAside: 0 },
];
const e = (date, kind, egp, category = '') => ({ date, kind, amount: egp, currency: 'EGP', egp, category, said: '', id: date + kind + egp, status: 'saved' });
const base = [e('2026-11-01', 'income', 50000), e('2026-11-01', 'expense', 12000, 'البيت'), e('2026-10-30', 'expense', 999, 'بنزين')];
const ledger = { categories: cats, entries: base, goal: 10000 };

// Month model keeps only this month's entries.
const nov8 = new Date(2026, 10, 8), nov20 = new Date(2026, 10, 20);
assert.equal(monthModel(ledger, nov8).entries.length, 2);
assert.equal(monthModel(ledger, nov8).days, 30);

// Standing: fixed at budget, variable at budget floor, periodic set-aside counted.
let s = standing(monthModel(ledger, nov8));
assert.equal(s.spend, 12000 + 1000 + 1200);
assert.equal(s.savings, 50000 - 14200);

// A Saving is not spending.
const withSaving = { ...ledger, entries: [...base, e('2026-11-05', 'saving', 5000)] };
assert.equal(standing(monthModel(withSaving, nov8)).spend, s.spend);
assert.equal(standing(monthModel(withSaving, nov8)).saved, 5000);

// Pace is ignored before the 10th, used after.
const fuel = { ...ledger, entries: [...base, e('2026-11-03', 'expense', 900, 'بنزين')] };
assert.equal(brief(monthModel(fuel, nov8), fuel.entries.at(-1), s, fmt).tone, 'ok');
const m20 = monthModel(fuel, nov20);
assert.equal(brief(m20, fuel.entries.at(-1), standing(m20), fmt).tone, 'warn'); // 900/20*30 = 1350 > 1000
assert.match(brief(m20, fuel.entries.at(-1), standing(m20), fmt).lines[0], /هتوصل 1350/);

// Over budget is "over".
const over = { ...ledger, entries: [...base, e('2026-11-03', 'expense', 1500, 'بنزين')] };
assert.equal(brief(monthModel(over, nov8), over.entries.at(-1), s, fmt).tone, 'over');

// Unknown category -> warn; unbudgeted category -> plain monthly total.
const other = { ...ledger, entries: [...base, e('2026-11-03', 'expense', 400, 'أخرى')] };
assert.equal(brief(monthModel(other, nov8), other.entries.at(-1), s, fmt).tone, 'warn');
const ride = { ...ledger, entries: [...base, e('2026-11-03', 'expense', 80, 'مواصلات')] };
assert.match(brief(monthModel(ride, nov8), ride.entries.at(-1), s, fmt).lines[0], /مواصلات: 80/);

// Periodic draws from the set-aside.
const clothes = { ...ledger, entries: [...base, e('2026-11-03', 'expense', 1500, 'ملابس')] };
assert.match(brief(monthModel(clothes, nov8), clothes.entries.at(-1), s, fmt).lines[0], /فاضل فيه 2700/);

// Claude JSON -> Entry: days_ago, USD conversion, no amount -> null, category cleared for non-expenses.
const en = toEntry({ kind: 'expense', amount: 100, currency: 'USD', category: 'فواتير', days_ago: 1, understood: 'x' }, 't', nov8, 50, 'id1');
assert.deepEqual([en.date, en.egp, en.category], ['2026-11-07', 5000, 'فواتير']);
assert.equal(toEntry({ kind: 'expense', amount: 0 }, 't', nov8, 50, 'id'), null);
assert.equal(toEntry({ kind: 'saving', amount: 10, currency: 'EGP', category: 'أخرى', days_ago: 0 }, 't', nov8, 50, 'id').category, '');

// Ledger rows round-trip.
const row = entryToRow({ ...en, status: 'saved' });
assert.deepEqual(rowToEntry(row), { ...en, status: 'saved' });
assert.equal(rowToEntry(['2026-11-01', 'غلط', 5]), null);
// Rows from before the source column are spoken; the hub's rows round-trip too.
assert.equal(rowToEntry(['2026-11-01', 'صرفة', 5, 'EGP', 5, 'بنزين', '', 'x']).source, 'voice');
assert.deepEqual(rowToEntry(['2026-11-09', 'صرفة', 700, 'EGP', 700, 'بنزين', 'sms', 'b1', 'رسالة', 'MOBIL']).merchant, 'MOBIL');
assert.equal(rowToEntry(['2026-11-10', 'سحب', 4000, 'EGP', 4000, '', 'sms', 'b2', 'رسالة', 'CIB']).kind, 'withdrawal');

// Match: a spoken Expense joins the Bank Message the hub saved first.
const sms = { ...e('2026-11-09', 'expense', 700, '؟'), id: 'b1', source: 'bank', merchant: 'MOBIL' };
const spoken = { ...e('2026-11-10', 'expense', 700, 'بنزين'), source: 'voice' };
assert.equal(findBankMatch([sms], spoken), sms);
assert.equal(findBankMatch([{ ...sms, source: 'matched' }], spoken), null);
assert.equal(findBankMatch([{ ...sms, date: '2026-11-07' }], spoken), null);
assert.equal(findBankMatch([sms], { ...spoken, egp: 800 }), null);
assert.equal(findBankMatch([sms], { ...spoken, kind: 'income' }), null);
// A Withdrawal never counts as spending.
assert.equal(standing(monthModel({ ...ledger, entries: [...base, e('2026-11-05', 'withdrawal', 4000)] }, nov8)).spend, s.spend);
assert.deepEqual(rowToCategory(categoryToRow(cats[2])), cats[2]);
assert.equal(rowToCategory(['', 'ثابت']), null);
assert.equal(DEFAULT_CATEGORIES.length, 22);

// Today: the Variable Budgets' rest this morning, spread over the days left, less today's spending.
{
  const tc = [{ name: 'بنزين', type: 'variable', budget: 3000, setAside: 0 }, { name: 'خروجات', type: 'variable', budget: 1500, setAside: 0 },
    { name: 'البيت', type: 'fixed', budget: 12000, setAside: 0 }, { name: 'ملابس', type: 'periodic', budget: 500, setAside: 2000 }];
  const tl = es => ({ categories: tc, entries: es, goal: 0 });
  const nov19 = new Date(2026, 10, 19);
  const before = [e('2026-11-03', 'expense', 900, 'بنزين'), e('2026-11-10', 'expense', 600, 'خروجات'), e('2026-11-01', 'expense', 12000, 'البيت'),
    e('2026-11-05', 'expense', 400, 'ملابس'), e('2026-11-05', 'income', 50000), e('2026-11-06', 'withdrawal', 3000)];
  // 4500 budgeted, 1500 spent before today: 3000 over the 12 days left = 250. Fixed, Periodic, income and cash don't count.
  assert.deepEqual(today(monthModel(tl(before), nov19)), { amount: 250, spentToday: 0, left: 3000, pool: 4500, tomorrow: 273 });
  // Spending today comes off today; a «؟» Expense from the bank is day-to-day too.
  const t2 = today(monthModel(tl([...before, e('2026-11-19', 'expense', 100, 'خروجات'), e('2026-11-19', 'expense', 50, '؟')]), nov19));
  assert.deepEqual([t2.amount, t2.spentToday, t2.left, t2.tomorrow], [100, 150, 2850, 259]);
  // Past today's share: negative, and tomorrow is spread from what's left.
  const t3 = today(monthModel(tl([...before, e('2026-11-19', 'expense', 1300, 'بنزين')]), nov19));
  assert.deepEqual([t3.amount, t3.tomorrow], [-1050, 155]);
  // The last day has no tomorrow; no Variable Budget means no number, only what was spent today.
  assert.equal(today(monthModel(tl(before), new Date(2026, 10, 30))).tomorrow, null);
  const none = today(monthModel({ categories: [tc[2]], entries: [e('2026-11-19', 'expense', 70, 'مواصلات')], goal: 0 }, nov19));
  assert.deepEqual([none.amount, none.spentToday], [null, 70]);

  // Month View: most spent first, Categories with nothing planned or spent left out, strays kept.
  const rows = monthRows(monthModel(tl([...before, e('2026-11-12', 'expense', 80, 'هدايا')]), nov19));
  assert.deepEqual(rows.map(r => r.name), ['البيت', 'بنزين', 'خروجات', 'ملابس', 'هدايا']);
  const fuelRow = rows.find(r => r.name === 'بنزين'), outRow = rows.find(r => r.name === 'خروجات');
  assert.deepEqual([fuelRow.plan, fuelRow.slack, fuelRow.attention], [3000, 10, false]); // 900 of 3000 is 9 days' worth on day 19
  assert.deepEqual([outRow.slack, outRow.attention], [7, false]);
  assert.equal(rows.find(r => r.name === 'ملابس').plan, 2000); // a Periodic Category is measured against its Set-aside
  assert.deepEqual([rows.at(-1).plan, rows.at(-1).slack], [0, null]);
  const hot = monthRows(monthModel(tl([e('2026-11-15', 'expense', 2900, 'بنزين')]), nov19)).find(r => r.name === 'بنزين');
  assert.deepEqual([hot.slack, hot.attention], [-10, true]); // 2900/19*30 is past 3000
}

console.log('logic: all checks passed');
