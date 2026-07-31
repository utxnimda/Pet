const pet = document.querySelector('#pet');
const petImage = document.querySelector('#pet-image');
const bubble = document.querySelector('#speech-bubble');
const speechText = document.querySelector('#speech-text');
const argueCaptionLeft = document.querySelector('#argue-caption-left');
const argueCaptionRight = document.querySelector('#argue-caption-right');
const particleLayer = document.querySelector('#particle-layer');
const voiceStatus = document.querySelector('#voice-status');
const liveStatusDot = document.querySelector('#live-status-dot');

const ACTION_IDS = ['idle', 'walk', 'depressed', 'argue', 'run', 'sleep'];
const ACTION_LABELS = {
  idle: '电脑前待机',
  walk: '走路',
  depressed: '低落',
  argue: '争辩',
  run: '跑一圈',
  sleep: '睡觉'
};
const ACTION_PARTICLES = {
  run: 6
};
// duck-argue.png starts from source frame 31 (red character speaking).
// Aya starts on frame 28 (source frame 11), where her mouth is open.  This
// also leaves enough room for the longest red-character line to finish.
const ARGUE_FRAME_DURATION_MS = 83;
const ARGUE_FRAME_COUNT = 48;
const ARGUE_LOOP_MS = ARGUE_FRAME_COUNT * ARGUE_FRAME_DURATION_MS;
const ARGUE_AYA_VOICE_DELAY_MS = 28 * ARGUE_FRAME_DURATION_MS;
const ARGUE_FINAL_LINE_DELAY_MS = ARGUE_LOOP_MS * 2;
const ARGUE_FINAL_LINE_WINDOW_MS = 2400;
const ARGUE_SEQUENCE_DURATION_MS =
  ARGUE_FINAL_LINE_DELAY_MS + ARGUE_FINAL_LINE_WINDOW_MS;

const GLOBAL_VOICES = [
  {
    text: '我在这里陪着你呀。',
    source: '../assets/voices/15-global-here.mp3'
  },
  {
    text: '今天也要好好照顾自己哦。',
    source: '../assets/voices/16-global-care.mp3'
  },
  {
    text: '能见到你，我很开心。',
    source: '../assets/voices/17-global-happy.mp3'
  }
];

const ACTION_VOICES = {
  idle: [
    {
      text: '枫哥牛逼！',
      source: '../assets/voices/18-idle-feng-ge-awesome.mp3'
    },
    {
      text: '请勿打扰。',
      source: '../assets/voices/19-idle-do-not-disturb.mp3'
    },
    {
      text: '胖头鱼受死！',
      source: '../assets/voices/20-idle-pangtouyu.mp3'
    }
  ],
  argue: [
    {
      openingText: '我奶哥敢吃屎。',
      openingSource: '../assets/voices/23-argue-red-nai-ge-dare.mp3',
      text: '我峰哥也敢吃。',
      source: '../assets/voices/21-argue-feng-ge-also.mp3'
    },
    {
      openingText: '我奶哥敢吃三斤。',
      openingSource: '../assets/voices/24-argue-red-nai-ge-three-jin.mp3',
      text: '我峰哥敢吃五斤。',
      source: '../assets/voices/22-argue-feng-ge-five-jin.mp3'
    }
  ],
  run: [
    {
      text: '累死雅宝了。',
      source: '../assets/voices/26-run-lap.mp3'
    }
  ]
};

const ARGUE_FINAL_VOICE = {
  text: '枫哥牛逼！',
  source: '../assets/voices/25-argue-red-feng-ge-awesome.mp3'
};

const LIVE_START_VOICE = {
  text: '阿雅开播啦，快来直播间集合呀！',
  source: '../assets/voices/27-live-started.mp3'
};

const LOCAL_VOICES = new Map();
for (const voice of [
  ...GLOBAL_VOICES,
  ...Object.values(ACTION_VOICES).flat(),
  ARGUE_FINAL_VOICE,
  LIVE_START_VOICE
]) {
  LOCAL_VOICES.set(voice.text, voice.source);
  if (voice.openingText && voice.openingSource) {
    LOCAL_VOICES.set(voice.openingText, voice.openingSource);
  }
}

