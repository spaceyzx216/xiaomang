# 小芒 · 部署手册（当前环境）

> 最近部署：**2026-10-20**（最终草稿按选题保存/用户隔离、飞书多记录导出；上一次 2026-10-19）　执行人：AI 会话
> 状态：**已上线并验证通过**（667 单测/339 路由/30 渲染、新镜像冒烟、容器 healthy、公网 HTTPS 200、401 边界）
>
> ⚠️ 本文描述的是**当前**环境。`docs/DEPLOY-TENCENT.md` 描述的是 2026-09-28 在
> **一台已被重装的共用服务器**上的部署，其中的宝塔面板/端口冲突等内容
> **对当前机器不适用**，只保留作历史与「域名为什么被拦」的分析。

---

## 0. 2026-10-20 更新部署（最终草稿按选题保存 / 用户隔离 / 飞书多记录导出）

| 项 | 本次结果 |
|---|---|
| 发布标识 | `20261020T0640Z` |
| 切换时间 | 2026-10-20 15:08（北京时间） |
| 发布内容 | 当前工作区整包（源码包 SHA256 `bb54c7080fc5d6f6b1a4558ffd9a9e80157d5dde8c318a730ce89dec7d6470b9`） |
| 发布镜像 | `xiaomang-app:release-20261020T0640Z`，同时标为 `xiaomang-app:latest` |
| 镜像 ID | `sha256:30b95f2d81d34b021c1dd12bf597f6afc35027708c2f245b1b6f41392aed9705` |
| 构建与记录 | `/opt/xiaomang-releases/20261020T0640Z/` |
| 回滚目录 | **已删除**（原 `/opt/xiaomang-rollbacks/pre-20261020T0640Z/`，按用户要求清理） |
| 旧版镜像 | **已删除**（原 `xiaomang-app:rollback-20261020T0640Z`，即 10-19 15:40 的 `20261019T0735Z`） |
| 公网入口 | **`https://124.223.15.17/`**，域名仍按用户确认暂缓 |

**修复与部署范围：**

- 最终文案草稿从「全局 append 一坨文本」改为按 `ownerId|customerId|taskId|topic.id` 归一化 upsert：同一选题再保存是更新、不同选题互不覆盖；列表按用户过滤（员工互不可见）；`/api/final-drafts` 系列接口全部要求登录。
- 飞书文档/多维表导出支持 `{ items: [...] }` 一次导出多条已保存记录（发布仓/内容页），单条草稿旧调用保持兼容。
- 发布仓勾选/草稿与最终编辑相关前端修复；导出/进入最终编辑前等待未完成保存。
- 只重建 app 容器；mongo、nginx 未重建（nginx 配置检查后重载）。`app.env` / `mongo.env` 部署前后逐字节一致（SHA256 校验通过），ASR/模型配置不变。
- 正式数据库部署前后均为 **22 个集合、831 条记录**，逐集合计数一致；测试只写独立临时库，验收后已删除。

**验证：**

- 部署前：667 单测（0 失败/0 跳过）、339 路由检查、30 渲染检查通过；新镜像在独立临时库冒烟（`/health`、`/health/ready` 200，静态资源 200，未登录 `/api/final-drafts` 401）。
- 部署后：容器 `healthy`、启动日志无错误；公网 `/`、`/health`、`/health/ready` 均 200，HTTP 80 → 301；新资产 `assets/index-CMpVgb12.js` 200；未登录 `GET/POST /api/final-drafts` 与 `/api/management/employees` 均 401。
- 本机 Chrome 无头浏览器打开公网登录页正常渲染（标题「小芒 AI · 内容生产工作台」，无错误边界）。
- 回滚资产校验（删除前）：源码/配置、应用数据、数据库归档 SHA256 全部 OK，旧镜像存在，`rollback.sh` 语法检查通过；`app.env`/`mongo.env` 仍与回滚记录一致。
- IP 证书有效至 **2026-10-26 09:01（北京时间）**，自动续期与每日备份 cron 未改动。

**回滚资产（已按用户要求全部清理）：**

