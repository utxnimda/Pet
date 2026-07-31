const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const voiceRoot = path.join(projectRoot, 'assets', 'voices');
const reportPath = path.join(
  projectRoot,
  'test-output',
  'idle-voice-generation.json'
);

const voices = [
  {
    text: '枫哥牛逼！',
    cue: '[excited, admiring, energetic emphasis]',
    expectedDirection: '兴奋崇拜，语速稍快，重读“牛逼”，结尾干脆上扬。',
    output: '18-idle-feng-ge-awesome.mp3'
  },
  {
    text: '请勿打扰。',
    cue: '[calm, cool, firm, slightly impatient]',
    expectedDirection: '冷静克制、略显不耐烦，语速偏慢，像专注工作时的简短提醒。',
    output: '19-idle-do-not-disturb.mp3'
  },
  {
    text: '胖头鱼受死！',
    cue: '[playful challenge, confident, energetic]',
    expectedDirection: '带玩笑感的挑衅，语气自信有冲劲，不演成真正愤怒。',
    output: '20-idle-pangtouyu.mp3'
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
        `window.petAPI.synthesizeSpeech(${JSON.stringify(synthesisText)}, true)`
      );
      const bytes = Buffer.from(result.audioBase64, 'base64');

      if (bytes.length < 1024) {
        throw new Error(`Fish Audio returned an invalid file for ${voice.text}`);
      }

      const outputPath = path.join(voiceRoot, voice.output);
      fs.writeFileSync(outputPath, bytes);
      results.push({
        ...voice,
        synthesisText,
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
        referenceId: '1a667f2491cd4ac7995645cc4a3747c3',
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