let currentModelId = 'duck';
let currentAction = 'run';
let currentState = {
  sleeping: false,
  speechEnabled: true,
  hasFishApiKey: false,
  idleMode: 'run',
  actionEnabled: {
    idle: false,
    walk: false,
    depressed: false,
    argue: false,
    run: true,
    sleep: false
  },
  idleIntervalSeconds: 12
};
let bubbleTimer;
let argumentCaptionTimers = [];
let actionTimer;
let idleTimer;
let pointerDown = null;
let moved = false;
let ignoringMouse = false;
let speechRequestId = 0;
let activeAudio = null;
let lastVoiceText = '';
let manualActionUntil = 0;
let currentLiveRoom = {
  roomId: '9667590',
  ownerName: '阿雅Midori',
  roomName: '',
  status: 'unknown',
  checkedAt: null,
  becameLiveAt: null,
  error: ''
};
let lastAnnouncedLiveStartedAt = Number(
  sessionStorage.getItem('mint-pet-live-announced-at') || 0
);

function preloadAssets() {
  for (const model of Object.values(window.PET_MODELS)) {
    for (const source of new Set(Object.values(model.actions))) {
      const image = new Image();
      image.decoding = 'async';
      image.src = source;
    }
  }

  for (const source of new Set(LOCAL_VOICES.values())) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = source;
  }
}

function getCurrentModel() {
  return window.PET_MODELS[currentModelId] || window.PET_MODELS.duck;
}

function getEnabledActionIds() {
  const model = getCurrentModel();
  return ACTION_IDS.filter(
    (action) =>
      Boolean(currentState.actionEnabled?.[action]) &&
      Boolean(model.actions[action])
  );
}

function getFallbackAction() {
  const model = getCurrentModel();
  return (
    getEnabledActionIds()[0] ||
    Object.keys(model.actions)[0] ||
    'run'
  );
}

function isActionEnabled(action) {
  return getEnabledActionIds().includes(action);
}

function clearIdleTimers() {
  clearTimeout(actionTimer);
  clearTimeout(idleTimer);
  actionTimer = undefined;
  idleTimer = undefined;
}

function clearArgumentCaptions() {
  for (const timer of argumentCaptionTimers) {
    clearTimeout(timer);
  }
  argumentCaptionTimers = [];
  argueCaptionLeft.classList.remove('show');
  argueCaptionRight.classList.remove('show');
}

function setAction(action, options = {}) {
  const { restart = false, duration = 0 } = options;
  clearTimeout(actionTimer);

  const model = getCurrentModel();
  const nextAction = isActionEnabled(action) ? action : getFallbackAction();
  const nextSource = model.actions[nextAction];
  currentAction = nextAction;
  if (nextAction !== 'argue') {
    clearArgumentCaptions();
  }
  pet.dataset.action = nextAction;
  pet.classList.toggle('sleeping', nextAction === 'sleep');
  pet.setAttribute(
    'aria-label',
    `小鸭薄荷正在${ACTION_LABELS[nextAction]}，点击播放语音`
  );

  if (petImage.getAttribute('src') !== nextSource) {
    petImage.classList.add('asset-changing');
    setTimeout(() => {
      petImage.src = nextSource;
      petImage.classList.remove('asset-changing');
    }, 70);
  } else if (restart) {
    const currentSource = petImage.src;
    petImage.removeAttribute('src');
    void petImage.offsetWidth;
    petImage.src = currentSource;
  }

  if (duration > 0) {
    actionTimer = setTimeout(() => startIdleBehavior(), duration);
  }
}

function chooseRandomAction() {
  const enabledActions = getEnabledActionIds();
  const candidates = enabledActions.filter(
    (action) => action !== currentAction
  );
  return (
    candidates[Math.floor(Math.random() * candidates.length)] ||
    enabledActions[0] ||
    getFallbackAction()
  );
}

function getIdleIntervalMilliseconds() {
  const seconds = Number(currentState.idleIntervalSeconds);
  const normalized = Number.isFinite(seconds)
    ? Math.min(Math.max(seconds, 3), 300)
    : 12;
  return Math.round(normalized * 1000);
}

