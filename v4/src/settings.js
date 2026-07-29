const modelGrid = document.querySelector('#model-grid');
const speechEnabled = document.querySelector('#speech-enabled');
const apiKey = document.querySelector('#api-key');
const apiKeyStatus = document.querySelector('#api-key-status');
const voiceModelId = document.querySelector('#voice-model-id');
const previewText = document.querySelector('#preview-text');
const previewSpeech = document.querySelector('#preview-speech');
const voiceResult = document.querySelector('#voice-result');
const saveSettingsButton = document.querySelector('#save-settings');
const notice = document.querySelector('#notice');

const FISH_API_KEYS_URL = 'https://fish.audio/app/api-keys/';
const DEFAULT_FISH_VOICE_MODEL_ID = '815acd1baeed4cc987e24e186424ac02';
const FISH_VOICE_MODEL_URL =
  'https://fish.audio/zh-CN/app/m/815acd1baeed4cc987e24e186424ac02/';

let selectedModel = 'classic';
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

function applyState(state) {
  selectedModel = state.characterModel || selectedModel;
  speechEnabled.checked = Boolean(state.speechEnabled);
  voiceModelId.value =
    state.fishVoiceModelId || DEFAULT_FISH_VOICE_MODEL_ID;
  hasSavedApiKey = Boolean(state.hasFishApiKey);
  clearApiKey = false;
  apiKey.value = '';
  updateApiKeyStatus();
  renderModels();
}

async function saveForm(silent = false) {
  const payload = {
    characterModel: selectedModel,
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

document.querySelectorAll('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    window.petAPI.triggerAction(button.dataset.action);
  });
});

window.petAPI.onState((state) => {
  if (!apiKey.matches(':focus') && !voiceModelId.matches(':focus')) {
    applyState(state);
  }
});

window.petAPI.onSettingsNotice((message) => {
  setNotice(message, true);
});

window.petAPI.getState().then(applyState);
