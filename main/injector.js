// Manages the persistent PowerShell injector sidecar (ps/injector.ps1).
// JSON-lines request/response with incrementing ids.
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

let proc = null;
let rl = null;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, timer}
let readyResolve = null;
let readyPromise = null;

function scriptPath() {
  // external processes cannot read inside app.asar; builder unpacks ps/
  return path.join(__dirname, '..', 'ps', 'injector.ps1').replace('app.asar', 'app.asar.unpacked');
}

function start() {
  if (proc) return readyPromise;
  readyPromise = new Promise((res) => { readyResolve = res; });
  proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
    '-File', scriptPath(),
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'ready' && readyResolve) {
      readyResolve();
      readyResolve = null;
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(msg.error || 'injector error'));
      else p.resolve(msg);
    }
  });

  proc.stderr.on('data', (d) => console.error('[injector]', d.toString().slice(0, 500)));
  proc.on('exit', (code) => {
    console.error('[injector] exited', code);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('injector died')); }
    pending.clear();
    proc = null;
    rl = null;
  });
  return readyPromise;
}

async function request(cmd, extra = {}, timeoutMs = 15000) {
  if (!proc) {
    start();
  }
  await readyPromise;
  const id = nextId++;
  const payload = JSON.stringify({ cmd, id, ...extra });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`injector ${cmd} timeout`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(payload + '\n');
  });
}

async function typeText(text) { return request('type', { text }, 60000); }
async function pasteText(text) { return request('paste', { text }); }
async function pressEnter() { return request('enter'); }
async function copySelection() {
  const r = await request('copy');
  return r.text || '';
}
async function foreground() {
  try {
    const r = await request('fg', {}, 3000);
    return { exe: (r.exe || '').toLowerCase(), title: r.title || '' };
  } catch {
    return { exe: '', title: '' };
  }
}

function stop() {
  if (!proc) return;
  try { proc.stdin.write(JSON.stringify({ cmd: 'quit', id: nextId++ }) + '\n'); } catch {}
  const p = proc;
  setTimeout(() => { try { p.kill(); } catch {} }, 500);
  proc = null;
}

module.exports = { start, typeText, pasteText, pressEnter, copySelection, foreground, stop };
