# 小芒 · 语音识别（ASR）模型调用清单

> 审计日期：2026-10-18　｜　代码基线：`main @ f9aec22` + 当前工作树（ASR 核心文件 `config.js` / `providers.js` / `goldThreeSecondTranscripts.js` / `transcriptStore.js` 与 HEAD 一致）
> 审计方式：静态读码 + `node` 动态加载 `getContentAgentConfig()` 实测各 env 的实际生效链 + 部署回滚包字节级比对。详细过程见文末附录的三份审计底稿。
> 本文只写「代码事实 / 配置事实 / 可核实事实」；账单归属中属于推断的部分均已标注。
> **2026-10-18 更新**：同日完成「录音文件识别 2.0（Seed）→ 流式/实时语音识别 2.0」迁移的代码 + 配置 + 文档落地（代码已在工作树合并：`config.js` / `providers.js` / 新增 `audioPcm.js`、`asrStreamClient.js`，尚未提交）。新增 **§0.1**；**§3 / §6 已同步更新**。迁移前的审计原始结论保留作账单追溯与回滚依据，涉及默认链的旧描述均已标注「迁移前」。**本次也更新了 `apps/server/.env.example` 与 `.deploy/app.env`，文中引用这两个文件的旧行号（§5/§7 等）属于迁移前版本，可能已漂移。**

---

## 0. 一句话答案

**项目里同时存在两条并行的语音识别链，不是一套模型：**

- **4 个「分析类」功能**（2.2 黄金三秒、2.3 结尾钩子、1.2 对标账号分析、2.4 今日选题脚本提取）走 **gold 链**，当前默认**第一位就是豆包录音文件识别 2.0（Seed）→ `volc.seedasr.auc`**；
- **员工二创 / 内容生成**走 **全局链**，当前 env 下**不含 Seed**，实际是 **豆包 flash 同步 ASR → `volc.bigasr.auc_turbo`** + 豆包视频理解兜底；
- 你账单里的 `Speech_Recognition_Seed_AUC…` 在代码里**只能对应 `doubao-file` 这条 Seed 2.0 通道**（`apps/server/api/_lib/contentAgent/providers.js:734` 是全仓唯一写 `volc.seedasr.auc` 的地方）→ 也就是上面那 4 个分析类功能。

**「模型没有统一」不是错觉，而且中间还有一次静默切换：** 提交 `f9aec22`（2026-10-09）把 gold 链的第一位从「本地 `ffmpeg`」改成了「`doubao-file`（Seed 2.0）」。在此之前（基线 `263e6a6`，2026-09-24）gold 链是 `ffmpeg` 第一，走的是 flash。该改动最晚自 **2026-10-09 首次重建部署**起就在生产（本机回滚包源码与 `f9aec22` 逐字节一致）；更早的 2026-09-28 部署源码已随服务器重装丢失，但 HANDOFF §0.9 记录那一轮已完成「ASR 换豆包录音文件识别 2.0」，所以实际切换点可能在 9 月底~10 月初之间。而生产 `deploy/app.env` **没有显式设置 `GOLD_TRANSCRIPT_PROVIDERS`**，代码默认值直接生效——这 4 个功能就从 flash 换到了 Seed，开始产生 Seed 子产品的按量计费。

> 本文不改代码、不改配置。要「统一」成哪一套（Seed 还是 flash）需要你拍板，见 §6。

**已经用生产库备份核实到「哪个功能真的调了 Seed」（见 §4.1）**：截至 2026-10-14，生产库里的 Seed 成功转写记录共 **272 条**，全部来自**同一个项目经理账号**，主要是 **1.2 对标账号分析**（6 轮 × 20 个视频、head+tail 各一遍），另有 **2.2 黄金三秒**（约 20 次）和 **2.3 结尾钩子**（约 19 次）各一轮；**2.4 今日选题脚本提取没有 Seed 记录**（唯一一条 script 记录走的是 flash），**员工二创也没有 Seed 记录**。

---

## 0.1 2026-10-18 迁移：录音文件识别 2.0 → 流式识别 2.0

> ⚠️ 本节与 §0.1.3 是**迁移后**的最新状态。§0 的「一句话答案」以及 §2 / §4 / §5 / §9 / §10 中把 `doubao-file` / `volc.seedasr.auc` 写成“默认/唯一”的描述，多数是**迁移前（2026-10-18 14:38 版）的历史审计记录**，保留它们是为了账单追溯与回滚；**当前实际链/资源以 §0.1.3 与 §3.2 为准**。

- **新资源**：`volc.seedasr.sauc.duration`（豆包**流式/实时语音识别 2.0 小时版**，WebSocket `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`）。用户有 **20 小时免费额度**；小时版按音频时长扣免费额度/计费，并发版 `volc.seedasr.sauc.concurrent` 按并发计费（不推荐）。
- **新 provider `doubao-stream`**：用 ffmpeg 把音频抽成 16k 单声道 **s16le** PCM → 通过 WebSocket **burst 全速发送**（实测 26.8 秒音频约 **2.6 秒**出最终结果，远快于实时 1x 节拍）。
- **默认链变化（2026-10-18 第二次调整后的当前状态）**：
  - gold 链：**`doubao-stream → doubao-video → doubao-file`**（`doubao-file` = 豆包录音文件识别模型 2.0 / `volc.seedasr.auc`，URL 异步 submit/query）；2.2 / 2.3 / 1.2 / 2.4 四个分析类功能走它；
  - 全局链（员工二创）：**`doubao-stream → doubao-file → doubao-video`**；
  - **默认链里不再包含任何极速版 flash provider**（`tikhub-music` / `tikhub-ffmpeg` / `ffmpeg`）。它们的代码与白名单保留，回滚时手动放回即可；
  - 显式写在链首的 `doubao-stream` / `doubao-file` 会保持链首（preferred prefix 规则，见 §3 结论 8）。
- **好处**：**主路径**不再产生录音文件识别 2.0（`volc.seedasr.auc`）的按量账单，改用有 20h 免费额度的流式 2.0；**head/tail 5 秒裁剪对 doubao-stream 有效**（内部先用 ffmpeg 抽 PCM，真的只转 5 秒；`doubao-file` 兜底路径不吃裁剪）。
- **坏处 / 代价**：20h 免费额度用完后按流式价计费；依赖 WSS 长连接（网络抖动 / 代理会影响）；单条音频要整段载入内存（16k × 2B × 秒数，1 分钟约 1.9MB）。
- **本地真实 API 端到端实测（2026-10-18）**：官方样例音频经 `transcribeVideo` 走 `doubao-stream` —— head 5 秒裁剪：**1.0 秒**返回、`duration=5000ms`、provider=`doubao-stream-asr+clip5s`；26.8 秒完整音频：**2.2 秒**返回、完整文本正确。说明 burst 全速发送确实远快于实时节拍，且 5 秒裁剪真的只按 5 秒扣额度。
- **回滚方式**：① 回到「极速版 flash 兜底」：`GOLD_TRANSCRIPT_PROVIDERS=doubao-stream,doubao-video,tikhub-music,tikhub-ffmpeg,ffmpeg`、`TRANSCRIPT_PROVIDERS=doubao-stream,ffmpeg,doubao-video`；② 回到 10-18 第一次迁移状态（2.0 首位）：`GOLD_TRANSCRIPT_PROVIDERS=doubao-file,doubao-video,doubao-stream`。flash 三个 provider 与 `DOUBAO_FILE_ASR_*` 配置都还在代码里，可随时切回。

### 0.1.1 部署步骤（2026-10-18）

> ✅ **已于 2026-10-18 16:41～16:44（北京时间）实际部署到生产**：release `20261018T1641Z`，镜像 `xiaomang-app:release-20261018T1641Z`；回滚资产 `/opt/xiaomang-rollbacks/pre-20261018T164043/`；详见 `docs/DEPLOY.md` §0。以下步骤保留作复现记录。

