# 小芒 ASR 功能映射审计（feature-map）

> 目标：从「用户看到的功能」出发，回答**哪个功能、在哪套入口、走了哪条转写链、最终会调用哪个豆包模型 / resource id**。
> 依据：**当前工作区代码**（工作树有未提交改动；ASR 相关文件 `config.js` / `providers.js` / `goldThreeSecondTranscripts.js` 与 HEAD 一致，未提交改动不影响本报告结论）+ 仓库内 env 文件。
> 约束：不输出任何 key / token / secret 值；只写变量名与「是否配置」。无法从仓库核实的一律标 **「待 Lead 核实」**。
> 关联产出：`docs/asr-audit/provider-layer.md`（provider 层实现细节）、`docs/asr-audit/config-and-history.md`（各环境实际生效配置）。

---

## 0. 结论速览（先看这 6 条）

1. **转写只有两条链**：`config.goldTranscriptProviders`（gold 链）和 `config.transcriptProviders`（全局链）。前者被 **2.2 黄金三秒 / 2.3 结尾钩子 / 1.2 对标账号分析 / 2.4 选题页脚本提取** 共用；后者只有 **员工二创（内容生成）** 用。
2. **gold 链当前代码默认第一个就是 `doubao-file`（Seed 2.0，`volc.seedasr.auc`）**：`apps/server/api/_lib/contentAgent/config.js:181`。
   仓库内 `apps/server/.env` 与 `.deploy/app.env` **都没有设置 `GOLD_TRANSCRIPT_PROVIDERS`**（只设置了 `TRANSCRIPT_PROVIDERS`），因此这两个环境下这 4 个功能实际生效链就是默认值：
   `doubao-file → doubao-video → tikhub-music → tikhub-ffmpeg → ffmpeg`。
   **这是账单里 `Speech_Recognition_Seed_AUC…` 实例最可能的主要来源。**
3. **员工二创走全局链，当前 env 下不碰 Seed**：`TRANSCRIPT_PROVIDERS="ffmpeg,doubao-video"`（`apps/server/.env:18`、`.deploy/app.env:16`）经 `getTranscriptProviders()` 自动补 `tikhub-music → tikhub-ffmpeg` 后实际为
   `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`：前三个都是 flash（`volc.bigasr.auc_turbo`），最后一个是 Ark 多模态视频理解（不是语音识别）。
4. **gold 链里 `doubao-file` 不接受裁剪参数**：2.2/2.3/1.2 传的 `clipSeconds=5` 只有排在第 5 位的本地 `ffmpeg` 真正吃得到；Seed / 豆包视频理解 / tikhub-* 都忽略裁剪。
   含义：默认情况下 2.2/2.3 存的「开头/结尾转写」**可能是整条音频的完整转写**，而且 head/tail 两个 scope 各调一次 Seed —— 同一视频可能被 Seed 转两遍。**是否为预期，待 Lead 核实**（见 §8-①）。
5. **不转写的功能**：2.1 分类、1.3 账号规划、3.x 发布仓、4.1 视频分析、4.2 周度分析、Excel 表格识别（另含 Excel 纯解析）——它们用 DeepSeek 文本模型（当前 `.env` 的 `DEEPSEEK_MODEL="deepseek-v4-flash"`，代码默认 `deepseek-chat`）或 Ark 视觉模型（封面拆解），**均不产生语音识别调用**。
6. **Express 与 Vercel 两套入口的 ASR 代码路径完全同构**（共用 `goldThreeSecondTranscripts.js` / `providers.js` / `transcriptStore.js`）；真正的差异在**部署环境变量来源**（Docker 用 `deploy/app.env`，Vercel 用控制台 env，仓库内看不到）与**部署版本**，而不是代码逻辑。**Vercel 生产 env 待核实**。

---

## 1. 机制总览（读懂主表所需）

### 1.1 gold 链的默认来源

- 路由把请求交给 `transcribeTargets()`（`apps/server/api/_lib/goldThreeSecondTranscripts.js:179`）；
- 它给 `transcribeVideo()` **显式**传入 `providers: config.goldTranscriptProviders`（`goldThreeSecondTranscripts.js:253-256`），
  `transcribeVideo` 见到显式链就**关掉**「有 TikHub 就跳过本地 ffmpeg」的隐式优化（`providers.js:2164-2170`）；
- gold 链的默认值在 `config.js:181`：
  `["doubao-file", "doubao-video", "tikhub-music", "tikhub-ffmpeg", "ffmpeg"]`。
- ⚠️ `config.js:171-180` 的注释仍写「默认把本地 ffmpeg 排在第一位」，与同函数 `:181` 的实际默认值矛盾（历史注释未更新，见 §7.3-④）。

### 1.2 全局链的默认来源与 env 覆盖

- 员工二创路由直接调 `transcribeVideo(video, config, …)`，**不传 providers**（`apps/server/api/_lib/contentAgent/index.js:272-275`），
  因此使用 `config.transcriptProviders`（`providers.js:2167-2170`）；
- 该值由 `getTranscriptProviders()` 计算（`config.js:47-69`）：
  1. 读 `TRANSCRIPT_PROVIDERS`（默认 `["doubao-file","ffmpeg","doubao-video"]`，`:57`）；
  2. 白名单过滤（`:51`，认不出的 provider 被静默丢弃）；
  3. 若链里有 `ffmpeg` 且 `TIKHUB_TRANSCRIPT_PROVIDER_ENABLED != false`，把 `tikhub-ffmpeg` unshift 到链首（`:61-63`）；
  4. 若链里有 `tikhub-ffmpeg` 且 `TIKHUB_MUSIC_PROVIDER_ENABLED != false`，再把 `tikhub-music` unshift 到最前（`:64-67`）。
- 当前仓库内两套 env 都设了 `TRANSCRIPT_PROVIDERS="ffmpeg,doubao-video"`（`apps/server/.env:18`；`.deploy/app.env:16`），
  `TIKHUB_*_PROVIDER_ENABLED` 未显式关闭（`.env:36` 仅 `TIKHUB_MUSIC_PROVIDER_ENABLED="true"`），所以实际全局链 =
  **`tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`**（无 `doubao-file`）。
