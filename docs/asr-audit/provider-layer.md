# 小芒 · ASR / 转写 provider 层审计

> 审计人：teammate `provider-audit`（task-1）｜审计日期：2026-10-18
> 审计方式：**纯静态读代码**（未运行 npm install / npm test，未发起任何真实 API 调用）。
> 代码基线：`git HEAD = f9aec22`（2026-10-09）。`providers.js`、`contentAgent/config.js`、`goldThreeSecondTranscripts.js`、`transcriptStore.js` 在工作区**无未提交改动**；`contentAgent/index.js`、`src/index.js` 为工作区已修改版本，本文行号以**当前工作区文件**为准。
> 证据口径：所有结论都带 `file:line`；代码引用每条 ≤2 行；**不输出任何 key/token/secret 的值**，只写变量名与「已配置/未配置」。

---

## 0. TL;DR（先看这 6 条）

1. **项目里"ASR"实际是两套完全独立的豆包通道**：
   - flash 同步识别（`recognizeDoubaoAudio`）：`X-Api-Resource-Id` 默认 **`volc.bigasr.auc_turbo`**，`config.js:138`；
   - 录音文件识别 2.0 异步（`recognizeDoubaoFileAudio`）：默认 **`volc.seedasr.auc`**，`config.js:153`。
   两套的 endpoint、输入形态、模型资源 id 全部不同，没有统一抽象（§3）。
2. **只有 `doubao-file` provider 会发 `X-Api-Resource-Id=volc.seedasr.auc`**（`providers.js:734`）；`tikhub-music` / `tikhub-ffmpeg` / `ffmpeg` 三个 provider 最终都走 flash（`providers.js:2318`、`2352`、`2426`）；`doubao-video` 走火山 Ark chat/completions，不经过 openspeech 的 resource id 体系（§3、§4）。
3. **黄金三秒/结尾钩子/2.4 完整脚本/对标画像四条链默认首选 `doubao-file`**：`config.goldTranscriptProviders` 的**代码默认值第一项就是 `doubao-file`**（`config.js:181`），而 `transcribeTargets` 对 head/tail/script 三种 scope 都会把这个顺序显式传给 `transcribeVideo`（`goldThreeSecondTranscripts.js:253-256`）。若线上没有用 env 覆盖该项，这四条链的第一跳就是 `volc.seedasr.auc`。
4. **员工二创（/api/agent/workflow/stream-run）走的是另一条链**：`config.transcriptProviders`（`contentAgent/index.js:272` 未传 `providers`），本地 env 为 `ffmpeg,doubao-video`，经自动 unshift 后实际为 `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`（`config.js:57-68`；测试同口径：`apps/server/tests/content-agent.test.mjs:438`）——前三个 provider 走 flash（`volc.bigasr.auc_turbo`），最后 `doubao-video` 走 Ark 模型。
5. **文档/示例配置与代码默认值不一致**：`.env.example` 写黄金三秒链是 `ffmpeg` 第一（`.env.example:66`），HANDOFF 也写 `ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video`（`HANDOFF.md:2798-2802`、`2821-2824`），但**代码默认是 `doubao-file → doubao-video → tikhub-music → tikhub-ffmpeg → ffmpeg`**（`config.js:181`）。本地 `apps/server/.env` 和 `.deploy/app.env` 都**没有设置** `GOLD_TRANSCRIPT_PROVIDERS` → 若线上沿用这两份 env，生效的是代码默认值（§8-R2）。
6. **启动日志只打印 flash 的 resource id 和员工二创链**，不打印 `doubaoFileAsrResourceId`、黄金三秒链、`doubaoVideoModel`（`src/index.js:114-125`）→ 线上到底跑哪套 ASR 模型，仅凭启动日志**无法判断**（§8-R7）。

> 账单关联只陈述**代码事实**：会携带 `volc.seedasr.auc` 的代码路径只有 `doubao-file`；会携带 `volc.bigasr.auc_turbo` 的是另外三个 provider。账单实例前缀 `Speech_Recognition_Seed_AUC…` 与 `volc.seedasr.auc` 的命名对应关系、以及各通道实际扣费口径，**待 Lead 用云侧账单/用量明细核实**，本文不做推断。

---

## 1. 文件与入口地图

| 层 | 文件 | 作用 |
|---|---|---|
| 配置 | `apps/server/api/_lib/contentAgent/config.js`（232 行） | 所有 ASR/转写/env 默认值；provider 链白名单与自动插入逻辑 |
| provider 实现 + 编排 | `apps/server/api/_lib/contentAgent/providers.js`（3370 行） | 豆包 flash / 文件识别 2.0 / Ark 视频理解 / TikHub / ffmpeg / `transcribeVideo` 编排 |
| 黄金三秒/钩子/脚本转写编排 | `apps/server/api/_lib/goldThreeSecondTranscripts.js`（303 行） | 选样本、解析、分批并发、scope、预算 |
| 转写持久化缓存 | `apps/server/api/_lib/transcriptStore.js`（194 行） | Mongo `gold_three_second_transcripts`，按 `managerId+videoId+scope` 唯一 |
| HTTP 工具 | `apps/server/api/_lib/contentAgent/http.js` | `fetchJson`：每次尝试的超时、重试、可重试状态码 |
| Serverless 入口 | `apps/server/api/agent/{gold-three-seconds,ending-hooks,benchmark-profile,benchmark-topic-refresh}.ts` | 生产 serverless handler，phase=transcribe 时调用 `transcribeTargets` |
| Express 入口（Docker CVM） | `apps/server/src/index.js` | 同名路由的 Express 版本，同样调用 `transcribeTargets`（`Dockerfile` 末尾 `CMD ["node","apps/server/src/index.js"]`） |
| 员工二创入口 | `apps/server/api/agent/workflow/stream-run.ts:31` → `contentAgent/index.js` | 调 `transcribeVideo`（`contentAgent/index.js:272`），链来自 `config.transcriptProviders` |

> 部署事实：仓库同时存在 Vercel serverless（`apps/server/vercel.json`）与 Docker CVM（`Dockerfile`、`deploy/compose.yml:19` 使用 `app.env`）两种入口，两者最终都落到**同一个 provider 层**。线上主入口是哪一种，**待 Lead 核实**。

---

## 2. provider 一览表

`transcribeVideo` 支持 5 个 provider id；`config.js:51` 是白名单，未列出的名字会被**静默过滤**（`config.js:48-51`、`57-59`），`"tikhub"` 会被别名成 `tikhub-ffmpeg`（`config.js:26-30`）。