function startIdleBehavior() {
  clearIdleTimers();
  manualActionUntil = 0;

  if (currentState.sleeping && isActionEnabled('sleep')) {
    setAction('sleep');
    return;
  }

  const enabledActions = getEnabledActionIds();
  const mode = enabledActions.includes(currentState.idleMode)
    ? currentState.idleMode
    : currentState.idleMode === 'random' && enabledActions.length > 1
      ? 'random'
      : getFallbackAction();
  const nextAction =
    mode === 'random' ? chooseRandomAction() : mode;
  setAction(nextAction, { restart: nextAction === currentAction });

  if (mode === 'random') {
    idleTimer = setTimeout(startIdleBehavior, getIdleIntervalMilliseconds());
  }
}

function setCharacterModel(modelId) {
  if (!window.PET_MODELS[modelId]) {
    return;
  }

  currentModelId = modelId;
  pet.classList.add('model-duck');
  startIdleBehavior();
}

function stopActiveAudio() {
  if (!activeAudio) {
    return;
  }

  activeAudio.pause();
  activeAudio.src = '';
  activeAudio = null;
  voiceStatus.classList.remove('loading', 'playing');
}

async function playAudio(audio) {
  activeAudio = audio;

  audio.addEventListener('playing', () => {
    voiceStatus.classList.remove('loading');
    voiceStatus.classList.add('playing');
  });

  const finish = () => {
    if (activeAudio === audio) {
      activeAudio = null;
    }
    voiceStatus.classList.remove('loading', 'playing');
  };

  audio.addEventListener('ended', finish, { once: true });
  audio.addEventListener('error', finish, { once: true });
  await audio.play();
}

async function speakText(text) {
  if (!currentState.speechEnabled) {
    return;
  }

  const requestId = ++speechRequestId;
  stopActiveAudio();
  voiceStatus.classList.add('loading');

  try {
    const localSource = LOCAL_VOICES.get(text);
    if (localSource) {
      await playAudio(new Audio(localSource));
      return;
    }

    if (!currentState.hasFishApiKey) {
      voiceStatus.classList.remove('loading');
      return;
    }

    const result = await window.petAPI.synthesizeSpeech(text);
    if (requestId !== speechRequestId) {
      return;
    }

    await playAudio(
      new Audio(
        `data:${result.mimeType || 'audio/mpeg'};base64,${result.audioBase64}`
      )
    );
  } catch (error) {
    if (requestId === speechRequestId) {
      voiceStatus.classList.remove('loading', 'playing');
      console.warn('Voice playback failed:', error.message);
    }
  }
}

function showMessage(message, duration = 3200, shouldSpeak = false) {
  clearArgumentCaptions();
  clearTimeout(bubbleTimer);
  speechText.textContent = message;
  bubble.classList.add('show');

  bubbleTimer = setTimeout(() => {
    bubble.classList.remove('show');
  }, duration);

  if (shouldSpeak) {
    speakText(message);
  }
}

function applyLiveRoomStatus(status = {}) {
  currentLiveRoom = { ...currentLiveRoom, ...status };
  const state = ['live', 'offline'].includes(currentLiveRoom.status)
    ? currentLiveRoom.status
    : 'unknown';
  const owner = currentLiveRoom.ownerName || '阿雅Midori';
  const roomId = currentLiveRoom.roomId || '9667590';
  const stateText =
    state === 'live' ? '直播中' : state === 'offline' ? '未开播' : '状态获取中';

  liveStatusDot.dataset.state = state;
  liveStatusDot.title = `${owner} · 房间 ${roomId}：${stateText}`;
  liveStatusDot.setAttribute(
    'aria-label',
    `${owner} 斗鱼房间 ${roomId}，${stateText}`
  );

  const becameLiveAt = Number(currentLiveRoom.becameLiveAt || 0);
  const transitionIsRecent =
    becameLiveAt > 0 && Date.now() - becameLiveAt < 5 * 60 * 1000;
  if (
    state === 'live' &&
    transitionIsRecent &&
    becameLiveAt > lastAnnouncedLiveStartedAt
  ) {
    lastAnnouncedLiveStartedAt = becameLiveAt;
    sessionStorage.setItem(
      'mint-pet-live-announced-at',
      String(becameLiveAt)
    );
    showMessage(LIVE_START_VOICE.text, 5200, false);
    void speakText(LIVE_START_VOICE.text);
    makeParticles(8);
  }
}