- 若某个环境**完全没设** `TRANSCRIPT_PROVIDERS`，代码默认全局链会是
  `tikhub-music → tikhub-ffmpeg → doubao-file → ffmpeg → doubao-video`（`doubao-file` 落在中间，见 §5）。

### 1.3 五个 provider 对应的上游模型 / resource id

| provider id | 上游接口 | 模型 / resource id（默认值） | 代码证据 |
|---|---|---|---|
| `doubao-file` | 豆包**录音文件识别 2.0**：submit → 轮询 query（只收音频 URL） | `X-Api-Resource-Id: volc.seedasr.auc`（`DOUBAO_FILE_ASR_RESOURCE_ID` 未配置时） | `providers.js:719-853`（`:734` 写 resource id）、`config.js:151-157` |
| `tikhub-music` | 下载 `music.play_url` 的 mp3 → base64 → flash 同步 ASR | `volc.bigasr.auc_turbo` | `providers.js:2292-2337`、`:945-1056` |
| `tikhub-ffmpeg` | TikHub 服务端抽音频 → base64 → flash 同步 ASR | `volc.bigasr.auc_turbo` | `providers.js:2338-2390`、`:945-1056` |
| `ffmpeg` | 本地 ffmpeg 抽音频（支持 `-t` / `-sseof` 裁剪）→ base64 → flash 同步 ASR | `volc.bigasr.auc_turbo` | `providers.js:2391-2443`、`:945-1056` |
| `doubao-video` | 火山方舟 Ark `chat/completions` 多模态**视频理解**（不是 ASR） | `doubao-seed-2-0-mini-260428` | `providers.js:2053-2088`（`:2065` model）、`config.js:158-161` |

> flash 的 resource id 在 `providers.js:593-598`（`buildDoubaoAsrHeaders`）统一写入，默认 `volc.bigasr.auc_turbo` 见 `config.js:138`；
> flash 端点默认 `/api/v3/auc/bigmodel/recognize/flash`（`config.js:132-134`）。

### 1.4 scope 与两层缓存

- **scope 三种**（`apps/server/api/_lib/transcriptStore.js:25-29`）：`head`（2.2）、`tail`（2.3）、`script`（2.4 完整脚本）；1.2 用 head + tail。
- **Mongo 持久缓存**：集合 `gold_three_second_transcripts`，唯一索引 `{managerId, videoId, scope}`（`transcriptStore.js:71-90, 117`）。
  - 成功的才被 `getTranscripts` 读回（`transcriptStore.js:140-155`）；**失败的也会写一条 `status=failed`**，所以默认不会自动重试（`transcriptStore.js:108-137, 163-185`）。
  - `ownerId` = 当前登录用户的 id：2.2/2.3/1.2 是项目经理；2.4 是当前员工/经理（`benchmark-topic-refresh.ts:48-51, 84, 99`）。
  - 1.2 的 head/tail 与 2.2/2.3 的缓存**同库同 scope**，同经理同视频会直接命中、不再花钱（`benchmark-profile.ts:56-58, 112-120`）。
- **进程内缓存**（只在同实例有效，见 `providers.js`）：
  - `transcriptCache`：key = `${awemeId || videoUrl || shareLink}::${clipMode}`，TTL `AGENT_TRANSCRIPT_CACHE_TTL_MS`（默认 1h），见 `providers.js:49, 2148-2160`、`config.js:98`；
  - `resolveCache`：key = `${platform}::${shareLink}`，TTL 默认 30min，只缓存成功的解析，见 `providers.js:78-109, 501-591`、`config.js:99-102`。
- **二创没有 Mongo 转写缓存**：只有上面两层进程内缓存；它的「免转写」主要靠前端把选题页已提取的脚本随请求带回来（见 §3-⑤）。

### 1.5 裁剪（clip）只对本地 ffmpeg 生效

`transcribeTargets` 把 `scope` 映射成裁剪参数（`goldThreeSecondTranscripts.js:193-199`）：head → `clipSeconds`，tail → `tailSeconds`，script → 不裁剪。
但 `transcribeVideo` 的 provider 分支里，**只有 `ffmpeg` 分支把 `clipSeconds/tailSeconds` 传进音频提取**（`providers.js:2396-2420`）；
`doubao-file`（`:2178-2244`）、`tikhub-music`（`:2292-2337`）、`tikhub-ffmpeg`（`:2338-2390`）、`doubao-video`（`:2444-2464`）都没有使用这两个参数。
→ 在默认 gold 链下，本地 ffmpeg 排第 5，**裁剪基本轮不到**。详见 §8-①。

---

## 2. 主表：ASR 功能 → 端点 → 链 → 模型 → 条数 → 缓存

> 「实际生效链」写的是：**仓库内 `apps/server/.env` 与 `.deploy/app.env` 当前内容**代入代码后的结果。
> 云端 Vercel 控制台 env 无法从仓库核实 → 见 §7、§8。