| provider id | 实现函数（file:line） | 上游 URL | `X-Api-Resource-Id`：env 名 → 默认值 | 认证 header | 输入形态 | 同步/异步 | 文本提取 | 失败/空文本回退行为 |
|---|---|---|---|---|---|---|---|---|
| `tikhub-music` | 分支：`providers.js:2292-2337`；下载：`fetchBinary`（`1238`）；ASR：`recognizeDoubaoAudio`（`945-1056`） | 音频来源是 TikHub 解析出的 `music.play_url`（CDN 直链），不是 TikHub API 本身；下载逻辑 `2299-2304` | 与 flash 相同：`DOUBAO_RESOURCE_ID` → `volc.bigasr.auc_turbo`（`config.js:138`；`providers.js:596`） | ASR：`X-Api-Key`（优先）或 `X-Api-App-Key`+`X-Api-Access-Key`，附 `X-Api-Request-Id`、`X-Api-Sequence:-1`（`providers.js:593-613`、`977`） | **base64**（mp3 buffer → base64，`2318-2322`） | 同步（单次 POST） | `result.text`（`619-622`、`1047-1052`） | 文件 <1KB 直接抛 `MUSIC_AUDIO_TOO_SMALL`（`2306-2311`）；ASR 空文本抛 `DOUBAO_ASR_EMPTY`（`1039-1045`）→ 外层 catch 继续下一个 provider（`2466-2487`）；成功才写进程内缓存（`2335`） |
| `tikhub-ffmpeg` | `extractAudioWithTikHubFfmpegProvider`（`1654-1732`）→ `extractAudioFromFetchedMedia`（`1560-1616`）→ 本地 ffmpeg（`extractAudioFromStream`，`1854-2021`）；ASR：`recognizeDoubaoAudio` | 媒体来自 TikHub CDN 直链（候选 URL 见 `1504-1524`），由本机 `undici` 下载后喂本地 ffmpeg stdin | flash：`DOUBAO_RESOURCE_ID` → `volc.bigasr.auc_turbo`（`config.js:138`） | ASR 同上 flash；媒体下载支持 `VIDEO_STREAM_FETCH_HEADERS` 与代理配置（`1183-1188`、`134-152`） | 本地抽出的音频 **base64**（wav 或 mp3） | 同步 | `result.text` | 仅适用 TikHub CDN 媒体（`1501-1502`、`1655-1660`、`2261-2267`）；音频格式按 `ASR_AUDIO_FORMAT` 依次尝试 wav→mp3（`1623-1628`）；可换格式的失败才回退格式（`1640-1652`、`2370`）；候选 URL 最多 `TIKHUB_MEDIA_URL_MAX_ATTEMPTS`（默认 2，`config.js:125`、`providers.js:1671`）；全失败继续下一 provider |
| `ffmpeg` | `extractAudioWithFfmpeg`（`1734-1847`）/ 视频号流式 `extractAudioFromStream`（`1854-2021`）；ASR：`recognizeDoubaoAudio` | 无第三方 URL：ffmpeg 直接读视频 URL 或 stdin 流；ffmpeg 参数见 `buildFfmpegAudioExtractArgs`（`1068-1132`） | flash：`DOUBAO_RESOURCE_ID` → `volc.bigasr.auc_turbo`（`config.js:138`） | ASR 同上 flash；ffmpeg 无鉴权 | 本地抽出的音频 **base64**（固定 mp3，`2397-2398`、`2426`） | 同步 | `result.text` | `FFMPEG_ENABLED=false` 抛 `FFMPEG_DISABLED`（`1735-1737`）；单进程硬超时 90s（`1764-1769`）；输出超限 24MB（mp3）/20MB（wav）（`config.js:120,124`、`1526-1533`）；空壳音频抛 `FFMPEG_EMPTY`（`1816-1832`）；裁剪时先 fast-probe 再保守重试（`2406-2419`）；仍失败继续下一 provider |
| `doubao-file` | `recognizeDoubaoFileAudio`（`873-943`）/ 单次任务 `recognizeDoubaoFileAudioOnce`（`719-853`） | submit：`DOUBAO_FILE_ASR_SUBMIT_URL` → `https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit`；query：`.../query`（`config.js:151-152`） | `DOUBAO_FILE_ASR_RESOURCE_ID` → **`volc.seedasr.auc`**（`config.js:153`；覆盖写入 `providers.js:734`） | 同 flash 的 `buildDoubaoAsrHeaders`（`733`），resource id 再覆盖；`task_id` 就是自己生成的 `X-Api-Request-Id`（`730-735`） | **音频 URL**（只接受 http(s)；`audio.url` + `audio.format`，`756-760`） | **异步**：submit + 轮询 query（`747-852`） | query 成功后 `result.text`（`824`、`845-851`） | 无可直取 URL 时**整个 provider 跳过**（`2180-2187`）；同一视频最多 2 个等价音源（music mp3 → video m4a）依次重试（`680-695`、`873-943`）；submit 失败立即抛（`764-770`）；轮询超预算抛 `DOUBAO_ASR_TIMEOUT`（`773-789`）；空文本抛 `DOUBAO_ASR_EMPTY`（`824-831`）→ 继续下一 provider |
| `doubao-video` | `callDoubaoVideoUnderstanding`（`2053-2088`）；鉴权 `doubaoMultimodalHeaders`（`2029-2042`） | `DOUBAO_VIDEO_ENDPOINT`，默认空串（`config.js:158`）；示例值 `https://ark.cn-beijing.volces.com/api/v3/chat/completions`（`.env.example:142`） | **不使用** `X-Api-Resource-Id`；模型写在请求体 `model` 字段：`DOUBAO_VIDEO_MODEL` → `doubao-seed-2-0-mini-260428`（`config.js:160`、`2064-2076`） | `Authorization: Bearer <DOUBAO_VIDEO_API_KEY>`（默认）；可用 `DOUBAO_VIDEO_AUTH_HEADER` 改 header 名（非 Authorization 时不加 Bearer，`2036-2040`） | **视频 URL**（`content:[{type:"text"},{type:"video_url",video_url:{url}}]`，`2064-2076`） | 同步（单次 POST，无轮询） | `choices[0].message.content`（兼容 `output_text/text/result.text`，`2045-2051`） | endpoint/key 缺失抛 `DOUBAO_VIDEO_CREDENTIALS_MISSING`（`2030-2033`）；空文本抛 `DOUBAO_VIDEO_EMPTY`（`2081-2086`）；视频号本地/流输入直接抛 `DOUBAO_VIDEO_LOCAL_FILE_UNSUPPORTED`（`2446-2450`）；失败继续下一 provider（`2466-2487`） |

补充：
- 所有 provider 成功返回的结构都并入 `{ text, provider, warnings }`，`provider` 标签由编排层拼：`doubao-file-asr`（`2211`）、`tikhub-music+doubao-asr:mp3`（`2323`）、`tikhub-ffmpeg+doubao-asr:{wav|mp3}`（`2353`）、`ffmpeg+doubao-asr:{mp3}+clip5s/+tail5s`（`2429-2430`）、`doubao-video`（`2452`）。这些字符串会写进报告/DB，是核对"这条转写到底走了哪套模型"的**最直接证据**（§9）。
- `tikhub-ffmpeg` 名字有误导性：它**不是**"TikHub 服务端 ffmpeg"。代码是先从 TikHub CDN 下载媒体流（`1596`），再由本机 `spawn(ffmpegPath, ...)` 抽音频（`1883`）。因此它**吃不到** `clipSeconds/tailSeconds`（`2344` 只传 `audioFormat`），行为上与"裁剪只对本地 ffmpeg 生效"的文档结论一致，但 `.env.example:59` 里"tikhub-ffmpeg 的 ffmpeg 跑在 TikHub 服务端"的表述与代码不符（§8-R6）。
- ASR 请求里的 `user.uid` 取 `config.doubaoApiKey || config.doubaoAppKey || "xiaomang-agent"`（`providers.js:615`），即把凭据值当 uid 用；不影响模型选择，但不宜作为业务用户标识（§8-R12）。