function playArgumentExchange() {
  clearTimeout(bubbleTimer);
  bubble.classList.remove('show');
  clearArgumentCaptions();

  const argumentSource = getCurrentModel().actions.argue;
  petImage.classList.remove('asset-changing');
  petImage.removeAttribute('src');
  void petImage.offsetWidth;
  petImage.src = argumentSource;

  function playOpening(voice) {
    argueCaptionLeft.classList.remove('show');
    argueCaptionRight.textContent = voice.openingText;
    argueCaptionRight.classList.add('show');
    void speakText(voice.openingText);
  }

  function playReply(voice) {
    argueCaptionRight.classList.remove('show');
    argueCaptionLeft.textContent = voice.text;
    argueCaptionLeft.classList.add('show');
    void speakText(voice.text);
  }

  ACTION_VOICES.argue.forEach((voice, index) => {
    const loopStart = index * ARGUE_LOOP_MS;
    if (loopStart === 0) {
      playOpening(voice);
    } else {
      argumentCaptionTimers.push(
        setTimeout(() => playOpening(voice), loopStart)
      );
    }

    argumentCaptionTimers.push(
      setTimeout(() => playReply(voice), loopStart + ARGUE_AYA_VOICE_DELAY_MS),
      setTimeout(() => {
        argueCaptionLeft.classList.remove('show');
        argueCaptionRight.classList.remove('show');
      }, loopStart + ARGUE_LOOP_MS - 80)
    );
  });

  argumentCaptionTimers.push(
    setTimeout(() => {
      argueCaptionLeft.classList.remove('show');
      argueCaptionRight.textContent = ARGUE_FINAL_VOICE.text;
      argueCaptionRight.classList.add('show');
      void speakText(ARGUE_FINAL_VOICE.text);
    }, ARGUE_FINAL_LINE_DELAY_MS),
    setTimeout(() => {
      argueCaptionRight.classList.remove('show');
    }, ARGUE_SEQUENCE_DURATION_MS)
  );
}

function makeParticles(count = 4) {
  const glyphs = ['♥', '✦', '♡', '✧'];

  for (let index = 0; index < count; index += 1) {
    const particle = document.createElement('span');
    particle.className = 'particle';
    particle.textContent = glyphs[Math.floor(Math.random() * glyphs.length)];
    particle.style.left = `${38 + Math.random() * 25}%`;
    particle.style.bottom = `${22 + Math.random() * 25}%`;
    particle.style.fontSize = `${12 + Math.random() * 12}px`;
    particle.style.setProperty('--drift', `${-40 + Math.random() * 80}px`);
    particle.style.setProperty('--tilt', `${-22 + Math.random() * 44}deg`);
    particle.style.animationDelay = `${index * 55}ms`;
    particleLayer.appendChild(particle);
    setTimeout(() => particle.remove(), 1450);
  }
}

function chooseVoice(action) {
  const actionPool = ACTION_VOICES[action] || [];
  const pool =
    action === 'argue' && actionPool.length
      ? actionPool
      : actionPool.length && Math.random() >= 0.5
      ? actionPool
      : GLOBAL_VOICES;
  const alternatives = pool.filter((voice) => voice.text !== lastVoiceText);
  const candidates = alternatives.length ? alternatives : pool;
  const voice = candidates[Math.floor(Math.random() * candidates.length)];
  lastVoiceText = voice.text;
  return voice;
}

function playActionVoice(action = currentAction) {
  if (action === 'argue' && ACTION_VOICES.argue.length) {
    playArgumentExchange();
    return;
  }

  const voice = chooseVoice(action);
  showMessage(voice.text, 3900, true);
  makeParticles(ACTION_PARTICLES[action] || 0);
}