| # | 功能（用户视角） | 端点（生产 Express / Vercel api） | 调用方式 | provider 链来源 | 当前实际生效链顺序 | 会命中的模型 / resource id | 转写条数 · scope · clip | 缓存 |
|---|---|---|---|---|---|---|---|---|
| ① | **2.2 黄金三秒库分析**（账号定位 → 选题库构建 → 2.2，经理） | Express `POST /api/agent/gold-three-seconds`（`apps/server/src/index.js:424`）<br>Vercel `api/agent/gold-three-seconds.ts:29` | `transcribeTargets({scope:"head", clipSeconds:5})`（`gold-three-seconds.ts:60-74`） | **gold 链**（`config.goldTranscriptProviders`） | `doubao-file → doubao-video → tikhub-music → tikhub-ffmpeg → ffmpeg` | 1) Seed：`volc.seedasr.auc`<br>2) Ark：`doubao-seed-2-0-mini-260428`<br>3) flash：`volc.bigasr.auc_turbo` | 最多 60 条（`GOLD_TRANSCRIPT_LIMIT` 默认 60，`config.js:185`）；`scope=head`；`clipSeconds=5`（`config.js:170`） | Mongo `gold_three_second_transcripts`，`scope=head`；进程内 `transcriptCache`/`resolveCache` |
| ② | **2.3 结尾钩子库分析**（模块 3 子步骤 2.3，经理） | Express `POST /api/agent/ending-hooks`（`src/index.js:616`）<br>Vercel `api/agent/ending-hooks.ts:28` | `transcribeTargets({scope:"tail", clipSeconds:5})`（`ending-hooks.ts:58-71`） | **gold 链** | 同 ① | 同 ①（顺序同上） | 最多 60 条；`scope=tail`；`clipSeconds=5`（`:65`） | Mongo `scope=tail`；进程内同上 |
| ③ | **1.2 对标账号分析**（模块 1 对标账号分析，经理） | Express `POST /api/agent/benchmark-profile`（`src/index.js:773`）<br>Vercel `api/agent/benchmark-profile.ts:32` | 转写阶段 `transcribeTargets({scope: "head" 或 "tail", clipSeconds:5})`（`benchmark-profile.ts:60-84`）；前端先 head 再 tail（`BenchmarkProfileStage.tsx:803, 811`） | **gold 链** | 同 ① | 同 ① | 只转**前 20 条**（`PROFILE_SAMPLE_LIMIT=20`，`benchmarkProfile.js:61`；`benchmark-profile.ts:57`）；head + tail 两个 scope 各一轮（每请求批 30，实际一轮跑完）；clip=5s | Mongo `scope=head`/`tail`，**与 2.2/2.3 共用**（同经理同视频直接命中） |
| ④ | **2.4 正式选题库与更新筛选**（用户界面叫「今日选题/选题生成与选择」，含**近 7 天完整脚本提取**） | Express `POST /api/agent/benchmark-topic-refresh`（`src/index.js:288`）<br>Vercel `api/agent/benchmark-topic-refresh.ts:44` | `transcribeTargets({scope:"script", clipSeconds:0})`（`benchmark-topic-refresh.ts:89-100`）；前端逐条驱动、每条一个请求（`topicContentAnalysis.ts:110-122`） | **gold 链** | 同 ① | 同 ①（完整脚本场景通常由 Seed 命中） | 前端传入的 ≤7 天视频（后端上限 60，`benchmarkTopicRefresh.js:21`）；`scope=script`；**不裁剪**；前端并行 3 条（`topicAnalysisPipeline.ts:33`），单条最多 10 轮（`:72`） | Mongo `scope=script`（按当前用户 id）；进程内同上 |
| ⑤ | **内容生成与确认 / 员工二创**（模块 3 下游，员工+经理） | Express `POST /api/agent/workflow/stream-run`（`src/index.js:2148`）<br>Vercel `api/agent/workflow/stream-run.ts:11` | `transcribeVideo(video, config, …)`，**不传 providers**（`contentAgent/index.js:272-275`） | **全局链**（`config.transcriptProviders`） | 当前 env：`tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`<br>（若 env 不设 `TRANSCRIPT_PROVIDERS`，代码默认会多一个 `doubao-file` 在 `tikhub-ffmpeg` 之后，见 §5） | 当前 env 下：flash `volc.bigasr.auc_turbo`（前 3 个）+ Ark `doubao-seed-2-0-mini-260428`（兜底）；**不含 Seed** | **只在没有「选题页已提取脚本」时转写**；每请求≤5 条（`config.js:79`），前端每请求只发 1 条（`ContentPage.tsx:1632` 的 `MAX_INPUTS_PER_BATCH=1`）；完整转写、**不裁剪** | **无 Mongo 缓存**；只有进程内 `transcriptCache`（TTL 1h）与 `resolveCache`（30min）；已带脚本时**整段跳过 resolve+transcribe**（`contentAgent/index.js:215-247`） |

### 2.1 补充：批量 / 并发 / 预算 / 权限明细

| 功能 | 权限 | 单请求批大小 | 服务端并发 | 单请求预算上限 | 端点 maxDuration | 前端循环上限 |
|---|---|---|---|---|---|---|
| 2.2 黄金三秒 | 经理（`gold-three-seconds.ts:31`；Express `src/index.js:425`） | 30（`GOLD_TRANSCRIPT_BATCH_SIZE`，`config.js:193`） | 3（`:194`）+ 解析预取 8（`:198`） | 240s（`:201`） | 300s（`gold-three-seconds.ts:14-16`） | 前端驱动至 `finished`（`GoldThreeSecondsStage.tsx:317`） |
| 2.3 结尾钩子 | 经理 | 30 | 3 + 8 | 240s | 300s | 同上（`EndingHooksStage.tsx:319`） |
| 1.2 对标账号 | 经理（`benchmark-profile.ts:34`；Express `:774`） | 30（对 20 条样本即一轮跑完） | 3 + 8 | 240s | 300s | head 一轮 + tail 一轮（`BenchmarkProfileStage.tsx:803, 811`） |
| 2.4 选题刷新/脚本提取 | 登录即可（`benchmark-topic-refresh.ts:50-51`；Express `:291`） | 30（但前端每条 1 个请求，实际 1） | 3 + 8（单条时形同串行） | 240s | 300s | 单条 ≤10 轮（`topicAnalysisPipeline.ts:72`） |
| 员工二创 | 登录即可（`stream-run.ts:15`；Express 由全局 `/api` 登录中间件兜底 `src/index.js:214-218`，无额外角色判断） | ≤5 链接/工作流请求；前端 1 条/请求 | 按视频串行（`contentAgent/index.js:203` 的 for 循环） | 无转写预算守卫 | 300s（`vercel.json` 的 `api/agent/workflow/stream-run.ts`） | 前端逐批提交 |

