// Spent: tap, speak, Brief back. The phone holds every Entry and the Google Sheet mirrors it (ADR-0005).
// Bump ?v= in every import (and in index.html) on each release: iOS Safari caches modules hard.
import { createSpeech } from './speech.js?v=5';
import { createUnderstanding, Anthropic, FAST } from './claude.js?v=5';
import { createLedgerClient, AuthNeeded } from './sheets.js?v=5';
import { reconcile, settle, applyOps } from './sync.js?v=5';
import { monthModel, standing, brief, toEntry, isoDate, findBankMatch, matchInto, categoryFor, cashInHand, cashCountEntry, corrected,
  answer, nextAsk, askText, KIND_AR, UNKNOWN, DEFAULT_CATEGORIES } from './logic.js?v=5';
import { GOOGLE_CLIENT_ID } from './config.js?v=5';

const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString('ar-EG');
const store = {
  get(k, d) { try { const v = localStorage.getItem('spent:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spent:' + k, JSON.stringify(v)); } catch {} },
};
const UNDO_MS = 8000, USD_FALLBACK = 50, SYNC_DELAY_MS = 1500;

let settings = store.get('settings', { key: '', model: FAST });
if (!store.get('haikuDefault', false)) { // once: the old default was Opus; Haiku with a Sonnet retry is the new one (roadmap phase 1)
  if (settings.model === 'claude-opus-5-5') { settings = { ...settings, model: FAST }; store.set('settings', settings); }
  store.set('haikuDefault', true);
}

/* ---------- the phone's own store (ADR-0005) ---------- */
// db:   { entries, dirty, gone, ops, last }: see sync.js; `last` is the ID a Correction applies to.
// meta: { categories, goal, usdRate }: the Sheet's, with the phone's pending ops applied.
let db = store.get('db', null), meta = store.get('meta', null);
if (!db) { // first start on phase 2: carry over the phase 1 cache and queue
  const cache = store.get('ledgerCache', null), queue = store.get('queue', []);
  const clean = ({ row, original, status, ...e }) => ({ source: 'voice', merchant: '', ...e });
  const byId = new Map((cache?.entries || []).filter(e => e.id).map(e => [e.id, { ...clean(e), synced: true }]));
  for (const q of queue) byId.set(q.id, { ...clean(q), synced: byId.get(q.id)?.synced || false });
  db = { entries: [...byId.values()], dirty: queue.map(q => q.id), gone: [], ops: [], last: null };
  meta = { categories: cache?.categories?.length ? cache.categories : DEFAULT_CATEGORIES, goal: cache?.goal || 0, usdRate: cache?.usdRate || null };
}
meta ||= { categories: DEFAULT_CATEGORIES, goal: 0, usdRate: null };
const save = () => { store.set('db', db); store.set('meta', meta); };
save();

const byId = id => db.entries.find(e => e.id === id) || null;
const without = (xs, x) => xs.filter(y => y !== x);
// Every change goes through here as [id, Entry | null]. Returns the list that reverses it, for Undo.
function change(list) {
  const undo = list.map(([id]) => [id, byId(id)]);
  for (const [id, after] of list) {
    const old = byId(id);
    if (after) {
      const rec = { ...after, synced: old ? old.synced : !!after.synced };
      db.entries = old ? db.entries.map(e => (e.id === id ? rec : e)) : [...db.entries, rec];
      db.dirty = [...without(db.dirty, id), id]; db.gone = without(db.gone, id);
    } else if (old) {
      db.entries = db.entries.filter(e => e.id !== id);
      db.dirty = without(db.dirty, id);
      if (old.synced) db.gone = [...without(db.gone, id), id];
    }
  }
  save(); scheduleSync();
  return undo;
}
function addOp(op) { db.ops = [...db.ops, op]; meta = applyOps(meta, [op]); save(); scheduleSync(); }

let phase = 'idle', settled = false, shown = null; // shown: what the result screen holds
const skipped = new Set(); // asks passed over in this session; closing the app asks again
const timers = {};

const ledger = createLedgerClient({ clientId: GOOGLE_CLIENT_ID, store });
const understand = createUnderstanding({ getKey: () => settings.key, getModel: () => settings.model });
const speech = createSpeech({ onInterim: t => t && setStatus(`«${t}»`, { heard: true, quiet: true }) });

const book = () => ({ categories: meta.categories, entries: db.entries, goal: meta.goal });
const model = () => monthModel(book(), new Date());
const rate = () => meta.usdRate || USD_FALLBACK;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const currentAsk = () => (settings.key ? nextAsk(book(), new Date(), skipped) : null);
function describe(e) { // the last Entry in words, so Claude can read "خليها ٣٠٠"
  return `${KIND_AR[e.kind]} ${e.amount} ${e.currency}${e.category ? ` في ${e.category}` : ''} يوم ${e.date}${e.merchant ? ` (${e.merchant})` : ''}`;
}

