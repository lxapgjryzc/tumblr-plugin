'use strict';
// The local web backend's HTTP side (LOCAL_WEB_APP_SPEC 4). One loopback port per environment serves:
//   GET  /                the interface (renderer files), /login?code= turns a one-time code into a session
//   POST /api/call        one business call { method, args } (session cookie + X-Studio header + own Origin)
//   GET  /api/events      server-sent events (status only; no scheduling depends on them)
//   GET  /asset/<id>      draft images
//   GET  /companion/…     the extension's companion page (session required: it hands out pairing grants)
//   POST /control/…       the launcher (local control token from the data folder)
//   POST /hello, /pair…   the browser extension's bridge (its own Origin and pairing token; bridge.js)
// Every request must name this server as Host (no DNS rebinding). Nothing listens beyond 127.0.0.1.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { bridgeHandler } = require('../service/boot');

const RENDERER = path.join(__dirname, '..', 'renderer');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const BRIDGE_PATHS = new Set(['/hello', '/pair', '/status', '/snapshot', '/request', '/result', '/relay/next', '/relay/done', '/unpair']);
const SESSION_MS = 30 * 86400e3;

function makeWeb({ env, dataDir, studio, controlToken, serveCompanion, onStop, extraApi = {} }) {
  const { api, bridge, db } = studio;
  let port = 0;
  const cookieName = 'studio_' + env.name;
  // sessions survive a backend restart (hashed on disk); one-time login codes and pairing grants don't
  const sessFile = path.join(dataDir, 'sessions.json');
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch {}
  const saveSessions = () => { try { fs.writeFileSync(sessFile, JSON.stringify(sessions)); } catch {} };
  const codes = new Map(), grants = new Map();
  const clients = new Set();

  const oneTime = (map, ms) => { const c = crypto.randomBytes(24).toString('base64url'); map.set(c, Date.now() + ms); return c; };
  const useOnce = (map, c) => { const until = map.get(c); map.delete(c); return !!until && until > Date.now(); };
  const loginCode = () => oneTime(codes, 120e3);
  const checkGrant = g => useOnce(grants, g);

  function sessionOf(req) {
    const m = new RegExp('(?:^|;\\s*)' + cookieName + '=([\\w-]+)').exec(req.headers.cookie || '');
    if (!m) return null;
    const s = sessions[sha(m[1])];
    return s && s.until > Date.now() ? s : null;
  }
  const hostOk = req => req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
  const originOk = req => !req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}` || req.headers.origin === `http://localhost:${port}`;

  const send = (res, status, body, type = 'application/json', extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const page = (res, status, title, msg) => send(res, status, `<!doctype html><meta charset="utf-8"><title>Tumblr Studio</title><body style="font:15px system-ui;padding:48px;max-width:640px;color:#171c29;background:#f5f6f9"><h2>${title}</h2><p>${msg}</p>`, 'text/html; charset=utf-8');

  function serveFile(res, file, extra = {}) {
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: 'not_found' });
      let body = buf;
      if (file.endsWith('index.html')) {
        // the browser build: the web bridge replaces Electron's preload, connections go to this server only
        body = buf.toString('utf8')
          .replace("connect-src 'none'", "connect-src 'self'")
          .replace(/img-src 'self' https: data: blob: file:/, "img-src 'self' https: data: blob:")
          .replace('<script src="i18n.js"></script>', `<script src="web.js"></script>\n<script src="i18n.js"></script>`)
          .replace('<title>Tumblr Studio</title>', `<title>${env.test ? 'Tumblr Studio · TEST 测试' : 'Tumblr Studio'}</title>`);
      }
      send(res, 200, body, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', extra);
    });
  }

  // JSON can't carry bytes: the page sends { $b64 } for a Uint8Array (image uploads)
  const revive = (k, v) => (v && typeof v === 'object' && typeof v.$b64 === 'string' && Object.keys(v).length === 1 ? Buffer.from(v.$b64, 'base64') : v);

  async function readBody(req, limit) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }

  const allApi = () => ({ ...api, ...extraApi });

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (!hostOk(req)) return send(res, 403, { error: 'host' });

    // the extension's bridge: its own checks (extension Origin, pairing token)
    if (req.method === 'POST' && BRIDGE_PATHS.has(p)) return bridgeHandler(bridge)(req, res);

    // the launcher
    if (p.startsWith('/control/')) {
      if (req.method !== 'POST' || req.headers.origin || req.headers['x-studio-control'] !== controlToken) return send(res, 403, { error: 'control' });
      if (p === '/control/status') return send(res, 200, { env: env.name, pid: process.pid, port, test: !!env.test, fake: !!studio.fake, clients: clients.size });
      if (p === '/control/login-code') return send(res, 200, { code: loginCode() });
      if (p === '/control/stop') { send(res, 200, { ok: true }); setTimeout(onStop, 100); return; }
      return send(res, 404, { error: 'path' });
    }

    if (p === '/login') {
      if (!useOnce(codes, u.searchParams.get('code') || '')) return page(res, 403, 'Link expired / 链接已失效', 'Open Tumblr Studio again from its shortcut. / 请从 Tumblr Studio 的快捷方式重新打开。');
      const token = crypto.randomBytes(32).toString('base64url');
      for (const [k, s] of Object.entries(sessions)) if (s.until < Date.now()) delete sessions[k];
      sessions[sha(token)] = { at: Date.now(), until: Date.now() + SESSION_MS };
      saveSessions();
      return send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}` });
    }

    const sess = sessionOf(req);
    // public: the renderer's code and styles (no data in them)
    if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/asset/') && !p.startsWith('/companion') && p !== '/' && p !== '/index.html') {
      const file = path.normalize(path.join(RENDERER, decodeURIComponent(p)));
      if (!file.startsWith(RENDERER + path.sep)) return send(res, 404, { error: 'not_found' });
      return serveFile(res, file);
    }
    if (!sess) {
      // the companion page without a session: usually the extension lives in another Chrome profile than the one
      // the app opens in (sessions are per profile), so say which profile that is
      const prof = (() => { try { const b = JSON.parse(fs.readFileSync(path.join(dataDir, 'browser.json'), 'utf8')); return b.name ? `${b.name}${b.user ? ' · ' + b.user : ''} (${b.profileDir})` : b.profileDir; } catch { return env.profileDir || '?'; } })();
      if (req.method === 'GET' && p.startsWith('/companion')) return page(res, 401, 'Not signed in to Tumblr Studio in this Chrome profile / 这个 Chrome 用户没有登录 Tumblr Studio',
        `Tumblr Studio opens in the Chrome profile “${prof}”. Connect the extension installed in that profile: open Tumblr Studio from its shortcut, then use Settings → Background service → companion page. If the extension is in another profile, install it in “${prof}” too. / Tumblr Studio 是在 Chrome 用户“${prof}”里打开的。请用装在这个用户里的插件来连接：从快捷方式打开 Tumblr Studio，再点 设置 → 后台服务 → 配对页。如果插件装在别的 Chrome 用户里，请在“${prof}”里也装上。`);
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return page(res, 401, 'Open from the shortcut / 请从快捷方式打开', 'This page needs a sign-in link from the Tumblr Studio shortcut on this computer. / 这个页面需要通过本机的 Tumblr Studio 快捷方式打开。');
      return send(res, 401, { error: 'session' });
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveFile(res, path.join(RENDERER, 'index.html'));
    if (req.method === 'GET' && p.startsWith('/companion')) return serveCompanion(req, res);
    if (req.method === 'GET' && p.startsWith('/asset/')) {
      const a = db.get('SELECT file FROM assets WHERE id = ?', p.slice(7));
      if (!a) return send(res, 404, { error: 'not_found' });
      return serveFile(res, path.join(dataDir, 'assets', a.file), { 'Cache-Control': 'private, max-age=86400' });
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const c = { res };
      clients.add(c);
      const beat = setInterval(() => res.write(': ping\n\n'), 25e3);
      req.on('close', () => { clearInterval(beat); clients.delete(c); });
      return;
    }
    if (req.method === 'POST' && p === '/api/call') {
      // changes need our own page: same Origin and a header a cross-site form can't send
      if (!originOk(req) || req.headers['x-studio'] !== '1') return send(res, 403, { error: 'origin' });
      let body;
      try { body = JSON.parse(await readBody(req, 64 * 1024 * 1024) || '{}', revive); } catch (e) { return send(res, e.status || 400, { error: e.status ? 'too_large' : 'json' }); }
      const fn = allApi()[body.method];
      if (typeof body.method !== 'string' || typeof fn !== 'function') return send(res, 404, { error: 'unknown method ' + body.method });
      const t0 = Date.now();
      try {
        const value = (await fn(body.args)) ?? null;
        studio.diag?.call(body.method, body.args, { ok: true, ms: Date.now() - t0 });
        return send(res, 200, { ok: true, value });
      } catch (e) {
        studio.diag?.call(body.method, body.args, { ok: false, error: e?.stack || e?.message || e, ms: Date.now() - t0 });
        return send(res, 200, { ok: false, error: String(e?.message || e) });
      }
    }
    return send(res, 404, { error: 'path' });
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(e => { studio.diag?.error('http ' + req.method + ' ' + String(req.url).split('?')[0], e); try { send(res, 500, { error: String(e.message || e) }); } catch {} }); });
  return {
    server,
    setPort: x => { port = x; },
    loginCode,
    grant: () => oneTime(grants, 120e3),
    checkGrant,
    clients: () => clients.size,
    broadcast(type, data) {
      const msg = `data: ${JSON.stringify({ type, data })}\n\n`;
      for (const c of clients) { try { c.res.write(msg); } catch {} }
    },
  };
}

module.exports = { makeWeb };
