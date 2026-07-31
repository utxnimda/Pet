const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  net,
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
  duck: '小鸭薄荷'
};
const ACTION_DEFINITIONS = {
  idle: {
    label: '电脑前待机',
    asset: 'assets/motion/duck-idle.png'
  },
  walk: {
    label: '走路',
    asset: 'assets/motion/duck-walk.png'
  },
  depressed: {
    label: '低落',
    asset: 'assets/motion/duck-depressed.png'
  },
  argue: {
    label: '争辩',
    asset: 'assets/motion/duck-argue.png'
  },
  run: {
    label: '跑一圈',
    asset: 'assets/motion/duck-run.png'
  },
  sleep: {
    label: '睡觉',
    asset: 'assets/motion/duck-sleep.png'
  }
};
const ACTION_IDS = Object.keys(ACTION_DEFINITIONS);
const IDLE_MODES = new Set([...ACTION_IDS, 'random']);
const DEFAULT_ACTION_ENABLED = {
  idle: false,
  walk: false,
  depressed: false,
  argue: true,
  run: true,
  sleep: false
};

const LEGACY_FISH_VOICE_MODEL_IDS = new Set([
  'af09f6d5c47545b69dc8bb39d19ce0af',
  '815acd1baeed4cc987e24e186424ac02'
]);
const DEFAULT_FISH_VOICE_MODEL_ID = '1a667f2491cd4ac7995645cc4a3747c3';
const DOUYU_LIVE_ROOM_ID = '9667590';
const DOUYU_LIVE_ROOM_URL = `https://www.douyu.com/betard/${DOUYU_LIVE_ROOM_ID}`;
const DOUYU_LIVE_POLL_INTERVAL_MS = 60_000;
const DOUYU_LIVE_RETRY_INTERVAL_MS = 15_000;
const DOUYU_LIVE_REQUEST_TIMEOUT_MS = 12_000;

const DEFAULT_SETTINGS = {
  alwaysOnTop: true,
  size: 'medium',
  sleeping: false,
  characterModel: 'duck',
  idleMode: 'run',
  idleIntervalSeconds: 12,
  actionEnabled: { ...DEFAULT_ACTION_ENABLED },
  speechEnabled: true,
  localVoiceReady: true,
  fishVoiceModelId: DEFAULT_FISH_VOICE_MODEL_ID,
  fishApiKeyEncrypted: ''
};

let mainWindow;
let settingsWindow;
let tray;
let settings = {
  ...DEFAULT_SETTINGS,
  actionEnabled: { ...DEFAULT_ACTION_ENABLED }
};
let settingsPath;
let isQuitting = false;
let dragState = null;
let liveRoomPollTimer = null;
let liveRoomPollInFlight = false;
let liveRoomAbortController = null;
let liveRoomState = {
  roomId: DOUYU_LIVE_ROOM_ID,
  ownerName: '阿雅Midori',
  roomName: '',
  status: 'unknown',
  showStatus: null,
  checkedAt: null,
  becameLiveAt: null,
  error: ''
};

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');

  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const needsLocalVoiceMigration = saved.localVoiceReady !== true;
    const needsFishVoiceMigration =
      !saved.fishVoiceModelId ||
      LEGACY_FISH_VOICE_MODEL_IDS.has(saved.fishVoiceModelId);
    const needsActionSettingsMigration = !saved.actionEnabled;
    const needsAutoWanderRemoval = Object.prototype.hasOwnProperty.call(
      saved,
      'autoWander'
    );
    settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      actionEnabled: {
        ...DEFAULT_ACTION_ENABLED,
        ...(saved.actionEnabled || {})
      }
    };
    delete settings.autoWander;

    if (needsLocalVoiceMigration) {
      settings.speechEnabled = true;
      settings.localVoiceReady = true;
    }

    if (needsFishVoiceMigration) {
      settings.fishVoiceModelId = DEFAULT_FISH_VOICE_MODEL_ID;
    }

    if (
      needsLocalVoiceMigration ||
      needsFishVoiceMigration ||
      needsActionSettingsMigration ||
      needsAutoWanderRemoval
    ) {
      saveSettings();
    }
  } catch {
    settings = {
      ...DEFAULT_SETTINGS,
      actionEnabled: { ...DEFAULT_ACTION_ENABLED }
    };
  }

  if (!CHARACTER_MODELS[settings.characterModel]) {
    settings.characterModel = DEFAULT_SETTINGS.characterModel;
  }

  const normalizedActionEnabled = normalizeActionEnabled(
    settings.actionEnabled
  );
  const actionSettingsChanged =
    JSON.stringify(normalizedActionEnabled) !==
    JSON.stringify(settings.actionEnabled);
  settings.actionEnabled = normalizedActionEnabled;

  const normalizedIdleMode = resolveIdleMode(settings.idleMode);
  const idleModeChanged = normalizedIdleMode !== settings.idleMode;
  settings.idleMode = normalizedIdleMode;

  const normalizedSleeping =
    Boolean(settings.sleeping) && isActionEnabled('sleep');
  const sleepingChanged = normalizedSleeping !== settings.sleeping;
  settings.sleeping = normalizedSleeping;

  const idleIntervalSeconds = Number(settings.idleIntervalSeconds);
  settings.idleIntervalSeconds = Number.isFinite(idleIntervalSeconds)
    ? Math.min(Math.max(Math.round(idleIntervalSeconds), 3), 300)
    : DEFAULT_SETTINGS.idleIntervalSeconds;

  if (actionSettingsChanged || idleModeChanged || sleepingChanged) {
    saveSettings();
  }
}

