# 前后端对接

前端通过 `src/lib/api.ts` 适配 `backend/src/api.mjs` 与 `projects.mjs` 的实际 HTTP 契约，组件使用 `src/lib/types.ts` 中的统一类型。项目与分镜操作已使用真实后端 HTTP handler 做隔离测试。

## 开发连接

- 前端默认地址为 `http://127.0.0.1:5173`，后端默认端口为 `8080`。
- `VITE_API_BASE_URL` 默认为 `/api`。前端请求 `/api/v1/projects` 与 `/api/healthz`，Vite 代理剥离这两类路径的 `/api` 前缀，再访问后端的 `/v1/projects` 与 `/healthz`。
- 账号与 Credit 保留 `/api/auth`、`/api/account`、`/api/credits` 路径，按 `../database/INTEGRATION.md` 接入。请求携带 Cookie 会话。
- 后端 `API_TOKEN` 是服务连接凭据。可由 Vite 的服务端代理通过 `API_PROXY_TOKEN` 添加 Bearer header，凭据留在服务器。后端凭据错误映射为 `ApiError.code === "API_AUTH_REQUIRED"`，与用户登录的 401 分别处理。
- 对接独立服务时，可将 `VITE_API_BASE_URL` 设为后端或网关的根地址。媒体地址也通过同一前缀生成。

## 已对齐的项目接口

下表为后端实际路径，前端默认通过 `/api` 代理访问。

| 方法 | 路径 | 前端行为 |
| --- | --- | --- |
| GET | `/healthz` | 检查服务是否就绪。 |
| GET | `/v1/access` | 读取真实访客／会员身份、生成额度和时长限制。 |
| GET | `/v1/projects` | 获取项目 ID，再以最多 6 个并发请求补全详情。 |
| POST | `/v1/projects` | 创建项目并自动启动工作流，随后读取新项目详情。 |
| GET | `/v1/projects/:id` | 将 `latest`、分镜、证据和产物转换为 `Project`。 |
| GET | `/v1/projects/:id/revisions/:revisionId` | 失败修改尚无镜头时，按服务端给出的成功来源版本读取可编辑数据。 |
| PATCH | `/v1/projects/:id/scenes/:sceneId` | 修改旁白或参数，自动创建新版本、重制该镜头并合成整片，返回规范化的新 `Project`。 |
| POST | `/v1/projects/:id/revisions/:revisionId/retry` | 重试 queued、failed 或 cancelled 的最新版本。 |
| GET | `/v1/projects/:id/revisions/:revisionId/artifacts/video.mp4` | 下载或播放该版本的完整视频。 |
| GET | `/v1/projects/:id/revisions/:revisionId/artifacts/project.zip` | 下载该版本的可编辑项目包。 |

创建主题使用 `{ input: { type: "topic", topic }, options }`，论文链接使用 `{ input: { type: "paper-url", url, title }, options }`。当前设置包含 `language`、`sceneCount`、`size`、`music`。知识主题上限 300 字，镜头数量为 2–8，清晰度为 360p、720p、1080p。

PDF 上传使用 `Content-Type: application/pdf` 和原始文件字节，在查询参数中传 `title`、`language`、`sceneCount`、`size`、`music`，文件上限 20 MiB。`music` 使用 `true` 或 `false` 字符串，PDF 与主题输入都可关闭配乐。论文链接支持 arXiv、OpenReview、ACL Anthology，其余来源可上传 PDF。

场景 PATCH 的 `baseRevisionId` 必须等于最新版本。后端允许编辑已完成版本，以及具有成功来源版本的失败／取消版本。前端使用服务端 `canEdit`，并将 `parameters` 转为后端 `params`。常规中文旁白上限 320 字，英文上限 1000 字符，语言从 `project.settings.language` 读取。短片还采用服务端 `project.access.maxNarrationCharacters` 的更小限制，当前 30 秒项目为中文 32 字、英文 110 字符。前端显示限制并阻止超限提交，已有旁白完整保留。

## 访客访问与生成额度

`api.getAccess(signal)` 返回 `VisitorAccess`，字段完全来自服务响应。

```ts
interface VisitorAccess {
  mode: "guest" | "member";
  limits: {
    maxDurationSeconds: number | null;
    maxGenerations: number | null;
    maxRetriesPerProject?: number | null;
  };
  usage: { generations: number };
  remainingGenerations: number | null;
  canGenerate: boolean;
}
```

当前访客为最长 30 秒、3 次生成额度，服务端固定 3 个镜头。新建项目和保存修改生成新版本各消耗一次。已保存操作的失败或排队重试不重复消耗生成额度，当前服务另返回每项目最多 2 次重试。会员响应的访客限制和剩余次数为 `null`。

