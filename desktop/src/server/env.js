'use strict';
// The two environments (LOCAL_WEB_APP_SPEC 2.1). Work: the user's data, in the Chrome profile the user chose for it
// on this computer (recorded in browser.json; asked on first open, `launcher.js bind`). Test (AI agents): its own
// data folder, port and Chrome "Profile 10", the made-up account unless --real. Never shared.
const fs = require('node:fs');
const path = require('node:path');

const APPDATA = () => process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const ENVS = {
  work: { name: 'work', dataDir: () => path.join(APPDATA(), 'Tumblr Studio'), ports: [47823, 47824], profileDir: null, test: false },
  test: { name: 'test', dataDir: () => path.join(APPDATA(), 'Tumblr Studio Test'), ports: [47825], profileDir: 'Profile 10', test: true },
};

function envConfig(args = []) {
  const i = args.indexOf('--env');
  const name = i >= 0 ? args[i + 1] : 'work';
  const e = ENVS[name];
  if (!e) throw new Error('unknown environment ' + name);
  const dataDir = e.test && process.env.STUDIO_DATA ? process.env.STUDIO_DATA : e.dataDir();
  return {
    ...e,
    profileDir: e.profileDir || boundProfile(dataDir), // for display; openers use fixedProfile
    fixedProfile: e.profileDir,
    // STUDIO_DATA moves a test environment only (development); the work folder stays where the user's data is
    dataDir,
    fake: e.test && !args.includes('--real'),
  };
}
// The profile the work environment was bound to on this computer (null: not chosen yet)
function boundProfile(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'browser.json'), 'utf8')).profileDir || null; } catch { return null; }
}

module.exports = { envConfig, ENVS };
