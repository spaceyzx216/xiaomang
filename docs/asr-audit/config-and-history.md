# ASR 配置与部署历史审计（config-and-history）

> 审计对象：小芒 `apps/server` 的语音识别（ASR）provider 配置——**代码默认值 / 本地 `.env` / 生产部署 env / 文档示例**四处到底各自实际生效什么。
> 审计时间：2026-10-18。仓库状态：`main` @ `f9aec22`（2026-10-09 19:13:32 +0800），工作树含未提交改动（`HANDOFF.md` +191/−6 等；`config.js` **无改动**）。
> 方法：静态读码 + `node` 动态 import `config.js` 后按 env 文件实测 + `git log -S` pickaxe + 对 `.deploy/rollbacks` 回滚包做字节级比对。
> 密钥纪律：全文只写「已配置 / 未配置」，**不输出任何 API key / token / secret 的值**；也没有 `cat` 完整 `.env`。真实 `.env`、`deploy/app.env`、`.deploy/` 均被 `.gitignore` 排除（`.gitignore:3-4,17-19`），git 里只有 `.env.example`。

---

## 0. 结论速览（给 Lead）

1. **生产（腾讯云 CVM，Docker）实际生效链**（下文 §2 实测）：
   - **全局链**（`config.transcriptProviders`，员工二创等用）：`tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`
   - **gold 链**（`config.goldTranscriptProviders`，黄金三秒等用）：`doubao-file → doubao-video → tikhub-music → tikhub-ffmpeg → ffmpeg`
2. **生产 env 根本没有设置 `GOLD_TRANSCRIPT_PROVIDERS`，也没设置任何 `DOUBAO_FILE_ASR_*`** → gold 链走代码默认，且 file 通道资源 id 走默认 **`volc.seedasr.auc`**。这是「没人显式配 Seed 2.0，但生产 gold 链会调用 Seed 2.0 录音文件识别」的直接机制。
3. **生产全局链不含 doubao-file**：因为 `deploy/app.env` 显式写了 `TRANSCRIPT_PROVIDERS="ffmpeg,doubao-video"`（`.deploy/app.env:16`），把 `doubao-file` 排除掉了；这条链上的 ASR 都是 flash（`volc.bigasr.auc_turbo`）。
4. **生产代码含 doubao-file**：2026-10-14 更新前的源码回滚包中 `config.js` 与 HEAD `f9aec22` **逐字节一致**（SHA256 相同），说明 2026-10-09 起在跑的那版就已含 doubao-file；2026-10-14 的新版由「当前工作区」构建（`docs/DEPLOY.md:14`），而 `config.js` 从 2026-09-28 起就没再改过 → **更新前后两版都含 doubao-file**。
5. **文档/示例明显滞后于代码**：`HANDOFF.md §3.3` 和 `apps/server/.env.example` 仍写旧 gold 链（ffmpeg 第一、无 doubao-file）；`f9aec22` 只改了代码默认值和 `DOUBAO_FILE_ASR_*` 文档，没同步这两处。**照文档去配 `GOLD_TRANSCRIPT_PROVIDERS=ffmpeg,...` 会把 doubao-file 关掉；不配反而走默认打开。**
6. **测试锁不住这个漂移**：`content-agent.test.mjs` 只锁「全局链 unshift/白名单」和「file ASR 协议」，**没有测试锁「无 env 时 gold 默认链」**。
7. **账单相关可核实事实**（只列事实，见 §7）：项目里唯一的 Seed 系 ASR 资源 id 是 `volc.seedasr.auc`（只被 doubao-file 使用）；flash 是 `volc.bigasr.auc_turbo`；本地 `.env` 与生产 env 的 `DOUBAO_RESOURCE_ID` 都是 bigasr。仓库里没有豆包 ASR 免费额度/计费配置或文档，**账户欠费原因无法从本仓库断言**。

---

## 1. 配置解析代码事实

### 1.1 全局链 `getTranscriptProviders()`（`apps/server/api/_lib/contentAgent/config.js:47-69`）

1. **白名单**：`["tikhub-music","tikhub-ffmpeg","ffmpeg","doubao-video","doubao-file"]`（`:51`）。`TRANSCRIPT_PROVIDERS` 里不认识的名字会被**静默过滤**（`:57-59`）。
2. **基础列表**：`splitCsv(process.env.TRANSCRIPT_PROVIDERS, ["doubao-file","ffmpeg","doubao-video"])`（`:57`；空串/未设时用后面的 fallback，`:60` 再兜一次）。
3. **TikHub 自动 `unshift`**（这是本地/生产实际链与 env 字面值不一致的原因）：
   - 若列表含 `ffmpeg` 且 `TIKHUB_TRANSCRIPT_PROVIDER_ENABLED !== "false"`（默认 true）→ 在**链首**插入 `tikhub-ffmpeg`（`:61-63`）。
   - 再若列表含 `tikhub-ffmpeg` 且 `TIKHUB_MUSIC_PROVIDER_ENABLED !== "false"`（默认 true）→ 在**链首**插入 `tikhub-music`（`:64-67`）。
4. `tikhub` 别名会被规范成 `tikhub-ffmpeg`（`:26-30`），最后去重（`:68`）。

> 推论：`TRANSCRIPT_PROVIDERS="ffmpeg,doubao-video"`（本地与生产都这么写）的实际生效值是 `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`，**不含 doubao-file**。

### 1.2 关键默认值（代码 fallback）