> 预算/批次参数见 `config.js:170-201`；Vercel 函数时长见 `apps/server/vercel.json`（2.2/2.3/1.2/2.4/二创 均为 300s）。

---

## 3. 逐功能补充说明（含证据与失败回退）

### ① 2.2 黄金三秒库分析
- 样本 = 分类报告按点赞/发布时间排序后的前 N 条，N=`GOLD_TRANSCRIPT_LIMIT`（默认 60）；`selectTranscriptTargets` 见 `goldThreeSecondTranscripts.js:34-59`。
- 转写目标：视频**开头**几秒，落 `scope=head`；分析阶段再由 DeepSeek 读回这些 head 转写（`gold-three-seconds.ts:100-106, 112`）。
- 单条失败不影响整批，只退回发布文案（`goldThreeSecondTranscripts.js:284-296`）。
- **注意**：默认链第一个 `doubao-file` 忽略 `clipSeconds`，所以实际可能拿到整条转写；head 和 tail 会各调一次 Seed（见 §8-①）。

### ② 2.3 结尾钩子库分析
- 与 2.2 同构，唯一区别是 `scope=tail`（`ending-hooks.ts:66`；`goldThreeSecondTranscripts.js:9-12` 的注释说明了 head/tail 必须分开）。
- 分析阶段读 `scope=tail` 的转写（`ending-hooks.ts:101-103`）。

### ③ 1.2 对标账号分析
- 只转**点赞最高的前 20 条**（`PROFILE_SAMPLE_LIMIT=20`，`benchmarkProfile.js:61`；`benchmark-profile.ts:57`），且需要 head + tail 两个方向（`benchmark-profile.ts:20-31, 112-120`）。
- 转写缓存与 2.2/2.3 共用：同经理、同视频、同 scope 时直接命中 Mongo，不再调用 ASR（`transcriptStore.js:140-155`）。
- 分析阶段另外读高赞评论（TikHub，非 ASR）与粉丝画像（TikHub，非 ASR）（`benchmark-profile.ts:122-135`）。

### ④ 2.4 正式选题库与更新筛选（今日选题页的「脚本提取」）
> 任务描述里写的「1.4 选题刷新」在本仓库实际编号为 **模块 3 / 2.4**（`accountPositioningModules.ts:127-140` 的步骤 `code: "2.4"`）。用户视角入口是「今日选题 / 选题生成与选择」页（`App.tsx:2078`）。
- 只有**近 7 天**窗口提取完整脚本（`topicContentRules.ts:21, 69`；`App.tsx:2090-2102`），更长时间窗口只筛点赞+打标签。
- 前端逐条驱动：每条视频单独发 `phase=transcribe`（`topicContentAnalysis.ts:110-122`），后端固定 `scope=script`、`clipSeconds=0`（`benchmark-topic-refresh.ts:96-98`），因此拿到的是**整条脚本**。
- 转写结果按当前用户 id 落 Mongo `scope=script`（`benchmark-topic-refresh.ts:84, 99`），下次进入/换窗口秒开；打标签的 analyze 阶段只读缓存，不再转写（`:124-126`）。
- 该脚本随后被「内容生成页/二创」复用：前端把 `benchmark_videos[].script` 传回（`ContentPage.tsx:1701-1728`），后端 `getExtractedScriptsFromBody` 解析后**跳过 resolve+transcribe**（`adapter.js:44-74`；`contentAgent/index.js:215-247, 368`）。

### ⑤ 内容生成与确认 / 员工二创
- 只有「没有已提取脚本」的条目才会真转写：手贴链接、视频号没拿到媒体、或选题页脚本提取失败/超窗口（`contentAgent/index.js:215-247`）。
- 转写的是**完整口播**，不裁剪（`transcribeVideo` 调用未传 clip 参数，`contentAgent/index.js:272-275`）。
- 转写完成后并行跑 4 个 DeepSeek 创作 Agent（`contentAgent/index.js:284-321`；`providers.js:2913`），ASR 只出现在它前面。
- 用的是**全局链**：当前 env 下为 flash×3 + Ark 视频理解兜底，不含 Seed（见 §6）。

---

## 4. 明确「不涉及 ASR」的功能与其实际模型

