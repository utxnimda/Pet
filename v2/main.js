const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  safeStorage,
  screen,
  shell
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const WINDOW_SIZES = {
  small: { width: 220, height: 290 },
  medium: { width: 270, height: 350 },
  large: { width: 330, height: 425 }
};

const CHARACTER_MODELS = {
  classic: '初代双马尾',
  duck: '小鸭薄荷'
};

const DEFAULT_SETTINGS = {
  alwaysOnTop: true,
  autoWander: true,
  size: 'medium',
  sleeping: false,
  characterModel: 'classic',
  speechEnabled: false,
  fishVoiceModelId: 'af09f6d5c47545b69dc8bb39d19ce0af',
  fishApiKeyEncrypted: ''
};

let mainWindow;
let settingsWindow;
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

  if (!CHARACTER_MODELS[settings.characterModel]) {
    settings.characterModel = DEFAULT_SETTINGS.characterModel;
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  } catch (error) {
    console.warn('Could not save pet settings:', error.message);
  }
}

function getFishApiKey() {
  if (process.env.FISH_AUDIO_API_KEY) {
    return process.env.FISH_AUDIO_API_KEY.trim();
  }

  if (!settings.fishApiKeyEncrypted || !safeStorage.isEncryptionAvailable()) {
    return '';
  }

  try {
    const encrypted = Buffer.from(settings.fishApiKeyEncrypted, 'base64');
    return safeStorage.decryptString(encrypted);
  } catch {
    return '';
  }
}

function setFishApiKey(apiKey) {
  const normalized = String(apiKey || '').trim();

  if (!normalized) {
    settings.fishApiKeyEncrypted = '';
    return;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统无法安全保存 API Key，请改用 FISH_AUDIO_API_KEY 环境变量。');
  }

  settings.fishApiKeyEncrypted = safeStorage
    .encryptString(normalized)
    .toString('base64');
}

function getPublicSettings() {
  return {
    alwaysOnTop: settings.alwaysOnTop,
    autoWander: settings.autoWander,
    size: settings.size,
    sleeping: settings.sleeping,
    characterModel: settings.characterModel,
    speechEnabled: settings.speechEnabled,
    fishVoiceModelId: settings.fishVoiceModelId,
    hasFishApiKey: Boolean(getFishApiKey())
  };
}

function broadcastState() {
  const state = getPublicSettings();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('pet:state', state);
  }

  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('pet:state', state);
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
    broadcastState();
    scheduleWander();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    broadcastState();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 460,
    height: 650,
    minWidth: 420,
    minHeight: 590,
    title: '角色与语音设置',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: '#fff9fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'src', 'settings.html'));
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    openApprovedExternal(url);
    return { action: 'deny' };
  });

  settingsWindow.once('ready-to-show', broadcastState);
  settingsWindow.on('closed', () => {
    settingsWindow = null;
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
  broadcastState();
}

function setAutoWander(value) {
  settings.autoWander = Boolean(value);
  saveSettings();
  broadcastState();
  scheduleWander();
}

function setSleeping(value) {
  settings.sleeping = Boolean(value);
  saveSettings();
  broadcastState();
  scheduleWander();
}

function setCharacterModel(modelId) {
  if (!CHARACTER_MODELS[modelId]) {
    return;
  }

  settings.characterModel = modelId;
  settings.sleeping = false;
  saveSettings();
  broadcastState();
  showPet();
  mainWindow.webContents.send('pet:command', 'model-changed');
}

function setSpeechEnabled(value) {
  const enabled = Boolean(value);

  if (enabled && !getFishApiKey()) {
    settings.speechEnabled = false;
    saveSettings();
    createSettingsWindow();
    settingsWindow.webContents.send('settings:notice', '请先填写 Fish Audio API Key。');
    return;
  }

  settings.speechEnabled = enabled;
  saveSettings();
  broadcastState();
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
  broadcastState();
}

function stopWanderAnimation() {
  if (wanderAnimation) {
    clearInterval(wanderAnimation);
    wanderAnimation = null;

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pet:motion', {
        active: false,
        direction: 'right'
      });
    }
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

function sendPetCommand(command) {
  showPet();
  mainWindow.webContents.send('pet:command', command);
}

function createPetMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;

  return Menu.buildFromTemplate([
    {
      label: '摸摸她',
      click: () => sendPetCommand('pat')
    },
    {
      label: '挥挥手',
      click: () => sendPetCommand('wave')
    },
    {
      label: '跳一下',
      click: () => sendPetCommand('jump')
    },
    {
      label: settings.sleeping ? '叫醒她' : '让她睡觉',
      click: () => setSleeping(!settings.sleeping)
    },
    { type: 'separator' },
    {
      label: '角色模型',
      submenu: Object.entries(CHARACTER_MODELS).map(([id, label]) => ({
        label,
        type: 'radio',
        checked: settings.characterModel === id,
        click: () => setCharacterModel(id)
      }))
    },
    {
      label: '语音',
      type: 'checkbox',
      checked: settings.speechEnabled,
      click: (item) => setSpeechEnabled(item.checked)
    },
    {
      label: '角色与语音设置…',
      click: createSettingsWindow
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

function openApprovedExternal(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const approved =
      url.protocol === 'https:' &&
      (url.hostname === 'fish.audio' || url.hostname === 'docs.fish.audio');

    if (approved) {
      shell.openExternal(url.toString());
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

async function readFishError(response) {
  try {
    const data = await response.json();
    return data.message || data.detail || JSON.stringify(data);
  } catch {
    return await response.text();
  }
}

async function synthesizeSpeech(text, preview = false) {
  const normalizedText = String(text || '').trim();

  if (!normalizedText) {
    throw new Error('请输入要说的文字。');
  }

  if (normalizedText.length > 180) {
    throw new Error('单次语音请控制在 180 个字符以内。');
  }

  if (!preview && !settings.speechEnabled) {
    throw new Error('语音功能尚未开启。');
  }

  const apiKey = getFishApiKey();
  if (!apiKey) {
    throw new Error('尚未设置 Fish Audio API Key。');
  }

  const referenceId = settings.fishVoiceModelId;
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${referenceId}\n${normalizedText}`)
    .digest('hex');
  const cacheDirectory = path.join(app.getPath('userData'), 'voice-cache');
  const cachePath = path.join(cacheDirectory, `${cacheKey}.mp3`);

  try {
    const cached = await fs.promises.readFile(cachePath);
    return {
      audioBase64: cached.toString('base64'),
      mimeType: 'audio/mpeg',
      cached: true
    };
  } catch {
    // Generate and populate the cache below.
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let response;

  try {
    response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: 's2-pro'
      },
      body: JSON.stringify({
        text: normalizedText,
        reference_id: referenceId,
        format: 'mp3',
        sample_rate: 44100,
        mp3_bitrate: 128,
        normalize: true,
        latency: 'balanced',
        temperature: 0.7,
        top_p: 0.7,
        chunk_length: 200,
        min_chunk_length: 20,
        prosody: {
          speed: 1,
          volume: 0,
          normalize_loudness: true
        }
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Fish Audio 请求超时，请稍后重试。');
    }
    throw new Error(`无法连接 Fish Audio：${error.message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await readFishError(response);
    const prefix = {
      401: 'API Key 无效或已过期',
      402: 'Fish Audio 账户余额不足',
      422: '语音参数无效'
    }[response.status] || `Fish Audio 请求失败（${response.status}）`;
    throw new Error(detail ? `${prefix}：${detail}` : prefix);
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) {
    throw new Error('Fish Audio 返回了空音频。');
  }

  await fs.promises.mkdir(cacheDirectory, { recursive: true });
  await fs.promises.writeFile(cachePath, audio);

  return {
    audioBase64: audio.toString('base64'),
    mimeType: response.headers.get('content-type') || 'audio/mpeg',
    cached: false
  };
}

function registerIpc() {
  ipcMain.handle('pet:get-state', () => getPublicSettings());

  ipcMain.handle('settings:save', (_event, input = {}) => {
    const nextModel = String(input.characterModel || settings.characterModel);
    const nextVoiceModelId = String(
      input.fishVoiceModelId || settings.fishVoiceModelId
    ).trim();

    if (!CHARACTER_MODELS[nextModel]) {
      throw new Error('未知的角色模型。');
    }

    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(nextVoiceModelId)) {
      throw new Error('Fish Audio 声音模型 ID 格式不正确。');
    }

    if (input.clearApiKey) {
      setFishApiKey('');
    } else if (String(input.apiKey || '').trim()) {
      setFishApiKey(input.apiKey);
    }

    settings.characterModel = nextModel;
    settings.fishVoiceModelId = nextVoiceModelId;
    settings.speechEnabled = Boolean(input.speechEnabled);

    if (settings.speechEnabled && !getFishApiKey()) {
      settings.speechEnabled = false;
      throw new Error('开启语音前请填写 Fish Audio API Key。');
    }

    settings.sleeping = false;
    saveSettings();
    broadcastState();
    sendPetCommand('model-changed');
    return getPublicSettings();
  });

  ipcMain.handle('speech:synthesize', (_event, request = {}) =>
    synthesizeSpeech(request.text, Boolean(request.preview))
  );

  ipcMain.handle('external:open', (_event, url) => openApprovedExternal(url));

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

  ipcMain.on('pet:set-model', (_event, modelId) => {
    setCharacterModel(modelId);
  });

  ipcMain.on('pet:trigger-action', (_event, command) => {
    if (['pat', 'wave', 'jump', 'sleep', 'wake'].includes(command)) {
      if (command === 'sleep') {
        setSleeping(true);
      } else if (command === 'wake') {
        setSleeping(false);
      } else {
        sendPetCommand(command);
      }
    }
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