| 字段（config 返回的 key） | 读取的 env | 代码默认值 | 位置 |
|---|---|---|---|
| `transcriptProviders` | `TRANSCRIPT_PROVIDERS` + 两个 TIKHUB 开关 | 见 §1.1（未设时含 `doubao-file`） | `config.js:57-68,97` |
| `goldTranscriptProviders` | `GOLD_TRANSCRIPT_PROVIDERS` | `doubao-file, doubao-video, tikhub-music, tikhub-ffmpeg, ffmpeg` | `config.js:181` |
| `doubaoResourceId`（flash） | `DOUBAO_RESOURCE_ID` | `volc.bigasr.auc_turbo` | `config.js:138` |
| `doubaoAsrEndpoint`（flash） | `DOUBAO_ASR_ENDPOINT` | `https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash` | `config.js:132-134` |
| `doubaoFileAsrResourceId`（file / Seed 2.0） | `DOUBAO_FILE_ASR_RESOURCE_ID` | `volc.seedasr.auc` | `config.js:153` |
| `doubaoFileAsrSubmitUrl` / `QueryUrl` | `DOUBAO_FILE_ASR_SUBMIT_URL` / `_QUERY_URL` | `.../api/v3/auc/bigmodel/submit` / `/query` | `config.js:151-152` |
| `doubaoFileAsrPollIntervalMs` / `BudgetMs` | `DOUBAO_FILE_ASR_POLL_INTERVAL_MS` / `_BUDGET_MS` | `2000` / `120000` | `config.js:156-157` |
| `doubaoVideoEndpoint` / `ApiKey` / `Model` | `DOUBAO_VIDEO_*` | `""` / `""` / `doubao-seed-2-0-mini-260428` | `config.js:158-161` |
| `goldTranscriptEnabled` / `ClipSeconds` | `GOLD_TRANSCRIPT_ENABLED` / `_CLIP_SECONDS` | `true` / `5` | `config.js:170,183` |
| `goldTranscriptLimit` / `BatchSize` / `Concurrency` / `BudgetMs` | `GOLD_TRANSCRIPT_*` | `60` / `30` / `3` / `240000` | `config.js:185-201` |

### 1.3 两条链各自的消费点

- **全局链**：`contentAgent/index.js:269-270` 把 `config.transcriptProviders` 传给 `transcribeVideo` 并写进「执行方案」日志；`src/index.js:119` 启动时把 `transcriptProviders` 打进 `server.config` 日志。
- **gold 链**：`goldThreeSecondTranscripts.js:253-256` 取 `config.goldTranscriptProviders` 作为 `providers` 传参；`providers.js:2163-2170` 中，显式传 `providers` 时**跳过**「有 TikHub 就跳过本地 ffmpeg」的隐式优化。
- **资源 id 落到请求头**：flash → `X-Api-Resource-Id: config.doubaoResourceId`（`providers.js:596`）；file → `X-Api-Resource-Id: config.doubaoFileAsrResourceId`（`providers.js:728-742`）。

### 1.4 生产环境变量是从哪进容器的

- 生产入口是 Docker 里的 Express：`Dockerfile:38` `CMD ["node","apps/server/src/index.js"]`，`Dockerfile:33` 设 `NODE_ENV=production`。
- `.dockerignore:5-7` 排除了 `**/.env`、`**/.env.*`、`**/*.env` → **镜像里没有任何 env 文件**。
- `deploy/compose.yml:15-24`（app 服务）：`env_file: app.env`（`:19`），并显式注入 `NODE_ENV=production`（`:21`）。
- 因此生产 ASR env 的**唯一来源**是服务器 `/opt/xiaomang/deploy/app.env`；本机 `.deploy/app.env` 是它的备份（`docs/DEPLOY.md:131-132`、`docs/DEPLOY-TENCENT.md:119-126`）。
- 本地开发由 `src/index.js:90-96` 两次 `dotenv.config()`：先 `apps/server/.env`（不 override），再 `apps/server/src/.env`（`override:true`，当前**不存在**这个文件）。若以后有人建 `apps/server/src/.env`，它会覆盖 `apps/server/.env`——这是本地独有的加载顺序，生产不受影响。

---

## 2. 各环境实际生效配置（核心）

### 2.1 实测方法

在 `apps/server` 目录下用 `node --input-type=module -e`：先用 `dotenv.config({path: <env文件>, override:true})` 加载对应文件，再动态 `import()` `api/_lib/contentAgent/config.js` 并调用 `getContentAgentConfig()`。为隔离场景，加载前会清空本次相关的 env（`TRANSCRIPT_PROVIDERS`、`GOLD_TRANSCRIPT_PROVIDERS`、`TIKHUB_*_ENABLED`、`DOUBAO_*`）。
**只打印以下非敏感字段**：`transcriptProviders`、`goldTranscriptProviders`、`doubaoResourceId`、`doubaoFileAsrResourceId`、`doubaoAsrEndpoint`、`doubaoVideoModel`（另加 file 的 submit/query/poll/budget 与「密钥是否配置」布尔值）。**没有打印任何 key/token/secret。**

### 2.2 环境 → 全局链 → gold 链 → 资源 id 对照表（node 实测值）

