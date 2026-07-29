# 薄荷小陪伴 1.2

Windows 透明桌面宠物，保留初代双马尾角色，并新增“小鸭薄荷”角色。

## 这版的交互

- 点击角色会显示气泡、播放对应的本地 MP3，并切换互动动作。
- 待机、互动、睡眠均使用透明 30 FPS WebP 帧动画。
- 右键角色可切换模型、挥手、跳一下、睡觉、静音或打开设置。
- 内置对白不联网即可播放；只有未预置的新文字才需要 Fish Audio API Key。
- API Key 通过 Electron `safeStorage` 加密保存，不写入源码或安装包。

## 开发

```powershell
npm install
npm run check
npm start
```

重新生成动画：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-animations.ps1
```

构建便携版：

```powershell
npm run dist
```