1. **本地**：Lead 已于 2026-10-18 14:49 更新 `apps/server/.env`（`TRANSCRIPT_PROVIDERS` / `GOLD_TRANSCRIPT_PROVIDERS` 均已改为 `doubao-stream` 优先，并加了 `DOUBAO_STREAM_ASR_*`（`:47-50`））——本地**无需额外操作**。
2. **服务器**：把本机 `.deploy/app.env` 末尾新增的 7 行（1 行注释 + 6 个键）同步进 `/opt/xiaomang/deploy/app.env`。**本机 `.deploy/app.env` 只是备份，不会自动上服务器。** 注意追加的 `TRANSCRIPT_PROVIDERS` / `GOLD_TRANSCRIPT_PROVIDERS` 会覆盖文件前面旧值（docker compose 的 `env_file` 与 dotenv 都是后出现的生效）。
3. **重建镜像并重启**（本次含代码变更——新增 `doubao-stream` provider）：`cd /opt/xiaomang/deploy && docker compose -f compose.yml -f compose.cvm.yml up -d --build`。若镜像已含新代码、仅改了 env，则用 `docker compose -f compose.yml -f compose.cvm.yml up -d` 即可（compose 会按新 env 重建容器）。
4. **验证**：`docker exec xiaomang-app-1 env | grep DOUBAO_STREAM`；再跑一次 2.2 黄金三秒，日志 `transcript.provider.success` 的 `provider` 应为 `doubao-stream-asr`。
5. **本机冒烟（可选，走真实 API）**：`cd apps/server && npm run asr:smoke -- --file /path/audio.wav --clip 5`；成功时会打印 `duration=5000`、`provider=doubao-stream-asr` 和文本，失败会打印错误码（不会打印密钥）。

### 0.1.2 录音文件极速版识别（flash / `volc.bigasr.auc_turbo`）现在还在哪些地方

> 用户 2026-10-18 问：「本项目应该没有用到录音文件极速版识别吧？」——**曾经用到，且用量很大**。它就是你贴的那份「录音文件极速版识别」文档：`POST /api/v3/auc/bigmodel/recognize/flash` + `X-Api-Resource-Id: volc.bigasr.auc_turbo`。
> **2026-10-18 第二次调整后，默认链已把三个 flash provider 全部移除**，改用「豆包录音文件识别模型 2.0」（`doubao-file` / `volc.seedasr.auc`）做兜底；flash 代码保留，仅用于回滚/手动配置。

| 项 | 事实 | 证据 |
|---|---|---|
| 代码入口 | `recognizeDoubaoAudio()`（闪存同步 ASR，base64 音频） | `providers.js`（`recognizeDoubaoAudio` 定义、`buildDoubaoAsrHeaders`）；配置默认 `apps/server/api/_lib/contentAgent/config.js:145,149` |
| 站点/资源 | `https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash`；`volc.bigasr.auc_turbo` | `config.js:145,149`；`.env:22-23`、`.env.example`、`.deploy/app.env` 都显式配置 |
| 使用它的 provider | `tikhub-music`、`tikhub-ffmpeg`、`ffmpeg`（三者抽完音频后都调 `recognizeDoubaoAudio`） | 当前工作树调用点：`providers.js:2402`、`2436`、`2510`（行号随本次新增代码后移） |
| 当前是否默认调用 | **不再默认调用**：默认链已改成 `doubao-stream → doubao-video → doubao-file`（gold）/ `doubao-stream → doubao-file → doubao-video`（全局），均不含 flash provider；只有手动把 `tikhub-music` / `tikhub-ffmpeg` / `ffmpeg` 写回链里才会调用 | `config.js:57-63`（全局默认）；`config.js` 的 `goldTranscriptProviders`；回归测试 `apps/server/tests/asr-stream-config.test.mjs` 会断言默认链不含 flash |
| 迁移前用量 | 9-28 生产库备份 296 条转写里 **295 条是 flash**；10-14 备份 442 条里 **164 条是 flash**（集中在 9-17/9-18，10-10/11 只有 3 条，因为 10-09 起 gold 链已改 Seed） | 本机两份 mongodump 备份解析结果（`backups/…20260928….archive.gz`、`.deploy/rollbacks/…20261014….archive.gz`） |
| 账单含义 | `volc.bigasr.auc_turbo` 是**另一个子产品**（与 Seed 录音 2.0 / 流式 2.0 都不是同一个 resource id）。如果控制台的 9.54h 免费额度属于「录音文件极速版」，那当前兜底路径仍会消耗它（而不是现金）；如果它也是正式版，则兜底调用会按其单价计费 | 需在控制台「用量统计/我的资源」按 resource id 核对 |

**默认已经不含 flash。** 如果将来要回滚到极速版兜底（例如 2.0 URL 也失败、需要本地 ffmpeg 兜底）：

```dotenv
GOLD_TRANSCRIPT_PROVIDERS="doubao-stream,doubao-video,tikhub-music,tikhub-ffmpeg,ffmpeg"
TRANSCRIPT_PROVIDERS="doubao-stream,ffmpeg,doubao-video"
```

代价 / 注意：
- 回滚后流式失败会再次落到 flash（`volc.bigasr.auc_turbo`）计费通道；flash 的音频抽取全在本地/TikHub，需要 `ffmpeg`/TikHub 可用。
- `DOUBAO_RESOURCE_ID` / `DOUBAO_ASR_ENDPOINT` 配置一直保留；不把三个 flash provider 写回链里，就不会发出 flash 请求。
- 验证方式：跑一次 2.2/2.4，看服务端日志 `transcript.provider.success` 的 `provider`——只有 `doubao-stream-asr*` / `doubao-file-asr`（以及兜底时的 `doubao-video`）= 没有调用 flash；出现 `ffmpeg+doubao-asr:*` / `tikhub-*+doubao-asr:*` = 调用了极速版。

---

### 0.1.3 2026-10-18 第二次调整：极速版兜底 → 录音文件识别 2.0

- **改动**：默认链中的三个极速版 flash provider（`tikhub-music` / `tikhub-ffmpeg` / `ffmpeg`）全部移出，换成已有的 `doubao-file`（豆包录音文件识别模型 2.0，`volc.seedasr.auc`，异步 submit + query，只接受公网音频 URL）。
- **当前默认链**：
  - gold 链：`doubao-stream → doubao-video → doubao-file`
  - 全局链：`doubao-stream → doubao-file → doubao-video`
  - 链首仍是流式 2.0（20h 免费额度，支持 head/tail 裁剪）；`doubao-file` 是 URL 直取的 2.0 兜底；默认链里不再有 1.0 flash。
- **为什么用 `doubao-file` 兜底，而不是把 flash provider 内部改成 2.0**：录音文件识别 2.0 **只接受公网音频 URL、不接受 base64**；而 flash 的三个 provider 里包含本地 ffmpeg 抽取、视频号解密流这类“没有公网 URL”的输入。最稳妥且不破坏原有链路的做法是：保留流式主通道（原生支持本地 PCM/解密流），把“URL 直取”的 2.0 兜底统一交给 `doubao-file`；flash 代码保留但默认不进链。
- **已知边界**：
  - `doubao-file` 需要公网 URL；视频号没有 URL，会在这一级被跳过（视频号仍由链首 `doubao-stream` 用本地解密流处理；若流式失败，2.0 兜底帮不上——这与原来“本地 ffmpeg + flash 可兜底”不同）；
  - `doubao-file` 不接受 clip 裁剪（整条音频计费），但它是兜底路径，正常不会走到；
  - **`volc.seedasr.auc` 正是上次产生 ¥0.95 账单的付费资源**：兜底调用同样会计费（除非该子产品另有免费额度）。主路径仍然是流式 2.0 的 20h 免费额度。
