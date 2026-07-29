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
    `duck-${name}.webp`
  );
  const animationBytes = fs.readFileSync(animationPath);
  const animationText = animationBytes.toString('latin1');
  const frameDirectory = path.join(
    projectRoot,
    'assets',
    'frames',
    'duck',
    name
  );
  const frameHashes = fs
    .readdirSync(frameDirectory)
    .filter((file) => file.endsWith('.png'))
    .sort()
    .map((file) => sha256(fs.readFileSync(path.join(frameDirectory, file))));

  return {
    name,
    sourceFrames: frameHashes.length,
    uniqueSourceFrames: new Set(frameHashes).size,
    encodedFrames: animationText.split('ANMF').length - 1,
    hasAnimationHeader: animationText.includes('ANIM'),
    hasAlphaFlag: (animationBytes[20] & 0x10) === 0x10,
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
      pet.classList.remove(...reactionClasses);
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

async function run() {
  const motionFiles = ['run', 'walk', 'sleep'].map(inspectMotion);
  const { socket, command } = await connectToPet();
  await command('Runtime.enable');
  await command('Page.enable');

  await evaluate(command, `window.petAPI.setModel('duck'); true`);
  await sleep(300);

  const playback = {
    run: await sampleAction(command, 'run', 95),
    walk: await sampleAction(command, 'walk', 135),
    sleep: await sampleAction(command, 'sleep', 270)
  };

  await evaluate(command, `setAction('idle'); true`);
  socket.close();

  const report = {
    motionFiles,
    playback
  };
  const reportPath = path.join(outputRoot, 'generated-motion-verification.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
