'use strict';
// Registers the native messaging host (nativehost.js) with Chrome for the current user, so the paired browser
// extension's toolbar icon can start Tumblr Studio. Only the installed work version registers (the launcher
// script must exist); the host may only be called by the extension id this app is paired with.
//   <dataDir>\native-host.json  Chrome's host manifest
//   <dataDir>\native-host.bat   runs the bundled node with nativehost.js and the launcher path
//   HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tumblr_studio.launcher → the manifest

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NAME = 'com.tumblr_studio.launcher';
const KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + NAME;
// the packaged layout puts "Tumblr Studio.vbs" in the folder above app/
const launcher = () => path.join(__dirname, '..', '..', '..', 'Tumblr Studio.vbs');

function hostFiles(dataDir, extId) {
  const bat = path.join(dataDir, 'native-host.bat');
  const manifest = {
    name: NAME,
    description: 'Starts Tumblr Studio from the browser companion',
    path: bat, type: 'stdio',
    allowed_origins: [`chrome-extension://${extId}/`],
  };
  const batText = `@echo off\r\n"${process.execPath}" "${path.join(__dirname, 'nativehost.js')}" "${launcher()}"\r\n`;
  return { bat, batText, json: path.join(dataDir, 'native-host.json'), manifest };
}

// Writes the files and the registry value when anything differs; returns true when the host is registered.
function register(dataDir, extId) {
  if (process.platform !== 'win32' || !extId || !/^[a-p]{32}$/.test(extId) || !fs.existsSync(launcher())) return false;
  const f = hostFiles(dataDir, extId);
  const text = JSON.stringify(f.manifest, null, 2);
  const same = (file, s) => { try { return fs.readFileSync(file, 'utf8') === s; } catch { return false; } };
  if (!same(f.json, text)) fs.writeFileSync(f.json, text);
  if (!same(f.bat, f.batText)) fs.writeFileSync(f.bat, f.batText);
  const q = spawnSync('reg', ['query', KEY, '/ve'], { encoding: 'utf8', windowsHide: true });
  if (q.status === 0 && (q.stdout || '').includes(f.json)) return true;
  const r = spawnSync('reg', ['add', KEY, '/ve', '/t', 'REG_SZ', '/d', f.json, '/f'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0;
}

module.exports = { register, hostFiles, NAME };
