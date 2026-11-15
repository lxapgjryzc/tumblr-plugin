'use strict';
// The everyday entry (LOCAL_WEB_APP_SPEC 2): reuses the environment's backend or starts it, waits until it
// answers, then opens the interface in the environment's Chrome profile with a one-time sign-in code.
//   node launcher.js open [--env work|test] [--real]   start if needed, open the page
//   node launcher.js background [--env …]              start if needed, no page (start with Windows)
//   node launcher.js stop [--env …]                    stop the backend (pages show "disconnected")
//   node launcher.js status [--env …]
//   node launcher.js bind <number|profile dir> [--env work]   choose the Chrome profile for the work environment
// Exit code 0 on success; otherwise the reason is written to the file in STUDIO_LAUNCH_MSG (the .vbs shows it).
// Exit code 3: no Chrome profile chosen yet; the message is the numbered list the .vbs asks from, then `bind`.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { envConfig } = require('./env');
const { readLock, alive, outdatedBackend } = require('./lock');
const { makeOpener, bindProfile, profiles, ChooseProfileError } = require('./chrome');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = require('../../package.json').version;
const outdated = l => outdatedBackend(l, VERSION, ROOT);

const args = process.argv.slice(2);
const cmd = args[0] || 'open';
const env = envConfig(args);

async function control(port, what) {
  const token = fs.readFileSync(path.join(env.dataDir, 'control.token'), 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${port}/control/${what}`, { method: 'POST', headers: { 'X-Studio-Control': token }, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// The running backend of this environment, checked by its control token (a different service on the port fails)
async function running() {
  const l = readLock(env.dataDir);
  if (!l || !alive(l.pid)) return null;
  if (l.kind !== 'web') throw new Error('the earlier desktop version (Electron) is running with this data. Quit it from its tray icon first. / 旧版桌面程序正在使用这份数据，请先从托盘退出它。');
  if (!l.port) return { starting: true };
  try { const s = await control(l.port, 'status'); return s.env === env.name ? { port: l.port, lock: l } : null; } catch { return { starting: true }; }
}

async function replaceOutdated(r) {
  await control(r.port, 'stop');
  for (let i = 0; i < 75; i++) {
    await new Promise(res => setTimeout(res, 200));
    if (!alive(r.lock.pid)) return;
  }
  throw new Error('the older background service did not stop. / 旧版后台没有停下来。');
}

async function ensure() {
  let r = await running();
  if (r?.port && outdated(r.lock)) { await replaceOutdated(r); r = null; }
  if (r?.port) return r.port;
  if (!r) {
    const a = ['--env', env.name, ...(args.includes('--real') ? ['--real'] : [])];
    const child = spawn(process.execPath, [path.join(__dirname, 'main.js'), ...a], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
  for (let i = 0; i < 100; i++) {
    await new Promise(res => setTimeout(res, 200));
    r = await running().catch(e => { throw e; });
    if (r?.port) return r.port;
  }
  let tail = '';
  try { tail = fs.readFileSync(path.join(env.dataDir, 'backend.log'), 'utf8').trim().split('\n').slice(-3).join('\n'); } catch {}
  throw new Error('the background service did not start. / 后台没有启动成功。\n' + tail);
}

// Chrome's profiles that can be chosen, in a stable order (the numbers `bind` takes)
const choices = () => profiles().filter(p => p.exists).sort((a, b) => a.dir.localeCompare(b.dir, 'en', { numeric: true }));
function chooseMessage(why) {
  return [why, '', 'Type the number of the Chrome profile to use for Tumblr Studio (the one with the extension installed):',
    '输入要用的 Chrome 用户的编号（装了扩展的那个）：', '',
    ...choices().map((p, i) => `${i + 1}   ${p.name}${p.user ? '  ' + p.user : ''}   (${p.dir})`)].join('\n');
}

async function main() {
  if (cmd === 'bind') {
    if (env.fixedProfile) throw new Error('the ' + env.name + ' environment always uses ' + env.fixedProfile);
    const want = String(args[1] || '').trim();
    const list = choices();
    const p = /^\d+$/.test(want) ? list[Number(want) - 1] : list.find(x => x.dir === want || x.name === want);
    if (!p) { const e = new ChooseProfileError(`“${want}” is not one of the numbers below. / 没有这个编号。`); throw e; }
    bindProfile(env.dataDir, p.dir);
    return `bound to ${p.dir} (${p.name})`;
  }
  if (cmd === 'stop') {
    const r = await running();
    if (r?.port) await control(r.port, 'stop');
    return r?.port ? 'stopped' : 'not running';
  }
  if (cmd === 'status') { const r = await running(); return r?.port ? `running on ${r.port}` : 'not running'; }
  // check the profile before anything starts, so a wrong profile never gets a page or a code
  const opener = makeOpener(env.dataDir, env.fixedProfile);
  if (cmd === 'open') opener.check();
  const port = await ensure();
  if (cmd === 'background') return 'running on ' + port;
  const { code } = await control(port, 'login-code');
  opener.open(`http://127.0.0.1:${port}/login?code=${code}`);
  return 'opened on ' + port;
}

// exitCode, not exit(): ending while a fetch socket is closing trips a libuv assertion on Windows
main().then(out => { console.log(out); process.exitCode = 0; }, e => {
  let msg = String(e?.message || e);
  if (e instanceof ChooseProfileError) { try { msg = chooseMessage(msg); } catch {} }
  console.error(msg);
  if (process.env.STUDIO_LAUNCH_MSG) try { fs.writeFileSync(process.env.STUDIO_LAUNCH_MSG, msg, 'utf8'); } catch {}
  process.exitCode = e instanceof ChooseProfileError ? 3 : 1;
});
