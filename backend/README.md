# KnoVid 后端

提交知识点或论文后，REST API 返回一个项目和版本。Temporal 调度资料、剧本、场景代码、配音、Remotion 渲染与合成，逐个发布镜头预览。完成后可下载 H.264/AAC 成片、WebVTT 字幕和包含源码、参数、旁白、时序、素材出处的项目包。

## 启动

在本目录启动 Docker Compose。复制配置模板时保留已有的 .env。

~~~sh
test -f .env || cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:8080/healthz
~~~

LLM 默认请求 https://sec.llm.autos/v1 的 OpenAI 兼容接口，规划、写作、审核和场景代码默认使用 glm-5.1-highspeed。密钥通过 LLM_API_KEY 注入 Model Worker。可用 LLM_PLAN_MODEL、LLM_FAST_MODEL 和 LLM_MOTION_MODEL 覆盖相应模型。使用其他网关时，未指定的模型通过 /models 发现。若网关仅提供聊天接口，按其实际模型 ID 显式配置。API_TOKEN 为可选的 REST 鉴权凭据，独立于模型密钥。

模型接口返回 HTTP 429 时，Worker 会按 Retry-After 等待，没有该响应头时使用退避。较长的等待由 Temporal 调度，任务按已有的重试次数和时间上限运行。

GLM-5.1-HighSpeed 生成分镜时请求最多 131,072 个输出 token，单次请求最多等待 8 分钟。

分镜用 Canvas 2D 绘制文字、图示和标签。需要 3D 结构或像素级效果时，在 `renderFrame` 中调用 `draw3D(setup3D)`，将 Three.js 图层合成到当前 Canvas。 `setup3D(THREE)` 初始化场景和材质，可以通过 `THREE.ShaderMaterial` 使用内嵌 GLSL。它返回一个按帧更新物体和 uniforms 的函数，每帧返回 `{scene, camera}`。镜头代码通过传入的帧号和提示点进行动画。

使用离线样例时，设置 KNOVID_MODE=fixture 并启动同一套服务。样例固定讲解开普勒定律。中文默认使用已合成的云希录音，额外的示例文字可能以占位静音处理。生成任意选题需要模型和语音服务。运行模式变更后重新启动对应服务。

~~~sh
KNOVID_MODE=fixture docker compose up -d --build
KNOVID_MODE=fixture docker compose up -d --scale model=2 --scale render=4 --scale renderer=4
~~~

镜头完成配音和关键帧检查后即可渲染。重镜头按帧范围分派，合成用帧数和音轨时长核验。渲染执行器使用无外部网络、只读容器，单独挂载渲染任务目录。Compose 的 Temporal 开发服务和文件卷适用于单机运行。当前写接口部署一个 API 实例，计算 Worker 可以独立扩缩。

## REST API

启动后可访问 /openapi.json 获取机器可读接口。浏览器或脚本先访问 /v1/access，并在后续请求中携带返回的 Cookie。提交或修改返回 HTTP 202 和 href，可轮询该地址或按 Location 响应头查询。项目访问和访客额度见 [GUEST_ACCESS.md](GUEST_ACCESS.md)。

登录用户可为新项目选择 2–32 个镜头。访客试用固定制作 3 个镜头。超过 8 个镜头的项目分批处理，已完成的镜头会随进度逐个开放预览。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /healthz | API 就绪状态 |
| GET | /v1/access | 建立访客会话或读取登录状态与制作额度 |
| GET | /v1/audio/catalog | 音色、音乐和音效选项，附公开素材出处 |
| GET / POST | /v1/projects | 列出项目或发起制作 |
| GET | /v1/projects/{projectId} | 项目、当前版本和历史版本 ID |
| PATCH | /v1/projects/{projectId} | 调整镜头顺序、音色、配乐和音效 |
| PATCH | /v1/projects/{projectId}/scenes/{sceneId} | 修改单个镜头的旁白或参数 |
| GET | /v1/projects/{projectId}/revisions/{revisionId} | 查分镜、阶段、审核、进度和下载地址 |
| POST | /v1/projects/{projectId}/revisions/{revisionId}/cancel | 请求取消 |
| POST | /v1/projects/{projectId}/revisions/{revisionId}/retry | 重派已保存的 queued 版本，或从最新失败版本重试 |
| GET / HEAD | /v1/projects/{projectId}/revisions/{revisionId}/artifacts/{name} | 下载视频、项目包、字幕、证据、素材出处 |
| GET / HEAD | /v1/projects/{projectId}/revisions/{revisionId}/scenes/{sceneId}/artifacts/{name} | 下载镜头预览、关键帧、代码或音频 |

