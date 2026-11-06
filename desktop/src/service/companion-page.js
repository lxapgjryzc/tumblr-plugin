'use strict';
// The companion page, served by the app at http://127.0.0.1:<port>/companion/ so it is an ordinary web page
// (design 4.3: the page belongs to the app). The extension's companion-host.js gives it the extension's few
// storage operations. Static files only, from a fixed list; no data is served by GET.
const fs = require('node:fs');
const path = require('node:path');

const FILES = { '': 'companion.html', 'index.html': 'companion.html', 'companion.js': 'companion.js', 'companion.css': 'companion.css', 'companion-ops.js': 'companion-ops.js', 'core.js': 'core.js' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// dirs: where to look for the files, first match wins. Returns (req, res) for GET requests.
function makeCompanionPage(dirs) {
  const find = name => dirs.map(d => path.join(d, name)).find(f => fs.existsSync(f)) || null;
  return (req, res) => {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (pathname === '/' || pathname === '/companion') { res.writeHead(302, { Location: '/companion/' }); return res.end(); }
    const m = /^\/companion\/(.*)$/.exec(pathname);
    const file = m && Object.hasOwn(FILES, m[1]) ? find(FILES[m[1]]) : null;
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(fs.readFileSync(file));
  };
}

module.exports = { makeCompanionPage };