> 2026-10-20 15:15 先删除上一版 `20261019T0735Z` 的回滚资产；15:20 按用户要求**清理全部历史版本**：
>
> - `rollback` 目录：`pre-20261014T0950Z`、`pre-20261018T164043`、`pre-20261019T0516Z`、`pre-20261019T0735Z`、`pre-20261020T0640Z`（`/opt/xiaomang-rollbacks/` 已空）
> - 发布记录：`/opt/xiaomang-releases/` 下仅保留 `20261020T0640Z`
> - 旧镜像：`c5a21c83a0ae`、`a45908f33a51`、`2b4c07401bcd`、`bd3e3c2ec493`、`fc13fbbfce8b` 全部删除；`xiaomang-app` 仅保留 `release-20261020T0640Z` 与 `latest`
> - Docker 构建缓存：`docker builder prune` 回收约 6.4GB
>
> 磁盘由 **15GB 已用 / 26GB 可用（36%）** 降到 **7.3GB 已用 / 33GB 可用（19%）**。**当前线上版本 `20261020T0640Z` 没有代码回滚点**（`/opt/xiaomang/deployment-current.json` 的 `previous` / `rollback` 已置空，`cleanup` 字段记录删除清单）。清理后已复核：三个容器 healthy，公网 `/`、`/health`、`/health/ready` 200，未登录 `/api/final-drafts` 仍 401。

> 说明：上一轮部署（2026-10-19 15:40，`20261019T0735Z`，内容生成并发 3/失败隔离）当时只写在服务器 `/opt/xiaomang/deployment-current.json`，本文与 HANDOFF 未补记。另：仓库 `apps/**` 文件为 CRLF 行尾，服务器既有副本为 LF，本次按源码包原样同步代码目录，未覆盖 `deploy/` 配置。

---

## 0. 2026-10-19 更新部署（发布仓勾选立即生效与草稿保留）

| 项 | 本次结果 |
|---|---|
| 发布标识 | `20261019T0516Z` |
| 切换时间 | 2026-10-19 13:20（北京时间） |
| 发布内容 | 当前工作区整包，包含修复提交 `addc7e0` 及已有 ASR/复盘改动 |
| 发布镜像 | `xiaomang-app:release-20261019T0516Z`，同时标为 `xiaomang-app:latest` |
| 镜像 ID | `sha256:a45908f33a517c7f4e3475a3bf924584aaf6cff20b1663edb54e56622c31e22c` |
| 源码包 SHA256 | `63f62a5bc33e886e5bd8a54fbcb1304f8f2d1d14a559029c8cbdaf53955c5539` |
| 构建与日志 | `/opt/xiaomang-releases/20261019T0516Z/` |
| 回滚目录 | `/opt/xiaomang-rollbacks/pre-20261019T0516Z/` |
| 旧版镜像 | `xiaomang-app:rollback-20261019T0516Z`（2026-10-18 线上版，包含流式 ASR） |
| 公网入口 | **`https://124.223.15.17/`**，域名仍按用户确认暂缓 |

**修复与部署范围：**

- 发布仓选择立即反映到页面，保存按选题串行执行；失败时提示重试，并保留按用户/客户/选题隔离的草稿。
- 后端只更新请求提供的板块；只切封面选择不重传图片，不清空其他文案/标签。四类发布文案的选择上限分开于单类候选上限。
- 导出、进入最终编辑和结束任务前等待未完成保存。快速连选、切换选题、刷新与重试均已在服务器新镜像中验证。
- 只重建 app 容器，mongo/nginx 容器保留，nginx 检查配置后重载。`app.env` / `mongo.env` 与部署前逐字节相同，保留 10-18 的 ASR 链及凭据，不更改 DNS 或平台配置。
- 正式数据库部署前后均为 **22 个集合、825 条记录**，各集合计数一致。临时验收账号和发布选择仅写入独立测试库，验收后已删除测试库、测试容器及临时高权限环境文件。

**回滚：**

```bash
sh /opt/xiaomang-rollbacks/pre-20261019T0516Z/rollback.sh
```

脚本恢复旧源码/配置和应用镜像，等待健康后重载 nginx，并恢复上一版发布记录；**不覆盖当前数据库或应用数据卷**。回滚目录含旧版镜像压缩包、源码/配置、数据库备份、应用数据、旧发布记录与 SHA256 校验文件，不受日常七天备份清理影响。数据库备份在独立库实际恢复 825 条、零失败，验证后删除恢复测试库；开发机 `.deploy/rollbacks/pre-20261019T0516Z/` 另保留数据库及源码配置备份。

**验证：**

- 634 单测（无跳过）、330 路由检查、30 渲染检查及前端构建通过。原有大包警告仍在，构建不等同于全项目类型检查。
- 服务器新镜像真实浏览器：延迟保存时立即勾选、快速文案/标签连选、板块互不覆盖、保存失败保留草稿、切换选题隔离、刷新恢复、手动重试、最终编辑接收最新选择，全部通过，无运行错误。
- 同镜像使用现有真实配置的 3 秒流式 ASR 冒烟成功，返回 `doubao-stream-asr` 与 `duration=3000`，原有模型配置保持可用。
- 公网首页/健康接口 200，证书验证正常，发布仓未登录接口 401；真实浏览器取得新资产 `index-BLC-c65Y.js`，桌面/390px 手机无页面溢出或运行错误。
- 当前 IP 证书有效至 **2026-10-23 09:01（北京时间）**，原有自动续期与日常数据库备份继续保留。

