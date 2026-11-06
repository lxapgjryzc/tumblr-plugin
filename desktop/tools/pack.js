'use strict';
// Builds a folder with "Tumblr Studio.exe" (no Node or toolchain needed to run it):
// copies the shared extension core and the maintained packs in, then runs @electron/packager.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
fs.copyFileSync(path.join(root, '..', 'src', 'core.js'), path.join(root, 'src', 'service', 'tthcore.js'));
// the companion page the app serves at http://127.0.0.1:<port>/companion/
fs.rmSync(path.join(root, 'src', 'companion'), { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'src', 'companion'));
for (const f of ['companion.html', 'companion.js', 'companion.css', 'companion-ops.js']) fs.copyFileSync(path.join(root, '..', 'extension', f), path.join(root, 'src', 'companion', f));
fs.copyFileSync(path.join(root, '..', 'src', 'core.js'), path.join(root, 'src', 'companion', 'core.js'));
fs.rmSync(path.join(root, 'src', 'service', 'packs'), { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'packs'), path.join(root, 'src', 'service', 'packs'), { recursive: true });
(async () => {
  const { packager } = require('@electron/packager');
  const out = await packager({
    dir: root, out: path.join(root, 'dist'), overwrite: true, asar: true, platform: 'win32', arch: 'x64',
    name: 'Tumblr Studio', executableName: 'Tumblr Studio', appCopyright: 'MIT',
    ignore: [/^\/test(\/|$)/, /^\/tools(\/|$)/, /^\/dist(\/|$)/, /^\/README\.md$/],
  });
  console.log('built:', out.join(', '));
})().catch(e => { console.error(e); process.exit(1); });