/* ---------- the one tap ---------- */
async function tap() {
  if (phase === 'thinking') return;
  if (!settings.key) return openSheet();
  if (phase === 'listening') return speech.stop();
  if (!speech.supported) return startTyping();
  phase = 'listening'; settled = false; shown = null;
  setStatus('بسمعك… اضغط تاني لما تخلص'); say('بسمعك'); paint();
  const heard = await speech.listen();
  if (heard.error) {
    const why = { 'not-allowed': 'اسمح بالميكروفون من إعدادات المتصفح', 'no-speech': 'ماسمعتش حاجة، جرّب تاني', network: 'التعرّف على الكلام محتاج نت', stuck: 'الميكروفون علّق، اضغط تاني' }[heard.error] || `مشكلة في الميكروفون: ${heard.error}`;
    return showError('ماسمعتش', why);
  }
  await handle(heard.text, heard.alts);
}

function startTyping() { // fallback when the browser has no speech recognition: the keyboard's own 🎤 still works
  phase = 'typing'; paint();
  $('typed').value = ''; $('typed').focus();
}
$('typedForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const t = $('typed').value.trim(); $('typed').blur();
  if (!t) { phase = 'idle'; return paint(); }
  handle(t, []);
});
$('typed').addEventListener('blur', () => { if (phase === 'typing' && !$('typed').value.trim()) { phase = 'idle'; paint(); } });

async function handle(text, alts) {
  phase = 'thinking'; setStatus(`«${text}»`, { heard: true }); paint();
  const ask = currentAsk(), last = byId(db.last);
  let j;
  try { j = await understand(text, alts, { categories: meta.categories, ask: ask && askText(ask, fmt), last: last && describe(last) }); }
  catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return showError('مفتاح Claude مش شغال', 'راجعه من الإعدادات');
    if (e instanceof Anthropic.RateLimitError) return showError('Claude مشغول', 'استنى شوية وجرّب تاني');
    if (e instanceof Anthropic.APIConnectionError) return showError('مفيش نت', 'Claude محتاج نت يفهم الجملة؛ قولها تاني بعدين');
    return showError('Claude ماردّش', e.message || String(e));
  }
  if (ask && j.intent !== 'answer') skipped.add(ask.key); // they moved on: ask the next thing, and this one again next time
  try {
    if (j.intent === 'answer' && ask) return answerAsk(ask, j, text);
    if (j.intent === 'correction') return correct(j, text);
    if (j.intent === 'question') return ask_(j, text);
    if (j.intent === 'cash_count') return countCash(j, text);
    return addEntry(j, text);
  } catch (e) { showError('حصلت مشكلة', e.message || String(e)); }
}

function addEntry(j, text) {
  let entry = toEntry(j, text, new Date(), rate(), newId());
  if (!entry) return showError('مسمعتش مبلغ', `«${text}» · قولها تاني ومعاها الرقم`);
  // Match: the bank's SMS for this purchase is already here. One Entry, not two (ADR-0007).
  const twin = findBankMatch(db.entries, entry);
  if (twin) entry = matchInto(twin, entry);
  const before = standing(model());
  const undo = change([[entry.id, entry]]);
  db.last = entry.id; save();
  const b = brief(model(), entry, before, fmt);
  if (entry.kind === 'withdrawal') b.lines = [`كاش معاك: ${fmt(cashInHand(db.entries))} ج`];
  const a = currentAsk();
  if (a?.type === 'budget' && a.category === entry.category) b.lines = [askText(a, fmt)]; // the orb asks right away
  showEntry(entry, b, undo);
  say([entry.currency === 'USD' ? `${fmt(entry.amount)} دولار` : `${fmt(entry.egp)} جنيه`, entry.kind === 'expense' ? entry.category : labelOf(entry), b.lines[0]].filter(Boolean).join('، '));
}

