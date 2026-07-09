// PieFlow main process entry.
const { app, ipcMain, session } = require('electron');
const path = require('path');

app.setName('PieFlow');

// Portable mode: keep all app data (settings, history, models cache) under a
// custom directory instead of %APPDATA%. Handy for a USB install or testing.
if (process.env.PIEFLOW_USER_DATA) {
  try { app.setPath('userData', process.env.PIEFLOW_USER_DATA); } catch {}
}

const settings = require('./settings');
const db = require('./db');
const windows = require('./windows');
const tray = require('./tray');
const hotkeys = require('./hotkeys');
const dictation = require('./dictation');
const injector = require('./injector');
const stt = require('./stt');
const llm = require('./llm');
const cleanupMod = require('./cleanup');
const license = require('./license');
const { shell } = require('electron');

// Boot log to a file so we can diagnose the packaged app (no console there).
const fs = require('fs');
function bootLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'pieflow-boot.log'), line + '\n');
  } catch {}
}
// Each startup step runs in isolation: if one subsystem fails to initialize,
// the others (above all the global hotkey) must still come up.
function step(name, fn) {
  try {
    fn();
    bootLog(`ok: ${name}`);
  } catch (e) {
    bootLog(`FAILED: ${name}: ${e && e.stack ? e.stack : e}`);
  }
}

process.on('unhandledRejection', (r) => bootLog('unhandled rejection: ' + (r && r.stack ? r.stack : r)));
process.on('uncaughtException', (e) => bootLog('uncaught exception: ' + (e && e.stack ? e.stack : e)));

const gotLock = app.requestSingleInstanceLock();
bootLog('boot, singleInstanceLock = ' + gotLock);
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => windows.createDashboard());

  app.whenReady().then(async () => {
    bootLog('ready');
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'pieflow-boot.log'), '');
    } catch {}
    bootLog('boot start');

    // Register the global hotkey FIRST. It is the core feature and must not be
    // blocked by any later subsystem (tray icon, windows, sidecars) failing.
    step('hotkeys', () => hotkeys.start({
      onDictateStart: dictation.onDictateStart,
      onDictateStop: dictation.onDictateStop,
      onDictateCancel: dictation.onDictateCancel,
      onCommandStart: dictation.onCommandStart,
      onCommandStop: dictation.onCommandStop,
    }));

    try {
      session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media'));
    } catch (e) { bootLog('permission handler failed: ' + e); }

    try { await db.open(); bootLog('ok: db'); } catch (e) { bootLog('FAILED: db: ' + (e && e.stack || e)); }
    step('overlay', () => windows.createOverlay());
    step('dashboard', () => windows.createDashboard());
    step('tray', () => tray.create());
    step('injector', () => injector.start());
    step('loginItem', () => app.setLoginItemSettings({ openAtLogin: !!settings.load().launchAtStartup }));
    step('warmUp', () => stt.warmUp());
    step('license', () => license.refresh());
    step('sttStatus', () => stt.onStatus((s) => {
      const d = windows.getDashboard();
      if (d) d.webContents.send('stt:status', s);
    }));
    bootLog('boot complete');
  });

  app.on('window-all-closed', (e) => {
    // tray app: keep running
  });

  app.on('before-quit', () => {
    app.isQuittingForReal = true;
    db.flush();
    stt.stop();
    injector.stop();
    hotkeys.stop();
  });
}

// ---------------- IPC ----------------

// settings
ipcMain.handle('settings:get', () => settings.load());
ipcMain.handle('settings:set', (e, partial) => {
  const out = settings.save(partial);
  tray.refreshMenu();
  if (partial && 'launchAtStartup' in partial) {
    app.setLoginItemSettings({ openAtLogin: !!partial.launchAtStartup });
  }
  return out;
});
ipcMain.handle('keys:get', () => {
  const k = settings.getKeys();
  // send masked previews; real values never leave main except on save
  return {
    openai: k.openai ? `sk-...${k.openai.slice(-4)}` : '',
    groq: k.groq ? `gsk-...${k.groq.slice(-4)}` : '',
    openaiSet: !!k.openai,
    groqSet: !!k.groq,
  };
});
ipcMain.handle('keys:set', (e, keys) => {
  settings.saveKeys(keys);
  return true;
});