- **真实 API 验证**：`doubao-stream` 已实测通过（§0.1）；`doubao-file` 用公网 WAV（`voiptroubleshooter.com` 的 33.6 秒语音样例）实测成功：`provider=doubao-file-asr`、约 40.7 秒返回、文本正确（`The birch canoe slid on the smooth planks...`）。另外：用本机 localhost URL 会返回 `45000006`（服务端拉不到内网地址），证明它只接受公网可访问 URL；用 Wikimedia 的一个 URL 曾超过 120s 预算触发 `DOUBAO_ASR_TIMEOUT`，说明 2.0 异步通道的延迟存在波动，兜底时要接受这点。生产历史上 272 条成功记录都来自 TikHub CDN 公网地址，链路本身可用。
- **回滚**：把 flash 三个 provider 放回链（见 §0.1.2 末），或完全回到 Seed 首位（`GOLD_TRANSCRIPT_PROVIDERS=doubao-file,doubao-video,doubao-stream`）。

---

### 0.1.4 视频号（WeChat Channels）在 2.0 迁移后到底还能不能用

> 用户 2026-10-18 问：「2.0 不支持 base64、视频号又需要本地解析，那视频号功能是不是无法运行了？」——**主功能正常**。视频号走的是链首的 `doubao-stream`，不是录音文件 2.0。

- **视频号的实际路径**：`mediaUrl + decodeKey` → `prepareVideoInput` 本地解密成 readable stream → `audioPcm.js` 用本地 ffmpeg 抽 16k s16le PCM → `asrStreamClient.js` 通过 WSS 发送。**不依赖公网 URL，也不需要 base64**。
- **为什么录音文件 2.0 帮不上视频号**：`volc.seedasr.auc` 的 `audio.url` 必须是服务端可公网访问的 URL；视频号媒体是 Isaac64 加密的 CDN 流，必须先下载解密——没有对象存储上传/临时 URL 就拿不到 `audio.url`。所以 `doubao-file` 只能做“抖音/TikTok 公网 URL”的兜底，视频号这一级会被跳过/失败。
- **逐功能可用性（迁移后）**：

| 功能 | 视频号是否可用 | 说明 |
|---|---|---|
| 2.2 黄金三秒（head） | ✅ | `doubao-stream` 对解密流做 `-t 5` 裁剪后发送 |
| 2.4 今日选题脚本提取（script） | ✅ | 全量 PCM → WS；按音频实际时长扣 20h 额度 |
| 1.2 对标账号分析 head | ✅ | 同 2.2 |
| 1.2 对标账号分析 tail | ❌（迁移前也不支持） | 本地管道不可 seek，`-sseof` 无法定位结尾；旧链的 ffmpeg 同样会抛 `FFMPEG_TAIL_NEEDS_SEEKABLE_INPUT` |
| 2.3 结尾钩子（tail） | ❌（迁移前也不支持） | 同上，非本次迁移引入 |
| 员工二创 | ✅（通常更快） | 走 `doubao-stream`；且视频号选题一般自带“选题页已提取脚本”，直接跳过转写 |
| 流式失败时的兜底 | ⚠️ 先用同一份 PCM 重试一次；**仍失败时没有第二模型兜底** | 迁移前可由本地 ffmpeg + 极速版 flash 兜底；2.0 拿不到本地流、`doubao-video` 也需要公网 URL。重试后仍失败时：2.2/2.3 降级为发布文案/失败标记（不崩），二创在没有预提取脚本时可能整个请求报错 |

- **如果要求视频号“失败也有兜底”，三个方案（✅ A 已实现）**：
  - **A（✅ 已实现，2026-10-18）**：`doubao-stream` 分支里 PCM 已抽好后，WS 失败时用**同一份 PCM 重试一次**（无需重新解密），仍失败才降级。默认链保持无 flash。
  - **B（保留旧链路）**：把 `ffmpeg` 放回链尾（env 一行）。视频号流式失败时走本地解密 + ffmpeg + **极速版 flash**；代价是极速版可能被调用，与“全部换 2.0”冲突。
  - **C（全 2.0，但工程量大）**：本地 PCM 编码 mp3 → 上传对象存储（你账号里有 TOS 资源包）拿临时 URL → 调 `doubao-file` 2.0 兜底。需要 TOS bucket/密钥与清理任务，1~2 天工作量。
- **A 方案实现细节（2026-10-18）**：`providers.js` 新增 `recognizeDoubaoStreamAudioWithRetry`（`:2172`）：PCM 只抽一次；`DOUBAO_STREAM_ASR_FAILED` / `DOUBAO_STREAM_ASR_TIMEOUT` / `DOUBAO_STREAM_ASR_BAD_FRAME` 用同一份 PCM 重试一次（间隔 300ms、第二次预算 60s，避免 120+120 顶穿端点 maxDuration）；空文本 `DOUBAO_STREAM_ASR_EMPTY` 与缺凭据不重试（避免重复计费/无意义重试）。调用点 `providers.js:2343`；回归测试 `apps/server/tests/asr-stream-retry.test.mjs`（6 条，全绿）。

---

## 1. 项目里到底有哪几套模型通道

| # | 通道 | 上游接口 | 资源 / 模型标识 | 输入 | 交互 | 代码位置 |
|---|---|---|---|---|---|---|
| A | **豆包 flash 同步 ASR**（「1.0 系」） | `https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash` | `X-Api-Resource-Id: volc.bigasr.auc_turbo`（env `DOUBAO_RESOURCE_ID`，默认值） | 音频 **base64** | 一次 POST 同步返回 | `providers.js:593-613, 945-1056`；默认值 `config.js:132-138` |
| B | **豆包录音文件识别 2.0（Seed）** | submit `.../api/v3/auc/bigmodel/submit` + 轮询 query `.../api/v3/auc/bigmodel/query` | `X-Api-Resource-Id: volc.seedasr.auc`（env `DOUBAO_FILE_ASR_RESOURCE_ID`，默认值） | 音频 **URL**（服务端自己拉，不收 base64） | 异步 submit + 轮询 | `providers.js:719-943`；唯一写 resource id 处 `providers.js:734`；默认值 `config.js:151-157` |
| C | **豆包视频理解**（Ark 多模态，**不是 ASR**） | `https://ark.cn-beijing.volces.com/api/v3/chat/completions`（env `DOUBAO_VIDEO_ENDPOINT`） | 模型写在请求体：`doubao-seed-2-0-mini-260428`（env `DOUBAO_VIDEO_MODEL`），**不发** `X-Api-Resource-Id` | 视频 URL | 一次 POST 同步返回 | `providers.js:2029-2088, 2444-2464`；默认值 `config.js:158-161` |
| D | **豆包流式/实时语音识别 2.0**（**2026-10-18 起的默认 ASR**） | WebSocket `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`（env `DOUBAO_STREAM_ASR_URL`） | `X-Api-Resource-Id: volc.seedasr.sauc.duration`（env `DOUBAO_STREAM_ASR_RESOURCE_ID`） | 16k 单声道 **s16le PCM**（本地 ffmpeg 抽取，支持 head/tail 裁剪） | WS 二进制帧 burst 发送，异步收最终文本 | 2026-10-18 新增（已合并工作树）：`providers.js:2255-2328` 的 `doubao-stream` 分支；音频抽取 `contentAgent/audioPcm.js`；WS 客户端 `contentAgent/asrStreamClient.js`；配置默认 `config.js:181-189` |
| — | 音频提取（不是模型） | 本地 `ffmpeg` / TikHub CDN 下载 | 无 | 视频 URL / 解密流 | 抽 audio → 送通道 A（`doubao-stream` 送通道 D） | `providers.js:1654-1732, 1734-1847, 1854-2021`；新实现 `audioPcm.js` |

补充：

