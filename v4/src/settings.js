const modelGrid = document.querySelector('#model-grid');
const actionSwitches = document.querySelector('#action-switches');
const speechEnabled = document.querySelector('#speech-enabled');
const idleMode = document.querySelector('#idle-mode');
const idleInterval = document.querySelector('#idle-interval');
const apiKey = document.querySelector('#api-key');
const apiKeyStatus = document.querySelector('#api-key-status');
const voiceModelId = document.querySelector('#voice-model-id');
const previewText = document.querySelector('#preview-text');
const previewSpeech = document.querySelector('#preview-speech');
const voiceResult = document.querySelector('#voice-result');
const saveSettingsButton = document.querySelector('#save-settings');
const notice = document.querySelector('#notice');

const FISH_API_KEYS_URL = 'https://fish.audio/app/api-keys/';
const DEFAULT_FISH_VOICE_MODEL_ID = '1a667f2491cd4ac7995645cc4a3747c3';
const FISH_VOICE_MODEL_URL =
  'https://fish.audio/zh-CN/app/m/1a667f2491cd4ac7995645cc4a3747c3/';
const ACTIONS = [
  { id: 'idle', label: '电脑前待机', icon: '🖥' },
  { id: 'walk', label: '走路', icon: '🚶' },
  { id: 'depressed', label: '低落', icon: '🌧' },
  { id: 'argue', label: '争辩', icon: '💢' },
  { id: 'run', label: '跑一圈', icon: '🏃' },
  { id: 'sleep', label: '睡觉', icon: '☾' }
];

let selectedModel = 'duck';
let actionEnabled = {};
let actionAvailable = {};
let hasSavedApiKey = false;
let clearApiKey = false;
let activePreviewAudio = null;

function setNotice(message, error = false) {
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.classList.add('show');

  setTimeout(() => {
    if (notice.textContent === message) {
      notice.classList.remove('show');
    }
  }, 4200);
}

function updateApiKeyStatus() {
  if (clearApiKey) {
    apiKeyStatus.textContent = '保存后会清除已保存的 Key';
    return;
  }

  if (apiKey.value.trim()) {
    apiKeyStatus.textContent = '将使用 Windows 安全存储加密';
    return;
  }

  apiKeyStatus.textContent = hasSavedApiKey ? '已安全保存' : '尚未保存';
}

function renderModels() {
  modelGrid.replaceChildren();

  for (const model of Object.values(window.PET_MODELS)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-card';
    button.classList.toggle('selected', selectedModel === model.id);
    button.innerHTML = `
      <img src="${model.thumbnail}" alt="" />
      <span>
        <strong>${model.name}</strong>
        <small>${model.description}</small>
      </span>
      <b class="check">✓</b>
    `;

    button.addEventListener('click', () => {
      selectedModel = model.id;
      renderModels();
      window.petAPI.setModel(model.id);
    });

    modelGrid.appendChild(button);
  }
}

function getEnabledAvailableActions() {
  return ACTIONS.filter(
    (action) => actionAvailable[action.id] && actionEnabled[action.id]
  );
}

function renderIdleModes(preferredMode) {
  const enabledActions = getEnabledAvailableActions();
  const optionValues = enabledActions.map((action) => action.id);
  idleMode.replaceChildren();

  for (const action of enabledActions) {
    const option = document.createElement('option');
    option.value = action.id;
    option.textContent = action.label;
    idleMode.appendChild(option);
  }

  if (enabledActions.length > 1) {
    const randomOption = document.createElement('option');
    randomOption.value = 'random';
    randomOption.textContent = '随机轮换';
    idleMode.appendChild(randomOption);
    optionValues.push('random');
  }

  idleMode.value = optionValues.includes(preferredMode)
    ? preferredMode
    : optionValues[0] || 'run';
  idleInterval.disabled = enabledActions.length <= 1;
}

function renderActionSwitches() {
  actionSwitches.replaceChildren();

  for (const action of ACTIONS) {
    const available = Boolean(actionAvailable[action.id]);
    const enabled = available && Boolean(actionEnabled[action.id]);
    const row = document.createElement('div');
    row.className = 'action-switch-row';
    row.classList.toggle('unavailable', !available);

    const text = document.createElement('div');
    text.className = 'action-switch-copy';
    text.innerHTML = `
      <strong>${action.icon} ${action.label}</strong>
      <small>${
        available
          ? enabled
            ? '已开启 · 会显示在右键菜单'
            : '已关闭 · 不显示在右键菜单'
          : '资源未就绪 · 暂不可开启'
      }</small>
    `;

    const label = document.createElement('label');
    label.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = enabled;
    input.disabled = !available;
    input.dataset.actionToggle = action.id;
    const slider = document.createElement('span');
    label.append(input, slider);

    input.addEventListener('change', () => {
      actionEnabled[action.id] = input.checked;

      if (getEnabledAvailableActions().length === 0) {
        actionEnabled[action.id] = true;
        setNotice('至少需要保留一个已有资源的动作。', true);
      }

      renderActionSwitches();
      renderIdleModes(idleMode.value);
    });

    row.append(text, label);
    actionSwitches.appendChild(row);
  }
}

