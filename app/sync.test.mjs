// Run: node app/sync.test.mjs. The local-first sync (ADR-0005) and the phase 2 logic: Cash, Corrections, Questions, asks.
import assert from 'node:assert/strict';
import { reconcile, settle, applyOps } from './sync.js';
import { cashInHand, cashCountEntry, corrected, answer, nextAsk, categoryFor, findBankMatch, matchInto, OTHER, PERSONAL, UNKNOWN } from './logic.js?v=5';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('✓', name); };
const E = (id, date, kind, egp, extra = {}) => ({ id, date, kind, amount: egp, currency: 'EGP', egp, category: kind === 'expense' ? 'بنزين' : '', said: '', source: 'voice', merchant: '', ...extra });
const state = (entries, more = {}) => ({ entries, dirty: [], gone: [], ops: [], ...more });
const row = (e, r) => ({ ...e, row: r, status: 'saved' });

/* ---------- reconcile ---------- */

test('a new spoken Entry is appended; nothing else is written', () => {
  const a = E('a', '2026-11-10', 'expense', 50);
  const r = reconcile(state([a], { dirty: ['a'] }), []);
  assert.deepEqual(r.plan.append, [a]);
  assert.equal(r.plan.update.length + r.plan.remove.length, 0);
});

test('a lost append is not written twice: the next read finds the row and updates it', () => {
  const a = E('a', '2026-11-10', 'expense', 50);
  const r = reconcile(state([a], { dirty: ['a'] }), [row(a, 7)]);
  assert.equal(r.plan.append.length, 0);
  assert.deepEqual(r.plan.update, [{ row: 7, entry: a }]);
});

test('the hub\'s new Bank Messages come in; edits made in the Sheet are taken unless the phone has a pending change', () => {
  const a = { ...E('a', '2026-11-10', 'expense', 50), synced: true }, b = { ...E('b', '2026-11-10', 'expense', 70), synced: true };
  const sms = E('b1', '2026-11-11', 'expense', 450, { source: 'bank', merchant: 'ACME STORE', category: UNKNOWN });
  const r = reconcile(state([a, b], { dirty: ['b'] }), [row({ ...a, category: 'خروجات' }, 2), row({ ...b, category: 'خروجات' }, 3), row(sms, 4)]);
  const by = Object.fromEntries(r.entries.map(e => [e.id, e]));
  assert.equal(by.a.category, 'خروجات'); // taken from the Sheet
  assert.equal(by.b.category, 'بنزين'); // the phone's pending change wins
  assert.equal(by.b1.merchant, 'ACME STORE');
  assert.equal(by.b1.row, undefined);
});

test('a row deleted in the Sheet is deleted on the phone; one never pushed is kept', () => {
  const a = { ...E('a', '2026-11-10', 'expense', 50), synced: true }, b = E('b', '2026-11-10', 'expense', 70);
  const r = reconcile(state([a, b]), []);
  assert.deepEqual(r.entries.map(e => e.id), ['b']);
  assert.deepEqual(r.plan.append.map(e => e.id), ['b']);
});

test('a removal deletes its row, bottom rows first; a removed Entry is not read back in', () => {
  const r = reconcile(state([], { gone: ['x', 'y'] }), [row(E('x', '2026-11-01', 'expense', 1), 3), row(E('y', '2026-11-01', 'expense', 2), 9)]);
  assert.deepEqual(r.plan.remove, [{ row: 9, id: 'y' }, { row: 3, id: 'x' }]);
  assert.equal(r.entries.length, 0);
});

test('cleared phone storage: everything is rebuilt from the Sheet', () => {
  const r = reconcile(state([]), [row(E('a', '2026-11-01', 'income', 9000), 2), row(E('b', '2026-11-02', 'expense', 50), 3)]);
  assert.equal(r.entries.length, 2);
  assert.ok(r.entries.every(e => e.synced));
});

