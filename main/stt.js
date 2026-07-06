// Speech-to-text: local faster-whisper sidecar (default, free) with optional
// OpenAI / Groq cloud engines when the user adds a key.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { app } = require('electron');
const settings = require('./settings');

let proc = null;
let nextId = 1;
const pending = new Map();
let status = { state: 'idle', detail: '', model: null, pythonFound: null, venvReady: false };
let statusListeners = [];
let loadedModel = null;
let loadPromise = null;

function onStatus(fn) { statusListeners.push(fn); }
function setStatus(patch) {
  status = { ...status, ...patch };
  for (const fn of statusListeners) fn(status);
}
function getStatus() { return status; }

function venvDir() { return path.join(app.getPath('userData'), 'stt-venv'); }
function venvPython() { return path.join(venvDir(), 'Scripts', 'python.exe'); }
function serverScript() {
  // external python cannot read inside app.asar; builder unpacks python/
  return path.join(__dirname, '..', 'python', 'stt_server.py').replace('app.asar', 'app.asar.unpacked');
}

function findSystemPython() {
  const candidates = [
    ['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']],
    ['python', []], ['py', ['-3']], ['python3', []],
  ];
  for (const [cmd, args] of candidates) {
    try {
      const r = spawnSync(cmd, [...args, '--version'], { timeout: 8000, windowsHide: true });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const m = out.match(/Python (3)\.(\d+)/);
      if (m && +m[2] >= 9) return { cmd, args };
    } catch {}
  }
  return null;
}

// Create venv + pip install faster-whisper. Slow on first run; reports progress.
async function ensureSetup() {
  if (fs.existsSync(venvPython())) {
    setStatus({ venvReady: true, pythonFound: true });
    return true;
  }
  const py = findSystemPython();
  if (!py) {
    setStatus({ pythonFound: false, state: 'error', detail: 'Python 3.9+ not found. Install from python.org, then restart PieFlow.' });
    return false;
  }
  setStatus({ pythonFound: true, state: 'setup', detail: 'Creating Python environment (one-time)...' });
  await execP(py.cmd, [...py.args, '-m', 'venv', venvDir()]);
  setStatus({ state: 'setup', detail: 'Installing faster-whisper (one-time, a few minutes)...' });
  await execP(venvPython(), ['-m', 'pip', 'install', '--quiet', 'faster-whisper']);
  setStatus({ venvReady: true, state: 'idle', detail: '' });
  return true;
}

function execP(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
    p.on('error', reject);
  });
}

function startSidecar() {
  if (proc) return;
  proc = spawn(venvPython(), ['-u', serverScript()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'loading') setStatus({ state: 'loading-model', detail: `Loading Whisper model "${msg.model}" (downloads on first use)...` });
    if (msg.event === 'loaded') { loadedModel = msg.model; setStatus({ state: 'ready', model: msg.model, detail: '' }); }
    if (msg.event === 'error') console.error('[stt]', msg.error);
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(new Error(msg.error || 'stt error'));
    }
  });
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    // pip/hf progress noise is fine; surface real tracebacks only
    if (/Traceback|Error/i.test(s)) console.error('[stt-err]', s.slice(0, 800));
  });
  proc.on('exit', (code) => {
    console.error('[stt] sidecar exited', code);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('stt sidecar died')); }
    pending.clear();
    proc = null;
    loadedModel = null;
    loadPromise = null;
    if (status.state !== 'error') setStatus({ state: 'idle', model: null });
  });
}

function send(obj) {
  proc.stdin.write(JSON.stringify(obj) + '\n');
}

function requestSidecar(payload, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('stt timeout')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ ...payload, id });
  });
}

async function ensureModel() {
  const cfg = settings.load();
  const model = cfg.stt.model || 'base';
  const ok = await ensureSetup();
  if (!ok) throw new Error('Local STT unavailable: Python not found. Add an OpenAI or Groq key in Settings, or install Python.');
  startSidecar();
  if (loadedModel === model) return;
  if (!loadPromise || loadPromise.model !== model) {
    setStatus({ state: 'loading-model', detail: `Loading Whisper "${model}"...` });
    const p = new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (loadedModel === model) { clearInterval(check); resolve(); }
        if (!proc) { clearInterval(check); reject(new Error('stt sidecar died during model load')); }
      }, 300);
      send({ cmd: 'load', model, device: 'auto', compute: 'auto' });
    });
    p.model = model;
    loadPromise = p;
  }
  await loadPromise;
}

async function transcribeLocal(wavPath, { language, prompt } = {}) {
  await ensureModel();
  setStatus({ state: 'transcribing' });
  try {
    const r = await requestSidecar({
      cmd: 'transcribe',
      path: wavPath,
      language: language && language !== 'auto' ? language : null,
      prompt: prompt || null,
    });
    return { text: r.text, language: r.language, duration: r.duration, engine: 'local' };
  } finally {
    setStatus({ state: 'ready' });
  }
}

async function transcribeCloud(wavPath, provider, { language } = {}) {
  const keys = settings.getKeys();
  const conf = provider === 'groq'
    ? { url: 'https://api.groq.com/openai/v1/audio/transcriptions', key: keys.groq, model: 'whisper-large-v3-turbo' }
    : { url: 'https://api.openai.com/v1/audio/transcriptions', key: keys.openai, model: 'whisper-1' };
  if (!conf.key) throw new Error(`${provider} key not set`);
  const buf = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', conf.model);
  if (language && language !== 'auto') form.append('language', language);
  const res = await fetch(conf.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${conf.key}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`${provider} STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { text: (j.text || '').trim(), language: j.language || language || '', duration: 0, engine: provider };
}

// Engine selection: explicit setting wins; 'auto' prefers a configured cloud
// key (faster), falls back to local. Cloud failure falls back to local too.
async function transcribe(wavPath, opts = {}) {
  const cfg = settings.load();
  const keys = settings.getKeys();
  const engine = cfg.stt.engine;
  const language = opts.language || cfg.stt.language;

  const tryOrder = [];
  if (engine === 'openai') tryOrder.push('openai', 'local');
  else if (engine === 'groq') tryOrder.push('groq', 'local');
  else if (engine === 'local') tryOrder.push('local');
  else { // auto
    if (keys.groq) tryOrder.push('groq');
    if (keys.openai) tryOrder.push('openai');
    tryOrder.push('local');
  }

  let lastErr = null;
  for (const eng of tryOrder) {
    try {
      if (eng === 'local') return await transcribeLocal(wavPath, { ...opts, language });
      return await transcribeCloud(wavPath, eng, { language });
    } catch (e) {
      lastErr = e;
      console.error(`[stt] ${eng} failed:`, e.message);
    }
  }
  throw lastErr || new Error('no STT engine available');
}

// Warm up in the background at app start so the first dictation is fast.
async function warmUp() {
  try { await ensureModel(); } catch (e) { console.error('[stt] warmup:', e.message); }
}

function stop() {
  if (proc) { try { send({ cmd: 'quit' }); } catch {} setTimeout(() => { try { proc && proc.kill(); } catch {} }, 500); }
}

module.exports = { transcribe, warmUp, ensureSetup, getStatus, onStatus, stop };