function applyState(state) {
  selectedModel = state.characterModel || selectedModel;
  actionEnabled = { ...(state.actionEnabled || {}) };
  actionAvailable = { ...(state.actionAvailable || {}) };
  idleInterval.value = String(state.idleIntervalSeconds || 12);
  speechEnabled.checked = Boolean(state.speechEnabled);
  voiceModelId.value =
    state.fishVoiceModelId || DEFAULT_FISH_VOICE_MODEL_ID;
  hasSavedApiKey = Boolean(state.hasFishApiKey);
  clearApiKey = false;
  apiKey.value = '';
  updateApiKeyStatus();
  renderModels();
  renderActionSwitches();
  renderIdleModes(state.idleMode || 'run');
}

async function saveForm(silent = false) {
  const payload = {
    characterModel: selectedModel,
    idleMode: idleMode.value,
    idleIntervalSeconds: Number(idleInterval.value),
    actionEnabled: { ...actionEnabled },
    speechEnabled: speechEnabled.checked,
    fishVoiceModelId: voiceModelId.value.trim(),
    apiKey: apiKey.value.trim(),
    clearApiKey
  };

  const state = await window.petAPI.saveSettings(payload);
  applyState(state);

  if (!silent) {
    setNotice('设置已保存。');
  }

  return state;
}

function stopPreviewAudio() {
  if (!activePreviewAudio) {
    return;
  }

  activePreviewAudio.pause();
  activePreviewAudio.src = '';
  activePreviewAudio = null;
}

async function previewVoice() {
  const text = previewText.value.trim();

  if (!text) {
    voiceResult.textContent = '请输入试听文字。';
    voiceResult.classList.add('error');
    return;
  }

  previewSpeech.disabled = true;
  voiceResult.textContent = '正在生成语音…';
  voiceResult.classList.remove('error');

  try {
    await saveForm(true);
    const result = await window.petAPI.synthesizeSpeech(text, true);
    stopPreviewAudio();

    const audio = new Audio(
      `data:${result.mimeType || 'audio/mpeg'};base64,${result.audioBase64}`
    );
    activePreviewAudio = audio;
    audio.addEventListener(
      'ended',
      () => {
        if (activePreviewAudio === audio) {
          activePreviewAudio = null;
        }
      },
      { once: true }
    );

    await audio.play();
    voiceResult.textContent = result.cached
      ? '正在播放缓存语音。'
      : '语音生成成功，正在播放。';
  } catch (error) {
    voiceResult.textContent = error.message || '语音生成失败。';
    voiceResult.classList.add('error');
  } finally {
    previewSpeech.disabled = false;
  }
}

apiKey.addEventListener('input', () => {
  if (apiKey.value.trim()) {
    clearApiKey = false;
  }
  updateApiKeyStatus();
});

document.querySelector('#clear-api-key').addEventListener('click', () => {
  apiKey.value = '';
  clearApiKey = true;
  speechEnabled.checked = false;
  updateApiKeyStatus();
});

document.querySelector('#open-api-keys').addEventListener('click', () => {
  window.petAPI.openExternal(FISH_API_KEYS_URL);
});

document.querySelector('#open-voice-model').addEventListener('click', () => {
  window.petAPI.openExternal(FISH_VOICE_MODEL_URL);
});

previewSpeech.addEventListener('click', previewVoice);

saveSettingsButton.addEventListener('click', async () => {
  saveSettingsButton.disabled = true;

  try {
    await saveForm();
  } catch (error) {
    setNotice(error.message || '保存失败。', true);
  } finally {
    saveSettingsButton.disabled = false;
  }
});

window.petAPI.onState((state) => {
  if (
    !apiKey.matches(':focus') &&
    !voiceModelId.matches(':focus') &&
    !idleMode.matches(':focus') &&
    !idleInterval.matches(':focus') &&
    !actionSwitches.contains(document.activeElement)
  ) {
    applyState(state);
  }
});

window.petAPI.onSettingsNotice((message) => {
  setNotice(message, true);
});

window.petAPI.getState().then(applyState);
