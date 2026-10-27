// Copies src/core.js to extension/core.js and writes the version from package.json into extension/manifest.json.
// Run: node build.js
const fs = require('fs');
const path = require('path');

const root = __dirname;
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.copyFileSync(path.join(root, 'src/core.js'), path.join(root, 'extension/core.js'));
const manifestPath = path.join(root, 'extension/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`built ${version}: extension/core.js, extension/manifest.json`);
