'use strict';
// Electron main process: hosts the desktop service, the window and the tray.
// Closing the window keeps the service running in the tray; Quit stops it (resumes and reconciles next start).

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, safeStorage, nativeImage, dialog, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { bootStudio, bridgeHandler, listenFirst, PORTS } = require('../service/boot');
const { takeLock } = require('../server/lock');
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
  // one executor per data folder, shared with the local web backend (src/server)
  const lock = takeLock(dataDir, { kind: 'electron' });
  if (lock.held) { dialog.showErrorBox('Tumblr Studio', 'This data is in use by the Tumblr Studio background service (' + (lock.held.kind || '?') + '). Stop it first. / 后台服务正在使用这份数据，请先停止它。'); app.exit(0); return false; }
  ({ svc, api, relay, bridge } = bootStudio({
    dataDir, vault, media, version: app.getVersion(), fake: !!process.env.STUDIO_FAKE,
    onEvent: (type, data) => send('event', { type, data }),
    openUrl: u => shell.openExternal(u), openPath: p => shell.openPath(p),
    relaunch: () => { quitting = true; app.relaunch(); app.exit(0); },
    readStage0,
    approvePairing: async extId => {
      if (win) { win.show(); win.focus(); }
      const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Allow / 允许', 'Deny / 拒绝'], defaultId: 1, cancelId: 1,
        message: 'Connect the browser extension? / 连接浏览器插件？',
        detail: 'Extension id: ' + extId + '\nIt will read your categories, templates and tag library for suggestions on tumblr.com, and send requests (open a post, collect a post) that you see here in Activity.\n它会读取分类、模板和标签库用于网页上的提示，并发送请求（打开帖子、收集帖子），这些请求都会在“活动记录”里显示。' });
      return r.response === 0;
    },
    onOpen: ({ item }) => { if (win) { win.show(); win.focus(); } send('event', { type: 'open', data: { item } }); },
    onRestoreError: e => dialog.showErrorBox('Tumblr Studio', 'Restore failed / 恢复失败: ' + e.message),
  }));
  startBridge();
  svc.start();
  return true;
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
let bridgeServer = null, relay = null, bridge = null;
function startBridge() {
  if (process.env.STUDIO_SNAP) return;
  const handle = bridgeHandler(bridge);
  const server = http.createServer((req, res) => (req.method === 'GET' ? serveCompanion(req, res) : handle(req, res)));
  listenFirst(server, PORTS).then(port => { bridgeServer = server; svc.db.setMeta('companionPort', port); }, () => svc.db.log('warn', 'companion', 'no free port for the browser companion'));
}

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 900, minWidth: 980, minHeight: 640, title: 'Tumblr Studio', backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f131b' : '#f5f6f9', show: false,
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    webPreferences: { backgroundThrottling: !process.env.STUDIO_SNAP, preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.env.STUDIO_SNAP && !process.argv.includes('--hidden')) win.show(); });
  // Screenshot for development checks: STUDIO_SNAP=out.png [STUDIO_PAGE=posts] [STUDIO_JS=code] [STUDIO_SIZE=980x640]
  if (process.env.STUDIO_SNAP) {
    win.setPosition(-3000, 0); win.showInactive();
    if (process.env.STUDIO_SIZE) { const [w, h] = process.env.STUDIO_SIZE.split('x').map(Number); win.setMinimumSize(Math.min(w, 980), Math.min(h, 640)); win.setSize(w, h); }
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
  if (!boot()) return;
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
