// Spent domain logic. Pure: no DOM, no network. Terms follow GLOSSARY.md.
// A "month" is everything the Brief needs:
//   { day, days, goal, categories: [{ name, type, budget, setAside }], entries: [Entry] }
// where entries are this calendar month's Entries only.

export const PACE_FROM = 10; // note: Pace is too jumpy in the first days of a month; revisit with real data
const RANK = { ok: 0, warn: 1, over: 2 };
export const OTHER = 'أخرى';

// Category Types as written in the Budgets tab of the Ledger.
export const TYPE_AR = { fixed: 'ثابت', variable: 'متغير', periodic: 'دوري', excluded: 'مستثنى' };
export const TYPE_FROM_AR = Object.fromEntries(Object.entries(TYPE_AR).map(([k, v]) => [v, k]));
export const KIND_AR = { expense: 'صرفة', income: 'دخل', saving: 'تحويش', withdrawal: 'سحب' }; // a Withdrawal is never an Expense
// Where an Entry came from (ADR-0007). Rows written before this column existed are spoken.
export const SOURCE_AR = { voice: 'صوت', bank: 'رسالة', matched: 'صوت + رسالة' };
export const SOURCE_FROM_AR = Object.fromEntries(Object.entries(SOURCE_AR).map(([k, v]) => [v, k]));
export const KIND_FROM_AR = Object.fromEntries(Object.entries(KIND_AR).map(([k, v]) => [v, k]));

// Defaults for a new Ledger. No amounts: the user sets Budgets in the sheet.
export const DEFAULT_CATEGORIES = [
  ['البيت', 'fixed'], ['فواتير واشتراكات', 'fixed'], ['أقساط', 'fixed'], ['جمعية', 'fixed'], ['الأهل', 'fixed'],
  ['بقالة وطلبات البيت', 'variable'], ['خروجات', 'variable'], ['مواصلات', 'variable'], ['بنزين', 'variable'],
  ['كشف ودواء', 'variable'], ['مصاريفي الشخصية', 'variable'], ['الأطفال', 'variable'], ['تعليم ودروس', 'variable'],
  ['خدمات البيت', 'variable'],
  ['العربية: صيانة وترخيص', 'periodic'], ['ملابس', 'periodic'], ['هدايا ومناسبات', 'periodic'], ['أجهزة وأثاث', 'periodic'],
  ['صدقة وزكاة', 'periodic'], ['سفر ومصيف', 'periodic'],
  ['مصاريف استثنائية', 'excluded'], [OTHER, 'variable'],
].map(([name, type]) => ({ name, type, budget: 0, setAside: 0 }));

const sum = xs => xs.reduce((a, b) => a + b, 0);
export const spentIn = (m, name) => sum(m.entries.filter(e => e.kind === 'expense' && e.category === name).map(e => e.egp));
const paceOf = (m, spent) => (m.day < PACE_FROM ? 0 : Math.round(spent / m.day * m.days));
const findCat = (m, name) => m.categories.find(c => c.name === name) || { name, type: 'variable', budget: 0, setAside: 0 };

export function categoryStatus(m, c) {
  const sp = spentIn(m, c.name);
  if (c.type === 'variable') {
    if (!c.budget) return { tone: c.name === OTHER && sp ? 'warn' : 'ok', sp };
    const pace = paceOf(m, sp);
    return { tone: sp > c.budget ? 'over' : pace > c.budget ? 'warn' : 'ok', sp, pace: pace || null };
  }
  if (c.type === 'fixed') return { tone: c.budget && sp > c.budget ? 'warn' : 'ok', sp };
  if (c.type === 'periodic' && !c.budget && !c.setAside) return { tone: 'ok', sp };
  if (c.type === 'periodic') return { tone: sp > c.setAside ? 'over' : 'ok', sp, balance: c.setAside - sp };
  return { tone: 'ok', sp };
}