| 环境 / 来源 | 显式设置的 ASR env | **全局链实际生效** | **gold 链实际生效** | flash resource id | file resource id | flash endpoint | video model |
|---|---|---|---|---|---|---|---|
| **代码默认**（全部 ASR env 清空） | 无 | `tikhub-music, tikhub-ffmpeg, doubao-file, ffmpeg, doubao-video` | `doubao-file, doubao-video, tikhub-music, tikhub-ffmpeg, ffmpeg` | `volc.bigasr.auc_turbo` | `volc.seedasr.auc` | `.../recognize/flash` | `doubao-seed-2-0-mini-260428` |
| **本地 `apps/server/.env`**（真实 44 行） | `TRANSCRIPT_PROVIDERS="ffmpeg,doubao-video"`、`TIKHUB_MUSIC_PROVIDER_ENABLED="true"`、`DOUBAO_RESOURCE_ID="volc.bigasr.auc_turbo"`、`DOUBAO_ASR_ENDPOINT`=flash、`DOUBAO_VIDEO_MODEL=...` | `tikhub-music, tikhub-ffmpeg, ffmpeg, doubao-video` | `doubao-file, doubao-video, tikhub-music, tikhub-ffmpeg, ffmpeg`（**未设 env → 代码默认**） | `volc.bigasr.auc_turbo` | `volc.seedasr.auc`（**未设 env → 代码默认**） | `.../recognize/flash` | `doubao-seed-2-0-mini-260428` |
| **生产 `.deploy/app.env`**（= 服务器 `deploy/app.env` 备份，44 行） | 与本地同：`TRANSCRIPT_PROVIDERS="ffmpeg,doubao-video"`、`TIKHUB_MUSIC_PROVIDER_ENABLED="true"`、`DOUBAO_RESOURCE_ID="volc.bigasr.auc_turbo"`、`DOUBAO_ASR_ENDPOINT`=flash、`DOUBAO_VIDEO_MODEL=...` | `tikhub-music, tikhub-ffmpeg, ffmpeg, doubao-video` | `doubao-file, doubao-video, tikhub-music, tikhub-ffmpeg, ffmpeg`（**未设 env → 代码默认**） | `volc.bigasr.auc_turbo` | `volc.seedasr.auc`（**未设 env → 代码默认**） | `.../recognize/flash` | `doubao-seed-2-0-mini-260428` |
| **示例 `apps/server/.env.example`**（193 行） | `TRANSCRIPT_PROVIDERS=ffmpeg,doubao-video`（`:104`）、`TIKHUB_TRANSCRIPT_PROVIDER_ENABLED=true`（`:105`）、`TIKHUB_MUSIC_PROVIDER_ENABLED=true`（`:106`）、`GOLD_TRANSCRIPT_PROVIDERS=ffmpeg,tikhub-music,tikhub-ffmpeg,doubao-video`（`:66`）、`DOUBAO_FILE_ASR_*`（`:132-139`）、`DOUBAO_RESOURCE_ID=volc.bigasr.auc_turbo`（`:124`） | `tikhub-music, tikhub-ffmpeg, ffmpeg, doubao-video` | `ffmpeg, tikhub-music, tikhub-ffmpeg, doubao-video`（**显式覆盖 → 没有 doubao-file**） | `volc.bigasr.auc_turbo` | `volc.seedasr.auc` | `.../recognize/flash` | `doubao-seed-2-0-mini-260428` |
| **旧示例 `apps/server/src/.env.example`**（25 行，`ea691d8` 起未再更新） | `TRANSCRIPT_PROVIDERS=ffmpeg,doubao-video`（`:8`）、`DOUBAO_RESOURCE_ID=volc.bigasr.auc_turbo`（`:12`）、`DOUBAO_ASR_ENDPOINT`=flash（`:13`）、`DOUBAO_VIDEO_MODEL=...`（`:16`）；**没有** `GOLD_TRANSCRIPT_*`、**没有** `DOUBAO_FILE_ASR_*` | `tikhub-music, tikhub-ffmpeg, ffmpeg, doubao-video` | `doubao-file, doubao-video, tikhub-music, tikhub-ffmpeg, ffmpeg`（**未设 env → 代码默认**） | `volc.bigasr.auc_turbo` | `volc.seedasr.auc`（未设 → 默认） | `.../recognize/flash` | `doubao-seed-2-0-mini-260428` |
| **部署示例 `deploy/app.env.example`**（6 行） | **没有任何 ASR env**（只有 mongo/jwt/TZ + 一句「Copy the required AI provider variables from the verified local configuration」，`:5-6`） | 若原样使用 = 代码默认（含 doubao-file） | 代码默认（doubao-file 第一） | `volc.bigasr.auc_turbo` | `volc.seedasr.auc` | `.../recognize/flash` | `doubao-seed-2-0-mini-260428` |

要点：
- **本地与生产完全一致**（ASR 非敏感键值逐项相同，见 §2.5）。两处都**没有** `GOLD_TRANSCRIPT_PROVIDERS`，所以 gold 链 = 代码默认 = **doubao-file 第一**。
- **`.env.example` 是唯一"显式把 doubao-file 从 gold 链里拿掉"的示例**，与代码默认相反。
- `deploy/app.env.example` 完全没写 ASR 配置，部署 env 的 ASR 部分在文档里是空白。

### 2.3 哪些关键 env「未设置 → 走代码默认」

| env | 代码默认 | 本地 `apps/server/.env` | 生产 `.deploy/app.env` | `.env.example` | 实际影响 |
|---|---|---|---|---|---|
| `GOLD_TRANSCRIPT_PROVIDERS` | `doubao-file,doubao-video,tikhub-music,tikhub-ffmpeg,ffmpeg` | **未设** → 默认 | **未设** → 默认 | 设为旧链（`:66`） | 生产/本地 gold 链 **doubao-file 第一**；示例则没有 doubao-file |
| `DOUBAO_FILE_ASR_RESOURCE_ID` | `volc.seedasr.auc`（`config.js:153`） | **未设** → 默认 | **未设** → 默认 | 设为 `volc.seedasr.auc`（`:135`，与默认相同） | 生产调 file 通道即用 Seed 2.0 资源 id，无需任何 env |
| `DOUBAO_FILE_ASR_SUBMIT_URL` / `_QUERY_URL` | `/submit`、`/query`（`config.js:151-152`） | **未设** → 默认 | **未设** → 默认 | 设为与默认相同的值（`:132-133`） | 无行为差异 |
| `DOUBAO_FILE_ASR_POLL_INTERVAL_MS` / `_BUDGET_MS` | `2000` / `120000`（`config.js:156-157`） | **未设** → 默认 | **未设** → 默认 | 设 `2000` / `120000`（`:138-139`） | 无行为差异 |
| `GOLD_TRANSCRIPT_CLIP_SECONDS` / `_ENABLED` / `_LIMIT` / `_BATCH_SIZE` / `_CONCURRENCY` / `_RESOLVE_CONCURRENCY` / `_BUDGET_MS` | `5` / `true` / `60` / `30` / `3` / `8` / `240000`（`config.js:170-201`） | **全部未设** → 默认 | **全部未设** → 默认 | 示例设了其中一部分（`:62-79`） | 生产 gold 转写**默认开启**（`goldTranscriptEnabled:true`） |
| `TIKHUB_TRANSCRIPT_PROVIDER_ENABLED` | `true`（`config.js:52`） | **未设** → 默认 true | **未设** → 默认 true | `true`（`:105`） | 链首自动插入 `tikhub-ffmpeg` |
| `TIKHUB_MUSIC_PROVIDER_ENABLED` | `true`（`config.js:56`） | 设为 `true`（`:36`） | 设为 `true`（`:34`） | `true`（`:106`） | 链首再插入 `tikhub-music` |
| `FFMPEG_ENABLED` | `true`（`config.js:103`） | **未设** → 默认 true | **未设** → 默认 true | `true`（`:191`） | 本地 ffmpeg provider 可用 |