---

## 0. 2026-10-18 更新部署（ASR：流式识别 2.0 + 录音文件识别 2.0 兜底）

| 项 | 本次结果 |
|---|---|
| 发布标识 | `20261018T1641Z` |
| 切换时间 | 2026-10-18 16:41～16:44（北京时间） |
| 发布镜像 | `xiaomang-app:release-20261018T1641Z`，并标为 `xiaomang-app:latest` |
| 镜像 ID | `sha256:2b4c07401bcdc4ad8113f0c9db7909138c21f75ba44e21b2120611f40ff6e27b` |
| 回滚资产 | `/opt/xiaomang-rollbacks/pre-20261018T164043/`（旧 `app.env` + 旧镜像 `xiaomang-app:pre-20261018T164043` + `rollback.sh`） |
| 版本记录 | `/opt/xiaomang/deployment-current.json` |
| 切换范围 | **只重建 app 容器**；mongo / nginx 未重建，数据库无 schema/数据变更 |
| 公网入口 | 仍为 **`https://124.223.15.17/`** |

**本次改动：**

- 默认 ASR 链：`doubao-stream（流式/实时识别 2.0，volc.seedasr.sauc.duration，20h 免费额度）→ doubao-video（视频理解兜底）→ doubao-file（录音文件识别 2.0，volc.seedasr.auc，URL 异步兜底）`；**默认链不再包含极速版 flash**（`tikhub-music` / `tikhub-ffmpeg` / `ffmpeg` 代码保留，回滚可放回）。
- 流式失败用**同一份 PCM 重试一次**（第二次预算 60s；仅连接/超时/坏帧可重试；空文本/缺凭据不重试），主要保护视频号解密流（只能消费一次）。
- 服务器 `deploy/app.env` 更新 6 个非敏感键：`GOLD_TRANSCRIPT_PROVIDERS`、`TRANSCRIPT_PROVIDERS`、`DOUBAO_STREAM_ASR_{URL,RESOURCE_ID,BUDGET_MS,CHUNK_BYTES}`（旧文件已备份）。
- 文档：`docs/ASR-MODEL-USAGE.md` §0.1.2 / §0.1.3 / §0.1.4。

**验证结果：**

- `docker ps`：`xiaomang-app-1` Up / healthy；mongo / nginx 未动。
- 启动日志 `server.config`：`transcriptProviders="doubao-stream,doubao-file,doubao-video"`、`goldTranscriptProviders="doubao-stream,doubao-video,doubao-file"`、`doubaoStreamAsrResourceId="volc.seedasr.sauc.duration"`。
- 容器内 `node` 读取配置：两条链与预期一致；`GET /health/ready` 200。
- 容器内冒烟：`node apps/server/scripts/asr-stream-smoke.mjs --file /tmp/asr-probe-3s.wav --clip 3` → `provider=doubao-stream-asr`、`duration=3000`、0.67s、文本正确。
- 公网：`https://124.223.15.17/` 200；`/health` 200；HTTP 80 → 301 HTTPS。
- 源码校验：`providers.js` / `config.js` / `audioPcm.js` / `asrStreamClient.js` 本地与 `/opt/xiaomang` 的 SHA256 完全一致。

**回滚命令：**

```bash
sh /opt/xiaomang-rollbacks/pre-20261018T164043/rollback.sh
```

（脚本会恢复旧 `app.env`、把 `xiaomang-app:pre-20261018T164043` 标回 latest，并只重建 app 容器；数据库与 nginx 不动。回滚后代码退回 2026-10-14 版，不含流式 2.0。）

---

## 0. 2026-10-14 更新部署与回滚

已将当前工作区构建并部署到原服务器，包含 4.2 周度分析、确认记忆回流，以及 4.1/4.2 直接填表与 AI Excel 识别。公网入口仍为 **`https://124.223.15.17/`**。用户确认本次先保留 IP 入口，域名暂缓：`xiaomang.cloud` 与 `www.xiaomang.cloud` 已解析到该 IP，但从公网直连可观察到腾讯云未备案拦截页和 HTTPS 握手失败；没有更改 DNS，也没有购买或迁移服务器。

### 发布记录

