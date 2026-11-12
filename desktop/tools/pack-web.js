'use strict';
// Builds the local web version (docs/LOCAL_WEB_APP_SPEC.md) into dist/Tumblr Studio/:
//   Tumblr Studio.vbs          everyday entry: start or reuse the work backend, open the page in Chrome "Profile 1"
//   Stop Tumblr Studio.vbs     stop the work backend
//   Tumblr Studio Test.vbs     AI-testing entry: separate test backend (made-up data), Chrome "Profile 10"
//   runtime/node.exe           the Node runtime (no installation needed)
//   app/                       the backend, the interface, the companion page, packs, and the made-up test account
// The data folders are not touched: work data stays in %APPDATA%\Tumblr Studio, test data in …\Tumblr Studio Test.
// With --shortcuts, a "Tumblr Studio" shortcut to the everyday entry is put on the desktop and in the Start menu.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'Tumblr Studio');
const app = path.join(out, 'app');
const cp = (from, to) => fs.cpSync(from, to, { recursive: true });

// the shared extension core, the companion page and the maintained packs, as for the Electron build
fs.copyFileSync(path.join(root, '..', 'src', 'core.js'), path.join(root, 'src', 'service', 'tthcore.js'));
fs.rmSync(path.join(root, 'src', 'companion'), { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'src', 'companion'));
for (const f of ['companion.html', 'companion.js', 'companion.css', 'companion-ops.js']) fs.copyFileSync(path.join(root, '..', 'extension', f), path.join(root, 'src', 'companion', f));
fs.copyFileSync(path.join(root, '..', 'src', 'core.js'), path.join(root, 'src', 'companion', 'core.js'));
fs.rmSync(path.join(root, 'src', 'service', 'packs'), { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'packs'), path.join(root, 'src', 'service', 'packs'), { recursive: true });

// a running backend holds files in app/: stop it first (the launcher does that with "stop")
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(path.join(app, 'test'), { recursive: true });
for (const d of ['service', 'server', 'renderer', 'companion']) cp(path.join(root, 'src', d), path.join(app, 'src', d));
for (const f of ['demo.js', 'fake-tumblr.js']) fs.copyFileSync(path.join(root, 'test', f), path.join(app, 'test', f)); // the test environment's made-up account
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, main: 'src/server/main.js', dependencies: pkg.dependencies }, null, 2));
for (const dep of Object.keys(pkg.dependencies || {})) cp(path.join(root, 'node_modules', dep), path.join(app, 'node_modules', dep));

fs.mkdirSync(path.join(out, 'runtime'), { recursive: true });
const nodeExe = path.join(out, 'runtime', 'node.exe');
if (!fs.existsSync(nodeExe) || fs.statSync(nodeExe).size !== fs.statSync(process.execPath).size) fs.copyFileSync(process.execPath, nodeExe);

// Windows Script Host runs the launcher without a console window and shows its message if it fails
const vbs = (cmd, env) => `' Tumblr Studio launcher (${env}): ${cmd}
Option Explicit
Dim sh, fso, dir, msgFile, rc, st, arg, ans
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
arg = "${cmd}"
If WScript.Arguments.Count > 0 Then arg = WScript.Arguments(0)
msgFile = sh.ExpandEnvironmentStrings("%TEMP%") & "\\tumblr-studio-${env}-launch.txt"
sh.Environment("Process")("STUDIO_LAUNCH_MSG") = msgFile
rc = Launch(arg)
' 3: no Chrome profile chosen for Tumblr Studio on this computer yet: ask which one, record it, try again
Do While rc = 3
  ans = Trim(InputBox(ReadMsg(), "Tumblr Studio"))
  If ans = "" Then WScript.Quit 0
  rc = Launch("bind """ & Replace(ans, """", "") & """")
  If rc = 0 Then rc = Launch(arg)
Loop
If rc <> 0 Then MsgBox ReadMsg(), 48, "Tumblr Studio${env === 'test' ? ' (test)' : ''}"

Function Launch(a)
  If fso.FileExists(msgFile) Then fso.DeleteFile msgFile
  Launch = sh.Run("""" & dir & "\\runtime\\node.exe"" """ & dir & "\\app\\src\\server\\launcher.js"" " & a & " --env ${env}", 0, True)
End Function

Function ReadMsg()
  ReadMsg = "Tumblr Studio could not start."
  If fso.FileExists(msgFile) Then
    Set st = CreateObject("ADODB.Stream")
    st.Type = 2: st.Charset = "utf-8": st.Open: st.LoadFromFile msgFile
    ReadMsg = st.ReadText: st.Close
  End If
End Function
`;
const write = (f, s) => fs.writeFileSync(path.join(out, f), s.replace(/\n/g, '\r\n'), 'latin1');
write('Tumblr Studio.vbs', vbs('open', 'work'));
write('Stop Tumblr Studio.vbs', vbs('stop', 'work'));
write('Tumblr Studio Test.vbs', vbs('open', 'test'));
fs.writeFileSync(path.join(out, 'README.txt'), [
  'Tumblr Studio (local web version)',
  '',
  'Tumblr Studio.vbs        Open Tumblr Studio (starts the background service if needed; Chrome "Profile 1").',
  'Stop Tumblr Studio.vbs   Stop the background service. Closing the page or Chrome does not stop it.',
  'Tumblr Studio Test.vbs   Test environment for AI agents: separate made-up data, Chrome "Profile 10".',
  '',
  '打开 Tumblr Studio.vbs 即可使用；关闭网页或浏览器不会停止后台。停止后台请用 Stop Tumblr Studio.vbs 或设置页。',
  '数据在 %APPDATA%\\Tumblr Studio（测试环境在 %APPDATA%\\Tumblr Studio Test）。',
].join('\r\n'));

if (process.argv.includes('--shortcuts')) {
  const ps = `$s = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $l = $s.CreateShortcut((Join-Path $dir 'Tumblr Studio.lnk'))
  $l.TargetPath = "$env:WINDIR\\System32\\wscript.exe"
  $l.Arguments = '"' + $env:TTH_VBS + '"'
  $l.WorkingDirectory = $env:TTH_DIR
  $l.IconLocation = $env:TTH_ICON
  $l.Description = 'Tumblr Studio'
  $l.Save()
}`;
  // an .ico that embeds the 256px PNG (Windows Vista and later read PNG entries)
  const ico = path.join(out, 'Tumblr Studio.ico');
  const pngBuf = fs.readFileSync(path.join(app, 'src', 'renderer', 'icon.png'));
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(0, 6); head.writeUInt8(0, 7); head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(pngBuf.length, 14); head.writeUInt32LE(22, 18);
  fs.writeFileSync(ico, Buffer.concat([head, pngBuf]));
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', env: { ...process.env, TTH_VBS: path.join(out, 'Tumblr Studio.vbs'), TTH_DIR: out, TTH_ICON: ico } });
  console.log(r.status === 0 ? 'shortcuts: desktop and Start menu' : 'shortcuts failed: ' + r.stderr);
}
console.log('built:', out);
