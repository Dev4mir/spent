// How the Ledger looks in Google Sheets: the Dashboard tab, and the formats, dropdowns and colours of the data tabs.
// Pure: it only builds Sheets API requests; sheets.js sends them. Tested by layout.test.mjs.
// The data the app and the hub read stays where it was: Entries!A:J, Budgets!A:D, Settings!B1:B3, Rules!A:B.
import { KIND_AR, TYPE_AR, SOURCE_AR, UNKNOWN, BUDGET_HEADERS } from './logic.js?v=6';

export const LAYOUT = 2; // bump to re-apply the layout to Ledgers that already exist
export const DASH = 'Dashboard';
export const DASH_ID = 770001; // our Dashboard's sheet ID, so a tab the user made is never mistaken for it
const THIS_MONTH = 'الشهر ده';

const rgb = hex => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const C = { head: rgb('#0d1715'), headInk: rgb('#eef3f1'), gold: rgb('#d9a756'), card: rgb('#f3f6f5'), line: rgb('#dfe5e3'), white: rgb('#ffffff'),
  mute: rgb('#6b7773'), ok: rgb('#188050'), warn: rgb('#b06f00'), over: rgb('#d93025'),
  income: rgb('#e6f4ea'), saving: rgb('#e8f0fe'), cashOut: rgb('#f1f3f4'), ask: rgb('#fde9b8'), goldSoft: rgb('#fbf3e2') };

// A grid range; rows and columns are 0-based and the end is exclusive. Leave an end out for "to the edge".
const R = (sheetId, r0, r1, c0, c1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
// Only the properties named are touched; inside textFormat, only the ones named there (so a tab's font survives a bold).
const fmt = (range, format) => ({ repeatCell: { range, cell: { userEnteredFormat: format },
  fields: Object.keys(format).flatMap(k => (k === 'textFormat' ? Object.keys(format[k]).map(t => `textFormat.${t}`) : [k]))
    .map(k => `userEnteredFormat.${k}`).join(',') } }); // dotted paths: Sheets refuses a(b,c) in an update mask
const num = pattern => ({ numberFormat: { type: 'NUMBER', pattern } });
const widths = (sheetId, px) => px.map((pixelSize, i) => ({ updateDimensionProperties: {
  range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize }, fields: 'pixelSize' } }));
const rowHeight = (sheetId, row, pixelSize) => ({ updateDimensionProperties: {
  range: { sheetId, dimension: 'ROWS', startIndex: row, endIndex: row + 1 }, properties: { pixelSize }, fields: 'pixelSize' } });
const hideCols = (sheetId, c0, c1) => ({ updateDimensionProperties: {
  range: { sheetId, dimension: 'COLUMNS', startIndex: c0, endIndex: c1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } });
const head = (sheetId, cols, row = 0) => [
  fmt(R(sheetId, row, row + 1, 0, cols), { backgroundColor: C.head, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
    textFormat: { bold: true, foregroundColor: C.headInk } }),
  rowHeight(sheetId, row, 34)];
const note = (sheetId, row, col, text) => ({ updateCells: { range: R(sheetId, row, row + 1, col, col + 1), rows: [{ values: [{ note: text }] }], fields: 'note' } });
const oneOf = (range, list, strict) => ({ setDataValidation: { range, rule: {
  condition: { type: 'ONE_OF_LIST', values: list.map(userEnteredValue => ({ userEnteredValue })) }, strict, showCustomUi: true } } });
const fromRange = (range, a1, strict) => ({ setDataValidation: { range, rule: {
  condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: a1 }] }, strict, showCustomUi: true } } });
const tab = (sheetId, color) => ({ updateSheetProperties: { properties: { sheetId, tabColor: color }, fields: 'tabColor' } });

// Conditional formats are numbered per tab: the lower the index, the earlier the rule wins.
function rules(range, list) {
  return list.map(([formula, format], index) => ({ addConditionalFormatRule: { index, rule: { ranges: [range],
    booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format } } } }));
}
const ink = c => ({ textFormat: { foregroundColor: c } });

