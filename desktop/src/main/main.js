'use strict';
// Electron main process: hosts the desktop service, the window and the tray.
// Closing the window keeps the service running in the tray; Quit stops it (resumes and reconciles next start).

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, safeStorage, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Credentials } = require('../service/auth');
const { makeTumblr, Budget } = require('../service/tumblr');
const { createService } = require('../service/service');
const { makeApi } = require('../service/api');
const { openDb } = require('../service/db');
const { addWriting } = require('../service/writing');
const { addFollowers } = require('../service/followers');
const { addData, restoreAtStartup } = require('../service/data');
const { addMaterial } = require('../service/material');
const { addTidy } = require('../service/tidy');
const { addAiArt } = require('../service/aiart');
const { addVersions } = require('../service/versions');
const { addVisitor } = require('../service/visitor');
const { addTakeover } = require('../service/takeover');
const { makeBridge, PORTS } = require('../service/bridge');
const { makeCompanionPage } = require('../service/companion-page');
const http = require('node:http');

// A development run with its own data folder gets its own Electron profile too, so it never collides with the
// installed app's single-instance lock (or its cache)
if (process.env.STUDIO_DATA) app.setPath('userData', path.join(process.env.STUDIO_DATA, 'electron'));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, tray = null, quitting = false, svc = null, api = null;
const dataDir = process.env.STUDIO_DATA || path.join(app.getPath('appData'), 'Tumblr Studio');

const vault = {
  encrypt: s => safeStorage.encryptString(s),
  decrypt: b => safeStorage.decryptString(b),
};

// Credentials of the stage-0 probe (DPAPI for this Windows user), so the user doesn't have to authorise twice
function readStage0() {
  const file = path.join(process.env.LOCALAPPDATA || '', 'tumblr-studio-stage0', 'credentials.dpapi');
  if (!fs.existsSync(file)) throw new Error('no stage-0 credentials found');
  const script = 'Add-Type -AssemblyName System.Security; $b = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:TTH_IN), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($b)';
  const env = { ...process.env, TTH_IN: fs.readFileSync(file, 'utf8').trim() };
  delete env.PSModulePath;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not decrypt the stage-0 credentials');
  const c = JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString('utf8'));
  if (!c.client_id || !c.refresh_token) throw new Error('the stage-0 credentials have no refresh token');
  return { client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, access_token: null, expires_at: 0, scope: c.scope };
}

function boot() {
  let restored = null;
  try { restored = restoreAtStartup(dataDir); } catch (e) { dialog.showErrorBox('Tumblr Studio', 'Restore failed / 恢复失败: ' + e.message); }
  const db = openDb(path.join(dataDir, 'studio.db'));
  if (restored) { db.setMeta('paused', true); db.log('info', 'data', 'restored from backup; automation paused', restored); }
  const creds = new Credentials(path.join(dataDir, 'credentials.bin'), vault);
  const budget = new Budget({ load: () => db.getMeta('budget', []), save: t => db.setMeta('budget', t) });
  let tumblr = makeTumblr({ creds, budget });
  if (process.env.STUDIO_FAKE) {
    // Demo account for UI checks: no network, made-up blogs (see test/demo.js)
    tumblr = require('../../test/demo').demoFake();
    creds.status = () => 'connected';
    db.capability('edit.labels', 'not_used');
  }
  svc = createService({ db, tumblr, creds, onEvent: (type, data) => send('event', { type, data }) });
  const extra = {};
  addWriting(svc, extra, { dataDir });
  const data = addData(svc, extra, { dataDir, vault, openPath: p => shell.openPath(p), relaunch: () => { quitting = true; app.relaunch(); app.exit(0); } });
  addFollowers(svc, extra, { aiKey: data.aiKey });
  addMaterial(svc, extra, { media, aiKey: data.aiKey });
  addTidy(svc, extra);
  addAiArt(svc, extra);
  addVersions(svc, extra);
  addVisitor(svc, extra);
  addTakeover(svc, extra, { dataDir });
  api = makeApi(svc, { creds, openUrl: u => shell.openExternal(u), importStage0: readStage0, extra });
  startBridge();
  creds.onChange(() => send('event', { type: 'auth' }));
  svc.start();
}