// Where the month is heading: income minus what every category is on course to cost.
// Unbudgeted categories count what was actually spent.
export function standing(m) {
  const income = sum(m.entries.filter(e => e.kind === 'income').map(e => e.egp));
  const saved = sum(m.entries.filter(e => e.kind === 'saving').map(e => e.egp)); // a Saving is not spending
  let spend = 0;
  const named = new Set(m.categories.map(c => c.name));
  for (const c of m.categories) {
    const sp = spentIn(m, c.name);
    if (c.type === 'fixed') spend += Math.max(c.budget, sp);
    else if (c.type === 'variable') spend += Math.max(c.budget, sp, paceOf(m, sp)); // plan is the floor
    else if (c.type === 'periodic') spend += c.budget + Math.max(0, sp - c.setAside);
    else spend += sp;
  }
  // Expenses filed under a category that isn't in Budgets (renamed or deleted in the sheet) still count.
  spend += sum(m.entries.filter(e => e.kind === 'expense' && !named.has(e.category)).map(e => e.egp));
  return { income, spend, saved, savings: income - spend, goal: m.goal };
}

// The Brief: what was saved, where its Category stands, and the month against the Savings Goal.
export function brief(m, e, before, fmt) {
  let tone = 'ok';
  const worse = t => { if (RANK[t] > RANK[tone]) tone = t; };
  const lines = [];
  if (e.kind === 'withdrawal') lines.push('سحب كاش، مش صرفة');
  if (e.kind === 'saving') lines.push(`اتحوّش الشهر ده ${fmt(standing(m).saved)} ج${m.goal ? ` من هدف ${fmt(m.goal)}` : ''}`);
  if (e.kind === 'expense') {
    const c = findCat(m, e.category);
    const st = categoryStatus(m, c), sp = st.sp;
    if (c.type === 'variable' && c.name === OTHER) {
      worse('warn'); lines.push(`ماعرفتش البند، فاتسجلت في «أخرى». قول «دي كانت …» تتعدّل`);
    } else if ((c.type === 'variable' && !c.budget) || (c.type === 'periodic' && !c.budget && !c.setAside) || (c.type === 'fixed' && !c.budget)) {
      lines.push(`${c.name}: ${fmt(sp)} ج الشهر ده`);
    } else if (c.type === 'variable') {
      worse(st.tone);
      if (st.tone === 'over') lines.push(`عدّيت ميزانية ${c.name} بـ ${fmt(sp - c.budget)} ج`);
      else if (st.tone === 'warn') lines.push(`${c.name}: ${fmt(sp)} من ${fmt(c.budget)}، وبالمعدل ده هتوصل ${fmt(st.pace)}`);
      else lines.push(`${c.name}: فاضل ${fmt(c.budget - sp)} من ${fmt(c.budget)}`);
    } else if (c.type === 'fixed') {
      worse(st.tone);
      if (sp === c.budget) lines.push(`${c.name} اتدفع ✓`);
      else if (sp < c.budget) lines.push(`${c.name}: اتدفع ${fmt(sp)} من ${fmt(c.budget)}`);
      else lines.push(`${c.name}: أكتر من المتوقع بـ ${fmt(sp - c.budget)} ج`);
    } else if (c.type === 'periodic') {
      worse(st.tone);
      if (st.balance >= 0) lines.push(`من تحويش ${c.name}، فاضل فيه ${fmt(st.balance)} ج`);
      else lines.push(`تحويش ${c.name} خلص، والزيادة ${fmt(-st.balance)} ج من مصروف الشهر`);
    } else lines.push(`${c.name}: برّه الميزانيات`);
  }
  const after = standing(m);
  if (after.income && m.goal) {
    const extra = before.savings - after.savings;
    if (e.kind === 'expense' && extra > e.egp) lines.push(`بالمعدل ده الصرفة دي بتكلّفك ${fmt(extra)} ج على الشهر`);
    if (after.savings >= after.goal) lines.push(`ماشي على توفير ${fmt(after.savings)} ج ✓`);
    else if (after.savings >= 0) { worse('warn'); lines.push(`هتوفّر ${fmt(after.savings)} ج بس، أقل من هدفك بـ ${fmt(after.goal - after.savings)}`); }
    else { worse('over'); lines.push(`ماشي على عجز ${fmt(-after.savings)} ج الشهر ده`); }
  }
  return { tone, lines };
}

