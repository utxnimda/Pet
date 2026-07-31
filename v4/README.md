# 雅宝桌面宠物

Windows 透明桌面宠物。动作按“资源已就绪 + 设置中已开启”共同控制。

## 当前状态

- 当前可用的动作：电脑前待机、争辩、跑一圈；争辩与跑一圈默认开启。
- 一般待机默认使用电脑前待机动画。
- 电脑前待机动画：`assets/motion/duck-idle.png`。
- 跑步动画：`assets/motion/duck-run.png`。
- 双人争辩动画：`assets/motion/duck-argue.png`。
- 电脑前待机专属语音：`枫哥牛逼！`、`请勿打扰。`、`胖头鱼受死！`，对应 `assets/voices/18-idle-*.mp3` 至 `20-idle-*.mp3`。
- 三条语音使用 S2-Pro 自然语言标签生成；标签和预期演绎记录在 `scripts/generate-idle-voices.js` 与 `test-output/idle-voice-generation.json`。
- 跑步专属语音：`assets/voices/26-run-lap.mp3`。
- 争辩固定完整播放五句专属对白，不进入通用语音随机池：红衣与阿雅先完成两轮对话，最后一处红衣空口型补上“枫哥牛逼！”。
- 红衣语音使用 Fish 模型 `09d7bda515cd4b3cbb21613a3a6bab88`，对应 `assets/voices/23-argue-*.mp3` 至 `25-argue-*.mp3`；生成报告同时记录并校验接口实际返回的 reference ID。阿雅继续使用 `21-argue-*.mp3` 与 `22-argue-*.mp3`。
- 争辩动画从原视频第 31 帧开始播放。每轮红衣在第 0 帧开口，阿雅延迟 28 帧（约 2.324 秒），等待红衣完整说完并在阿雅张口帧接话；第二组对白在下一轮动画继续播放，第三轮开头由红衣说最后一句。
- 全局点击语音保留在 `assets/voices/15-*.mp3` 至 `17-*.mp3`。
- 走路、低落和睡觉尚无活动资源，因此设置页开关显示为不可用，右键菜单也不会显示。

## 动作开关规则

设置页会列出电脑前待机、走路、低落、争辩、跑一圈和睡觉六个动作。

一个动作只有同时满足以下条件才会进入右键菜单和待机选择：

1. 对应 `assets/motion/duck-<action>.png` 已存在。
2. 设置页中的动作开关已打开。

至少需要保留一个已有资源的动作处于开启状态。

## 运行

```powershell
npm install
npm start
```

## 检查

```powershell
npm run check
python scripts/verify-animation-assets.py
```

后续动作按单个视频逐一生成、验收并接入，不再批量预置动作资源。
