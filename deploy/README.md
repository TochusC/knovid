# knovid.art 单机部署

部署前端、制作 API、账号服务、PostgreSQL、Temporal 与制作 Worker。外部仅开放 HTTP 80 和 HTTPS 443，数据库与内部 API 不绑定宿主机端口。Nginx 为制作 API 添加内部凭据，前端构建不包含模型密钥。

## 从本机发布

在仓库根目录配置 SSH 目标和证书目录，再执行部署脚本。

```sh
export KNOVID_SSH_TARGET=deploy@example.com
export KNOVID_CERT_DIR=/path/to/knovid-certs
bash deploy/deploy.sh
```

证书目录应包含 `knovid.art.pem` 和 `knovid.art.key`，默认目录为 `deploy/certs`。SSH 和 sudo 按需交互询问密码。

本机需要 Node.js 22.18+、npm、Python 3、OpenSSL、SSH，且前端依赖已安装。模型配置来自 `backend/.env`，其中 `LLM_API_KEY` 必须有值。初次部署会随机生成数据库密码和内部 API 凭据。

只验证本机准备工作、不连接服务器：

```sh
bash deploy/deploy.sh --check
```

可用 `KNOVID_SSH_TARGET` 和 `KNOVID_CERT_DIR` 环境变量调整目标与证书目录。域名固定为 `knovid.art`，域名变更须同步修改 Nginx 与两个 API 的允许来源。

服务器需为使用 systemd 的 Ubuntu 或 Debian，登录账号有 sudo 权限。脚本会检查 Docker Compose，缺少时会从系统软件源安装可用软件包。已安装 Docker 和 Compose 的其他 systemd 主机也可执行。建议至少 4 核、8 GiB 内存、20 GiB 可用磁盘。

`knovid.art` 的 DNS A 记录需要指向部署服务器的公网 IPv4 地址，云服务器入站规则需允许 80、443。启用 `www.knovid.art` 时可添加指向 `knovid.art` 的 CNAME，Nginx 会将其重定向到主域名。

首次部署到已有 Nginx 的服务器时，使用 `bash deploy/deploy.sh --nginx-gateway`。此模式需要 Docker Compose 2.24.4 或更新版本。KnoVid 在 `127.0.0.1:18443` 提供 HTTPS，由宿主机 Nginx 的 `/etc/nginx/conf.d/knovid.art.conf` 转发主域名请求。后续发布自动识别该站点配置，直接运行部署命令即可。

## 发布行为

1. 校验域名、证书有效期和公私钥匹配，构建前端，验证 Compose 配置。
2. 将选定的源码、构建产物和私密配置通过 SSH 传输到服务器。不会上传本机 node_modules、开发数据库、已有视频项目或日志。
3. 创建 `/opt/knovid/releases/<时间戳>`，构建镜像，再启动新版本。构建期间保留正在运行的版本；切换容器时可能有短暂中断。
4. 更新已有部署前，备份账号数据库。模型配置和数据库密码保留在 `/opt/knovid/shared/.env`，重复部署不会覆盖。后续修改模型配置应编辑该服务器文件。
5. 检查容器健康状态、Nginx 配置、HTTPS 证书、制作 API、账号数据库与访客访问接口。检查成功后更新 `/opt/knovid/current`；保存前一版路径为 `/opt/knovid/previous`。

持久化卷属于固定的 `knovid-art` Compose 项目，包含账号库、项目与额度记录、Temporal 数据、渲染任务。不要使用 `docker compose down -v`，该命令会删除数据卷。

## 运维

服务器上查看运行状态与日志：

```sh
sudo -i
cd /opt/knovid/current/deploy
export KNOVID_RELEASE=$(cat /opt/knovid/shared/current-release)
docker compose -p knovid-art --env-file /opt/knovid/shared/.env ps
docker compose -p knovid-art --env-file /opt/knovid/shared/.env logs --tail=80 api accounts workflow
docker compose -p knovid-art --env-file /opt/knovid/shared/.env logs --since 30m model renderer
```

