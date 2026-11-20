// Spent: tap, speak, Brief back. The phone holds every Entry and the Google Sheet mirrors it (ADR-0005).
// Bump ?v= in every import (and in index.html) on each release: iOS Safari caches modules hard.
import { createSpeech } from './speech.js?v=261120170220';
import { createUnderstanding, createAdviser, Anthropic, FAST } from './claude.js?v=261120170220';
import { createLedgerClient, AuthNeeded } from './sheets.js?v=261120170220';
import { reconcile, settle, applyOps } from './sync.js?v=261120170220';
import { monthModel, standing, brief, toEntry, isoDate, findBankMatch, matchInto, categoryFor, cashInHand, cashCountEntry, corrected,
  answer, nextAsk, askText, today, monthRows, moneySummary, monthKey, KIND_AR, UNKNOWN, DEFAULT_CATEGORIES } from './logic.js?v=261120170220';
import { GOOGLE_CLIENT_ID } from './config.js?v=261120170220';

const BUILD = '2026-11-20 17:02:20 UTC'; // stamped by tools/release.mjs; a phone compares it with version.json to update itself
const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString('en-US'); // Western digits everywhere: screen, Sheet and Claude's replies
const store = {
  get(k, d) { try { const v = localStorage.getItem('spent:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('spent:' + k, JSON.stringify(v)); } catch {} },
};
const SLIP_MS = 5000, CHAT_MS = 120_000, USD_FALLBACK = 50, SYNC_DELAY_MS = 1500;

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

let phase = 'idle', shown = null; // shown: what the result screen holds
const skipped = new Set(); // asks passed over in this session; closing the app asks again
const timers = {};

const ledger = createLedgerClient({ clientId: GOOGLE_CLIENT_ID, store });
// What Claude cost this month, on this phone: every call adds to it (shown at the bottom of the Month View).
function addCost(usd) { const k = monthKey(new Date()), c = store.get('claudeCost', {}); store.set('claudeCost', { [k]: (c[k] || 0) + usd }); }
const understand = createUnderstanding({ getKey: () => settings.key, getModel: () => settings.model, onCost: addCost });
const advise = createAdviser({ getKey: () => settings.key, onCost: addCost });
// The conversation with the adviser: the turns so far, the numbers it was given, and until when a new tap carries it on.
let chat = null;
const chatting = () => (chat && Date.now() < chat.until ? chat : null);
const speech = createSpeech({ onInterim: (all, settledWords, changing) => all && setSaid(settledWords, changing) });

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
  hush(); unlockVoice(); // a tap stops the adviser talking, and lets iOS speak the next answer
  if (!speech.supported) return startTyping();
  phase = 'listening'; shown = null; clearTimeout(timers.settle); clearTimeout(timers.undo); timers.undo = null;
  setSaid('', 'بسمعك…'); say('بسمعك'); paint(); // within a tenth of a second: the button fills and the words area clears
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
  const t = $('typed').value.trim(); $('typed').blur(); unlockVoice();
  if (!t) { phase = 'idle'; return paint(); }
  handle(t, []);
});
$('typed').addEventListener('blur', () => { if (phase === 'typing' && !$('typed').value.trim()) { phase = 'idle'; paint(); } });

async function handle(text, alts) {
  phase = 'thinking'; setSaid(text, ''); paint(); // your words stay up while Claude reads them: no spinner
  const ask = currentAsk(), last = byId(db.last);
  let j;
  try { j = await understand(text, alts, { categories: meta.categories, ask: ask && askText(ask, fmt), last: last && describe(last), adviser: chatting()?.last }); }
  catch (e) { return claudeFailed(e); }
  if (ask && j.intent !== 'answer') skipped.add(ask.key); // they moved on: ask the next thing, and this one again next time
  try {
    if (j.intent === 'answer' && ask) return answerAsk(ask, j, text);
    if (j.intent === 'correction') return correct(j, text);
    if (j.intent === 'question') return ask_(j, text);
    if (j.intent === 'cash_count') return countCash(j, text);
    if (j.intent === 'chat') return adviseOn(j.understood || text);
    return addEntry(j, text);
  } catch (e) { showError('حصلت مشكلة', e.message || String(e)); }
}

function claudeFailed(e) {
  if (e instanceof Anthropic.AuthenticationError) return showError('مفتاح Claude مش شغال', 'راجعه من الإعدادات');
  if (e instanceof Anthropic.RateLimitError) return showError('Claude مشغول', 'استنى شوية وجرّب تاني');
  if (e instanceof Anthropic.APIConnectionError) return showError('مفيش نت', 'Claude محتاج نت يفهم الجملة؛ قولها تاني بعدين');
  return showError('Claude ماردّش', e.message || String(e));
}

// The adviser: anything that isn't an Entry or a plain total. It reads a summary of the user's money, built once per
// conversation; for two minutes after an answer, the next question carries the conversation on. Nothing is saved.
async function adviseOn(question) {
  const on = chatting();
  const money = on ? on.money : moneySummary(book(), new Date(), fmt);
  let r;
  try { r = await advise(on ? on.history : [], question, money); }
  catch (e) { return claudeFailed(e); }
  chat = { history: r.history, money, last: r.text, until: Date.now() + CHAT_MS };
  clearTimeout(timers.chat); timers.chat = setTimeout(() => { if (phase === 'idle') paint(); }, CHAT_MS + 50);
  show({ amt: '', label: '', line: r.text, tone: 'ok', chat: true }, canSpeak ? null : r.text); // spoken aloud below; screen readers would say it twice
  speakAloud(r.text);
}

/* ---------- the adviser's voice: the phone's own Arabic voice ---------- */
// Off for now: the iPhone has no Egyptian Arabic voice, and the Arabic it has sounds wrong. Answers stay on screen.
const SPEAK = false;
const canSpeak = SPEAK && 'speechSynthesis' in window;
// iOS speaks only for a page that has spoken from a tap. An empty utterance doesn't count, so each tap says a silent space.
function unlockVoice() {
  if (!canSpeak) return;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {}
}
function hush() { try { if (canSpeak && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel(); } catch {} }
function arabicVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find(x => x.lang === 'ar-EG') || voices.find(x => x.lang?.replace('_', '-').startsWith('ar'));
}
function speakAloud(text) {
  if (!canSpeak) return;
  try {
    hush();
    speech.release(); // with the mic still open, iOS plays the voice quietly in the earpiece, or not at all
    const u = new SpeechSynthesisUtterance(text.replace(/[«»"]/g, ''));
    const v = arabicVoice();
    u.lang = v?.lang || 'ar-SA'; if (v) u.voice = v;
    setTimeout(() => speechSynthesis.speak(u), 250); // give iOS a moment to switch the audio back from recording
  } catch {}
}
if (canSpeak) speechSynthesis.getVoices(); // iOS loads its voice list on first ask

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

function undo(dir = -1) { // dir: which way the Brief leaves, the way it was swiped
  if (!shown?.undo || !timers.undo) return;
  clearTimeout(timers.undo); clearTimeout(timers.settle); timers.undo = null;
  change(shown.undo);
  const slip = $('slip'); slip.style.translate = `${dir * 110}% 0`; setTimeout(() => { slip.style.translate = ''; }, 350);
  shown = null; phase = 'idle'; flash('اتلغت'); paintToday(false); say('اتلغت');
}

/* ---------- sync with the Ledger (sync.js) ---------- */
let syncing = null, again = false;
function scheduleSync() { clearTimeout(timers.sync); timers.sync = setTimeout(sync, SYNC_DELAY_MS); paintPending(); }
function sync() {
  if (syncing) { again = true; return syncing; }
  syncing = doSync().finally(() => { syncing = null; paintPending(); if (phase === 'idle') { paint(); paintToday(false); } if (month.open) renderMonth(); if (again) { again = false; sync(); } });
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
    for (const id of ['openSheet', 'monthSheet']) { $(id).href = ledger.url; $(id).hidden = !ledger.url; }
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
  const label = labelOf(e), line = (b.lines[0] || '').replace(`${label}: `, ''); // the Category is already on the first line
  show({ amt: amtOf(e), label: label + (e.merchant ? ` · ${e.merchant}` : '') + when, line, tone: b.tone, undo }, null);
}
// The Brief: what was saved (Category and amount), one line on where it stands, and Undo while it lasts.
// Then it leaves and Today rolls to its new number.
function show(s, spoken) {
  shown = s; phase = 'result'; buzz(s.tone);
  if (spoken) say(spoken);
  clearTimeout(timers.undo); timers.undo = s.undo ? setTimeout(() => { timers.undo = null; paint(); }, SLIP_MS) : null;
  const stay = s.chat ? Math.min(30_000, 6000 + s.line.length * 70) : SLIP_MS; // long enough to read an answer
  clearTimeout(timers.settle); timers.settle = setTimeout(() => {
    if (phase !== 'result') return;
    shown = null; phase = 'idle'; paint(); setTimeout(() => paintToday(true), 180);
  }, stay);
  paint();
}
function showError(title, why) { show({ amt: '', label: title, line: why, tone: 'over' }, null); shout(`${title}. ${why}`); }
function setSaid(settledWords, changing) { // words still changing are lighter (Apple's advice for live speech)
  $('fin').textContent = settledWords; $('vol').textContent = (settledWords && changing ? ' ' : '') + changing;
}
let note = ''; // a short word in the ask line, like «اتلغت»
function flash(t) { note = t; paint(); clearTimeout(timers.note); timers.note = setTimeout(() => { note = ''; if (phase === 'idle') paint(); }, 2000); }
// Screen readers: one polite region for the Brief, one alert region for failures. Clear first so a repeat still speaks.
function announce(id, text) { const el = $(id); el.textContent = ''; setTimeout(() => { el.textContent = text; }, 60); }
const say = t => announce('say', t), shout = t => announce('shout', t);
function buzz(tone) { try { navigator.vibrate?.(tone === 'over' ? [80, 60, 80, 60, 220] : tone === 'warn' ? [60, 60, 60] : 40); } catch {} }

function paint() {
  const scr = $('screen');
  scr.dataset.phase = phase;
  const on = (id, v) => $(id).classList.toggle('on', v);
  on('said', phase === 'listening' || phase === 'thinking');
  on('typedForm', phase === 'typing');
  const res = phase === 'result' && !!shown;
  if (res) {
    $('cat').textContent = shown.label || '';
    $('amt').innerHTML = shown.amt || '';
    $('s2').textContent = shown.line || '';
    $('slip').toggleAttribute('data-attention', shown.tone !== 'ok');
    $('slip').toggleAttribute('data-chat', !!shown.chat);
    $('s1').hidden = !shown.label && !shown.amt;
  }
  on('slip', res);
  $('undo').hidden = !(res && timers.undo && shown.undo);
  const orb = $('orb');
  orb.setAttribute('aria-label', phase === 'listening' ? 'خلصت، وقّف التسجيل' : phase === 'thinking' ? 'بيفهم…' : 'اضغط واتكلم');
  if (phase === 'thinking') orb.setAttribute('aria-disabled', 'true'); else orb.removeAttribute('aria-disabled');
  if (phase === 'idle') {
    const a = currentAsk();
    $('ask').textContent = note || (!settings.key ? 'اضغط عشان تبدأ' : a ? askText(a, fmt) : chatting() ? 'اسأل تاني تكمّل الكلام'
      : speech.supported ? '' : 'اضغط واكتب، أو 🎤 في الكيبورد');
    $('ask').toggleAttribute('data-question', !note && !!a);
  }
  paintPending();
}

/* ---------- Today: the one number on the home screen ---------- */
// Each digit rolls to its new value on its own, ones first. A different number of digits just swaps.
function roll(el, s, animate) {
  const prev = el.dataset.s || '', isDigit = ch => ch >= '0' && ch <= '9';
  const same = prev.length === s.length && [...s].every((ch, i) => isDigit(ch) === isDigit(prev[i]));
  if (!same || !animate) el.innerHTML = [...s].map(ch => isDigit(ch)
    ? `<span class="col"><span class="strip">${'0123456789'.split('').map(x => `<span>${x}</span>`).join('')}</span></span>` : `<span>${ch}</span>`).join('');
  const strips = [...el.querySelectorAll('.strip')], ds = [...s].filter(isDigit);
  strips.forEach((st, k) => {
    st.style.transition = animate ? '' : 'none';
    st.style.transitionDelay = animate ? `${(strips.length - 1 - k) * 50}ms` : '0ms';
    st.style.translate = `0 ${-Number(ds[k])}em`;
  });
  el.dataset.s = s;
}
function paintToday(animate) {
  const t = today(model()), over = t.amount != null && t.amount < 0;
  const shownAmount = t.amount == null ? t.spentToday : Math.abs(t.amount);
  roll($('num'), fmt(shownAmount), animate);
  const label = t.amount == null ? 'صرفت النهارده' : over ? 'زيادة النهارده' : 'النهارده';
  $('tlabel').textContent = label;
  $('today').toggleAttribute('data-over', over);
  $('tmr').textContent = !over || t.tomorrow == null ? '' : t.tomorrow > 0 ? `بكرة ${fmt(t.tomorrow)}` : `عدّيت ميزانيات الشهر بـ ${fmt(-t.left)}`;
  const hidden = store.get('hideToday', false);
  $('today').toggleAttribute('data-hidden', hidden);
  $('numBtn').setAttribute('aria-pressed', String(hidden));
  $('numBtn').setAttribute('aria-label', hidden ? `${label}: مستخبي، اضغط عشان يظهر` : `${label} ${fmt(shownAmount)} جنيه، اضغط عشان تخبّيه`);
}
$('numBtn').addEventListener('click', () => { store.set('hideToday', !store.get('hideToday', false)); paintToday(false); });

/* ---------- the Month View: swipe up, or the handle under the button ---------- */
const month = { open: false };
const days = n => (n === 1 ? 'يوم' : n === 2 ? 'يومين' : n <= 10 ? `${fmt(n)} أيام` : `${fmt(n)} يوم`);
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function rowValue(r) { // [text, quiet]
  if (!r.plan) return [fmt(r.spent), true];
  if (r.spent > r.plan) return [`عدّيت ${fmt(r.spent - r.plan)}`, false];
  if (r.slack != null) return [r.slack === 0 ? 'ماشي مظبوط' : r.slack > 0 ? `قدامك ${days(r.slack)}` : `ورا ${days(-r.slack)}`, false];
  if (r.type === 'fixed' && r.spent >= r.plan) return ['اتدفع', true];
  return [`فاضل ${fmt(r.plan - r.spent)}`, false];
}
function renderMonth() {
  const now = new Date(), m = model(), rows = monthRows(m), t = today(m);
  $('monthTitle').textContent = now.toLocaleDateString('ar-EG-u-nu-latn', { month: 'long' });
  $('mday').textContent = `يوم ${fmt(m.day)} من ${fmt(m.days)}`;
  $('rows').innerHTML = rows.length ? rows.map(r => {
    const [v, quiet] = rowValue(r);
    const tick = r.type === 'variable' ? `<b style="right:${m.day / m.days * 100}%"></b>` : ''; // where even spending would be today
    const bar = r.plan ? `<span class="bar" aria-hidden="true"><i style="width:${Math.min(100, r.spent / r.plan * 100)}%"></i>${tick}</span>` : '';
    return `<div class="mrow"${r.attention ? ' data-attention' : ''}><span class="n">${esc(r.name)}</span><span class="v${quiet ? ' quiet' : ''}">${v}</span>${bar}</div>`;
  }).join('') : '<p class="mempty">لسه مفيش حاجة الشهر ده. اضغط واتكلم.</p>';
  const lines = [];
  if (t.amount != null) lines.push(`<p${t.left < 0 ? ' data-attention' : ''}><span>المصروف اليومي</span><b>${t.left < 0 ? `عدّيت ${fmt(-t.left)}` : `فاضل ${fmt(t.left)} من ${fmt(t.pool)}`}</b></p>`);
  const a = answer(book(), { about: 'month', period: 'month' }, now, fmt);
  if (a.egp != null) lines.push(`<p${a.tone !== 'ok' ? ' data-attention' : ''}><span>${esc(a.label)}</span><b>${fmt(Math.abs(a.egp))}</b></p>`);
  const usd = store.get('claudeCost', {})[monthKey(now)] || 0;
  if (usd) lines.push(`<p><span>Claude الشهر ده</span><b class="quiet">${usd < 0.01 ? '&lt; $0.01' : `$${usd.toFixed(2)}`}</b></p>`);
  $('msum').innerHTML = lines.join('');
  $('msum').hidden = !lines.length;
}
function openMonth(on) {
  if (on) renderMonth();
  month.open = on;
  const el = $('month'); el.classList.toggle('open', on); el.setAttribute('aria-hidden', String(!on)); el.inert = !on;
  if (on) $('grab').focus({ preventScroll: true, focusVisible: false }); // focus moves in for screen readers; no ring after a tap else if (el.contains(document.activeElement)) $('pull').focus({ preventScroll: true });
}
$('pull').addEventListener('click', () => openMonth(true));
$('grab').addEventListener('click', () => openMonth(false));
addEventListener('keydown', e => { if (e.key === 'Escape' && month.open) openMonth(false); });
let swipedAt = 0, p0 = null;
$('screen').addEventListener('pointerdown', e => { p0 = { x: e.clientX, y: e.clientY }; });
$('screen').addEventListener('pointerup', e => {
  if (!p0) return; const dx = e.clientX - p0.x, dy = e.clientY - p0.y; p0 = null;
  if (dy < -60 && Math.abs(dy) > Math.abs(dx) && phase !== 'typing') { swipedAt = Date.now(); openMonth(true); }
});
{ // swipe down from the top of the Month View to close it
  const el = $('month'); let y0 = null;
  el.addEventListener('touchstart', e => { y0 = el.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
  el.addEventListener('touchmove', e => { if (y0 != null && e.touches[0].clientY - y0 > 70) { y0 = null; openMonth(false); } }, { passive: true });
  el.inert = true;
}

/* ---------- swipe the Brief sideways to undo it ---------- */
{
  const slip = $('slip'); let x0 = null, dx = 0;
  slip.addEventListener('pointerdown', e => {
    if (!shown?.undo || !timers.undo || e.target.closest('.undo')) return;
    e.stopPropagation(); x0 = e.clientX; dx = 0; slip.classList.add('drag'); slip.setPointerCapture(e.pointerId);
  });
  slip.addEventListener('pointermove', e => { if (x0 == null) return; dx = e.clientX - x0; slip.style.translate = `${dx}px 0`; });
  const end = e => {
    if (x0 == null) return; e.stopPropagation(); x0 = null; slip.classList.remove('drag');
    if (Math.abs(dx) > 70) undo(Math.sign(dx)); else slip.style.translate = '';
  };
  slip.addEventListener('pointerup', end); slip.addEventListener('pointercancel', end);
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

$('orb').addEventListener('click', () => { if (Date.now() - swipedAt > 400) tap(); });
$('undo').addEventListener('click', () => undo(-1));
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
$('stepVoice').hidden = !canSpeak;
$('testVoice').addEventListener('click', () => { // from a tap, so iOS allows it: hearing nothing here means the phone itself is silent
  hush();
  const u = new SpeechSynthesisUtterance('أهلاً، ده صوت المستشار في Spent');
  const v = arabicVoice(); u.lang = v?.lang || 'ar-SA'; if (v) u.voice = v;
  speechSynthesis.speak(u);
  $('voiceMsg').textContent = v ? `الصوت: ${v.name}` : 'مفيش صوت عربي على الموبايل؛ زوّده من الإعدادات ← تسهيلات الاستخدام ← المحتوى المنطوق ← الأصوات';
});
$('save').addEventListener('click', () => {
  settings = { key: $('key').value.trim(), model: $('model').value };
  store.set('settings', settings);
  closeSheet(); paint(); paintToday(false);
});

/* ---------- updates: the same way as Totap (herdr-dr) ---------- */
// sw.js serves the app from a cache, so it opens at once. version.json names the newest release (tools/release.mjs).
// The app checks it when it opens, when it comes back to the front and every 10 minutes; a newer release downloads in
// the background, and the app reloads into it when nothing would be lost: no answer on screen, no sheet open.
const update = { state: 'idle', build: null, checked: 0 };
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function toWorker(msg, ms = 60_000) {
  return new Promise((res, rej) => {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return rej(new Error('no worker yet'));
    const ch = new MessageChannel(), t = setTimeout(() => rej(new Error('timeout')), ms);
    ch.port1.onmessage = e => { clearTimeout(t); res(e.data); };
    sw.postMessage(msg, [ch.port2]);
  });
}
async function checkUpdate(manual = false) {
  if (!navigator.serviceWorker?.controller || ['checking', 'downloading', 'ready'].includes(update.state)) return;
  if (!manual && Date.now() - update.checked < 60_000) return;
  update.state = 'checking'; paintVersion();
  try {
    const info = await (await fetch('./version.json', { cache: 'no-store' })).json();
    update.checked = Date.now();
    if (!info?.build || info.build === BUILD || !Array.isArray(info.files)) { update.state = 'current'; return; }
    const files = info.files.filter(f => typeof f === 'string' && SAFE_FILE.test(f));
    if (!files.includes('index.html') || !files.includes('app.js')) throw new Error('incomplete release');
    update.state = 'downloading'; update.build = info.build; paintVersion();
    const r = await toWorker({ update: files });
    if (!r?.ok) throw new Error(r?.error || 'download failed');
    update.state = 'ready';
    applyWhenSafe();
  } catch (e) { update.state = 'failed'; console.warn('update', e); }
  finally { paintVersion(); }
}
const safeToReload = () => document.visibilityState === 'visible' && phase === 'idle' && !month.open && !$('sheet').open;
function applyUpdate() { try { sessionStorage.setItem('spent:updated', update.build || ''); } catch {} location.reload(); }
function applyWhenSafe() { if (update.state === 'ready' && safeToReload()) applyUpdate(); }
function paintVersion() {
  const st = { checking: 'بيدوّر على نسخة جديدة…', downloading: 'بينزّل النسخة الجديدة…', ready: 'نسخة جديدة جاهزة، هتتركّب لوحدها',
    failed: 'ماقدرش يدوّر على تحديث دلوقتي', current: 'محدّث' }[update.state] || 'بيتحدّث لوحده';
  $('appVersion').textContent = `النسخة ${BUILD} · ${st}`;
  $('updateNow').hidden = update.state !== 'ready';
}
$('updateNow').addEventListener('click', applyUpdate);
if ('serviceWorker' in navigator) {
  // updateViaCache 'none': each check for a new worker goes to the network, not the HTTP cache.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(e => console.warn('sw', e));
  setTimeout(() => checkUpdate(), 3000);
  setInterval(() => { if (document.visibilityState === 'visible') checkUpdate(); }, 10 * 60_000);
  setInterval(applyWhenSafe, 3000); // an update waiting on an answer or an open sheet goes once they're done
}
try { const done = sessionStorage.getItem('spent:updated'); sessionStorage.removeItem('spent:updated'); if (done) setTimeout(() => flash('اتحدّث Spent'), 300); } catch {}
paintVersion();

// Google's sign-in script; the app works fully without it and syncs once connected.
const gsi = document.createElement('script');
gsi.src = 'https://accounts.google.com/gsi/client'; gsi.async = true;
document.head.appendChild(gsi);

if (!settings.key) openSheet();
paint(); paintToday(false);
sync();
document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); applyWhenSafe(); checkUpdate(); } });