| 功能 | 端点（Express / Vercel） | 实际模型 / 调用 | 证据（含「不转写」的明确声明） |
|---|---|---|---|
| **2.1 对标账号分类分析** | Express `POST /api/agent/benchmark-analysis`（`src/index.js:220`）<br>Vercel `api/agent/benchmark-analysis.ts` | DeepSeek 文本（`runBenchmarkAnalysisAgent` → `callDeepSeek`） | `providers.js:3243-3248, 2505-2557`；输入是 TikHub 抓来的视频标题/发布文案，不转写 |
| **1.3 账号规划** | Express `POST /api/agent/account-plan`（`src/index.js:975`）<br>Vercel `api/agent/account-plan.ts` | DeepSeek 文本（`runAccountPlanAgent`） | `providers.js:3349-3363`；`account-plan.ts:13-22` 明确写「**不抓视频、不转写**」 |
| **3.1 封面 / 3.2 发布文案 / 3.3 标签**（发布仓） | Express `POST /api/agent/publish`（`src/index.js:1416`）<br>Vercel `api/agent/publish.ts` | 3.1 封面基底拆解：Ark **图片理解** `doubao-seed-2-0-mini-260428`（`providers.js:2101-2139`；`publishAgents.js:190`）<br>3.1 出图：第三方图片模型（`XXCAPI_IMAGE_MODEL` 等，`imageProvider.js:120`）<br>3.2/3.3/其余 phase：DeepSeek `runJsonAgent`（`publishAgents.js:116,135,148,205`） | `publish.ts:9-18`；`PUBLISH_PHASES` 见 `publishAgentRunner.js:197`。**全链路无 ASR**；注意 3.1 的视觉调用与 `doubao-video` 共用同一个 `DOUBAO_VIDEO_MODEL`，但它是**图片**不是语音 |
| **4.1 视频数据分析（单条复盘）** | Express `POST /api/agent/video-analysis`（`src/index.js:1165`）<br>Vercel `api/agent/video-analysis.ts:24` | DeepSeek 文本（`runVideoAnalysisSuggestionAgent` → `runJsonAgent`）；指标判定由后端确定性实算 | `video-analysis.ts:11-22` 明确写「这条链路**不抓取、不转写**」；`reviewAgentRunner.js:121`；`reviewAgents.js` 只调 `runJsonAgent` |
| **4.2 账号数据分析（周度）** | Express `ALL /api/review/weekly`（`src/index.js:1259-1266`）<br>Vercel `api/review/weekly.ts` | DeepSeek 文本 ×2（补标签 + 写周报建议，`runJsonAgent`） | `weeklyAgentRunner.js:8, 30, 49`；周报的「文案」来自用户填表/Excel 行（`r.script`），**没有 ASR** |
| **Excel 解析（不复盘表格识别）** | Express `POST /api/review/workbook`（`src/index.js:1137`）<br>Vercel `api/review/workbook.ts:20` | **不调模型**（纯后端解析 + 建议列映射） | `review/workbook.ts:9-19` 注释「不落库、不调模型」 |
| **Excel / 复盘表格 AI 识别** | Express `ALL /api/review/workbook-recognition`（`src/index.js:1157`，**未提交改动**）<br>Vercel `api/review/workbook-recognition.ts:5` | DeepSeek **JSON 模式**（`runJsonAgent`，`interfaceName: deepseek:review-workbook-recognition`）；AI 只定位字段位置，**数值由后端从原始单元格读取** | `reviewWorkbookRecognition.js:83-104`（`:99-103` 调模型）、`:30-81`（后端读原表）；DeepSeek JSON 模式见 `providers.js:2518-2520, 2565-2582` |
| **1.2/2.2/2.3/2.4 的 analyze 阶段**（报告生成） | 同上各端点 phase=analyze | DeepSeek 文本（`runGoldThreeSecondsAgent` / `runEndingHooksAgent` / `runBenchmarkTopicRefreshAgent` / `runBenchmarkProfileAgent`） | `providers.js:3249-3348`；它们只**读取**已转写文本，不触发 ASR |
| **翻译 / 改写 Agent** | `/api/agent/translation`、`/api/agent/rewrite` | DeepSeek 文本 | `providers.js:3099-3115`（translation）、`3116-3157`（rewrite） |
| **评论抓取 / 粉丝画像** | `/api/tikhub/comments`、`/api/tikhub/fans-portrait`（含 Express 同名路由） | TikHub 数据接口，无 LLM/ASR | `videoComments.js:251` 只是「与转写同构的并发/预算」注释，不是 ASR；`tikhub/*.ts` 无转写调用 |
| **客户/任务/报告存取、导出飞书、发布仓 CRUD** | 其余路由 | 无模型 | — |

> 当前生效的 DeepSeek 模型：本地 `.env` 为 `DEEPSEEK_MODEL="deepseek-v4-flash"`（`apps/server/.env`），代码默认 `deepseek-chat`（`config.js:212-214`）；以调用处 `config.deepseekModel` 为准（`providers.js:2510`）。

---

## 5. 可能产生 `volc.seedasr.auc`（Seed 2.0）调用的功能

**判定依据 = 链顺序 + env 是否覆盖**：只有 `doubao-file` 这个 provider 会调用 Seed 录音文件识别 2.0（`providers.js:719-853`，resource id 默认 `volc.seedasr.auc`，`config.js:153`）。

按当前仓库 env（**`GOLD_TRANSCRIPT_PROVIDERS` 未设置** → 用代码默认 gold 链，`doubao-file` 排第一）：

| 功能 | 是否会调用 Seed | 依据 / 触发条件 |
|---|---|---|
| **2.2 黄金三秒库分析** | ✅ 会（默认路径） | gold 链首位 `doubao-file`（`config.js:181`）；每个视频只要有可公网抓取的音源（抖音/TikTok 经 TikHub 解析出 `musicUrl`/`videoUrl`）就会先走 Seed（`providers.js:2178-2188, 680-695`）。最多 60 条/轮，`scope=head` |
| **2.3 结尾钩子库分析** | ✅ 会（默认路径） | 同上，`scope=tail`；**同一视频可能被 Seed 再转一遍**（head/tail 是两个 scope，各自不走对方缓存） |
| **1.2 对标账号分析** | ✅ 会（默认路径，但有缓存可省） | 前 20 条 head+tail 两轮（`benchmark-profile.ts:57, 60-84`）；若 2.2/2.3 已转写同视频同 scope，则命中 Mongo 缓存、不再调用 |
| **2.4 正式选题库与更新筛选**（今日选题页近 7 天脚本提取） | ✅ 会（默认路径，且是**日常高频入口**） | 每条新视频一个 transcribe 请求、`scope=script`（`benchmark-topic-refresh.ts:89-100`）；员工每天都在用（登录即可，`requireAuth`），是 Seed 调用量最可能最大的一项 |
| **内容生成与确认 / 员工二创** | ⚠️ **当前 env 下不会**；env 变化时可能 | 全局链当前为 `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`（无 `doubao-file`，见 §1.2）。若某环境**没设** `TRANSCRIPT_PROVIDERS`（回落到代码默认）或把它设成含 `doubao-file`，则 Seed 会作为第 3 个 provider 被调用（`config.js:57, 60, 181`） |