| 项 | 本次结果 |
|---|---|
| 发布标识 | `20261014T0950Z` |
| 切换时间 | 2026-10-14 17:59～18:00（北京时间） |
| 正式代码 | `/opt/xiaomang` |
| 独立构建目录 | `/opt/xiaomang-releases/20261014T0950Z` |
| 发布镜像 | `xiaomang-app:release-20261014T0950Z`，并标为 `xiaomang-app:latest` 供现有 compose 使用 |
| 镜像 ID | `sha256:bd3e3c2ec493a8ef0c6bd894ae3617c707bc3a45978192b29b7714672179c546` |
| 源码包 SHA256 | `fab58a9e23b4d7a76eedeb3a7de4ae41d47de122931181f0bdc8b6751e435c77` |
| 版本记录 | `/opt/xiaomang/deployment-current.json` |
| 切换范围 | 只重建应用容器，数据库与 nginx 容器保留；健康后重载 nginx |
| 配置与数据 | 正式 `app.env` / `mongo.env` 逐字节保持一致；原有 17 个集合、685 条记录与切换前一致 |
| 当前证书 | 2026-10-13 签发，2026-10-20 01:01（北京时间）到期；自动续期正常，下个 ARI 窗口为 2026-10-16 16:04 |

### 回滚资产与命令

回滚目录：**`/opt/xiaomang-rollbacks/pre-20261014T0950Z`**，位于日常备份目录之外，不受七天清理任务影响。包含旧版源码与环境配置、旧镜像压缩包、数据库备份、应用数据卷备份、证书及定时任务配置、校验文件和回滚脚本。旧镜像同时保留为 `xiaomang-app:rollback-20261014T0950Z`。

```bash
# 在服务器上执行：回滚代码、配置和应用镜像，保留当前业务数据库与数据卷。
sh /opt/xiaomang-rollbacks/pre-20261014T0950Z/rollback.sh
```

脚本等待旧应用健康后重新创建 nginx，以加载恢复的绑定配置及应用地址。**不会自动恢复旧数据库或覆盖新业务数据**。若要恢复数据库，必须另行评估后使用保留的 archive 备份，不对正在使用的数据库直接执行覆盖恢复。

备份全部经过 SHA256 校验，数据库备份已在独立库实际恢复 **685 条记录、零失败**，核对后删除测试库。旧源码/配置、证书配置和数据库备份另复制到开发机 `.deploy/rollbacks/pre-20261014T0950Z/`，目录受权限保护且被 Git 忽略；旧镜像压缩包保留在服务器回滚目录。

### 本次验证

- 部署前重新执行：576 单测（无跳过）、330 路由检查、30 前端渲染检查及 Vite 构建通过。旧模块类型错误与原有大包警告尚未消除，不能把构建当成全项目类型检查。
- 服务器发布镜像在独立验收数据库中运行真实浏览器：登录、4.1 填表分析保存、实际 AI 识别带前置说明的 Excel、原表取值及视频选择、切换平台、4.2 填表分析、周报保存、配比预览与确认全部通过。此轮使用现有真实模型配置，证明验收样例可用，不代表所有业务表格或建议质量均已验收。
- 公网实际验证：首页和数据库健康接口 200，HTTP 301 到 HTTPS，证书校验为 0；真实浏览器无证书忽略选项，登录页正常，新版 JS 资产存在，复盘未登录接口返回 401，桌面/390px 手机无运行错误或页面溢出。
- 正式数据库未重建或导入，测试账号与周报只写入独立验收库。验收容器、测试库及临时根权限环境文件已清理。
- 构建日志与两份浏览器验收日志保存在发布构建目录，数据库恢复验证日志保存在回滚目录。

---

## 1. 一分钟速览

| 项 | 值 |
|---|---|
| 服务器 | `124.223.15.17`（腾讯云 CVM，OpenCloudOS 9.6，2 vCPU / 1.9G 内存 / 40G 盘） |
| 登录 | `ssh root@124.223.15.17` |
| 代码目录 | `/opt/xiaomang`（属主 root） |
| 编排方式 | `docker compose`，项目名 `xiaomang` |
| 容器 | `xiaomang-app-1` / `xiaomang-mongo-1` / `xiaomang-nginx-1` |
| **当前可访问地址** | **`https://124.223.15.17/`** ✅ 公网 HTTPS，受信任证书，无浏览器警告 |
| HTTP | 80 端口一律 **301 跳转到 HTTPS**（避免密码明文过公网） |
| HTTPS 证书 | Let's Encrypt **IP 证书**（`SAN = IP Address:124.223.15.17`），**6 天有效期** |
| 数据库 | 容器内 MongoDB 8.0，数据在 volume `xiaomang_mongo_data`，**不对外暴露** |
| 备份 | 每日 03:00 → `/opt/xiaomang/backups/`，保留 7 天 |
| 证书续期 | 每天 02:00 / 10:00 / 18:00（acme.sh + ARI 决定是否真签），走 **80 端口** |