### 2.4 node 实测输出（只摘非敏感字段）

```jsonc
// 场景 1：代码默认（清空全部 ASR env）
{ "transcriptProviders": ["tikhub-music","tikhub-ffmpeg","doubao-file","ffmpeg","doubao-video"],
  "goldTranscriptProviders": ["doubao-file","doubao-video","tikhub-music","tikhub-ffmpeg","ffmpeg"],
  "doubaoResourceId": "volc.bigasr.auc_turbo", "doubaoFileAsrResourceId": "volc.seedasr.auc",
  "doubaoAsrEndpoint": "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
  "doubaoVideoModel": "doubao-seed-2-0-mini-260428" }

// 场景 2：apps/server/.env
{ "transcriptProviders": ["tikhub-music","tikhub-ffmpeg","ffmpeg","doubao-video"],
  "goldTranscriptProviders": ["doubao-file","doubao-video","tikhub-music","tikhub-ffmpeg","ffmpeg"],
  "doubaoResourceId": "volc.bigasr.auc_turbo", "doubaoFileAsrResourceId": "volc.seedasr.auc",
  "doubaoAsrEndpoint": "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
  "doubaoVideoModel": "doubao-seed-2-0-mini-260428",
  "tikhubProviderEnabled": "(未设置→默认true)", "goldEnvRaw": "(未设置→代码默认)" }

// 场景 3：.deploy/app.env（与场景 2 完全一致）
{ "transcriptProviders": ["tikhub-music","tikhub-ffmpeg","ffmpeg","doubao-video"],
  "goldTranscriptProviders": ["doubao-file","doubao-video","tikhub-music","tikhub-ffmpeg","ffmpeg"],
  "doubaoResourceId": "volc.bigasr.auc_turbo", "doubaoFileAsrResourceId": "volc.seedasr.auc",
  "doubaoAsrEndpoint": "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
  "doubaoVideoModel": "doubao-seed-2-0-mini-260428",
  "tikhubProviderEnabled": "(未设置→默认true)", "goldEnvRaw": "(未设置→代码默认)" }

// 场景 4：apps/server/.env.example（注意 gold 链变了）
{ "goldTranscriptProviders": ["ffmpeg","tikhub-music","tikhub-ffmpeg","doubao-video"],
  "transcriptProviders": ["tikhub-music","tikhub-ffmpeg","ffmpeg","doubao-video"],
  "goldEnvRaw": "ffmpeg,tikhub-music,tikhub-ffmpeg,doubao-video" }
```

file 通道默认值（本地与生产一致，均未设 env）：`submit=https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit`、`query=.../query`、`resource=volc.seedasr.auc`、`poll=2000ms`、`budget=120000ms`；两处 `DOUBAO_API_KEY` 都已配置，因此该通道**可用**。

### 2.5 本地与生产的一致性 + 密钥状态

- 逐项比对 ASR 非敏感键，**本地 = 生产（值一致）**：`TRANSCRIPT_PROVIDERS`、`DOUBAO_RESOURCE_ID`、`DOUBAO_ASR_ENDPOINT`、`DOUBAO_VIDEO_ENDPOINT`、`DOUBAO_VIDEO_MODEL`、`TIKHUB_MUSIC_PROVIDER_ENABLED`。
- 密钥状态（只写是否配置）：**`DOUBAO_API_KEY`=已配置**、`DOUBAO_APP_KEY`=未配置（空）、`DOUBAO_ACCESS_KEY`=未配置（空）、**`DOUBAO_VIDEO_API_KEY`=已配置**、`TIKHUB_API_TOKEN`=已配置、`DEEPSEEK_API_KEY`=已配置。本地与生产相同。
- 两份文件并非同一文件（SHA256 不同、各 44 行）：差异在 `PORT`（本地，`.env:3`）vs `TZ`（生产，`.deploy/app.env:44`）以及会话/飞书等密钥值；ASR 段一致。

---

## 3. 生产跑的是否是「含 doubao-file」的版本（B）

### 3.1 部署时间线（文档 + 本机回滚资产）

| 时间（北京时间） | 事件 | 依据 |
|---|---|---|
| 2026-09-28 | 首次腾讯云部署（共用服务器，宝塔 nginx；旧 Next.js 项目同机） | `docs/DEPLOY-TENCENT.md:1-38` |
| （之后） | 服务器被**重装**，9-28 部署全部消失 | `docs/DEPLOY.md:80-90` |
| 2026-10-09 | **首次重建**（从零装 Docker、同步源码、起容器、恢复数据） | `docs/DEPLOY.md:3,95-103` |
| 2026-10-14 17:55 | 建立更新前回滚目录 `pre-20261014T0950Z`（源码/配置/数据库/证书） | `.deploy/rollbacks/pre-20261014T0950Z/`、`docs/DEPLOY.md:32-43` |
| 2026-10-14 17:59–18:00 | 切换到发布 `20261014T0950Z`（`xiaomang-app:release-20261014T0950Z`），本次由**当前工作区**构建 | `docs/DEPLOY.md:12-30` |
| 至今（文档口径） | 公网 `https://124.223.15.17/`，应用容器运行上述 release | `docs/DEPLOY.md:3-4,49` |