**什么时候会 fallback 到别的模型（即 Seed 失败/超时后才可能出现 flash/Ark）**：
- `doubao-file` 的已知失败路径：没有可直接抓取的 http 音源 → 直接 skip（`providers.js:2180-2187`）；submit 报错 → 失败（`:762-770`）；**query 超预算**（默认 `DOUBAO_FILE_ASR_BUDGET_MS=120s`，`:774-789`；官方口径异步任务通常 3 小时内完成，延迟不可控）；空文本（`:825-831`）。任一失败 → 链上继续下一个 `doubao-video`。
- 因此「Seed 失败 → Ark 视频理解」是最常见的回退；「Seed + Ark 都失败 → flash」才会出现 `volc.bigasr.auc_turbo`。
- **视频号（WeChat Channels）**：媒体是 Isaac64 加密的 CDN 流，HANDOFF 明确写「视频号用不了 doubao-file」（`HANDOFF.md:579, 640`），但**当前代码没有按平台过滤** `doubao-file`（`pickDoubaoFileAudioSources` 只看是不是 http URL，`providers.js:680-695`；视频号 meta 的 `videoUrl` 就是加密的 `mediaUrl`，`providers.js:282-317`）→ 视频号会先拿加密 URL 去 submit 一次 Seed，然后大概率失败回退。**这类失败请求是否计费需以火山账单口径为准（待 Lead 核实）**。
- 同一视频内部还可能产生**两个 Seed 任务**：多音源重试（`music.play_url` mp3 → 视频 m4a，`providers.js:855-943, 2202`）。

---

## 6. 使用 `volc.bigasr.auc_turbo`（flash 1.0）的功能

**判定依据**：`tikhub-music` / `tikhub-ffmpeg` / `ffmpeg` 三个 provider 内部都调用 `recognizeDoubaoAudio`（flash 同步接口），默认 `X-Api-Resource-Id: volc.bigasr.auc_turbo`（`providers.js:593-598, 945-1056`；`config.js:132-138`）。

| 功能 | 使用 flash 的路径 | 依据 |
|---|---|---|
| **内容生成与确认 / 员工二创** | **主路径**：全局链 `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video` 的前 3 个全是 flash；只有三者都失败才会落到 Ark 视频理解（不是 ASR） | `providers.js:2292-2443`（三个分支均调 `recognizeDoubaoAudio`）；`config.js:57-69`；`apps/server/.env:18`、`.deploy/app.env:16` |
| **2.2 / 2.3 / 1.2 / 2.4** | **兜底路径**：gold 链第 3~5 位是 `tikhub-music` / `tikhub-ffmpeg` / `ffmpeg`。只有 `doubao-file`（Seed）与 `doubao-video`（Ark）都失败/跳过时，才会走到 flash。<br>典型场景：① Seed 超时/失败；② 视频号（Ark 无法消费本地解密流会主动抛错，`providers.js:2446-2450`），于是通常回退到本地 `ffmpeg` 的 flash | `config.js:181`；`providers.js:2174-2488` 的循环顺序 |
| **任意把 `GOLD_TRANSCRIPT_PROVIDERS` 显式设成 `ffmpeg,...` 的环境** | 变成主路径 | `.env.example:66` 里的示例值就是 `ffmpeg,tikhub-music,tikhub-ffmpeg,doubao-video`（**与代码默认不同**，见 §7.3-①） |
| **把全局链设成不含 `doubao-file` 的环境**（当前仓库 env 即如此） | 员工二创稳定走 flash | `.env:18` / `.deploy/app.env:16`；`config.js:57-69` |

> 补充：flash 分支内部还有「TikHub 音频格式 mp3→wav 回退」（`providers.js:2338-2390`，`tikhubAudioFormatAttempts` 见 `:1623-1631`）与 `recognizeDoubaoAudio` 自身的状态码重试（`:959-1025`），**同一条视频可能对 flash 发起多次请求**；与 Seed 的计费叠加方式需以账单为准（待 Lead 核实）。

---

## 7. 同一功能在「Express vs Vercel」两个入口的差异

### 7.1 结论：ASR 代码路径无差异
- 2.2/2.3/1.2/2.4 两套入口都调用**同一份** `transcribeTargets`（`goldThreeSecondTranscripts.js`）→ 同一份 `transcribeVideo`（`providers.js`）→ 同一份 `transcriptStore`，参数逐项一致：
  - Express：`src/index.js:455-469`（2.2）、`:646-658`（2.3）、`:810-822`（1.2）、`:339-349`（2.4）；
  - Vercel：`api/agent/gold-three-seconds.ts:60-74`、`ending-hooks.ts:58-71`、`benchmark-profile.ts:71-84`、`benchmark-topic-refresh.ts:89-100`。
- 员工二创两套入口同样都走 `runContentAgentWorkflow`（Express `src/index.js:2148-2170`；Vercel `api/agent/workflow/stream-run.ts:11-31`），转写调用点只有 `contentAgent/index.js:272`。
- 权限差异只是写法不同（Express 内联判断角色 → Vercel `requireManager`），语义一致。
- 时长差异：Vercel 函数有 `maxDuration`（相关端点为 300s，见 `apps/server/vercel.json`），Express 常驻进程无此限制；但业务层预算 `GOLD_TRANSCRIPT_BUDGET_MS=240s` 两边相同（`config.js:201`）。

### 7.2 真正的不一致风险：**部署环境变量来源不同**
| 入口 | 环境变量来源 | 仓库内能否核实 | 影响 |
|---|---|---|---|
| 生产 Express（Docker，腾讯云 CVM） | `deploy/compose.yml:19` 的 `env_file: app.env`（部署机上的 `app.env`，仓库内快照对应 `.deploy/app.env`） | 部分能（仓库内快照 `.deploy/app.env`；部署机真实文件待 task-3/Lead 核实，`docs/DEPLOY.md:13-14` 称正式 `app.env` 保持不变。**task-3 的 `docs/asr-audit/config-and-history.md` §0 已用回滚包比对确认该结论，以该文为准**） | `TRANSCRIPT_PROVIDERS="ffmpeg,doubao-video"`；无 `GOLD_TRANSCRIPT_PROVIDERS` → gold 链=代码默认（Seed 第一） |
| 本地开发 Express | `dotenv` 依次加载 `apps/server/.env`，再用 `apps/server/src/.env` 覆盖（`src/index.js:90-96`）；`apps/server/src/.env` 实际不存在（只有 `.env.example`） | 能（`apps/server/.env`） | 同上，与部署 env 内容一致（都是 `ffmpeg,doubao-video`） |
| Vercel | Vercel 项目控制台 env（仓库内无 `.env` 被 Vercel 读取） | **不能** | 若控制台设置了 `GOLD_TRANSCRIPT_PROVIDERS` / `TRANSCRIPT_PROVIDERS`，同一功能在两个入口会走不同的链/模型。**待 Lead 核实** |
| 生产部署版本 | `docs/DEPLOY.md:3-6`：2026-10-14 按当前工作区构建部署到腾讯云；ASR 相关代码最后改动为 9-28（`config.js` / `providers.js` / `goldThreeSecondTranscripts.js` 的 mtime） | 部分能 | 生产 Express 大概率包含“gold 链默认 Seed 第一”的版本；Vercel 部署是否同步更新未知 → **待核实** |

