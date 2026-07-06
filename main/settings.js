// Settings store: plain JSON file in userData. Small, human-readable, no native deps.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // uiohook keycodes are filled in on first run by hotkeys.js (needs the lib loaded)
  hotkey: null,          // { keycode, ctrl, shift, alt, label }
  commandHotkey: null,   // same shape
  mic: 'default',
  micProcessing: true,   // echo cancellation + noise suppression + AGC
  stt: {
    engine: 'auto',      // auto | local | openai | groq
    model: 'base',       // tiny | base | small | medium | large-v3
    language: 'auto',    // auto or ISO code like 'en'
  },
  cleanup: {
    mode: 'auto',        // auto | rules | llm
    provider: 'auto',    // auto | openai | groq | ollama
    ollamaModel: '',
  },
  typing: {
    method: 'auto',      // auto | type | paste
    pasteThreshold: 60,  // chars; above this, auto uses clipboard paste
  },
  launchAtStartup: false,
  scratchpad: '',
  onboarded: false,
};

let cache = null;
let file = null;

function settingsFile() {
  if (!file) file = path.join(app.getPath('userData'), 'settings.json');
  return file;
}

function keysFile() {
  return path.join(app.getPath('userData'), 'keys.json');
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    if (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k]) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], extra[k]);
    } else {
      out[k] = extra[k];
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    cache = deepMerge(DEFAULTS, raw);
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(partial) {
  cache = deepMerge(load(), partial || {});
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(cache, null, 2));
  return cache;
}

function getKeys() {
  try {
    return JSON.parse(fs.readFileSync(keysFile(), 'utf8'));
  } catch {
    return { openai: '', groq: '' };
  }
}

function saveKeys(keys) {
  const cur = { ...getKeys(), ...keys };
  fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
  fs.writeFileSync(keysFile(), JSON.stringify(cur, null, 2));
  return cur;
}

module.exports = { load, save, getKeys, saveKeys, DEFAULTS };
