# 小芒 AI · 内容生产工作台

小芒面向新媒体内容团队，将客户管理、账号定位、选题研究、AI 内容生产、发布材料准备和数据复盘放在同一个工作台中。项目经理负责客户、策略与任务分配，员工按任务完成选题与内容生产，复盘经验经确认后回流到后续创作。

当前仓库采用 npm Workspaces，包含 React 前端、Express 服务端和共享角色定义。

## 核心能力

| 模块 | 能力 |
| --- | --- |
| 团队与客户 | 经理/员工登录、员工管理、客户档案、IP 信息整理、任务分配与今日任务 |
| 账号定位 | 对标账号研究、用户画像、账号规划、黄金三秒与结尾钩子分析、客户选题库 |
| 选题与内容 | 抖音、视频号、TikTok 对标内容获取，选题筛选、脚本提取、二创与翻译，流式展示生成结果 |
| 发布仓 | 封面、发布文案与话题标签生成和选择，按选题保存草稿，最终文案编辑与飞书导出 |
| 数据复盘 | 单条视频与周度账号分析，手工填表、Excel 导入与 AI 识别，下周配比预览、确认与经验回流 |

工作流：**客户建档 → 账号定位与建库 → 分配任务 → 筛选选题 → 内容生成 → 发布仓与最终编辑 → 人工发布 → 数据复盘**。

平台数据、AI、语音识别、图片生成和飞书导出依赖对应服务配置。发布仓用于准备发布材料，平台发布仍由人工完成。

## 技术栈与目录

- **前端**：React 18、TypeScript、Vite 6、React Router、Tailwind CSS 4、Radix UI。
- **后端**：Node.js、Express 5、MongoDB、bcryptjs；业务逻辑集中在 `apps/server/api/_lib/`。
- **AI 与集成**：TikHub、DeepSeek、豆包 ASR/视频理解、星辰图片服务、飞书。
- **部署**：Docker 多阶段构建、Docker Compose、Nginx。

```text
.
├── apps/
│   ├── web/                    # 前端页面、管理端、内容生产与复盘界面
│   └── server/
│       ├── src/                # Express 统一入口与管理端路由
│       ├── api/                # API 处理器与共享业务逻辑
│       ├── scripts/            # 邀请码、迁移、冒烟与验证脚本
│       ├── tests/              # Node.js 测试
│       └── .env.example        # 服务端配置模板
├── packages/shared/            # 共享角色定义
├── deploy/                     # Compose、Nginx、备份与恢复配置
├── docs/                       # 产品、复盘、ASR 与部署文档
├── Dockerfile
├── HANDOFF.md                  # 交接记录与历史决策
└── package.json                # 工作区与统一命令
```

## 本地运行

### 1. 准备环境

- Node.js **22.18 或以上**及 npm；仓库 Dockerfile 使用 Node.js 24。
- 可访问的 MongoDB；仓库容器配置使用 MongoDB 8.0。
- 如需音视频转写，需可用的 FFmpeg。默认尝试 `ffmpeg-static`，也可通过 `FFMPEG_PATH` 指定本机可执行文件。
- Docker 为可选项，可用于启动本地数据库。

```bash
git clone https://github.com/spaceyzx216/xiaomang.git
cd xiaomang
npm ci
cp apps/server/.env.example apps/server/.env
```

### 2. 配置数据库与会话

已有 MongoDB 时，可直接配置连接地址。也可以启动一个仅映射到本机回环地址的开发数据库：

```bash
docker run -d --name xiaomang-mongo \
  -p 127.0.0.1:27018:27017 \
  -v xiaomang-dev-mongo:/data/db \
  mongo:8.0
```

此示例用于本地开发，未启用数据库认证。生产环境请使用带认证的独立配置。

编辑 `apps/server/.env` 中的对应项：

```dotenv
PORT=8787
MONGODB_URI=mongodb://127.0.0.1:27018/xiaomang
MONGODB_DB_NAME=xiaomang
JWT_SECRET=REPLACE_WITH_RANDOM_SESSION_SECRET
```

使用下面的命令生成随机值，替换 `JWT_SECRET` 的占位内容：

```bash
openssl rand -base64 48
```

后端先加载 `apps/server/.env`，再以覆盖模式加载 `apps/server/src/.env`（如果存在）。新环境建议统一维护前者；如果本机保留了后者，请先检查其中是否有旧配置。

### 3. 创建经理邀请码

首次注册经理账号前，需要在数据库中创建可用邀请码。在仓库根目录执行：

```bash
node --env-file=apps/server/.env \
  apps/server/scripts/seed-invite-code.mjs '<自定义邀请码>' 1 'local-setup'
```

将 `<自定义邀请码>` 替换为自己的值；`1` 表示最多使用一次。该脚本读取进程环境变量，因此本地执行时需要显式指定 `--env-file`。

### 4. 启动工作台

```bash
npm run dev
```

- 前端通常位于 `http://localhost:5173`，以 Vite 实际输出为准。
- 后端默认位于 `http://localhost:8787`。
- Vite 将 `/api` 请求代理到 `http://localhost:8787`。如果修改后端端口，需要同步修改 `apps/web/vite.config.ts`。

打开前端的 `/register` 页面，使用邀请码注册经理账号。经理登录后可创建员工、客户和任务；员工使用经理创建的账号登录。

服务启动时会连接 MongoDB 并建立管理端索引，数据库不可达会阻止正常启动。启动后可检查：

```bash
curl http://localhost:8787/health
curl http://localhost:8787/health/ready
```

`/health` 检查进程响应；`/health/ready` 同时检查数据库，数据库不可用时返回 HTTP 503。

## 外部服务配置