### 7.3 仓库内配置/文档不一致（会直接改变“实际生效链”）
1. **`GOLD_TRANSCRIPT_PROVIDERS`**
   - 代码默认：`doubao-file, doubao-video, tikhub-music, tikhub-ffmpeg, ffmpeg`（`config.js:181`）；
   - `.env.example:66`：`ffmpeg,tikhub-music,tikhub-ffmpeg,doubao-video`（无 `doubao-file`，ffmpeg 第一）；
   - `.env` / `.deploy/app.env`：**未设置** → 用代码默认；
   - `HANDOFF.md:2797-2802`：文档写「黄金三秒链路 = ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video」（旧口径，已与代码默认相反）。
   → 结论：**文档/示例滞后于代码；如果谁把 `.env.example` 的示例复制成真实 env，gold 链会瞬间从 Seed 切回 flash（且裁剪恢复生效）**。
2. **`TRANSCRIPT_PROVIDERS`**
   - 代码默认（未设置时）：`doubao-file, ffmpeg, doubao-video` + 自动补 TikHub → `tikhub-music, tikhub-ffmpeg, doubao-file, ffmpeg, doubao-video`（`config.js:57-68`）；
   - `.env` / `.deploy/app.env`：`ffmpeg,doubao-video` → `tikhub-music, tikhub-ffmpeg, ffmpeg, doubao-video`（**无 Seed**）；
   - `.env.example:104`：`ffmpeg,doubao-video`（与仓库 env 一致；但少了代码默认里的 `doubao-file`）。
3. **`apps/server/src/.env.example`** 仍是一份**旧的、只有基础 ASR 变量的副本**（`apps/server/src/.env.example:8-16`，没有 `GOLD_TRANSCRIPT_*` / `DOUBAO_FILE_ASR_*`）；而 `src/index.js:93-96` 会用 `apps/server/src/.env` **覆盖** `apps/server/.env` 的同名变量 → 本地若有人建了这个文件，链会被静默改掉（当前不存在，但属于结构性隐患）。
4. **代码注释与默认值矛盾**：`config.js:171-180` 说「黄金三秒默认把本地 ffmpeg 排在第一位」，实际 `:181` 首位是 `doubao-file`；`HANDOFF.md:2822-2828` 的「裁剪只在本地 ffmpeg 生效、所以黄金三秒把 ffmpeg 排第一」推理在当前默认值下**不再成立**。
5. **视频号能否用 `doubao-file`**：`HANDOFF.md:579, 640` 明确「视频号用不了 doubao-file」，但当前代码没有平台过滤（`providers.js:680-695` + `:2178-2188`），gold 链会先尝试 Seed。属于「文档假设 vs 代码行为」不一致（是否预期待 Lead 核实）。
6. **4.2 / Excel AI 识别的 Express 路由是未提交改动**：`src/index.js:1157-1163, 1259-1266` 只存在于工作树（HEAD 没有）；Vercel 侧对应文件 `api/review/weekly.ts`、`api/review/workbook-recognition.ts` 也处于未跟踪状态。`docs/DEPLOY.md:13-14` 说明 10-14 生产是按当时工作区构建的，因此生产可能有这些路由；**但这两条功能本身不涉及 ASR**，只是“入口一致性”备注。

---

## 8. 缓存/口径风险（需要 Lead 知道的副作用）

### ① 默认 gold 链让「开头/结尾裁剪」失效（最值得核实）
- 意图：2.2/2.3/1.2 只转**开头/结尾 5 秒**（`config.js:170` 注释；`goldThreeSecondTranscripts.js:193-199`；`HANDOFF.md:2822-2828`）。
- 实际：只有 `ffmpeg` provider 实现裁剪（`providers.js:2396-2420`）；默认链第一位是 `doubao-file`，它把整条音频 URL 交给 Seed（`providers.js:2178-2244`），**不接受 clip 参数**。
- 后果：
  1. 2.2/2.3 拿到的“head/tail 转写”其实是**整条音频**（存入对应 scope），后续分析会把整篇文案当“开场文案/结尾文案”；
  2. 同一视频 head、tail 各调一次 Seed（两个 scope 不共享缓存）→ **同一音频可能被 Seed 转两遍**；
  3. 视频号在 Seed 失败后回退到本地 ffmpeg，此时裁剪才生效（路径不一致）。
- 状态：**待 Lead 核实**这是否是预期；如果不是，可选方向：① 显式设 `GOLD_TRANSCRIPT_PROVIDERS=ffmpeg,...` 恢复 ffmpeg 优先（会同时把 gold 链切回 flash）；② 给 `doubao-file` 增加裁剪能力（该接口只收音频 URL，需要先有可公网访问的短音频 URL，工程量不小）；③ 接受完整转写、调整 2.2/2.3 的分析口径。本报告不改代码。

### ② 缓存混用与「失败也缓存」
- Mongo 缓存按 `(managerId, videoId, scope)` 唯一（`transcriptStore.js:71-90`），但**同 scope 内的内容口径可能不同**：如果某视频先走了 ffmpeg（5 秒）再走 Seed（整条），后写入会 upsert 覆盖（`transcriptStore.js:108-137`）——同一条“head 转写”可能是 5 秒也可能是整条。
- 失败记录也落库（`status=failed`），`getTranscriptProgress` 把失败当“已尝试”（`transcriptStore.js:157-185`）→ 要重试必须清缓存（`clearTranscripts`，`:188-194`）。
- 进程内 `transcriptCache` 只按 `clipMode` 区分（`providers.js:2148-2151`），**不区分 provider 链**：同一实例内改了链/配置，旧缓存仍会命中（TTL 1h）——排查“为什么改了配置没生效”时要先想到它。