### 3.2 证据链：生产含 doubao-file 代码

1. **本机 `.deploy/app.env` 就是服务器生产 env 的备份**：其 SHA256 = `66f77155…48e979`，与回滚包内 `./deploy/app.env` **完全相同**；且 `docs/DEPLOY.md:29` 记录 10-14 更新时「正式 `app.env` / `mongo.env` 逐字节保持一致」。
2. **回滚包确实来自服务器**（不是本机工作区）：包内含有服务器才有的文件——`./deploy/mongo.env`、`./deploy/acme-webroot/…`、`./deploy/nginx.conf.bak-pre443`、`./.migration-load/mongo-2026-09-22…/manifest.ejson`；同时 `.env` 被排除在外。
3. **回滚包源码 = HEAD `f9aec22`**：包内 `config.js`、`HANDOFF.md`、`providers.js`、`goldThreeSecondTranscripts.js`、`src/index.js` 的 SHA256 与 `git show f9aec22:<path>` **全部逐字节一致**（`config.js` = `43fd52b229a2…38f9`；注意 `src/index.js` 与工作区不同，但等于 HEAD → 包是干净的 `f9aec22` 源码）。这同时说明 **2026-10-09 首次重建部署的就是 `f9aec22`（含 doubao-file）**。
4. **`f9aec22`（2026-10-09 19:13:32 +0800）就是引入 doubao-file 的提交**：`git show f9aec22 -- config.js` 把 `doubao-file` 加进白名单、全局默认改成 `["doubao-file","ffmpeg","doubao-video"]`、gold 默认改成 `["doubao-file","doubao-video","tikhub-music","tikhub-ffmpeg","ffmpeg"]`，并新增 `DOUBAO_FILE_ASR_*`（submit/query/resource/轮询/预算）与 `providers.js` 的 `recognizeDoubaoFileAudio`。
5. **2026-10-14 新版也含 doubao-file**：新版由「当前工作区」构建（`docs/DEPLOY.md:14`），工作区 `config.js` 自 2026-09-28 15:16 起未再修改（mtime + `git status` 无 M + 文件 SHA = HEAD `43fd52b2…38f9`）。即使新版源码包里其它文件有未提交改动，`config.js` 也不是其中之一。
6. **结论（高置信）**：无论生产此刻跑的是 10-14 新版还是回滚到 10-09 旧版，**都包含 doubao-file 代码**，且 10-14 前后 `deploy/app.env` 逐字节不变（因此 `GOLD_TRANSCRIPT_PROVIDERS` 依旧未设 → gold 链仍是 `doubao-file` 第一）。

### 3.3 由证据得出的「生产实际生效链」

- gold 链（2.2 黄金三秒等，功能归属见 `feature-map.md`）：**`doubao-file` 第一** → 对可拿到公网音源 URL 的视频（抖音/TikTok，music.play_url 或视频直链）**会直接调用 `volc.seedasr.auc`（Seed 2.0 录音文件识别）**；失败/无 URL 时回退 `doubao-video`（Ark 视频理解）再回退 TikHub/ffmpeg。
- 全局链（员工二创等）：`tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`，**不含 doubao-file**；前三个 provider 最终都调 flash ASR（`volc.bigasr.auc_turbo`，见 `providers.js:596` 与 `providers.js:2318/2352/2426` 三处 `recognizeDoubaoAudio` 调用）。

### 3.4 证据边界 / 待核实

- 本机**无法直连生产容器**（没有执行 SSH 到 `124.223.15.17`），所以「当前容器里实际跑的文件/镜像标签」没有直接读取；上述结论基于 `docs/DEPLOY.md` 发布记录 + 服务器回滚包字节比对，**证据充分度高但非容器内直证**。
- 若服务器上的 `deploy/app.env` 在 2026-10-14 之后被人工改过（例如新增 `GOLD_TRANSCRIPT_PROVIDERS`），本机 `.deploy/app.env` 不会反映 → 结论会变。**待 Lead 核实**。
- 可在服务器上低成本验证：
  - `docker exec xiaomang-app-1 grep -n "doubao-file" /app/apps/server/api/_lib/contentAgent/config.js`；
  - 看启动日志 `server.config.transcriptProviders`（`src/index.js:119`，只打全局链；gold 链未打日志，需要时可在容器内 `docker exec … node -e` 读 env 计算）。
- 本机回滚目录是**不完整副本**：`rollback.sh` 引用的 `app-image.tar.gz`、`rollback-compose.yml` 及服务器侧验证日志不在本机（`docs/DEPLOY.md:34,43` 说明旧镜像只留在服务器），因此无法在本机做镜像级核对。

---

## 4. ASR 相关 git 时间线（C）

`git log --oneline -S` 结果（pickaxe，全仓）：`doubao-file` → 只有 `f9aec22`；`seedasr` → 只有 `f9aec22`；`bigasr` → `f9aec22` + `ea691d8`（合并带入）。`config.js` 全历史只有两次提交：`ea691d8`、`f9aec22`。