// hotkey capture
ipcMain.handle('hotkey:capture', () => {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { hotkeys.cancelCapture(); resolve(null); }, 10000);
    hotkeys.captureNext((comboObj) => {
      clearTimeout(timer);
      resolve(comboObj);
    });
  });
});

// history
ipcMain.handle('history:list', (e, opts) => db.listHistory(opts || {}));
ipcMain.handle('history:delete', (e, id) => { db.deleteHistory(id); return true; });
ipcMain.handle('history:update', (e, { id, text }) => {
  const oldText = db.updateHistoryText(id, text);
  if (oldText && oldText !== text) cleanupMod.learnFromEdit(oldText, text);
  return true;
});

// dictionary
ipcMain.handle('dict:list', () => db.listDictionary());
ipcMain.handle('dict:add', (e, { word, misheard }) => { db.addDictWord(word, misheard || []); return true; });
ipcMain.handle('dict:delete', (e, id) => { db.deleteDictWord(id); return true; });

// snippets
ipcMain.handle('snip:list', () => db.listSnippets());
ipcMain.handle('snip:add', (e, { trigger, content }) => { db.addSnippet(trigger, content); return true; });
ipcMain.handle('snip:delete', (e, id) => { db.deleteSnippet(id); return true; });

// styles
ipcMain.handle('styles:list', () => db.listStyles());
ipcMain.handle('styles:save', (e, s) => { db.saveStyle(s); return true; });
ipcMain.handle('styles:delete', (e, id) => { db.deleteStyle(id); return true; });

// transforms
ipcMain.handle('transforms:list', () => db.listTransforms());
ipcMain.handle('transforms:save', (e, t) => { db.saveTransform(t); return true; });
ipcMain.handle('transforms:delete', (e, id) => { db.deleteTransform(id); return true; });

// stats and insights
ipcMain.handle('stats:get', () => db.getStats());
ipcMain.handle('insights:get', () => db.getInsights(14));

// pro licensing
ipcMain.handle('license:status', () => license.status());
ipcMain.handle('license:activate', (e, key) => license.activate(key));
ipcMain.handle('license:deactivate', () => license.deactivate());
ipcMain.handle('license:checkout', () => { shell.openExternal(license.CHECKOUT_URL); return true; });

// engines status
ipcMain.handle('stt:status', () => stt.getStatus());
ipcMain.handle('stt:setup', () => stt.ensureSetup());
ipcMain.handle('llm:status', () => llm.statusReport());

// scratchpad
ipcMain.handle('scratchpad:get', () => settings.load().scratchpad || '');
ipcMain.handle('scratchpad:set', (e, text) => { settings.save({ scratchpad: text }); return true; });

// demo/test: cleanup + inject arbitrary text after a delay
ipcMain.handle('test:inject', async (e, { text, delayMs }) => {
  return dictation.testInject(text, delayMs || 3000);
});
ipcMain.handle('test:cleanup', async (e, { text }) => {
  return cleanupMod.clean(text, { style: null });
});

// dev/test hook: PIEFLOW_TEST_WAV=<path> runs that file through the full
// pipeline 12s after launch (time to focus a target window)
if (process.env.PIEFLOW_TEST_WAV) {
  app.whenReady().then(() => {
    setTimeout(async () => {
      try {
        await dictation.testDictateWav(process.env.PIEFLOW_TEST_WAV);
      } catch (err) {
        console.error('[test] failed:', err.message);
      }
    }, 12000);
  });
}
if (process.env.PIEFLOW_TEST_CMD_WAV) {
  app.whenReady().then(() => {
    setTimeout(async () => {
      try {
        await dictation.testCommandWav(process.env.PIEFLOW_TEST_CMD_WAV);
      } catch (err) {
        console.error('[test] cmd failed:', err.message);
      }
    }, 12000);
  });
}

// overlay -> main audio results
ipcMain.on('rec:data', (e, buf) => dictation.onAudioData(buf));
ipcMain.on('rec:error', (e, msg) => dictation.onAudioError(msg));
ipcMain.on('rec:level', (e, level) => {
  // level updates loop back to the overlay itself; nothing to do in main
});
