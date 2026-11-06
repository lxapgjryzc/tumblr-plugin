'use strict';
// The only bridge between the window and the service: one call channel and one event channel.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
  call: (method, args) => ipcRenderer.invoke('studio', method, args),
  on: fn => ipcRenderer.on('event', (_e, ev) => fn(ev)),
  trayRefresh: () => ipcRenderer.send('tray-refresh'),
  locale: navigator.language,
});
