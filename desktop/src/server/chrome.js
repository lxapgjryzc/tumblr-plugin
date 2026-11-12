'use strict';
// Opening pages in the right Chrome profile (docs/LOCAL_WEB_APP_SPEC.md 2.1): the work backend uses the user's
// daily profile ("Profile 1"), the test backend the AI-testing profile ("Profile 10"). Every browser step of an
// environment (the local UI, Tumblr authorisation, "open on Tumblr") goes through open() with that
// environment's binding. There is no fallback: if Chrome or the profile can't be confirmed, open() throws and
// nothing is opened, never the default browser or another profile.
//
// The binding is checked against Chrome's own profile list ("Local State" → profile.info_cache) and stored in
// the environment's data folder the first time; later runs refuse if the profile's name or signed-in user no
// longer match what was stored (a renamed or recreated profile needs a deliberate re-bind).

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const USER_DATA = () => path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');

function findChrome() {
  for (const hive of ['HKCU', 'HKLM']) {
    const r = spawnSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve'], { encoding: 'utf8', windowsHide: true });
    const m = /REG_SZ\s+(.+chrome\.exe)/i.exec(r.stdout || '');
    if (m && fs.existsSync(m[1].trim())) return m[1].trim();
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    const p = base && path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function profiles(userData = USER_DATA()) {
  const ls = JSON.parse(fs.readFileSync(path.join(userData, 'Local State'), 'utf8'));
  const cache = ls?.profile?.info_cache || {};
  return Object.entries(cache).map(([dir, p]) => ({ dir, name: p.name || '', user: p.user_name || '', exists: fs.existsSync(path.join(userData, dir)) }));
}

// Check (and on first use record) the binding of an environment to one profile directory
function verifyBinding(dataDir, profileDir, { userData = USER_DATA(), chrome = findChrome() } = {}) {
  if (!chrome) throw new Error('Google Chrome was not found');
  let list;
  try { list = profiles(userData); } catch (e) { throw new Error('Chrome’s profile list could not be read (' + e.message + ')'); }
  const p = list.find(x => x.dir === profileDir);
  if (!p || !p.exists) throw new Error(`Chrome profile “${profileDir}” does not exist; nothing was opened`);
  const file = path.join(dataDir, 'browser.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (saved && saved.profileDir === profileDir && (saved.name !== p.name || saved.user !== p.user)) {
    throw new Error(`Chrome profile “${profileDir}” changed (was “${saved.name}” ${saved.user}, now “${p.name}” ${p.user}); confirm it before it is used again`);
  }
  if (!saved || saved.profileDir !== profileDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ profileDir, name: p.name, user: p.user, userData, chrome, boundAt: new Date().toISOString() }, null, 2));
  }
  return { chrome, profileDir, name: p.name, user: p.user };
}

// No profile chosen yet for an environment (work, on a new computer): the launcher asks which one (exit code 3)
class ChooseProfileError extends Error {}
const boundDir = dataDir => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'browser.json'), 'utf8')).profileDir || null; } catch { return null; } };

// profileDir null: the profile recorded for this data folder, read at each use (so a choice made while the
// backend runs applies at once)
function makeOpener(dataDir, profileDir) {
  const dir = () => {
    const d = profileDir || boundDir(dataDir);
    if (!d) throw new ChooseProfileError('No Chrome profile has been chosen for Tumblr Studio on this computer yet. / 这台电脑上还没有选择 Tumblr Studio 用哪个 Chrome 用户。');
    return d;
  };
  return {
    open(url) {
      if (!/^https?:\/\//.test(url)) throw new Error('only web addresses are opened');
      const d = dir();
      const b = verifyBinding(dataDir, d);
      const child = spawn(b.chrome, [`--profile-directory=${d}`, url], { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', () => {});
      child.unref();
      return b;
    },
    check: () => verifyBinding(dataDir, dir()),
  };
}

// The user's deliberate choice of profile for a data folder (replaces an earlier one)
function bindProfile(dataDir, profileDir, { userData = USER_DATA(), chrome = findChrome() } = {}) {
  const p = profiles(userData).find(x => x.dir === profileDir);
  if (!p || !p.exists) throw new Error(`Chrome profile “${profileDir}” does not exist`);
  fs.rmSync(path.join(dataDir, 'browser.json'), { force: true });
  return verifyBinding(dataDir, profileDir, { userData, chrome });
}

module.exports = { makeOpener, verifyBinding, bindProfile, profiles, findChrome, USER_DATA, ChooseProfileError };