function getActionAvailability() {
  return Object.fromEntries(
    ACTION_IDS.map((actionId) => [
      actionId,
      fs.existsSync(path.join(__dirname, ACTION_DEFINITIONS[actionId].asset))
    ])
  );
}

function normalizeActionEnabled(input = {}) {
  const availability = getActionAvailability();

  return Object.fromEntries(
    ACTION_IDS.map((actionId) => [
      actionId,
      availability[actionId] && Boolean(input[actionId])
    ])
  );
}

function getEnabledActionIds(actionEnabled = settings.actionEnabled) {
  const availability = getActionAvailability();
  return ACTION_IDS.filter(
    (actionId) => availability[actionId] && actionEnabled[actionId]
  );
}

function isActionEnabled(actionId) {
  return getEnabledActionIds().includes(actionId);
}

function resolveIdleMode(requestedMode, actionEnabled = settings.actionEnabled) {
  const enabledActions = getEnabledActionIds(actionEnabled);

  if (requestedMode === 'random' && enabledActions.length > 1) {
    return 'random';
  }

  if (enabledActions.includes(requestedMode)) {
    return requestedMode;
  }

  return enabledActions[0] || 'run';
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
  const actionAvailable = getActionAvailability();

  return {
    alwaysOnTop: settings.alwaysOnTop,
    size: settings.size,
    sleeping: settings.sleeping,
    characterModel: settings.characterModel,
    idleMode: settings.idleMode,
    idleIntervalSeconds: settings.idleIntervalSeconds,
    actionEnabled: { ...settings.actionEnabled },
    actionAvailable,
    speechEnabled: settings.speechEnabled,
    fishVoiceModelId: settings.fishVoiceModelId,
    hasFishApiKey: Boolean(getFishApiKey()),
    liveRoom: { ...liveRoomState }
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

function broadcastLiveRoomStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('live:status', { ...liveRoomState });
  }
}

function scheduleLiveRoomPoll(delay) {
  if (liveRoomPollTimer) {
    clearTimeout(liveRoomPollTimer);
  }

  liveRoomPollTimer = setTimeout(() => {
    liveRoomPollTimer = null;
    void pollDouyuLiveRoomStatus();
  }, delay);
}

