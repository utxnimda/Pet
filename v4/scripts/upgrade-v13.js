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

const packagePath = path.join(projectRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
packageJson.version = '1.3.0';
packageJson.description =
  'A multi-character desktop companion with generated pose-to-pose motion and synchronized speech.';

if (!packageJson.build.files.includes('assets/motion/*.webp')) {
  const insertionIndex = packageJson.build.files.indexOf('assets/voices/*.mp3');
  packageJson.build.files.splice(insertionIndex, 0, 'assets/motion/*.webp');
}

fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

const charactersPath = path.join(projectRoot, 'src', 'characters.js');
let charactersSource = fs.readFileSync(charactersPath, 'utf8');

charactersSource = replaceExactly(
  charactersSource,
  "    description: '来自新图片，带小鸭和三套动作',\n" +
    "    thumbnail: '../assets/models/duck/idle.png',\n" +
    '    actions: {\n' +
    "      idle: '../assets/animations/duck-idle.webp',\n" +
    "      wave: '../assets/animations/duck-wave.webp',\n" +
    "      sleep: '../assets/animations/duck-sleep.webp'\n" +
    '    }',
  "    description: '来自新图片，带小鸭和真实逐帧动作',\n" +
    "    thumbnail: '../assets/models/duck/idle.png',\n" +
    '    actions: {\n' +
    "      idle: '../assets/animations/duck-idle.webp',\n" +
    "      wave: '../assets/animations/duck-wave.webp',\n" +
    "      walk: '../assets/motion/duck-walk.webp',\n" +
    "      run: '../assets/motion/duck-run.webp',\n" +
    "      sleep: '../assets/motion/duck-sleep.webp'\n" +
    '    }',
  'duck generated motion assets'
);

fs.writeFileSync(charactersPath, charactersSource, 'utf8');

const mainPath = path.join(projectRoot, 'main.js');
let mainSource = fs.readFileSync(mainPath, 'utf8');

mainSource = replaceExactly(
  mainSource,
  "    {\n" +
    "      label: '跳一下',\n" +
    "      click: () => sendPetCommand('jump')\n" +
    '    },\n' +
    '    {\n' +
    "      label: settings.sleeping ? '叫醒她' : '让她睡觉',",
  "    {\n" +
    "      label: '跳一下',\n" +
    "      click: () => sendPetCommand('jump')\n" +
    '    },\n' +
    '    {\n' +
    "      label: '跑一圈',\n" +
    "      click: () => sendPetCommand('run')\n" +
    '    },\n' +
    '    {\n' +
    "      label: settings.sleeping ? '叫醒她' : '让她睡觉',",
  'run context-menu action'
);

fs.writeFileSync(mainPath, mainSource, 'utf8');

const rendererPath = path.join(projectRoot, 'src', 'renderer.js');
let rendererSource = fs.readFileSync(rendererPath, 'utf8');

rendererSource = replaceExactly(
  rendererSource,
  "    message: '嘿嘿，被你发现啦！',\n" +
    "    className: 'react-happy',\n" +
    "    action: 'wave',",
  "    message: '嘿嘿，被你发现啦！',\n" +
    "    className: 'react-happy',\n" +
    "    action: 'run',",
  'first click motion'
);

rendererSource = replaceExactly(
  rendererSource,
  "    message: '今天也要元气满满～',\n" +
    "    className: 'react-spin',\n" +
    "    action: 'idle',",
  "    message: '今天也要元气满满～',\n" +
    "    className: 'react-spin',\n" +
    "    action: 'run',",
  'second click motion'
);

rendererSource = replaceExactly(
  rendererSource,
  "    message: '再摸一下也可以哦',\n" +
    "    className: 'react-shy',\n" +
    "    action: 'wave',",
  "    message: '再摸一下也可以哦',\n" +
    "    className: 'react-shy',\n" +
    "    action: 'walk',",
  'third click motion'
);

rendererSource = replaceExactly(
  rendererSource,
  "    message: '我会乖乖陪着你的',\n" +
    "    className: 'react-squish',\n" +
    "    action: 'idle',",
  "    message: '我会乖乖陪着你的',\n" +
    "    className: 'react-squish',\n" +
    "    action: 'walk',",
  'fourth click motion'
);

rendererSource = replaceExactly(
  rendererSource,
  "    message: '休息一下，喝口水吧',\n" +
    "    className: 'react-happy',\n" +
    "    action: 'wave',",
  "    message: '休息一下，喝口水吧',\n" +
    "    className: 'react-happy',\n" +
    "    action: 'walk',",
  'fifth click motion'
);

rendererSource = replaceExactly(
  rendererSource,
  "    message: '桌面巡逻中！一切正常',\n" +
    "    className: 'react-spin',\n" +
    "    action: 'idle',",
  "    message: '桌面巡逻中！一切正常',\n" +
    "    className: 'react-spin',\n" +
    "    action: 'walk',",
  'sixth click motion'
);

rendererSource = replaceExactly(
  rendererSource,
  "  if (action === 'jump') {\n",
  "  if (action === 'run') {\n" +
    "    setAction('run', 2400);\n" +
    "    pet.classList.add('react-happy');\n" +
    "    showMessage('起飞！', 1800, true);\n" +
    "    makeParticles(6);\n" +
    "    setTimeout(() => pet.classList.remove('react-happy'), 900);\n" +
    '    return;\n' +
    '  }\n\n' +
    "  if (action === 'jump') {\n",
  'manual run action'
);

rendererSource = replaceExactly(
  rendererSource,
  "} else if (command === 'wave' || command === 'jump') {\n",
  "} else if (command === 'wave' || command === 'jump' || command === 'run') {\n",
  'run command routing'
);

rendererSource = replaceExactly(
  rendererSource,
  "window.petAPI.onMotion((motion) => {\n" +
    "  pet.classList.toggle('walking', Boolean(motion.active));\n" +
    '  pet.classList.toggle(\n' +
    "    'facing-left',\n" +
    "    Boolean(motion.active) && motion.direction === 'left'\n" +
    '  );\n' +
    '});',
  "window.petAPI.onMotion((motion) => {\n" +
    '  const isMoving = Boolean(motion.active);\n' +
    "  pet.classList.toggle('walking', isMoving);\n" +
    '  pet.classList.toggle(\n' +
    "    'facing-left',\n" +
    "    isMoving && motion.direction === 'left'\n" +
    '  );\n\n' +
    '  if (!currentState.sleeping) {\n' +
    "    setAction(isMoving ? 'walk' : 'idle');\n" +
    '  }\n' +
    '});',
  'wander motion routing'
);

fs.writeFileSync(rendererPath, rendererSource, 'utf8');

const settingsPath = path.join(projectRoot, 'src', 'settings.html');
let settingsSource = fs.readFileSync(settingsPath, 'utf8');

settingsSource = replaceExactly(
  settingsSource,
  'MINT PET · 1.2',
  'MINT PET · 1.3',
  'settings version'
);

settingsSource = replaceExactly(
  settingsSource,
  '          <button type="button" data-action="jump">✨ 跳跃</button>\n' +
    '          <button type="button" data-action="sleep">☾ 睡觉</button>',
  '          <button type="button" data-action="jump">✨ 跳跃</button>\n' +
    '          <button type="button" data-action="run">🏃 跑步</button>\n' +
    '          <button type="button" data-action="sleep">☾ 睡觉</button>',
  'settings run button'
);

fs.writeFileSync(settingsPath, settingsSource, 'utf8');

console.log('Applied v1.3 generated-motion integration.');
