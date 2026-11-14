'use strict';
// A release to copy to another computer: the built local web app (run `npm run pack` first) and the browser
// extension, side by side, plus install notes, as a folder and a zip in desktop/release/.
// Nothing from the data folders (%APPDATA%\Tumblr Studio…) is included.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// A plain zip (deflate, UTF-8 names) written with Node only, so the release needs no outside tool.
function writeZip(file, base, top) {
  const files = [];
  const walk = rel => {
    const abs = path.join(base, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r); else files.push(r);
    }
  };
  walk(top);
  const fd = fs.openSync(file, 'w');
  const central = [];
  let offset = 0;
  const write = b => { fs.writeSync(fd, b); offset += b.length; };
  const dos = d => [((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff];
  for (const rel of files) {
    const data = fs.readFileSync(path.join(base, rel));
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
    const [t, d] = dos(fs.statSync(path.join(base, rel)).mtime);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(t, 10); h.writeUInt16LE(d, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    const at = offset;
    write(h); write(name); write(comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(t, 12); c.writeUInt16LE(d, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(at, 42);
    central.push(Buffer.concat([c, name]));
  }
  const cd = Buffer.concat(central);
  const start = offset;
  write(cd);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(start, 16);
  write(e);
  fs.closeSync(fd);
  if (offset > 0xffffffff || files.length > 0xffff) throw new Error('the release is too big for a plain zip');
}

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist', 'Tumblr Studio');
const extSrc = path.join(root, '..', 'extension');
const appVer = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const extVer = JSON.parse(fs.readFileSync(path.join(extSrc, 'manifest.json'), 'utf8')).version;
const built = (() => { try { return JSON.parse(fs.readFileSync(path.join(dist, 'app', 'package.json'), 'utf8')).version; } catch { return null; } })();
if (built !== appVer) { console.error(`dist is ${built || 'missing'}, package.json is ${appVer}: run "npm run pack" first`); process.exit(1); }
const rootVer = JSON.parse(fs.readFileSync(path.join(root, '..', 'package.json'), 'utf8')).version;
if (rootVer !== extVer) { console.error(`extension manifest is ${extVer}, package.json is ${rootVer}: run "npm test" in the repository root first`); process.exit(1); }

const name = `Tumblr Studio ${appVer} (extension ${extVer})`;
const outDir = path.join(root, 'release');
const out = path.join(outDir, name);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(dist, path.join(out, 'Tumblr Studio'), { recursive: true });
// Chrome writes _metadata (indexed rulesets) into an unpacked extension's folder and refuses to load one that has it
fs.cpSync(extSrc, path.join(out, 'Tumblr Studio Extension'), { recursive: true, filter: f => !path.relative(extSrc, f).split(path.sep).some(p => p.startsWith('_')) });

fs.writeFileSync(path.join(out, '安装说明 Install.txt'), [
  `Tumblr Studio ${appVer} + browser extension ${extVer}`,
  '',
  '【第一次安装】',
  '1. 把整个文件夹复制到一个固定位置（例如 D:\Tumblr Studio），以后不要再移动。',
  '2. 打开 Chrome，进入 chrome://extensions ，打开右上角“开发者模式”，',
  '   点“加载已解压的扩展程序”，选择 “Tumblr Studio Extension” 文件夹。',
  '3. 双击 “Tumblr Studio\Tumblr Studio.vbs”。第一次会问用哪个 Chrome 用户，选装了插件的那个。',
  '4. 在那个 Chrome 用户里点插件图标，按页面提示配对。',
  '',
  '【升级】',
  '1. 先运行 “Tumblr Studio\Stop Tumblr Studio.vbs” 停止后台。',
  '2. 用新版本的两个文件夹覆盖旧的（位置保持不变）。',
  '3. 在 chrome://extensions 里点插件上的 🔄 重新加载，再双击 Tumblr Studio.vbs。',
  '   位置不变就不用重新配对；换了位置，Chrome 会把它当成新插件，需要重新配对。',
  '',
  '数据在 %APPDATA%\Tumblr Studio ，不在这个文件夹里，覆盖升级不会丢数据。',
  '',
  '[First install] Copy this folder to a fixed place. In chrome://extensions turn on Developer mode, "Load unpacked",',
  'choose "Tumblr Studio Extension". Run "Tumblr Studio\Tumblr Studio.vbs" (the first time it asks which Chrome profile:',
  'pick the one with the extension), then click the extension icon in that profile and pair.',
  '[Upgrade] Run "Stop Tumblr Studio.vbs", replace both folders in place, reload the extension, run Tumblr Studio.vbs.',
  'Data lives in %APPDATA%\Tumblr Studio, not here.',
  '',
].join('\r\n'));

const zip = path.join(outDir, `Tumblr-Studio-${appVer}-extension-${extVer}.zip`);
fs.rmSync(zip, { force: true });
writeZip(zip, outDir, name);
console.log('folder: ' + out);
console.log('zip:    ' + zip + ` (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);