async function pollDouyuLiveRoomStatus() {
  if (liveRoomPollInFlight || isQuitting) {
    return;
  }

  liveRoomPollInFlight = true;
  let nextPollDelay = DOUYU_LIVE_RETRY_INTERVAL_MS;
  const controller = new AbortController();
  liveRoomAbortController = controller;
  const timeout = setTimeout(
    () => controller.abort(),
    DOUYU_LIVE_REQUEST_TIMEOUT_MS
  );

  try {
    const response = await net.fetch(DOUYU_LIVE_ROOM_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const room = payload?.room;
    const showStatus = Number(room?.show_status);

    if (!room || (showStatus !== 1 && showStatus !== 2)) {
      throw new Error('斗鱼未返回有效的直播状态');
    }

    const previousStatus = liveRoomState.status;
    const nextStatus = showStatus === 1 ? 'live' : 'offline';
    const checkedAt = Date.now();
    liveRoomState = {
      roomId: String(room.room_id || DOUYU_LIVE_ROOM_ID),
      ownerName: String(room.owner_name || liveRoomState.ownerName),
      roomName: String(room.room_name || ''),
      status: nextStatus,
      showStatus,
      checkedAt,
      becameLiveAt:
        previousStatus === 'offline' && nextStatus === 'live'
          ? checkedAt
          : nextStatus === 'offline'
            ? null
            : liveRoomState.becameLiveAt,
      error: ''
    };
    nextPollDelay = DOUYU_LIVE_POLL_INTERVAL_MS;
    broadcastLiveRoomStatus();
  } catch (error) {
    if (error.name !== 'AbortError' || !isQuitting) {
      liveRoomState = {
        ...liveRoomState,
        error:
          error.name === 'AbortError'
            ? '斗鱼直播状态请求超时'
            : String(error.message || error)
      };
      broadcastLiveRoomStatus();
      console.warn(
        `[douyu-live] Room ${DOUYU_LIVE_ROOM_ID} status check failed:`,
        liveRoomState.error
      );
    }
  } finally {
    clearTimeout(timeout);
    if (liveRoomAbortController === controller) {
      liveRoomAbortController = null;
    }
    liveRoomPollInFlight = false;
  }

  if (!isQuitting) {
    scheduleLiveRoomPoll(nextPollDelay);
  }
}

function startLiveRoomPolling() {
  if (liveRoomPollTimer) {
    clearTimeout(liveRoomPollTimer);
    liveRoomPollTimer = null;
  }
  void pollDouyuLiveRoomStatus();
}

function stopLiveRoomPolling() {
  if (liveRoomPollTimer) {
    clearTimeout(liveRoomPollTimer);
    liveRoomPollTimer = null;
  }
  liveRoomAbortController?.abort();
  liveRoomAbortController = null;
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

function setSleeping(value) {
  settings.sleeping = Boolean(value) && isActionEnabled('sleep');
  saveSettings();
  broadcastState();
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

function sendPetCommand(command) {
  showPet();
  mainWindow.webContents.send('pet:command', command);
}

function triggerPetAction(command) {
  if (!isActionEnabled(command)) {
    return;
  }

  if (command === 'sleep') {
    setSleeping(true);
    sendPetCommand('sleep');
    return;
  }

  if (settings.sleeping) {
    setSleeping(false);
  }

  sendPetCommand(command);
}

function createPetMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const actionItems = getEnabledActionIds().map((actionId) => ({
    label: ACTION_DEFINITIONS[actionId].label,
    click: () => triggerPetAction(actionId)
  }));

  return Menu.buildFromTemplate([
    {
      label: '摸摸她',
      click: () => sendPetCommand('pat')
    },
    ...actionItems,
    { type: 'separator' },
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
  tray.setToolTip('小小雅鹅');
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
      const data = await response.clone().json();
    return data.message || data.detail || JSON.stringify(data);
  } catch {
    return await response.text();
  }
}

async function synthesizeSpeech(
  text,
  preview = false,
  referenceIdOverride = ''
) {
  const normalizedText = String(text || '').trim();
  const requestedReferenceId = String(referenceIdOverride || '').trim();

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

  if (
    requestedReferenceId &&
    !/^[a-zA-Z0-9_-]{8,80}$/.test(requestedReferenceId)
  ) {
    throw new Error('Fish Audio 声音模型 ID 格式不正确。');
  }

  const referenceId =
    requestedReferenceId || settings.fishVoiceModelId;
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
      cached: true,
      referenceId
    };
  } catch {
    // Generate and populate the cache below.
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let response;

  try {
    response = await net.fetch('https://api.fish.audio/v1/tts', {
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
    cached: false,
    referenceId
  };
}

function registerIpc() {
  ipcMain.handle('pet:get-state', () => getPublicSettings());

  ipcMain.handle('settings:save', (_event, input = {}) => {
    const nextModel = String(input.characterModel || settings.characterModel);
    const nextIdleMode = String(input.idleMode || settings.idleMode);
    const nextActionEnabled = normalizeActionEnabled({
      ...settings.actionEnabled,
      ...(input.actionEnabled || {})
    });
    const nextIdleIntervalSeconds = Number(
      input.idleIntervalSeconds ?? settings.idleIntervalSeconds
    );
    const nextVoiceModelId = String(
      input.fishVoiceModelId || settings.fishVoiceModelId
    ).trim();

    if (!CHARACTER_MODELS[nextModel]) {
      throw new Error('未知的角色模型。');
    }

    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(nextVoiceModelId)) {
      throw new Error('Fish Audio 声音模型 ID 格式不正确。');
    }

    if (!IDLE_MODES.has(nextIdleMode)) {
      throw new Error('未知的待机模式。');
    }

    if (getEnabledActionIds(nextActionEnabled).length === 0) {
      throw new Error('至少需要开启一个已有资源的动作。');
    }

    if (
      !Number.isFinite(nextIdleIntervalSeconds) ||
      nextIdleIntervalSeconds < 3 ||
      nextIdleIntervalSeconds > 300
    ) {
      throw new Error('随机待机间隔必须在 3 到 300 秒之间。');
    }

    if (input.clearApiKey) {
      setFishApiKey('');
    } else if (String(input.apiKey || '').trim()) {
      setFishApiKey(input.apiKey);
    }

    settings.characterModel = nextModel;
    settings.actionEnabled = nextActionEnabled;
    settings.idleMode = resolveIdleMode(nextIdleMode, nextActionEnabled);
    settings.idleIntervalSeconds = Math.round(nextIdleIntervalSeconds);
    settings.fishVoiceModelId = nextVoiceModelId;
    settings.speechEnabled = Boolean(input.speechEnabled);
    settings.localVoiceReady = true;

    settings.sleeping = false;
    saveSettings();
    broadcastState();
    sendPetCommand('model-changed');
    return getPublicSettings();
  });

  ipcMain.handle('speech:synthesize', (_event, request = {}) =>
    synthesizeSpeech(
      request.text,
      Boolean(request.preview),
      request.referenceId
    )
  );

  ipcMain.handle('external:open', (_event, url) => openApprovedExternal(url));

  ipcMain.on('pet:drag-start', (_event, point) => {
    if (!mainWindow) {
      return;
    }

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
    if (command === 'pat') {
      sendPetCommand(command);
      return;
    }

    if (ACTION_IDS.includes(command)) {
      triggerPetAction(command);
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
    startLiveRoomPolling();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopLiveRoomPolling();
  });

  app.on('window-all-closed', () => {
    // The tray owns the application lifetime.
  });
}
