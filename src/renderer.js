const pet = document.querySelector('#pet');
const bubble = document.querySelector('#speech-bubble');
const speechText = document.querySelector('#speech-text');
const particleLayer = document.querySelector('#particle-layer');

const reactions = [
  { message: '嘿嘿，被你发现啦！', className: 'react-happy', particles: 5 },
  { message: '今天也要元气满满～', className: 'react-spin', particles: 4 },
  { message: '再摸一下也可以哦', className: 'react-shy', particles: 6 },
  { message: '我会乖乖陪着你的', className: 'react-squish', particles: 4 },
  { message: '休息一下，喝口水吧', className: 'react-happy', particles: 5 },
  { message: '桌面巡逻中！一切正常', className: 'react-spin', particles: 3 }
];

const sleepMessages = ['晚安啦，做个好梦…', '呼…让我眯一小会儿', 'Zzz…'];
const wakeMessages = ['早呀！我醒啦', '充满电，继续陪你！'];
const reactionClasses = reactions.map((reaction) => reaction.className);

let reactionIndex = Math.floor(Math.random() * reactions.length);
let bubbleTimer;
let animationTimer;
let isSleeping = false;
let pointerDown = null;
let moved = false;
let ignoringMouse = false;

function showMessage(message, duration = 2500) {
  clearTimeout(bubbleTimer);
  speechText.textContent = message;
  bubble.classList.add('show');

  bubbleTimer = setTimeout(() => {
    bubble.classList.remove('show');
  }, duration);
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
  if (isSleeping) {
    setSleeping(false);
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
  showMessage(reaction.message);
  makeParticles(reaction.particles);

  clearTimeout(animationTimer);
  animationTimer = setTimeout(() => {
    pet.classList.remove(...reactionClasses);
  }, 900);
}

function setSleeping(sleeping, syncMain = false) {
  isSleeping = Boolean(sleeping);
  pet.classList.toggle('sleeping', isSleeping);
  pet.setAttribute(
    'aria-label',
    isSleeping ? '叫醒薄荷小陪伴' : '摸摸薄荷小陪伴'
  );

  if (isSleeping) {
    showMessage(sleepMessages[Math.floor(Math.random() * sleepMessages.length)]);
  } else {
    showMessage(wakeMessages[Math.floor(Math.random() * wakeMessages.length)]);
    makeParticles(5);
  }

  if (syncMain) {
    window.petAPI.setSleeping(isSleeping);
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
  const nextSleeping = Boolean(state.sleeping);
  if (nextSleeping !== isSleeping) {
    setSleeping(nextSleeping);
  }
});

window.petAPI.onCommand((command) => {
  if (command === 'pat') {
    playReaction('pat');
  }
});

window.petAPI.onMotion((motion) => {
  pet.classList.toggle('walking', Boolean(motion.active));
  pet.classList.toggle(
    'facing-left',
    Boolean(motion.active) && motion.direction === 'left'
  );
});

window.petAPI.getState().then((state) => {
  isSleeping = Boolean(state.sleeping);
  pet.classList.toggle('sleeping', isSleeping);

  setTimeout(() => {
    showMessage(isSleeping ? '嘘…我在打盹' : '我来陪你啦！', 2800);
  }, 550);
});
