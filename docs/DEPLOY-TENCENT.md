# 腾讯云部署手册（xiaomang）

> ## ⚠️ 本文档已过期，描述的是**另一台机器的历史状态**（保留作背景）
>
> 这里是 2026-09-28 在 `124.223.15.17` 上的部署记录。**该机器后来被重装**：
> 三个 SSH 主机密钥全变、磁盘从 13.4G 回到 3.4G、`/opt` 为空、宝塔面板与
> `/www` 全部消失。因此本文中的**宝塔面板、80/443 被占用、`/www/wwwroot`、
> `compose.tencent.yml`、pm2 回滚方案**等内容**对当前机器全都不适用**。
>
> 👉 **当前部署请看 `docs/DEPLOY.md`（2026-10-09 重新部署）。**
>
> 本文仍值得保留的两部分：
> - **§7 域名被腾讯云拦截的分析** —— `xiaomang.cloud` 因「无备案 + 大陆服务器」被阻断，
>   这是**备案策略**决定的，与服务器无关，换机器依然成立；结论仍然有效。
> - §6 的历史 bug 记录、§12 服务器瘦身记录 —— 作历史参考。

> 部署日期：2026-09-28　执行人：AI 会话（可复现，命令全部留档）
> 状态：**服务已上线并验证通过**；唯一未决项是域名被腾讯云拦截（见 §7）
> （⚠️ 该状态属于重装前的旧机器，见上方提示）

---

## 1. 一分钟速览

| 项 | 值 |
|---|---|
| 服务器 | `124.223.15.17`（腾讯云 CVM，OpenCloudOS 9.6，2 vCPU / 1.9G 内存 / 40G 盘） |
| 登录 | `ssh root@124.223.15.17`（已装公钥免密；**密码登录仍开着，建议尽快关闭**） |
| 代码目录 | `/opt/xiaomang`（属主 root） |
| 编排方式 | `docker compose`，项目名 `xiaomang`（容器 `xiaomang-app-1` / `xiaomang-mongo-1`） |
| 对外入口 | 宿主机宝塔 nginx（80/443）→ 反代 `127.0.0.1:8787` → app 容器 |
| **当前可访问地址** | **`https://124.223.15.17/`**（受信任的 IP 证书，无浏览器警告）—— 见 §8 |
| 数据库 | 容器内 MongoDB 8.0，数据在 docker volume `xiaomang_mongo_data`，**不对外暴露** |
| 备份 | 每日 03:00，`/opt/xiaomang/backups/`，保留 7 天（`/etc/cron.d/xiaomang-backup`） |
| 域名 | `xiaomang.cloud` → `124.223.15.17`（**被腾讯云按备案策略拦截，见 §7**；临时用 IP 访问） |

---

## 2. 为什么不是「直接 `docker compose up`」

这台机器**不是空机器**，与项目自带的 `deploy/compose.yml` 有直接冲突，必须叠加覆盖文件：

1. **80/443 已被占用** —— 宿主机跑着宝塔面板的 nginx，且已有多个业务站点。
   `compose.yml` 里的 `nginx` 服务要绑 `80:80`，直接起会失败。
   → 新增 `deploy/compose.tencent.yml`，用 `profiles` 把自带 nginx 排除掉，改由宿主机 nginx 反代。
2. **app 不能对公网裸奔** —— 覆盖文件把端口绑成 `127.0.0.1:8787:8787`，公网只能经 nginx 进来。
3. **apt 会卡死** —— `deb.debian.org` 从这台机器实测约 270KB/s，`apt-get update` 会长时间无响应。
   → `Dockerfile` 增加 `APT_MIRROR` 构建参数（默认空 = 官方源，行为不变），腾讯云构建时传
   `mirrors.cloud.tencent.com`（实测 835KB/s）。
4. **源码 600 权限导致容器起不来** —— 仓库里有 **86 个源文件是 `600`**，镜像里非 root 的 `node`
   用户读不到，启动即 `EACCES`。已做两处修复：
   - 工作区：`chmod -R a+rX apps packages`（`.env` 保持 600）
   - `Dockerfile`：`RUN chmod -R a+rX /app/apps /app/packages`（防止以后再犯）
