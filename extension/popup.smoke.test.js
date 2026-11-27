// Smoke check for the popup. Run: node extension/popup.smoke.test.js
// Two drift guards, no browser needed:
//   1. Every element id popup.js looks up with $(...) exists in src/popup.html.
//   2. Every script src/popup.html loads parses under `node --check`-style parsing
//      (new Function compile), so a syntax error in a popup dependency is caught.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const html = fs.readFileSync(path.join(SRC, 'popup.html'), 'utf8');
const popupJs = fs.readFileSync(path.join(SRC, 'popup.js'), 'utf8');

// 1. Element ids. popup.js reaches elements through the $ helper:
//    const $ = id => document.getElementById(id)
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const jsIds = new Set([...popupJs.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]));
assert.ok(jsIds.size > 40, `expected popup.js to reference many ids, found ${jsIds.size}`);
const missing = [...jsIds].filter(id => !htmlIds.has(id));
assert.deepStrictEqual(missing, [], `popup.js references ids missing from popup.html: ${missing}`);

// 2. Script tags in popup.html must point at files that exist and parse.
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
assert.ok(scripts.length >= 8, `expected popup.html to load its scripts, found ${scripts.length}`);
for (const src of scripts) {
  const file = path.join(SRC, src);
  assert.ok(fs.existsSync(file), `popup.html loads ${src}, which does not exist`);
  const code = fs.readFileSync(file, 'utf8');
  assert.doesNotThrow(() => new Function(code), `${src} does not parse`);
}

// popup.js itself must parse too (it is covered above, belt and suspenders).
assert.doesNotThrow(() => new Function(popupJs), 'popup.js does not parse');

console.log(`popup smoke: ${jsIds.size} ids all present, ${scripts.length} scripts parse`);
