const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const outputPath = path.join(
  projectRoot,
  'assets',
  'voices',
  '27-live-started.mp3'
);
const reportPath = path.join(
  projectRoot,
  'test-output',
  'live-voice-generation.json'
);
const voice = {
  text: '阿雅开播啦，快来直播间集合呀！',
  cue: '[warm, cheerful, lively, friendly, cute, natural announcement]',
  expectedDirection:
    '轻快亲切地招呼大家集合，语气自然、有笑意，不要过度激动，结尾俏皮上扬。'
};

async function connectToPet() {
  const targets = await fetch('http://127.0.0.1:9228/json/list').then(
    (response) => response.json()
  );
  const target = targets.find(
    (item) => item.type === 'page' && item.url.endsWith('/src/index.html')
  );

  if (!target) {
    throw new Error('Pet renderer target was not found on port 9228.');
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener(
      'error',
      () => reject(new Error('Could not open the CDP socket.')),
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
  const response = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });

  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text;
    throw new Error(description);
  }

  return response.result.value;
}

async function main() {
  const { socket, command } = await connectToPet();

  try {
    const synthesisText = `${voice.cue} ${voice.text}`;
    const result = await evaluate(
      command,
      `window.petAPI.synthesizeSpeech(${JSON.stringify(synthesisText)}, true)`
    );
    const audio = Buffer.from(result.audioBase64, 'base64');

    if (audio.length < 1024) {
      throw new Error('Fish Audio returned an invalid audio file.');
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, audio);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          model: 's2-pro',
          referenceId: '1a667f2491cd4ac7995645cc4a3747c3',
          ...voice,
          synthesisText,
          output: path.relative(projectRoot, outputPath).replaceAll('\\', '/'),
          bytes: audio.length,
          cached: Boolean(result.cached)
        },
        null,
        2
      )}\n`
    );
    console.log(`Generated ${path.basename(outputPath)} (${audio.length} bytes)`);
  } finally {
    socket.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