---

## 3. 两条豆包 ASR 通道对比

### 3.1 通道 A：flash 同步识别（`recognizeDoubaoAudio`）

| 项 | 值 | 证据 |
|---|---|---|
| 端点 | `DOUBAO_ASR_ENDPOINT` → 默认 `https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash` | `config.js:132-134` |
| 资源 id | `DOUBAO_RESOURCE_ID` → 默认 `volc.bigasr.auc_turbo` | `config.js:138`；写入 `providers.js:596` |
| 请求头 | `Content-Type: application/json`、`X-Api-Resource-Id`、`X-Api-Request-Id`（每次随机 UUID）、`X-Api-Sequence: "-1"`、认证头 | `providers.js:593-613`、`977` |
| 认证 | 优先 `X-Api-Key: DOUBAO_API_KEY`；否则 `X-Api-App-Key`+`X-Api-Access-Key`；都缺则抛 `DOUBAO_ASR_CREDENTIALS_MISSING` | `providers.js:601-612` |
| 请求体 | `{ user:{uid}, audio:{data:<base64>}, request:{model_name:"bigmodel"} }`；**不发 audio.format** | `providers.js:978-982` |
| 输入形态 | base64 音频；音频由调用方先抽好（mp3 或 wav） | `providers.js:945-951` |
| 结果判定 | 以响应头 `X-Api-Status-Code` 为准（存在且 ≠`20000000` 即失败）；header 缺失时以 `response.ok` + 非空文本判成功；正文取 `result[0].text` / `result.text` | `providers.js:985`、`1001`、`1039-1045`、`619-622` |
| 超时 | 每次 HTTP 尝试 `AGENT_REQUEST_TIMEOUT_MS` 默认 **120s** | `config.js:80`、`providers.js:963`、`http.js:124` |
| 重试 | **双层**：外层最多 `apiRetryAttempts+1`=3 次，且仅对 `55xxxx` 状态重试（`providers.js:956`、`1001-1038`）；内层 `fetchJson` 对 429/5xx/网络错误再重试 `apiRetryAttempts`=2 次（`http.js:43`、`108-109`、`162-179`） | 同左 |
| 失败文本 | 非 `20000000` → `DOUBAO_ASR_FAILED`；`response.ok` 为假或空文本 → `DOUBAO_ASR_EMPTY` | `providers.js:1001-1045` |

### 3.2 通道 B：录音文件识别 2.0（异步 submit + query，`recognizeDoubaoFileAudio`）

| 项 | 值 | 证据 |
|---|---|---|
| submit 端点 | `DOUBAO_FILE_ASR_SUBMIT_URL` → 默认 `.../api/v3/auc/bigmodel/submit` | `config.js:151` |
| query 端点 | `DOUBAO_FILE_ASR_QUERY_URL` → 默认 `.../api/v3/auc/bigmodel/query` | `config.js:152` |
| 资源 id | `DOUBAO_FILE_ASR_RESOURCE_ID` → 默认 **`volc.seedasr.auc`**；在通用头之后覆盖 | `config.js:153`、`providers.js:732-735` |
| task_id | **就是调用方生成的 `X-Api-Request-Id`**；submit 响应体是 `{}` 不返回 task_id，query 必须复用同一个 UUID | `providers.js:730-735`、`706-708`（注释）、测试 `tests/content-agent.test.mjs:1193-1213` |
| submit 请求体 | `{ user:{uid}, audio:{url,format}, request:{model_name:"bigmodel"} }`；`format` 白名单 `wav/mp3/ogg/spx/amr/aac/m4a` | `providers.js:756-760`、`649-653` |
| 输入形态 | **只接受音频 URL**（http(s)），服务端自己拉；不接受 base64 | `providers.js:700-702`（注释）、`757-759` |
| 音源顺序 | `music.play_url`(mp3) 优先 → 视频直链（声明为 m4a）；同一视频最多 2 个等价音源依次重试 | `providers.js:680-695`、`873-943` |
| 轮询 | 每 `DOUBAO_FILE_ASR_POLL_INTERVAL_MS` 默认 **2000ms** 发一次空 body 的 query；`20000001`=处理中继续，`20000000`=成功 | `config.js:156`、`providers.js:773-806` |
| 总预算 | `DOUBAO_FILE_ASR_BUDGET_MS` 默认 **120000ms**；**预算在轮询循环开头检查**，即「睡 2s + 一次最长 120s 的 query」可能让实际耗时越过预算（见 R5） | `config.js:157`、`providers.js:736-737`、`773-801` |
| 超时 | submit/query 每次 HTTP 尝试都是 `AGENT_REQUEST_TIMEOUT_MS`=120s；query `retries:0`（不重试），submit 沿用 `apiRetryAttempts` | `providers.js:747-755`、`792-801` |
| 结果判定 | 状态码读响应头 `X-Api-Status-Code`，兼容 body 的 `code/status_code`；正文 `result.text` | `providers.js:660-662`、`802-824` |
| 失败语义 | submit 非 `20000000` → 立即失败；超预算 → `DOUBAO_ASR_TIMEOUT`；查询错误码 → `DOUBAO_ASR_FAILED`；空文本 → `DOUBAO_ASR_EMPTY`（失败即交给 provider 链） | `providers.js:762-789`、`808-831` |

### 3.3 关键差异与"谁在用哪条通道"

| 维度 | flash（A） | 录音文件识别 2.0（B） |
|---|---|---|
| 模型资源 | `volc.bigasr.auc_turbo` | `volc.seedasr.auc`（`.env.example:135` 注释：2.0；`volc.bigasr.auc`=1.0 历史版本） |
| 输入 | base64 | URL |
| 交互 | 一次请求同步返回 | submit → 轮询 query |
| 需要本地 ffmpeg | 是（音频先抽出来） | 否（但可以复用 `music.play_url`） |
| 时延特征 | 单次秒级；受 120s 超时约束 | 实测 57s 视频约 10s（`providers.js:703` 注释）；官方口径可能延迟到 3 小时内（`config.js:147` 注释） |
| 默认超时预算 | 单次 120s × 最多 3 外层 × 3 内层（R5） | 总 120s（软预算）+ 单次 query 120s |
| 使用它的 provider | `tikhub-music`（`2318`）、`tikhub-ffmpeg`（`2352`）、`ffmpeg`（`2426`） | 只有 `doubao-file`（`2202`） |
| 资源 id env | `DOUBAO_RESOURCE_ID` | `DOUBAO_FILE_ASR_RESOURCE_ID` |

> **账单可核对事实**：把 `X-Api-Resource-Id` 设为 `volc.seedasr.auc` 的代码位置**只有** `providers.js:734`；没有其他 provider 复用该 resource id。`tikhub-music/tikhub-ffmpeg/ffmpeg` 三个 provider 共用 `recognizeDoubaoAudio`，因此共用 `volc.bigasr.auc_turbo`。

---

