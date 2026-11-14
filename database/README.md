# KnoVid 账号、Credit 与数据库

可被现有 Node 后端直接导入的 ESM 模块，使用 PostgreSQL 保存账号、会话、项目归属、预留记录和 Credit 账本，也提供独立 HTTP 服务用于联调。数据库和服务代码集中在本目录，前端页面与视频工作流仍由各自 Agent 接入。

**接入入口：[INTEGRATION.md](./INTEGRATION.md)**。可复制的 Node HTTP / Temporal Activity 示例在 [examples/backend-integration.mjs](./examples/backend-integration.mjs)。本次未改写 `frontend/`、`backend/` 或顶层产品 README。

## 已实现

- 邮箱密码注册、登录、退出、当前账号、修改昵称和密码。
- 异步 scrypt 密码哈希；随机会话令牌仅以 SHA-256 哈希入库。会话过期、退出、改密码和停用账号均可使旧会话失效。
- 浏览器 Cookie 会话、精确 Origin 校验、凭据 CORS、登录与注册的数据库限速、请求大小及字段校验。
- Credit 发放、预留、实际结算、失败/取消释放、余额与流水查询。所有数值为整数产品额度；不代表人民币、美元或 Token 数量。
- 每个账号的数据库行锁、事务和幂等键；防止重复扣款、并发超额预留、结算与取消双重生效。
- 项目归属绑定与检查，兼容后端现有文件存储。**接入前，现有项目 API 和媒体下载不会自动获得保护**。
- 校验迁移文件摘要的迁移器、管理员 CLI、只读账本核对、Docker Compose 本地数据库和测试。

没有加入售价、支付渠道或订阅假设。默认注册赠额为 `0`，可通过 `SIGNUP_CREDITS` 配置。邮箱验证、邮件找回密码、OAuth 和付费充值尚未实现。启用注册赠额前应先接入邮箱验证与防滥用措施。

## 本地运行

要求 Node.js ≥ 22.18、npm；使用下面的数据库启动方式还需要 Docker 正在运行。

```sh
cd database
npm ci
cp .env.example .env
docker compose up -d
npm run migrate
npm start
```

默认数据库监听 `127.0.0.1:5433`，账号 API 监听 `127.0.0.1:3001`，避免占用视频后端的 `3000`。样例密码仅用于本机开发。数据保存在 Compose 命名卷中。`docker compose down` 停止容器并保留卷；不要为常规重启删除数据卷。

`.env` 不提交到代码库。生产环境需要独立数据库凭据、HTTPS、`SECURE_COOKIES=true` 和精确 `ALLOWED_ORIGINS`。独立服务在 `NODE_ENV=production` 时拒绝关闭 Secure Cookie。容器内提供 HTTP 服务时显式设置 `HOST=0.0.0.0`，由网关负责公开访问。

联调可把前端 Vite 的 `/api/auth`、`/api/account` 和 `/api/credits` 代理到 `3001`，其余 `/api` 仍代理到现有后端。正式组合建议直接挂载同一个后端进程，所有请求走同源 `/api`，避免在两处重复部署业务路由。

## 接入后端

```js
import {
  createDatabase, migrate, AccountService, CreditService,
  ProjectAccessService, createAccountHandler, getSessionToken,
} from '../../database/src/index.mjs';

const db = createDatabase({ connectionString: process.env.DATABASE_URL });
await migrate(db); // 部署/启动阶段执行，不在每个请求中运行。
const accounts = new AccountService(db, { signupCredits: 0 });
const credits = new CreditService(db);
const access = new ProjectAccessService(db);
const accountHandler = createAccountHandler({
  accounts, credits,
  allowedOrigins: ['http://127.0.0.1:5173', 'http://localhost:5173'],
  secureCookies: true, // 仅本机 HTTP 开发时改为 false。
});

// 原生 Node HTTP router 内，在其他路由和正文解析器之前：
if (await accountHandler(req, res)) return;

// 现有项目路由必须另外校验变更请求的 Origin，然后：
const user = await accounts.authenticate(getSessionToken(req));
await access.requireOwner({ projectId, userId: user.id });
// 此后才可读取、修改、渲染或下载该项目。
```

账号 handler 只处理自身的路由；宿主后端必须为其余项目路由补上同源校验、鉴权与项目归属。列表用 `access.listProjectIds(user.id)` 筛选。新项目必须先绑定服务端生成的项目 ID。旧匿名项目不会自动归属于新账号；迁移旧项目需要可信管理员明确映射。

不要把产物目录不经校验直接挂为公开静态目录。媒体、源文件与导出 ZIP 都需验证项目所有者，或由后端发放短期访问凭证。生成场景的执行容器不应收到数据库凭据、Cookie 或可信 Credit 服务能力。

## Credit 的含义