// Turns Claude's parsed JSON into an Entry. `today` is a Date; the month model comes from the Ledger.
export function toEntry(j, transcript, today, usdRate, id) {
  if (!j || !(j.amount > 0)) return null;
  const d = new Date(today); d.setDate(d.getDate() - Math.max(0, Math.min(7, j.days_ago || 0)));
  return {
    id, date: isoDate(d), kind: j.kind, amount: j.amount, currency: j.currency,
    egp: j.currency === 'USD' ? Math.round(j.amount * usdRate) : j.amount,
    category: j.kind === 'expense' ? j.category : '', said: j.understood || transcript, status: 'pending', source: 'voice', merchant: '',
  };
}

export const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const monthKey = d => isoDate(d).slice(0, 7);

// Ledger rows <-> Entries. Entries tab columns: التاريخ | النوع | المبلغ | العملة | بالجنيه | البند | اللي اتقال | ID | المصدر | التاجر
// The hub (hub/Code.gs) writes the same columns for Bank Messages.
export const ENTRY_HEADERS = ['التاريخ', 'النوع', 'المبلغ', 'العملة', 'بالجنيه', 'البند', 'اللي اتقال', 'ID', 'المصدر', 'التاجر'];
export const entryToRow = e => [e.date, KIND_AR[e.kind], e.amount, e.currency, e.egp, e.category, e.said, e.id, SOURCE_AR[e.source || 'voice'], e.merchant || ''];
// A date the user typed in the Sheet is read back as a serial day number (days from 1899-12-30); the app writes text.
const sheetDate = v => (typeof v === 'number' ? new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10) : String(v).slice(0, 10));
export function rowToEntry(r) {
  const kind = KIND_FROM_AR[r[1]];
  const amount = Number(r[2]), egp = Number(r[4]);
  if (!kind || !(amount > 0)) return null;
  return { date: sheetDate(r[0]), kind, amount, currency: r[3] || 'EGP', egp: egp > 0 ? egp : amount, category: r[5] || '', said: r[6] || '', id: r[7] || '', status: 'saved',
    source: SOURCE_FROM_AR[r[8]] || 'voice', merchant: r[9] || '' };
}

// Match (ADR-0007): a spoken Expense or Withdrawal and the Bank Message for it: same kind, same amount in EGP,
// dates at most a day apart, neither matched yet. The closest date wins.
const dayNo = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
function closest(entries, e, source) {
  if (e.kind !== 'expense' && e.kind !== 'withdrawal') return null;
  let best = null, bestGap = 2;
  for (const x of entries) {
    if (x.kind !== e.kind || (x.source || 'voice') !== source || Math.abs(x.egp - e.egp) >= 1) continue;
    const gap = Math.abs(dayNo(x.date) - dayNo(e.date));
    if (gap <= bestGap && gap <= 1) { best = x; bestGap = gap; }
  }
  return best;
}
export const findBankMatch = (entries, spoken) => closest(entries, spoken, 'bank'); // the user speaks after the SMS
export const findVoiceMatch = (entries, bank) => closest(entries, bank, 'voice'); // the SMS arrives after the user spoke
// One Entry from both: the bank's ID, date, amount and Merchant; the user's Category and words.
export const matchInto = (bank, spoken) => ({ ...spoken, id: bank.id, date: bank.date, amount: bank.amount, currency: bank.currency,
  egp: bank.egp, merchant: bank.merchant, source: 'matched' });
// Budgets tab columns: البند | النوع | الميزانية الشهرية | رصيد التحويش
export const BUDGET_HEADERS = ['البند', 'النوع', 'الميزانية الشهرية', 'رصيد التحويش'];
export const RULE_HEADERS = ['التاجر فيه', 'البند']; // Rules tab, the same as the hub's
export const categoryToRow = c => [c.name, TYPE_AR[c.type], c.budget || '', c.type === 'periodic' ? (c.setAside || '') : ''];
export function rowToCategory(r) {
  const name = String(r[0] || '').trim();
  if (!name) return null;
  return { name, type: TYPE_FROM_AR[String(r[1] || '').trim()] || 'variable', budget: Number(r[2]) || 0, setAside: Number(r[3]) || 0 };
}

