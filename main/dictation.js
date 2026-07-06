// The dictation pipeline: record -> transcribe -> clean -> inject -> history.
// Also drives the overlay state display.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const settings = require('./settings');
const stt = require('./stt');
const cleanup = require('./cleanup');
const llm = require('./llm');
const injector = require('./injector');
const db = require('./db');
const windows = require('./windows');
const hotkeys = require('./hotkeys');

let mode = null;            // 'dictate' | 'command' | null
let fgInfo = { exe: '', title: '' };
let cmdSelection = '';
let recordStartTs = 0;
let audioResolve = null;

function overlaySend(channel, payload) {
  const ov = windows.getOverlay();
  if (ov) ov.webContents.send(channel, payload);
}

let flashTimer = null;
function setOverlayState(state, detail = '') {
  if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
  overlaySend('state', { state, detail, mode });
  if (state === 'hidden') windows.hideOverlay();
  else windows.showOverlay();
}

function flashOverlay(state, detail, ms = 1800) {
  setOverlayState(state, detail);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    setOverlayState('hidden');
  }, ms);
}

// ---- recording control (audio captured in overlay renderer) ----
function startRecording() {
  const cfg = settings.load();
  recordStartTs = Date.now();
  overlaySend('rec:start', { deviceId: cfg.mic || 'default', processing: cfg.micProcessing !== false });
}

function stopRecording() {
  return new Promise((resolve, reject) => {
    audioResolve = { resolve, reject };
    overlaySend('rec:stop', {});
    setTimeout(() => {
      if (audioResolve) {
        audioResolve = null;
        reject(new Error('audio capture timeout'));
      }
    }, 10000);
  });
}

function cancelRecording() {
  overlaySend('rec:cancel', {});
  audioResolve = null;
}

// Called from IPC when the overlay renderer delivers the WAV buffer.
function onAudioData(buf) {
  if (audioResolve) {
    const r = audioResolve;
    audioResolve = null;
    r.resolve(Buffer.from(buf));
  }
}

function onAudioError(msg) {
  if (audioResolve) {
    const r = audioResolve;
    audioResolve = null;
    r.reject(new Error(msg || 'audio error'));
  } else {
    flashOverlay('error', msg || 'Microphone error');
    hotkeys.release();
    mode = null;
  }
}

// ---- style matching ----
function styleFor(exe) {
  try {
    const styles = db.listStyles();
    let fallback = null;
    for (const s of styles) {
      if (s.name === 'Default') fallback = s;
      let apps = [];
      try { apps = JSON.parse(s.apps || '[]'); } catch {}
      if (apps.some((a) => a && exe.includes(a.toLowerCase()))) return s;
    }
    return fallback;
  } catch {
    return null;
  }
}

// ---- gesture handlers ----
async function onDictateStart() {
  mode = 'dictate';
  fgInfo = await injector.foreground();
  setOverlayState('listening');
  startRecording();
}

async function onCommandStart() {
  mode = 'command';
  fgInfo = await injector.foreground();
  setOverlayState('listening', 'Command');
  startRecording();
  // grab the selection while the user is speaking
  try { cmdSelection = await injector.copySelection(); } catch { cmdSelection = ''; }
}

async function onDictateStop() {
  await finish('dictate');
}

async function onCommandStop() {
  await finish('command');
}

function onDictateCancel() {
  cancelRecording();
  setOverlayState('hidden');
  mode = null;
  hotkeys.release();
}

async function finish(kind) {
  const durationMs = Date.now() - recordStartTs;
  try {
    setOverlayState('processing');
    const wav = await stopRecording();

    if (durationMs < 350 || wav.length < 8000) {
      flashOverlay('error', 'Too short');
      return;
    }

    const tmp = path.join(os.tmpdir(), `pieflow-${Date.now()}.wav`);
    fs.writeFileSync(tmp, wav);
    // keep the last capture around for mic troubleshooting
    try {
      fs.copyFileSync(tmp, path.join(app.getPath('userData'), 'last-capture.wav'));
      let sum = 0;
      for (let i = 44; i < wav.length - 1; i += 2) { const v = wav.readInt16LE(i); sum += v * v; }
      const rms = Math.sqrt(sum / ((wav.length - 44) / 2)) / 32768;
      console.log(`[dictation] captured ${((wav.length - 44) / 32000).toFixed(1)}s audio, rms=${rms.toFixed(4)}`);
    } catch {}

    let dictWords = [];
    try { dictWords = db.listDictionary().map((d) => d.word); } catch {}
    const prompt = dictWords.length ? `Glossary: ${dictWords.slice(0, 60).join(', ')}.` : null;

    let tr;
    try {
      tr = await stt.transcribe(tmp, { prompt });
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }

    const raw = (tr.text || '').trim();
    console.log(`[dictation] ${kind} transcript (${tr.engine}, ${tr.language}): ${raw.slice(0, 200)}`);
    if (!raw) {
      flashOverlay('error', 'No speech detected');
      return;
    }

    if (kind === 'dictate') {
      await handleDictation(raw, tr, durationMs);
    } else {
      await handleCommand(raw, tr, durationMs);
    }
  } catch (e) {
    console.error('[dictation]', e);
    flashOverlay('error', shortErr(e));
  } finally {
    mode = null;
    hotkeys.release();
  }
}