test('an SMS that arrives after the spoken Entry reached the Sheet: one Matched Entry under the bank\'s ID', () => {
  const spoken = { ...E('v', '2026-11-09', 'expense', 700, { said: 'بنزين ٧٠٠' }), synced: true };
  const sms = E('b1', '2026-11-09', 'expense', 700, { source: 'bank', merchant: 'MOBIL', category: UNKNOWN });
  const r = reconcile(state([spoken]), [row(spoken, 2), row(sms, 3)]);
  assert.equal(r.entries.length, 1);
  assert.deepEqual([r.entries[0].id, r.entries[0].category, r.entries[0].merchant, r.entries[0].source], ['b1', 'بنزين', 'MOBIL', 'matched']);
  assert.deepEqual(r.plan.update.map(u => u.row), [3]);
  assert.deepEqual(r.plan.remove, [{ row: 2, id: 'v' }]);
  assert.deepEqual(r.renamed, { v: 'b1' });
});

test('settle: what reached the Sheet is synced, a change made during the push stays pending', () => {
  const a = E('a', '2026-11-10', 'expense', 50), b = E('b', '2026-11-10', 'expense', 70);
  const r = reconcile(state([a, b], { dirty: ['a', 'b'], ops: [{ type: 'rule' }, { type: 'rule' }] }), []);
  const now = { ...r, ops: [{ type: 'rule' }, { type: 'rule' }, { type: 'budget' }], entries: r.entries.map(e => (e.id === 'b' ? { ...e, egp: 80 } : e)) };
  const s = settle(now, r.plan, 2);
  assert.deepEqual(s.dirty, ['b']);
  assert.equal(s.entries.find(e => e.id === 'a').synced, true);
  assert.deepEqual(s.ops, [{ type: 'budget' }]);
});

test('applyOps: a Budget, "ignore" and a Rule count before they reach the Sheet', () => {
  const meta = applyOps({ categories: [{ name: 'بنزين', type: 'variable', budget: 0, setAside: 0 }], rules: [] },
    [{ type: 'budget', category: 'بنزين', amount: 2000 }, { type: 'budget', category: 'هدايا', excluded: true }, { type: 'rule', merchant: 'ACME STORE', category: 'ملابس' }]);
  assert.equal(meta.categories[0].budget, 2000);
  assert.equal(meta.categories[1].type, 'excluded');
  assert.deepEqual(meta.rules, [['ACME STORE', 'ملابس']]);
});

/* ---------- Match, Cash, Corrections ---------- */

test('a spoken Withdrawal matches its SMS too', () => {
  const sms = E('b2', '2026-11-10', 'withdrawal', 4000, { source: 'bank', merchant: 'CIB' });
  const spoken = E('v', '2026-11-10', 'withdrawal', 4000);
  assert.equal(findBankMatch([sms], spoken), sms);
  assert.equal(findBankMatch([sms], { ...spoken, kind: 'expense' }), null);
  assert.equal(matchInto(sms, spoken).source, 'matched');
});

test('Cash: Withdrawals in, spoken Expenses out, card charges and older Expenses ignored', () => {
  const es = [E('o', '2026-11-01', 'expense', 999), E('w', '2026-11-02', 'withdrawal', 2500, { source: 'bank' }),
    E('c', '2026-11-03', 'expense', 200), E('k', '2026-11-03', 'expense', 450, { source: 'bank' }), E('m', '2026-11-04', 'expense', 700, { source: 'matched' })];
  assert.equal(cashInHand(es), 2300);
  assert.equal(cashInHand([E('c', '2026-11-03', 'expense', 200)]), null);
});

test('Cash Count: less cash than expected is Unaccounted Cash in مصاريفي الشخصية; more is added as a Withdrawal', () => {
  const es = [E('w', '2026-11-02', 'withdrawal', 2500)], today = new Date(2026, 10, 13);
  const cats = [{ name: PERSONAL }];
  const lost = cashCountEntry(es, 2000, today, 'x', cats);
  assert.deepEqual([lost.kind, lost.egp, lost.category, lost.date], ['expense', 500, PERSONAL, '2026-11-13']);
  assert.equal(cashCountEntry(es, 2000, today, 'x', []).category, OTHER);
  assert.deepEqual([cashCountEntry(es, 2900, today, 'x', cats).kind, cashCountEntry(es, 2900, today, 'x', cats).egp], ['withdrawal', 400]);
  assert.equal(cashCountEntry(es, 2500, today, 'x', cats), null);
  assert.equal(cashCountEntry([], 1000, today, 'x', cats).kind, 'withdrawal'); // first count: the starting Cash
});