function correct(j, text) {
  const e = byId(db.last);
  if (!e) return showError('مفيش حاجة أعدّلها', 'التعديل بيكون على آخر حاجة اتسجلت');
  if (j.delete) {
    const undo = change([[e.id, null]]);
    db.last = null; save();
    return show({ amt: amtOf(e), label: `اتمسحت · ${labelOf(e)}`, line: '', heard: text, tone: 'ok', undo }, 'اتمسحت');
  }
  const after = corrected(e, j, new Date(), rate());
  if (JSON.stringify(after) === JSON.stringify(e)) return showError('ماعرفتش أعدّل إيه', `«${text}»`);
  const before = standing(model());
  const list = [[e.id, after]];
  // A new Category for a bank Merchant teaches a Rule: the next charge there is filed by itself.
  if (e.merchant && after.category !== e.category && after.kind === 'expense') list.push(...learnRule(e.merchant, after.category, e.id));
  const undo = change(list);
  const b = brief(model(), after, before, fmt);
  showEntry(after, { ...b, lines: [b.lines[0] ? `اتعدّلت · ${b.lines[0]}` : 'اتعدّلت'] }, undo);
  say('اتعدّلت');
}

// The Rule goes to the Sheet (the hub files the next charges); the «؟» Expenses already here are filed now.
function learnRule(merchant, category, except) {
  addOp({ type: 'rule', merchant, category });
  return db.entries.filter(x => x.id !== except && x.kind === 'expense' && x.category === UNKNOWN && categoryFor(x.merchant, [[merchant, category]]))
    .map(x => [x.id, { ...x, category }]);
}

function ask_(j, text) { // a Question: answered on the phone, nothing is saved
  const a = answer(book(), { about: j.about || 'month', period: j.period, category: j.category }, new Date(), fmt);
  show({ amt: a.egp == null ? '' : `${fmt(a.egp)}<small>ج</small>`, label: a.label, line: a.line, heard: text, tone: a.tone }, [a.egp == null ? '' : `${fmt(a.egp)} جنيه`, a.label, a.line].filter(Boolean).join('، '));
}

function countCash(j, text) {
  const entry = cashCountEntry(db.entries, Math.max(0, j.amount), new Date(), newId(), meta.categories);
  if (!entry) return show({ amt: `${fmt(j.amount)}<small>ج</small>`, label: 'كاش معاك', line: 'مظبوط ✓', heard: text, tone: 'ok' }, 'مظبوط');
  const undo = change([[entry.id, entry]]);
  db.last = entry.id; save();
  const line = `معاك ${fmt(j.amount)} ج كاش دلوقتي`;
  show({ amt: `${fmt(entry.egp)}<small>ج</small>`, label: entry.kind === 'expense' ? `${entry.category} · كاش مش متسجل` : 'كاش زيادة', line, heard: text, tone: 'ok', undo }, line);
}

function answerAsk(a, j, text) {
  if (a.type === 'budget') {
    if (j.ignore) {
      addOp({ type: 'budget', category: a.category, excluded: true });
      return show({ amt: '', label: a.category, line: 'مش هيتحسب في الميزانيات', heard: text, tone: 'ok' }, 'تمام');
    }
    if (!(j.amount > 0)) { skipped.add(a.key); return showError('مسمعتش رقم', 'هسألك تاني بعدين'); }
    addOp({ type: 'budget', category: a.category, amount: j.amount });
    const left = answer(book(), { about: 'left', period: 'month', category: a.category }, new Date(), fmt);
    return show({ amt: `${fmt(j.amount)}<small>ج</small>`, label: `ميزانية ${a.category} في الشهر`, line: `${left.label}: ${fmt(left.egp)}`, heard: text, tone: left.tone }, `ميزانية ${a.category} ${fmt(j.amount)}`);
  }
  if (j.ignore || !j.category) { skipped.add(a.key); return show({ amt: '', label: a.merchant, line: 'تمام، هسألك بعدين', heard: text, tone: 'ok' }, 'تمام'); }
  change(learnRule(a.merchant, j.category));
  show({ amt: `${fmt(a.egp)}<small>ج</small>`, label: `${a.merchant} → ${j.category}`, line: 'وهتتسجل كده على طول', heard: text, tone: 'ok' }, `${a.merchant}، ${j.category}`);
}

async function undo() {
  if (!shown?.undo || !timers.undo) return;
  clearTimeout(timers.undo); timers.undo = null;
  change(shown.undo);
  shown = null; phase = 'idle'; paint(); setStatus('اتلغت · اضغط واتكلم'); say('اتلغت');
}

