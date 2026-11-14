# 访客试用与项目权限

浏览器先请求 `GET /v1/access`。未登录时，后端设置 `knovid_guest` HttpOnly、SameSite=Lax Cookie，并在 `KNOVID_DATA/access/guests` 保存额度。前端代理必须转发请求的 Cookie 与响应的 Set-Cookie。生产 HTTPS 环境设置 `NODE_ENV=production`，以启用 Secure Cookie。

```json
{
  "mode": "guest",
  "limits": {"maxDurationSeconds": 30, "maxGenerations": 3, "maxRetriesPerProject": 2},
  "usage": {"generations": 1},
  "remainingGenerations": 2,
  "canGenerate": true
}
```

访客共 3 次生成额度：新建项目、保存镜头修改或项目设置并生成新版本，各使用 1 次。输入校验失败或过期版本冲突不扣额度。队列暂不可用但已保存的任务保留额度，恢复后重试无需再次扣生成额度。每个项目最多重试 2 次，仅可重试最新的 queued、failed 或 cancelled 版本。额度耗尽后仍可查看和下载自己的作品。

额度在任务提交前持久预留，以目录锁串行处理同一访客的请求；共享 `KNOVID_DATA` 的多个 API 实例也不能通过并发请求超额。项目修改、重试、取消和登录认领另持有跨进程项目锁，同一版本的并发保存只有一次会被接受，其余请求返回 409，不会覆盖已接受的版本。任务保存后的未知错误采用保守计费。该限制绑定当前浏览器 Cookie；清除 Cookie、换浏览器或换设备会成为新访客。它不保证同一个自然人只能试用 3 次，公开大规模上线仍需独立的反滥用措施。

新建访客项目固定为 3 个镜头。脚本阶段限制每镜头一个概念，中文旁白最多 32 字符、英文最多 110 字符；重写和用户修改同样限制。音频阶段根据真实解码音轨验证每镜头不超过 249 帧（25 fps），组装时验证完整时间线和 ffprobe 测得的成片均不超过 30 秒。超时会明确失败，不截断旁白。重试、编辑、缓存复用仍执行时长限制。已成功的短片项目登录后继续保留原来的时长约束，新建会员项目不受试用约束。

`GET /v1/projects/{id}` 增加 `access`：`canEdit`、`canRetry`、`remainingGenerations`、`remainingRetries`、`maxDurationSeconds`、`maxNarrationCharacters`。UI 应读取这些值，不能用 localStorage 或客户端会员标记判断权限。

会员身份仅由真实 `knovid_session` 会话确认。后端将它发送至 `ACCOUNT_API_ORIGIN`（默认 `http://127.0.0.1:3001`）的 `GET /api/auth/me`；请求包含会话而账号服务不可用时返回错误，不降级为访客。`API_TOKEN` 仍可限制服务入口，但代理的 Bearer 凭证不会赋予会员身份。测试可显式注入 `createApp({executor, authenticate})`，生产默认始终验证账号服务。

每个新项目持久保存所属访客或会员。列表、详情、编辑、取消、重试和媒体下载均检查归属，跨身份访问返回 404。验证会员会话并同时持有有效访客 Cookie 时，后端在访客锁下认领其项目；随后旧访客身份不能单独访问这些作品。没有 owner 的历史项目不会自动公开或认领。

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `GUEST_LIMIT_REACHED` | 429 | 3 次生成额度已用完 |
| `GUEST_RETRY_LIMIT` | 429 | 当前项目的 2 次重试已用完 |
| `GUEST_NARRATION_LIMIT` | 400 | 旁白超过短片字数预算，精简后保存 |
| `GUEST_DURATION_LIMIT` | 422 | 实际音轨或成片超时，需要精简内容 |
| `GUEST_BUSY` | 409 | 当前访客的另一个请求正在保存 |
| `PROJECT_BUSY` | 409 | 当前项目的另一个请求正在保存 |
| `UNAUTHENTICATED` | 401 | 登录会话失效或无效，需要重新登录 |
| `ACCOUNT_SERVICE_UNAVAILABLE` | 503 | 无法验证账号会话 |

运行 `npm test` 验证并发额度、真实账号校验、登录认领和真实音轨时长。`KNOVID_TEST_RENDER=1 node --test test/guest-render.test.mjs` 额外执行完整的 Chromium/FFmpeg 访客成片测试。
