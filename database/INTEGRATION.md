# 账号与 Credit 接入约定

本目录由账号／数据库 Agent 负责；前后端 Agent 请在各自目录接入，不修改这里的核心实现。状态：独立模块已实现并通过测试，待前后端联调（2026-11-14）。工作区真实目录名为 `KnoVid`。

## 模块边界

- `database/`：PostgreSQL 迁移、账号与会话、Credit 事务账本、项目归属、测试、独立 HTTP 适配器及本地开发服务。
- `backend/`：现有视频工作流、项目内容与产物；从这里导入服务并为项目 API 加鉴权与归属检查。
- `frontend/`：注册登录、当前用户、可用 Credit／冻结额度与流水界面。Cookie 会话，跨端口请求须 `credentials: 'include'`；推荐沿用 Vite `/api` 同源代理。

无需等数据库即可按下列 API 编写 UI。此包采用 ESM `.mjs`，可直接被现有 Node 后端导入，无须新建 TypeScript 编译链。

## 浏览器 API

| 方法 | 路径 | 输入 / 输出 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{email,password,displayName}` → `{user}`，同时设置会话 Cookie |
| POST | `/api/auth/login` | `{email,password}` → `{user}`，同时设置会话 Cookie |
| POST | `/api/auth/logout` | 204，撤销当前会话 |
| GET | `/api/auth/me` | `{user}`；未登录 401 |
| PATCH | `/api/account` | `{displayName}` → `{user}` |
| POST | `/api/account/password` | `{currentPassword,newPassword}` → 204；撤销全部会话，需重新登录 |
| GET | `/api/credits` | `{balance,reserved,available}`，整数产品额度，非货币 |
| GET | `/api/credits/ledger?limit=20&before=…` | `{entries,nextCursor}`，仅当前账号流水 |

`user` 为 `{id,email,displayName,status,createdAt,updatedAt}`，不包含密码、会话令牌。错误为 `{code,message}`。余额不足返回 402 `INSUFFICIENT_CREDITS`；重复键参数变化返回 409 `IDEMPOTENCY_CONFLICT`。变更请求检查 `Origin`，开发环境应明确允许 `http://localhost:5173` 和/或 `http://127.0.0.1:5173`。登录／注册 API 有数据库级限速。

## 后端交接

已从 `src/index.mjs` 导出 `createDatabase({connectionString})`、`migrate(db)`、`AccountService`、`CreditService`、`ProjectAccessService`、`createAccountHandler({accounts,credits,allowedOrigins,secureCookies})`。HTTP handler 使用 Node `IncomingMessage/ServerResponse`：`await handler(req,res)`，处理自己的路由返回 `true`，其他路径返回 `false`。业务路由用 `accounts.authenticate(token)`，Cookie 提取用 `getSessionToken(req)`。

项目归属通过 `ProjectAccessService.bind({projectId,userId})` 与 `requireOwner({projectId,userId})` 关联后端已有项目 ID。所有列表、读写、渲染、导出和媒体下载都应按登录账号过滤/校验；服务端不能信任请求体里的 `userId`。当前未将旧的匿名项目自动归给任何账号。

## Credit 工作流

1. `credits.reserve({userId,operationKey,amount,projectId,revisionId?,revision?,sceneId?})`，派发任务前预留估算上限。`revisionId` 与 `revision` 至少提供一项；现有后端使用字符串 `revisionId`，应直接传入并原样保留，不能用固定序号代替。
2. 成功 `credits.capture({userId,operationKey,amount})`，实际额度须不大于预留；差额自动释放。
3. 最终失败／取消 `credits.release({userId,operationKey})`；中间 Activity 重试不释放。
4. 同一逻辑任务重试复用 `operationKey`，例如 `project:revision:scene:render:requestId`，不能包含重试次数。用户发起新制作使用新请求 ID。
5. 重复调用返回已记录结果；同一个键的金额／项目／版本等变化报冲突；已结算与已释放不可互相转换。
6. `credits.grant({userId,amount,idempotencyKey,reason})` 仅供可信后端或 CLI，不暴露用户充值接口。默认注册赠送 0，可配置；真实充值支付、价格和订阅另行接入。

`balance` 是未花费总额度，`reserved` 是进行中任务占用，`available=balance-reserved`。预留不记为消费。预留、结算、释放、发放均为数据库事务，保留不可变账本。计费操作必须放在 Temporal Activity；不要在确定性 Workflow 代码里直接访问数据库。任务派发与数据库不是同一事务，需用稳定工作流 ID 重试派发并保留待处理预留，只有确认未启动或进入最终失败/取消才释放；不能在网络超时时立即退款。

## 范围

本轮提供本地可运行的基础账号与 Credit 服务。不假定支付价格；邮箱验证、邮件找回、OAuth 或上线部署尚未实现。已通过真实 PostgreSQL 多连接并发测试；项目/产物权限和完整视频任务的端到端联调仍需前后端接入后完成。可复制的挂载与 Activity 代码见 `examples/backend-integration.mjs`。