- 通道 A 被 3 个 provider 共用：`tikhub-music`（下载 `music.play_url` mp3）、`tikhub-ffmpeg`（下载 TikHub CDN 媒体后**本机** ffmpeg 抽音频）、`ffmpeg`（本地 ffmpeg 抽音频；迁移前**只有它能吃 5 秒裁剪参数**，2026-10-18 起 `doubao-stream` 内部抽 PCM 也能吃 head/tail 裁剪）。证据：`providers.js:2318, 2352, 2426`。
- 通道 B 只被 `doubao-file` 一个 provider 使用（`providers.js:2202`），它**不需要也不使用**本地 ffmpeg。**2026-10-18 起通道 B 保留但默认不再进链（回滚用）**：回滚时设 `GOLD_TRANSCRIPT_PROVIDERS=doubao-file,doubao-video,tikhub-music,tikhub-ffmpeg,ffmpeg`。
- 通道 D（2026-10-18 新增）被 `doubao-stream` 一个 provider 使用：先用本地 ffmpeg 抽 16k s16le PCM（因此 head/tail 裁剪有效），再经 WSS burst 发送到流式识别 2.0；它是 gold 链与（代码默认的）全局链的首选 ASR。原通道 B 的 Seed 按量账单因此默认不再产生。
- 通道 C 是「转写兜底」：前两条 ASR 全失败时，用视频理解模型"复述口播"当转写文本；它不是逐字 ASR，`utterances` 恒为空（`providers.js:2451-2452`）。
- `apps/server/.env.example:146` 的注释口径：`volc.seedasr.auc` = 录音文件识别模型 2.0，`volc.bigasr.auc` = 1.0 历史版本。迁移前项目里同时保留并使用了两个资源 id（这就是「模型不统一」的代码根因）；**2026-10-18 起默认链改用第三个资源 `volc.seedasr.sauc.duration`（流式 2.0），前两者保留但默认不进链**。

---

## 2. 主表：哪个功能用哪个模型

> 「当前实际生效链」= 用仓库内 `apps/server/.env` / 生产 `.deploy/app.env` 代入 `getContentAgentConfig()` 实测的结果（见 §3）。
>
> ⚠️ **2026-10-18 迁移后**：①②③④ 的链首位已从 `doubao-file` 改为 **`doubao-stream`（流式识别 2.0，`volc.seedasr.sauc.duration`）**，⑤ 员工二创在生产 env 下也改为 `doubao-stream` 优先（gold/全局链的更新值见 §0.1 与 §3）。本表「当前实际生效链」列保留**迁移前（2026-10-18 14:38）**的实测记录作对照，不再代表当前线上行为。

| # | 功能（用户视角） | 入口页面 / 端点 | 转写调用方式 | 链来源 | 当前实际生效链顺序 | 实际会命中的模型 / 资源 id | 转写范围 |
|---|---|---|---|---|---|---|---|
| ① | **2.2 黄金三秒** | 经理端「账号定位」2.2；`POST /api/agent/gold-three-seconds` | `transcribeTargets`，`scope=head`，`clipSeconds=5` | **gold 链** | `doubao-file → doubao-video → tikhub-music → tikhub-ffmpeg → ffmpeg` | 第 1 位 **Seed 2.0 `volc.seedasr.auc`**；失败回退豆包视频理解；再回退 flash | 最多 60 条（`GOLD_TRANSCRIPT_LIMIT`），head |
| ② | **2.3 结尾钩子** | 经理端「账号定位」2.3；`POST /api/agent/ending-hooks` | `transcribeTargets`，`scope=tail`，`clipSeconds=5` | **gold 链** | 同上 | 同上 | 最多 60 条，tail |
| ③ | **1.2 对标账号分析（画像报告）** | 经理端「账号定位」1.2；`POST /api/agent/benchmark-profile` | `transcribeTargets`，head + tail 各一轮，`clipSeconds=5` | **gold 链** | 同上 | 同上；同经理同视频同 scope 会先命中 2.2/2.3 的 Mongo 缓存，可能不调用 | 只转前 20 条，head + tail |
| ④ | **2.4 正式选题库 / 今日选题脚本提取** | 「今日选题 / 选题生成」页（近 7 天新视频）；`POST /api/agent/benchmark-topic-refresh`（`phase=transcribe`） | `transcribeTargets`，`scope=script`，不裁剪 | **gold 链** | 同上 | 同上（完整脚本场景基本都命中第 1 位 Seed） | 前端逐条驱动，每条一个新视频；**登录即可用，是日常最高频入口** |
| ⑤ | **员工二创 / 内容生成** | 「内容生成」页；`POST /api/agent/workflow/stream-run` | `transcribeVideo`，**不传 providers** | **全局链** | `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video` | 前 3 位 **flash `volc.bigasr.auc_turbo`**；第 4 位豆包视频理解；**当前 env 不含 Seed** | 完整口播、不裁剪；**若请求里已带选题页提取好的脚本，则整段跳过转写** |
| ⑥ | 视频号素材（上述任意功能） | — | — | 同上 | `doubao-file` 无可直接抓取的音源时会被**跳过**，最终走本地解密 + `ffmpeg` | 最终是 **flash**（`ffmpeg+doubao-asr`）；但代码未在 `doubao-file` 分支按平台排除，会先拿加密 URL 试一次 Seed（见 §5-R7） | — |

证据：

- gold 链默认值：`apps/server/api/_lib/contentAgent/config.js:218`；`transcribeTargets` 对 head/tail/script 都会显式传该链：`apps/server/api/_lib/goldThreeSecondTranscripts.js:253-256`。
- 全局链实测（2026-10-18 第二次调整后）：`config.js:62-80` 先保留**显式写在链首**的 `doubao-stream` / `doubao-file`，再（若列表含 `ffmpeg`）把 TikHub 两个 provider 自动 `unshift`；默认列表已不含 `ffmpeg`，所以当前实际链 = `doubao-stream → doubao-file → doubao-video`（本地 `.env:18`、生产备份 `.deploy/app.env:47`；回归测试 `apps/server/tests/asr-stream-config.test.mjs` 会断言默认链不含 flash provider）。历史链（`tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`）见 `apps/server/tests/content-agent.test.mjs:438` 的对照用例。
- 员工二创调用点：`apps/server/api/_lib/contentAgent/index.js:268-278`（未传 providers）；「已带脚本则跳过」：同文件 `215-247`。
- 端点有 **Express（生产 Docker）** 与 **Vercel api** 两份，ASR 代码路径完全同构：Express `apps/server/src/index.js:288,424,616,773,2148` ↔ Vercel `apps/server/api/agent/*.ts`。生产当前是 Docker CVM（`docs/DEPLOY.md` §0）。

### 2.1 明确「不涉及 ASR」的功能（避免误查）

| 功能 | 实际用的模型 |
|---|---|
| 2.1 对标账号分类分析 | DeepSeek 文本（不转写） |
| 1.3 账号规划 | DeepSeek 文本（代码注释明确"不抓视频、不转写"） |
| 3.x 发布仓（封面/文案/标签） | DeepSeek 文本 + 3.1 封面拆解走 Ark **图片理解** `doubao-seed-2-0-mini-260428`（与视频理解同一个 env/model，但**不是语音**） |
| 4.1 单条视频复盘分析 / 4.2 周度分析 | DeepSeek 文本（"不抓取、不转写"；周报文案来自用户填表） |
| Excel 解析 / 复盘表格 AI 识别 | 纯后端解析 / DeepSeek JSON 模式定位字段（不调 ASR） |
| 评论抓取、粉丝画像、翻译、改写 | TikHub 数据接口 / DeepSeek 文本 |

> 当前生产 `.deploy/app.env` 的 DeepSeek 模型是 `deepseek-v4-flash`（`config.js:214` 的代码默认是 `deepseek-chat`）；这些都与语音识别计费无关。

---

## 3. 各环境实际生效的 ASR 配置

> 迁移前（2026-10-18 14:38）的内容是 `node` 实测（只列非敏感字段，密钥不展示）。
> **2026-10-18 迁移后**：代码已在工作树合并（`config.js` 白名单/默认值 + `providers.js` 的 `doubao-stream` 分支），下表是合并后**用 `node` 重新实测**的结果（2026-10-18 14:56 左右；只列非敏感字段）。服务器侧尚未同步 env / 重新部署，见 §0.1.1。

### 3.1 迁移前实测（历史记录，保留作对照）