/* ---------- sync with the Ledger (sync.js) ---------- */
let syncing = null, again = false;
function scheduleSync() { clearTimeout(timers.sync); timers.sync = setTimeout(sync, SYNC_DELAY_MS); paintPending(); }
function sync() {
  if (syncing) { again = true; return syncing; }
  syncing = doSync().finally(() => { syncing = null; paintPending(); if (phase === 'idle') paint(); if (again) { again = false; sync(); } });
  return syncing;
}
async function doSync() {
  if (!ledger.connected) return;
  try {
    const snap = await ledger.read();
    // From here to the push nothing awaits, so a tap can't change db between the read and the plan.
    const r = reconcile(db, snap.entries);
    db = { ...db, entries: r.entries, dirty: r.dirty, gone: r.gone };
    if (r.renamed[db.last]) db.last = r.renamed[db.last];
    if (shown?.undo?.some(([id]) => r.renamed[id])) shown.undo = null; // the Entry it would restore was just matched
    const ops = db.ops;
    meta = applyOps({ categories: snap.categories.length ? snap.categories : DEFAULT_CATEGORIES, goal: snap.goal, usdRate: snap.usdRate || meta.usdRate }, ops);
    save();
    const p = r.plan;
    if (p.update.length || p.append.length || p.remove.length || ops.length) {
      await ledger.push(p, ops, snap);
      db = settle(db, p, ops.length); save();
    }
    $('openSheet').href = ledger.url; $('openSheet').hidden = !ledger.url;
  } catch (e) {
    if (!(e instanceof AuthNeeded)) { console.warn('sync', e); $('googleMsg').textContent = e.message; } // stays pending; retried on the next change or open
  }
}
async function connectGoogle() { // only from a tap
  if (!GOOGLE_CLIENT_ID) { $('googleMsg').textContent = 'محتاج Google Client ID في config.js'; return; }
  $('googleMsg').textContent = 'بيفتح جوجل…';
  try { await ledger.connect(); $('googleMsg').textContent = 'بيجهّز الشيت…'; await sync(); $('googleMsg').textContent = 'متوصّل ✓'; }
  catch (e) { $('googleMsg').textContent = e.message; }
  paintSetup(); paintPending();
}

/* ---------- screen ---------- */
const labelOf = e => (e.kind === 'expense' ? e.category : { income: 'دخل', saving: 'تحويش', withdrawal: 'سحب كاش' }[e.kind]);
const amtOf = e => (e.currency === 'USD' ? `$${fmt(e.amount)}` : `${fmt(e.egp)}<small>ج</small>`);
function showEntry(e, b, undo) {
  const when = e.date === isoDate(new Date()) ? '' : ` · ${e.date.slice(5).split('-').reverse().join('/')}`;
  show({ amt: amtOf(e), label: labelOf(e) + (e.merchant ? ` · ${e.merchant}` : '') + when, line: b.lines[0] || '', heard: e.said, tone: b.tone, undo }, null);
}
// The result screen: a big number, a label, one line, the words heard, and Undo while it lasts.
function show(s, spoken) {
  shown = s; phase = 'result'; settled = false; buzz(s.tone);
  if (spoken) say(spoken);
  clearTimeout(timers.undo); timers.undo = s.undo ? setTimeout(() => { timers.undo = null; paint(); }, UNDO_MS) : null;
  clearTimeout(timers.settle); timers.settle = setTimeout(() => { settled = true; paint(); }, 2800);
  paint();
}
function showError(title, why) { shown = null; show({ amt: '', label: title, line: why, heard: '', tone: 'over' }, null); shout(`${title}. ${why}`); }
const calm = matchMedia('(prefers-reduced-motion: reduce)');
function setStatus(t, { heard = false, quiet = false } = {}) { // quiet: interim words update in place, no fade per word
  const el = $('status');
  el.toggleAttribute('data-heard', heard);
  if (el.textContent === t) return;
  el.textContent = t;
  if (!quiet && el.classList.contains('on')) el.animate(
    calm.matches ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, translate: '0 6px', filter: 'blur(4px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0)' }],
    { duration: calm.matches ? 150 : 380, easing: 'cubic-bezier(.22,1,.36,1)' });
}
// Screen readers: one polite region for the Brief, one alert region for failures. Clear first so a repeat still speaks.
function announce(id, text) { const el = $(id); el.textContent = ''; setTimeout(() => { el.textContent = text; }, 60); }
const say = t => announce('say', t), shout = t => announce('shout', t);
function buzz(tone) { try { navigator.vibrate?.(tone === 'over' ? [80, 60, 80, 60, 220] : tone === 'warn' ? [60, 60, 60] : 40); } catch {} }
function readyStatus() {
  const a = currentAsk();
  setStatus(!settings.key ? 'اضغط عشان تبدأ' : a ? askText(a, fmt) : speech.supported ? 'اضغط واتكلم' : 'اضغط واكتب، أو 🎤 في الكيبورد', { heard: !!a });
}