### 登录方式（两条路，见 §5）

- **A. 用原账号登录**（能看到已恢复的历史数据）：`2146986718@qq.com`，密码是**你原来的密码**。
- **B. 注册新账号**（全新空工作台）：邀请码 **`<从服务器私有文件读取>`**（一次性，已存在服务器 `/opt/xiaomang/.invite-code`）。

> ⚠️ **A 与 B 不是同一份数据**：业务数据按 `managerId` 隔离，用 B 注册的新账号看到的是空工作台。

---

## 2. 🔴 重要前提：这台机器是重装过的

本次部署与上次（2026-09-28）**不是同一台机器的同一状态**。证据：

- 服务器三个主机密钥（RSA/ECDSA/ED25519）**全部与本地 `known_hosts` 记录不符**；
- 磁盘占用 3.4G（上次部署时是 13.4G）；
- `/opt` 为空，无 docker、无 nginx、无宝塔面板、无 `/www`，只有 sshd 监听 22。

**结论：上次的部署（含 `/opt/xiaomang`、容器、Mongo 数据、nginx 站点、Let's Encrypt 证书）
已随重装全部消失。** 本次是从零重建，因此下面很多步骤是「首次部署」而非「更新」。

---

## 3. 从开发机重新部署 / 更新代码

### 3.1 首次部署做了哪些事（按顺序）

1. **装 Docker**（OpenCloudOS 9.6，`dnf`）——⚠️ 有个坑，见 §7-2
2. **同步源码** 到 `/opt/xiaomang`
3. **生成密钥文件** `deploy/app.env`、`deploy/mongo.env`（600，不进镜像）
4. **构建镜像** 并起容器
5. **恢复历史数据**（可选，见 §5）
6. **种邀请码**（必需，否则没人能注册，见 §7-5）
7. **证书 + 续期 cron + 备份 cron**

### 3.2 日常更新代码

更新前先为当时运行的镜像、源码/配置和业务数据库建立新的回滚目录并校验。§0 的目录只保护 2026-10-14 更新前的版本，不应被后续更新覆盖。下方是源码同步和构建示例，本次实际采用独立目录构建、验收后只切应用容器。

```bash
cd <项目根>
COPYFILE_DISABLE=1 tar czf - \
  --exclude='./.git' --exclude='./.migration' --exclude='./.deploy' \
  --exclude='./.codegraph' --exclude='./.workbuddy' --exclude='./backups' \
  --exclude='node_modules' --exclude='dist' --exclude='apps/server/src/data' \
  --exclude='./deploy/local.env' --exclude='./deploy/app.env' --exclude='./deploy/mongo.env' \
  --exclude='*.env' --exclude='.env' --exclude='.env.*' --exclude='./deploy/acme-webroot' \
  --exclude='apps/web/.env' --exclude='apps/server/.env' \
  --exclude='.DS_Store' --exclude='*.log' \
  . | ssh root@124.223.15.17 \
  'tar xzf - -C /opt/xiaomang && find /opt/xiaomang -name "._*" -delete && chown -R root:root /opt/xiaomang'

ssh root@124.223.15.17 'cd /opt/xiaomang/deploy && \
  docker compose -f compose.yml -f compose.cvm.yml up -d --build'
```

> 为什么用 `tar` 而不是 `rsync`：macOS 自带的是 **openrsync**，与 GNU rsync 的参数
> 不完全兼容；`tar` 管道在这里更可控。
> `COPYFILE_DISABLE=1` 很关键 —— 不加的话 macOS 会塞进一堆 `._*` AppleDouble 文件
> （本次首轮同步就中招了），后面那条 `find ... -delete` 是兜底。

> ⚠️ `deploy/app.env`、`deploy/mongo.env` **不在同步范围**（上面的 exclude 已排除）。
> 它们是服务器上的密钥文件，本地对应的备份在 `.deploy/app.env`、`.deploy/mongo.env`。

