const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getState: () => ipcRenderer.invoke('pet:get-state'),
  startDrag: (point) => ipcRenderer.send('pet:drag-start', point),
  moveDrag: (point) => ipcRenderer.send('pet:drag-move', point),
  endDrag: () => ipcRenderer.send('pet:drag-end'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', ignore),
  showMenu: () => ipcRenderer.send('pet:show-menu'),
  setSleeping: (sleeping) => ipcRenderer.send('pet:set-sleeping', sleeping),
  onState: (callback) => {
    ipcRenderer.on('pet:state', (_event, state) => callback(state));
  },
  onCommand: (callback) => {
    ipcRenderer.on('pet:command', (_event, command) => callback(command));
  },
  onMotion: (callback) => {
    ipcRenderer.on('pet:motion', (_event, motion) => callback(motion));
  }
});