function playManualAction(action) {
  if (!isActionEnabled(action)) {
    return;
  }

  clearIdleTimers();
  const minimumActionDuration =
    action === 'argue' ? ARGUE_SEQUENCE_DURATION_MS + 250 : 5000;
  const keepDuration = action === 'sleep'
    ? 0
    : Math.min(
      Math.max(getIdleIntervalMilliseconds(), minimumActionDuration),
      30000
    );
  manualActionUntil = keepDuration > 0
    ? Date.now() + keepDuration
    : Number.POSITIVE_INFINITY;
  setAction(action, { restart: true, duration: keepDuration });
  playActionVoice(action);
}

function applyState(state, initial = false) {
  const previousSleeping = currentState.sleeping;
  const previousIdleMode = currentState.idleMode;
  const previousIdleInterval = currentState.idleIntervalSeconds;
  const previousActionEnabled = JSON.stringify(currentState.actionEnabled);
  currentState = { ...currentState, ...state };
  setCharacterModel(state.characterModel || 'duck');
  applyLiveRoomStatus(state.liveRoom);

  const idleSettingsChanged =
    previousIdleMode !== currentState.idleMode ||
    previousIdleInterval !== currentState.idleIntervalSeconds ||
    previousActionEnabled !== JSON.stringify(currentState.actionEnabled);
  if (
    initial ||
    previousSleeping !== Boolean(currentState.sleeping) ||
    idleSettingsChanged
  ) {
    startIdleBehavior();
  }

  if (!state.speechEnabled) {
    speechRequestId += 1;
    stopActiveAudio();
  }
}

function updateMousePassThrough(event) {
  if (pointerDown) {
    return;
  }

  const isInteractive = Boolean(event.target.closest('[data-interactive]'));
  const shouldIgnore = !isInteractive;

  if (shouldIgnore !== ignoringMouse) {
    ignoringMouse = shouldIgnore;
    window.petAPI.setIgnoreMouse(shouldIgnore);
  }
}

pet.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  pointerDown = {
    pointerId: event.pointerId,
    screenX: event.screenX,
    screenY: event.screenY
  };
  moved = false;
  pet.setPointerCapture(event.pointerId);
  window.petAPI.startDrag({ screenX: event.screenX, screenY: event.screenY });
});

pet.addEventListener('pointermove', (event) => {
  if (!pointerDown || event.pointerId !== pointerDown.pointerId) {
    return;
  }

  const distance = Math.hypot(
    event.screenX - pointerDown.screenX,
    event.screenY - pointerDown.screenY
  );

  if (distance > 4) {
    moved = true;
  }

  if (moved) {
    window.petAPI.moveDrag({ screenX: event.screenX, screenY: event.screenY });
  }
});

function finishPointer(event) {
  if (!pointerDown || event.pointerId !== pointerDown.pointerId) {
    return;
  }

  const wasMoved = moved;
  pointerDown = null;
  moved = false;
  window.petAPI.endDrag();

  if (!wasMoved) {
    playActionVoice(currentAction);
  }
}

pet.addEventListener('pointerup', finishPointer);
pet.addEventListener('pointercancel', (event) => {
  if (pointerDown && event.pointerId === pointerDown.pointerId) {
    pointerDown = null;
    moved = false;
    window.petAPI.endDrag();
  }
});

pet.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.petAPI.showMenu();
});

pet.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    playActionVoice(currentAction);
  }
});

document.addEventListener('mousemove', updateMousePassThrough);

window.petAPI.onState((state) => {
  applyState(state);
});

window.petAPI.onCommand((command) => {
  if (command === 'pat') {
    playActionVoice(currentAction);
  } else if (isActionEnabled(command)) {
    playManualAction(command);
  } else if (command === 'model-changed') {
    startIdleBehavior();
  }
});

window.petAPI.onLiveStatus((status) => {
  applyLiveRoomStatus(status);
});

preloadAssets();

window.petAPI.getState().then((state) => {
  applyState(state, true);
  setTimeout(() => {
    showMessage('小鸭薄荷准备好了，点击我听语音。', 3000, false);
  }, 550);
});
