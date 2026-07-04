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

const getTranscriptProviders = () => {
  const allowed = new Set(["tikhub-ffmpeg", "ffmpeg", "doubao-video"]);
  const enableTikHubProvider = String(process.env.TIKHUB_TRANSCRIPT_PROVIDER_ENABLED || "true").toLowerCase() !== "false";
  const providers = splitCsv(process.env.TRANSCRIPT_PROVIDERS, ["ffmpeg", "doubao-video"])
    .map(normalizeTranscriptProvider)
    .filter(item => allowed.has(item));
  const normalized = providers.length > 0 ? providers : ["ffmpeg", "doubao-video"];
  if (enableTikHubProvider && normalized.includes("ffmpeg") && !normalized.includes("tikhub-ffmpeg")) {
    normalized.unshift("tikhub-ffmpeg");
  }
  return Array.from(new Set(normalized));
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
    tikhubBaseUrl: process.env.TIKHUB_BASE_URL || "https://api.tikhub.dev",
    tikhubApiToken: process.env.TIKHUB_API_TOKEN || "",
    tikhubRegion: process.env.AGENT_VIDEO_REGION || "CN",
    apiRetryAttempts: toInt(process.env.AGENT_API_RETRY_ATTEMPTS, 2),
    apiRetryBaseDelayMs: toInt(process.env.AGENT_API_RETRY_BASE_DELAY_MS, 500),
    creativeAgentRetryAttempts: toInt(process.env.AGENT_CREATIVE_RETRY_ATTEMPTS, 2),
    creativeAgentRetryBaseDelayMs: toInt(process.env.AGENT_CREATIVE_RETRY_BASE_DELAY_MS, 1200),
    transcriptProviders: getTranscriptProviders(),
    transcriptCacheTtlMs: toInt(process.env.AGENT_TRANSCRIPT_CACHE_TTL_MS, 60 * 60 * 1000),
    ffmpegEnabled: String(process.env.FFMPEG_ENABLED || "true").toLowerCase() !== "false",
    ffmpegTimeoutMs: toInt(process.env.FFMPEG_TIMEOUT_MS, 90000),
    ffmpegAudioMaxBytes: toInt(process.env.FFMPEG_AUDIO_MAX_BYTES, 24 * 1024 * 1024),
    ffmpegFastProbeSize: toFfmpegSize(process.env.FFMPEG_FAST_PROBE_SIZE, "1048576"),
    ffmpegFastAnalyzeDuration: toFfmpegSize(process.env.FFMPEG_FAST_ANALYZE_DURATION, "1000000"),
    asrAudioFormat: normalizeAsrAudioFormat(process.env.ASR_AUDIO_FORMAT || "auto"),
    asrWavMaxBytes: toInt(process.env.ASR_WAV_MAX_BYTES, 20 * 1024 * 1024),
    tikhubMediaUrlMaxAttempts: toInt(process.env.TIKHUB_MEDIA_URL_MAX_ATTEMPTS, 6),
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
    doubaoVideoEndpoint: process.env.DOUBAO_VIDEO_ENDPOINT || "",
    doubaoVideoApiKey: process.env.DOUBAO_VIDEO_API_KEY || "",
    doubaoVideoModel: process.env.DOUBAO_VIDEO_MODEL || "doubao-seed-2-0-mini-260428",
    doubaoVideoAuthHeader: process.env.DOUBAO_VIDEO_AUTH_HEADER || "Authorization",
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
    deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
    deepseekTemperature: Number.parseFloat(process.env.DEEPSEEK_TEMPERATURE || "0.7"),
    deepseekMaxTokens: toInt(process.env.DEEPSEEK_MAX_TOKENS, 4096),
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
