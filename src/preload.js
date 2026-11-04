'use strict';
/** Preload bridge for the desktop sidebar: IPC only, no node access in the page. */
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('sideDock', {
  init: () => ipcRenderer.invoke('side-dock:init'),
  latest: () => ipcRenderer.invoke('side-dock:latest'),
  onStats: subscribe('side-dock:stats'),
  onState: subscribe('side-dock:state'),
  setCollapsed: (collapsed) => ipcRenderer.invoke('side-dock:set-collapsed', Boolean(collapsed)),
  flip: () => ipcRenderer.invoke('side-dock:flip'),
  setWidth: (width) => ipcRenderer.invoke('side-dock:set-width', width),
  open: (url) => ipcRenderer.invoke('side-dock:open', url),
  refresh: () => ipcRenderer.invoke('side-dock:refresh'),
  getSettings: () => ipcRenderer.invoke('side-dock:settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('side-dock:settings:save', patch),
  setHeight: (height) => ipcRenderer.invoke('side-dock:set-height', height),
  fit: (size) => ipcRenderer.invoke('side-dock:fit', size),
  closeDesktop: () => ipcRenderer.invoke('side-dock:close'),
  report: (message) => ipcRenderer.send('side-dock:renderer-log', String(message)),
});
