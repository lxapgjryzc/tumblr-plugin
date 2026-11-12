'use strict';
// Credential protection without Electron: Windows DPAPI (CurrentUser scope), the same protection Electron's
// safeStorage uses underneath. Called through PowerShell's ProtectedData, so no native module is needed; the
// secret travels in an environment variable of the child process, never on a command line or in a file.
//
// Files written by the Electron version (safeStorage: "v10" + AES-256-GCM, its key DPAPI-protected in
// Electron's "Local State") are still read, and rewritten in the new form on first use (migrateFile).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function dpapi(op, b64) {
  const fn = op === 'protect' ? 'Protect' : 'Unprotect';
  const script = `Add-Type -AssemblyName System.Security; $b = [Security.Cryptography.ProtectedData]::${fn}([Convert]::FromBase64String($env:TTH_IN), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($b)`;
  const env = { ...process.env, TTH_IN: b64 };
  delete env.PSModulePath;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (r.status !== 0) throw new Error('DPAPI ' + op + ' failed: ' + String(r.stderr || r.error || '').trim().slice(0, 200));
  return Buffer.from(r.stdout.trim(), 'base64');
}

// legacyStates: candidate paths of Electron's "Local State" (holds the safeStorage key)
function makeVault({ legacyStates = [] } = {}) {
  let legacyKey;
  const cache = new Map(); // ciphertext (base64) → plaintext, so repeated reads don't start PowerShell again
  function oldKey() {
    if (legacyKey !== undefined) return legacyKey;
    legacyKey = null;
    for (const f of legacyStates) {
      try {
        const enc = Buffer.from(JSON.parse(fs.readFileSync(f, 'utf8')).os_crypt.encrypted_key, 'base64');
        if (enc.subarray(0, 5).toString() !== 'DPAPI') continue;
        legacyKey = dpapi('unprotect', enc.subarray(5).toString('base64'));
        break;
      } catch {}
    }
    return legacyKey;
  }
  const isLegacy = buf => buf.length > 31 && buf.subarray(0, 3).toString() === 'v10';
  const vault = {
    encrypt(s) {
      const out = dpapi('protect', Buffer.from(String(s), 'utf8').toString('base64'));
      cache.set(out.toString('base64'), String(s));
      return out;
    },
    decrypt(buf) {
      buf = Buffer.from(buf);
      const k = buf.toString('base64');
      if (cache.has(k)) return cache.get(k);
      let s;
      if (isLegacy(buf)) {
        const key = oldKey();
        if (!key) throw new Error('this file was protected by the earlier desktop version, whose key could not be found');
        const iv = buf.subarray(3, 15), tag = buf.subarray(buf.length - 16), ct = buf.subarray(15, buf.length - 16);
        const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
        d.setAuthTag(tag);
        s = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      } else s = dpapi('unprotect', k).toString('utf8');
      cache.set(k, s);
      return s;
    },
    isLegacy,
    // Rewrite an Electron-era file in this vault's form (atomically); returns true when it did
    migrateFile(file, writeAtomic) {
      if (!fs.existsSync(file)) return false;
      const buf = fs.readFileSync(file);
      if (!isLegacy(buf)) return false;
      const plain = vault.decrypt(buf);
      fs.copyFileSync(file, file + '.electron-backup');
      writeAtomic(file, vault.encrypt(plain));
      return true;
    },
  };
  return vault;
}

// Where the Electron version kept its "Local State" for a data folder
function legacyStatePaths(dataDir) {
  return [path.join(dataDir, 'electron', 'Local State'), path.join(process.env.APPDATA || '', 'tumblr-studio', 'Local State'), path.join(process.env.APPDATA || '', 'Tumblr Studio', 'Local State')];
}

module.exports = { makeVault, legacyStatePaths, dpapi };
