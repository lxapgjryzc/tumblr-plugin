'use strict';
// Assembles the whole service (store, queue, adapters, business modules, browser bridge) independent of how it
// is hosted: the local web backend (src/server) and the legacy Electron shell (src/main) both call this.
// Host-specific abilities come in as functions: the credential vault, image decoding, opening a URL in the
// right browser, opening a folder, restarting, and what to do when the extension asks to open something.

const path = require('node:path');
const http = require('node:http');
const { Credentials } = require('./auth');
const { makeTumblr, Budget } = require('./tumblr');
const { createService } = require('./service');
const { makeApi } = require('./api');
const { openDb } = require('./db');
const { addWriting } = require('./writing');
const { addFollowers } = require('./followers');
const { addAudience } = require('./audience');
const { addReplies } = require('./replies');
const { addData, restoreAtStartup } = require('./data');
const { addMaterial } = require('./material');
const { addTidy } = require('./tidy');
const { addAiArt } = require('./aiart');
const { addVersions } = require('./versions');
const { addVisitor } = require('./visitor');
const { addTakeover } = require('./takeover');
const { makeBridge, PORTS } = require('./bridge');
const { makeRelay } = require('./relay');
const { makeDiag, exportBundle } = require('./diag');

function bootStudio({
  dataDir, vault, media, version = '0', fake = false,
  onEvent = () => {}, openUrl = () => {}, openPath = () => {}, relaunch = () => {},
  readStage0 = null, assetUrl = null, approvePairing = async () => false, checkGrant = null, onOpen = () => {},
  onRestoreError = () => {}, runtimeInfo = () => ({}),
}) {
  const diag = makeDiag(dataDir);
  let restored = null;
  try { restored = restoreAtStartup(dataDir); } catch (e) { onRestoreError(e); }
  const db = openDb(path.join(dataDir, 'studio.db'));
  // everything written to Activity also goes to the diagnostic log
  const activityLog = db.log;
  db.log = (level, kind, msg, data) => { activityLog(level, kind, msg, data); diag.write('activity', { level, area: kind, msg, data }); };
  if (restored) { db.setMeta('paused', true); db.log('info', 'data', 'restored from backup; automation paused', restored); }
  const creds = new Credentials(path.join(dataDir, 'credentials.bin'), vault);
  const budget = new Budget({ load: () => db.getMeta('budget', []), save: t => db.setMeta('budget', t) });
  let svc = null;
  // the paired browser carries reads and edits while it is connected (relay.js); Settings can turn it off
  const relay = makeRelay({
    enabled: () => !!db.getMeta('companion', null) && db.getMeta('settings', {}).browserRelay !== false,
    onConnect: () => { db.log('info', 'relay', 'browser connected: reads and edits go through it'); svc?.jobs.wake('rate:'); svc?.jobs.wake('browser:'); },
    onCool: (why, ms) => db.log('warn', 'relay', `browser set aside for ${Math.round(ms / 60e3)} min (${why}): using the official API`),
  });
  // Tumblr requests: reads that succeed through the browser are frequent and dull, so only their failures
  // and every write are kept; official requests are all kept (they spend the hourly budget)
  const onRequest = r => { if (r.method === 'GET' && r.status >= 200 && r.status < 300 && r.via === 'browser') return; diag.request(r); };
  let tumblr = makeTumblr({ creds, budget, relay, onRequest });
  if (fake) {
    // made-up account for tests and UI checks (test/demo.js); never the real one
    tumblr = require('../../test/demo').demoFake();
    tumblr.relay = relay;
    // like the real adapter: a reply goes only through a connected browser, otherwise it waits
    const send = tumblr.sendReply;
    tumblr.sendReply = a => { if (!relay.available()) throw new (require('./errors').WaitError)('needs the signed-in browser (Tumblr Studio companion)'); return send(a); };
    creds.status = () => 'connected';
    db.capability('edit.labels', 'not_used');
  }
  svc = createService({ db, tumblr, creds, onEvent, diag });
  if (!db.getMeta('categoryFirstFixed')) {
    const n = require('./ops').queueCategoryFirst(db, svc.jobs);
    db.setMeta('categoryFirstFixed', Date.now());
    if (n) db.log('info', 'post.tags', `general categories moved to the front of ${n} originals`, { n });
  }
  const extra = {
    // the page's own errors and where the user went (breadcrumbs), into the diagnostic log
    clientLog({ level = 'info', what = 'page', msg = '', stack = '', page = '' } = {}) { diag.write(level === 'error' ? 'page.error' : 'page', { what, msg, stack, page }); return true; },
    // "something just went wrong": a marked line, so the moment can be found later
    diagNote({ note = '' } = {}) { diag.write('user.note', { note: String(note).slice(0, 4000) }); return true; },
    diagExport({ note = '', days = 3 } = {}) {
      if (note) diag.write('user.note', { note: String(note).slice(0, 4000) });
      const file = exportBundle(diag, { db, info: { version, ...runtimeInfo() }, days: Math.min(14, Math.max(1, Number(days) || 3)), note });
      try { openPath(diag.dir); } catch {}
      return { file, dir: diag.dir };
    },
    diagFolder() { try { openPath(diag.dir); } catch {} return diag.dir; },
  };
  addWriting(svc, extra, { dataDir, assetUrl });
  const data = addData(svc, extra, { dataDir, vault, openPath, relaunch });
  addFollowers(svc, extra, { aiKey: data.aiKey });
  addAudience(svc, extra);
  addReplies(svc, extra);
  addMaterial(svc, extra, { media, aiKey: data.aiKey });
  addTidy(svc, extra);
  addAiArt(svc, extra);
  addVersions(svc, extra);
  addVisitor(svc, extra);
  addTakeover(svc, extra, { dataDir });
  const api = makeApi(svc, { creds, openUrl, importStage0: readStage0, extra });
  const bridge = makeBridge(svc, api, { version, relay, approve: approvePairing, checkGrant, onOpen });
  return { svc, api, db, creds, relay, bridge, fake, diag };
}

// The extension's loopback endpoint (POST, JSON). Returns a (req, res) handler; GETs are left to the caller.
function bridgeHandler(bridge) {
  return (req, res) => {
    const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(json)); };
    if (req.method !== 'POST') return reply(405, { error: 'method' });
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 20 * 1024 * 1024) { reply(413, { error: 'too_large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return reply(400, { error: 'json' }); }
      try {
        const out = await bridge.handle({ origin: req.headers.origin || '', host: req.headers.host || '', auth: req.headers.authorization || '', path: req.url, body });
        reply(out.status, out.json);
      } catch (e) { reply(500, { error: String(e.message || e) }); }
    });
  };
}

// Listen on the first free port of a list (loopback only)
function listenFirst(server, ports, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const tryPort = i => {
      if (i >= ports.length) return reject(new Error('no free port among ' + ports.join(', ')));
      const onErr = () => tryPort(i + 1);
      server.once('error', onErr);
      server.listen(ports[i], host, () => { server.off('error', onErr); resolve(ports[i]); });
    };
    tryPort(0);
  });
}

module.exports = { bootStudio, bridgeHandler, listenFirst, PORTS, http };
