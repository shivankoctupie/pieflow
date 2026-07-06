const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('pie', {
  settings: { get: invoke('settings:get'), set: invoke('settings:set') },
  keys: { get: invoke('keys:get'), set: invoke('keys:set') },
  hotkey: { capture: invoke('hotkey:capture') },
  history: {
    list: invoke('history:list'),
    delete: invoke('history:delete'),
    update: invoke('history:update'),
    onChanged: (cb) => ipcRenderer.on('history:changed', cb),
  },
  dict: { list: invoke('dict:list'), add: invoke('dict:add'), delete: invoke('dict:delete') },
  snip: { list: invoke('snip:list'), add: invoke('snip:add'), delete: invoke('snip:delete') },
  styles: { list: invoke('styles:list'), save: invoke('styles:save'), delete: invoke('styles:delete') },
  transforms: { list: invoke('transforms:list'), save: invoke('transforms:save'), delete: invoke('transforms:delete') },
  stats: { get: invoke('stats:get') },
  insights: { get: invoke('insights:get') },
  stt: {
    status: invoke('stt:status'),
    setup: invoke('stt:setup'),
    onStatus: (cb) => ipcRenderer.on('stt:status', (e, s) => cb(s)),
  },
  llm: { status: invoke('llm:status') },
  scratchpad: { get: invoke('scratchpad:get'), set: invoke('scratchpad:set') },
  test: { inject: invoke('test:inject'), cleanup: invoke('test:cleanup') },
});