| 环境 / 来源 | 全局链（员工二创） | gold 链（4 个分析功能） | flash resource id | file resource id |
|---|---|---|---|---|
| **代码默认**（env 清空） | `tikhub-music → tikhub-ffmpeg → doubao-file → ffmpeg → doubao-video` | `doubao-file → doubao-video → tikhub-music → tikhub-ffmpeg → ffmpeg` | `volc.bigasr.auc_turbo` | `volc.seedasr.auc` |
| **本地 `apps/server/.env`**（14:38 时） | `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video` | 同代码默认（未设 `GOLD_TRANSCRIPT_PROVIDERS`） | `volc.bigasr.auc_turbo`（显式） | `volc.seedasr.auc`（未设 → 默认） |
| **生产 `.deploy/app.env`**（迁移前） | 同本地 | 同代码默认（未设 `GOLD_TRANSCRIPT_PROVIDERS` / 任何 `DOUBAO_FILE_ASR_*`） | 同本地 | 同本地 |
| **示例 `apps/server/.env.example`**（迁移前） | 同本地 | ⚠️ `ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video`（显式覆盖，不含 Seed） | 同 | 同 |

### 3.2 迁移后（2026-10-18 起；**已部署到生产**，release `20261018T1641Z`）

| 环境 / 来源 | 全局链（员工二创） | gold 链（4 个分析功能） | flash resource id | file resource id（回滚保留） | **stream resource id（新）** |
|---|---|---|---|---|---|
| **代码默认**（env 清空） | `doubao-stream → doubao-file → doubao-video`（基础列表 `doubao-stream,doubao-file,doubao-video`；无 flash 段所以不触发 TikHub unshift；`config.js:60-63`） | `doubao-stream → doubao-video → doubao-file`（`config.js` 的 gold 默认） | `volc.bigasr.auc_turbo`（仅配置保留，默认不用） | `volc.seedasr.auc`（**默认 2.0 兜底**） | `volc.seedasr.sauc.duration` |
| **本地 `apps/server/.env`**（Lead 15:08 已更新） | `doubao-stream → doubao-file → doubao-video`（显式 `TRANSCRIPT_PROVIDERS="doubao-stream,doubao-file,doubao-video"`，`:18`） | `doubao-stream → doubao-video → doubao-file`（显式 `GOLD_TRANSCRIPT_PROVIDERS`，`:46`） | `volc.bigasr.auc_turbo`（显式，默认不用） | `volc.seedasr.auc`（未设 → 默认） | `volc.seedasr.sauc.duration`（显式，`:48`） |
| **生产 `.deploy/app.env`**（本机备份，已追加；同步服务器 + 部署后生效） | `doubao-stream → doubao-file → doubao-video`（显式 `TRANSCRIPT_PROVIDERS="doubao-stream,doubao-file,doubao-video"`，追加在 `:47`） | `doubao-stream → doubao-video → doubao-file`（显式 `GOLD_TRANSCRIPT_PROVIDERS`，`:46`） | `volc.bigasr.auc_turbo`（保留，默认不用） | `volc.seedasr.auc`（默认 2.0 兜底） | `volc.seedasr.sauc.duration`（显式，`:49`） |
| **示例 `apps/server/.env.example`**（已更新） | `doubao-stream → doubao-file → doubao-video`（示例值 `TRANSCRIPT_PROVIDERS=doubao-stream,doubao-file,doubao-video`） | `doubao-stream → doubao-video → doubao-file` | `volc.bigasr.auc_turbo`（仅保留） | `volc.seedasr.auc`（默认 2.0 兜底） | `volc.seedasr.sauc.duration` |

**关键结论：**

1. **（迁移前，保留作对照）生产与本地完全一致**：`GOLD_TRANSCRIPT_PROVIDERS` 都没设 → gold 链吃代码默认 → Seed 2.0 排第一；`DOUBAO_FILE_ASR_RESOURCE_ID` 也没设 → 资源 id 吃默认 `volc.seedasr.auc`。也就是说，迁移前线上没有任何人显式选择过 Seed，是代码默认值在生效。
2. **（迁移前）`.env.example` 与代码默认相反**：示例写的是旧 gold 链（ffmpeg 第一、无 Seed）。
3. **部署时间线**：`f9aec22`（2026-10-09 19:13）引入 `doubao-file` 并改了 gold 默认链；2026-10-09 首次重建部署的源码（本机回滚包）与 `f9aec22` 逐字节一致 → 该改动自 10-09 起就在生产；2026-10-14 再次部署，`deploy/app.env` 逐字节未变 → Seed 一直在链首，直到本次 2026-10-18 迁移。
4. ~~启动日志只打印 flash resource id 和全局链~~ → **2026-10-18 已修复**：`apps/server/src/index.js:114-129` 现在同时打印 `goldTranscriptProviders`、`doubaoFileAsrResourceId`、`doubaoStreamAsrResourceId`、`doubaoStreamAsrUrl`，部署后一看启动日志就能确认当前用哪套模型。
5. **（迁移后）生产 env 显式固定**：`GOLD_TRANSCRIPT_PROVIDERS`、`TRANSCRIPT_PROVIDERS`、`DOUBAO_STREAM_ASR_*` 已写进本机 `.deploy/app.env`（同步服务器后生效）→ 不再完全依赖代码默认（部分修复迁移前的 R2）。
6. **（第二次调整后）本地与生产已同步**：两边都显式配置 `TRANSCRIPT_PROVIDERS="doubao-stream,doubao-file,doubao-video"`（本地 `.env:18`、生产备份 `.deploy/app.env:47`）与 `GOLD_TRANSCRIPT_PROVIDERS="doubao-stream,doubao-video,doubao-file"`（`.env:46` / `app.env:46`），并显式设置 `DOUBAO_STREAM_ASR_*`；默认链已无 flash provider（见 §3.2 表）。
7. **（迁移后）stream 新键默认值**：`DOUBAO_STREAM_ASR_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`、`DOUBAO_STREAM_ASR_RESOURCE_ID=volc.seedasr.sauc.duration`、`DOUBAO_STREAM_ASR_BUDGET_MS=120000`、`DOUBAO_STREAM_ASR_CHUNK_BYTES=6400`。
8. **✅（迁移后已修正）`doubao-stream` 在全局链保持链首**：迁移时发现 `getTranscriptProviders()` 的 TikHub 自动 unshift 会把显式写在链首的 `doubao-stream` 挤到第 3 位（前两个 provider 走 flash 计费）。已在 `config.js` 加「preferred prefix」规则：显式写在链首的 `doubao-stream` / `doubao-file` 保持链首，TikHub 只插到它后面。第二次调整后默认链已不含 flash，当前全局链 = `doubao-stream → doubao-file → doubao-video`，并已用 `apps/server/tests/asr-stream-config.test.mjs` 锁住「默认链不含 flash provider」。

---

## 4. 与账单的对应关系（可核实事实 + 推断）

**可核实事实（仓库内）：**

1. 全仓写 `X-Api-Resource-Id: volc.seedasr.auc` 的地方**只有一处**：`providers.js:734`，属于 `doubao-file` 通道。
2. 迁移前 `doubao-file` 只出现在 **gold 链**；2026-10-18 第一次迁移后默认链改用 `doubao-stream`；**第二次调整后 `doubao-file` 重新作为两条默认链的 2.0 兜底**（gold 第三位、全局第二位），但首位仍是流式免费额度，正常不调用。
3. 因此**能产生 Seed 2.0（`volc.seedasr.auc`）调用的功能** = §2 的 ①②③④⑤ 在“流式/视频理解都失败”时的兜底路径；正常成功路径走 `doubao-stream`（`volc.seedasr.sauc.duration`，20h 免费额度）。
4. 对比 `f9aec22` 之前的基线（`263e6a6`，2026-09-24）：gold 链默认是 `ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video`，**没有 Seed**；`f9aec22` 之后才变成 Seed 第一。所以「同一功能以前走 flash、现在走 Seed」是这次提交导致的，不是你的错觉；切换上线的准确时间点建议再用控制台的用量明细反推（9-28 那次的服务器源码已丢失，无法直接核对）。

**推断（标注，供你在控制台核对）：**

