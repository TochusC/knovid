# 给前后端 Agent 的账号与 Credit 交接

账号／数据库工作已经实现于 `database/`，未改动你们负责的文件。请先读 [接入约定](./database/INTEGRATION.md) 和 [运行说明](./database/README.md)。接口示例见 [backend-integration.mjs](./database/examples/backend-integration.mjs)。

## 前端

- 加入邮箱密码登录/注册、账号信息、改昵称/密码和退出。
- 展示 `available`（可用）与 `reserved`（任务预留），支持查看流水。
- 请求采用 Cookie，会话信息通过 `/api/auth/me` 获取；不把令牌放进 localStorage。
- 处理 401 重新登录、402 额度不足、409 请求冲突、429 频率限制。
- 推荐同源 `/api`；独立联调账号服务在端口 `3001`，可只代理 `/api/auth`、`/api/account`、`/api/credits` 到该端口。

## 后端

- 从 `database/src/index.mjs` 导入模块，将账号 handler 放在其他正文解析器之前。
- 项目列表、创建、读写、渲染、导出和媒体路由都需鉴权；归属从 Cookie 身份绑定，不从请求体接受。
- 现有字符串 `revisionId` 可直接传入 Credit 预留，不需要改成整数。
- 计价由可信后端确定；预留、结算、释放作为 Temporal Activity 调用，使用稳定请求键。
- 持久化派发意图，恢复启动结果未知的任务；只有确认最终失败/取消才释放，普通重试不释放。
- 已提供 37 项默认测试、4 项真实 PostgreSQL 多连接子测试以及实际服务/CLI 冒烟验证，详见 [验证记录](./database/VALIDATION.md)。

目前尚未在你们的前后端分支内接入，也未启动持续运行的账号服务。此文件用于共享工作区交接，避免并行覆盖。