| 字段 | 含义 |
| --- | --- |
| `balance` | 尚未消费的全部额度，包含预留部分 |
| `reserved` | 正在进行的任务占用 |
| `available` | 可以发起新任务的额度，等于 `balance - reserved` |

例如余额 100，预留 30 后可用 70；成功消费 20 后，余额 80、预留 0、可用 80。任务最终失败时释放 30，余额回到可用 100。释放预留本身不产生新额度。

```js
// 可信后端/Temporal Activity；额度由服务端计价，不采用浏览器提交金额。
const hold = await credits.reserve({
  userId, projectId, revisionId, sceneId,
  operationKey: persistedRequestKey,
  amount: quotedCredits,
});
// 相同任务重试会返回已有状态。captured/released 时不能再次开始制作。
if (hold.state === 'reserved') {
  // 按持久化的任务 ID 发起或恢复工作流。
}
// 持久化成功产物及实际收费后，幂等重试结算直到确认成功：
await credits.capture({ userId, operationKey: persistedRequestKey, amount: actualCredits });
// 或确认任务最终失败/取消后：
await credits.release({ userId, operationKey: persistedRequestKey });
```

上面的结算与释放是两个互斥分支，不能依次调用。实际收费不得超过预留额度，多余部分自动释放；实际收费为 0 也可正常结算。已停用账号不能新增预留，但已受理任务仍能查询幂等结果、结算和释放。

幂等键在账号内唯一，绑定项目、版本、场景和金额。重试复用同一键；用户发起新的制作请求使用新键。当前后端的字符串 `revisionId` 应直接传入，不要替换成固定 `revision=1`。接口也允许数值 `revision`，两者至少提供其一；传入后都属于不可随重试改变的参数。

数据库预留与 Temporal 启动不是一个事务。调用方需要保存派发意图与稳定 Workflow ID，对未知的启动结果进行查询/重试；网络超时不等于工作未启动。只有确认最终失败或取消才释放，不在每次 Activity 重试时释放，也不按时间盲目释放正在运行的任务。调用方仍需实现派发恢复与最终结算的持续重试。

## 管理命令

```sh
npm run admin -- users
npm run admin -- balance --user USER_ID
npm run admin -- grant --user USER_ID --amount 100 --key test-grant-001 --reason "开发联调额度"
npm run admin -- disable --user USER_ID
npm run admin -- enable --user USER_ID
npm run admin -- pending
npm run admin -- audit
```

CLI 只供持有数据库连接权限的可信操作者使用；不提供普通用户发放额度或停用其他账号的 HTTP 接口。发放重试必须使用相同 `--key` 和参数。`audit` 对比钱包、账本与待结算预留，发现不一致返回非零退出码，仅报告，不擅自修改账。

## 数据表

| 表 | 保存内容 |
| --- | --- |
| `knovid_users` | 账号、密码哈希、启停状态 |
| `knovid_sessions` | 会话令牌哈希、账号、过期时间 |
| `knovid_auth_limits` | 跨 API 实例共享的限速窗口 |
| `knovid_project_owners` | 现有项目 ID 与账号的唯一归属 |
| `knovid_credit_accounts` | 每个账号的余额和预留总额 |
| `knovid_credit_reservations` | 逻辑制作任务的预留与终态 |
| `knovid_credit_ledger` | 只追加的额度事件和当时余额 |
| `knovid_schema_migrations` | 已应用 SQL 与摘要 |

视频项目正文、证据、场景代码、音频和视频仍使用视频后端自己的产物存储，本模块不复制这些文件。项目与账本外键同时绑定账号，防止内部写入意外混淆归属。账本通过触发器阻止普通 SQL 更新、删除和清空；生产应进一步将应用数据库角色与迁移管理员分离。

## 验证

```sh
npm test
TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5433/TEST_DB npm run test:postgres
```

默认测试使用 PGlite 执行真实 PostgreSQL SQL，HTTP 测试使用临时本机端口。真实 PostgreSQL 测试创建、清理随机独立 schema，并以多连接验证竞争行为；未设置 `TEST_DATABASE_URL` 时明确跳过。只对本地测试数据库运行该套件。

2026-11-14 已验证默认账号/Credit/HTTP 测试，以及 PostgreSQL 18.6 的多连接预留、重复发放/结算、结算/取消竞争、事务回滚和重新连接持久化。Compose 配置使用 PostgreSQL 17；当前 Docker 未启动，Compose 启动路径仍需在目标环境复核。具体执行结果见 [VALIDATION.md](./VALIDATION.md)。

后续联调重点：前端账号页与额度展示；后端项目和媒体权限；Temporal 计价、预留、派发恢复与最终结算。限速当前使用 socket 对端 IP，不信任任意 `X-Forwarded-For`；反向代理后多个用户会共享此限额，部署时应配置可信代理识别或网关分用户限速。过期会话、旧限速窗口清理与数据库备份也应纳入部署维护。
