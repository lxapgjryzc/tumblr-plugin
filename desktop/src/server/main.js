'use strict';
// Tumblr Studio's independent local backend (docs/LOCAL_WEB_APP_SPEC.md). Plain Node, no browser engine: it
// keeps the store, credentials, sync, rules and the job queue running whether or not any page is open, and
// serves the interface to the browser on demand. Started by the launcher (launcher.js), never by a page.
//
//   node src/server/main.js [--env work|test] [--real]
// Environments are fully separate: data folder, port, Chrome profile, credentials, sessions and pairing.
// The test environment uses the made-up Tumblr account unless --real is given.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { bootStudio, listenFirst } = require('../service/boot');
const { writeAtomic } = require('../service/auth');
const { makeCompanionPage } = require('../service/companion-page');
const { makeVault, legacyStatePaths } = require('./vault');
const { makeMedia } = require('./media');
const { makeOpener } = require('./chrome');
const { takeLock } = require('./lock');
const { makeWeb } = require('./web');
const { envConfig } = require('./env');
const autostart = require('./autostart');
const nativereg = require('./nativereg');

const args = process.argv.slice(2);
const env = envConfig(args);
const VERSION = require('../../package.json').version;
const logFile = path.join(env.dataDir, 'backend.log');
let diag = null;
function log(...a) { try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + a.join(' ') + '\n'); } catch {} }

