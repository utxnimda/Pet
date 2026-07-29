const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, 'test-output');
fs.mkdirSync(outputRoot, { recursive: true });

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inspectAnimatedWebP(filePath) {
  const bytes = fs.readFileSync(filePath);
  const text = bytes.toString('latin1');

  return {
    file: path.basename(filePath),
    bytes: bytes.length,
    hasAnimationHeader: text.includes('ANIM'),
    frameCount: text.split('ANMF').length - 1,
    hasAlphaFlag: (bytes[20] & 0x10) === 0x10
  };
}

async function connectToPet() {
  const targets = await fetch('http://127.0.0.1:9226/json/list').then((response) =>
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
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
  return filePath;
}

async function run() {
  const animationRoot = path.join(projectRoot, 'assets', 'animations');
  const animations = fs
    .readdirSync(animationRoot)
    .filter((name) => name.endsWith('.webp'))
    .sort()
    .map((name) => inspectAnimatedWebP(path.join(animationRoot, name)));

  const { socket, command } = await connectToPet();
  await command('Runtime.enable');
  await command('Page.enable');

  const initial = await evaluate(
    command,
    `({
      model: currentModelId,
      speechEnabled: currentState.speechEnabled,
      hasFishApiKey: currentState.hasFishApiKey,
      source: petImage.getAttribute('src'),
      loaded: petImage.complete && petImage.naturalWidth > 0
    })`
  );

  await evaluate(
    command,
    `(() => {
      bubble.classList.remove('show');
      pet.classList.remove(...reactionClasses);
      setAction('idle');
      return true;
    })()`
  );
  await sleep(120);
  const idleFrameA = await capture(command, 'idle-frame-a.png');
  await sleep(420);
  const idleFrameB = await capture(command, 'idle-frame-b.png');
  const idleHashA = crypto
    .createHash('sha256')
    .update(fs.readFileSync(idleFrameA))
    .digest('hex');
  const idleHashB = crypto
    .createHash('sha256')
    .update(fs.readFileSync(idleFrameB))
    .digest('hex');

  await evaluate(command, `playReaction('pat'); true`);
  await sleep(220);
  const clickReaction = await evaluate(
    command,
    `({
      bubbleVisible: bubble.classList.contains('show'),
      bubbleText: speechText.textContent,
      voiceState: voiceStatus.className,
      talking: pet.classList.contains('talking'),
      audioPlaying: Boolean(activeAudio && !activeAudio.paused && activeAudio.currentTime > 0),
      source: petImage.getAttribute('src')
    })`
  );

  await evaluate(command, `window.petAPI.setModel('duck'); true`);
  await sleep(350);
  await evaluate(command, `window.petAPI.triggerAction('wave'); true`);
  await sleep(220);
  const duckWave = await evaluate(
    command,
    `({
      model: currentModelId,
      bubbleText: speechText.textContent,
      voiceState: voiceStatus.className,
      talking: pet.classList.contains('talking'),
      audioPlaying: Boolean(activeAudio && !activeAudio.paused && activeAudio.currentTime > 0),
      source: petImage.getAttribute('src'),
      loaded: petImage.complete && petImage.naturalWidth > 0
    })`
  );
  const duckScreenshot = await capture(command, 'duck-wave.png');

  socket.close();

  const report = {
    initial,
    animations,
    idleFramesChanged: idleHashA !== idleHashB,
    idleFrameA,
    idleFrameB,
    clickReaction,
    duckWave,
    duckScreenshot
  };

  const reportPath = path.join(outputRoot, 'verification.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