test('a Correction changes only what was said', () => {
  const e = E('a', '2026-11-13', 'expense', 500), today = new Date(2026, 10, 13);
  assert.deepEqual(corrected(e, { amount: 50, category: '', days_ago: -1 }, today, 50), { ...e, amount: 50, egp: 50 });
  assert.equal(corrected(e, { amount: 0, category: 'مواصلات', days_ago: 1 }, today, 50).date, '2026-11-12');
  assert.equal(corrected({ ...e, currency: 'USD' }, { amount: 10, category: '', days_ago: -1 }, today, 50).egp, 500);
  assert.equal(corrected(E('i', '2026-11-13', 'income', 9), { amount: 0, category: 'بنزين', days_ago: -1 }, today, 50).category, '');
});

test('Rules: longest text wins, as in the hub', () => {
  assert.equal(categoryFor('UBER EATS CAIRO', [['UBER', 'مواصلات'], ['uber eats', 'خروجات']]), 'خروجات');
  assert.equal(categoryFor('ACME STORE', [['MOBIL', 'بنزين']]), null);
});

/* ---------- Questions and asks ---------- */

const fmt = x => String(Math.round(x));
const cats = [{ name: 'بنزين', type: 'variable', budget: 2000, setAside: 0 }, { name: 'خروجات', type: 'variable', budget: 0, setAside: 0 },
  { name: 'هدايا', type: 'excluded', budget: 0, setAside: 0 }, { name: OTHER, type: 'variable', budget: 0, setAside: 0 }];
const today = new Date(2026, 10, 13);
const es = [E('i', '2026-11-01', 'income', 20000), E('f1', '2026-11-05', 'expense', 500), E('f2', '2026-11-13', 'expense', 300),
  E('g', '2026-11-12', 'expense', 400, { category: 'خروجات' }), E('old', '2026-10-20', 'expense', 700)];

test('Questions: spent, left, today, last month', () => {
  const book = { categories: cats, entries: es, goal: 5000 };
  assert.equal(answer(book, { about: 'spent', period: 'month', category: 'بنزين' }, today, fmt).egp, 800);
  const left = answer(book, { about: 'left', period: 'month', category: 'بنزين' }, today, fmt);
  assert.deepEqual([left.egp, left.label], [1200, 'فاضل في بنزين']);
  assert.equal(answer(book, { about: 'spent', period: 'today', category: '' }, today, fmt).egp, 300);
  assert.equal(answer(book, { about: 'spent', period: 'last_month', category: '' }, today, fmt).egp, 700);
  assert.equal(answer(book, { about: 'cash', period: 'month', category: '' }, today, fmt).egp, null);
  assert.equal(answer(book, { about: 'spent', period: 'month', category: 'خروجات' }, today, fmt).line, 'مالوش ميزانية');
});

test('the orb asks about «؟» Merchants first, then Categories with Expenses and no Budget; never Excluded or أخرى', () => {
  const sms = E('b', '2026-11-11', 'expense', 450, { source: 'bank', merchant: 'ACME STORE', category: UNKNOWN });
  const book = { categories: cats, entries: [...es, sms, E('h', '2026-11-12', 'expense', 100, { category: 'هدايا' }), E('o', '2026-11-12', 'expense', 100, { category: OTHER })] };
  assert.deepEqual(nextAsk(book, today, new Set()), { type: 'merchant', key: 'm:ACME STORE', merchant: 'ACME STORE', egp: 450 });
  assert.deepEqual(nextAsk(book, today, new Set(['m:ACME STORE'])), { type: 'budget', key: 'b:خروجات', category: 'خروجات' });
  assert.equal(nextAsk(book, today, new Set(['m:ACME STORE', 'b:خروجات'])), null);
});

console.log(`\n${n} passed`);
