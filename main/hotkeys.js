// Global hotkeys via uiohook-napi: real keydown/keyup, so push-to-talk works.
// Gestures on the dictation combo:
//   hold (>=280ms)          press-and-hold dictation, stops on release
//   double-tap (<280ms x2)  hands-free dictation, any later tap stops it
// Command combo: hold to speak an instruction over selected text.
const { uIOhook, UiohookKey } = require('uiohook-napi');
const settings = require('./settings');

const HOLD_MS = 280;
const DOUBLE_TAP_MS = 450;

const DEFAULT_HOTKEY = { keycode: UiohookKey.Space, ctrl: true, shift: true, alt: false, label: 'Ctrl + Shift + Space' };
const DEFAULT_CMD_HOTKEY = { keycode: UiohookKey.K, ctrl: true, shift: true, alt: false, label: 'Ctrl + Shift + K' };

let handlers = { onDictateStart: null, onDictateStop: null, onDictateCancel: null, onCommandStart: null, onCommandStop: null };
let state = 'idle'; // idle | ptt | handsfree | cmd
let pressAt = 0;
let lastTapAt = 0;
let captureCb = null;
let started = false;

const KEYNAMES = {};
for (const [name, code] of Object.entries(UiohookKey)) {
  if (typeof code === 'number' && !(code in KEYNAMES)) KEYNAMES[code] = name;
}

function combo(cfg) {
  return cfg || null;
}

// uiohook's e.ctrlKey / e.shiftKey flags are unreliable on Windows (observed:
// ctrlKey stays false while Ctrl is physically held). Track held modifiers
// ourselves from raw keycodes instead.
const K = UiohookKey;
const held = new Set();
const CTRL_KEYS = [K.Ctrl, K.CtrlRight];
const SHIFT_KEYS = [K.Shift, K.ShiftRight];
const ALT_KEYS = [K.Alt, K.AltRight];
const META_KEYS = [K.Meta, K.MetaRight];

function modsNow() {
  return {
    ctrl: CTRL_KEYS.some((k) => held.has(k)),
    shift: SHIFT_KEYS.some((k) => held.has(k)),
    alt: ALT_KEYS.some((k) => held.has(k)),
  };
}

function matches(e, cfg) {
  if (!cfg) return false;
  const m = modsNow();
  return e.keycode === cfg.keycode &&
    m.ctrl === !!cfg.ctrl &&
    m.shift === !!cfg.shift &&
    m.alt === !!cfg.alt;
}

function isModifier(keycode) {
  return [...CTRL_KEYS, ...SHIFT_KEYS, ...ALT_KEYS, ...META_KEYS].includes(keycode);
}

function labelFor(e) {
  const m = modsNow();
  const parts = [];
  if (m.ctrl) parts.push('Ctrl');
  if (m.shift) parts.push('Shift');
  if (m.alt) parts.push('Alt');
  parts.push(KEYNAMES[e.keycode] || `Key${e.keycode}`);
  return parts.join(' + ');
}

function ensureDefaults() {
  const cfg = settings.load();
  const patch = {};
  if (!cfg.hotkey) patch.hotkey = DEFAULT_HOTKEY;
  if (!cfg.commandHotkey) patch.commandHotkey = DEFAULT_CMD_HOTKEY;
  if (Object.keys(patch).length) settings.save(patch);
}

function start(h) {
  handlers = { ...handlers, ...h };
  ensureDefaults();
  if (started) return;
  started = true;

  uIOhook.on('keydown', (e) => {
    held.add(e.keycode);
    // hotkey capture mode for the settings page
    if (captureCb && !isModifier(e.keycode)) {
      const cb = captureCb;
      captureCb = null;
      const m = modsNow();
      cb({ keycode: e.keycode, ctrl: m.ctrl, shift: m.shift, alt: m.alt, label: labelFor(e) });
      return;
    }

    const cfg = settings.load();
    if (matches(e, combo(cfg.hotkey))) {
      if (state === 'handsfree') {
        // any press of the combo while hands-free stops it
        state = 'stopping';
        handlers.onDictateStop && handlers.onDictateStop();
        return;
      }
      if (state === 'idle') {
        state = 'ptt';
        pressAt = Date.now();
        handlers.onDictateStart && handlers.onDictateStart();
      }
      return;
    }
    if (matches(e, combo(cfg.commandHotkey))) {
      if (state === 'idle') {
        state = 'cmd';
        pressAt = Date.now();
        handlers.onCommandStart && handlers.onCommandStart();
      }
    }
  });

  uIOhook.on('keyup', (e) => {
    held.delete(e.keycode);
    const cfg = settings.load();
    if (state === 'ptt' && (e.keycode === cfg.hotkey.keycode || isModifier(e.keycode))) {
      const held = Date.now() - pressAt;
      if (held >= HOLD_MS) {
        state = 'stopping';
        handlers.onDictateStop && handlers.onDictateStop();
      } else {
        // tap: maybe first half of a double-tap
        const now = Date.now();
        if (now - lastTapAt <= DOUBLE_TAP_MS) {
          lastTapAt = 0;
          state = 'handsfree'; // keep recording, hands-free
        } else {
          lastTapAt = now;
          state = 'idle';
          handlers.onDictateCancel && handlers.onDictateCancel();
        }
      }
      return;
    }
    if (state === 'cmd' && (e.keycode === cfg.commandHotkey.keycode || isModifier(e.keycode))) {
      state = 'stopping';
      handlers.onCommandStop && handlers.onCommandStop();
    }
  });

  uIOhook.start();
}

// Called by the dictation pipeline when processing finishes or fails,
// so the state machine can accept the next gesture.
function release() {
  state = 'idle';
}

function captureNext(cb) {
  captureCb = cb;
}

function cancelCapture() {
  captureCb = null;
}

function stop() {
  try { uIOhook.stop(); } catch {}
  started = false;
}

module.exports = { start, stop, release, captureNext, cancelCapture, DEFAULT_HOTKEY, DEFAULT_CMD_HOTKEY };