// Builds the month model from Ledger data plus any Entries still waiting on the phone.
export function monthModel({ categories, entries, goal }, today) {
  const key = monthKey(today);
  const days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  return { day: today.getDate(), days, goal: goal || 0, categories, entries: entries.filter(e => e.date.startsWith(key)) };
}

/* ---------- phase 2: Cash, Rules, Questions and the orb's own questions ---------- */

export const UNKNOWN = '؟'; // the Category of a Bank Message whose Merchant has no Rule yet
export const PERSONAL = 'مصاريفي الشخصية'; // where Unaccounted Cash goes
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// The longest Rule whose text appears in the Merchant wins (same as the hub's categoryFor).
export function categoryFor(merchant, rules) {
  const up = String(merchant || '').toUpperCase();
  let best = null;
  for (const [k, cat] of rules) {
    const key = String(k || '').trim().toUpperCase();
    if (key && cat && up.includes(key) && (!best || key.length > best.key.length)) best = { key, cat: String(cat).trim() };
  }
  return best?.cat || null;
}

// Cash: Withdrawals add to it; every spoken Expense with no Bank Message behind it is paid from it.
// Counting starts at the first Withdrawal, so Expenses from before the user tracked Cash don't push it below zero.
// null: no Withdrawal yet, so Cash isn't tracked.
export function cashInHand(entries) {
  const w = entries.filter(e => e.kind === 'withdrawal');
  if (!w.length) return null;
  const from = w.reduce((a, e) => (e.date < a ? e.date : a), w[0].date);
  const paidCash = entries.filter(e => e.kind === 'expense' && (e.source || 'voice') === 'voice' && e.date >= from);
  return sum(w.map(e => e.egp)) - sum(paidCash.map(e => e.egp));
}

// Cash Count: the user says how much Cash they hold. Less than the app thinks: the gap is Unaccounted Cash, an
// Expense in مصاريفي الشخصية. More: the extra is added as a Withdrawal (cash the app never saw come in).
export function cashCountEntry(entries, have, today, id, categories) {
  const gap = Math.round((cashInHand(entries) ?? 0) - have);
  if (Math.abs(gap) < 1) return null;
  const base = { id, date: isoDate(today), amount: Math.abs(gap), currency: 'EGP', egp: Math.abs(gap), source: 'voice', merchant: '' };
  if (gap > 0) return { ...base, kind: 'expense', category: categories.some(c => c.name === PERSONAL) ? PERSONAL : OTHER, said: 'كاش مش متسجل' };
  return { ...base, kind: 'withdrawal', category: '', said: 'كاش كان معايا' };
}

// A Correction to one Entry. j: { amount (0 = same), category ('' = same), days_ago (-1 = same) }.
export function corrected(e, j, today, usdRate) {
  const out = { ...e };
  if (j.amount > 0) { out.amount = j.amount; out.egp = e.currency === 'USD' ? Math.round(j.amount * usdRate) : j.amount; }
  if (j.category && e.kind === 'expense') out.category = j.category;
  if (j.days_ago >= 0) out.date = isoDate(addDays(today, -Math.min(7, j.days_ago)));
  return out;
}

const PERIOD_AR = { today: 'النهارده', yesterday: 'امبارح', week: 'آخر ٧ أيام', month: 'الشهر ده', last_month: 'الشهر اللي فات' };
function periodRange(period, today) {
  const t = isoDate(today);
  if (period === 'today') return [t, t];
  if (period === 'yesterday') { const y = isoDate(addDays(today, -1)); return [y, y]; }
  if (period === 'week') return [isoDate(addDays(today, -6)), t];
  if (period === 'last_month') { const p = new Date(today.getFullYear(), today.getMonth(), 0); return [monthKey(p) + '-01', isoDate(p)]; }
  return [monthKey(today) + '-01', t];
}

