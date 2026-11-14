'use strict';
// The extension's DOM-free logic (src/core.js, the TTHCore object) loaded into Node, so tag handling, packs and
// template ordering are the same code in both products. In a packaged build the file sits next to this one.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The source tree's src/core.js first: `npm run pack` also leaves a tthcore.js copy here, which would otherwise
// shadow later core changes in tests and `npm run serve`. A packaged build has only the copy.
const candidates = [path.join(__dirname, '..', '..', '..', 'src', 'core.js'), path.join(__dirname, 'tthcore.js')];
const file = candidates.find(f => fs.existsSync(f));
if (!file) throw new Error('src/core.js not found');
const ctx = { URLSearchParams, URL, TextDecoder, TextEncoder, setTimeout, clearTimeout, console, fetch, navigator: { languages: ['en'] } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(file, 'utf8') + '\nthis.__C = TTHCore;', ctx, { filename: file });
module.exports = ctx.__C;
