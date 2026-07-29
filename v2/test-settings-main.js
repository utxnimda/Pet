const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const testState = {
  alwaysOnTop: true,
  autoWander: true,
  size: 'medium',
  sleeping: false,
  characterModel: 'duck',
  speechEnabled: false,
  fishVoiceModelId: 'af09f6d5c47545b69dc8bb39d19ce0af',
  hasFishApiKey: false
};

ipcMain.handle('pet:get-state', () => testState);
ipcMain.handle('settings:save', () => testState);
ipcMain.handle('speech:synthesize', () => {
  throw new Error('设置页视觉测试不发送真实语音请求。');
});
ipcMain.handle('external:open', () => false);

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 460,
    height: 650,
    show: false,
    backgroundColor: '#fff9fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(path.join(__dirname, 'src', 'settings.html'));
  window.once('ready-to-show', () => window.show());
});

app.on('window-all-closed', () => app.quit());