async function handleDictation(raw, tr, durationMs) {
  const style = styleFor(fgInfo.exe);

  // snippet triggers fire on the raw phrase, before any cleanup
  const snip = cleanup.matchSnippet(raw);
  let text, submit = false, engine = 'snippet';
  if (snip) {
    text = snip.content;
    db.bumpSnippetUse(snip.id);
  } else {
    const res = await cleanup.clean(raw, { style });
    text = res.text;
    submit = res.submit;
    engine = res.engine;
  }

  if (!text) {
    flashOverlay('error', 'Nothing to type');
    return;
  }

  console.log(`[dictation] cleaned (${engine}): ${text.slice(0, 200)}${submit ? ' [+enter]' : ''}`);
  setOverlayState('inserting');
  await inject(text);
  if (submit) {
    await new Promise((r) => setTimeout(r, 120));
    await injector.pressEnter();
  }

  const words = text.split(/\s+/).filter(Boolean).length;
  const audioSec = tr.duration || durationMs / 1000;
  db.addHistory({
    ts: Date.now(),
    raw_text: raw,
    clean_text: text,
    app_exe: fgInfo.exe,
    app_title: fgInfo.title,
    duration_ms: Math.round(audioSec * 1000),
    words,
    wpm: audioSec > 1 ? Math.round((words / audioSec) * 60) : 0,
    mode: 'dictate',
    language: tr.language || '',
  });
  notifyDashboard();
  flashOverlay('done', '', 900);
}

async function handleCommand(raw, tr, durationMs) {
  if (!cmdSelection) {
    flashOverlay('error', 'No text selected');
    return;
  }
  const canLlm = await llm.available();
  if (!canLlm) {
    flashOverlay('error', 'Command Mode needs an LLM (start Ollama or add a key in Settings)', 3200);
    return;
  }

  // spoken instruction may match a saved transform by name
  let instruction = raw;
  try {
    const norm = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    const t = db.listTransforms().find((x) => norm === x.name.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim());
    if (t) instruction = t.instruction;
  } catch {}

  setOverlayState('processing', 'Rewriting');
  const sys = `You rewrite text according to the user's instruction.
Output ONLY the rewritten text. No quotes, no preamble, no commentary.
Preserve the original formatting style (line breaks, markdown) unless the instruction says otherwise.`;
  const user = `Instruction: ${instruction}\n\nText:\n${cmdSelection}`;
  // command mode is explicit, so allow slow local models plenty of time
  const out = await llm.chat(sys, user, { maxTokens: Math.max(512, cmdSelection.length), temperature: 0.3, timeoutMs: 180000 });
  if (!out) {
    flashOverlay('error', 'LLM returned nothing');
    return;
  }

  setOverlayState('inserting');
  await injector.pasteText(out); // replaces the still-active selection

  db.addHistory({
    ts: Date.now(),
    raw_text: `[${raw}] ${cmdSelection.slice(0, 400)}`,
    clean_text: out,
    app_exe: fgInfo.exe,
    app_title: fgInfo.title,
    duration_ms: durationMs,
    words: out.split(/\s+/).filter(Boolean).length,
    wpm: 0,
    mode: 'command',
    language: tr.language || '',
  });
  notifyDashboard();
  flashOverlay('done', '', 900);
  cmdSelection = '';
}

async function inject(text) {
  const cfg = settings.load();
  const method = cfg.typing.method || 'auto';
  const threshold = cfg.typing.pasteThreshold || 60;
  const usePaste = method === 'paste' || (method === 'auto' && text.length > threshold);
  if (usePaste) {
    try {
      await injector.pasteText(text);
      return;
    } catch (e) {
      console.error('[inject] paste failed, falling back to type:', e.message);
    }
  }
  await injector.typeText(text);
}

function notifyDashboard() {
  const d = windows.getDashboard();
  if (d) d.webContents.send('history:changed');
}

function shortErr(e) {
  const m = (e && e.message) || 'Something went wrong';
  return m.length > 90 ? m.slice(0, 90) + '...' : m;
}

// Demo/test path: run the pipeline on provided text (no audio), inject after a delay.
async function testInject(text, delayMs = 3000) {
  await new Promise((r) => setTimeout(r, delayMs));
  fgInfo = await injector.foreground();
  const style = styleFor(fgInfo.exe);
  const res = await cleanup.clean(text, { style });
  setOverlayState('inserting');
  await inject(res.text);
  if (res.submit) await injector.pressEnter();
  flashOverlay('done', '', 900);
  return res;
}

// Test path: run a WAV file through the exact production pipeline
// (transcribe -> clean -> inject into the focused app -> history).
async function testDictateWav(wavPath) {
  mode = 'dictate';
  fgInfo = await injector.foreground();
  recordStartTs = Date.now();
  setOverlayState('processing');
  let dictWords = [];
  try { dictWords = db.listDictionary().map((d) => d.word); } catch {}
  const prompt = dictWords.length ? `Glossary: ${dictWords.slice(0, 60).join(', ')}.` : null;
  const tr = await stt.transcribe(wavPath, { prompt });
  const raw = (tr.text || '').trim();
  console.log(`[test] transcript (${tr.engine}): ${raw}`);
  if (!raw) { flashOverlay('error', 'No speech in test wav'); mode = null; return null; }
  await handleDictation(raw, tr, tr.duration * 1000 || 5000);
  mode = null;
  return raw;
}

// Test path for Command Mode: text must already be selected in the focused
// app; the WAV carries the spoken instruction.
async function testCommandWav(wavPath) {
  mode = 'command';
  fgInfo = await injector.foreground();
  recordStartTs = Date.now();
  cmdSelection = await injector.copySelection();
  console.log(`[test] command selection (${cmdSelection.length} chars): ${cmdSelection.slice(0, 80)}`);
  const tr = await stt.transcribe(wavPath, {});
  const raw = (tr.text || '').trim();
  console.log(`[test] command instruction: ${raw}`);
  await handleCommand(raw, tr, 3000);
  mode = null;
}

module.exports = {
  onDictateStart, onDictateStop, onDictateCancel,
  onCommandStart, onCommandStop,
  onAudioData, onAudioError,
  testInject, testDictateWav, testCommandWav,
};