5. **MongoDB 缓存默认吃掉 512MB** —— 这台机器只有 1.9G 且与他人共用。MongoDB 8.0 的 WiredTiger
   缓存默认 `max(256MB, (RAM-1GB)/2)` ≈ **512MB**，而本项目整个数据集只有约 **1.5MB**。
   → 覆盖文件里加 `--wiredTigerCacheSizeGB 0.25`，实测生效为 **256MB**，给同机的
   MySQL / Redis / 宝塔 / `dolist-server` 让出约 250MB。
6. **容器日志无上限** —— 已给 app 与 mongo 都加 `max-size: 10m` / `max-file: 3`，
   避免长期运行把 40G 系统盘写满。

### 涉及文件

| 文件 | 变更 |
|---|---|
| `Dockerfile` | 新增 `APT_MIRROR` 构建参数；新增防御性 `chmod` |
| `deploy/compose.tencent.yml` | **新增**，腾讯云覆盖配置 |
| `deploy/compose.server.yml` | **新增**（仅服务器上），`include` 聚合上面两个，供 `backup.sh`/`restore.sh` 使用 |
| `apps/` `packages/` | 权限修正（`600` → 可读，`.env` 除外） |

---

## 3. 常用运维命令

全部在 `/opt/xiaomang/deploy` 下执行。

```bash
# 查看状态
docker compose -f compose.server.yml ps

# 看日志（已限制 10m × 3 份，不会撑爆磁盘）
docker logs -f xiaomang-app-1
docker logs --tail 100 xiaomang-mongo-1

# 重启应用（改代码后）
cd /opt/xiaomang && rsync ...           # 从开发机同步
cd /opt/xiaomang/deploy
docker compose -f compose.server.yml build app
docker compose -f compose.server.yml up -d

# 健康检查
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/health/ready     # {"status":"ok"} 表示数据库通

# 手动备份 / 恢复
COMPOSE_FILE=/opt/xiaomang/deploy/compose.server.yml BACKUP_DIR=/opt/xiaomang/backups sh backup.sh
COMPOSE_FILE=/opt/xiaomang/deploy/compose.server.yml sh restore.sh /opt/xiaomang/backups/xxx.archive.gz
```

> ⚠️ `backup.sh` / `restore.sh` 只接受**单个** `-f`，所以必须用 `compose.server.yml`（它 `include` 了
> `compose.yml` + `compose.tencent.yml`）。另外 `restore.sh` 会先校验 sha256、再确认目标库为空，
> **不会** `--drop` 覆盖线上库 —— 这是刻意设计，别绕过。

---

## 4. 从开发机重新部署

```bash
cd <项目根>
rsync -az --exclude '.git/' --exclude 'node_modules/' --exclude '.migration/' \
  --exclude '.deploy/' --exclude 'dist/' --exclude '.DS_Store' --exclude '*.log' \
  --exclude '.env' --exclude 'deploy/local.env' \
  ./ root@124.223.15.17:/opt/xiaomang/

ssh root@124.223.15.17 'cd /opt/xiaomang/deploy && \
  docker compose -f compose.server.yml build app && \
  docker compose -f compose.server.yml up -d'
```

`deploy/app.env`、`deploy/mongo.env` 里的密钥**不在开发机备份内**（`--exclude '.env'` 只管 `.env*`，
这两个文件名不含点，会被同步）。若被误删，可从开发机 `.deploy/app.env`、`.deploy/mongo.env` 恢复。

---

## 5. 密钥与安全

- `deploy/app.env`、`deploy/mongo.env`：`600` + root 属主，**未进镜像**（`.dockerignore` 排除 `**/.env*`）。
- MongoDB 密码、`JWT_SECRET` 均为部署时新生成的随机值（`openssl rand`），
  **与本地开发环境不同** —— 因此本地签发的旧会话令牌在线上无效。
- 旧版遗留的 `/www/wwwroot/xiaomang.cloud/server/.env` 原为 `644`（**任何本地用户可读**，
  内含 MongoDB Atlas 凭据），已改为 `600`。
