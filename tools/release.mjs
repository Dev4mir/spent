// Run before every commit that changes the app:  node tools/release.mjs
// Stamps a new build into app.js and into every ?v= in the app, and writes app/version.json with the build and its
// files. Phones check version.json, download the new build in the background and switch to it (app.js, "updates").
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const dir = new URL('../app/', import.meta.url);
const now = new Date();
const build = now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
const v = now.toISOString().replace(/\D/g, '').slice(2, 14); // e.g. 261120153045

// The files a phone needs: everything served from app/ except the tests, the notes, the worker and this stamp.
const files = readdirSync(dir).filter(f => !/\.test\.mjs$|\.md$|^sw\.js$|^version\.json$/.test(f)).sort();
for (const need of ['index.html', 'app.js']) if (!files.includes(need)) throw new Error(`app/${need} is missing`);

for (const f of files.filter(f => /\.(js|html)$/.test(f))) {
  const path = new URL(f, dir);
  let s = readFileSync(path, 'utf8');
  const before = s;
  s = s.replace(/\?v=[0-9A-Za-z]+/g, `?v=${v}`);
  if (f === 'app.js') {
    if (!/^const BUILD = '[^']*';/m.test(s)) throw new Error("app.js has no `const BUILD = '…';` line");
    s = s.replace(/^const BUILD = '[^']*';/m, `const BUILD = '${build}';`);
  }
  if (s !== before) writeFileSync(path, s);
}
writeFileSync(new URL('version.json', dir), JSON.stringify({ build, files }) + '\n');
console.log(`release ${build}: ${files.length} files`);
