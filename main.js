const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const WINDOW_SIZES = {
  small: { width: 220, height: 290 },
  medium: { width: 270, height: 350 },
  large: { width: 330, height: 425 }
};

const DEFAULT_SETTINGS = {
  alwaysOnTop: true,
  autoWander: true,
  size: 'medium',
  sleeping: false
};

let mainWindow;
let tray;
let settings = { ...DEFAULT_SETTINGS };
let settingsPath;
let isQuitting = false;
let dragState = null;
let wanderTimeout = null;
let wanderAnimation = null;

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');

  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.warn('Could not save pet settings:', error.message);
  }
}

function clampWindowPosition(x, y, width, height) {
  const display = screen.getDisplayMatching({ x, y, width, height });
  const area = display.workArea;

  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(y, area.y), area.y + area.height - height)
  };
}

function placeNearBottomRight() {
  const { width, height } = mainWindow.getBounds();
  const area = screen.getPrimaryDisplay().workArea;
  const position = clampWindowPosition(
    area.x + area.width - width - 28,
    area.y + area.height - height - 18,
    width,
    height
  );

  mainWindow.setPosition(position.x, position.y, false);
}

function createWindow() {
  const size = WINDOW_SIZES[settings.size] || WINDOW_SIZES.medium;

  mainWindow = new BrowserWindow({
    ...size,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    hasShadow: false,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    placeNearBottomRight();
    mainWindow.showInactive();
    mainWindow.webContents.send('pet:state', settings);
    scheduleWander();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showPet() {
  if (!mainWindow) {
    return;
  }

  mainWindow.showInactive();
  mainWindow.moveTop();
}

function togglePetVisibility() {
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showPet();
  }
}

function setAlwaysOnTop(value) {
  settings.alwaysOnTop = Boolean(value);
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  saveSettings();
}

function setAutoWander(value) {
  settings.autoWander = Boolean(value);
  saveSettings();
  scheduleWander();
}

function setSleeping(value) {
  settings.sleeping = Boolean(value);
  saveSettings();
  mainWindow.webContents.send('pet:state', settings);
  scheduleWander();
}

function setPetSize(sizeKey) {
  const nextSize = WINDOW_SIZES[sizeKey];
  if (!nextSize || settings.size === sizeKey) {
    return;
  }

  const current = mainWindow.getBounds();
  const bottom = current.y + current.height;
  const centerX = current.x + Math.round(current.width / 2);
  const nextPosition = clampWindowPosition(
    centerX - Math.round(nextSize.width / 2),
    bottom - nextSize.height,
    nextSize.width,
    nextSize.height
  );

  settings.size = sizeKey;
  mainWindow.setBounds({ ...nextPosition, ...nextSize }, true);
  saveSettings();
}

function stopWanderAnimation() {
  if (wanderAnimation) {
    clearInterval(wanderAnimation);
    wanderAnimation = null;
    mainWindow?.webContents.send('pet:motion', { active: false, direction: 'right' });
  }
}

function scheduleWander() {
  if (wanderTimeout) {
    clearTimeout(wanderTimeout);
    wanderTimeout = null;
  }

  stopWanderAnimation();

  if (!settings.autoWander || settings.sleeping || !mainWindow) {
    return;
  }

  const delay = 9000 + Math.round(Math.random() * 9000);
  wanderTimeout = setTimeout(performWander, delay);
}

function performWander() {
  if (!mainWindow || !mainWindow.isVisible() || dragState || settings.sleeping) {
    scheduleWander();
    return;
  }

  const start = mainWindow.getBounds();
  const area = screen.getDisplayMatching(start).workArea;
  const distance = 45 + Math.round(Math.random() * 85);
  const direction = Math.random() > 0.5 ? 1 : -1;
  const targetX = Math.min(
    Math.max(start.x + distance * direction, area.x),
    area.x + area.width - start.width
  );

  if (targetX === start.x) {
    scheduleWander();
    return;
  }

  const duration = 1300 + Math.round(Math.random() * 500);
  const startedAt = Date.now();
  const facing = targetX > start.x ? 'right' : 'left';
  mainWindow.webContents.send('pet:motion', { active: true, direction: facing });

  wanderAnimation = setInterval(() => {
    const progress = Math.min((Date.now() - startedAt) / duration, 1);
    const eased = 0.5 - Math.cos(progress * Math.PI) / 2;
    const x = Math.round(start.x + (targetX - start.x) * eased);
    const hop = Math.round(Math.sin(progress * Math.PI * 4) * 2);
    mainWindow.setPosition(x, start.y - Math.max(hop, 0), false);

    if (progress >= 1) {
      stopWanderAnimation();
      mainWindow.setPosition(targetX, start.y, false);
      scheduleWander();
    }
  }, 16);
}

function createPetMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;

  return Menu.buildFromTemplate([
    {
      label: '摸摸她',
      click: () => {
        showPet();
        mainWindow.webContents.send('pet:command', 'pat');
      }
    },
    {
      label: settings.sleeping ? '叫醒她' : '让她睡觉',
      click: () => setSleeping(!settings.sleeping)
    },
    { type: 'separator' },
    {
      label: '自动散步',
      type: 'checkbox',
      checked: settings.autoWander,
      click: (item) => setAutoWander(item.checked)
    },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: settings.alwaysOnTop,
      click: (item) => setAlwaysOnTop(item.checked)
    },
    {
      label: '大小',
      submenu: Object.keys(WINDOW_SIZES).map((sizeKey) => ({
        label: { small: '小', medium: '中', large: '大' }[sizeKey],
        type: 'radio',
        checked: settings.size === sizeKey,
        click: () => setPetSize(sizeKey)
      }))
    },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    {
      label: mainWindow?.isVisible() ? '隐藏到托盘' : '显示宠物',
      click: togglePetVisibility
    },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  const trayImage = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'icon.png'))
    .resize({ width: 32, height: 32 });

  tray = new Tray(trayImage);
  tray.setToolTip('薄荷小陪伴');
  tray.on('click', togglePetVisibility);
  tray.on('right-click', () => tray.popUpContextMenu(createPetMenu()));
}

