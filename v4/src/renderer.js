const pet = document.querySelector('#pet');
const petImage = document.querySelector('#pet-image');
const bubble = document.querySelector('#speech-bubble');
const speechText = document.querySelector('#speech-text');
const particleLayer = document.querySelector('#particle-layer');
const voiceStatus = document.querySelector('#voice-status');

const LOCAL_VOICES = {
  '嘿嘿，被你发现啦！': '../assets/voices/01-discovered.mp3',
  '今天也要元气满满～': '../assets/voices/02-energetic.mp3',
  '再摸一下也可以哦': '../assets/voices/03-pat-again.mp3',
  '我会乖乖陪着你的': '../assets/voices/04-stay-with-you.mp3',
  '休息一下，喝口水吧': '../assets/voices/05-drink-water.mp3',
  '桌面巡逻中！一切正常': '../assets/voices/06-patrol-ok.mp3',
  '嗨～见到你真好！': '../assets/voices/07-hello-wave.mp3',
  '起飞！': '../assets/voices/08-take-off.mp3',
  '晚安啦，做个好梦…': '../assets/voices/09-good-night.mp3',
  '呼…让我眯一小会儿': '../assets/voices/09-good-night.mp3',
  'Zzz…': '../assets/voices/09-good-night.mp3',
  '早呀！我醒啦': '../assets/voices/10-good-morning.mp3',
  '充满电，继续陪你！': '../assets/voices/11-fully-charged.mp3',
  '小鸭也来陪你啦！': '../assets/voices/12-duck-arrived.mp3'
};

const reactions = [
  {
    message: '嘿嘿，被你发现啦！',
    className: 'react-happy',
    action: 'run',
    particles: 5
  },
  {
    message: '今天也要元气满满～',
    className: 'react-spin',
    action: 'run',
    particles: 4
  },
  {
    message: '再摸一下也可以哦',
    className: 'react-shy',
    action: 'walk',
    particles: 6
  },
  {
    message: '我会乖乖陪着你的',
    className: 'react-squish',
    action: 'walk',
    particles: 4
  },
  {
    message: '休息一下，喝口水吧',
    className: 'react-happy',
    action: 'walk',
    particles: 5
  },
  {
    message: '桌面巡逻中！一切正常',
    className: 'react-spin',
    action: 'walk',
    particles: 3
  }
];

const sleepMessages = ['晚安啦，做个好梦…', '呼…让我眯一小会儿', 'Zzz…'];
const wakeMessages = ['早呀！我醒啦', '充满电，继续陪你！'];
const reactionClasses = reactions.map((reaction) => reaction.className);

let reactionIndex = Math.floor(Math.random() * reactions.length);
let currentModelId = 'classic';
let currentState = {
  sleeping: false,
  speechEnabled: true,
  hasFishApiKey: false
};
let bubbleTimer;
let animationTimer;
let actionTimer;
let pointerDown = null;
let moved = false;
let ignoringMouse = false;
let speechRequestId = 0;
let activeAudio = null;

function preloadAssets() {
  for (const model of Object.values(window.PET_MODELS)) {
    for (const source of new Set(Object.values(model.actions))) {
      const image = new Image();
      image.decoding = 'async';
      image.src = source;
    }
  }

  for (const source of new Set(Object.values(LOCAL_VOICES))) {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = source;
  }
}

function getCurrentModel() {
  return window.PET_MODELS[currentModelId] || window.PET_MODELS.classic;
}

function setAction(action, duration = 0) {
  clearTimeout(actionTimer);

  const model = getCurrentModel();
  const nextAction = model.actions[action] ? action : 'idle';
  const nextSource = model.actions[nextAction];

  if (petImage.getAttribute('src') !== nextSource) {
    petImage.classList.add('asset-changing');
    setTimeout(() => {
      petImage.src = nextSource;
      petImage.classList.remove('asset-changing');
    }, 70);
  } else if (action !== 'idle') {
    const currentSource = petImage.src;
    petImage.removeAttribute('src');
    void petImage.offsetWidth;
    petImage.src = currentSource;
  }

  if (duration > 0) {
    actionTimer = setTimeout(() => {
      setAction(currentState.sleeping ? 'sleep' : 'idle');
    }, duration);
  }
}

function setCharacterModel(modelId) {
  if (!window.PET_MODELS[modelId]) {
    return;
  }

  currentModelId = modelId;
  pet.classList.toggle('model-duck', modelId === 'duck');
  setAction(currentState.sleeping ? 'sleep' : 'idle');
}

function stopActiveAudio() {
  if (!activeAudio) {
    return;
  }

  activeAudio.pause();
  activeAudio.src = '';
  activeAudio = null;
  pet.classList.remove('talking');
  voiceStatus.classList.remove('loading', 'playing');
}