// Image decoding for the palette and the AI (the service itself has no image library): Tumblr's media are
// asked for as JPEG/PNG, decoded by Electron, scaled down. Returns RGBA bytes / a JPEG data URL.
async function imageOf(url, size) {
  if (!/^https:\/\/[\w.-]+\.media\.tumblr\.com\//.test(url)) throw new Error('not a Tumblr image');
  const res = await fetch(url, { headers: { Accept: 'image/jpeg,image/png;q=0.9' } });
  if (!res.ok) throw new Error('image ' + res.status);
  let img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
  if (img.isEmpty()) throw new Error('image format not readable');
  const { width, height } = img.getSize();
  const k = Math.min(1, size / Math.max(width, height));
  if (k < 1) img = img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' });
  return img;
}
const media = {
  async pixels(url, size = 64) {
    const bgra = (await imageOf(url, size)).toBitmap();
    const out = new Uint8ClampedArray(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) { out[i] = bgra[i + 2]; out[i + 1] = bgra[i + 1]; out[i + 2] = bgra[i]; out[i + 3] = bgra[i + 3]; }
    return out;
  },
  async dataUrl(url, size = 768) { return 'data:image/jpeg;base64,' + (await imageOf(url, size)).toJPEG(85).toString('base64'); },
};

// The companion page is served from the extension's files: copied into src/companion when packaged, the
// extension folder next to desktop/ in development
const serveCompanion = makeCompanionPage([path.join(__dirname, '..', 'companion'), path.join(__dirname, '..', '..', '..', 'extension')]);

// The browser companion's loopback endpoint (protocol in service/bridge.js). Pairing asks here, in the app.
let bridgeServer = null;
function startBridge() {
  if (process.env.STUDIO_SNAP) return;
  const bridge = makeBridge(svc, api, {
    version: app.getVersion(),
    approve: async extId => {
      if (win) { win.show(); win.focus(); }
      const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Allow / 允许', 'Deny / 拒绝'], defaultId: 1, cancelId: 1,
        message: 'Connect the browser extension? / 连接浏览器插件？',
        detail: 'Extension id: ' + extId + '\nIt will read your categories, templates and tag library for suggestions on tumblr.com, and send requests (open a post, collect a post) that you see here in Activity.\n它会读取分类、模板和标签库用于网页上的提示，并发送请求（打开帖子、收集帖子），这些请求都会在“活动记录”里显示。' });
      return r.response === 0;
    },
    onOpen: ({ item }) => { if (win) { win.show(); win.focus(); } send('event', { type: 'open', data: { item } }); },
  });
  const server = http.createServer((req, res) => {
    const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(json)); };
    if (req.method === 'GET') return serveCompanion(req, res);
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
  });
  const tryPort = i => {
    if (i >= PORTS.length) { svc.db.log('warn', 'companion', 'no free port for the browser companion'); return; }
    server.once('error', () => tryPort(i + 1));
    server.listen(PORTS[i], '127.0.0.1', () => { bridgeServer = server; svc.db.setMeta('companionPort', PORTS[i]); });
  };
  tryPort(0);
}

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 900, minWidth: 980, minHeight: 640, title: 'Tumblr Studio', backgroundColor: '#f6f7fb', show: false,
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: { backgroundThrottling: !process.env.STUDIO_SNAP, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.env.STUDIO_SNAP && !process.argv.includes('--hidden')) win.show(); });
  // Screenshot for development checks: STUDIO_SNAP=out.png [STUDIO_PAGE=posts] [STUDIO_JS=code]
  if (process.env.STUDIO_SNAP) {
    win.setPosition(-3000, 0); win.showInactive();
    win.webContents.on('console-message', (e) => { const m = e.message; const lv = e.level; if (lv === 'error' || lv === 3 || lv === 'warning') console.log('[renderer]', m); });
    win.webContents.once('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 2500));
      if (process.env.STUDIO_PAGE) await win.webContents.executeJavaScript(`App.go(${JSON.stringify(process.env.STUDIO_PAGE)})`);
      await new Promise(r => setTimeout(r, 1500));
      if (process.env.STUDIO_JS) { try { console.log('[js]', await win.webContents.executeJavaScript(process.env.STUDIO_JS)); } catch (e) { console.log('[js error]', e.message); } await new Promise(r => setTimeout(r, 1500)); }
      console.log('[main]', await win.webContents.executeJavaScript(`document.querySelector('#main').innerHTML.length + ' ' + document.querySelector('#main').innerText.slice(0, 200)`));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.STUDIO_SNAP, img.toPNG());
      quitting = true; app.quit();
    });
  }
  // Links open in the system browser; the window never navigates away
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  if (process.env.STUDIO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

function trayMenu() {
  const paused = svc?.db.getMeta('paused', false);
  return Menu.buildFromTemplate([
    { label: 'Open Tumblr Studio / 打开', click: () => { win.show(); win.focus(); } },
    { label: paused ? 'Resume automation / 恢复自动任务' : 'Pause automation / 暂停自动任务', click: () => { svc.db.setMeta('paused', !paused); tray.setContextMenu(trayMenu()); send('event', { type: 'status' }); } },
    { label: 'Start with Windows / 开机启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: m => { app.setLoginItemSettings({ openAtLogin: m.checked, args: ['--hidden'] }); } },
    { type: 'separator' },
    { label: 'Quit / 退出', click: () => { quitting = true; app.quit(); } },
  ]);
}

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.whenReady().then(() => {
  boot();
  ipcMain.handle('studio', async (_e, method, args) => {
    if (typeof api[method] !== 'function') throw new Error('unknown method ' + method);
    return api[method](args);
  });
  createWindow();
  const iconFile = path.join(__dirname, '..', 'renderer', 'tray.png');
  tray = new Tray(fs.existsSync(iconFile) ? nativeImage.createFromPath(iconFile) : nativeImage.createEmpty());
  tray.setToolTip('Tumblr Studio');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => { win.show(); win.focus(); });
  ipcMain.on('tray-refresh', () => tray.setContextMenu(trayMenu()));
});
app.on('window-all-closed', e => { /* stays in the tray */ });
app.on('before-quit', () => { quitting = true; svc?.stop(); bridgeServer?.close(); });
