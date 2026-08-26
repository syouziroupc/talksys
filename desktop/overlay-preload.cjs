const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onShow: (callback) => ipcRenderer.on('overlay:show', (_event, value) => callback(value)),
  onClear: (callback) => ipcRenderer.on('overlay:clear', () => callback()),
});
