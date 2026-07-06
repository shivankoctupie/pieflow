const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pieOverlay', {
  onState: (cb) => ipcRenderer.on('state', (e, s) => cb(s)),
  onRecStart: (cb) => ipcRenderer.on('rec:start', (e, opts) => cb(opts)),
  onRecStop: (cb) => ipcRenderer.on('rec:stop', () => cb()),
  onRecCancel: (cb) => ipcRenderer.on('rec:cancel', () => cb()),
  sendAudio: (buf) => ipcRenderer.send('rec:data', buf),
  sendError: (msg) => ipcRenderer.send('rec:error', msg),
});
