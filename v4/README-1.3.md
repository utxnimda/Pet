# 小小雅鹅 1.3

这一版将“小鸭薄荷”的移动动画改成 AI 生成的真实逐帧动作。

## 动作

- 跑步：8 个不同姿势，12 FPS 循环。
- 散步：8 个不同姿势，8 FPS 循环。
- 睡觉：8 个不同姿势，4 FPS 呼吸循环。
- 自动散步开始时自动切换散步动图，停止后回到待机。
- 右键菜单或设置页可执行“跑步”。
- 点击小鸭薄荷会随机播放跑步或散步动作，同时保留气泡语音。
- 睡觉时自动切换为闭眼、呼吸和轻微点头的睡眠动图。

三套动作均由 4×2 动作表切成透明 PNG 帧，再编码为带透明通道的循环 WebP。动作表和逐帧源文件保留在工程中，EXE 只打包压缩后的动图。

## 生成和验证

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-generated-motion.ps1
npm run check
node .\scripts\verify-generated-motion.js
npm run dist
```