- 端口暴露面：仅 `127.0.0.1:8787`；mongo 只在 compose 网络内，无宿主端口。

### ⚠️ 顺带发现的暴露面（不属于本项目，建议你处理）

从公网实测这台机器的端口可达性（`nc -z 124.223.15.17 <port>`）：

| 端口 | 服务 | 状态 |
|---|---|---|
| 22 | sshd | 开放（正常） |
| 80 / 443 | 宝塔 nginx | 开放（正常） |
| **8888** | **宝塔面板 BT-Panel** | **⚠️ 对外开放** |
| **3210** | `/opt/dolist-server`（你的另一个项目） | **⚠️ 对外开放** |
| 3306 / 6379 | MySQL / Redis | 已关闭 ✅ |
| 3000 | 旧版小芒（已停） | 已关闭 ✅ |

宝塔面板直接暴露在公网是常见的高危项（暴力破解 / 历史漏洞）。建议在**腾讯云安全组**里把
8888 限制为你的固定 IP，或改用面板的「面板 SSH 隧道 / 授权 IP」功能。

### 待办（建议尽快）

1. **关闭 SSH 密码登录**，改用公钥：
   ```bash
   # 确认公钥能登后再改
   sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
   systemctl restart sshd
   ```
2. **轮换 root 密码** —— 本次部署过程中密码以明文形式在会话里传递过。
3. 旧版 `/www/wwwroot/xiaomang.cloud/server/.env` 里的 **MongoDB Atlas 凭据仍在用**（旧版已停但库还在）。
   若确认不再回滚，建议去 Atlas 删掉该用户。

---

## 6. 部署过程中修复的真实 bug

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 1 | 容器启动即 `EACCES: open '/app/apps/server/api/_lib/stageSampleWindow.js'` | 86 个源文件是 `600`，`COPY` 保留权限，非 root 的 `node` 用户读不到 | 修正工作区权限 + `Dockerfile` 加 `chmod` |
| 2 | `docker compose build` 卡在 `apt-get update` 十几分钟无进展 | `deb.debian.org` 从该机器仅约 270KB/s | 加 `APT_MIRROR` 参数切腾讯云源 |
| 3 | `restore.sh` 报 `service "mongo" is not running` | `include` 让 compose 项目名退回目录名 `deploy`，与容器所属项目 `xiaomang` 对不上 | `compose.server.yml` 显式声明 `name: xiaomang` |
| 4 | 切换 nginx 后 `robots.txt`/`sitemap.xml`/`llms.txt` 会退回 index.html | 新版是 SPA，`apps/web/public` 里没有这些文件；旧版有 | nginx 增加 location，从旧 public 目录就地伺服，缺失才回落应用 |
| 5 | 迁移会因「目标库非空」被 `restore.sh` 拒绝 | 应用启动时会自建 3 个空集合（`customers`/`employees`/`tasks`） | 停应用 → 删这 3 个**空**集合 → 恢复 |

---

## 7. 🔴 域名被腾讯云拦截（正式域名不可用，已由 §8 的 IP 入口临时顶替）

### 现象（2026-09-28 核实）

| 检查 | 结果 |
|---|---|
| `curl http://xiaomang.cloud/` | **302 → `https://dnspod.qcloud.com/static/webblock.html?d=xiaomang.cloud`** |
| `curl https://xiaomang.cloud/` | **`Recv failure: Connection reset by peer`**（TLS 握手阶段被重置） |
| 服务器本机 `curl -k --resolve xiaomang.cloud:443:127.0.0.1` | **HTTP 200 ✅** |
| 第三、四方网络（另两个独立出口） | 同样失败 |
| 每日外部请求量 | 9/26 前日均 500–3400 次 → **9/28 仅 2 次** |

### 🔬 铁证：响应在传输途中被改写

这是提工单时最有力的一条证据 —— **源站返回的状态码和客户端收到的对不上**：

