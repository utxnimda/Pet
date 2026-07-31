const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  getState: () => ipcRenderer.invoke('pet:get-state'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  synthesizeSpeech: (text, preview = false, referenceId = '') =>
    ipcRenderer.invoke('speech:synthesize', { text, preview, referenceId }),
  openExternal: (url) => ipcRenderer.invoke('external:open', url),
  startDrag: (point) => ipcRenderer.send('pet:drag-start', point),
  moveDrag: (point) => ipcRenderer.send('pet:drag-move', point),
  endDrag: () => ipcRenderer.send('pet:drag-end'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', ignore),
  showMenu: () => ipcRenderer.send('pet:show-menu'),
  setSleeping: (sleeping) => ipcRenderer.send('pet:set-sleeping', sleeping),
  setModel: (modelId) => ipcRenderer.send('pet:set-model', modelId),
  triggerAction: (command) => ipcRenderer.send('pet:trigger-action', command),
  onState: (callback) => {
    ipcRenderer.on('pet:state', (_event, state) => callback(state));
  },
  onCommand: (callback) => {
    ipcRenderer.on('pet:command', (_event, command) => callback(command));
  },
  onLiveStatus: (callback) => {
    ipcRenderer.on('live:status', (_event, status) => callback(status));
  },
  onSettingsNotice: (callback) => {
    ipcRenderer.on('settings:notice', (_event, notice) => callback(notice));
  }
});
