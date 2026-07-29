const fs = require('node:fs');
const path = require('node:path');

const API_URL = 'https://api.fish.audio/v1/tts';
const REFERENCE_ID = 'af09f6d5c47545b69dc8bb39d19ce0af';
const OUTPUT_DIRECTORY = path.resolve(__dirname, '..', 'voices');

const phrases = [
  { id: 'discovered', text: '嘿嘿，被你发现啦！' },
  { id: 'energetic', text: '今天也要元气满满！' },
  { id: 'pat-again', text: '再摸一下也可以哦。' },
  { id: 'stay-with-you', text: '我会乖乖陪着你的。' },
  { id: 'drink-water', text: '休息一下，喝口水吧。' },
  { id: 'patrol-ok', text: '桌面巡逻中！一切正常。' },
  { id: 'hello-wave', text: '嗨！见到你真好！' },
  { id: 'take-off', text: '起飞！' },
  { id: 'good-night', text: '晚安啦，做个好梦。' },
  { id: 'good-morning', text: '早呀！我醒啦。' },
  { id: 'fully-charged', text: '充满电，继续陪你！' },
  { id: 'duck-arrived', text: '小鸭也来陪你啦！' }
];

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function synthesize(apiKey, phrase, outputPath) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      model: 's2-pro'
    },
    body: JSON.stringify({
      text: phrase.text,
      reference_id: REFERENCE_ID,
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
    })
  });

  if (!response.ok) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data.message || data.detail || JSON.stringify(data);
    } catch {
      detail = await response.text();
    }
    throw new Error(`${response.status} ${detail}`.trim());
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) {
    throw new Error('Fish Audio returned an empty response.');
  }

  await fs.promises.writeFile(outputPath, audio);
  return audio.length;
}

async function main() {
  const apiKey = String(process.env.FISH_AUDIO_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('FISH_AUDIO_API_KEY is not set.');
  }

  await fs.promises.mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const manifest = {
    generatedAt: new Date().toISOString(),
    provider: 'Fish Audio',
    endpoint: API_URL,
    backend: 's2-pro',
    referenceId: REFERENCE_ID,
    files: []
  };

  for (const [index, phrase] of phrases.entries()) {
    const filename = `${String(index + 1).padStart(2, '0')}-${phrase.id}.mp3`;
    const outputPath = path.join(OUTPUT_DIRECTORY, filename);
    process.stdout.write(`[${index + 1}/${phrases.length}] ${phrase.text} ... `);

    try {
      const bytes = await synthesize(apiKey, phrase, outputPath);
      console.log(`${Math.round(bytes / 1024)} KiB`);
      manifest.files.push({ ...phrase, filename, bytes });
    } catch (error) {
      console.log(`FAILED (${error.message})`);
      manifest.files.push({ ...phrase, filename, error: error.message });
    }

    if (index < phrases.length - 1) {
      await sleep(350);
    }
  }

  await fs.promises.writeFile(
    path.join(OUTPUT_DIRECTORY, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  const succeeded = manifest.files.filter((item) => !item.error).length;
  console.log(`Generated ${succeeded}/${phrases.length} voice files.`);

  if (!succeeded) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