```
# 客户端发一个带唯一路径的请求
curl -o /dev/null -w "%{http_code} %{redirect_url}" http://xiaomang.cloud/probe-1790587320
  → 302  https://dnspod.qcloud.com/static/webblock.html?d=xiaomang.cloud

# 同一时刻服务器 nginx 的访问日志
grep probe-1790587320 /www/wwwlogs/xiaomang.cloud.log
  → 60.177.147.249 - - [28/Sep/2026:17:22:01 +0800] "GET /probe-1790587320 HTTP/1.1" 301 162 "-" "curl/8.7.1"
                                                                                        ^^^ nginx 返回的是 301
```

**请求确实到达了 nginx，nginx 按配置返回了 301（跳 HTTPS），但客户端收到的是 302 指向腾讯云拦截页。**
中间设备改写了响应体和状态码 —— 这排除了「服务端配置错误」的一切可能。

**结论：服务本身完全正常，拦截发生在腾讯云网络层，在服务器上改任何配置都无法绕过。**

`dnspod.qcloud.com/static/webblock.html` 是腾讯云的标准拦截页。

### 📌 官方定论（已核实腾讯云文档，2026-09-28）

腾讯云官方文档 [「网站/APP 阻断相关」](https://cloud.tencent.com.cn/document/faq/243/20220) 原文：

> **不支持备案的域名指向中国大陆地区云服务器会被阻断，指向非中国大陆地区服务器不会被阻断。**
>
> **域名被阻断怎么办？** 请核实您的域名是否有备案号：已有备案号 → 需办理接入备案；
> **没有备案号 → 请先办理网站/APP 备案。成功备案以后，方可开启网站/APP 访问。**

同一文档还写明：*「若您的域名指向中国大陆地区云服务器，会封禁域名，不会封禁主机。」*

**所以这是「域名无备案号 + `.cloud` 属于不支持备案的后缀 + 服务器在大陆」三者叠加的必然结果，
不是故障，也没有服务器端的解法。** 之前怀疑的「违规内容判定」可以排除。

### 🔬 补充实验：拦截按主机名精确判定

用泛解析域名（都指向 `124.223.15.17`）测试，每种主机名连测 5 次，结果完全稳定：

| 主机名 | 结果 |
|---|---|
| `xiaomang.cloud` | 拦 5/5 |
| `www.xiaomang.cloud` | 拦 5/5 |
| `124-223-15-17.sslip.io` | 拦 5/5 |
| `124.223.15.17.nip.io` | **通 5/5**（到达 nginx，返回 404） |

说明拦截是**逐个主机名判定**的（备案白名单机制），不是 IP 或端口级封锁 ——
`124.223.15.17.nip.io` 因为主机名以 IP 形式开头，绕过了备案识别。

> ⚠️ **不建议拿它当生产入口**：① 属于绕过合规管控；② `sslip.io` 已被拦说明这套机制随时会覆盖到它；
> ③ 域名不可控、不可用于正式业务。仅作为「证明拦截是域名级」的诊断证据记录在此。

### 可行路径（按推荐度）

| 方案 | 说明 | 耗时 | 代价 |
|---|---|---|---|
| **A. 换可备案域名 + 备案** | 买 `.com`/`.cn` 等[工信部批复后缀](https://www.pady.com.cn/record/262710.html)（`.cloud` 不行），走腾讯云备案 | 约 1–20 天 | 域名费 + 等待期 |
| **B. 换到腾讯云香港/境外节点** | 无需备案，**现有域名可直接用** | 数小时 | 需新购服务器；这台机器还跑着你别的业务，不能直接搬 |
| ~~C. 服务器端绕过~~ | 官方文档已明确：不支持备案的域名指向大陆服务器必被阻断 | — | **不可行** |
| ~~D. 用 IP 直连~~ | IP 不被拦（`http://124.223.15.17/` 返回 200），但需安全组放行端口，且无域名/证书体验差 | — | 临时可用 |

**建议**：如果这个系统要长期对外用 → 走 A；如果只是内部几个人用且想立刻可用 → 先看 D（我可以帮你配，需要你在安全组放行端口）。

### 换域名/解封之后要做什么

**不需要改任何应用配置**。宿主机 nginx 已经指向新版（`127.0.0.1:8787`），域名一旦可访问即刻生效。
只需：

```bash
curl -I https://<你的域名>/          # 期望 200
```

若是换新域名，需要三步（我可以代做）：新建 vhost → `certbot --nginx -d <新域名>` 签证书 → reload。

### ⏰ 证书续期（部署时补装）

原服务器上 **certbot 装了、续期配置也在，但没有任何自动续期的 cron/timer** —— 证书会在
2026-11-14 静默过期。已补装 `/etc/cron.d/xiaomang-certbot`（每天 03:17 / 15:17 两次，
`webroot` 方式，续期成功后自动 reload nginx）。

**注意：域名解封前，这个任务每次都会失败**，因为 Let's Encrypt 的 HTTP-01 验证需要从公网
访问 `http://xiaomang.cloud/.well-known/acme-challenge/<token>`，而该请求当前会被腾讯云拦到
webblock 页。也就是说：**域名一天不解封，证书就一天无法续期，11/14 之后 HTTPS 会失效。**
解封后此任务无需任何改动即自动生效。

---

## 8. 🚑 临时入口：IP 直连（**当前生效的访问方式**）

域名被备案策略阻断、而备案至少需要 1–20 天，因此按用户选择启用了 **IP 直连入口**。
腾讯云「只封域名不封主机」，IP 访问不受影响。

### 怎么访问

```
https://124.223.15.17/
```

**有受信任的 HTTPS，浏览器不会弹任何警告。** HTTP（80 端口）会 301 跳转到 HTTPS。

### 为什么不是裸 HTTP

裸 HTTP 会让登录密码明文过公网，属于安全降级。所以额外签了一张
**Let's Encrypt IP 地址证书**（IP 证书已 [正式 GA](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)）：

| 项 | 值 |
|---|---|
| SAN | `IP Address:124.223.15.17` |
| 签发者 | Let's Encrypt（受信任链，实测 `SSL certificate verify ok`） |
| 证书文件 | `/etc/ssl/xiaomang-ip/fullchain.pem`、`privkey.pem`（600） |
| 管理工具 | acme.sh v3.1.6（`/root/.acme.sh/`） |
| 有效期 | **仅 6 天**（IP 证书属 `shortlived` profile） |
| 续期 | `/etc/cron.d/xiaomang-ip-cert`，每天 02:00 / 10:00 / 18:00 |
| 下次续期 | 由 ARI 建议窗口决定，当前为 2026-10-01 |

> ⚠️ **6 天有效期是这套方案最脆弱的点**。acme.sh 依据 ARI 自动续期，且已实测走通
> （强制续期一次：重新签发 → 装入 → reload nginx 全部成功）。若某天续期连续失败，
> HTTPS 会在 6 天后失效，届时降级为删掉 443 段、只保留 80 端口的 HTTP 入口。
> 排查命令：`cat /var/log/xiaomang-ip-cert.log`

### 涉及文件

| 文件 | 说明 |
|---|---|
| `/www/server/panel/vhost/nginx/ip-access.conf` | IP 的 80/443 server 块 |
| `/etc/cron.d/xiaomang-ip-cert` | 证书续期 |
| `/www/wwwroot/xiaomang-ip-acme/` | ACME HTTP-01 验证目录 |
| `/etc/ssl/xiaomang-ip/` | 证书落盘位置 |
| 仓库内 `.deploy/ip-access.conf` | 配置源文件（便于重建） |

### 安全边界（为什么不会影响你其他站点）

- `server_name` **精确写 `124.223.15.17`**，只匹配 Host 为该 IP 的请求
- **没有使用 `default_server`**，`0.default.conf`（`server_name _`）仍是默认站
- 已实测：未知 Host 仍走默认站、`xiaomang.cloud` 本机访问不受影响

### 怎么下线这个临时入口

域名/备案就绪后，三步即可：

```bash
rm -f /www/server/panel/vhost/nginx/ip-access.conf
rm -f /etc/cron.d/xiaomang-ip-cert
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
```

（`/etc/ssl/xiaomang-ip/`、`/www/wwwroot/xiaomang-ip-acme/`、`/root/.acme.sh/` 可留可删，不影响。）

---

## 9. 回滚方案

旧版（Next.js，pm2 进程 `nmt-web` @ :3000）**代码与进程都还在**，只是被 `pm2 stop` + `pm2 save` 停了。

```bash
# 1) nginx 换回旧配置（原配置已备份）
cd /www/server/panel/vhost/nginx
cp xiaomang.cloud.conf.bak-before-docker-<时间戳> xiaomang.cloud.conf
/www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload

# 2) 拉起旧版
pm2 start nmt-web && pm2 save
```

> 旧版的 SEO 文件目录 `/www/wwwroot/xiaomang.cloud/server/public/` 被新 nginx 配置引用，
> **不要删除**，否则 `robots.txt`/`sitemap.xml`/`llms.txt`/百度校验文件会 404。

**该方案已于 2026-09-28 实测验证**：前置条件全部在位（nginx 原配置备份、旧版代码、旧版 `.env`、
pm2 进程定义），`pm2 start nmt-web` 后旧版立即监听 3000 并返回 HTTP 200，随后已停机复原。
即「回滚可用」是实测结论，不是假设。

---

## 10. 本次部署验证记录（全部实测）

| 验证项 | 结果 |
|---|---|
| 镜像构建 | ✅ `xiaomang-app:latest` 310MB |
| 容器状态 | ✅ app / mongo 均 healthy，`RestartCount=0` |
| `/health`、`/health/ready` | ✅ 200 `{"status":"ok"}` |
| SPA 首页 | ✅ 200，`<title>小芒 AI · 内容生产工作台</title>` |
| 静态资源 | ✅ `/assets/index-B41YQU9D.js` 200（906KB） |
| 数据迁移 | ✅ **20 集合 / 366 文档**，与本地逐项一致 |
| 迁移用户 | ✅ 蓬辰 `2146986718@qq.com` |
| 鉴权链路 | ✅ 自签令牌打 `/api/auth/me` → 200；无令牌 → 401；篡改签名 → 401 |
| 业务接口 | ✅ `/api/customers` → 200（返回"二奢包包Tiktok"等真实数据） |
| 经 nginx 的 HTTPS | ✅ 200（完整生产路径） |
| **公网 IP 入口（HTTP）** | ✅ `http://124.223.15.17/` 200，标题正确，静态资源 200，`/api/auth/me` 401 |
| **公网 IP 入口（HTTPS）** | ✅ `curl` **不带 `-k`** 返回 200；`SSL certificate verify ok`；Python 独立 TLS 校验通过；SAN=`IP Address:124.223.15.17` |
| **公网 IP 入口（真实浏览器）** | ✅ 无头 Chrome 加载 `https://124.223.15.17/`，登录页完整渲染，**零证书警告、零控制台报错** |
| **证书续期实测** | ✅ 强制续期一次：重新签发 → 装入 `/etc/ssl/xiaomang-ip/` → reload nginx 全部成功 |
| **默认站未受影响** | ✅ 未知 Host 仍走 `0.default.conf`；`xiaomang.cloud` 本机访问正常 |
| **浏览器真实渲染 · 登录页** | ✅ 无头 Chrome 渲染，React 已挂载，2 按钮/2 输入框/1 表单，**零应用级报错**，路由正确跳 `/login` |
| **浏览器真实渲染 · 工作台** | ✅ 已登录态渲染出 `欢迎回来，蓬辰。`、`5 待处理任务`、`5 已逾期`、`3 档案待确认`，与库中 `tasks:5` 精确吻合 |
| **浏览器真实渲染 · 任务页** | ✅ `/manager/tasks` 共 5 条，含真实客户「馨雅羊绒」及对标账号链接 |
| **浏览器真实渲染 · 客户页** | ✅ `/manager/customers` 共 5 条（测试 / 二奢包包Tiktok / 橙汁的财富地图） |
| SEO 文件 | ✅ robots/sitemap/llms/百度校验 均正确返回，未退化成 HTML |
| 第三方 API 出网 | ✅ DeepSeek / **TikHub（海外，200）** / Coze / 豆包 ASR+出图 / 飞书 / RedFox 全通 |
| 备份脚本 | ✅ 实测生成 + sha256 校验通过；每日 03:00 定时 |
| **重启自愈** | ✅ `systemctl restart docker` 模拟服务器重启：5 秒内两个容器自动恢复，均转 healthy，`RestartCount=0`，数据完好 |
| **回滚方案可行性** | ✅ 实测 `pm2 start nmt-web` 后旧版立刻返回 200，nginx 原配置备份在位；随后已恢复现状 |
| 证书续期 | ⚠️ 原无自动续期机制，已补装 cron；**域名解封前必然失败**（§7） |
| 端口暴露面 | ✅ 本项目仅 `127.0.0.1:8787`（另有他项目暴露面见 §5） |

> **「浏览器真实渲染」是怎么做的**（域名被拦截时如何验证线上页面）：
> ```bash
> # 1) SSH 隧道把线上容器端口映射到本地
> ssh -f -N -L 18787:127.0.0.1:8787 root@124.223.15.17
> # 2) 本地注入认证 Cookie 的反向代理（不动生产数据）
> XM_TOKEN=<自签令牌> python3 .deploy/cookie-proxy.py     # 监听 127.0.0.1:18888
> # 3) 无头 Chrome 渲染并截图 + dump-dom 提取文本
> "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
>   --headless=new --virtual-time-budget=18000 --dump-dom --screenshot=x.png \
>   "http://127.0.0.1:18888/manager"
> ```
> 截图存于 `.deploy/shots/`。令牌用 `xm_auth_session` Cookie 注入，**不新建/修改任何生产数据**。

---

## 11. 遗留事项

- [ ] **正式域名**（§7）—— 当前用 IP 顶替。要恢复 `xiaomang.cloud` 需换可备案域名或迁境外节点
- [ ] **IP 证书每 6 天续期一次**（§8）—— 最需要盯的一项，续期失败则 6 天后 HTTPS 失效
- [ ] 关闭 SSH 密码登录 + 轮换 root 密码（§5）
- [ ] 旧版 Atlas 库处置（本次按你的选择**未动**；其中 `users: 8`、`chat_histories: 173` 仍在）
- [ ] `pm2` 里 `nmt-web` 已 stopped 但仍在列表中，确认一段时间无问题后可 `pm2 delete nmt-web`
- [ ] `/www/wwwroot/xiaomang.cloud/` 已瘦身至 19M（仅保留源码 + `server/public`），可长期保留
- [ ] `xiaomang.cloud` 的 Let's Encrypt 证书 11/14 到期，且**域名被拦期间无法续期**（§7）
- [ ] 内存偏紧：1.9G 总内存，当前可用约 850-990MB（本栈占 app 约 100MB + mongo 约 130MB）。
      若后续加功能，建议升配到 4G

---

## 12. 服务器瘦身记录（2026-09-28）

这台机器是**多项目共用**的，除了本项目还跑着宝塔面板、`dolist-server`、旧版小芒等。
用户要求瘦身，实际执行 A / D / E 三档（B、C 两档用户选择跳过）。

### 效果

| 指标 | 瘦身前 | 瘦身后 | 释放 |
|---|---|---|---|
| 磁盘 | 17.0 GB (43%) | **13.42 GB (34%)** | **≈3.58 GB** |
| 内存可用 | 746 MB | **854–990 MB**（有波动） | **≈+110 ~ +240 MB** |
| 停用服务的常驻内存 | — | — | **≈208 MB**（mysqld 163.7 + php 20 + postfix 14 + redis 8 + ftpd 2） |

> 内存读数会随 BT 面板、缓存、临时探测进程波动，故给区间；磁盘数值是稳定的。

### A 档：垃圾与缓存（≈2.0G）

| 项 | 处理 | 释放 |
|---|---|---|
| `/www/server/nginx/src` | 删除 nginx 编译源码（其中 openssl 源码 1.7G） | 1.8G |
| `systemd journal` | `journalctl --vacuum-size=100M` | 707M |
| `/var/log/secure` | 保留最后 5000 行 | 68M → 684K |
| `/var/log/messages` | 同上 | 41M → 644K |
| `/var/log/cron` | 同上 | 40M → 860K |
| `/var/log/btmp*` | 截断（失败登录二进制记录） | 47M |
| `/var/log/sa` | 删除 7 天前 sysstat 数据 | 18M → 4.1M |
| `/var/cache/dnf` | `dnf clean all` | 74M |
| nginx 安装包 tar.gz | 删除（已装 1.30.4，包是 1.30.2） | 7.4M |

> **附带永久修复**：`secure`/`messages`/`cron` 原本**没有 logrotate 配置**（所以才涨到 40–68MB）。
> 已新增 `/etc/logrotate.d/bt-syslogs`（每周轮转、保留 4 份、压缩），清了不会再涨。

### E 档：旧版小芒构建产物（≈782M）

`/www/wwwroot/xiaomang.cloud` 从 **801M 降到 19M**：

| 删除 | 大小 |
|---|---|
| `server/node_modules` | 582M |
| `server/.next`（当前构建） | 85M |
| `server/.next.bak.1786957635` | 85M |
| `server/.next.bak.1786891219` | 8.6M |
| `dist/` | 22M |
| `._*`（macOS AppleDouble 垃圾） | 37 个文件 |

> ⚠️ **`server/public/`（19M）绝对不能删** —— nginx 的 `xiaomang.cloud.conf` 第 39/47 行
> 从这里伺服 `robots.txt`/`sitemap.xml`/`llms.txt`/百度校验文件。瘦身后已实测这四个文件仍返回 200。
>
> ⚠️ **回滚代价变了**：旧版回滚现在需要先 `npm ci && npm run build` 才能 `pm2 start nmt-web`
> （源码、`.env`、`ecosystem.config.js`、`package-lock.json` 都还在）。

### D 档：停用空转服务（≈246MB 内存 + 缩小攻击面）

停用并 `disable` 了 5 个**完全没在用**的服务：

| 服务 | 停用依据 | 内存 | 磁盘（软件仍在盘上） |
|---|---|---|---|
| **mysqld** | 自 8/15 安装起**零业务连接**、**零用户库**（只有 mysql/performance_schema 系统库）；宝塔面板自身用 SQLite | 163.7 MB | 818M |
| **redis** | `DBSIZE`=0，无任何客户端连接 | ~8 MB | 238M |
| **php-fpm-82** | `/www/wwwroot` 下 **0 个 .php 文件** | ~20 MB | 192M |
| **pure-ftpd** | 密码文件 **0 字节**，无任何 FTP 账号 | ~2 MB | 0.6M |
| **postfix** | 邮件队列为空 | ~14 MB | — |

**每停一个都验活**（app 200 / nginx 301 / SEO 200 / 宝塔面板存活），全部通过；
停止 60 秒后复查确认宝塔**不会**自动拉起这些服务。

**攻击面连带收益**：`3306`(MySQL)、`6379`(Redis)、`21`(FTP)、`25`(SMTP) 端口全部消失。

> **MySQL 采用「先停用观察」策略，未卸载**。观察 1 周无异常后，可进一步删除
> `/www/server/mysql`(590M) + `/www/server/data`(228M) 再省 818M。
> 宝塔面板的「数据库」页签会因 MySQL 停用而报错，属预期行为，不影响面板本身。

### 剩余可回收空间（本次未做）

| 项 | 大小 | 说明 |
|---|---|---|
| `/www/backup/panel` + php82/php-fpm82/nginx 的 `.Bak` | ≈284M | 宝塔备份，有回滚价值，用户选择保留 |
| Docker 构建缓存 `docker builder prune` | 0.57–2.1G | 用户选择保留 |
| 停用服务的软件包本体（mysql/redis/php） | ≈1.25G | 观察期结束后可删 |
| `/www/swap` 1.1G | — | **不能删**，正在使用且这台 1.9G 内存的机器离不开 |

