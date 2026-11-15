// Run: node app/layout.test.mjs. The Ledger's layout (layout.js): well-formed requests and formulas, and safe to apply twice.
import assert from 'node:assert/strict';
import { layoutRequests, layoutValues, chartRequests, styleRules, DASH, DASH_ID } from './layout.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('✓', name); };
const fresh = [{ id: 1, title: 'Entries' }, { id: 2, title: 'Budgets' }, { id: 3, title: 'Months' }, { id: 4, title: 'Settings' }];
const kinds = reqs => reqs.map(r => Object.keys(r)[0]);
const sheetIds = x => (x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => (k === 'sheetId' ? [v] : sheetIds(v))) : []);
const formulas = x => (typeof x === 'string' ? (x.startsWith('=') ? [x] : []) : x && typeof x === 'object' ? Object.values(x).flatMap(formulas) : []);
function balanced(f) { // brackets pair up outside quoted text, and every quote closes
  const open = { ')': '(', '}': '{' }, stack = [];
  let quoted = false;
  for (const ch of f) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '(' || ch === '{')) stack.push(ch);
    else if (!quoted && open[ch] && stack.pop() !== open[ch]) return false;
  }
  return !quoted && !stack.length;
}

test('every request is one Sheets request about a tab that exists', () => {
  const reqs = layoutRequests(fresh);
  const known = new Set([1, 2, 3, 4, DASH_ID]);
  for (const r of reqs) {
    assert.equal(Object.keys(r).length, 1);
    for (const id of sheetIds(r)) assert.ok(known.has(id), `unknown sheet ${id} in ${Object.keys(r)[0]}`);
  }
  assert.equal(kinds(reqs)[0], 'addSheet'); // the Dashboard exists before anything is drawn on it
});

test('field masks name what they change; none replaces the whole gridProperties', () => {
  for (const r of layoutRequests(fresh)) {
    const f = Object.values(r)[0].fields;
    if (f) assert.ok(!/(^|,)gridProperties(,|$)/.test(f), f); // that mask would zero the row and column counts
    if (r.repeatCell) assert.match(f, /^userEnteredFormat\.[A-Za-z.]+(,userEnteredFormat\.[A-Za-z.]+)*$/); // Sheets refuses a(b,c) in an update mask
  }
});

test('every formula is balanced, in the cells and in the conditional formats', () => {
  const all = [...formulas(layoutValues(fresh)), ...formulas(layoutRequests(fresh))];
  assert.ok(all.length > 25);
  for (const f of all) assert.ok(balanced(f), f);
});

test('conditional formats on one tab get distinct, gap-free indexes', () => {
  const bySheet = {};
  for (const r of layoutRequests(fresh)) if (r.addConditionalFormatRule) {
    const { index, rule } = r.addConditionalFormatRule;
    (bySheet[rule.ranges[0].sheetId] ||= []).push(index);
  }
  for (const idx of Object.values(bySheet)) assert.deepEqual(idx, idx.map((_, i) => i));
});

test('applying it again clears what it made: the Dashboard is wiped, not added twice', () => {
  const again = [{ id: DASH_ID, title: DASH, rules: 5, charts: [11, 12] }, { id: 1, title: 'Entries', rules: 4 }, ...fresh.slice(1)];
  const k = kinds(layoutRequests(again));
  assert.ok(!k.includes('addSheet'));
  assert.equal(k.filter(x => x === 'deleteConditionalFormatRule').length, 9);
  assert.equal(k.filter(x => x === 'deleteEmbeddedObject').length, 2);
  assert.ok(k.indexOf('updateCells') < k.indexOf('mergeCells'));
});

test('a tab the user named Dashboard is left alone', () => {
  const tabs = [...fresh, { id: 99, title: DASH }];
  const add = layoutRequests(tabs).find(r => r.addSheet);
  assert.equal(add.addSheet.properties.title, 'Spent Dashboard');
  assert.ok(!layoutRequests(tabs).some(r => sheetIds(r).includes(99)));
  assert.ok(layoutValues(tabs)[0].range.startsWith("'Spent Dashboard'!"));
});

test('the data the app and the hub read is never written', () => {
  for (const { range } of layoutValues(fresh)) {
    assert.ok(!/^Entries!/.test(range), range);
    assert.ok(!/^Budgets!\$?[A-D]/.test(range), range);
    assert.ok(!/^Settings!\$?[AB]/.test(range), range);
  }
});

test('missing tabs are skipped; the hub tabs are styled when they exist', () => {
  const bare = [{ id: 1, title: 'Entries' }];
  assert.ok(!layoutValues(bare).some(d => /^(Budgets|Months|Settings)!/.test(d.range)));
  assert.equal(chartRequests(bare).length, 1);
  const withHub = [...fresh, { id: 5, title: 'Rules' }, { id: 6, title: 'Inbox' }];
  const ids = new Set(layoutRequests(withHub).flatMap(sheetIds));
  assert.ok(ids.has(5) && ids.has(6));
  assert.ok(styleRules(5).every(r => sheetIds(r).every(id => id === 5)));
});

test('charts sit on the Dashboard and read the Months tab', () => {
  const c = chartRequests(fresh);
  assert.equal(c.length, 2);
  for (const r of c) assert.equal(r.addChart.chart.position.overlayPosition.anchorCell.sheetId, DASH_ID);
  assert.deepEqual([...new Set(sheetIds(c[1].addChart.chart.spec))], [3]);
});

console.log(`\n${n} tests passed`);