## 4. `doubao-video`：Ark chat/completions 视频理解（转写兜底）

- **接口**：`POST <DOUBAO_VIDEO_ENDPOINT>`（Ark chat/completions 兼容；示例 `https://ark.cn-beijing.volces.com/api/v3/chat/completions`），请求体 `model/messages/temperature`（`providers.js:2064-2076`）。
- **模型**：`DOUBAO_VIDEO_MODEL`，默认 `doubao-seed-2-0-mini-260428`（`config.js:160`）；与 `understandDoubaoImage` **共用同一个 endpoint、同一个 key、同一个 model**（`providers.js:2029-2042`、`2101-2139`）。
- **输入**：视频 URL，作为 `content` 里的 `{ type:"video_url", video_url:{url} }`（`2071`）；不下载视频、不抽音频、不传 base64。
- **提示词**：`DOUBAO_VIDEO_TRANSCRIPT_PROMPT`——要求"还原视频中的口播文案和屏幕关键信息，输出一段可供二创使用的原始文案"（`prompts.js:485`）。
- **输出**：模型返回的自然语言文本（`choices[0].message.content` 等，`2045-2051`），编排层原样作为 `transcript.text` 返回，`utterances: []`（`2451-2452`）。
- **为什么算"转写兜底"**：它被放在 provider 链里，产出直接当转写文本用（`transcript.text`）；当 ASR 路径（flash 或 file）全部失败时它仍可能给出可用的口播复述。注意它是**理解生成**而不是逐字 ASR，`utterances` 恒为空、没有音频时间戳（`2452`）。
- **是否走语音识别计费**：代码层面它**不发送** `X-Api-Resource-Id`，也没有任何 openspeech 端点（`2053-2088` 全文无该 header），请求落在 Ark 多模态模型上；`DOUBAO_VIDEO_API_KEY` 与 ASR 的 `DOUBAO_API_KEY` 是**两组独立凭据**（`config.js:135` vs `159`）。它在云侧账单上归到哪个商品/是否计入 ASR 用量，**代码无法证明，待 Lead 核实**；本文只陈述"不经过 openspeech resource id 通道"这一事实。

---

## 5. `transcribeVideo` 编排（`providers.js:2141-2497`）

### 5.1 provider 顺序与 `explicitProviders`

- 顺序来源（`providers.js:2167-2172`）：
  - 调用方传了 `options.providers`（非空数组）→ **完全使用该顺序**，`explicitProviders=true`；
  - 否则使用 `config.transcriptProviders`。
- `explicitProviders` 的副作用：会**关闭**「有 TikHub 就跳过本地 ffmpeg」的隐式优化（`2269` 条件里有 `!explicitProviders`），避免显式顺序被静默改写（`2164-2168` 注释）。
- 黄金三秒/钩子/2.4/画像都通过 `transcribeTargets` **显式传** `config.goldTranscriptProviders`（`goldThreeSecondTranscripts.js:253-256`），所以它们**永远走 explicit 分支**。
- 员工二创没有传 `providers`（`contentAgent/index.js:272-275`），走 `config.transcriptProviders`。

### 5.2 链的推导（默认值 vs 实际 env）

`config.transcriptProviders` 的构造（`config.js:47-69`）：

1. 基础列表：`TRANSCRIPT_PROVIDERS`，代码默认 `["doubao-file","ffmpeg","doubao-video"]`（`config.js:57`，env 为空时才用）；
2. 若含 `ffmpeg` 且 `TIKHUB_TRANSCRIPT_PROVIDER_ENABLED!=false`（默认 true，`config.js:52`）→ 头部插入 `tikhub-ffmpeg`（`61-63`）；
3. 若含 `tikhub-ffmpeg` 且 `TIKHUB_MUSIC_PROVIDER_ENABLED!=false`（默认 true，`config.js:56`）→ 再插入 `tikhub-music`（`65-67`）；
4. 去重（`68`）。

因此：
- **代码默认**（env 全不设）：`tikhub-music → tikhub-ffmpeg → doubao-file → ffmpeg → doubao-video`；
- **本地 `apps/server/.env` 与 `.deploy/app.env` 的 `TRANSCRIPT_PROVIDERS="ffmpeg,doubao-video"`** → `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`（无 `doubao-file`）；与测试断言一致（`tests/content-agent.test.mjs:438`）。
- **注意陷阱**：若基础列表里没有 `ffmpeg`（如 `doubao-video` 单独一项），两个 TikHub provider 都**不会**被自动插入（`61-67` 的条件依赖 `includes("ffmpeg")/("tikhub-ffmpeg")`）。

`config.goldTranscriptProviders` 是独立配置，**不经过**上面的自动插入逻辑，只是 `splitCsv`（`config.js:181`）：
- 代码默认：`["doubao-file","doubao-video","tikhub-music","tikhub-ffmpeg","ffmpeg"]`（`config.js:181`）；
- `.env.example` 写的是 `ffmpeg,tikhub-music,tikhub-ffmpeg,doubao-video`（`.env.example:66`）；
- HANDOFF 文档写的是 `ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video`（`HANDOFF.md:2798-2802`、`2821-2824`）；
- 本地 `.env` / `.deploy/app.env` **均未设置**该变量 → 生效的是代码默认（R2）。

### 5.3 缓存

| 缓存 | key | TTL | 证据 |
|---|---|---|---|
| 进程内转写缓存 | （`awemeId`、`videoUrl`、`shareLink` 取第一个可用值）+ `::clipMode`；`clipMode` = `full`/`head{N}`/`tail{N}`；**不含 provider、不含 scope 名** | `AGENT_TRANSCRIPT_CACHE_TTL_MS` 默认 1h | `providers.js:2148-2160`；`config.js:98` |
| TikHub 解析缓存 | `platform::shareLink` | `AGENT_RESOLVE_CACHE_TTL_MS` 默认 30min | `providers.js:81`、`501-591`；`config.js:101` |
| Mongo 持久化 | `managerId + videoId + scope` 唯一索引；`scope ∈ {head, tail, script}`；**不含 provider、不含 clip 秒数** | 无 TTL（永久） | `transcriptStore.js:25-29`、`77`、`109-137`；`goldThreeSecondTranscripts.js:156-163` |

- 只有成功结果写进程内缓存（`2227`、`2335`、`2366`、`2441`、`2462`）；失败继续下一个 provider（`2466-2487`）。
- 持久化层"失败的也记一条"（`transcriptStore.js:108-137`），由调用方在 `transcribeTargets` 里 `emit({status:"failed"})`（`goldThreeSecondTranscripts.js:284-296`），避免每次重跑撞同一堵墙（`transcriptStore.js:157-162` 注释）。
- **风险**：进程内 key 不含 provider → 在同一实例、1h TTL 内，即使 env 改了 provider 链，也会直接返回**旧 provider 的文本**（R4）。

### 5.4 空文本 / 失败回退

