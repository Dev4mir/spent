// The Ledger: the user's own Google Sheet, reached straight from the browser (ADR-0002). The phone's mirror (ADR-0005).
// Auth is Google Identity Services' token model with drive.file only (non-sensitive scope).
import { ENTRY_HEADERS, BUDGET_HEADERS, RULE_HEADERS, DEFAULT_CATEGORIES, TYPE_AR, categoryToRow, entryToRow, rowToEntry, rowToCategory } from './logic.js?v=6';
import { LAYOUT, layoutRequests, layoutValues, chartRequests, styleRules } from './layout.js?v=6';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const TAG = { key: 'spent', value: 'ledger' }; // Drive appProperty used to find the Ledger again after a reinstall

export class AuthNeeded extends Error {}

export function createLedgerClient({ clientId, store }) {
  let token = store.get('gtoken', null); // { value, exp }
  const valid = () => token && token.exp > Date.now() + 60_000;

  // Must be called from a tap: iOS only allows the Google popup inside a user gesture.
  function connect() {
    return new Promise((resolve, reject) => {
      if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in did not load. Check the connection and reload.'));
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: SCOPE,
        callback: r => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          token = { value: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
          store.set('gtoken', token);
          resolve();
        },
        error_callback: e => reject(new Error(e.type === 'popup_closed' ? 'اتقفلت نافذة جوجل قبل ما تكمّل' : e.message || e.type)),
      });
      client.requestAccessToken({ prompt: store.get('gconsented', false) ? '' : 'consent' });
      store.set('gconsented', true);
    });
  }

  async function api(url, opts = {}) {
    if (!valid()) throw new AuthNeeded();
    const r = await fetch(url, { ...opts, headers: { authorization: `Bearer ${token.value}`, 'content-type': 'application/json', ...opts.headers } });
    if (r.status === 401) { token = null; store.set('gtoken', null); throw new AuthNeeded(); }
    if (!r.ok) throw new Error(`Google ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  }

  let ledger = store.get('ledger', null); // { id, entriesSheetId, layout }

  async function findOrCreate() {
    if (!ledger) { ledger = await find(); store.set('ledger', ledger); }
    // A new Ledger, or one made before this layout: dress it. A failure here must not stop the sync; the next one tries again.
    if (ledger.layout !== LAYOUT) {
      try { await applyLayout(ledger.id); ledger = { ...ledger, layout: LAYOUT }; store.set('ledger', ledger); }
      catch (e) { if (e instanceof AuthNeeded) throw e; console.warn('layout', e); }
    }
    return ledger;
  }

  async function find() {
    const q = encodeURIComponent(`appProperties has { key='${TAG.key}' and value='${TAG.value}' } and trashed=false`);
    const found = await api(`${DRIVE}?q=${q}&fields=files(id)&spaces=drive`);
    if (found.files?.length) {
      const meta = await api(`${SHEETS}/${found.files[0].id}?fields=sheets.properties`);
      const entries = meta.sheets.find(s => s.properties.title === 'Entries');
      return { id: found.files[0].id, entriesSheetId: entries.properties.sheetId };
    }
    return create();
  }

  // The Dashboard, formats, dropdowns and formulas (layout.js). Safe to run twice: it replaces what it made before.
  async function applyLayout(id) {
    const meta = await api(`${SHEETS}/${id}?fields=sheets(properties(sheetId,title),conditionalFormats,charts(chartId))`);
    const tabs = meta.sheets.map(s => ({ id: s.properties.sheetId, title: s.properties.title,
      rules: s.conditionalFormats?.length || 0, charts: (s.charts || []).map(c => c.chartId) }));
    const batch = requests => api(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
    await batch(layoutRequests(tabs));
    await api(`${SHEETS}/${id}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: layoutValues(tabs) }) });
    try { await batch(chartRequests(tabs)); } catch (e) { if (e instanceof AuthNeeded) throw e; console.warn('charts', e); }
  }

  async function create() {
    const tab = (title, frozen = 1) => ({ properties: { title, rightToLeft: true, gridProperties: { frozenRowCount: frozen } } });
    // Only the data is seeded here; the Dashboard, formulas and formats come from layout.js.
    // en_US locale keeps formula separators predictable for those formulas; the tabs are still right-to-left.
    const made = await api(SHEETS, { method: 'POST', body: JSON.stringify({
      properties: { title: 'Spent · مصاريفي', locale: 'en_US', timeZone: 'Africa/Cairo' },
      sheets: [tab('Entries'), tab('Budgets'), tab('Months'), tab('Settings', 0)],
    }) });
    const id = made.spreadsheetId;
    const entriesSheetId = made.sheets.find(s => s.properties.title === 'Entries').properties.sheetId;
    await api(`${SHEETS}/${id}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: 'Entries!A1:J1', values: [ENTRY_HEADERS] },
        { range: 'Budgets!A1:D1', values: [BUDGET_HEADERS] },
        { range: `Budgets!A2:D${DEFAULT_CATEGORIES.length + 1}`, values: DEFAULT_CATEGORIES.map(categoryToRow) },
        { range: 'Settings!A1:B3', values: [['هدف الادخار', 0], ['العملة', 'EGP'], ['سعر الدولار', '=GOOGLEFINANCE("CURRENCY:USDEGP")']] },
      ],
    }) });
    await api(`${DRIVE}/${id}`, { method: 'PATCH', body: JSON.stringify({ appProperties: { [TAG.key]: TAG.value } }) });
    return { id, entriesSheetId };
  }

  // Everything the phone mirrors, in one request. Each Entry and Budget carries its `row` for the push.
  async function read() {
    const { id } = await findOrCreate();
    const ranges = ['Budgets!A2:D', 'Entries!A2:J', 'Settings!B1:B3'].map(r => `ranges=${encodeURIComponent(r)}`).join('&');
    const res = await api(`${SHEETS}/${id}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`);
    const [b, e, s] = res.valueRanges.map(v => v.values || []);
    const usdRate = Number(s[2]?.[0]);
    return {
      categories: b.map((r, i) => { const c = rowToCategory(r); return c && { ...c, row: i + 2 }; }).filter(Boolean),
      // A row the user typed without an ID gets one from its position; a voice Correction writes that ID into the row.
      entries: e.map((r, i) => { const x = rowToEntry(r); return x && { ...x, id: x.id || `row${i + 2}`, row: i + 2 }; }).filter(Boolean),
      goal: Number(s[0]?.[0]) || 0,
      usdRate: usdRate > 1 ? usdRate : null,
    };
  }

  // Writes a sync plan (sync.js) and the Budget and Rule ops, using the row numbers from `snap`, the read just before.
  // Order matters: rewrites and appends first, then deletes from the bottom up, so no row number goes stale.
  // RAW keeps "2026-11-08" as text, so month filters and SUMIFS wildcards work regardless of locale.
  async function push(plan, ops, snap) {
    const { id, entriesSheetId } = await findOrCreate();
    const data = plan.update.map(({ row, entry }) => ({ range: `Entries!A${row}:J${row}`, values: [entryToRow(entry)] }));
    const budgets = new Map(); // one change per Category, the last one said wins
    for (const op of ops) if (op.type === 'budget') budgets.set(op.category, { ...budgets.get(op.category), ...(op.excluded ? { excluded: true } : { amount: op.amount, excluded: false }) });
    const newCategories = [];
    for (const [name, b] of budgets) {
      const c = snap.categories.find(x => x.name === name);
      if (!c) { newCategories.push(categoryToRow({ name, type: b.excluded ? 'excluded' : 'variable', budget: b.amount || 0, setAside: 0 })); continue; }
      if (b.excluded) data.push({ range: `Budgets!B${c.row}`, values: [[TYPE_AR.excluded]] });
      else data.push({ range: `Budgets!C${c.row}`, values: [[b.amount]] });
    }
    const rules = ops.filter(op => op.type === 'rule').map(op => [op.merchant, op.category]);
    if (data.length) await api(`${SHEETS}/${id}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data }) });
    if (plan.append.length) await appendRows(id, 'Entries!A:J', plan.append.map(entryToRow));
    if (newCategories.length) await appendRows(id, 'Budgets!A:D', newCategories);
    if (rules.length) await appendRules(id, rules);
    if (plan.remove.length) await api(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: plan.remove.map(({ row }) => (
      { deleteDimension: { range: { sheetId: entriesSheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row } } })) }) });
  }
  const appendRows = (id, range, values) => api(`${SHEETS}/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) });
  // The Rules tab is the hub's (hub/Code.gs). Without the hub, the app makes it on the first Rule.
  async function appendRules(id, rules) {
    try { await appendRows(id, 'Rules!A:B', rules); }
    catch (e) {
      if (!/Unable to parse range/i.test(e.message)) throw e;
      const made = await api(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [
        { addSheet: { properties: { title: 'Rules', rightToLeft: true, gridProperties: { frozenRowCount: 1 } } } }] }) });
      await appendRows(id, 'Rules!A:B', [RULE_HEADERS, ...rules]);
      await api(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: styleRules(made.replies[0].addSheet.properties.sheetId) }) });
    }
  }

  return {
    connect, read, push,
    get connected() { return valid(); },
    get url() { return ledger ? `https://docs.google.com/spreadsheets/d/${ledger.id}` : null; },
  };
}