5. 账单实例前缀 `Speech_Recognition_Seed_AUC…` 与 `volc.seedasr.auc` 的命名对应（Seed 系资源）→ 与第 1~3 条拼起来，**扣费只能来自 ①②③④ 中的 Seed 调用**；而此前这些功能走的是 flash 子产品。
6. 豆包语音的**免费试用额度按子产品/资源独立计算**（官方计费概述：<https://docs.volcengine.com/docs/6561/1359369>；计费说明：<https://www.volcengine.com/docs/6561/1359370>）。项目现在同时使用两个子产品资源（`bigasr.auc_turbo` 与 `seedasr.auc`），**9.54 小时若属于另一个子产品，就不会抵扣 Seed 的调用**——这与你贴出的分析一致。控制台里两个子产品当前是试用版还是正式版，需要你在控制台逐项确认。
7. **粗算量级**：按你账单 ¥0.95 ≈ 0.21 小时音频（¥4.5/小时）。因为 Seed 通道**忽略 5 秒裁剪**（见 R3），每条视频按整条音频计费；若按 57 秒/条粗算，0.21 小时 ≈ **13 条左右**。也就是说，这更像「一小批视频走过 Seed」的量级，而不是整批 60 条跑完。**这是量级核对，不是账单结论。**

### 4.1 生产库实测：Seed 到底被哪些功能调用过（截至 2026-10-14）

本机存有生产库在 2026-10-14 部署前的备份：`.deploy/rollbacks/pre-20261014T0950Z/database/xiaomang-20261014T094913Z.archive.gz`。对其中 `gold_three_second_transcripts` 集合做了**只读 BSON 解析**（未恢复数据库、未连生产），结果：

- 该备份里 provider = `doubao-file-asr`（Seed 2.0 成功转写）的记录 **272 条**，全部属于**同一个项目经理账号**；对比 flash 的 provider（`ffmpeg+doubao-asr:*` / `tikhub-*+doubao-asr`）合计 500 余条。
- 272 条 Seed 记录：`scope=head` 137 条、`scope=tail` 135 条；其中 **135 个视频同时有 head 和 tail**，同一视频两份转写的时间中位间隔 **1.2 分钟**（112/135 在 5 分钟内）。这正是一次「先 head 再 tail」的分析流程的特征。
- 按时间断层（间隔 > 2 分钟）切分，可还原成 8 轮用户操作：

| 轮次 | 时间（北京） | head | tail | 判定 |
|---|---|---|---|---|
| 1 | 10-10 08:03–08:04 | 20 | 19 | **1.2 对标账号分析** |
| 2 | 10-10 09:05–09:07 | 19 | 19 | **1.2 对标账号分析** |
| 3 | 10-10 09:12–09:14 | 20 | 20 | **1.2 对标账号分析** |
| 4 | 10-10 09:18–09:21 | 20 | 20 | **1.2 对标账号分析** |
| 5 | 10-10 13:04–13:05 | 19 | 1 | **2.2 黄金三秒**（只跑 head） |
| 6 | 10-10 13:37–13:39 | 1 | 18 | **2.3 结尾钩子**（只跑 tail，距 2.2 约 31 分钟） |
| 7 | 10-11 11:10–11:13 | 19 | 18 | **1.2 对标账号分析** |
| 8 | 10-11 21:03–21:06 | 19 | 19 | **1.2 对标账号分析** |

判定依据：1.2 的前端是「先 head 20 条、紧接着 tail 20 条」的同一条流程（`BenchmarkProfileStage.tsx:803,811`），所以同一轮内 head 批结束到 tail 批开始只隔约 0 秒；而 2.2/2.3 是两个独立入口，要人手动切换，因此出现了 13:04 只跑 head、13:37 才跑 tail 的分裂（间隔 31 分钟）。

- **结论：截至 10-14，Seed 的钱主要花在「1.2 对标账号分析」**（6 轮 × 20 视频 × head+tail ≈ 240 次调用），其次是 **2.2 黄金三秒**（约 20 次 head）和 **2.3 结尾钩子**（约 19 次 tail）。
- **2.4 今日选题脚本提取基本没有花 Seed 的钱**：备份里 `scope=script` 只有 1 条，provider 是 `ffmpeg+doubao-asr:mp3`（flash），不是 Seed（应是视频号没有公网音源、`doubao-file` 被跳过后的回退）。
- **员工二创没有 Seed 记录**（与全局链不含 `doubao-file` 一致）。
- 文字量估算：270 条成功转写合计约 **4.37 万字**；按中文口播 4~5 字/秒折算，Seed 实际处理音频约 **2.4~3.0 小时**（未计静音/音乐/片头，真实音频时长会更高）。
- **局限**：这是 **10-14 17:49 之前**的生产数据。如果 ¥0.95 发生在这之后，必须查线上库（见 §4.2）。另外，本地开发 `.env` 与生产 `.deploy/app.env` 的豆包 API Key **哈希完全相同**——本地调试这 4 个功能同样会花这个 Seed 资源，不能排除「本地测试花的钱」。

### 4.2 一条命令锁定线上 Seed 调用（在服务器上执行）

```bash
ssh root@124.223.15.17
docker exec xiaomang-app-1 node -e '
const {MongoClient}=require("mongodb");
(async()=>{
  const c=await MongoClient.connect(process.env.MONGODB_URI);
  const db=c.db(process.env.MONGODB_DB_NAME || "xiaomang");
  const rows=await db.collection("gold_three_second_transcripts").aggregate([
    {$match:{provider:"doubao-file-asr"}},
    {$group:{_id:{day:{$dateToString:{format:"%Y-%m-%d %H:%M",date:"$createdAt",timezone:"Asia/Shanghai"}},scope:"$scope"},n:{$sum:1}}},
    {$sort:{"_id.day":1}}
  ]).toArray();
  console.log(JSON.stringify(rows,null,2)); await c.close();
})().catch(e=>{console.error(e);process.exit(1)})'
```

输出里 `scope` 直接对应功能：`script` → 2.4；`head` → 2.2 或 1.2；`tail` → 2.3 或 1.2；同一分钟内成对出现 head+tail 的，是 1.2。把扣费日期前后几小时的输出发我，即可锁定到具体是哪一次。

---

## 5. 风险 / 不一致清单（按重要性）

