export const DEFAULT_MAIN_WORKFLOW_ID = "7618854964156563519";

const splitCsv = (value, fallback = []) => {
  const items = String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
};

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toFfmpegSize = (value, fallback) => {
  const text = String(value || "").trim();
  return /^[1-9]\d*(?:[kKmMgG])?$/.test(text) ? text : fallback;
};

const normalizeAsrAudioFormat = (value) => {
  const format = String(value || "").toLowerCase();
  return ["auto", "mp3", "wav"].includes(format) ? format : "auto";
};

const normalizeTranscriptProvider = (value) => {
  const provider = String(value || "").toLowerCase();
  if (provider === "tikhub") return "tikhub-ffmpeg";
  return provider;
};

const isExplicitTrue = (value) => String(value || "").trim().toLowerCase() === "true";

const isExplicitFalse = (value) => String(value || "").trim().toLowerCase() === "false";

const isLocalDevelopmentEnvironment = () => {
  const environment = String(process.env.NODE_ENV || "").trim().toLowerCase();
  return environment === "" || environment === "development" || environment === "test";
};

const shouldLogTikHubWechatResponses = () => {
  const value = process.env.TIKHUB_WECHAT_RESPONSE_LOG;
  // 仅本地开发默认开启；预发、生产等持久化日志环境必须由运维显式确认。
  return isLocalDevelopmentEnvironment() ? !isExplicitFalse(value) : isExplicitTrue(value);
};

const getTranscriptProviders = () => {
  // ⚠️ 这个集合是**白名单**：TRANSCRIPT_PROVIDERS 里认不出的名字会被静默过滤掉
  //    （不报错，只是不生效）。新增 provider 必须同时加到 providers.js 的分支里，
  //    否则用户配了却看不到任何效果 —— 这类"配了没用"最难查。
  const allowed = new Set(["tikhub-music", "tikhub-ffmpeg", "ffmpeg", "doubao-video", "doubao-file", "doubao-stream"]);
  const enableTikHubProvider = String(process.env.TIKHUB_TRANSCRIPT_PROVIDER_ENABLED || "true").toLowerCase() !== "false";
  // tikhub-music 用 music.play_url mp3 直送 ASR，跳过 ffmpeg 提取（实测快约 12 倍）。
  // 默认开启。music 是纯背景音乐（无人声）时 ASR 返回空，provider 链自动回退到 tikhub-ffmpeg。
  // 如需关闭设 TIKHUB_MUSIC_PROVIDER_ENABLED=false。
  const enableMusicProvider = String(process.env.TIKHUB_MUSIC_PROVIDER_ENABLED || "true").toLowerCase() !== "false";
  // 2026-10-18：默认 ASR 从「录音文件识别 2.0（Seed，按量付费）」换成「流式/实时识别 2.0」
  // （doubao-stream，小时版资源，用户有 20 小时免费额度）。
  // 同日第二次调整：**默认链里的极速版 flash 段（tikhub-music / tikhub-ffmpeg / ffmpeg）
  // 全部换成「豆包录音文件识别模型 2.0」（doubao-file → volc.seedasr.auc，异步 submit/query）。
  // 三个 flash provider 的代码与白名单**保留**（回滚/手动配置时仍可用），但默认不再进链。
  const providers = splitCsv(process.env.TRANSCRIPT_PROVIDERS, ["doubao-stream", "doubao-file", "doubao-video"])
    .map(normalizeTranscriptProvider)
    .filter(item => allowed.has(item));
  const normalized = providers.length > 0 ? providers : ["doubao-stream", "doubao-file", "doubao-video"];
  // 🔴 计费/免费额度通道（doubao-stream / doubao-file）如果被**显式写在链首**，保持它在链首：
  //    TikHub 的自动 unshift 只对后面的 flash 段生效。否则 `TRANSCRIPT_PROVIDERS=doubao-stream,...`
  //    会被静默改成「tikhub-music → tikhub-ffmpeg → doubao-stream ...」——前两个先走 flash，
  //    "优先用免费流式额度"的配置等于没写（2026-10-18 迁移时踩过）。
  const preferredPrefix = [];
  while (normalized.length > 0 && (normalized[0] === "doubao-stream" || normalized[0] === "doubao-file")) {
    preferredPrefix.push(normalized.shift());
  }
  if (enableTikHubProvider && normalized.includes("ffmpeg") && !normalized.includes("tikhub-ffmpeg")) {
    normalized.unshift("tikhub-ffmpeg");
  }
  // tikhub-music 插入链首（优先于 tikhub-ffmpeg），ASR 返回空时自动回退
  if (enableMusicProvider && normalized.includes("tikhub-ffmpeg") && !normalized.includes("tikhub-music")) {
    normalized.unshift("tikhub-music");
  }
  return Array.from(new Set([...preferredPrefix, ...normalized]));
};