~~~sh
curl -c /tmp/knovid-cookies http://127.0.0.1:8080/v1/access
curl -b /tmp/knovid-cookies http://127.0.0.1:8080/v1/projects \
  -H 'Content-Type: application/json' \
  -d '{"input":{"type":"topic","topic":"开普勒定律"},"options":{"sceneCount":3,"size":"720p","voiceStyle":"warm","musicTrack":"first-light","effects":true}}'
~~~

主题可以随 input.sources 附上可信资料的 title、excerpt、url。不提供资料时尝试检索维基百科，并在证据中保留来源。论文链接支持 arXiv、OpenReview、ACL Anthology。可用 paper-text 类型上传论文文字，也可直接上传 PDF。

~~~sh
curl -b /tmp/knovid-cookies 'http://127.0.0.1:8080/v1/projects?language=zh&sceneCount=3&size=720p' \
  -H 'Content-Type: application/pdf' --data-binary @paper.pdf
~~~

PDF 上限 20 MiB，读取前 18 页的文本与可识别图表标题，保留页码并导出相应页面预览。扫描版需要先做 OCR。研究员校验引用与摘录相符，审片员核对脚本内容。镜头首帧检查和时长验证由程序执行。

~~~sh
curl -b /tmp/knovid-cookies -X PATCH "http://127.0.0.1:8080/v1/projects/$KNOVID_PROJECT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"baseRevisionId":"替换为当前版本ID","sound":{"voiceStyle":"soft","musicTrack":"exploration","effects":true}}'
~~~

更换音色时会保留场景源码，重新配音、对齐和渲染。只改配乐、音效或顺序时复用现有镜头，重新计算整片时间轴并混音。单镜头 PATCH 使用同样的 baseRevisionId，附上 narration 或 params。改动会创建新版本。所有媒体地址始终指向生成该产物的版本。

## 声音

中文默认音色为云希，也可选晓晓、晓伊或云扬。脚本按镜头连续合成，使用语音服务返回的边界对齐字幕和动作。服务合并多个句子时，按字符比例估算句内位置，并非逐字精确对齐。长停顿才单独补齐。混音在解说时自动压低音乐，并对整片做响度和峰值处理。

| 类型 | 素材 | 作者 |
| --- | --- | --- |
| 氛围钢琴 | [First Light Particles](https://opengameart.org/node/182244) | Yoiyami |
| 合成器与钢琴 | [Exploration Theme](https://opengameart.org/content/exploration-theme) | Cleyton Kauffman |
| 转场、强调与收束 | [Interface Sounds](https://kenney.nl/assets/interface-sounds) | Kenney |

三组素材均标注 [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)。仓库附整理后的音频文件。每次导出生成 audio-credits.json，项目包同时包含实际使用的音乐和音效。

## 本地验证

~~~sh
npm ci
npm test
KNOVID_TEST_RENDER=1 npm test
node scripts/remix-orbit.mjs ../../orbit-by-code.mp4 ../demos/orbit-audio-v2.mp4
~~~

本地媒体测试需要 FFmpeg、FFprobe、zip 和 Chromium。可用 CHROMIUM_EXECUTABLE 指定本机 Chromium。重新给原样片配音需要 edge-tts。解析 PDF 需要 Poppler。KNOVID_EXECUTOR=local 用于离线 fixture 调试。正式生成运行 Temporal 和独立渲染执行器。