- provider 抛错（含空文本）→ 编排层 catch → 记 `transcript.provider.failed`、`warnings.push`、`continue` 下一个 provider（`providers.js:2466-2487`）。
- 全部失败 → `TRANSCRIPT_FAILED`，`details.warnings` 带每个 provider 的失败原因（`2493-2496`）。
- 各 provider 的空文本判定：
  - `doubao-file`：`!text` → 抛空文本错误（`2207-2208`），且内部会先换音源重试（`886-927`）；
  - `tikhub-music` / `tikhub-ffmpeg` / `ffmpeg`：由 `recognizeDoubaoAudio` 抛 `DOUBAO_ASR_EMPTY`（`1039-1045`），所以成功返回的文本必然非空；
  - `doubao-video`：`callDoubaoVideoUnderstanding` 内判空（`2081-2086`）。
- `tikhub-ffmpeg` 还有两层"内部回退"：音频格式 wav→mp3（`2338-2390`，可回退条件 `1640-1652`）和媒体候选 URL 轮换（`1671-1727`）。
- **黄金三秒裁剪空文本另有一层**：`goldThreeSecondTranscripts.js:261-269`——裁出来的 5 秒没人声时，先回退**完整转写**再试一次（同一链、`clipSeconds:0`），仍空才判 failed（`270`）。

### 5.5 视频号（`platform: "wechat_channels"`）

- 解析：没有分享链接，走 `resolveWeChatChannelsTopicVideo`：`videoUrl = source.mediaUrl`、`decodeKey` 必填，缺一即抛（`providers.js:282-317`；字段判定 `goldThreeSecondTranscripts.js:54-58`）。
- 可转写性：必须有 `mediaUrl + decodeKey`（`goldThreeSecondTranscripts.js:54-58`）；抖音/TikTok 要 `link`。
- 媒体准备：`prepareVideoInput` 先下载 + 用 `generateKeystream(decodeKey)` 做 Isaac64 流式解密，得到 `prepared.stream`（`providers.js:1444-1497`，`1458-1460`）；`ffmpeg` provider 用该 stream 喂 stdin（`2394-2398`）。
- provider 限制：
  - `tikhub-music`：显式跳过（`providers.js:2253-2260`）；
  - `tikhub-ffmpeg`：跳过（不是 TikHub CDN，`2261-2267`）；
  - `doubao-video`：`prepared.stream/localFile` 时直接抛 `DOUBAO_VIDEO_LOCAL_FILE_UNSUPPORTED`（`2446-2450`）；
  - `ffmpeg`：正常路径；
  - `doubao-file`：**代码没有对视频号做排除**（见 R3）。

### 5.6 TikHub provider 的限制（`tikhub-music` / `tikhub-ffmpeg`）

- `tikhub-music` 只在有 `videoMeta.musicUrl` 时可用（`2245-2251`）；下载到的 mp3 <1KB 判无效（`2306-2311`）。
- `tikhub-ffmpeg` 只在 `sourceProvider === "tikhub"` 且存在可流式 CDN URL 时可用（`1501-1502`），否则跳过（`2261-2267`）。
- **隐式跳过本地 ffmpeg**：当链里含 `tikhub-ffmpeg`、且该视频是 TikHub CDN 媒体、且**不是** `explicitProviders` 时，`ffmpeg` 会被跳过（`2269-2281`）。黄金三秒因为显式传链，**不会**触发这条跳过（`2269` 条件里的 `!explicitProviders`）。
- 媒体 URL 排序：来源优先级 + 文件大小升序，避免抽到无音轨的纯视频 DASH 流（`1504-1524`、`config.js:126-128`）。
- 视频号的加密媒体**不在** TikHub 适用范围内（`platform/sourceProvider` 不匹配；`isWeChatChannelsVideo` 见 `providers.js:261-264`）。

---

## 6. 功能 → 转写链 → 模型 矩阵

> 说明：serverless handler 与 Express 路由是**两份同构实现**，都调用同一个 `transcribeTargets`/`transcribeVideo`，所以"功能→链"映射一致；线上具体走哪份入口待核实。

| # | 功能（模块） | 入口（file:line） | 转写链来源 | 按当前代码/env 的实际顺序（首跳→末跳） | 首跳通道/模型 |
|---|---|---|---|---|---|
| 1 | **员工二创**（含 4 个 DeepSeek 创作 Agent） | `api/agent/workflow/stream-run.ts:31` → `contentAgent/index.js:351`（内置视频在 `index.js:272` 调 `transcribeVideo`）；Express：`src/index.js:2148`、`2169` | `config.transcriptProviders`（`config.js:57-68`） | `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`（本地 env `ffmpeg,doubao-video` + 自动 unshift；测试 `tests/content-agent.test.mjs:438`） | flash `volc.bigasr.auc_turbo` → 最后 Ark `doubao-video` 兜底 |
| 2 | **2.2 黄金三秒** 开场口播（scope=`head`，clip 默认 5s） | `api/agent/gold-three-seconds.ts:60`；Express `src/index.js:455` | `config.goldTranscriptProviders`（`goldThreeSecondTranscripts.js:253-256`） | 代码默认：`doubao-file → doubao-video → tikhub-music → tikhub-ffmpeg → ffmpeg`；若按 `.env.example:66` 则是 `ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video` | 默认 **`doubao-file` / `volc.seedasr.auc`（异步 URL）** |
| 3 | **2.3 结尾钩子**（scope=`tail`，`-sseof`） | `api/agent/ending-hooks.ts:58`；Express `src/index.js:646` | 同上 | 同上 | 同上 |
| 4 | **2.4 选题库/近期开更新 完整脚本**（scope=`script`，`clipSeconds:0`；目标为本次筛选出的视频、不受 `goldTranscriptLimit` 限制，见 `benchmark-topic-refresh.ts:34`、`77`） | `api/agent/benchmark-topic-refresh.ts:89`；Express `src/index.js:339` | 同上 | 同上（完整脚本**没有**裁剪，转的是整条视频） | 同上 |
| 5 | **对标账号画像**（前 20 条，scope=head 或 tail） | `api/agent/benchmark-profile.ts:71`（`PROFILE_SAMPLE_LIMIT` 见 `:24`）；Express `src/index.js:810` | 同上 | 同上 | 同上 |
| 6 | 发布仓 3.1 封面拆解（**非 ASR**） | `publishAgents.js:190` → `providers.js:2101` | 直接调 `understandDoubaoImage` | Ark 图片理解（同一 `doubaoVideoModel`） | `doubao-seed-2-0-mini-260428`（image_url） |
| 7 | 复盘 Excel 字段识别（**非 ASR**） | `reviewWorkbookRecognition.js:102` | `runJsonAgent` → DeepSeek | DeepSeek chat/completions（`providers.js:2505`） | `DEEPSEEK_MODEL` 默认 `deepseek-chat`（`config.js:214`） |
| 8 | 管理端客户信息提取（**非 ASR**） | `src/manager/ai.js:80-89` | 独立 DeepSeek 调用（不复用 contentAgent 的 `callDeepSeek`） | DeepSeek `/chat/completions` | `MANAGER_DEEPSEEK_MODEL` 或 `DEEPSEEK_MODEL` 或 `'deepseek-flash'`（`ai.js:87`） |
| 9 | 二创/翻译/改写/分析类 Agent（**非 ASR**） | `providers.js:2565-2582`、`2913`、`3099`、`3116`、`3234-3361` | `callDeepSeek`/`runJsonAgent` | DeepSeek text | `deepseekModel` |