### 3.3 涉及的文件

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 两阶段构建；`APT_MIRROR` 参数默认空 = 官方源 |
| `deploy/compose.yml` | 基础编排：mongo + app + nginx（80） |
| `deploy/compose.cvm.yml` | **本次新增**：腾讯云换源 + 发布 443 + 挂 ACME/证书目录 |
| `deploy/compose.server.yml` | **本次新增**：聚合入口，供 `backup.sh`/`restore.sh` 用（它们只收单个 `-f`） |
| `deploy/nginx.conf` | 80（ACME + 301 跳转）+ 443（TLS 入口）两个 server 块 |
| `deploy/cron/*` | 三个 cron/logrotate 配置的**源文件**（便于重建） |
| `apps/server/scripts/import-migration-dump.mjs` | **本次新增**：把 `.ejsonl` 历史备份导回库 |
| `apps/server/scripts/seed-invite-code.mjs` | **本次新增**：种邀请码 |

---

## 4. 常用运维命令

全部在 `/opt/xiaomang/deploy` 下执行。

```bash
cd /opt/xiaomang/deploy
C="docker compose -f compose.yml -f compose.cvm.yml"

$C ps                      # 状态
docker logs -f xiaomang-app-1
docker logs --tail 100 xiaomang-mongo-1

# 改完代码后重建
$C up -d --build

# 只改了 nginx.conf（挂载进去的，不用重建容器）
docker exec xiaomang-nginx-1 nginx -t && docker exec xiaomang-nginx-1 nginx -s reload

# 健康检查
curl -s http://127.0.0.1/health          # {"status":"ok",...}
curl -s http://127.0.0.1/health/ready    # {"status":"ok"} 表示数据库通

# 手动备份（注意用 compose.server.yml，因为 backup.sh 只收单个 -f）
COMPOSE_FILE=/opt/xiaomang/deploy/compose.server.yml \
  BACKUP_DIR=/opt/xiaomang/backups sh backup.sh
```

---

## 5. 数据与登录

### 5.1 已恢复的内容

从开发机 `.migration/mongo-2026-09-22T09-39-59-223Z/`（**2026-09-22 的快照**）导入：

| 集合 | 文档数 |
|---|---|
| gold_three_second_transcripts | 163 |
| benchmark_video_comments | 40 |
| customers | 5 |
| tasks | 5 |
| employees / adhoc_analyses | 2 / 2 |
| users / invitecodes / topic_libraries 等 | 各 1 |
| **合计** | **225**（17 个集合有数据，另 1 个空集合建了索引） |

⚠️ 这是**能找到的最新本地快照**。上次部署时曾迁过一份更新的数据（20 集合 / 366 文档），
那份备份不在开发机上 —— 已被重装的服务器上也没了。**如需那版数据，只能从别处找回。**

### 5.2 为什么「必须」种邀请码

`POST /api/auth/register` → `registerManager()` → `consumeInviteCode()` 强制校验邀请码；
而邀请码在库里**只存 bcrypt 哈希**，明文不可反推，`index.js` 里也**没有任何创建邀请码的接口**。
所以：**全新空库 = 谁都注册不了，整个系统锁死。**

- 已种：`<从服务器私有文件读取>`（`maxUses=1`，已消耗 0）
- 种法：
  ```bash
  docker exec -u root -w /app xiaomang-app-1 \
    node apps/server/scripts/seed-invite-code.mjs <明文邀请码> [maxUses] [note]
  ```
- 库里现有 2 条邀请码：恢复回来的那条（明文未知）+ 上面这条。

### 5.3 原账号的密码

`2146986718@qq.com`（蓬辰）的密码是 **bcrypt 哈希**，无法反推；且项目**没有找回/改密接口**
（`grep password apps/server/src/index.js` 只有登录用到）。所以：

- 记得原密码 → 直接用 A 方式登录，历史数据都在；
- 不记得 → 用邀请码注册新账号（B 方式，空工作台）。
  若想找回原账号的数据，需要在库里**直接重置该用户的 `passwordHash`**（运维操作，非应用功能）。

---

## 6. HTTPS（已启用，公网可用）

**`https://124.223.15.17/`** —— 受信任证书、浏览器无警告；`http://` 一律 301 跳过去。

| 项 | 值 |
|---|---|
| 证书类型 | Let's Encrypt **IP 证书**（`SAN = IP Address:124.223.15.17`） |
| 签发者 | Let's Encrypt（`CN=YE1`）；实测从公网 `Verify return code: 0 (ok)` |
| 证书文件 | `/etc/ssl/xiaomang-ip/fullchain.pem`、`privkey.pem`（600） |
| 管理工具 | acme.sh v3.1.5（`/root/.acme.sh/`）；证书目录 `124.223.15.17_ecc/` |
| **有效期** | **仅 6 天**（IP 证书属 `shortlived` profile，这是 Let's Encrypt 的策略） |
| 当前证书 | 2026-10-16 签发 → **2026-10-23 09:01（北京时间）到期**（2026-10-19 实测） |
| 续期 | `/etc/cron.d/xiaomang-ip-cert`，每天 02:00 / 10:00 / 18:00 |
| 下次续期窗口 | 由 ARI 动态建议；以 `/var/log/xiaomang-ip-cert.log` 的最近结果为准，旧窗口已过期 |
| 验证方式 | HTTP-01，走 **80 端口**（`deploy/acme-webroot`，与 nginx 容器共享） |
| 续期日志 | `/var/log/xiaomang-ip-cert.log` |