访客身份由服务端 `knovid_guest` Cookie 维护，包含 HttpOnly、SameSite=Lax。API 请求携带 Cookie，前端不使用 localStorage 计算次数。访问状态未获得、格式异常或服务离线时，`getAccess` 抛出明确错误，UI 应显示状态待确认并提供重试。创建、保存、重试或额度相关错误之后，应重新读取访问状态。

首次身份初始化由 API 层共享一次 `/v1/access` 请求，项目请求等待 Cookie 建立后才发送，避免首次直达工作台时并发响应覆盖 Cookie。单个调用者取消等待不会取消其他调用者共用的初始化。登录或退出后，UI 先调用 `api.resetIdentity()`，再刷新访问状态和列表。身份轮次会阻止旧响应将新身份标记为已就绪。初始化完成后的额度读取始终请求服务端。

项目详情保留 `Project.access` 的 `canEdit`、`canRetry`、`remainingGenerations`、`remainingRetries`、`maxDurationSeconds`、`maxNarrationCharacters`。前端顶层编辑和重试权限采用服务端决策，以支持失败版本的修复。生成次数用尽时，已有项目仍可使用其剩余重试次数。项目列表、详情、版本和媒体按当前 Cookie／账号身份隔离。

| 错误码 | UI 处理 |
| --- | --- |
| `GUEST_LIMIT_REACHED` | 生成额度已用完，提供登录入口。 |
| `GUEST_RETRY_LIMIT` | 当前作品重试额度已用完，提供登录入口。 |
| `GUEST_DURATION_LIMIT` | 提示访客最长 30 秒及缩短讲解。 |
| `GUEST_NARRATION_LIMIT` | 按项目的实际单段字数限制精简旁白。 |
| `ACCOUNT_SERVICE_UNAVAILABLE` | 账号状态暂时无法确认，保留错误并允许重试。 |
| `INVALID_ACCESS_RESPONSE` | 服务响应无法识别，显示状态待确认。 |

登录后，后端自动认领当前访客 Cookie 所属作品到已验证的会员账号。会员可继续访问原项目，旧访客身份和其他账号无法读取已认领项目与媒体。原 30 秒作品的时长及旁白限制继续按项目设置执行，新建会员作品使用会员权限。

## 状态、产物与失败恢复

后端 running 阶段 `research`、`planning`、`scenes/reusing`、`assembly` 分别对应前端资料、讲解、画面、合成状态。succeeded 对应 ready，failed/cancelled 对应需要处理，取消时显示明确的停止说明。

后端尚未提供数值化总进度。前端依据阶段及已就绪镜头数量估算，并通过 `progressIsEstimated` 标记。成片时长来自实际镜头帧数和后端固定的 25 fps。

预览、视频和项目包的 URL 都绑定到生成它们的具体 revision。修改后立即展示新版本，待新产物出现后提供相应下载。证据 quote、页码、URL，以及参数 label/min/max 已映射到工作台。

失败／取消的修改版本如果尚无镜头且服务端允许编辑，适配层仅按后端提供的 `sourceRevisionId` 读取成功来源版本的镜头文本、参数与引用。`editingSourceRevisionId` 标记这些修复数据；最新版本 ID、失败状态、错误和下载引用保持不变，不将来源版本的视频或时长当作新产物。

派单失败的 503 响应可能已经保存项目或版本。适配层保留其 ID，显示服务暂不可用并允许重试，避免创建重复项目。提交成功后读取详情失败时，`ApiError.acceptedOperation` 包含真实 `projectId` 和 `revisionId`，UI 可继续进入该项目并刷新状态。

## 当前能力边界

`apiCapabilities` 记录后端能力。旁白与参数保存后会自动更新视频。独立合成、手动单镜头重渲、镜头排序、标题／视觉描述／自然语言修改，以及观众／风格／目标时长／画幅偏好目前隐藏。重试入口仅针对后端允许重试的版本。导出直接使用已完成产物，尚未准备好的文件会显示清晰提示。

## 验证

在前端目录运行 `node --test test/api.contract.test.mjs`。测试使用真实 `createApp()`、隔离临时数据目录、随机端口和不执行生成的测试 executor，覆盖 JSON/PDF 创建、论文链接、中文错误提示、版本与参数映射、PATCH 自动派单、409 冲突、重试、下载、派单失败恢复和部分成功处理。访客用例维护真实 Cookie，验证共用额度、重试计数、登录认领、旧访客访问撤销、首次并发初始化、取消等待和账号切换时的过期响应，以及离线和错误访问响应不会产生假余额。

这些测试验证前端与后端接口契约。实际模型、配音和渲染由后端流水线继续验收。