> 补充：员工二创若命中"选题页已提取好的脚本"，会直接复用、**跳过解析与转写**（`contentAgent/index.js:235`、`242-247`）；因此实际 ASR 调用量取决于有多少视频没有预置脚本。

---

## 7. 明确"不是语音识别"的模型调用（避免与 ASR 混淆）

| 调用 | 接口 | 代码位置 | 为什么不是 ASR |
|---|---|---|---|
| `callDeepSeek` | `DEEPSEEK_BASE_URL` + `/chat/completions` | `providers.js:2499-2503`、`2505-2557` | 纯文本 LLM；无音频输入；模型 `deepseek-chat` 默认（`config.js:214`），token 计费 |
| `runJsonAgent` | 同上 + JSON 修复二次调用 | `providers.js:2565-2582` | 文本结构化；复用于复盘表格识别、发布仓 Agent |
| 创作/分析 Agent | 同上 | `providers.js:2913`（二创）、`3099`（翻译）、`3116`（改写）、`3203-3361`（对标/画像/账号方案/黄金三秒/结尾钩子分析） | 输入是转写文本/报告，不是音频 |
| `understandDoubaoImage` | Ark `chat/completions` + `image_url` | `providers.js:2101-2139`；调用方 `publishAgents.js:190` | 图片理解（封面拆解），同一 Ark 模型，但无音频、非 ASR |
| 复盘 Excel 字段识别 | DeepSeek chat/completions（`interfaceName: 'deepseek:review-workbook-recognition'`） | `reviewWorkbookRecognition.js:102` | 表格结构识别，不是语音 |
| 管理端 AI | 独立 DeepSeek 调用 | `src/manager/ai.js:80-89` | 客户沟通纪要 → JSON，不是语音 |
| 出图（星辰/xxcapi OpenAI 兼容） | `imageProvider.js:244-376` | `imageProvider.js` | 文生图，不是语音 |

> 结论：**整个仓库只有一个 ASR 实现文件** `contentAgent/providers.js`（除测试外，全仓 grep `openspeech/bigasr/seedasr` 只命中 config、providers、测试，见 `tests/content-agent.test.mjs:448`、`1184-1212`）。`doubao-video` / `understandDoubaoImage` 与 ASR 共用"豆包"品牌但走不同接口、不同 key、不同计费资源。

---

## 8. 不一致 / 风险清单

> 每条：现象 → 代码证据 → 影响 → 建议核实/修复方向（本次**未改任何代码**）。

**R1（核心）flash 与 file 两套 resource id 未统一，且分别绑定到不同 provider 子集**
- 证据：flash `config.js:138`（`volc.bigasr.auc_turbo`，`providers.js:596`）vs file `config.js:153`（`volc.seedasr.auc`，`providers.js:734`）；调用方分流见 §3.3。
- 影响：同一条视频走 `doubao-file` 与走 `ffmpeg` 会消耗**不同模型资源**；账单上会同时出现两套商品。且两条链的默认顺序不同（员工二创 vs 黄金三秒），"同一个功能看起来都在转写，实际扣的是两套模型"。
- 核实：云侧账单 `Speech_Recognition_Seed_AUC…` 是否只对应 `volc.seedasr.auc`；生产实际走哪条链（R2）。

**R2（核心）黄金三秒链的代码默认值、`.env.example`、HANDOFF 三份不一致，且本地/deploy env 都没覆盖**
- 证据：代码默认 `doubao-file` 第一（`config.js:181`）；`.env.example:66` 与 `HANDOFF.md:2798-2802`、`2821-2824` 写 `ffmpeg` 第一；`apps/server/.env` 与 `.deploy/app.env` 中无 `GOLD_TRANSCRIPT_PROVIDERS`（我用变量名检索确认，未输出值）。
- 影响：接入 `doubao-file`（2026-09-28，`HANDOFF.md:518`）后，**转写量最大的四条链（2.2/2.3/2.4/画像）默认第一跳变为异步文件识别 2.0**，与文档描述相反；每批 60 条 × 多模块，量级可观。
- 核实：生产环境实际 env 是否设置了 `GOLD_TRANSCRIPT_PROVIDERS`；线上镜像/函数版本是否等于工作区代码（HEAD `f9aec22`，`providers.js` 无未提交改动）。

**R3（视频号）`doubao-file` 没有排除视频号加密媒体，与注释/HANDOFF 说法冲突**
- 证据：`pickDoubaoFileAudioSources` 只检查 `http(s)`（`providers.js:680-695`），其注释假设"视频号 `videoUrl` 为 null"（`677-678`）；但 `resolveWeChatChannelsTopicVideo` 返回的 `videoUrl` 就是加密的 `mediaUrl`（`providers.js:312`）；`transcribeVideo` 的 `doubao-file` 分支只判空数组（`2180-2187`），没有 `isWeChatChannelsVideo` 排除（对比 `tikhub-music` 的显式排除 `2253-2260`）。
- 影响：视频号在黄金链（默认 `doubao-file` 第一）下会**先对加密 URL 提交一次文件识别任务**，成功率为 0，失败后才轮到 `ffmpeg`；如果 submit 被接受/计费，会产生无效用量。是否真实发生、是否计费**待 Lead 核实**（HANDOFF 认为视频号"用不了 doubao-file"，`HANDOFF.md:579`、`640`）。
- 建议方向：在 `doubao-file` 分支显式跳过视频号（本次不改）。

**R4（缓存）缓存 key 不含 provider（进程内）/不含 clip 秒数（Mongo），换模型或改裁剪后可能读到旧结果**
- 证据：进程内 key = `id::clipMode`，无 provider（`providers.js:2151`）；Mongo 唯一索引 = `managerId+videoId+scope`（`transcriptStore.js:77`），`scope` 只有 head/tail/script（`25-29`）。
- 影响：① 改 `TRANSCRIPT_PROVIDERS`/`GOLD_TRANSCRIPT_PROVIDERS` 后 1 小时内（`config.js:98`）同实例仍返回旧 provider 文本，账单口径与结果来源不一致；② 改 `GOLD_TRANSCRIPT_CLIP_SECONDS`（`config.js:170`）后，Mongo 里 `scope=head` 的旧 5 秒转写仍会被复用（clip 秒数不进 key），不会报错。
- 建议方向：key 增加 provider/资源 id 与裁剪口径（本次不改）。

**R5（预算/重试）超时预算是"软"的：文件识别可能超出预算；flash 存在双层重试放大**
- 文件识别：预算在循环开头检查（`providers.js:773-789`），随后 `sleep(2s)` + 一次最长 120s 的 query（`config.js:80`、`providers.js:791-801`）→ 实际墙钟可到 `budget+2s+120s`（默认约 242s）；而单批预算只有 `GOLD_TRANSCRIPT_BUDGET_MS=240s`（`config.js:201`），serverless `maxDuration=300s`（`vercel.json:40-41`），且批量预算只在视频之间检查（`goldThreeSecondTranscripts.js:233-241`）。
- flash：外层最多 3 次（`providers.js:956`）+ 内层 `fetchJson` 最多 3 次（`http.js:108-109`）→ 极端情况单条音频最多 9 次计费请求，每次最长 120s。
- 影响：超时/重试可能把批次拖到平台强杀，或在失败路径上产生额外 ASR 调用量。
- 核实：线上日志 `doubao:asr.file.query` 的 `elapsedMs` 与 `DOUBAO_ASR_TIMEOUT` 频率。