| commit | 提交时间 | 与 ASR 相关的变更 | 对默认值的影响 |
|---|---|---|---|
| `ea691d8` | 2026-09-22 17:47:41 +0800 | 把 xiaomang2 合并为单 workspace 的基线；`config.js` 当时**没有** doubao-file / `DOUBAO_FILE_ASR_*` | 全局默认 `["ffmpeg","doubao-video"]`；gold 默认 `["ffmpeg","tikhub-music","tikhub-ffmpeg","doubao-video"]`；flash = `volc.bigasr.auc_turbo` |
| `79e9142` | 2026-09-24 11:23:39 +0800 | 出图代理 + 网络错误中文化（**非 ASR**，只改了 `.env.example` 其它段落） | 无 |
| `f9aec22`（HEAD） | **2026-10-09 19:13:32 +0800** ⚠️ 不是 10-14 | 引入 `doubao-file` provider（`recognizeDoubaoFileAudio`，异步 submit+query）、`DOUBAO_FILE_ASR_*` 配置项、`volc.seedasr.auc` 默认；改全局/gold 默认链；`.env.example` 增加 file ASR 段（+42/−1）；新增 file ASR 测试 | 全局默认 → `["doubao-file","ffmpeg","doubao-video"]`（再被 TikHub unshift 变成 `tikhub-music,tikhub-ffmpeg,doubao-file,ffmpeg,doubao-video`）；gold 默认 → `["doubao-file","doubao-video","tikhub-music","tikhub-ffmpeg","ffmpeg"]` |
| 工作树（未提交） | 2026-10-14 之后 | `HANDOFF.md` +191/−6、多份业务代码改动；**`config.js` / 测试 / `.env.example` 均无改动** | 无（默认链与 10-14 生产一致） |

> 结论：docs 里「`f9aec22` 是 2026-10-14 提交」的说法与 git 不符——**它是 2026-10-09 19:13 +0800**；2026-10-14 是**部署**新版本（由当时工作区构建），不是该提交时间。

---

## 5. 文档 vs 代码 vs `.env.example` 不一致清单（C）

> 行号说明：`HANDOFF.md` 在工作树里是**已修改未提交**状态，下面用**工作树行号**；括号内给出 HEAD `f9aec22` 的行号。其余文件行号 = 当前 HEAD。

| # | 位置 | 说法 | 与代码/实际的关系 | 影响 |
|---|---|---|---|---|
| 1 | `HANDOFF.md:2797-2802`（HEAD `:2613` 附近） | 黄金三秒链 = `ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video` | 旧值。`config.js:181` 自 `f9aec22` 起为 `doubao-file` 第一 | 按文档理解会以为 gold 链不用 Seed 2.0 |
| 2 | `HANDOFF.md:2824`（HEAD `:2639`） | gold 默认 = `ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video` | 与 `config.js:181` 当前默认相反 | 同上；排障方向会被带偏 |
| 3 | `HANDOFF.md:518`（§0.9-B 表第 9 行，`f9aec22` 新增） | 「ASR 换豆包录音文件识别 2.0」已上线、与旧 flash 是两条通道 | 同一个文档里已经记录了新通道，但 §3.3 没同步 | 文档自相矛盾（写代码的人知道，写链顺序的段落不知道） |
| 4 | `apps/server/.env.example:60-66` | 注释称「本地 ffmpeg 提到第一位…实测快 5 倍」，并显式设 `GOLD_TRANSCRIPT_PROVIDERS=ffmpeg,tikhub-music,tikhub-ffmpeg,doubao-video` | 这是 `f9aec22` **之前**的设计；`f9aec22` 改了代码默认却没有更新这段 | **照示例复制 env 的人会把 doubao-file 从 gold 链拿掉**，行为与「不配置」相反 |
| 5 | `apps/server/.env.example:49-53` | 「真实链路仍是 `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`」 | 只对**全局链**成立（因为 `TRANSCRIPT_PROVIDERS` 覆盖）；对 gold 链不成立 | 容易把两条链混为一谈 |
| 6 | `apps/server/.env.example:104` | `TRANSCRIPT_PROVIDERS=ffmpeg,doubao-video` | 与**代码默认** `["doubao-file","ffmpeg","doubao-video"]` 不同；但与本地/生产实际 env 相同 | 示例其实在演示「排除 doubao-file」的写法，却没有解释 |
| 7 | `apps/server/.env.example:131` | 「要启用就把 doubao-file 放进 `TRANSCRIPT_PROVIDERS` / `GOLD_TRANSCRIPT_PROVIDERS`」 | 已过时：gold 默认已含 `doubao-file`（`config.js:181`，`f9aec22` 起） | 读者会以为 file 通道默认关闭 |
| 8 | `apps/server/src/.env.example:8` | 只有 `TRANSCRIPT_PROVIDERS=ffmpeg,doubao-video`；**没有** `GOLD_TRANSCRIPT_*`、**没有** `DOUBAO_FILE_ASR_*` | 自 `ea691d8`（2026-09-22）后未更新，`f9aec22` 没碰它 | 旧架构遗留示例，照它配会完全丢失 file ASR 段落（虽然走代码默认，但看起来像「没这功能」） |
| 9 | `deploy/app.env.example:5-6` | 只有 mongo/jwt/TZ + 「Copy the required AI provider variables from the verified local configuration」 | 生产 ASR env 实际上只在该文件之外的 `deploy/app.env`（本机 `.deploy/app.env`）；部署文档没有列出 ASR 变量清单 | 生产 ASR 配置**不可从文档复现**；换环境时极易漏配/多配 |
| 10 | `docs/DEPLOY.md`（全文 335 行） | **没有**任何 ASR 模型/资源/链路配置说明（唯一相关字眼是 `:186` 数据表清单里的缓存集合名 `gold_three_second_transcripts`） | 部署手册不记录「线上跑的是哪条 ASR 链」 | 事后无法从部署文档回答「生产用哪个模型」 |
| 11 | `.env` / `.deploy/app.env` | 实际**未设** `GOLD_TRANSCRIPT_PROVIDERS` | 与 `.env.example:66` 的「显式旧链」相反；生产正是因此走了新默认（§2、§3） | 不是错误，但「env 与示例不一致」本身是维护风险 |
| 12 | `HANDOFF.md:1290` | 部署列写「Vercel + 本地 Express 8787」（合并对比表，历史语境） | 当前生产按 `docs/DEPLOY.md` 是腾讯云 CVM Docker；Vercel 侧在更早的 HANDOFF 段落里多处写「**没有部署验证过**」（如 `:1497`、`:1777`） | 不要把 Vercel 的 env 当成生产 env（若线上另有 Vercel 部署，**待 Lead 核实**） |

---