| # | 级别 | 问题 | 证据 / 影响 |
|---|---|---|---|
| R1 | 🟡 低中（迁移后已收敛） | **文档、示例、代码注释与代码默认值曾经漂移**：迁移后 `config.js` 注释、`.env.example`、§3.2 已统一为 `doubao-stream` 优先；仅 `HANDOFF.md §3.3` 作为历史记录未改（里面写的还是迁移前旧链） | `config.js:62-80/181-218`、`apps/server/.env.example`；历史：`HANDOFF.md:2798-2802/2821-2824` |
| R2 | 🔴 高（迁移后已缓解） | **生产 env 没有显式固定链与资源 id** 曾是本次扣费的直接机制；迁移后本机 `.deploy/app.env` 已显式写入 `GOLD_TRANSCRIPT_PROVIDERS` / `TRANSCRIPT_PROVIDERS` / `DOUBAO_STREAM_ASR_*`，**但必须同步到服务器并重新部署才生效** | `.deploy/app.env:46-51`；服务器 `/opt/xiaomang/deploy/app.env` |
| R3 | 🟡 低中（迁移后对默认链已解决） | **迁移前** 2.2/2.3/1.2 的「开头/结尾 5 秒」裁剪对 Seed 无效、按整条音频计费。**迁移后 `doubao-stream` 内部先用 ffmpeg 抽 PCM，裁剪真的生效**（本地实测 head 5s → `duration=5000ms`）；`doubao-file` / `doubao-video` / `tikhub-*` 仍忽略 clip，但它们已不是默认首选 | 裁剪映射：`goldThreeSecondTranscripts.js:193-199`；`audioPcm.js` 的 `fastProbe/clipSeconds` 透传；`providers.js:2263-2273` |
| R4 | 🟠 中 | **fallback 会静默换模型**：`doubao-stream` 失败/超时/空文本 → 豆包视频理解 → 再回退 TikHub/本地 ffmpeg（flash）。同一次分析里不同视频可能落在不同模型上，报告里的 `transcriptProvider` 字段会不同 | `providers.js:2174-2496` 的 provider 循环；报告/DB 存 `provider` 字段：`transcriptStore.js:83,107` |
| R5 | 🟠 中 | **进程内缓存 key 不含 provider / 模型**：`awemeId::clipMode`；同一视频的流式结果与 flash 结果可能互相命中（1 小时 TTL 内）；Mongo 缓存 key 也不含 clip 秒数 | `providers.js:2148-2160`；`transcriptStore.js:52-58, 90-117` |
| R6 | 🟡 低中（迁移后默认不触发） | **视频号在 `doubao-file` 分支没有被排除**（旧问题）：视频号会拿加密 URL 先试 Seed。迁移后默认链不再用 `doubao-file`；`doubao-stream` 对视频号走 `prepared.stream`（本地解密流），不会把加密 URL 发给服务端 | `resolveWeChatChannelsTopicVideo`（`providers.js:282-330`）；`pickStreamAudioSources` 对视频号返回空、走 stream：`audioPcm.js` |
| R7 | 🟡 低（已修复） | ~~启动日志缺 file/gold/stream 关键信息~~ → 2026-10-18 已补：`goldTranscriptProviders`、`doubaoFileAsrResourceId`、`doubaoStreamAsrResourceId`、`doubaoStreamAsrUrl` | `apps/server/src/index.js:114-129` |
| R8 | 🟡 低中 | **Vercel 入口的 env 不可见**：仓库里仍有 `apps/server/api/**` 一套 serverless 端点，若 Vercel 项目还在使用另一套环境变量，行为可能与生产 Docker 不一致。当前生产是 Docker CVM；Vercel 是否停用待核实 | `apps/server/api/agent/*.ts`、`apps/server/vercel.json`；`docs/DEPLOY.md` §0 |
| R9 | 🟡 低 | `.env.example:59` 写「tikhub-music / tikhub-ffmpeg 的 ffmpeg 跑在 TikHub 服务端」，与代码不符：`tikhub-ffmpeg` 实为**本机下载 + 本机 ffmpeg** | `providers.js:1654-1690, 1883`；`apps/server/.env.example:56-60` |

---

## 6. 建议：怎么「统一」以及先要拍板的事

**先拍板：保留哪一套作为主 ASR？**

> **2026-10-18 更新（已拍板并落地）**：实际采用「统一用流式/实时语音识别 2.0（新 provider `doubao-stream`，资源 `volc.seedasr.sauc.duration`，20h 免费额度）」——见 §0.1。下面的方案 A / B 是迁移前的候选，保留作历史与回滚参考；**方案 A 的 env 示例现在等于「回滚到 flash」配置**（若要回滚到 Seed 录音文件识别，见 §0.1 的回滚方式）。

- **方案 A（迁移前候选；现为回滚方案：统一回 flash 1.0）**：把 gold 链显式改回 `ffmpeg` 第一，Seed 通道保留但不上链（或直接关掉）。
  ```dotenv
  # 生产 deploy/app.env（与本地 .env 同步）
  GOLD_TRANSCRIPT_PROVIDERS=ffmpeg,tikhub-music,tikhub-ffmpeg,doubao-video
  ```
  好处：与 `.env.example` / HANDOFF 的旧口径一致；能吃到本地 ffmpeg 的 5 秒裁剪，2.2/2.3 成本最低；全部回到 `volc.bigasr.auc_turbo` 一个子产品，免费额度/账单口径只对一个。
- **方案 B（统一用 Seed 2.0）**：全局链也加入 `doubao-file`，并接受「整条音频计费 + 异步延迟（官方口径可能到 3 小时）」。
  ```dotenv
  TRANSCRIPT_PROVIDERS=doubao-file,ffmpeg,doubao-video
  GOLD_TRANSCRIPT_PROVIDERS=doubao-file,ffmpeg,doubao-video
  ```
  好处：模型单一、不再依赖本地 ffmpeg；代价：2.2/2.3 的 5 秒裁剪失效（本来也失效），且所有功能都进 Seed 计费。

**无论选哪个，都建议补上（2026-10-18 迁移时已完成的标 ✅）：**

1. ✅ **生产 env 显式声明**：`.deploy/app.env` 已显式写入 gold/全局链与 `DOUBAO_STREAM_ASR_*`（同步服务器 + 重启后生效），不再依赖代码默认。
2. ✅ **同步更新文档/示例**：`apps/server/.env.example`、`config.js` 注释、本文件 §3.2 已按迁移后链更新（`HANDOFF.md §3.3` 作为历史记录保留旧链）。
3. ✅ **启动日志补齐**：`src/index.js:117-127` 已打印 gold 链、file resource id、stream resource id 与 WS 端点。
4. ✅ **测试锁住默认链**：新增 `apps/server/tests/asr-stream-config.test.mjs` 钉住「gold 链首位 = doubao-stream」「全局链 doubao-stream 保持链首」「流式默认资源 id/预算/分块」，并保留回滚用例。
5. **日常核对入口**：数据库 `gold_three_second_transcripts.provider` 字段、报告里的 `transcriptProvider` 字段、服务端日志 `transcript.provider.success` 的 `provider` 值：
   - `doubao-stream-asr(+clip5s/+tail5s)` → **流式识别 2.0（当前默认，20h 免费额度）**
   - `doubao-file-asr` → 录音文件识别 2.0 / Seed（**当前 2.0 兜底**：流式/视频理解都失败时才会走到；`volc.seedasr.auc` 会计费）
   - `tikhub-music+doubao-asr:mp3` / `tikhub-ffmpeg+doubao-asr:*` / `ffmpeg+doubao-asr:mp3` → flash
   - `doubao-video` → 豆包视频理解（不是 ASR）
6. **云端核对**：在火山引擎控制台按资源 id 查看 `volc.seedasr.auc` 与 `volc.bigasr.auc_turbo` 的用量/账单，确认免费试用额度分别挂在哪个子产品；工单/调账按你此前的分析推进即可（本仓库无法看到账户侧状态）。

---

## 7. 证据索引（核心 file:line）