**R6（文档）`.env.example` 关于 tikhub-ffmpeg 的实现描述与代码不符**
- 证据：`.env.example:57-59` 称 "tikhub-music / tikhub-ffmpeg 的 ffmpeg 跑在 TikHub 服务端"；代码实际是下载 TikHub CDN 流后**本机 spawn ffmpeg**（`providers.js:1596`、`1883`）。
- 影响：排查"为什么裁剪不生效"时容易误判（真正原因不是"跑在服务端"，而是 `transcribeVideo` 调用该 provider 时没传 `clipSeconds`，`providers.js:2344`）。行为结论（无裁剪）与文档一致，**原因说明错误**。
- 核实：无需动代码，修文档即可（本次不改）。

**R7（可观测性）启动日志不打印黄金链、文件识别 resource id、视频模型**
- 证据：`server.config` 仅含 `transcriptProviders`、`doubaoResourceId`、`doubaoAsrConfigured`、`doubaoVideoConfigured`（`src/index.js:114-125`）；没有 `goldTranscriptProviders`、`doubaoFileAsrResourceId`、`doubaoVideoModel`。
- 影响：线上"到底哪条链、哪个 resource id 在跑"无法从启动日志确认；这正是"账单与预期对不上"最难定位的一类问题。
- 建议方向：启动日志补字段（本次不改）。

**R8（配置模板）三份 env 示例互相漂移，部署模板缺 ASR 变量**
- 证据：`apps/server/.env.example` 含 flash/file/video/黄金三秒全部变量（`50-145`）；`apps/server/src/.env.example`（历史副本）只有 flash/video，**缺** `DOUBAO_FILE_ASR_*`、`GOLD_TRANSCRIPT_*`、`TIKHUB_*_PROVIDER_ENABLED`（`apps/server/src/.env.example:8`、`12-16`）；`deploy/app.env.example` 仅 6 行、**完全没有** ASR/转写变量（`deploy/app.env.example:1-6`，要求"从本地已验证配置复制"，见 `docs/DEPLOY-TENCENT.md:119-126`）。
- 影响：换机器/重建部署时极易漏配，导致"默认值悄悄接管"（例如 R2）。
- 核实：生产 `deploy/app.env` 是否与本地 `.deploy/app.env` 一致。

**R9（配置陷阱）`TRANSCRIPT_PROVIDERS` 白名单静默过滤 + 自动插入依赖 `ffmpeg`**
- 证据：白名单 `config.js:51`；不认识的 provider 静默丢弃（`48-59`）；自动插入条件依赖列表含 `ffmpeg`（`61-67`）。
- 影响：写错名字（如 `doubao_file`）不会报错，链悄悄变短；只写 `doubao-video` 时 TikHub 两个 provider 不会出现。黄金链 `GOLD_TRANSCRIPT_PROVIDERS` 没有白名单，未知名字只会在 provider 循环里记 "Unknown transcript provider"（`providers.js:2465`），不阻断。
- 核实：线上 env 的实际字符串拼写。

**R10（对齐）`.env.example` 注释把 `volc.bigasr.auc` 标为 1.0 历史版本，但默认 file id 是 2.0**
- 证据：`.env.example:135` 注释；`config.js:153` 默认 `volc.seedasr.auc`。
- 影响：若有人手动把 `DOUBAO_FILE_ASR_RESOURCE_ID` 写成 `volc.bigasr.auc`，会落到另一版本/另一商品，且启动日志看不出。
- 核实：生产 env 是否显式设置了该变量（本地/deploy env 未设置 → 默认 2.0）。

**R11（协议猜测点）file ASR 的 `audio.format` 与视频源声明**
- 证据：视频直链声明为 `m4a`（`providers.js:690-692`），注释称服务端"按内容嗅探、不看该字段"（`868-871` 注释）。
- 影响：这是**实测得出的非文档行为**；若服务端行为变化，可能导致 m4a 源失败并回退 mp3 源（多一次 submit）。
- 核实：线上失败日志里 `audioFormat` 与 `DOUBAO_ASR_EMPTY` 比例。

**R12（安全/规范，非账单）ASR 请求的 `user.uid` 用凭据值**
- 证据：`getDoubaoUid` 返回 `doubaoApiKey || doubaoAppKey || "xiaomang-agent"`（`providers.js:615`），随后写入 `user.uid`（`757`、`979`）。
- 影响：凭据值会出现在发往上游的请求体里（上游本来也收到 header，风险有限），但 `uid` 失去业务含义、日志/排障不可读。
- 建议方向：改用固定业务 uid（本次不改）。

---

## 9. 可用于核对"哪条调用走了哪个模型"的现有证据（不改代码）

1. **启动日志**：`server.config.transcriptProviders`（员工二创链）与 `doubaoResourceId`（flash 资源 id）（`src/index.js:114-121`）。⚠️ 不含黄金链与 file 资源 id（R7）。
2. **每条成功转写的 `provider` 字符串**（写入报告，也写 Mongo 的 `provider` 字段，`transcriptStore.js:102`、`126`）：
   - `doubao-file-asr` → **录音文件识别 2.0 / `volc.seedasr.auc`**；
   - `tikhub-music+doubao-asr:mp3`、`tikhub-ffmpeg+doubao-asr:*`、`ffmpeg+doubao-asr:*` → **flash / `volc.bigasr.auc_turbo`**；
   - `doubao-video` → **Ark 多模态**；
   - `preset-script` → 未调用 ASR（`contentAgent/index.js:235`）。
   建议 Lead 按 `gold_three_second_transcripts.provider` 聚合统计（只读查询，本文未执行）。
3. **结构化日志**：
   - flash：`interface: "doubao:asr.flash"`（`providers.js:967`、`989`）；
   - 文件识别：`"doubao:asr.file.submit"` / `"doubao:asr.file.query"`（`753`、`797`、`833`）；
   - Ark 视频理解：`"doubao:video-understanding"`（`2062`）；
   - 编排层：`transcript.provider.start/success/failed/skipped`（`2190`、`2215`、`2230`、`2283`、`2467`）、`transcript.provider.skipped` 带 `reason`（如 `2181-2185`、`2262-2266`、`2270-2274`）；
   - 文件识别音源级：`doubao.file_asr.source_retry_ok` / `source_failed`（`902-923`）。
4. **关键排障字段**：`requestId`（= file ASR 的 task_id，`providers.js:730-735`）、`logid`（响应头 `X-Tt-Logid`，`providers.js:804`、`987`）、`audioSourceKind`（`2219`）。

> ⚠️ 仅在**成功**返回时 `provider` 才落库；失败的 provider 尝试只出现在日志 `warnings`/`transcript.provider.failed` 里。

---

## 10. 待 Lead 核实清单（不臆断，逐条列）