### ③ 2.4 的缓存归 owner 所有
- 2.4 的 `scope=script` 缓存按**当前用户 id** 存（`benchmark-topic-refresh.ts:48-51, 84, 99`）。员工 A 提取的脚本不会被员工 B 或经理复用 → 同一批视频多人使用会各转一遍（成本翻倍，且都走 gold 链）。是否需要改为客户级共享，**产品决策，待 Lead 核实**。

---

## 9. 待 Lead 核实清单

1. **生产 Vercel 项目的 env**（`TRANSCRIPT_PROVIDERS` / `GOLD_TRANSCRIPT_PROVIDERS` / `DOUBAO_FILE_ASR_*`）是否与仓库 `.env.example` 或 `.deploy/app.env` 一致；若不一致，Vercel 入口的实际链会不同。
2. **生产 Express 容器的实际 `app.env`** 是否等于 `.deploy/app.env`（尤其 `GOLD_TRANSCRIPT_PROVIDERS` 是否被运维额外设置）。
3. **gold 链默认 `doubao-file` 第一是否为有意的产品决策**（尤其是它导致的“裁剪失效 / head-tail 各转一次”）——这是当前账单最可能的主要组成。
4. **视频号加密 URL 被提交到 Seed 是否计费**（代码会尝试，见 §5）。
5. 2.4 脚本缓存是否应按客户共享（当前按用户）。
6. 生产 Vercel 是否与 10-14 的腾讯云部署同版本（`docs/DEPLOY.md` 只记录了 CVM 部署）。

---

## 10. 证据索引（本报告引用的关键位置）

| 结论 | 文件:行 |
|---|---|
| gold 链默认值（Seed 第一） | `apps/server/api/_lib/contentAgent/config.js:181` |
| 全局链默认值 / TikHub 自动补位 | `apps/server/api/_lib/contentAgent/config.js:47-69, 57, 61-67` |
| flash resource id 默认 `volc.bigasr.auc_turbo` | `apps/server/api/_lib/contentAgent/config.js:132-138`；`providers.js:593-598, 945-1056` |
| file ASR resource id 默认 `volc.seedasr.auc` | `apps/server/api/_lib/contentAgent/config.js:151-157`；`providers.js:719-853`（:734） |
| doubao-video 模型默认 `doubao-seed-2-0-mini-260428` | `apps/server/api/_lib/contentAgent/config.js:158-161`；`providers.js:2053-2088`（:2065）；图片同模型 `:2101-2139` |
| 批量/并发/预算/clip 参数 | `apps/server/api/_lib/contentAgent/config.js:170-201` |
| `transcribeTargets` 用 gold 链 + scope/clip | `apps/server/api/_lib/goldThreeSecondTranscripts.js:193-199, 253-256` |
| 只有 ffmpeg 吃裁剪 | `providers.js:2178-2244` vs `:2391-2443` |
| 进程内缓存 key/TTL | `providers.js:49, 78-109, 501-591, 2148-2160`；`config.js:98-102` |
| Mongo 缓存集合与唯一索引 | `apps/server/api/_lib/transcriptStore.js:25-29, 71-90, 108-155, 163-185` |
| 2.2 端点（Express / Vercel） | `apps/server/src/index.js:424-532`；`apps/server/api/agent/gold-three-seconds.ts:29-141` |
| 2.3 端点 | `apps/server/src/index.js:616-720`；`apps/server/api/agent/ending-hooks.ts:28-138` |
| 1.2 端点 | `apps/server/src/index.js:773-903`；`apps/server/api/agent/benchmark-profile.ts:32-186` |
| 2.4 端点 | `apps/server/src/index.js:288-423`；`apps/server/api/agent/benchmark-topic-refresh.ts:44-185` |
| 二创端点 | `apps/server/src/index.js:2148-2170`；`apps/server/api/agent/workflow/stream-run.ts:11-31` |
| 二创转写调用点 / 复用已提取脚本 | `apps/server/api/_lib/contentAgent/index.js:215-247, 272-275, 351-402`；`adapter.js:44-74` |
| 4.1 不转写 | `apps/server/api/agent/video-analysis.ts:11-22`；`reviewAgentRunner.js:121` |
| 4.2 只走 DeepSeek | `apps/server/api/_lib/weeklyAgentRunner.js:8, 30, 49`；`weeklyRoutes.js:18` |
| Excel 识别只走 DeepSeek JSON | `apps/server/api/_lib/reviewWorkbookRecognition.js:83-104`；`providers.js:2565-2582` |
| 1.3 明确不转写 | `apps/server/api/agent/account-plan.ts:13-22` |
| 当前仓库 env | `apps/server/.env:18-26, 36`；`.deploy/app.env:16-25`；`.env.example:66-68, 104-105, 132-135` |
| Docker 使用 `app.env` | `deploy/compose.yml:19` |
| 部署事实（2026-10-14，按工作区构建） | `docs/DEPLOY.md:3-6, 13-14` |
| HANDOFF 旧链/裁剪/视频号口径 | `HANDOFF.md:579, 640, 2797-2802, 2822-2828` |
| PRD 模块编号 | `docs/PRD.md:57-60`；`apps/web/src/app/accountPositioningModules.ts:55-190` |
| 前端功能入口/循环驱动 | `apps/web/src/app/reportApi.ts:129-190`；`BenchmarkProfileStage.tsx:803, 811`；`topicLibrary.ts:349, 361`；`topicContentAnalysis.ts:110-122`；`ContentPage.tsx:1670-1728`；`App.tsx:1336-1439, 2078-2102` |