| 事实 | 位置 |
|---|---|
| gold 链默认（2026-10-18 第二次调整后 = `doubao-stream → doubao-video → doubao-file`） | `apps/server/api/_lib/contentAgent/config.js:218`；迁移前（`doubao-file` 第一）见 `git show f9aec22:apps/server/api/_lib/contentAgent/config.js`（:181） |
| 全局链默认 / preferred prefix / TikHub unshift | `apps/server/api/_lib/contentAgent/config.js:62-80`（基础列表 `:62`；fallback `:65`；preferred prefix `:70`；TikHub unshift `:74-79`） |
| flash 资源 id 默认 | `apps/server/api/_lib/contentAgent/config.js:132-138` |
| Seed 资源 id 默认（迁移后保留作回滚） | `apps/server/api/_lib/contentAgent/config.js:151-157` |
| 流式 ASR 配置默认（2026-10-18） | `apps/server/api/_lib/contentAgent/config.js:181-189`（URL/资源 id/预算/分块） |
| 流式 ASR 新键（2026-10-18，`DOUBAO_STREAM_ASR_*`） | `apps/server/.env.example:158-161`；`.deploy/app.env:46-51`（本机备份，未上服务器）；本地 `apps/server/.env:47-50` |
| 流式 ASR 代码（2026-10-18 新增） | `providers.js:2255-2328` 的 `doubao-stream` 分支；`apps/server/api/_lib/contentAgent/audioPcm.js`（抽 16k PCM）；`asrStreamClient.js`（WS 客户端） |
| 流式 ASR 测试（2026-10-18 新增） | `apps/server/tests/audio-pcm.test.mjs`（23）、`apps/server/tests/asr-stream-client.test.mjs`（15）、`apps/server/tests/asr-stream-config.test.mjs`（3；含「默认链不含 flash provider」断言）、`apps/server/tests/asr-stream-retry.test.mjs`（6；PCM 复用重试） |
| 流式失败重试（A 方案） | `apps/server/api/_lib/contentAgent/providers.js:2145-2210`（`recognizeDoubaoStreamAudioWithRetry`）；调用点 `:2343` |
| 视频理解模型默认 | `apps/server/api/_lib/contentAgent/config.js:158-161` |
| flash 请求头写 resource id | `apps/server/api/_lib/contentAgent/providers.js:593-613` |
| Seed 请求头写 resource id（唯一处） | `apps/server/api/_lib/contentAgent/providers.js:719-755`（`:734`） |
| 三个 provider 调 flash | `apps/server/api/_lib/contentAgent/providers.js:2318, 2352, 2426` |
| doubao-file 调 Seed | `apps/server/api/_lib/contentAgent/providers.js:2202` |
| 视频理解调用 | `apps/server/api/_lib/contentAgent/providers.js:2053-2088, 2444-2464` |
| provider 循环 / fallback | `apps/server/api/_lib/contentAgent/providers.js:2141-2497` |
| 缓存 key（不含 provider） | `apps/server/api/_lib/contentAgent/providers.js:2148-2160` |
| 裁剪语义（迁移前：只对 ffmpeg 生效） | `apps/server/api/_lib/goldThreeSecondTranscripts.js:193-199`；`providers.js:2396-2420`；迁移后 `doubao-stream` 内部抽 PCM 也吃 head/tail 裁剪（`audioPcm.js`，2026-10-18） |
| gold 链显式传给 transcribeVideo | `apps/server/api/_lib/goldThreeSecondTranscripts.js:253-256` |
| 员工二创调用（不传 providers） | `apps/server/api/_lib/contentAgent/index.js:268-278` |
| 已带脚本则跳过转写 | `apps/server/api/_lib/contentAgent/index.js:215-247` |
| 本地 env | `apps/server/.env:18,22-23,26,36,46-50`（2026-10-18 第二次调整后） |
| 生产 env 备份 | `.deploy/app.env:16,20-21,24,34`；2026-10-18 追加的迁移键在 `:45-51` |
| 示例 env（2026-10-18 第二次调整后） | `apps/server/.env.example:71`（gold 链示例）、`:114`（全局链示例）、`:158-161`（流式 ASR 新键） |
| 启动日志字段 | `apps/server/src/index.js:114-125` |
| 测试锁全局链 | `apps/server/tests/content-agent.test.mjs:438` |
| 测试锁 Seed 协议 | `apps/server/tests/content-agent.test.mjs:1181-1339` |
| 生产部署记录（Docker CVM） | `docs/DEPLOY.md` §0 |
| 旧版 gold 链（ffmpeg 第一） | `git show 263e6a6:apps/server/api/_lib/contentAgent/config.js` |
| 引入 Seed 的提交 | `git show f9aec22 -- apps/server/api/_lib/contentAgent/config.js` |

---

## 8. 附录：详细审计底稿

- [provider 层审计](asr-audit/provider-layer.md) — 每个 provider 的接口/resource id/输入形态/失败回退、双通道协议细节、R1–R12 风险。
- [功能映射审计](asr-audit/feature-map.md) — 功能→端点→链→模型的完整主表、不转写功能清单、Seed/flash 功能归类。
- [配置与部署历史审计](asr-audit/config-and-history.md) — 各环境实测生效链、生产版本证据链（回滚包字节比对）、文档/代码不一致 12 条清单。

> 外部参考（官方文档，按你提供的链接）：[计费概述](https://docs.volcengine.com/docs/6561/1359369)、[语音产品-计费说明](https://www.volcengine.com/docs/6561/1359370)、[录音文件识别标准版 HTTP](https://docs.volcengine.com/docs/6561/1354868)。资源 id 与账单子产品的最终对应关系以控制台/账单为准。

---

## 9. 仍需你在账户侧确认的 3 件事

> **2026-10-18 更新**：第 3 条已拍板——迁移到**流式/实时语音识别 2.0**（见 §0.1），不再走方案 A flash / 方案 B Seed；第 1、2 条仍需你在火山引擎控制台确认（新资源 `volc.seedasr.sauc.duration` 的 20h 免费额度是否已在控制台可见）。

1. 控制台的 **「大模型录音文件识别-极速版 / 标准版 / Seed 2.0」** 各自当前是「试用版」还是「正式版」，以及 9.54 小时剩余额度挂在哪个子产品下。
2. 本次 `Speech_Recognition_Seed_AUC…` 的用量明细对应的音频时长（可反推是 2.2/2.3/1.2 还是 2.4 触发的）。
3. ~~这 4 个分析功能后续你希望统一走哪一套（方案 A flash / 方案 B Seed）~~ —— **已于 2026-10-18 决定：统一走流式识别 2.0（`doubao-stream` / `volc.seedasr.sauc.duration`）。**

---

## 10. 关于「能不能转回试用版」（官方规则核查）

用户问：当前应该是正式版所以会欠费，能否转回试用版？——**官方规则是「单向」的，不能转回**：

- 豆包语音旧版控制台快速入门原文：「**首次开启后默认为试用版本**……试用版本中提供一定的免费额度」「点击开通后会告知后付费的阶梯价目表，**确认开通后转换为正式版本，试用赠送的用量清零并开始计费**」。→ 只有「试用 → 正式」的入口，没有「正式 → 试用」的反向操作。
- 新版控制台快速入门原文：「新用户……一键开通全部模型，并获取免费试用礼包……**注：试用的免费礼包只在首次开通后赠送，新建项目二次开通则不再赠送。**」→ 换项目/新建应用也拿不到第二份试用。
- 控制台 FAQ：按调用后付费实例欠费后「**自账户欠费起 2 个小时**仍未能补缴所有欠费账单，保留该实例并关停服务；欠费 **168 小时**内补缴，服务恢复正常；**超过 168 小时，资源将被释放且无法恢复**（需重新创建应用并再次开通）」。

**结论：**

1. **同一条服务转不回试用版**；换项目/新建应用也不会重新赠送试用。唯一可能的例外是提工单让客服核对「试用资格/调账」，但按规则大概率不成立。
2. 更容易奏效的方向是「**换一个还有免费额度/更便宜的通道**」，而不是把正式版退回去：
   - **方案 A（最短路径，项目已接好）**：把 4 个分析功能切到 **flash 通道**（`volc.bigasr.auc_turbo`）。如果控制台里 flash 那个子产品还是试用版/还有 9.54h，就继续免费用；如果它也是正式版，再对比两者单价。项目侧只改一个 env：
     ```dotenv
     GOLD_TRANSCRIPT_PROVIDERS=ffmpeg,tikhub-music,tikhub-ffmpeg,doubao-video
     ```
     顺带解决「Seed 忽略 5 秒裁剪」的问题（本地 ffmpeg 能裁剪）。
   - **方案 B**：看录音文件识别其他子产品（标准版/极速版/闲时版）里有没有你**从未开通过**的，首次开通可领该子产品的试用额度；有的话改 resource id/endpoint 即可（我可以做）。
   - **方案 C**：换第三方 ASR（阿里云/腾讯云/讯飞等，通常有新用户免费额度）或自建 FunASR/Whisper；项目 provider 层是插件式的，可以加一个 provider。
   - **方案 D**：先不换模型，只减少 Seed 调用（2.2/2.3 切 flash、限制条数、关掉视频号的无效 Seed 尝试等）。

**紧急动作**：先补缴欠费（¥0.95），避免 2 小时关停、168 小时回收；回收后资源不可恢复。

官方依据：[旧版控制台快速入门](https://docs.volcengine.com/docs/DoubaoVoice/QuickStartOldConsole?lang=zh)、[新版控制台快速入门](https://docs.volcengine.com/docs/DoubaoVoice/QuickStartNewConsole?lang=zh)、[控制台使用 FAQ（欠费关停/回收）](https://docs.volcengine.com/docs/DoubaoVoice/ConsoleUsageFAQ?lang=zh)。