### 6.1 设计要点

- **走 webroot 而不是 standalone**：续期时无需停 nginx，**零停机**。
- **80 端口的 ACME location 不做跳转**：`location /.well-known/acme-challenge/`
  排在 `return 301` 之前，续期链路少一个可能失败的面。
- **续期不依赖 443**：HTTP-01 只走 80，所以即使 HTTPS 出问题也不影响重新签发。

### 6.2 ⚠️ 应急：6 天有效期是这套方案最脆的点

若哪天续期连续失败，HTTPS 会在 6 天后失效。**届时站点会打不开（因为 80 跳 301）。**

**应急回退**（把 80 端口退回普通 HTTP 反代）：
编辑 `deploy/nginx.conf`，把 80 段里的
`location / { return 301 https://$host$request_uri; }`
删掉、换成 443 段里那段 `location /` 反代块（`proxy_pass http://app:8787;` 等），然后：

```bash
docker exec xiaomang-nginx-1 nginx -t && docker exec xiaomang-nginx-1 nginx -s reload
```

排查续期：`cat /var/log/xiaomang-ip-cert.log`；强制续期：
`/root/.acme.sh/acme.sh --cron --home /root/.acme.sh --force`

---

## 7. 🔴 本次踩到的坑（每条都带症状，别再踩）

| # | 症状 | 根因 | 处置 |
|---|---|---|---|
| 1 | SSH 报 `REMOTE HOST IDENTIFICATION HAS CHANGED` | 服务器被**重装**，三个主机密钥全变 | 确认是重装而非中间人后 `ssh-keygen -R 124.223.15.17` |
| 2 | `dnf install docker-ce` 找不到包 / 404 | OpenCloudOS 报 `releasever=9.6`，而 docker-ce 仓只有 `9` 目录 | `sed -i 's/$releasever/9/g' /etc/yum.repos.d/docker-ce.repo` |
| 3 | 源码目录里混入大量 `._*` 文件 | macOS `tar` 会打包 AppleDouble 扩展属性 | 打包时 `COPYFILE_DISABLE=1`，落盘后再 `find -name "._*" -delete` |
| 4 | 数据导入成功但**唯一索引没建** | manifest 里索引键是**规范 EJSON**（`{"$numberInt":"1"}`），`createIndex` 只收普通数字 | 导入脚本先 `BSON.EJSON.parse` 解回普通值（已修在脚本里） |
| 5 | 全新库谁都注册不了（403「邀请码无效」） | 邀请码只存哈希、且**没有创建邀请码的接口** | 必须运维侧种一条，见 §5.2 |
| 6 | `restore.sh` 用不了本地的 `.migration` 备份 | 它只认 `mongodump --archive` 格式，而 `.migration` 是 `.ejsonl` + manifest | 新写 `import-migration-dump.mjs` |
| 7 | `backup.sh` 报找不到 mongo 容器 | 它只接受**单个** `-f`，而本机要叠 `compose.yml` + `compose.cvm.yml` | 新增 `compose.server.yml` 用 `include` 聚合（并显式写 `name: xiaomang`） |
| 8 | nginx 里写了 `listen 443 ssl`，宿主仍连不上 443 | **容器监听 ≠ 宿主发布端口**：`compose.yml` 只发布了 `80:80` | `compose.cvm.yml` 里补 `ports: ["443:443"]` |
| 9 | **误判「安全组没放行 443」** | 第 8 条的状态下，从外网 `nc -z ... 443` 也是不通的 —— 「没监听」和「被安全组拦」表现一样，**不能只看外网连通性下结论** | 判端口是否被拦，先 `ss -tlnp` 确认宿主**有没有在监听**；只有「宿主在监听 + 外网不通」才是安全组问题 |
| 10 | ACME 验证路径返回 index.html | SPA 反代的 `location /` 把 `/.well-known/...` 也吞了 | ACME location 必须**排在** `location /` 之前 |
| 11 | 装了 acme.sh 但卡住不动 | `raw.githubusercontent.com` 从该机器不通（`get.acme.sh` 本身通） | 改从 gitee 镜像取：`https://gitee.com/neilpang/acme.sh/raw/master/acme.sh` |
| 12 | 用新邀请码注册后「看不到数据」 | 业务数据按 `managerId` 隔离，新账号是空工作台 | 属预期，见 §5.3 |