// A text progress bar: ten blocks and the percentage. Plain text works in ARRAYFORMULA and in the phone app.
const bar = (spent, plan) => {
  const tenths = `ROUND(10*IF(${spent}>${plan},1,${spent}/${plan}))`;
  return `REPT("█",${tenths})&REPT("░",10-${tenths})&"  "&TEXT(${spent}/${plan},"0%")`;
};
// What a Category has to spend: a Periodic one with a Set-aside spends from that (as logic.js); the rest from the month's Budget.
const PLAN = `IF((B2:B="${TYPE_AR.periodic}")*(D2:D>0),D2:D,C2:C)`;
const MONEY = '#,##0;[Red]-#,##0;'; // zero shows as blank
const TYPE_NOTE = `${TYPE_AR.fixed}: دفعة واحدة متوقعة في الشهر (إيجار، قسط)\n${TYPE_AR.variable}: بيتصرف شوية بشوية (أكل، بنزين)\n`
  + `${TYPE_AR.periodic}: بتحوّشله كل شهر لمصروف بييجي كل فترة (ملابس، سفر)\n${TYPE_AR.excluded}: بيتسجل بس برّه الميزانيات`;

// tabs: [{ id, title, rules (how many conditional formats it has), charts: [chartId] }], as read from the spreadsheet.
// Safe to run again: it clears what it made before (the Dashboard's cells and every conditional format on our tabs).
export function layoutRequests(tabs) {
  const by = Object.fromEntries(tabs.map(t => [t.title, t]));
  const out = [];
  const reset = t => { for (let i = 0; i < (t.rules || 0); i++) out.push({ deleteConditionalFormatRule: { sheetId: t.id, index: 0 } }); };

  /* ----- Dashboard ----- */
  const dash = tabs.find(t => t.id === DASH_ID);
  const d = DASH_ID;
  if (!dash) out.push({ addSheet: { properties: { sheetId: d, title: dashTitle(tabs), index: 0, rightToLeft: true, gridProperties: { rowCount: 200, columnCount: 15 } } } });
  else {
    reset(dash);
    for (const chartId of dash.charts || []) out.push({ deleteEmbeddedObject: { objectId: chartId } });
    out.push({ unmergeCells: { range: { sheetId: d } } }, { updateCells: { range: { sheetId: d }, fields: '*' } });
  }
  out.push(
    { updateSheetProperties: { properties: { sheetId: d, index: 0, rightToLeft: true, tabColor: C.gold, gridProperties: { hideGridlines: true } },
      fields: 'index,rightToLeft,tabColor,gridProperties.hideGridlines' } },
    ...widths(d, [150, 100, 100, 100, 170, 24, 150, 90, 95, 90, 240, 24]), hideCols(d, 12, 15),
    fmt({ sheetId: d }, { verticalAlignment: 'MIDDLE', textFormat: { fontFamily: 'Cairo', fontSize: 10 } }),
    // title and the month picker
    { mergeCells: { range: R(d, 0, 1, 0, 3), mergeType: 'MERGE_ALL' } }, rowHeight(d, 0, 46),
    fmt(R(d, 0, 1, 0, 3), { textFormat: { fontSize: 20, bold: true } }),
    fmt(R(d, 0, 1, 3, 4), { horizontalAlignment: 'LEFT', textFormat: { foregroundColor: C.mute } }),
    fmt(R(d, 0, 1, 4, 5), { backgroundColor: C.goldSoft, horizontalAlignment: 'CENTER', numberFormat: { type: 'TEXT' }, textFormat: { bold: true } }),
    fromRange(R(d, 0, 1, 4, 5), `='${dashTitle(tabs)}'!$M$1:$M$60`, true),
    // the five numbers: label, value, a line under it
    fmt(R(d, 2, 5, 0, 5), { backgroundColor: C.card, horizontalAlignment: 'CENTER' }),
    fmt(R(d, 2, 3, 0, 5), { textFormat: { fontSize: 9, foregroundColor: C.mute } }),
    fmt(R(d, 3, 4, 0, 5), { ...num('#,##0'), textFormat: { fontSize: 18, bold: true } }), rowHeight(d, 3, 44),
    fmt(R(d, 4, 5, 0, 5), { textFormat: { fontSize: 9, foregroundColor: C.mute } }),
    { updateBorders: { range: R(d, 2, 5, 0, 5), innerVertical: { style: 'SOLID_THICK', color: C.white } } },
    { mergeCells: { range: R(d, 5, 6, 0, 5), mergeType: 'MERGE_ALL' } },
    fmt(R(d, 5, 6, 0, 5), { textFormat: { bold: true, foregroundColor: C.warn } }),
    // the two tables: Categories of the month (A:E), the last Entries (G:K)
    fmt(R(d, 7, 8, 0, 11), { textFormat: { fontSize: 12, bold: true } }),
    ...head(d, 5, 8),
    fmt(R(d, 8, 9, 6, 11), { backgroundColor: C.head, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', textFormat: { bold: true, foregroundColor: C.headInk } }),
    fmt(R(d, 9, undefined, 1, 4), num(MONEY)),
    fmt(R(d, 9, 19, 7, 8), num('#,##0')),
    fmt(R(d, 9, 19, 10, 11), { wrapStrategy: 'CLIP' }),
    { updateBorders: { range: R(d, 9, 19, 6, 11), innerHorizontal: { style: 'SOLID', color: C.line }, bottom: { style: 'SOLID', color: C.line } } },
    ...rules(R(d, 3, 4, 3, 4), [['=$D$4<0', ink(C.over)], ['=RIGHT($D$5,1)="✓"', ink(C.ok)]]),
    ...rules(R(d, 9, undefined, 4, 5), [
      ['=AND($D10<>"",$D10<0)', ink(C.over)],
      [`=AND($D10<>"",$O10="${TYPE_AR.variable}",$D10<=0.2*$C10)`, ink(C.warn)],
      ['=$D10<>""', ink(C.ok)]]).map((r, i) => ({ addConditionalFormatRule: { ...r.addConditionalFormatRule, index: i + 2 } })),
  );

  /* ----- Entries ----- */
  const e = by.Entries;
  if (e) {
    reset(e);
    out.push(tab(e.id, C.head), ...head(e.id, 10),
      ...widths(e.id, [100, 80, 85, 65, 95, 160, 330, 90, 105, 170]), hideCols(e.id, 7, 8), // ID is the app's, not the reader's
      fmt(R(e.id, 1, undefined, 2, 3), num('#,##0.##')), fmt(R(e.id, 1, undefined, 4, 5), { ...num('#,##0.##'), textFormat: { bold: true } }),
      fmt(R(e.id, 1, undefined, 6, 7), { wrapStrategy: 'CLIP' }),
      oneOf(R(e.id, 1, undefined, 1, 2), Object.values(KIND_AR), false),
      fromRange(R(e.id, 1, undefined, 5, 6), '=Budgets!$A$2:$A', false), // not strict: «؟» and a blank are fine
      { setBasicFilter: { filter: { range: R(e.id, 0, undefined, 0, 10) } } },
      ...rules(R(e.id, 1, undefined, 5, 6), [[`=$F2="${UNKNOWN}"`, { backgroundColor: C.ask, textFormat: { bold: true } }]]),
      ...rules(R(e.id, 1, undefined, 0, 10), [
        [`=$B2="${KIND_AR.income}"`, { backgroundColor: C.income }],
        [`=$B2="${KIND_AR.saving}"`, { backgroundColor: C.saving }],
        [`=$B2="${KIND_AR.withdrawal}"`, { backgroundColor: C.cashOut }]]).map((r, i) => ({ addConditionalFormatRule: { ...r.addConditionalFormatRule, index: i + 1 } })),
    );
  }

  /* ----- Budgets ----- */
  const b = by.Budgets;
  if (b) {
    reset(b);
    out.push(tab(b.id, C.ok), ...head(b.id, 7), ...widths(b.id, [180, 95, 135, 120, 130, 110, 180]),
      fmt(R(b.id, 1, undefined, 2, 6), num(MONEY)),
      fmt(R(b.id, 1, undefined, 4, 7), { backgroundColor: C.card }), // worked out by formulas; the user types in A:D
      oneOf(R(b.id, 1, undefined, 1, 2), Object.values(TYPE_AR), true),
      note(b.id, 0, 1, TYPE_NOTE), note(b.id, 0, 3, 'للبنود الدورية بس: اللي متحوّش للبند لحد دلوقتي'),
      ...rules(R(b.id, 1, undefined, 6, 7), [
        ['=AND($F2<>"",$F2<0)', ink(C.over)],
        [`=AND($F2<>"",$B2="${TYPE_AR.variable}",$F2<=0.2*($E2+$F2))`, ink(C.warn)],
        ['=$F2<>""', ink(C.ok)]]),
    );
  }

  /* ----- Months, Rules, Inbox, Settings ----- */
  const m = by.Months;
  if (m) out.push(tab(m.id, C.mute), ...head(m.id, 5), ...widths(m.id, [110, 120, 120, 120, 120]), fmt(R(m.id, 1, undefined, 1, 5), num(MONEY)));
  if (by.Rules) out.push(...styleRules(by.Rules.id));
  const inbox = by.Inbox;
  if (inbox) out.push(tab(inbox.id, C.warn), ...head(inbox.id, 3), ...widths(inbox.id, [135, 560, 90]), fmt(R(inbox.id, 1, undefined, 1, 2), { wrapStrategy: 'WRAP' }));
  const s = by.Settings;
  if (s) out.push(tab(s.id, C.mute), ...widths(s.id, [140, 120, 380]), fmt(R(s.id, 0, 3, 0, 1), { textFormat: { bold: true } }),
    fmt(R(s.id, 0, 3, 1, 2), { backgroundColor: C.goldSoft }), fmt(R(s.id, 0, 1, 1, 2), num('#,##0')), fmt(R(s.id, 0, 3, 2, 3), ink(C.mute)));
  return out;
}

// The Rules tab is made late (by the hub, or by the app on the first Rule), so its look is on its own too.
export const styleRules = sheetId => [tab(sheetId, C.warn), ...head(sheetId, 2), ...widths(sheetId, [220, 190])];

const dashTitle = tabs => tabs.find(t => t.id === DASH_ID)?.title || (tabs.some(t => t.title === DASH) ? 'Spent Dashboard' : DASH);

// Every formula and label the layout owns, for values:batchUpdate with USER_ENTERED. Only for tabs that exist.
// Two rules, both learned the hard way: (1) Entries is read by whole columns (Entries!E:E), because a row inserted
// under the header turns E2:E into E3:E and the first Entries drop out of every total; (2) SUMIFS does not spread over
// a list of criteria inside ARRAYFORMULA (it answers for the first one only), so each row asks through MAP.
export function layoutValues(tabs) {
  const has = t => tabs.some(x => x.title === t);
  const D = `'${dashTitle(tabs)}'!`;
  const inMonth = kind => `=SUMIFS(Entries!E:E, Entries!B:B, "${kind}", Entries!A:A, $N$1&"*")`;
  const unknown = `COUNTIFS(Entries!B:B, "${KIND_AR.expense}", Entries!F:F, "${UNKNOWN}")`;
  const thisMonth = 'TEXT(TODAY(),"yyyy-mm")&"*"';
  const data = [
    { range: `${D}A1`, values: [['مصاريفي']] },
    { range: `${D}D1:E1`, values: [['الشهر ←', THIS_MONTH]] },
    // hidden helpers: M = the month picker's list, N1 = the month shown as "2026-11", O = each listed Category's Type
    { range: `${D}M1:N2`, values: [
      [THIS_MONTH, `=IF(E1="${THIS_MONTH}", TEXT(TODAY(),"yyyy-mm"), IF(ISNUMBER(E1), TEXT(E1,"yyyy-mm"), LEFT(E1,7)))`],
      ['=ARRAYFORMULA(Months!A2:A60)', '']] },
    { range: `${D}O10`, values: [['=ARRAYFORMULA(IF(A10:A="",, IFNA(VLOOKUP(A10:A, Budgets!A:B, 2, FALSE), "")))']] },
    { range: `${D}A3:E5`, values: [
      ['الدخل', 'المصروف', 'التحويش', 'الفاضل', 'كاش معاك'],
      [inMonth(KIND_AR.income), inMonth(KIND_AR.expense), inMonth(KIND_AR.saving), '=A4-B4',
        // Cash as logic.js cashInHand: Withdrawals, less every spoken Expense since the first Withdrawal
        `=IFERROR(IF(COUNTIF(Entries!B:B, "${KIND_AR.withdrawal}")=0, "—", LET(from, INDEX(SORT(FILTER(Entries!A:A, Entries!B:B="${KIND_AR.withdrawal}")), 1), `
        + `SUMIFS(Entries!E:E, Entries!B:B, "${KIND_AR.withdrawal}") - SUMPRODUCT((Entries!B:B="${KIND_AR.expense}")*((Entries!I:I="${SOURCE_AR.voice}")+(Entries!I:I=""))*(Entries!A:A>=from), Entries!E:E))), "—")`],
      ['', '=IF(A4>0, TEXT(B4/A4,"0%")&" من الدخل", "")', '',
        '=IF(Settings!B1>0, IF(D4>=Settings!B1, "هدفك "&TEXT(Settings!B1,"#,##0")&" ✓", "أقل من هدفك بـ "&TEXT(Settings!B1-D4,"#,##0")), "")',
        '=IF(N(E4)<0, "قول «معايا كذا كاش» يتظبط", "")']] },
    { range: `${D}A6`, values: [[`=IF(${unknown}>0, "⚠ "&${unknown}&" صرفة من غير بند: افتح Spent وقول كانت إيه", "")`]] },
    { range: `${D}A8`, values: [['="بنود "&N1']] },
    { range: `${D}A9:E9`, values: [['البند', 'اتصرف', 'الميزانية', 'الفاضل', 'النسبة']] },
    // every Category with a plan or an Expense in the month, biggest first; a Category missing from Budgets (or «؟») still shows
    { range: `${D}A10`, values: [[
      `=IFNA(LET(all, {Budgets!A:A; Entries!F:F}, names, UNIQUE(FILTER(all, all<>"", all<>"${BUDGET_HEADERS[0]}")), `
      + `sp, MAP(names, LAMBDA(c, SUMIFS(Entries!E:E, Entries!F:F, c, Entries!A:A, $N$1&"*", Entries!B:B, "${KIND_AR.expense}"))), `
      + `plan, ARRAYFORMULA(IFNA(IF((VLOOKUP(names, Budgets!A:D, 2, FALSE)="${TYPE_AR.periodic}")*(VLOOKUP(names, Budgets!A:D, 4, FALSE)>0), VLOOKUP(names, Budgets!A:D, 4, FALSE), VLOOKUP(names, Budgets!A:D, 3, FALSE))+0, 0)), `
      + 'SORT(FILTER({names, sp, plan}, sp+plan>0), 2, FALSE)), "لسه مفيش صرفات")']] },
    { range: `${D}D10:E10`, values: [[
      '=ARRAYFORMULA(IF(C10:C>0, C10:C-B10:B,))',
      `=ARRAYFORMULA(IF(C10:C>0, ${bar('B10:B', 'C10:C')},))`]] },
    { range: `${D}G8`, values: [['آخر ١٠ حركات']] },
    { range: `${D}G9:K9`, values: [['البند', 'بالجنيه', 'التاريخ', 'المصدر', 'التفاصيل']] },
    // newest first; an Income, Saving or Withdrawal shows its kind where the Category would be; the Merchant beats the raw words
    { range: `${D}G10`, values: [[
      '=IFNA(ARRAYFORMULA(ARRAY_CONSTRAIN(SORT(FILTER({IF(Entries!F:F="", Entries!B:B, Entries!F:F), Entries!E:E, Entries!A:A, Entries!I:I, '
      + 'IF(Entries!J:J="", Entries!G:G, Entries!J:J), ROW(Entries!A:A)}, Entries!B:B<>"", ROW(Entries!B:B)>1), 3, FALSE, 6, FALSE), 10, 5)), "لسه مفيش حركات")']] },
  ];
  if (has('Budgets')) data.push({ range: 'Budgets!E1:G1', values: [[
    `={"اتصرف الشهر ده"; MAP(A2:A, LAMBDA(c, IF(c="",, SUMIFS(Entries!E:E, Entries!F:F, c, Entries!A:A, ${thisMonth}, Entries!B:B, "${KIND_AR.expense}"))))}`,
    `=ARRAYFORMULA({"الفاضل"; IF(A2:A="",, IF(${PLAN}>0, ${PLAN}-E2:E,))})`,
    `=ARRAYFORMULA({"النسبة"; IF(A2:A="",, IF(${PLAN}>0, ${bar('E2:E', PLAN)},))})`]] });
  if (has('Months')) {
    const of = kind => `=MAP(A2:A, LAMBDA(m, IF(m="",, SUMIFS(Entries!E:E, Entries!A:A, m&"*", Entries!B:B, "${kind}"))))`;
    data.push({ range: 'Months!A1:E1', values: [['الشهر', 'الدخل', 'المصروف', 'التحويش', 'الفاضل']] },
      { range: 'Months!A2:E2', values: [['=IFERROR(SORT(UNIQUE(FILTER(LEFT(Entries!A:A,7), Entries!A:A<>"", ROW(Entries!A:A)>1)), 1, FALSE),)',
        of(KIND_AR.income), of(KIND_AR.expense), of(KIND_AR.saving), '=ARRAYFORMULA(IF(A2:A="",, B2:B-C2:C))']] });
  }
  if (has('Settings')) data.push({ range: 'Settings!C1:C3', values: [
    ['المبلغ اللي عايزه يفضل معاك آخر كل شهر بعد كل المصاريف'], ['العملة الأساسية'], ['بيتحدّث لوحده؛ بيحوّل الصرفات اللي بالدولار للجنيه']] });
  return data;
}

// Two charts beside the tables. Sent on their own, after the rest: a chart Google refuses must not undo the layout.
export function chartRequests(tabs) {
  const months = tabs.find(t => t.title === 'Months');
  const src = (sheetId, r0, r1, c0, c1) => ({ sourceRange: { sources: [R(sheetId, r0, r1, c0, c1)] } });
  const at = rowIndex => ({ overlayPosition: { anchorCell: { sheetId: DASH_ID, rowIndex, columnIndex: 6 }, widthPixels: 665, heightPixels: 300 } });
  const out = [{ addChart: { chart: { position: at(21), spec: { title: 'المصروف حسب البند', fontName: 'Cairo',
    pieChart: { legendPosition: 'LABELED_LEGEND', pieHole: 0.55, domain: src(DASH_ID, 9, 40, 0, 1), series: src(DASH_ID, 9, 40, 1, 2) } } } } }];
  if (months) out.push({ addChart: { chart: { position: at(37), spec: { title: 'الدخل والمصروف كل شهر', fontName: 'Cairo',
    basicChart: { chartType: 'COLUMN', legendPosition: 'BOTTOM_LEGEND', headerCount: 1,
      domains: [{ domain: src(months.id, 0, 25, 0, 1), reversed: true }], // Months lists the newest first; the chart reads oldest first
      series: [{ series: src(months.id, 0, 25, 1, 2), targetAxis: 'LEFT_AXIS', color: C.ok },
        { series: src(months.id, 0, 25, 2, 3), targetAxis: 'LEFT_AXIS', color: C.gold }] } } } } });
  return out;
}