export const getContentAgentConfig = () => {
  const mainWorkflowId =
    process.env.AGENT_CONTENT_WORKFLOW_ID ||
    DEFAULT_MAIN_WORKFLOW_ID;

  return {
    provider: "agent",
    mainWorkflowId,
    maxLinksPerRun: toInt(process.env.AGENT_MAX_LINKS_PER_RUN, 5),
    requestTimeoutMs: toInt(process.env.AGENT_REQUEST_TIMEOUT_MS, 120000),
    tikhubBaseUrl: process.env.TIKHUB_BASE_URL || "https://api.tikhub.io",
    tikhubApiToken: process.env.TIKHUB_API_TOKEN || "",
    tikhubWechatResponseLogEnabled: shouldLogTikHubWechatResponses(),
    tikhubRegion: process.env.AGENT_VIDEO_REGION || "CN",
    apiRetryAttempts: toInt(process.env.AGENT_API_RETRY_ATTEMPTS, 2),
    apiRetryBaseDelayMs: toInt(process.env.AGENT_API_RETRY_BASE_DELAY_MS, 500),
    creativeAgentRetryAttempts: toInt(process.env.AGENT_CREATIVE_RETRY_ATTEMPTS, 2),
    creativeAgentRetryBaseDelayMs: toInt(process.env.AGENT_CREATIVE_RETRY_BASE_DELAY_MS, 1200),
    // 通用 Agent 重试：给分类分析、黄金三秒这类「一次调用出一份报告」的 Agent 用。
    // 它们原先没有重试，一次瞬时故障就直接掉进规则兜底，用户看到的就是「Agent 曾发生异常」。
    agentRetryAttempts: toInt(process.env.AGENT_RETRY_ATTEMPTS, 2),
    agentRetryBaseDelayMs: toInt(process.env.AGENT_RETRY_BASE_DELAY_MS, 1500),
    // 重试总预算。单次 HTTP 超时就有 AGENT_REQUEST_TIMEOUT_MS=120s，
    // 而 serverless 函数的 maxDuration 也是 120s：没有这个预算守卫，
    // 重试会把函数拖到被平台强杀，那样连兜底报告都拿不到，比直接降级更糟。
    agentRetryBudgetMs: toInt(process.env.AGENT_RETRY_BUDGET_MS, 90000),
    transcriptProviders: getTranscriptProviders(),
    transcriptCacheTtlMs: toInt(process.env.AGENT_TRANSCRIPT_CACHE_TTL_MS, 60 * 60 * 1000),
    // TikHub 解析缓存：2.2 与 2.3 跑同一批视频的同一个 link，解析（3.4~4.7s/条）是纯重复劳动。
    // TTL 比转写缓存短，因为 CDN 直链会过期（拿到过期直链会让下载 403/404）。设 0 可关闭。
    resolveCacheTtlMs: toInt(process.env.AGENT_RESOLVE_CACHE_TTL_MS, 30 * 60 * 1000),
    resolveCacheMaxEntries: toInt(process.env.AGENT_RESOLVE_CACHE_MAX_ENTRIES, 500),
    ffmpegEnabled: String(process.env.FFMPEG_ENABLED || "true").toLowerCase() !== "false",
    /**
     * ffmpeg 单个进程的硬上限 —— 它同时兜住**下载 + 抽音频**，是这条链路唯一的卡死保护。
     *
     * 🔴 **别想当然调低。** 2026-09-28 实测（本机、真实抖音视频、完整脚本口径）：
     *      57 秒的视频  → 64.3s
     *      103 秒的视频 → 90.2s   ← 已经贴着 90s 上限，余量只有 1.0x
     *    当时我建议"调到 30~45 秒让卡死快速失败"，实测证明那是错的：正常视频
     *    都会直接超时，然后回退到下一个 provider 再失败一遍 —— **比不调更低效**。
     *
     * 为什么 90s 才够：这道超时覆盖的是「CDN 下载整条视频 + 抽 16k 单声道音频」。
     * 抖音 CDN 实测只有 1~2MB/s，而视频越大需要的时间近似随时长线性增长。
     *
     * 想调之前先量：`FFMPEG_TIMEOUT_MS` 设成小于实测值就等于让正常视频失败。
     * 真要降，得先解决下载慢（本地解密/缓存）或换更快的抽取方式，而不是砍超时。
     */
    ffmpegTimeoutMs: toInt(process.env.FFMPEG_TIMEOUT_MS, 90000),
    ffmpegAudioMaxBytes: toInt(process.env.FFMPEG_AUDIO_MAX_BYTES, 24 * 1024 * 1024),
    ffmpegFastProbeSize: toFfmpegSize(process.env.FFMPEG_FAST_PROBE_SIZE, "4194304"),
    ffmpegFastAnalyzeDuration: toFfmpegSize(process.env.FFMPEG_FAST_ANALYZE_DURATION, "3000000"),
    asrAudioFormat: normalizeAsrAudioFormat(process.env.ASR_AUDIO_FORMAT || "auto"),
    asrWavMaxBytes: toInt(process.env.ASR_WAV_MAX_BYTES, 20 * 1024 * 1024),
    tikhubMediaUrlMaxAttempts: toInt(process.env.TIKHUB_MEDIA_URL_MAX_ATTEMPTS, 2),
    // TikHub CDN 媒体下载大小预警阈值（仅日志，不硬拒绝）。
    // 超过此值的文件会被标记为「超大」，配合 URL 按大小排序，确保只有小文件全失败时才回退到大文件。
    tikhubMediaLargeBytes: toInt(process.env.TIKHUB_MEDIA_LARGE_BYTES, 50 * 1024 * 1024),
    mediaProxyUrl: process.env.TIKTOK_MEDIA_PROXY_URL || process.env.TIKHUB_MEDIA_PROXY_URL || process.env.MEDIA_PROXY_URL || "",
    mediaUseEnvProxy: String(process.env.MEDIA_USE_ENV_PROXY || "true").toLowerCase() !== "false",
    wechatMediaMaxBytes: toInt(process.env.WECHAT_CHANNELS_MEDIA_MAX_BYTES, 220 * 1024 * 1024),
    doubaoAsrEndpoint:
      process.env.DOUBAO_ASR_ENDPOINT ||
      "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    doubaoApiKey: process.env.DOUBAO_API_KEY || "",
    doubaoAppKey: process.env.DOUBAO_APP_KEY || "",
    doubaoAccessKey: process.env.DOUBAO_ACCESS_KEY || "",
    doubaoResourceId: process.env.DOUBAO_RESOURCE_ID || "volc.bigasr.auc_turbo",
    // ── 豆包录音文件识别模型 2.0（异步 submit + 轮询 query）─────────────────
    // 与上面的 flash 同步接口是**两条独立通道**：
    //   flash（默认端点 /recognize/flash）：客户端把音频 base64 传上去，同步返回。
    //   文件识别（本组）：只传**音频 URL**，服务端自己去拉，任务异步，要轮询取结果。
    //
    // 用它的最大好处是**不需要本地 ffmpeg**：直接把 CDN 上的 mp3/mp4 地址交给服务端，
    // 省掉「下载整个视频 + 本地抽音频」（实测 ffmpeg 全量提取 45s，而这条路约 10s）。
    //
    // 🔴 但它是异步任务，官方口径「任务通常在 3 小时内完成，高峰期可能延迟」——
    //    延迟不可控是本条通道最大的风险。所以下面有轮询上限与超时，
    //    **超时就当作这个 provider 失败**，由 provider 链自然回退到别的方案，
    //    绝不让一条视频把整个批次挂死。
    doubaoFileAsrSubmitUrl: process.env.DOUBAO_FILE_ASR_SUBMIT_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
    doubaoFileAsrQueryUrl: process.env.DOUBAO_FILE_ASR_QUERY_URL || "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
    doubaoFileAsrResourceId: process.env.DOUBAO_FILE_ASR_RESOURCE_ID || "volc.seedasr.auc",
    // 轮询间隔与总预算。实测一条 57 秒的视频约 10 秒出结果，默认预算给到 120 秒足够宽裕；
    // 超过就走回退，不要在这条路上无限等。
    doubaoFileAsrPollIntervalMs: toInt(process.env.DOUBAO_FILE_ASR_POLL_INTERVAL_MS, 2000),
    doubaoFileAsrBudgetMs: toInt(process.env.DOUBAO_FILE_ASR_BUDGET_MS, 120000),
    // ── 豆包流式/实时语音识别 2.0（WebSocket，2026-10-18 接入）─────────────
    // 为什么换：用户账户里「录音文件识别 2.0（Seed，volc.seedasr.auc）」已转正式版、
    // 按量后付费（¥4.5/小时量级）；而流式识别 2.0 小时版还有 20 小时免费额度。
    // 协议要点（已用官方 Python/Java/Go SDK + 真实 API 验证）：
    //   · 两端 WebSocket，二进制帧 + gzip payload，不是裸 JSON；
    //   · 资源 id 用「小时版」volc.seedasr.sauc.duration（按音频时长扣免费额度/计费），
    //     并发版 volc.seedasr.sauc.concurrent 按并发计费，不适合本项目；
    //   · 客户端可以**全速发送**（不必须按 200ms 实时节拍），实测 26.8s 音频约 2.6s 拿到
    //     最终结果，所以批量转写不会被拖成"视频多长就等多久"。
    // 音频由 ffmpeg 抽成 16k 单声道 s16le PCM 后整段发送，因此 head/tail 裁剪对这条通道**有效**。
    doubaoStreamAsrUrl:
      process.env.DOUBAO_STREAM_ASR_URL ||
      "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
    doubaoStreamAsrResourceId:
      process.env.DOUBAO_STREAM_ASR_RESOURCE_ID || "volc.seedasr.sauc.duration",
    // 单个 WebSocket 会话的总预算；超时即失败，交给 provider 链回退。
    doubaoStreamAsrBudgetMs: toInt(process.env.DOUBAO_STREAM_ASR_BUDGET_MS, 120000),
    // 每个音频包字节数：16k×16bit×单声道 = 32000 B/s，6400 B = 200ms（与官方 SDK 对齐）。
    doubaoStreamAsrChunkBytes: toInt(process.env.DOUBAO_STREAM_ASR_CHUNK_BYTES, 6400),
    doubaoVideoEndpoint: process.env.DOUBAO_VIDEO_ENDPOINT || "",
    doubaoVideoApiKey: process.env.DOUBAO_VIDEO_API_KEY || "",
    doubaoVideoModel: process.env.DOUBAO_VIDEO_MODEL || "doubao-seed-2-0-mini-260428",
    doubaoVideoAuthHeader: process.env.DOUBAO_VIDEO_AUTH_HEADER || "Authorization",
    // 黄金三秒的真实口播转写。复用员工二创那套 ASR / 视频理解能力
    // （provider 链见 transcriptProviders）。
    //
    // 2026-09-17：黄金三秒改成对全部 60 条做分析，而完整转写实测一条约 89 秒
    // （其中「下载/解码整条视频」占大头），60 条根本跑不完。
    // 但只要**开场 3 秒**的话没必要转整条 —— 下面这个 clip 让 ffmpeg 只取开头
    // 一小段音频（`-t N`，见 buildFfmpegAudioExtractArgs），提取和 ASR 都随之变快。
    // 2026-10-18 起 doubao-stream 走「本地 ffmpeg → PCM」，所以这条裁剪对新的流式通道
    // 同样生效；只有 doubao-file / doubao-video 这类把整段音频交给服务端的通道才忽略它。
    // 只对黄金三秒/结尾钩子/对标画像生效：员工二创链路要完整转写，不要给它传这个值。
    goldTranscriptClipSeconds: toInt(process.env.GOLD_TRANSCRIPT_CLIP_SECONDS, 5),
    // 黄金三秒**专用**的 provider 顺序。
    //
    // 2026-10-18：首位从「录音文件识别 2.0（doubao-file）」换成「流式识别 2.0（doubao-stream）」。
    // 流式通道会先用本地 ffmpeg 把音频抽成 16k PCM，所以 **goldTranscriptClipSeconds 的裁剪
    // 对 doubao-stream 也生效**（head 只转开头 5 秒、tail 只转结尾 5 秒），不会因为换模型
    // 又变成"整条视频都计费"。
    // 同日第二次调整：链尾的极速版 flash 段（tikhub-music / tikhub-ffmpeg / ffmpeg）整体换成
    // 「录音文件识别 2.0」（doubao-file，只收音频 URL，异步 submit/query），保持"主通道失败后
    // 至少还有一条 URL 直取的 2.0 兜底"；三个 flash provider 保留在代码里，回滚时可手动放回。
    //
    // 显式传这个顺序还会关掉「有 TikHub 就跳过本地 ffmpeg」那条隐式优化（见 transcribeVideo），
    // 否则顺序会被静默改回 TikHub 优先。
    // 回滚到 flash 兜底：GOLD_TRANSCRIPT_PROVIDERS=doubao-stream,doubao-video,tikhub-music,tikhub-ffmpeg,ffmpeg
    goldTranscriptProviders: splitCsv(process.env.GOLD_TRANSCRIPT_PROVIDERS, ["doubao-stream", "doubao-video", "doubao-file"]),
    // 设为 false 可整体关掉黄金三秒的转写，回到纯发布文案的行为。
    goldTranscriptEnabled: String(process.env.GOLD_TRANSCRIPT_ENABLED || "true").toLowerCase() !== "false",
    // 转写覆盖多少条 —— 与分析样本数（60）保持一致，否则部分大类只能靠发布文案推断。
    goldTranscriptLimit: toInt(process.env.GOLD_TRANSCRIPT_LIMIT, 60),
    // 每个请求处理几条。
    //
    // 2026-09-17：从 3 放大到 30。原来 3 是**裁剪之前**定的 —— 那时完整转写 89s/条，
    // 240s 预算只装得下 3 条。裁剪后单条 ~1.7s，60 条还要跑 20 轮，
    // **每轮的固定开销（鉴权 + 2 次进度查询 + 往返）已经和实际工作同一量级**。
    // 30 条约需 (30 × 1.7 / 并发 3) ≈ 17s，240s 预算远远用不完，轮数 20 → 2。
    // 单条变慢时预算守卫会提前收尾并返回 partial progress，前端会接着驱动下一批。
    goldTranscriptBatchSize: toInt(process.env.GOLD_TRANSCRIPT_BATCH_SIZE, 30),
    goldTranscriptConcurrency: toInt(process.env.GOLD_TRANSCRIPT_CONCURRENCY, 3),
    // TikHub 解析的预取宽度（与转写并发解耦）。
    // 解析实测 3.4~4.7s/条、比裁剪后的转写还慢，所以给它更宽的通道提前跑，
    // 转写 worker 直接取现成的结果。设 0 退回「解析和转写串行」的老行为。
    goldTranscriptResolveConcurrency: toInt(process.env.GOLD_TRANSCRIPT_RESOLVE_CONCURRENCY, 8),
    // 单批转写的总预算。必须明显小于该端点的 serverless maxDuration（300s），
    // 否则函数会被平台强杀，这一批的转写结果全部丢失。
    goldTranscriptBudgetMs: toInt(process.env.GOLD_TRANSCRIPT_BUDGET_MS, 240000),
    // 对标视频「高赞评论」抓取。TikHub 评论接口**按次计费**，所以抓过的视频永久落库
    // （commentStore.js），下面这些参数只决定「一次请求抓多少、跑多快」。
    // 每个请求处理几个视频（与转写同理：批太小，每轮的固定开销就和实际工作同一量级）。
    benchmarkCommentBatchSize: toInt(process.env.BENCHMARK_COMMENT_BATCH_SIZE, 10),
    // 每个视频按点赞降序保留多少条评论 —— 也就是「最被认同的几条」。
    benchmarkCommentLimitPerVideo: toInt(process.env.BENCHMARK_COMMENT_LIMIT_PER_VIDEO, 30),
    benchmarkCommentConcurrency: toInt(process.env.BENCHMARK_COMMENT_CONCURRENCY, 4),
    // 单批抓取的总预算。必须明显小于该端点的 serverless maxDuration（300s），
    // 否则函数会被平台强杀 —— 在途的付费请求结果会跟着一起丢。
    benchmarkCommentBudgetMs: toInt(process.env.BENCHMARK_COMMENT_BUDGET_MS, 240000),
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
    deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    deepseekTemperature: Number.parseFloat(process.env.DEEPSEEK_TEMPERATURE || "0.7"),
    // DeepSeek 允许的 max_tokens 上限是 393216（实测 API 报错信息为 [1, 393216]）。
    // 当前用的是推理模型（deepseek-flash），思考 token 计入 max_tokens：上限给小了会
    // 出现「思考吃满预算 → message.content 为空 → DEEPSEEK_EMPTY → 直接掉规则兜底」。
    // 这里只是上限，模型正常结束不会真的用到，调高不额外花钱。
    deepseekMaxTokens: toInt(process.env.DEEPSEEK_MAX_TOKENS, 393216),
    useDeepseekJsonMode: String(process.env.DEEPSEEK_USE_RESPONSE_FORMAT || "true").toLowerCase() !== "false",
  };
};

export const isMainContentWorkflow = (body, config = getContentAgentConfig()) => {
  const workflowId = String(body?.workflow_id || body?.workflowId || "").trim();
  return Boolean(workflowId && config.mainWorkflowId && workflowId === config.mainWorkflowId);
};

export const shouldUseContentAgent = (body, config = getContentAgentConfig()) => {
  return isMainContentWorkflow(body, config);
};