## 6. 测试锁定的是什么（C）

### 6.1 provider 链测试：`apps/server/tests/content-agent.test.mjs:397-461`

- 测试名：`"configures TikHub media provider, ffmpeg fallback, and Doubao video fallback"`（`:397`）。
- 场景：`TRANSCRIPT_PROVIDERS="legacy-provider,ffmpeg,doubao-video"`，并 `delete` 两个 TikHub 开关（`:418-420`）。
- 断言（`:436-449`）：
  - `config.transcriptProviders === ["tikhub-music","tikhub-ffmpeg","ffmpeg","doubao-video"]`（`:438`）——锁定「TikHub 自动 unshift、未知名字 `legacy-provider` 被白名单静默过滤、开关为 true 时 TikHub 在前」这套语义；
  - `config.doubaoResourceId === "volc.bigasr.auc_turbo"`（`:448`）、`doubaoAsrEndpoint` 以 `/recognize/flash` 结尾（`:449`）。
- **没锁**：未设 `TRANSCRIPT_PROVIDERS` 时全局链是否含 `doubao-file`；**未锁 gold 链默认顺序**（全文测试里 `goldTranscriptProviders` 0 命中）。

### 6.2 录音文件识别（Seed 2.0）测试：`apps/server/tests/content-agent.test.mjs:1181-1339`

`FILE_ASR_CONFIG`（`:1181-1191`）显式给 `doubaoFileAsrResourceId: "volc.seedasr.auc"`，7 条测试锁的是**异步协议契约**：

- `:1193` task_id = 自己传的 `X-Api-Request-Id`，submit 与每次 query 必须同一个；`:1212` 断言 `X-Api-Resource-Id === "volc.seedasr.auc"`；只传 URL 不传 base64。
- `:1219` submit 失败立即抛，不白轮询；`:1230` 超预算抛 `DOUBAO_ASR_TIMEOUT` 让 provider 链回退；`:1251` query 报错带出上游状态码；`:1264` 缺 `audioUrl` 直接拒绝（不接受 base64）。
- `:1276` 双音源换源重试（music→video）；`:1305` 全失败时保留每个源的失败原因；`:1325` 单源兼容。

**一句话**：测试锁的是「全局链的 TikHub unshift/白名单语义」+「录音文件识别 2.0 的异步协议与 `volc.seedasr.auc` 资源 id」；**没有测试固定「无 env 时 gold 链默认 `doubao-file` 第一」**，所以 §5 第 1/2/4 条的文档漂移不会被 `npm test` 发现。

---

## 7. 与账单实例「Speech_Recognition_Seed_AUC…」相关的可核实事实（D）

> 以下是**项目内可核实的配置事实**，不含账户后台数据；**不对欠费/免费额度做任何断言**。

| # | 事实 | 证据 |
|---|---|---|
| 1 | 项目内**唯一**的 Seed 系 ASR 资源 id 是 `volc.seedasr.auc`，仅由 `doubao-file` 通道使用 | `config.js:153`；`providers.js:728-742`（`X-Api-Resource-Id: config.doubaoFileAsrResourceId`）；测试 `content-agent.test.mjs:1184,1212`；`.env.example:134-135` |
| 2 | flash 同步 ASR 资源 id 是 `volc.bigasr.auc_turbo`，由 `recognizeDoubaoAudio`（tikhub-music / tikhub-ffmpeg / ffmpeg 三个 provider 共用）使用 | `config.js:138`；`providers.js:596`；测试 `:448`；`apps/server/.env:22`；`.deploy/app.env:20`；`.env.example:124`；`src/.env.example:12` |
| 3 | 全仓库出现的 `volc.*` 资源 id **只有上面两个**（grep `volc\.`，排除 node_modules） | 见附录 A 的 grep；另 `DOUBAO_VIDEO_MODEL` 是 Ark 模型名不是资源 id |
| 4 | 本地 `.env` 与生产 `.deploy/app.env` 的 `DOUBAO_RESOURCE_ID` **都是** `volc.bigasr.auc_turbo` | `.env:22`、`.deploy/app.env:20` |
| 5 | 两处 env **都没有** `DOUBAO_FILE_ASR_RESOURCE_ID` → file 通道走代码默认 `volc.seedasr.auc`；两处 `DOUBAO_API_KEY` 均已配置 → file 通道**可用** | §2.3、§2.5 |
| 6 | 生产 gold 链未配置覆盖 → 默认 `doubao-file` 第一（§3.3）；因此**生产 gold 链功能在不改 env 的情况下会调用 `volc.seedasr.auc`**，而全局链不会（`TRANSCRIPT_PROVIDERS` 显式排除） | `config.js:181` + `.deploy/app.env:16` + §2.4 实测 |
| 7 | 两条 ASR 通道在代码里是**独立字段、独立端点、独立 resource id**：flash = base64 同步（`config.js:132-138`）；file = URL 异步 submit+轮询（`config.js:151-157`）。豆包录音文件识别 2.0 的资源 id 与 flash 的 `DOUBAO_RESOURCE_ID` **互不影响** | `config.js:139-157`；`providers.js:592-600` vs `728-742` |
| 8 | 另有 Ark 视频理解模型 `doubao-seed-2-0-mini-260428`（`DOUBAO_VIDEO_MODEL`），名字含 seed-2-0，但走 `chat/completions` 视频理解、**不是语音识别资源**；由 `doubao-video` provider 使用 | `config.js:158-161`；`providers.js:2444` 起分支；`.env:26`、`.deploy/app.env:24` |
| 9 | 仓库内**没有**豆包 ASR 免费额度/计费配置或说明文档（`docs/`、`HANDOFF.md`、`contentAgent/*.js` 检索「免费额度/计费/账单」仅命中出图与 TikHub 评论的计费注释） | 附录 A 检索命令 |
| 10 | 视频号媒体「用不了 doubao-file」（需要公网可拉 URL，视频号是 Isaac64 加密 + `mediaUrl`/`decodeKey`），文档明确记录 → gold 链对视频号会跳过 doubao-file，落到 doubao-video/ffmpeg | `HANDOFF.md:579`（§D-2）、`HANDOFF.md:640`（§E-4）；`providers.js:2178` 分支 |

