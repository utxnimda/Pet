const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const voiceRoot = path.join(projectRoot, 'assets', 'voices');
const reportPath = path.join(
  projectRoot,
  'test-output',
  'argue-red-voice-generation.json'
);
const referenceId = '09d7bda515cd4b3cbb21613a3a6bab88';

const voices = [
  {
    text: '我奶哥敢吃屎。',
    cue: '[argumentative, defiant, sharp, emphatic, fast-paced]',
    expectedDirection: '红衣角色先发难，语气挑衅、短促，重读“我奶哥”和“敢”。',
    output: '23-argue-red-nai-ge-dare.mp3'
  },
  {
    text: '我奶哥敢吃三斤。',
    cue: '[boastful, taunting, competitive, emphatic, fast-paced]',
    expectedDirection: '红衣角色继续抬杠，带夸耀和挑衅感，重读“三斤”。',
    output: '24-argue-red-nai-ge-three-jin.mp3'
  },
  {
    text: '枫哥牛逼！',
    cue: '[excited, impressed, emphatic, bright, punchy]',
    expectedDirection: '红衣角色最后突然高声称赞，短促有力地重读“牛逼”。',
    output: '25-argue-red-feng-ge-awesome.mp3'
  }
];

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
  const results = [];

  try {
    for (const voice of voices) {
      const synthesisText = `${voice.cue} ${voice.text}`;
      const result = await evaluate(
        command,
        `window.petAPI.synthesizeSpeech(
          ${JSON.stringify(synthesisText)},
          true,
          ${JSON.stringify(referenceId)}
        )`
      );
      const bytes = Buffer.from(result.audioBase64, 'base64');
      if (bytes.length < 1024) {
        throw new Error(`Fish Audio returned an invalid file for ${voice.text}`);
      }
      if (result.referenceId !== referenceId) {
        throw new Error(
          `Fish Audio reference mismatch: expected ${referenceId}, got ${result.referenceId || 'unknown'}`
        );
      }

      const outputPath = path.join(voiceRoot, voice.output);
      fs.writeFileSync(outputPath, bytes);
      results.push({
        ...voice,
        synthesisText,
        actualReferenceId: result.referenceId,
        output: path.relative(projectRoot, outputPath).replaceAll('\\', '/'),
        bytes: bytes.length,
        cached: Boolean(result.cached)
      });
      console.log(`Generated ${voice.output} (${bytes.length} bytes)`);
    }
  } finally {
    socket.close();
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: 's2-pro',
        referenceId,
        speaker: 'right/red-dressed character',
        voices: results
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