// A Question, answered on the phone from the Entries. q: { about, period, category }.
// Returns what the orb shows: { egp (the big number, or null), label, line, tone }.
export function answer({ categories, entries, goal }, q, today, fmt) {
  const [from, to] = periodRange(q.period, today);
  const inPeriod = entries.filter(e => e.date >= from && e.date <= to);
  const total = kind => sum(inPeriod.filter(e => e.kind === kind && (kind !== 'expense' || !q.category || e.category === q.category)).map(e => e.egp));
  const when = PERIOD_AR[q.period] || PERIOD_AR.month;
  const thisMonth = !q.period || q.period === 'month';
  const m = monthModel({ categories, entries, goal }, today);
  if (q.about === 'cash') {
    const cash = cashInHand(entries);
    return cash == null ? { egp: null, label: 'الكاش', line: 'مفيش سحب متسجل؛ قول «معايا كذا كاش»', tone: 'ok' }
      : { egp: cash, label: 'كاش معاك', line: cash < 0 ? 'صرفت كاش أكتر من اللي سحبته؛ قول «معايا كذا كاش» يتظبط' : '', tone: cash < 0 ? 'warn' : 'ok' };
  }
  if (q.about === 'income') return { egp: total('income'), label: `الدخل · ${when}`, line: '', tone: 'ok' };
  if (q.about === 'saved') return { egp: total('saving'), label: `التحويش · ${when}`, line: '', tone: 'ok' };
  if (q.category && (q.about === 'left' || q.about === 'spent')) {
    const c = findCat(m, q.category), st = categoryStatus(m, c), plan = c.type === 'periodic' ? c.setAside : c.budget;
    if (q.about === 'spent' || !plan) {
      return { egp: total('expense'), label: `${q.category} · ${when}`, tone: thisMonth ? st.tone : 'ok',
        line: !plan ? 'مالوش ميزانية' : thisMonth ? `من ${fmt(plan)}` : '' };
    }
    const left = plan - st.sp;
    return { egp: left, label: left >= 0 ? `فاضل في ${q.category}` : `عدّيت ${q.category}`, line: `من ${fmt(plan)} الشهر ده`, tone: st.tone };
  }
  if (q.about === 'spent') return { egp: total('expense'), label: `المصروف · ${when}`, line: '', tone: 'ok' };
  // "left" with no Category, or "month": where the month is heading
  const s = standing(m);
  if (!s.income) return { egp: sum(m.entries.filter(e => e.kind === 'expense').map(e => e.egp)), label: 'صرفت الشهر ده', line: 'مفيش دخل متسجل الشهر ده', tone: 'ok' };
  const tone = s.savings < 0 ? 'over' : goal && s.savings < goal ? 'warn' : 'ok';
  return { egp: s.savings, label: s.savings >= 0 ? 'هتوفّر الشهر ده' : 'عجز الشهر ده', tone,
    line: goal ? (s.savings >= goal ? `هدفك ${fmt(goal)} ✓` : `أقل من هدفك بـ ${fmt(goal - s.savings)}`) : '' };
}

// What the orb asks next, if anything: first a Merchant with no Rule, then a Category with no Budget that has
// Expenses this month. `skipped` holds the asks the user passed over in this session (closing the app resets it).
export function nextAsk({ categories, entries }, today, skipped) {
  const unknown = entries.find(e => e.kind === 'expense' && e.category === UNKNOWN && e.merchant && !skipped.has('m:' + e.merchant.toUpperCase()));
  if (unknown) return { type: 'merchant', key: 'm:' + unknown.merchant.toUpperCase(), merchant: unknown.merchant, egp: unknown.egp };
  const key = monthKey(today), seen = new Set();
  for (const e of entries) {
    if (e.kind !== 'expense' || !e.date.startsWith(key) || seen.has(e.category)) continue;
    seen.add(e.category);
    const c = categories.find(x => x.name === e.category);
    if (!c || c.type === 'excluded' || c.name === OTHER || c.budget || c.setAside || skipped.has('b:' + c.name)) continue;
    return { type: 'budget', key: 'b:' + c.name, category: c.name };
  }
  return null;
}
export const askText = (a, fmt) => a.type === 'merchant'
  ? `«${a.merchant}» بـ ${fmt(a.egp)} ج: دي كانت إيه؟`
  : `${a.category} مالوش ميزانية. كام في الشهر؟ أو قول «تجاهل»`;
