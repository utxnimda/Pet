const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, 'test-output');
fs.mkdirSync(outputRoot, { recursive: true });

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inspectMotion(name) {
  const animationPath = path.join(
    projectRoot,
    'assets',
    'motion',
    `duck-${name}.png`
  );
  const animationBytes = fs.readFileSync(animationPath);
  const animationText = animationBytes.toString('latin1');

  return {
    name,
    encodedFrames: animationText.split('fcTL').length - 1,
    hasAnimationHeader: animationText.includes('acTL'),
    hasAlphaFlag: animationBytes[25] === 6,
    bytes: animationBytes.length
  };
}

async function connectToPet() {
  const targets = await fetch('http://127.0.0.1:9228/json/list').then((response) =>
    response.json()
  );
  const target = targets.find(
    (item) => item.type === 'page' && item.url.endsWith('/src/index.html')
  );

  if (!target) {
    throw new Error('Pet renderer target was not found.');
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener(
      'error',
      () => reject(new Error('Could not open CDP socket.')),
      { once: true }
    );
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);

    if (handler) {
      pending.delete(message.id);
      handler(message);
    }
  });

  function command(method, params = {}) {
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      pending.set(id, (message) => {
        if (message.error) {
          reject(new Error(message.error.message));
        } else {
          resolve(message.result);
        }
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return { socket, command };
}

async function evaluate(command, expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }

  return result.result.value;
}

async function capture(command, filename) {
  const result = await command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  });
  const filePath = path.join(outputRoot, filename);
  const bytes = Buffer.from(result.data, 'base64');
  fs.writeFileSync(filePath, bytes);
  return { filePath, hash: sha256(bytes) };
}

async function sampleAction(command, action, delay) {
  await evaluate(
    command,
    `(() => {
      bubble.classList.remove('show');
      manualActionUntil = Date.now() + 30000;
      setAction('${action}');
      return petImage.getAttribute('src');
    })()`
  );
  await sleep(80);

  const screenshots = [];

  for (let index = 0; index < 3; index += 1) {
    screenshots.push(
      await capture(command, `${action}-playback-${index + 1}.png`)
    );
    await sleep(delay);
  }

  const state = await evaluate(
    command,
    `({
      model: currentModelId,
      source: petImage.getAttribute('src'),
      loaded: petImage.complete && petImage.naturalWidth > 0,
      naturalWidth: petImage.naturalWidth,
      naturalHeight: petImage.naturalHeight
    })`
  );

  return {
    ...state,
    screenshotHashes: screenshots.map((item) => item.hash),
    uniqueScreenshots: new Set(screenshots.map((item) => item.hash)).size
  };
}

async function verifyInteractionRouting(command) {
  return evaluate(
    command,
    `(() => {
      const actions = getEnabledActionIds();
      const previousRandom = Math.random;
      const previousLastVoiceText = lastVoiceText;
      const previousState = {
        sleeping: currentState.sleeping,
        idleMode: currentState.idleMode,
        idleIntervalSeconds: currentState.idleIntervalSeconds
      };

      try {
        const voiceRouting = Object.fromEntries(actions.map((action) => {
          lastVoiceText = '';
          Math.random = () => 0.1;
          const globalVoice = chooseVoice(action);
          lastVoiceText = '';
          Math.random = () => 0.9;
          const actionVoice = chooseVoice(action);
          return [action, {
            globalText: globalVoice.text,
            globalSource: globalVoice.source,
            globalPoolMatched: GLOBAL_VOICES.some(
              (voice) => voice.source === globalVoice.source
            ),
            actionText: actionVoice.text,
            actionSource: actionVoice.source,
            actionPoolMatched: (ACTION_VOICES[action] || []).some(
              (voice) => voice.source === actionVoice.source
            ),
            exclusiveActionOnly:
              action === 'argue' &&
              (ACTION_VOICES[action] || []).includes(globalVoice) &&
              (ACTION_VOICES[action] || []).includes(actionVoice)
          }];
        }));

        currentState.sleeping = false;
        currentState.idleMode = actions[0];
        currentState.idleIntervalSeconds = 3;
        startIdleBehavior();
        const fixedIdleAction = currentAction;

        return {
          configuredIdleMode: previousState.idleMode,
          configuredIdleIntervalSeconds:
            previousState.idleIntervalSeconds,
          fixedIdleAction,
          fixedIdleActionValid: actions.includes(fixedIdleAction),
          voiceRouting
        };
      } finally {
        Math.random = previousRandom;
        lastVoiceText = previousLastVoiceText;
        currentState.sleeping = previousState.sleeping;
        currentState.idleMode = previousState.idleMode;
        currentState.idleIntervalSeconds =
          previousState.idleIntervalSeconds;
        startIdleBehavior();
      }
    })()`
  );
}

