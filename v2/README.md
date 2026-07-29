# 薄荷小陪伴 1.1

Windows 桌面宠物，支持两套角色模型、简单动作和 Fish Audio 文字转语音。

## 功能

- `初代双马尾`：保留上一版视频角色
- `小鸭薄荷`：根据新图片生成，包含待机、挥手和睡觉姿态
- 简单动作：呼吸、走动、跳跃、挥手、睡觉、点击反馈
- Fish Audio：将宠物对话文字传给指定声音模型生成 MP3
- 桌面能力：透明悬浮、拖拽、始终置顶、随机散步、托盘菜单

## 运行

```powershell
npm.cmd install
npm.cmd start
```

## Fish Audio 设置

1. 打开应用右键菜单中的“角色与语音设置…”。
2. 在 [Fish Audio API Keys](https://fish.audio/app/api-keys/) 创建 API Key。
3. 填入 API Key；声音模型 ID 默认是：

   `af09f6d5c47545b69dc8bb39d19ce0af`

4. 点击“保存并试听”验证语音。

API Key 由 Electron `safeStorage` 使用 Windows 安全存储加密。语音请求发送到官方 `POST https://api.fish.audio/v1/tts`，使用 `s2-pro` 后端和上述 `reference_id`。

## 打包

```powershell
npm.cmd run dist
```

输出位于 `release/MintPet-1.1.0-portable.exe`。