> 账单结论（例如「扣费是否来自 Seed 2.0」「是否还有免费额度」）需要火山引擎控制台的资源 id/实例/用量数据，**不在本仓库可见范围内，待 Lead/用户核实**；本文只提供「项目哪些代码路径会按哪个 resource id 发请求」这一层事实。

---

## 8. 待 Lead 核实 / 不确定项

1. **生产容器内实际文件**：本机未 SSH 到 `124.223.15.17`。结论基于 `docs/DEPLOY.md` 发布记录 + 回滚包逐字节比对（证据充分度高）。可在服务器 `docker exec xiaomang-app-1 grep -n doubao-file /app/apps/server/api/_lib/contentAgent/config.js` 直证。
2. **服务器 `deploy/app.env` 在 2026-10-14 之后是否被改过**。本机 `.deploy/app.env` 与 10-14 回滚包内的 `deploy/app.env` SHA256 相同（`66f77155…48e979`），但无法证明之后没人再改（文档只说 10-14 当时逐字节一致）。
3. **Vercel 侧是否还有在线部署及其 env**：`docs/DEPLOY.md` 只描述腾讯云 CVM Docker；HANDOFF 多处记录「Vercel 侧没有部署验证过」。若线上另有 Vercel 部署，其 `DOUBAO_*/GOLD_TRANSCRIPT_PROVIDERS` 不在仓库内，需从 Vercel 项目设置核实。
4. **发布包 SHA256 无法本地复算**：`docs/DEPLOY.md:26` 的源码包 SHA（`fab58a9e…`）对应 10-14 构建时的服务器包，本机无法复现（工作区已变）。
5. **本机回滚目录不完整**：缺 `app-image.tar.gz` / `rollback-compose.yml` / 验证日志（只在服务器 `/opt/xiaomang-rollbacks/…`），无法在本机核对旧镜像。
6. `HANDOFF.md` 为未提交修改状态，本文引用的工作树行号会随其继续编辑漂移；HEAD `f9aec22` 的对应行号已在 §5 括号内给出。

---

## 附录 A：复现命令（均不打印密钥）

```bash
# 1) 各环境实际生效配置（在 apps/server 下执行；输出只含非敏感字段）
cd apps/server
node --input-type=module -e '
import dotenv from "dotenv";
const { getContentAgentConfig } = await import("./api/_lib/contentAgent/config.js");
const files = { "代码默认": null, "本地": "<repo>/apps/server/.env", "生产备份": "<repo>/.deploy/app.env",
                "示例": "<repo>/apps/server/.env.example" };
const ASR = /^(TRANSCRIPT_PROVIDERS|GOLD_TRANSCRIPT_PROVIDERS|TIKHUB_(MUSIC|TRANSCRIPT)_PROVIDER_ENABLED|DOUBAO_)/;
for (const [label, file] of Object.entries(files)) {
  for (const k of Object.keys(process.env)) if (ASR.test(k)) delete process.env[k];
  if (file) dotenv.config({ path: file, override: true, quiet: true });
  const c = getContentAgentConfig();
  console.log(label, JSON.stringify({ transcriptProviders: c.transcriptProviders,
    goldTranscriptProviders: c.goldTranscriptProviders, doubaoResourceId: c.doubaoResourceId,
    doubaoFileAsrResourceId: c.doubaoFileAsrResourceId, doubaoAsrEndpoint: c.doubaoAsrEndpoint,
    doubaoVideoModel: c.doubaoVideoModel }));
}'

# 2) 回滚包与本机/HEAD 的字节比对
T=.deploy/rollbacks/pre-20261014T0950Z/source-and-config.tar.gz
shasum -a 256 .deploy/app.env
tar -xOzf "$T" ./deploy/app.env | shasum -a 256
git show f9aec22:apps/server/api/_lib/contentAgent/config.js | shasum -a 256
tar -xOzf "$T" ./apps/server/api/_lib/contentAgent/config.js | shasum -a 256
shasum -a 256 apps/server/api/_lib/contentAgent/config.js

# 3) pickaxe / 历史
git log --oneline -S 'doubao-file'; git log --oneline -S 'seedasr'; git log --oneline -S 'bigasr'
git show -s --format='%H %ci %s' f9aec22

# 4) 资源 id 全仓检索（用 grep 工具或下面的命令）
grep -rn 'volc\.' --include='*.js' --include='*.mjs' --include='*.md' --include='*.example' --include='*.json' . | grep -v node_modules | grep -v '.deploy/rollbacks'
grep -rn '免费额度\|计费\|账单' docs/ HANDOFF.md apps/server/api/_lib/contentAgent/*.js
```

## 附录 B：本次审计读取的关键文件

- 配置与 provider：`apps/server/api/_lib/contentAgent/config.js`、`providers.js`（相关分支）、`contentAgent/index.js:269`、`goldThreeSecondTranscripts.js:253`、`apps/server/src/index.js:90-124`
- env：`apps/server/.env`（只读、只输出布尔/非敏感值）、`apps/server/.env.example`、`apps/server/src/.env.example`、`.deploy/app.env`、`deploy/app.env.example`、`deploy/compose*.yml`、`Dockerfile`、`.dockerignore`、`.gitignore`
- 部署/历史：`docs/DEPLOY.md`、`docs/DEPLOY-TENCENT.md`、`HANDOFF.md`（§0.9/§0.10/§3.3/E-4/D-2）
- 回滚资产：`.deploy/rollbacks/pre-20261014T0950Z/`（`source-and-config.tar.gz`、`rollback.sh`）
- 测试：`apps/server/tests/content-agent.test.mjs:397-461,1181-1339`

（完）
