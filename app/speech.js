// Speech to text with the browser's own recognizer (Apple's on iPhone, Google's in Chrome). ADR-0004.
// iOS workaround: hold a getUserMedia stream while recognizing and for 12 s after, or every session after the
// first one hears only silence. The stream is released after that grace window or when the app goes away.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const GRACE_MS = 12_000, MAX_LISTEN_MS = 12_000, STOP_WATCHDOG_MS = 2_500;

export function createSpeech({ lang = 'ar-EG', onInterim = () => {}, log = () => {} } = {}) {
  let rec = null, mic = null, graceTimer = null, session = null;

  function release(why) {
    clearTimeout(graceTimer);
    if (!mic || session) return;
    mic.getTracks().forEach(t => t.stop()); mic = null; log('mic-released', why);
  }
  addEventListener('pagehide', () => release('pagehide'));
  addEventListener('blur', () => release('blur'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) release('hidden'); });

  function recognizer() {
    if (rec) return rec;
    rec = new SR();
    rec.lang = lang; rec.interimResults = true; rec.maxAlternatives = 3; rec.continuous = false;
    rec.onresult = ev => {
      if (!session) return;
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) { session.text += r[0].transcript; session.alts = Array.from(r, a => a.transcript); }
        else interim += r[0].transcript;
      }
      onInterim((session.text + interim).trim(), session.text.trim(), interim.trim()); // all, settled words, words still changing
    };
    rec.onerror = ev => { log('error', ev.error); if (session) session.error = ev.error; };
    rec.onend = () => { log('end'); finish(); };
    for (const ev of ['start', 'audiostart', 'speechstart']) rec.addEventListener(ev, () => log(ev));
    return rec;
  }

  function finish() {
    if (!session) return;
    const s = session; session = null;
    clearTimeout(s.timers.max); clearTimeout(s.timers.watch);
    clearTimeout(graceTimer); graceTimer = setTimeout(() => release('idle'), GRACE_MS);
    s.resolve({ text: s.text.trim(), alts: s.alts, error: s.text.trim() ? null : s.error || 'no-speech' });
  }

  // Call from a tap. Resolves when the user stops (stop()), goes quiet, or after MAX_LISTEN_MS.
  async function listen() {
    if (!SR) return { text: '', alts: [], error: 'unsupported' };
    if (session) return { text: '', alts: [], error: 'busy' };
    const done = new Promise(resolve => { session = { text: '', alts: [], error: null, resolve, timers: {} }; });
    try {
      if (!(mic && mic.active)) { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); log('mic-open'); }
    } catch (e) { log('mic-fail', e.name); session.error = 'not-allowed'; finish(); return done; }
    clearTimeout(graceTimer);
    try { recognizer().start(); log('call-start'); }
    catch (e) { log('start-threw', e.name); try { rec.abort(); } catch {} rec = null; session.error = 'busy'; finish(); return done; }
    session.timers.max = setTimeout(stop, MAX_LISTEN_MS);
    return done;
  }

  function stop() {
    if (!session || !rec) return;
    try { rec.stop(); log('call-stop'); } catch {}
    // iOS sometimes never fires "end": give up instead of freezing the orb.
    session.timers.watch = setTimeout(() => { log('watchdog'); try { rec.abort(); } catch {} rec = null; if (session) session.error ||= 'stuck'; finish(); }, STOP_WATCHDOG_MS);
  }

  // Let go of the mic now, not after the grace window: while it is open, iOS plays sound quietly through the earpiece.
  const releaseNow = () => release('speak');
  return { supported: !!SR, listen, stop, release: releaseNow, get listening() { return !!session; } };
}
