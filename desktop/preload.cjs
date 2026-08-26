const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('talksys', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  chat: (messages, apiBase) => ipcRenderer.invoke('chat:send', { messages, apiBase }),
  locate: (query, apiBase) => ipcRenderer.invoke('guide:locate', { query, apiBase }),
  clearOverlay: () => ipcRenderer.invoke('overlay:clear'),
  saveCapture: () => ipcRenderer.invoke('capture:save'),
});
