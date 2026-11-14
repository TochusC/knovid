# 开普勒知识视频 · 画面升级版

12 秒，1920×1080，60 fps，H.264 视频和 AAC 音频。画面由 Canvas 2D 逐帧绘制，经 Remotion 分段渲染，再由 FFmpeg 合并。保留音频升级版的完整声音轨道。

## 画面

- 深蓝星空和太阳光晕，统一薄荷绿、暖金色视觉语言。
- 行星沿椭圆运动，尾迹表示相同时间内经过的位置。
- 旁白讲到速度时突出近日点与远日点的速度对比。
- 两块不同颜色的区域同时增长，明确展示相同用时和相同面积。
- 文字、字幕和重点显示时间沿用实际配音的句子边界。

## 重新渲染

源文件位于 `KnoVid/demos/orbit-visual-v3/scene.js`，渲染脚本位于 `KnoVid/backend/scripts/render-orbit-v3.mjs`。需要 Node.js 22、FFmpeg，以及 Chromium。

```sh
cd KnoVid/backend
npm ci
CHROMIUM_EXECUTABLE=/absolute/path/to/chromium node scripts/render-orbit-v3.mjs
```

输出 `KnoVid/demos/orbit-visual-v3.mp4`。增加 `--stills` 可只导出关键帧，用 `KNOVID_PREVIEWS` 指定预览目录。`soundtrack.m4a` 是已混音的声音轨道，脚本直接复制音频数据，不再次调用模型或语音服务。`subtitles.vtt` 控制字幕时间。

## 数学核验

示意轨道取半长轴 490、偏心率 0.62。半短轴按照 `b = a√(1-e²)` 计算。只对整幅轨道做旋转与等比例缩放，太阳始终位于椭圆焦点。

平均近点角 `M = (t-4)×2π/8.2` 随时间线性增加。通过牛顿迭代求解 `E-e sin E=M`，再计算行星位置。4 秒时经过近日点。

两个扇区的平均近点角增量均为 0.62，因此解析面积均为 `ab×0.62/2`，约为 58,398.697 平方绘图单位。使用 160 段采样后，两块多边形面积之间的相对差约 0.00315%。远日点与近日点的速度比为 `(1-e)/(1+e)`，即 0.2345679，与画面中的速度条一致。

参考 [NASA — Orbits and Kepler’s Laws](https://science.nasa.gov/solar-system/orbits-and-keplers-laws/)。天体尺寸和轨道偏心率用于教学示意，不代表某颗真实行星。

## 声音出处

声音沿用 `orbit-audio-v2`。配乐为 Yoiyami 的 First Light Particles，音效来自 Kenney Interface Sounds。素材链接、CC0 标注与处理记录详见 `audio-credits.json`。
