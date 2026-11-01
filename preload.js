'use strict';
// The only bridge between the sandboxed player window and main: two inbound
// channels and three outbound ones. The renderer gets no Node or Electron access.
const { contextBridge, ipcRenderer } = require('electron');

const IN = ['reveal', 'audio'];
const OUT = ['playback-ended', 'control', 'config'];

contextBridge.exposeInMainWorld('ls', {
  on: (ch, cb) => { if (IN.includes(ch)) ipcRenderer.on(ch, (_, data) => cb(data)); },
  send: (ch, data) => { if (OUT.includes(ch)) ipcRenderer.send(ch, data); },
});
