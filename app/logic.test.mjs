// Run: node app/logic.test.mjs
import assert from 'node:assert/strict';
import { monthModel, standing, brief, toEntry, rowToEntry, entryToRow, rowToCategory, categoryToRow, DEFAULT_CATEGORIES, findBankMatch } from './logic.js';

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

console.log('logic: all checks passed');
