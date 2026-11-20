// Spent's service worker: the app opens from this cache at once, even with no network, and each open refreshes
// the cache in the background. A new release is installed through the 'update' message (app.js, "updates"):
// every file is downloaded first and only then written, so a half-downloaded release never loads.

// Bump with every change to this file.
const SW_VERSION = 'spent-sw-1';
const CACHE = 'spent-app';
const SHELL = ['./', 'app.js', 'claude.js', 'speech.js', 'sheets.js', 'sync.js', 'logic.js', 'layout.js', 'config.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
// The Claude SDK is pinned to one version in claude.js, so the copy kept here never goes stale.
const SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@';

const inScope = f => new URL(f === 'index.html' ? './' : f, self.registration.scope).href;
// One cache entry per file, whatever ?v= the page asked for.
const keyOf = url => (url.origin === self.location.origin ? url.origin + url.pathname : url.href);
const cachable = url => (url.origin === self.location.origin && !/\/(sw\.js|version\.json)$/.test(url.pathname)) || url.href.startsWith(SDK);

self.addEventListener('install', e => {
  self.skipWaiting();
  // Best effort: an install while offline still leaves a working worker.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(f => new Request(inScope(f), { cache: 'reload' })))).catch(() => {}));
});
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !cachable(url)) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const key = keyOf(url);
    const hit = await c.match(key);
    const net = fetch(e.request).then(r => { if (r.ok) c.put(key, r.clone()); return r; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});

self.addEventListener('message', e => {
  const port = e.ports?.[0];
  if (!port) return;
  if (e.data?.ask === 'version') return port.postMessage({ sw: SW_VERSION });
  if (!Array.isArray(e.data?.update)) return;
  e.waitUntil((async () => {
    try {
      const got = [];
      for (const f of e.data.update) { // straight from the network, past every cache
        const r = await fetch(inScope(f), { cache: 'reload' });
        if (!r.ok) throw new Error(`${f}: ${r.status}`);
        got.push([keyOf(new URL(inScope(f))), r]);
      }
      const c = await caches.open(CACHE);
      for (const [key, r] of got) await c.put(key, r);
      port.postMessage({ ok: true });
    } catch (err) { port.postMessage({ ok: false, error: String(err?.message || err) }); }
  })());
});