1. **线上部署形态**：生产实际跑 Vercel serverless（`vercel.json`）还是 Docker CVM（`Dockerfile`/`deploy/compose.yml:19`）？两者代码路径一致，但 env 与版本可能不同。
2. **生产 env 实际值**：`GOLD_TRANSCRIPT_PROVIDERS`、`DOUBAO_FILE_ASR_RESOURCE_ID`、`DOUBAO_RESOURCE_ID`、`DOUBAO_VIDEO_MODEL`、`TRANSCRIPT_PROVIDERS` 在云侧/env 平台上的真实取值（仓库内 `.deploy/app.env` 只能代表其中一份同步源）。
3. **部署版本**：线上镜像/函数是否等于当前 HEAD `f9aec22`（`providers.js` 无未提交改动；`contentAgent/index.js`、`src/index.js` 在工作区有未提交修改）。
4. **账单映射**：`Speech_Recognition_Seed_AUC…` 与 `volc.seedasr.auc` 的对应关系、以及 Ark `doubao-seed-2-0-mini-260428` 是否单独计费——需用云侧账单/用量明细确认（代码只能证明"哪些请求带哪个 resource id / 哪个 Ark model"）。
5. **视频号 file ASR**：线上是否真的对加密媒体发出过 file ASR submit、上游是否返回错误码、是否产生计费（R3）。
6. **file ASR 是否产生重复 submit**：多音源重试（`providers.js:873-943`）在真实失败场景下的频率与计费表现。
7. **.env.example vs HANDOFF 的预期链**：哪一份是"预期基线"（决定 R2 是"文档没跟上代码"还是"代码默认值需要改"）。
8. **`HANDOFF.md:518` 的"ASR 换 2.0"范围**：只覆盖黄金链默认值？员工二创是否也要切？

---

## 附录 A：关键常量 / env 默认值速查

| 配置项 | 代码默认 | 证据 |
|---|---|---|
| `DOUBAO_ASR_ENDPOINT` | flash `.../recognize/flash` | `config.js:132-134` |
| `DOUBAO_RESOURCE_ID` | `volc.bigasr.auc_turbo` | `config.js:138` |
| `DOUBAO_FILE_ASR_SUBMIT_URL` / `QUERY_URL` | `.../submit` / `.../query` | `config.js:151-152` |
| `DOUBAO_FILE_ASR_RESOURCE_ID` | `volc.seedasr.auc` | `config.js:153` |
| `DOUBAO_FILE_ASR_POLL_INTERVAL_MS` | 2000 | `config.js:156` |
| `DOUBAO_FILE_ASR_BUDGET_MS` | 120000 | `config.js:157` |
| `DOUBAO_VIDEO_ENDPOINT` | **空串**（未配置则 doubao-video 不可用） | `config.js:158`、`providers.js:2030-2033` |
| `DOUBAO_VIDEO_MODEL` | `doubao-seed-2-0-mini-260428` | `config.js:160` |
| `DOUBAO_VIDEO_AUTH_HEADER` | `Authorization` | `config.js:161` |
| `TRANSCRIPT_PROVIDERS` | `doubao-file,ffmpeg,doubao-video`（再自动插入 TikHub 两 provider） | `config.js:57-68` |
| `GOLD_TRANSCRIPT_PROVIDERS` | `doubao-file,doubao-video,tikhub-music,tikhub-ffmpeg,ffmpeg` | `config.js:181` |
| `GOLD_TRANSCRIPT_CLIP_SECONDS` | 5 | `config.js:170` |
| `GOLD_TRANSCRIPT_ENABLED` / `LIMIT` | true / 60 | `config.js:183`、`185` |
| `GOLD_TRANSCRIPT_BATCH_SIZE` / `CONCURRENCY` / `RESOLVE_CONCURRENCY` / `BUDGET_MS` | 30 / 3 / 8 / 240000 | `config.js:193-201` |
| `AGENT_REQUEST_TIMEOUT_MS`（单次 HTTP 尝试） | 120000 | `config.js:80`、`http.js:124` |
| `AGENT_API_RETRY_ATTEMPTS`（fetchJson 重试次数） | 2（即最多 3 次尝试） | `config.js:85`、`http.js:108-109` |
| `AGENT_TRANSCRIPT_CACHE_TTL_MS` | 3600000（1h） | `config.js:98` |
| `AGENT_RESOLVE_CACHE_TTL_MS` | 1800000（30min） | `config.js:101` |
| `FFMPEG_ENABLED` / `FFMPEG_TIMEOUT_MS` / mp3 上限 / wav 上限 | true / 90000 / 24MB / 20MB | `config.js:103,119,120,124` |
| `ASR_AUDIO_FORMAT` | `auto`（tikhub-ffmpeg 依次 wav→mp3；ffmpeg/provider 固定 mp3；tikhub-music 固定 mp3） | `config.js:123`、`providers.js:1623-1628`、`2397-2398`、`2319` |
| `TIKHUB_TRANSCRIPT_PROVIDER_ENABLED` / `TIKHUB_MUSIC_PROVIDER_ENABLED` | 真 / 真 | `config.js:52`、`56` |
| `TIKHUB_MEDIA_URL_MAX_ATTEMPTS` | 2 | `config.js:125` |
| `DEEPSEEK_MODEL`（非 ASR） | `deepseek-chat` | `config.js:214` |

## 附录 B：凭据配置状态（仅名字 + 是否配置，不输出值）

来源：本地 `apps/server/.env` 与 `.deploy/app.env` 的**变量名检索**（只判断空/非空）。

| 变量 | 本地 `.env` | `.deploy/app.env`（生产同步源之一） |
|---|---|---|
| `DOUBAO_API_KEY`（flash + file ASR 共用） | 已配置 | 已配置 |
| `DOUBAO_APP_KEY` / `DOUBAO_ACCESS_KEY`（备用认证） | 已配置 | 未配置/空 |
| `DOUBAO_VIDEO_API_KEY`（Ark） | 已配置 | 已配置 |
| `TIKHUB_API_TOKEN` | 已配置 | 已配置 |
| `DOUBAO_RESOURCE_ID` | 已显式设置（`volc.bigasr.auc_turbo`） | 已显式设置（同值） |
| `DOUBAO_FILE_ASR_RESOURCE_ID` | 未设置（走默认 `volc.seedasr.auc`） | 未设置（走默认） |
| `GOLD_TRANSCRIPT_PROVIDERS` | 未设置（走代码默认，doubao-file 第一） | 未设置（同上） |
| `TRANSCRIPT_PROVIDERS` | `ffmpeg,doubao-video` | `ffmpeg,doubao-video` |
| `DOUBAO_ASR_ENDPOINT` | 已显式设置（flash 端点） | 已显式设置（同值） |
| `DOUBAO_VIDEO_ENDPOINT` / `DOUBAO_VIDEO_MODEL` | 已设置 / `doubao-seed-2-0-mini-260428` | 已设置 / 同值 |
| `TIKHUB_TRANSCRIPT_PROVIDER_ENABLED` | 未设置（默认 true） | 未设置（默认 true） |
| `TIKHUB_MUSIC_PROVIDER_ENABLED` | `true` | `true` |

> 凭据是否**有效/有余额**（而非仅配置）不在静态审计范围内。