默认启动两个模型 Worker，每个同时处理一个 Agent 任务。渲染队列可同时调度两个任务，由两个隔离的 `renderer` 容器分别执行。每个容器一次渲染一个帧块，Remotion 在帧块内默认使用 1 个槽。模型队列每秒最多派发两个活动，配音默认单路运行。

使用 `/opt/knovid/shared/.env` 中的 `MODEL_REPLICAS`、`MODEL_CONCURRENCY`、`MODEL_QUEUE_RATE`、`RENDER_CONCURRENCY`、`RENDERER_REPLICAS` 和 `REMOTION_CONCURRENCY` 调整容量。`RENDER_CONCURRENCY` 应与 `RENDERER_REPLICAS` 匹配，两个模型副本共享 `MODEL_QUEUE_RATE`。旧部署若显式配置 `RENDER_CONCURRENCY=1`，将其改为 `2` 后可启用两路渲染。等正在制作的任务结束再重启受影响的容器。

Docker 将每个容器的日志以 JSON 文件保存在宿主机，单文件 10 MB，最多保留 3 个。可用 `docker inspect --format '{{.LogPath}}' knovid-art-model-1` 查看模型容器当前的日志路径。查分镜生成失败时，在模型日志中搜索 `motion_schema_rejected`，按作品、版本和镜头编号关联失败原因、模型和尝试次数。

Agent 返回的 JSON 经规则修复且通过校验时，模型日志会记录 `agent_json_repaired` 和使用的规则。编写讲解重试后仍失败时可搜索 `writer_schema_rejected`。

更新代码后重新执行本机部署命令。证书由 shared/certs 持久保存；当前证书有效至 **2027-02-11 23:59:59 UTC**。续期时替换本机证书后重新部署，原证书会备份到 shared/backups。

应用回退时先确认数据库迁移向后兼容。以下命令适用于独占 80/443 的部署。使用宿主机 Nginx 时，Compose 命令需额外指定 `-f compose.yaml -f compose.gateway.yaml`，并将 `/etc/nginx/conf.d/knovid.art.conf` 的符号链接指向回退版本的 `deploy/host-nginx.conf`，再执行 `nginx -t && systemctl reload nginx`。

```sh
sudo -i
PREVIOUS=$(readlink -f /opt/knovid/previous)
test -n "$PREVIOUS" && test -d "$PREVIOUS/deploy" || exit 1
export KNOVID_RELEASE=$(basename "$PREVIOUS")
cd "$PREVIOUS/deploy"
docker compose -p knovid-art --env-file /opt/knovid/shared/.env up -d --wait --wait-timeout 240
curl --fail --resolve knovid.art:443:127.0.0.1 https://knovid.art/api/account-health
ln -sfn "$PREVIOUS" /opt/knovid/current
printf '%s\n' "$KNOVID_RELEASE" > /opt/knovid/shared/current-release
```

DeepSeek 和 OpenRouter 需要登录。每个镜头收取 1 Credit，成片每满或不足 30 秒加收 1 Credit。任务开始前按每镜头最多 60 秒预留，制作成功后按实际成片结算，失败或取消时释放额度。默认 GLM 沿用免费额度。

首次部署可在 `backend/.env` 提供 `DEEPSEEK_API_KEY` 和 `OPENROUTER_API_KEY`。已有部署在 `/opt/knovid/shared/.env` 配置相应密钥、`PRODUCTION_BILLING_TOKEN` 和逗号分隔的 `PREMIUM_MODEL_PROVIDERS`。模型密钥只传给模型 Worker，Credit 服务令牌只用于制作 API、流程 Worker 与账号服务之间的请求。

Temporal 使用单实例开发服务器和持久化 SQLite，适合单机试运行。账号登录和注册目前按连接来源限速，每 15 分钟共享 60 次配额。

源站检查通过后，脚本会检查域名的公网 HTTPS。若此时 DNS 尚未生效，脚本会报告公网检查失败，服务器上已通过检查的版本会继续运行。