async function verifyArgumentCaptions(command) {
  const previousSpeechEnabled = await evaluate(
    command,
    'currentState.speechEnabled'
  );

  try {
    await evaluate(
      command,
      `currentState.speechEnabled = false;
       setAction('argue', { restart: true });
       true`
    );
    await sleep(180);

    const firstCaption = await evaluate(
      command,
      `(() => {
        playArgumentExchange();
        return {
          dialogues: ACTION_VOICES.argue.map(
            ({ openingText, openingSource, text, source }) => ({
              openingText,
              openingSource,
              text,
              source
            })
          ),
          finalVoice: ARGUE_FINAL_VOICE,
          leftVisible: argueCaptionLeft.classList.contains('show'),
          rightText: argueCaptionRight.textContent,
          rightVisible: argueCaptionRight.classList.contains('show')
        };
      })()`
    );
    await capture(command, 'argue-caption-red.png');
    await sleep(2400);

    const replyCaption = await evaluate(
      command,
      `({
        leftText: argueCaptionLeft.textContent,
        leftVisible: argueCaptionLeft.classList.contains('show'),
        rightVisible: argueCaptionRight.classList.contains('show')
      })`
    );
    await capture(command, 'argue-caption-aya.png');
    await sleep(2200);

    const secondOpeningCaption = await evaluate(
      command,
      `({
        leftVisible: argueCaptionLeft.classList.contains('show'),
        rightText: argueCaptionRight.textContent,
        rightVisible: argueCaptionRight.classList.contains('show')
      })`
    );
    await capture(command, 'argue-caption-red-second.png');
    await sleep(1800);

    const secondReplyCaption = await evaluate(
      command,
      `({
        leftText: argueCaptionLeft.textContent,
        leftVisible: argueCaptionLeft.classList.contains('show'),
        rightVisible: argueCaptionRight.classList.contains('show')
      })`
    );
    await capture(command, 'argue-caption-aya-second.png');
    await sleep(1600);

    const finalOpeningCaption = await evaluate(
      command,
      `({
        leftVisible: argueCaptionLeft.classList.contains('show'),
        rightText: argueCaptionRight.textContent,
        rightVisible: argueCaptionRight.classList.contains('show')
      })`
    );
    await capture(command, 'argue-caption-red-final.png');
    await sleep(2500);

    const cleared = await evaluate(
      command,
      `({
        leftVisible: argueCaptionLeft.classList.contains('show'),
        rightVisible: argueCaptionRight.classList.contains('show')
      })`
    );

    return {
      firstCaption,
      replyCaption,
      secondOpeningCaption,
      secondReplyCaption,
      finalOpeningCaption,
      cleared
    };
  } finally {
    await evaluate(
      command,
      `currentState.speechEnabled = ${JSON.stringify(previousSpeechEnabled)};
       clearArgumentCaptions();
       true`
    );
  }
}

async function run() {
  const { socket, command } = await connectToPet();
  try {
    await command('Runtime.enable');
    await command('Page.enable');

    const publicState = await evaluate(
      command,
      'window.petAPI.getState()'
    );
    const actionNames = Object.keys(publicState.actionEnabled).filter(
      (action) =>
        publicState.actionEnabled[action] &&
        publicState.actionAvailable[action]
    );
    const motionFiles = actionNames.map(inspectMotion);
    await evaluate(command, `window.petAPI.setModel('duck'); true`);
    await sleep(300);

    const playback = {};
    for (const action of actionNames) {
      playback[action] = await sampleAction(command, action, 95);
    }
    const interactions = await verifyInteractionRouting(command);
    const argumentCaptions = actionNames.includes('argue')
      ? await verifyArgumentCaptions(command)
      : null;

    await evaluate(
      command,
      `manualActionUntil = 0; setAction(getFallbackAction()); true`
    );

    const report = {
      publicState,
      motionFiles,
      playback,
      interactions,
      argumentCaptions
    };
    const reportPath = path.join(
      outputRoot,
      'generated-motion-verification.json'
    );
    const reportJson = JSON.stringify(report, null, 2);
    try {
      fs.writeFileSync(reportPath, reportJson, 'utf8');
    } catch (error) {
      if (error.code !== 'UNKNOWN' && error.code !== 'EBUSY') {
        throw error;
      }
      fs.writeFileSync(
        path.join(outputRoot, 'generated-motion-verification-latest.json'),
        reportJson,
        'utf8'
      );
    }
    console.log(reportJson);
  } finally {
    socket.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
