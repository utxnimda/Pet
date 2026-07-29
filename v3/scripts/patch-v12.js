const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function replaceExactly(source, oldText, newText, label) {
  const matches = source.split(oldText).length - 1;

  if (matches !== 1) {
    throw new Error(`${label}: expected 1 match, found ${matches}`);
  }

  return source.replace(oldText, newText);
}

const mainPath = path.join(projectRoot, 'main.js');
let mainSource = fs.readFileSync(mainPath, 'utf8');

mainSource = replaceExactly(
  mainSource,
  "  speechEnabled: false,\n  fishVoiceModelId:",
  "  speechEnabled: true,\n  localVoiceReady: true,\n  fishVoiceModelId:",
  'default local speech'
);

mainSource = replaceExactly(
  mainSource,
  "    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));\n" +
    '    settings = { ...DEFAULT_SETTINGS, ...saved };',
  "    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));\n" +
    '    const needsLocalVoiceMigration = saved.localVoiceReady !== true;\n' +
    '    settings = { ...DEFAULT_SETTINGS, ...saved };\n\n' +
    '    if (needsLocalVoiceMigration) {\n' +
    '      settings.speechEnabled = true;\n' +
    '      settings.localVoiceReady = true;\n' +
    '      saveSettings();\n' +
    '    }',
  'local speech migration'
);

mainSource = replaceExactly(
  mainSource,
  "function setSpeechEnabled(value) {\n" +
    '  const enabled = Boolean(value);\n\n' +
    '  if (enabled && !getFishApiKey()) {\n' +
    '    settings.speechEnabled = false;\n' +
    '    saveSettings();\n' +
    '    createSettingsWindow();\n' +
    "    settingsWindow.webContents.send('settings:notice', '请先填写 Fish Audio API Key。');\n" +
    '    return;\n' +
    '  }\n\n' +
    '  settings.speechEnabled = enabled;',
  "function setSpeechEnabled(value) {\n" +
    '  const enabled = Boolean(value);\n\n' +
    '  settings.speechEnabled = enabled;',
  'tray speech toggle'
);

mainSource = replaceExactly(
  mainSource,
  '    settings.speechEnabled = Boolean(input.speechEnabled);\n\n' +
    '    if (settings.speechEnabled && !getFishApiKey()) {\n' +
    '      settings.speechEnabled = false;\n' +
    "      throw new Error('开启语音前请填写 Fish Audio API Key。');\n" +
    '    }\n\n' +
    '    settings.sleeping = false;',
  '    settings.speechEnabled = Boolean(input.speechEnabled);\n' +
    '    settings.localVoiceReady = true;\n\n' +
    '    settings.sleeping = false;',
  'settings speech toggle'
);

mainSource = replaceExactly(
  mainSource,
  '    const data = await response.json();',
  '      const data = await response.clone().json();',
  'Fish Audio error response clone'
);

fs.writeFileSync(mainPath, mainSource, 'utf8');

const settingsPath = path.join(projectRoot, 'src', 'settings.html');
let settingsSource = fs.readFileSync(settingsPath, 'utf8');

settingsSource = replaceExactly(
  settingsSource,
  'MINT PET · 1.1',
  'MINT PET · 1.2',
  'settings version'
);

settingsSource = replaceExactly(
  settingsSource,
  '<span>Fish Audio 语音</span>\n' +
    '            <small>文字会传给 Fish Audio 生成 MP3</small>',
  '<span>气泡语音</span>\n' +
    '            <small>已知对白播放本地 MP3，新文字可用 Fish Audio</small>',
  'voice section copy'
);

settingsSource = replaceExactly(
  settingsSource,
  '<span>API Key</span>',
  '<span>API Key（仅新文字需要）</span>',
  'optional API key copy'
);

fs.writeFileSync(settingsPath, settingsSource, 'utf8');

console.log('Applied v1.2 local-voice migration and settings copy.');