function paint() {
  const scr = $('screen');
  scr.dataset.phase = phase;
  scr.toggleAttribute('data-settled', settled);
  const canUndo = phase === 'result' && !!timers.undo && !!shown?.undo;
  scr.toggleAttribute('data-undo', canUndo);
  const show_ = (id, on) => $(id).classList.toggle('on', on);
  show_('status', ['idle', 'listening', 'thinking'].includes(phase));
  show_('typedForm', phase === 'typing');
  const orb = $('orb');
  orb.setAttribute('aria-label', phase === 'listening' ? 'خلصت، وقّف التسجيل' : phase === 'thinking' ? 'بيفهم…' : 'اضغط واتكلم');
  if (phase === 'thinking') orb.setAttribute('aria-disabled', 'true'); else orb.removeAttribute('aria-disabled');
  const res = phase === 'result' && !!shown;
  if (res) {
    scr.dataset.tone = shown.tone;
    $('amt').innerHTML = shown.amt || '';
    $('label').textContent = shown.label || '';
    $('line').textContent = shown.line || '';
    $('heard').textContent = shown.heard ? `«${shown.heard}»` : '';
  } else delete scr.dataset.tone;
  // the result group and each line fade together (a visible child would show through a hidden parent)
  show_('result', res);
  for (const id of ['amt', 'label', 'line', 'heard']) show_(id, res && !!$(id).textContent);
  show_('undo', res && canUndo);
  if (phase === 'idle') readyStatus();
  paintPending();
}
function paintPending() {
  const n = db.dirty.length + db.gone.length + db.ops.length;
  $('pending').hidden = !n;
  $('pending').textContent = fmt(n);
  $('pending').setAttribute('aria-label', `${fmt(n)} تغييرات لسه ماوصلتش الشيت. ${ledger.connected ? 'اضغط عشان تبعتها' : 'اضغط عشان تربط جوجل'}`);
}
function paintSetup() {
  $('stepClaude').toggleAttribute('data-done', !!settings.key);
  $('stepGoogle').toggleAttribute('data-done', ledger.connected);
  $('claudeDone').hidden = !settings.key; $('googleDone').hidden = !ledger.connected;
  $('connect').textContent = ledger.connected ? 'اتصل تاني' : 'اربط جوجل';
}
function openSheet() {
  $('key').value = settings.key; $('model').value = settings.model;
  paintSetup();
  const d = $('sheet');
  d.removeAttribute('data-closing');
  if (!d.open) d.showModal();
}
// Safari has no `overlay` transition, so a native close would cut the slide-down. Play the exit first, then close.
let canTransitionDisplay;
function supportsTopLayerExit() {
  if (canTransitionDisplay === undefined) {
    canTransitionDisplay = false;
    if (window.CSS?.supports?.('transition-behavior', 'allow-discrete')) {
      const probe = document.createElement('div');
      probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
      document.body.appendChild(probe); getComputedStyle(probe).display;
      probe.style.display = 'none'; canTransitionDisplay = getComputedStyle(probe).display === 'block'; probe.remove();
    }
  }
  return window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay;
}
async function closeSheet() {
  const d = $('sheet');
  if (!d.open) return;
  if (!supportsTopLayerExit()) {
    d.setAttribute('data-closing', '');
    const anims = d.getAnimations({ subtree: true });
    if (anims.length) await Promise.race([Promise.allSettled(anims.map(a => a.finished)), new Promise(r => setTimeout(r, 1000))]);
    if (!d.hasAttribute('data-closing')) return; // reopened meanwhile
    d.removeAttribute('data-closing');
  }
  d.close();
}

$('orb').addEventListener('click', tap);
$('undo').addEventListener('click', undo);
$('gear').addEventListener('click', openSheet);
$('closeSheet').addEventListener('click', closeSheet);
$('sheet').addEventListener('cancel', ev => { ev.preventDefault(); closeSheet(); }); // Esc and the back gesture animate too
if (!('closedBy' in HTMLDialogElement.prototype)) { // tap outside to close where `closedby` isn't supported (Safari)
  const d = $('sheet'); let downOutside = false;
  const outside = e => { const r = d.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  d.addEventListener('pointerdown', e => { downOutside = outside(e); });
  d.addEventListener('pointerup', e => { if (downOutside && outside(e)) closeSheet(); });
}
$('connect').addEventListener('click', connectGoogle);
$('pending').addEventListener('click', () => (ledger.connected ? sync() : connectGoogle()));
$('save').addEventListener('click', () => {
  settings = { key: $('key').value.trim(), model: $('model').value };
  store.set('settings', settings);
  closeSheet(); paint();
});

// Google's sign-in script; the app works fully without it and syncs once connected.
const gsi = document.createElement('script');
gsi.src = 'https://accounts.google.com/gsi/client'; gsi.async = true;
document.head.appendChild(gsi);

if (!settings.key) openSheet();
paint();
sync();
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