完整变量与说明见 [`apps/server/.env.example`](apps/server/.env.example)。按需要启用以下能力：

| 能力 | 主要配置 |
| --- | --- |
| 平台账号与视频数据 | `TIKHUB_API_TOKEN`、`TIKHUB_BASE_URL` |
| 文案生成与分析 | `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL` |
| 音视频转写 | `DOUBAO_API_KEY`、`DOUBAO_STREAM_ASR_*`、`DOUBAO_FILE_ASR_*`，以及可用的 FFmpeg |
| 视频理解兜底 | `DOUBAO_VIDEO_API_KEY`、`DOUBAO_VIDEO_ENDPOINT`、`DOUBAO_VIDEO_MODEL` |
| 封面图片生成 | `XINGCHEN_API_KEY`；同时兼容 `XXCAPI_API_KEY`，模型与地址可按模板覆盖 |
| 飞书文档与多维表 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，以及目标文件夹或多维表配置 |

缺少对应配置时，相关功能会报错或使用该模块已有的降级逻辑，不能据此视为真实模型能力已验证。ASR 的调用链与排查说明见 [`docs/ASR-MODEL-USAGE.md`](docs/ASR-MODEL-USAGE.md)。

本地开发默认使用同源 `/api` 代理，无需额外配置前端 API 地址。确需覆盖时，在 `apps/web/.env` 中设置 `VITE_API_PROXY_BASE` 并重新启动或构建前端。`VITE_*` 会进入浏览器代码，只应放公开配置；API 密钥和数据库连接串保留在服务端。

## 常用命令与验证

以下命令均在仓库根目录执行：

| 命令 | 作用与前置条件 |
| --- | --- |
| `npm run dev` | 并行启动前端与后端，需要 MongoDB 和基础配置 |
| `npm run dev:web` | 仅启动 Vite 前端 |
| `npm run dev:server` | 仅启动后端，监听源码改动 |
| `npm run build` | 构建前端，输出至 `apps/web/dist/` |
| `npm start` | 启动 Express，同时托管已经构建的前端 |
| `npm test` | 运行服务端测试；完整运行需要 MongoDB 和测试环境配置 |
| `npm run verify:routes` | 启动临时服务进行真实 HTTP 路由检查，需要可创建临时库的 MongoDB 账号 |
| `npm run verify:render` | 对关键页面进行服务端渲染检查 |
| `npm run verify:concurrency` | 内容生成并发与失败恢复的浏览器检查；需先构建，并安装 Chrome/Chromium，可通过 `CHROME_PATH` 指定 |
| `npm run probe:image --workspace @xiaomang/server` | 图片网关连通性检查，需要真实服务配置 |

部分数据库测试在连接不可用时会跳过，管理端集成测试则会直接失败。测试脚本会使用独立临时数据库，需要相应的创建、读写与清理权限。页面渲染检查不能代替浏览器交互验证，Vite 构建也不等同于全项目 TypeScript 类型检查。

如果从其他机器复制过 `node_modules` 并遇到 esbuild 原生二进制缺失或平台错误，请在当前机器重新执行 `npm ci`，不要复用其他环境的依赖目录。

## 构建与部署

### Node.js 运行

配置好 MongoDB、服务端环境变量与 FFmpeg 后：

```bash
npm ci
npm run build
npm start
```

Express 默认在 `8787` 端口提供 API 与前端静态资源，并处理前端路由回退。公网运行时应配置 HTTPS 反向代理。

### Docker 与持久化

仓库 Dockerfile 构建前端，并在运行镜像中安装 FFmpeg；Compose 编排应用、MongoDB 与 Nginx。

- 从 `deploy/app.env.example`、`deploy/mongo.env.example` 创建部署环境文件，替换所有占位值；应用数据库凭据需与初始化配置一致。
- `deploy/compose.yml` 是基础编排；`deploy/compose.cvm.yml` 补充腾讯云构建源、443 端口与证书挂载；`deploy/compose.server.yml` 聚合两者。
- 仓库现有 `deploy/nginx.conf` 包含 HTTPS 跳转和证书路径，启动 Nginx 前需完成证书及挂载配置，不能直接当作通用 HTTP 开箱配置。
- MongoDB 数据使用 `mongo_data` 卷；应用文件使用 `app_data` 卷，容器内 `DATA_DIR=/app/data`。直接用 Node.js 运行时，默认文件数据位于 `apps/server/src/data/`。
- 备份与恢复脚本位于 `deploy/backup.sh`、`deploy/restore.sh`；环境文件、业务数据和备份不提交到 Git。

部署操作与历史记录见 [`docs/DEPLOY.md`](docs/DEPLOY.md)。其中的服务器地址、发布结果、证书与回滚记录对应文档记录时点，执行前需核对实际环境。更早的腾讯云环境说明保留在 [`docs/DEPLOY-TENCENT.md`](docs/DEPLOY-TENCENT.md)。

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [产品需求](docs/PRD.md) | 业务流程、角色、功能范围与验收要求 |
| [周度复盘](docs/WEEKLY-REVIEW.md) | 数据录入、统计口径、配比确认与经验回流 |
| [ASR 调用说明](docs/ASR-MODEL-USAGE.md) | 转写通道、模型配置与排查线索 |
| [部署手册](docs/DEPLOY.md) | 部署结构、备份恢复与历史发布记录 |
| [系统合并记录](docs/MERGE-PROGRESS.md) | 管理端与内容工作台的合并进展 |
| [交接记录](HANDOFF.md) | 实现背景、问题排查与历史决策 |

`docs/legacy/` 保留旧版本资料。文档中的历史测试数量和上线记录不代表当前检出版本或线上环境已经重新验证。
