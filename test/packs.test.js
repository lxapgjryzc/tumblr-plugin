// Checks every maintained pack in packs/: it loads, uses no punctuated tags, and every character has a tag
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8') + ';this.C = TTHCore;', ctx);
const C = ctx.C;
let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

const dir = path.join(__dirname, '..', 'packs');
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let pk = null;
  try { pk = C.parsePack(raw); } catch (e) { check(false, `${f}: loads (${e.message})`); continue; }
  check(true, `${f}: loads`);
  const items = [...pk.items.values()];
  const punct = [...pk.base, ...items.flatMap(it => it.tags)].filter(tg => /[^\p{L}\p{N}\s]/u.test(tg));
  check(!punct.length, `${f}: no punctuated tags` + (punct.length ? ': ' + punct.join(', ') : ''));
  const bare = items.filter(it => it.kind === 'char' && !it.tags.length).map(it => it.id);
  check(!bare.length, `${f}: every character has a tag` + (bare.length ? ': ' + bare.join(', ') : ''));
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