> 另外：本机 1.9G 内存是唯一偏紧的资源（当前可用约 1.1G，本栈占 app ≈100MB + mongo ≈130MB）。
> 40G 盘当前用 8.1G（21%），其中 Docker 构建缓存 2.09G —— 空间紧张时
> `docker builder prune` 可回收。

---

## 8. 本次验证记录（全部实测）

| 验证项 | 结果 |
|---|---|
| 镜像构建 | ✅ `xiaomang-app:latest`，310MB |
| 容器状态 | ✅ app / mongo 均 `healthy`，`RestartCount=0` |
| `/health`、`/health/ready` | ✅ 200 `{"status":"ok"}` |
| **公网 HTTPS** | ✅ 从外部机器 `https://124.223.15.17/` → **200**，`ssl_verify_result=0`（**未加 `-k`**），`openssl` 校验 `Verify return code: 0 (ok)`，标题正确 |
| **公网 HTTP** | ✅ `http://124.223.15.17/` → **301** → `https://124.223.15.17/`（跟随跳转后 200） |
| SPA 深链 | ✅ `/login` → 200；静态资源 `/assets/index-*.js`（932KB）→ 200 |
| 鉴权 | ✅ 无令牌 `/api/auth/me` → 401 |
| **注册全链路** | ✅ 用**一次性测试邀请码**走完整注册 → 201 + Cookie → `/api/auth/me` 200 → `/api/customers` 200；**随后已清理测试用户与测试码** |
| 数据恢复 | ✅ 225 文档落库；`users`/`customers`/`employees` 的唯一索引已建 |
| **真实浏览器渲染** | ✅ 无头 Chrome 加载线上站点，登录页完整渲染（标题/2 输入框/2 按钮/中文文案正确），**零应用级报错** |
| **ACME 验证路径** | ✅ 本机与**公网**均能取到 `/.well-known/acme-challenge/<token>` → 200 且**不被 301**；缺失 token 正确 404（不会退化成 SPA 的 index.html） |
| 证书续期机制 | ✅ `--cron` 实测：非 ARI 窗口正确跳过，`exit=0`；reload 钩子已记录在 acme.sh 配置里 |
| 备份脚本 | ✅ 实测产出 219KB 归档 + sha256 校验通过；每日 03:00 定时 |
| **重启自愈** | ✅ `systemctl restart docker` 后 3 个容器 5 秒内自动恢复，`RestartCount=0`，数据完好，服务可达 |
| docker 开机自启 | ✅ `systemctl is-enabled docker` = enabled |
| 日志轮转 | ✅ `/etc/logrotate.d/xiaomang` 语法校验 0 error |

---

## 9. 回滚与卸载

这台机器上**没有旧版可回滚**（重装已清空）。要下线本项目：

```bash
cd /opt/xiaomang/deploy
docker compose -f compose.yml -f compose.cvm.yml down          # 停容器，保留数据卷
docker compose -f compose.yml -f compose.cvm.yml down -v       # ⚠️ 连数据卷一起删，不可恢复

rm -f /etc/cron.d/xiaomang-ip-cert /etc/cron.d/xiaomang-backup /etc/logrotate.d/xiaomang
```

备份数据在 `/opt/xiaomang/backups/`（`down -v` 不会删它）。

---

## 10. 遗留事项

- [ ] **确认能否登录原账号** `2146986718@qq.com`；不行则决定是重置其密码还是用邀请码注册新账号（§5.3）
- [ ] 邀请码 `<从服务器私有文件读取>` 是**一次性**的，用过即废；后续加人需要再种（§5.2）
- [ ] **盯着证书续期**：IP 证书约 6 天有效，查看最近续期日志与实际到期日；若续期失败需按 §6.2 应急回退
- [ ] 本机 `known_hosts` 已按重装后的新主机密钥更新（旧记录备份在 `~/.ssh/known_hosts.bak-*`）
- [ ] 服务器 root 密码本次以明文形式在会话里传递过 —— **建议轮换**
- [ ] 内存 1.9G 偏紧，若后续加功能建议升配到 4G
- [ ] 正式域名：`xiaomang.cloud` 因「无备案 + 大陆服务器」被腾讯云阻断（分析见 `docs/DEPLOY-TENCENT.md` §7），
      要恢复需换可备案域名或迁境外节点；目前用 IP 入口