async function main() {
  const lock = takeLock(env.dataDir, { env: env.name, kind: 'web' });
  if (lock.held) { log('another executor holds this data folder:', JSON.stringify(lock.held)); console.error('busy: ' + JSON.stringify(lock.held)); process.exit(3); }

  const vault = makeVault({ legacyStates: legacyStatePaths(env.dataDir) });
  // files the Electron version protected are rewritten in this vault's form (a copy of the old one stays)
  for (const f of ['credentials.bin', 'aikey.bin']) {
    try { if (vault.migrateFile(path.join(env.dataDir, f), writeAtomic)) log('migrated', f, 'from the Electron vault'); } catch (e) { log('could not migrate', f, e.message); }
  }
  const browser = makeOpener(env.dataDir, env.fixedProfile);
  let web = null;
  const controlToken = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(env.dataDir, 'control.token'), controlToken);

  // the interface, opened in this environment's profile with a fresh one-time sign-in code
  const openUi = (hash = '') => browser.open(`http://127.0.0.1:${port}/login?code=${web.loginCode()}${hash}`);
  let port = 0;
  // Pairing requests waiting for the user's answer in an app page (bridge /pair without a grant)
  const pairAsks = new Map();
  const approvePairing = (extId, { code }) => new Promise(resolve => {
    const id = crypto.randomBytes(8).toString('hex');
    const done = ok => { if (!pairAsks.has(id)) return; pairAsks.delete(id); clearTimeout(timer); web?.broadcast('pairDone', { id }); resolve(ok); };
    const timer = setTimeout(() => done(false), 110e3);
    pairAsks.set(id, { id, code, extId, at: Date.now(), done });
    web?.broadcast('pairAsk', { id, code });
    // no page open: open one so the question can be answered
    if (!web?.clients()) { try { openUi(); } catch (e) { log('could not open a page for pairing', e.message); } }
  });
  const studio = bootStudio({
    dataDir: env.dataDir, vault, media: makeMedia(), version: VERSION, fake: env.fake,
    onEvent: (type, data) => web?.broadcast(type, data),
    openUrl: url => browser.open(url),
    openPath: p => spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref(),
    relaunch: () => restart(),
    assetUrl: id => '/asset/' + id,
    checkGrant: g => web.checkGrant(g),
    approvePairing,
    onOpen: ({ item, fresh }) => {
      // "Open in Tumblr Studio" from the extension: an open page shows it, otherwise a page is opened
      if (web.clients() && !fresh) web.broadcast('open', { item });
      else { try { openUi(); } catch (e) { studio.db.log('warn', 'browser', String(e.message || e)); } }
    },
    onRestoreError: e => log('restore failed', e.message),
    runtimeInfo: () => ({ env: env.name, test: !!env.test, fake: !!env.fake, port, pid: process.pid, node: process.version, platform: process.platform, uptimeS: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576), relay: studio?.relay?.stats?.(), budget: studio?.svc?.ctx?.tumblr?.budget?.stats?.() }),
  });
  diag = studio.diag;
  diag.write('backend.start', { version: VERSION, env: env.name, pid: process.pid, node: process.version });
  const { svc, db } = studio;
  db.setMeta('runtime', { kind: 'web', env: env.name, version: VERSION, pid: process.pid, at: Date.now() });

  const serveCompanion = makeCompanionPage([path.join(__dirname, '..', 'companion'), path.join(__dirname, '..', '..', '..', 'extension')]);
  const extraApi = {
    serverInfo: () => ({ env: env.name, test: !!env.test, fake: !!env.fake, port, profile: env.profileDir, version: VERSION, pid: process.pid, autostart: env.test ? null : autostart.get() }),
    // the companion page asks for this to pair the extension of the same browser profile
    pairingGrant: () => ({ grant: web.grant(), port }),
    stopServer: () => { setTimeout(stop, 200); return true; },
    pairAsks: () => [...pairAsks.values()].map(a => ({ id: a.id, code: a.code })),
    pairAnswer: ({ id, allow }) => { const a = pairAsks.get(String(id)); if (!a) return false; a.done(!!allow); return true; },
    setAutostart: on => { if (env.test) throw new Error('the test environment never starts with Windows'); autostart.set(!!on); return autostart.get(); },
    openExternal: url => { browser.open(String(url)); return true; },
  };
  web = makeWeb({ env, dataDir: env.dataDir, studio, controlToken, serveCompanion, onStop: () => stop(), extraApi });
  port = await listenFirst(web.server, env.ports);
  web.setPort(port);
  // version and install folder: a launcher of a newer install replaces this backend instead of reusing it
  lock.update({ env: env.name, kind: 'web', port, version: VERSION, root: path.resolve(__dirname, '..', '..') });
  db.log('info', 'runtime', `local backend started (${env.name}, port ${port}${env.fake ? ', made-up account' : ''})`);
  log('started', env.name, 'port', port, 'pid', process.pid);
  svc.start();
  // the paired extension's toolbar icon may start the installed app (nativehost.js); re-checked after pairing
  if (!env.test) {
    let lastExt = null;
    const syncHost = () => {
      const ext = db.getMeta('companion', null)?.extId || null;
      if (!ext || ext === lastExt) return;
      try { if (nativereg.register(env.dataDir, ext)) { lastExt = ext; log('native host registered for', ext); } } catch (e) { log('native host not registered', e.message); }
    };
    syncHost();
    setInterval(syncHost, 30e3).unref();
    // "start with Windows" left pointing at an older install would start that one again after a restart
    try { if (autostart.repoint()) log('start with Windows now points at this install'); } catch (e) { log('start with Windows not updated', e.message); }
  }

  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    log('stopping');
    diag?.write('backend.stop', { uptimeS: Math.round(process.uptime()) });
    db.log('info', 'runtime', 'local backend stopped');
    svc.stop();
    web.broadcast('stopped', {});
    web.server.close();
    setTimeout(() => { lock.release(); process.exit(0); }, 300);
  }
  function restart() {
    // a new backend after this one let go of the folder (restore from backup, data import)
    const child = spawn(process.execPath, [__filename, ...args, '--wait-lock'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    stop();
  }
  // a stray promise rejection is recorded and the service keeps going (jobs are durable); an uncaught
  // exception leaves the process in an unknown state, so it is recorded and the process ends
  process.on('unhandledRejection', e => { log('unhandled rejection', e?.stack || e); diag?.error('unhandledRejection', e); });
  process.on('uncaughtException', e => { log('uncaught exception', e?.stack || e); diag?.error('uncaughtException', e); try { lock.release(); } catch {} process.exit(1); });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

(async () => {
  // after a restart the previous process may still hold the folder for a moment
  if (args.includes('--wait-lock')) {
    const { readLock, alive } = require('./lock');
    for (let i = 0; i < 50; i++) { const l = readLock(env.dataDir); if (!l || !alive(l.pid) || l.pid === process.pid) break; await new Promise(r => setTimeout(r, 200)); }
  }
  await main();
})().catch(e => { log('fatal', e.stack || e); diag?.error('fatal', e); console.error(e); process.exit(1); });