function registerIpc() {
  ipcMain.handle('pet:get-state', () => settings);

  ipcMain.on('pet:drag-start', (_event, point) => {
    if (!mainWindow) {
      return;
    }

    stopWanderAnimation();
    const bounds = mainWindow.getBounds();
    dragState = {
      pointerX: Number(point.screenX),
      pointerY: Number(point.screenY),
      windowX: bounds.x,
      windowY: bounds.y,
      width: bounds.width,
      height: bounds.height
    };
  });

  ipcMain.on('pet:drag-move', (_event, point) => {
    if (!mainWindow || !dragState) {
      return;
    }

    const next = clampWindowPosition(
      dragState.windowX + Number(point.screenX) - dragState.pointerX,
      dragState.windowY + Number(point.screenY) - dragState.pointerY,
      dragState.width,
      dragState.height
    );

    mainWindow.setPosition(Math.round(next.x), Math.round(next.y), false);
  });

  ipcMain.on('pet:drag-end', () => {
    dragState = null;
    scheduleWander();
  });

  ipcMain.on('pet:ignore-mouse', (_event, ignore) => {
    mainWindow?.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  });

  ipcMain.on('pet:show-menu', () => {
    createPetMenu().popup({ window: mainWindow });
  });

  ipcMain.on('pet:set-sleeping', (_event, sleeping) => {
    setSleeping(sleeping);
  });
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showPet);

  app.whenReady().then(() => {
    loadSettings();
    registerIpc();
    createWindow();
    createTray();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (wanderTimeout) {
      clearTimeout(wanderTimeout);
    }
    stopWanderAnimation();
  });

  app.on('window-all-closed', () => {
    // The tray owns the application lifetime.
  });
}