async function playAudio(audio) {
  activeAudio = audio;

  audio.addEventListener('playing', () => {
    voiceStatus.classList.remove('loading');
    voiceStatus.classList.add('playing');
    pet.classList.add('talking');
  });

  const finish = () => {
    if (activeAudio === audio) {
      activeAudio = null;
    }
    voiceStatus.classList.remove('loading', 'playing');
    pet.classList.remove('talking');
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
    const localSource = LOCAL_VOICES[text];

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
      pet.classList.remove('talking');
      console.warn('Voice playback failed:', error.message);
    }
  }
}

function showMessage(message, duration = 2500, shouldSpeak = false) {
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

function makeParticles(count = 5) {
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

function playReaction(forcedType) {
  if (currentState.sleeping) {
    setSleeping(false, true);
    return;
  }

  const reaction =
    forcedType === 'pat'
      ? reactions[reactionIndex % reactions.length]
      : reactions[Math.floor(Math.random() * reactions.length)];

  reactionIndex += 1;
  pet.classList.remove(...reactionClasses);
  void pet.offsetWidth;
  pet.classList.add(reaction.className);
  setAction(reaction.action, 1550);
  showMessage(reaction.message, 2800, true);
  makeParticles(reaction.particles);

  clearTimeout(animationTimer);
  animationTimer = setTimeout(() => {
    pet.classList.remove(...reactionClasses);
  }, 950);
}

function playManualAction(action) {
  if (currentState.sleeping) {
    setSleeping(false, true);
    return;
  }

  if (action === 'wave') {
    setAction('wave', 1650);
    pet.classList.add('react-shy');
    showMessage('嗨～见到你真好！', 2600, true);
    makeParticles(4);
    setTimeout(() => pet.classList.remove('react-shy'), 900);
    return;
  }

  if (action === 'run') {
    setAction('run', 2400);
    pet.classList.add('react-happy');
    showMessage('起飞！', 1800, true);
    makeParticles(6);
    setTimeout(() => pet.classList.remove('react-happy'), 900);
    return;
  }

  if (action === 'jump') {
    setAction('idle');
    pet.classList.remove(...reactionClasses);
    void pet.offsetWidth;
    pet.classList.add('react-happy');
    showMessage('起飞！', 1800, true);
    makeParticles(6);
    setTimeout(() => pet.classList.remove('react-happy'), 900);
  }
}

function setSleeping(sleeping, syncMain = false) {
  currentState.sleeping = Boolean(sleeping);
  pet.classList.toggle('sleeping', currentState.sleeping);
  pet.setAttribute(
    'aria-label',
    currentState.sleeping ? '叫醒薄荷小陪伴' : '摸摸薄荷小陪伴'
  );

  if (currentState.sleeping) {
    setAction('sleep');
    showMessage(
      sleepMessages[Math.floor(Math.random() * sleepMessages.length)],
      2800,
      true
    );
  } else {
    setAction('idle');
    showMessage(
      wakeMessages[Math.floor(Math.random() * wakeMessages.length)],
      2600,
      true
    );
    makeParticles(5);
  }

  if (syncMain) {
    window.petAPI.setSleeping(currentState.sleeping);
  }
}

function applyState(state, initial = false) {
  const previousSleeping = currentState.sleeping;
  const previousModel = currentModelId;
  currentState = { ...currentState, ...state };
  setCharacterModel(state.characterModel || 'classic');

  if (!initial && previousModel !== currentModelId) {
    showMessage(`已切换到「${getCurrentModel().name}」`, 2600, false);
    makeParticles(5);
  }

  if (Boolean(state.sleeping) !== previousSleeping || initial) {
    pet.classList.toggle('sleeping', Boolean(state.sleeping));
    setAction(state.sleeping ? 'sleep' : 'idle');
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
    playReaction('pat');
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
    playReaction('pat');
  }
});

document.addEventListener('mousemove', updateMousePassThrough);

window.petAPI.onState((state) => {
  applyState(state);
});

window.petAPI.onCommand((command) => {
  if (command === 'pat') {
    playReaction('pat');
  } else if (command === 'wave' || command === 'jump' || command === 'run') {
    playManualAction(command);
  } else if (command === 'model-changed') {
    setAction('idle');
  }
});

window.petAPI.onMotion((motion) => {
  const isMoving = Boolean(motion.active);
  pet.classList.toggle('walking', isMoving);
  pet.classList.toggle(
    'facing-left',
    isMoving && motion.direction === 'left'
  );

  if (!currentState.sleeping) {
    setAction(isMoving ? 'walk' : 'idle');
  }
});

preloadAssets();

window.petAPI.getState().then((state) => {
  applyState(state, true);

  setTimeout(() => {
    const greeting =
      currentModelId === 'duck' ? '小鸭也来陪你啦！' : '我来陪你啦！';
    showMessage(state.sleeping ? '嘘…我在打盹' : greeting, 2800, false);
  }, 550);
});
