import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { Transform } from "stream";
import { Readable } from "stream";
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import {
  AgentError,
  appendQuery,
  cleanModelText,
  extractFirstJsonObjectText,
  fetchJson,
  safeJsonParse,
  retryDelayMs,
  sleep,
  withTimeout,
} from "./http.js";
import {
  DOUBAO_VIDEO_TRANSCRIPT_PROMPT,
  ENDING_HOOK_PROMPT,
  OPENING_HOOK_PROMPT,
  SCRIPT_REWRITE_PROMPT,
  TITLE_PROMPT,
} from "./prompts.js";
import { normalizeEndingHook, normalizeOpeningHook, parseJsonAgentOutput } from "./adapter.js";
import { generateKeystream } from "./vendor/wechatKeystream.mjs";

const transcriptCache = new Map();

// 视频号 Isaac64 加密仅作用于文件前 KEYSTREAM_SIZE 字节，其余为明文。
// KEYSTREAM_SIZE 同时也是密钥流长度（见 vendor/wechatKeystream.mjs）。
const WECHAT_KEYSTREAM_SIZE = 131072;

const isObject = value => value && typeof value === "object" && !Array.isArray(value);

const compactDetails = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const mediaProxyDispatchers = new Map();

const hasEnvProxy = () => Boolean(
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy,
);

const getMediaFetchDispatcher = (config = {}) => {
  const proxyUrl = String(config.mediaProxyUrl || "").trim();
  if (proxyUrl) {
    const cacheKey = `proxy:${proxyUrl}`;
    if (!mediaProxyDispatchers.has(cacheKey)) {
      mediaProxyDispatchers.set(cacheKey, new ProxyAgent(proxyUrl));
    }
    return mediaProxyDispatchers.get(cacheKey);
  }
  if (config.mediaUseEnvProxy && hasEnvProxy()) {
    const cacheKey = "env";
    if (!mediaProxyDispatchers.has(cacheKey)) {
      mediaProxyDispatchers.set(cacheKey, new EnvHttpProxyAgent());
    }
    return mediaProxyDispatchers.get(cacheKey);
  }
  return null;
};

const fetchErrorDetails = error => ({
  reason: error instanceof Error ? error.message : "Media stream failed",
  causeName: error?.cause?.name,
  causeCode: error?.cause?.code,
  causeMessage: error?.cause?.message,
});

const collectStrings = (value, out = [], path = "", depth = 0) => {
  if (depth > 8 || out.length > 2500) return out;
  if (typeof value === "string") {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, out, `${path}[${index}]`, depth + 1));
    return out;
  }
  if (isObject(value)) {
    Object.entries(value).forEach(([key, item]) => {
      collectStrings(item, out, path ? `${path}.${key}` : key, depth + 1);
    });
  }
  return out;
};

const firstByPath = (payload, pathRegexes, valuePredicate = () => true) => {
  const strings = collectStrings(payload);
  const found = strings.find(item =>
    pathRegexes.some(regex => regex.test(item.path)) && valuePredicate(item.value),
  );
  return found?.value || "";
};

const uniqueStrings = values => Array.from(new Set(
  values
    .map(value => String(value || "").trim())
    .filter(Boolean),
));

const isHttpUrl = value => /^https?:\/\//i.test(String(value || ""));

export const isDirectMp4Url = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    return /^https?:$/i.test(parsed.protocol) && /\.mp4$/i.test(parsed.pathname);
  } catch {
    return false;
  }
};

// 识别 CDN 直链（TikTok/抖音的真实视频流）。
// 这类 URL 可能不以 .mp4 结尾，但域名/路径能表明它是实际媒体流。
const isCdnDirectVideoUrl = value => {
  const text = String(value || "");
  if (!isHttpUrl(text)) return false;
  if (/\.(jpe?g|png|webp|gif|heic|heif|avif)(\?|$)/i.test(text)) return false;
  if (/(tos-[^/?]*-avt-|avatar|cropcenter|cover|image|img|tplv-tiktokx-cropcenter)/i.test(text)) return false;
  return /(tiktokcdn|\.bytecdn|\.byteimg|douyincdn|\.akamaized|\/video\/tos\/|\/tos\/(alisg|useast|cvb))/i.test(text);
};

export const describeVideoUrlForDiagnostics = (value) => {
  const text = String(value || "");
  try {
    const parsed = new URL(text);
    let kind = "http-url";
    if (isDirectMp4Url(text)) {
      kind = "direct-mp4";
    } else if (isCdnDirectVideoUrl(text)) {
      kind = "cdn-direct-video";
    } else if (/\/aweme\/v1\/play/i.test(parsed.pathname)) {
      kind = "douyin-aweme-play-api";
    } else if (parsed.searchParams.has("video_id")) {
      kind = "video-id-play-url";
    } else if (/douyin/i.test(parsed.hostname) && /play/i.test(text)) {
      kind = "douyin-play-url";
    }

    return {
      kind,
      host: parsed.host,
      path: parsed.pathname,
      queryKeys: Array.from(parsed.searchParams.keys()).slice(0, 12).join(","),
      isDirectMp4: isDirectMp4Url(text),
    };
  } catch {
    return {
      kind: text ? "invalid-url" : "empty",
      host: "",
      path: text.slice(0, 120),
      queryKeys: "",
      isDirectMp4: false,
    };
  }
};

const isImageUrl = value => {
  const text = String(value || "");
  return isHttpUrl(text) && /(douyinpic|cover|image|img|jpeg|jpg|png|webp|tplv-dy-360p)/i.test(text);
};

const isVideoUrl = value => {
  const text = String(value || "");
  if (!isHttpUrl(text)) return false;
  if (/\/user\//i.test(text)) return false;
  if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(text)) return false;
  return /(\.mp4(\?|$)|\/aweme\/v1\/play|video_id=|play_addr|download_addr|douyin.*play)/i.test(text);
};

const isWeChatChannelsVideo = (videoMeta) =>
  videoMeta?.platform === "wechat_channels" ||
  videoMeta?.source?.platform === "wechat_channels" ||
  Boolean(videoMeta?.decodeKey && videoMeta?.videoUrl);

const wechatTopicKey = (topic = {}) => {
  const source = topic?.source || {};
  const rawData = topic?.rawData || {};
  const objectId =
    source.objectId ||
    rawData.id ||
    rawData.object_id ||
    rawData.objectId ||
    topic.id ||
    source.objectNonceId ||
    rawData.object_nonce_id ||
    rawData.objectNonceId ||
    "";
  return `wechat_channels:${String(objectId || topic.title || "topic").replace(/^wechat_channels:/, "")}`;
};

export const resolveWeChatChannelsTopicVideo = (topic = {}) => {
  const source = topic?.source || {};
  const rawData = topic?.rawData || {};
  const media = rawData?.media || {};
  const videoUrl = String(source.mediaUrl || media.full_url || media.url || "").trim();
  const decodeKey = String(source.decodeKey || media.decode_key || "").trim();
  const title = String(topic.title || rawData.desc || rawData.title?.[0]?.shortTitle || rawData.nickname || "未识别标题").trim();
  const cover = String(source.coverUrl || topic.coverUrl || media.cover_url || rawData.cover_img_url || "").trim();

  if (!videoUrl) {
    throw new AgentError("WeChat Channels topic is missing mediaUrl", {
      code: "WECHAT_MEDIA_URL_MISSING",
      status: 400,
      details: { topicId: topic.id, title },
    });
  }
  if (!decodeKey) {
    throw new AgentError("WeChat Channels topic is missing decodeKey", {
      code: "WECHAT_DECODE_KEY_MISSING",
      status: 400,
      details: { topicId: topic.id, title },
    });
  }

  return {
    shareLink: wechatTopicKey(topic),
    awemeId: wechatTopicKey(topic),
    platform: "wechat_channels",
    title,
    cover,
    videoUrl,
    decodeKey,
    source,
    raw: rawData || topic,
  };
};

const parseAwemeIdFromShareLink = (shareLink) => {
  try {
    const parsed = new URL(shareLink);
    return parsed.searchParams.get("modal_id") || parsed.searchParams.get("aweme_id") || "";
  } catch {
    return "";
  }
};

const extractAwemeId = (payload, shareLink) => {
  return (
    firstByPath(payload, [/aweme[_-]?id$/i, /item[_-]?id$/i], value => /^\d{8,}$/.test(value)) ||
    parseAwemeIdFromShareLink(shareLink)
  );
};

const extractVideoMeta = (payload, shareLink) => {
  const data = payload?.data ?? payload;
  const strings = collectStrings(data);
  const title =
    firstByPath(
      data,
      [/(^|\.)desc$/i, /(^|\.)title$/i, /(^|\.)description$/i, /(^|\.)caption$/i],
      value => value.length > 0 && value.length < 600 && !isHttpUrl(value),
    ) || "";
  const cover = strings.find(item => isImageUrl(item.value))?.value || "";
  // URL 选择优先级：
  //   1. .mp4 直链（最稳，ffmpeg/doubao 都能直接用）
  //   2. CDN 直链（tiktokcdn/bytecdn 等真实视频流，TikTok 常见，不以 .mp4 结尾但可访问）
  //   3. play_addr/download_addr 里的跳转链接（含 aweme/v1/play，部分场景可用作兜底）
  const preferredPaths = [/original_video_url$/i, /video_url$/i, /play_addr/i, /download_addr/i, /url_list/i];
  const pathMatches = item => preferredPaths.some(regex => regex.test(item.path));
  const videoUrls = uniqueStrings([
    ...strings.filter(item => pathMatches(item) && isDirectMp4Url(item.value)).map(item => item.value),
    ...strings.filter(item => isDirectMp4Url(item.value)).map(item => item.value),
    ...strings.filter(item => pathMatches(item) && isCdnDirectVideoUrl(item.value)).map(item => item.value),
    ...strings.filter(item => isCdnDirectVideoUrl(item.value)).map(item => item.value),
    ...strings.filter(item => pathMatches(item) && isVideoUrl(item.value)).map(item => item.value),
    ...strings.filter(item => isVideoUrl(item.value)).map(item => item.value),
  ]);
  const videoUrl = videoUrls[0] || "";

  return {
    awemeId: extractAwemeId(data, shareLink),
    title,
    cover,
    videoUrl,
    videoUrls,
    raw: data,
  };
};

const mergeMeta = (base, next, options = {}) => {
  const preferVideo = Boolean(options.preferVideo);
  const videoUrls = uniqueStrings([
    ...(preferVideo ? next.videoUrls || [] : base.videoUrls || []),
    ...(preferVideo ? base.videoUrls || [] : next.videoUrls || []),
    next.videoUrl,
    base.videoUrl,
  ]);
  return {
    ...base,
    awemeId: base.awemeId || next.awemeId || "",
    title: base.title || next.title || "",
    cover: base.cover || next.cover || "",
    videoUrl: preferVideo ? next.videoUrl || base.videoUrl || "" : base.videoUrl || next.videoUrl || "",
    videoUrls,
    raw: base.raw || next.raw || null,
  };
};

const fetchTikHub = async (path, params, config, logger) => {
  if (!config.tikhubApiToken) {
    throw new AgentError("Missing TIKHUB_API_TOKEN", { code: "TIKHUB_TOKEN_MISSING", status: 500 });
  }
  const url = appendQuery(`${config.tikhubBaseUrl.replace(/\/$/, "")}${path}`, params);
  const { data } = await fetchJson(url, {
    timeoutMs: config.requestTimeoutMs,
    retries: config.apiRetryAttempts,
    retryBaseDelayMs: config.apiRetryBaseDelayMs,
    logger,
    interfaceName: `tikhub:${path}`,
    headers: {
      Authorization: `Bearer ${config.tikhubApiToken}`,
    },
  });
  return data;
};

// 按 platform 构造 TikHub 端点轮询列表。
// 抖音与 TikTok 的端点路径不同，但请求参数与返回字段结构一致（同为 aweme 协议），
// 故 extractVideoMeta 的通用递归提取逻辑可同时服务两者。
export const buildTikHubVideoAttempts = (shareLink, platform, config) => {
  if (platform === "tiktok") {
    // TikTok：实测仅 fetch_one_video_by_share_url 有效（返回含 play_addr CDN 直链），
    // fetch_video_high_quality_play_url / web 系列端点均 404，故不列入。
    return [
      {
        path: "/api/v1/tiktok/app/v3/fetch_one_video_by_share_url",
        params: { share_url: shareLink },
        preferVideo: true,
      },
    ];
  }
  // 默认抖音：混合端点 + douyin app/web 端点
  return [
    {
      path: "/api/v1/hybrid/video_data",
      params: { url: shareLink, minimal: false },
      preferVideo: false,
    },
    {
      path: "/api/v1/douyin/app/v3/fetch_one_video_by_share_url",
      params: { share_url: shareLink },
      preferVideo: false,
    },
    {
      path: "/api/v1/douyin/web/fetch_one_video_by_share_url",
      params: { share_url: shareLink },
      preferVideo: false,
    },
    {
      path: "/api/v1/douyin/web/fetch_video_high_quality_play_url",
      params: { share_url: shareLink, region: config.tikhubRegion },
      preferVideo: true,
    },
    {
      path: "/api/v1/douyin/app/v3/fetch_video_high_quality_play_url",
      params: { share_url: shareLink, region: config.tikhubRegion },
      preferVideo: true,
    },
  ];
};

export const resolveTikHubVideo = async (shareLink, config, options = {}) => {
  const logger = options.logger;
  const platform = options.platform === "tiktok" ? "tiktok" : "douyin";
  let meta = {
    shareLink,
    platform,
    awemeId: parseAwemeIdFromShareLink(shareLink),
    title: "",
    cover: "",
    videoUrl: "",
    videoUrls: [],
    raw: null,
  };
  const warnings = [];

  const attempts = buildTikHubVideoAttempts(shareLink, platform, config);

  for (const attempt of attempts) {
    try {
      const payload = await fetchTikHub(attempt.path, attempt.params, config, logger);
      meta = mergeMeta(meta, extractVideoMeta(payload, shareLink), { preferVideo: attempt.preferVideo });
      if (meta.title && meta.cover && meta.videoUrl && attempt.preferVideo) break;
    } catch (error) {
      warnings.push({
        provider: "tikhub",
        step: attempt.path,
        message: error instanceof Error ? error.message : "TikHub request failed",
      });
    }
  }

  if (!meta.videoUrl) {
    throw new AgentError("Unable to resolve playable video URL from TikHub", {
      code: "VIDEO_URL_MISSING",
      details: warnings,
    });
  }

  logger?.info("tikhub.video.resolved", {
    provider: "tikhub",
    title: meta.title || "未识别标题",
    awemeId: meta.awemeId,
    candidateCount: Array.isArray(meta.videoUrls) ? meta.videoUrls.length : 0,
    ...describeVideoUrlForDiagnostics(meta.videoUrl),
  });

  return {
    ...meta,
    sourceProvider: "tikhub",
    title: meta.title || "未识别标题",
    cover: meta.cover || "",
    warnings,
  };
};

const buildDoubaoAsrHeaders = (config, options = {}) => {
  const headers = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": config.doubaoResourceId,
    "X-Api-Request-Id": options.requestId || randomUUID(),
  };
  if (options.sequence) headers["X-Api-Sequence"] = options.sequence;

  if (config.doubaoApiKey) {
    headers["X-Api-Key"] = config.doubaoApiKey;
    return headers;
  }

  if (config.doubaoAppKey && config.doubaoAccessKey) {
    headers["X-Api-App-Key"] = config.doubaoAppKey;
    headers["X-Api-Access-Key"] = config.doubaoAccessKey;
    return headers;
  }

  throw new AgentError("Missing Doubao ASR credentials", { code: "DOUBAO_ASR_CREDENTIALS_MISSING" });
};

const getDoubaoUid = config => config.doubaoApiKey || config.doubaoAppKey || "xiaomang-agent";

const getAsrResult = data => Array.isArray(data?.result) ? data.result[0] : data?.result;

const extractAsrTranscript = (data) => {
  const result = getAsrResult(data);
  return String(result?.text || data?.text || "").trim();
};

const extractAsrUtterances = (data) => {
  const result = getAsrResult(data);
  return Array.isArray(result?.utterances) ? result.utterances : [];
};

const extractAsrDuration = (data) => {
  const result = getAsrResult(data);
  return data?.audio_info?.duration || result?.additions?.duration || null;
};

const isRetryableDoubaoAsrStatus = (statusCode) => {
  const code = String(statusCode || "");
  return code === "55000031" || /^55\d+/.test(code);
};

const normalizeAudioFormat = value => String(value || "mp3").toLowerCase() === "wav" ? "wav" : "mp3";

export const recognizeDoubaoAudio = async ({ audioDataBase64, audioFormat = "mp3", audioBytes = 0 }, config, options = {}) => {
  if (!audioDataBase64) {
    throw new AgentError("audioDataBase64 is required for ffmpeg + Doubao flash ASR", {
      code: "ASR_INPUT_MISSING",
      status: 422,
    });
  }

  const normalizedAudioFormat = normalizeAudioFormat(audioFormat);
  const uid = getDoubaoUid(config);
  const logger = options.logger;
  const maxAttempts = Math.max(1, Number(config.apiRetryAttempts || 0) + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestId = randomUUID();
    const { response, data } = await fetchJson(config.doubaoAsrEndpoint, {
      method: "POST",
      timeoutMs: config.requestTimeoutMs,
      retries: config.apiRetryAttempts,
      retryBaseDelayMs: config.apiRetryBaseDelayMs,
      logger,
      interfaceName: "doubao:asr.flash",
      logFields: {
        inputType: "base64",
        audioFormat: normalizedAudioFormat,
        audioBytes,
        resourceId: config.doubaoResourceId,
        asrAttempt: attempt,
        asrMaxAttempts: maxAttempts,
        requestId,
      },
      headers: buildDoubaoAsrHeaders(config, { sequence: "-1", requestId }),
      body: JSON.stringify({
        user: { uid },
        audio: { data: audioDataBase64 },
        request: { model_name: "bigmodel" },
      }),
    });

    const statusCode = response.headers.get("X-Api-Status-Code");
    const apiMessage = response.headers.get("X-Api-Message");
    const logid = response.headers.get("X-Tt-Logid");
    const transcript = extractAsrTranscript(data);
    logger?.info("doubao.asr.result", {
      interface: "doubao:asr.flash",
      status: response.status,
      apiStatusCode: statusCode,
      apiMessage,
      logid,
      requestId,
      transcriptLength: transcript.length,
      audioFormat: normalizedAudioFormat,
      audioBytes,
    });

    if (statusCode && statusCode !== "20000000") {
      const error = new AgentError(`Doubao ASR failed with code ${statusCode}`, {
        code: "DOUBAO_ASR_FAILED",
        status: response.status,
        details: { statusCode, apiMessage, logid, data },
      });
      lastError = error;
      if (attempt < maxAttempts && isRetryableDoubaoAsrStatus(statusCode)) {
        const delayMs = retryDelayMs(attempt, config.apiRetryBaseDelayMs);
        logger?.warn("external.request.retry", {
          interface: "doubao:asr.flash",
          method: "POST",
          endpoint: config.doubaoAsrEndpoint,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          reason: `ASR status ${statusCode}`,
          apiMessage,
          logid,
          requestId,
        });
        await sleep(delayMs);
        continue;
      }

      logger?.error("external.request.error", {
        interface: "doubao:asr.flash",
        method: "POST",
        endpoint: config.doubaoAsrEndpoint,
        error: error.message,
        code: error.code,
        status: error.status,
        details: compactDetails(error.details),
        requestId,
      });
      throw error;
    }
    if (!response.ok || !transcript) {
      throw new AgentError("Doubao ASR returned empty transcript", {
        code: "DOUBAO_ASR_EMPTY",
        status: response.status,
        details: { statusCode, apiMessage, logid, data },
      });
    }

    return {
      text: transcript,
      utterances: extractAsrUtterances(data),
      logid,
      duration: extractAsrDuration(data),
    };
  }

  throw lastError || new AgentError("Doubao ASR failed", { code: "DOUBAO_ASR_FAILED" });
};

const loadFfmpegPath = async () => {
  const imported = await import("ffmpeg-static");
  const ffmpegPath = imported.default || imported;
  if (!ffmpegPath || typeof ffmpegPath !== "string") {
    throw new AgentError("ffmpeg-static did not expose a binary path", { code: "FFMPEG_MISSING" });
  }
  return ffmpegPath;
};

export const buildFfmpegAudioExtractArgs = ({ input = "pipe:0", fastProbe = false, audioFormat = "mp3", config = {} } = {}) => {
  const format = normalizeAudioFormat(audioFormat);
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
  ];
  if (fastProbe) {
    args.push(
      "-probesize",
      String(config.ffmpegFastProbeSize || "4194304"),
      "-analyzeduration",
      String(config.ffmpegFastAnalyzeDuration || "3000000"),
    );
  }
  args.push(
    "-i",
    input,
    "-vn",
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "16000",
  );
  if (format === "wav") {
    args.push(
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "pipe:1",
    );
  } else {
    args.push(
      "-b:a",
      "32k",
      "-f",
      "mp3",
      "pipe:1",
    );
  }
  return args;
};

// 视频号文件是否已是明文 MP4：偏移 4-8 处应为 "ftyp"（ISO BMFF 文件类型盒签名）。
const isPlainMp4Header = (buffer) =>
  Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.toString("latin1", 4, 8) === "ftyp";

/**
 * 解密视频号媒体 buffer。
 *
 * 加密机制（经逆向确认，见 vendor/wechatKeystream.mjs 与 aynakeya 的分析）：
 *   - decodeKey 作为 seed（内部 stoull 转 uint64）初始化 Isaac64 PRNG
 *   - 生成 131072 字节密钥流并 reverse() 后，与文件【前 131072 字节】逐字节 XOR
 *   - 文件其余部分为明文，原样保留
 *
 * 因此本函数不再像旧实现那样尝试 15 种猜测策略：密钥流由 decodeKey 唯一确定，
 * 解密后偏移 4-8 处必然出现 "ftyp"，可作为成功判据。
 *
 * 注意：从同步变异步——generateKeystream 需等待 wasm 实例化（进程内仅一次）。
 */
export const decryptWeChatChannelsMediaBuffer = async (buffer, decodeKey) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AgentError("WeChat Channels media buffer is empty", { code: "WECHAT_MEDIA_EMPTY" });
  }
  if (isPlainMp4Header(buffer)) {
    return { buffer, strategy: "plain" };
  }
  if (!decodeKey) {
    throw new AgentError("WeChat Channels media missing decodeKey", { code: "WECHAT_DECODE_KEY_MISSING" });
  }

  const keystream = await generateKeystream(String(decodeKey)); // Uint8Array(131072)
  const decrypted = Buffer.from(buffer); // 拷贝，明文部分原样保留
  const len = Math.min(WECHAT_KEYSTREAM_SIZE, decrypted.length, keystream.length);
  for (let i = 0; i < len; i += 1) {
    decrypted[i] = buffer[i] ^ keystream[i];
  }

  if (!isPlainMp4Header(decrypted)) {
    throw new AgentError("WeChat Channels media decrypt failed (no ftyp signature after XOR)", {
      code: "WECHAT_MEDIA_DECRYPT_FAILED",
      details: { decodeKey: String(decodeKey).slice(0, 16) },
    });
  }
  return { buffer: decrypted, strategy: "isaac64" };
};

const mediaEndpointForLogs = (url) => {
  const diagnostics = describeVideoUrlForDiagnostics(url);
  return diagnostics.host ? `${diagnostics.host}${diagnostics.path || ""}` : "wechat-media";
};

const VIDEO_STREAM_FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const toNodeReadable = (body) => {
  if (!body) return Readable.from([]);
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function" && typeof body.getReader === "function") {
    return Readable.fromWeb(body);
  }
  if (typeof body[Symbol.asyncIterator] === "function") return Readable.from(body);
  return Readable.from([]);
};

const fetchBinary = async (url, config, options = {}) => {
  const logger = options.logger;
  const maxAttempts = Math.max(1, Number(config.apiRetryAttempts || 0) + 1);
  const maxBytes = Number(config.wechatMediaMaxBytes || 220 * 1024 * 1024);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timeout = withTimeout(config.requestTimeoutMs || 120000);
    const startedAt = Date.now();
    const endpoint = mediaEndpointForLogs(url);
    logger?.info("external.request.start", {
      interface: "wechat_channels:media-download",
      method: "GET",
      endpoint,
      attempt,
      maxAttempts,
    });

    try {
      const response = await fetch(url, { signal: timeout.signal });
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > maxBytes) {
        throw new AgentError("WeChat Channels media exceeded download limit", {
          code: "WECHAT_MEDIA_TOO_LARGE",
          status: 413,
          details: { contentLength, maxBytes },
        });
      }
      if (!response.ok) {
        throw new AgentError(`HTTP ${response.status} from WeChat Channels media`, {
          code: "HTTP_ERROR",
          status: response.status,
        });
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        throw new AgentError("WeChat Channels media exceeded download limit", {
          code: "WECHAT_MEDIA_TOO_LARGE",
          status: 413,
          details: { bytes: buffer.length, maxBytes },
        });
      }
      logger?.info("external.request.end", {
        interface: "wechat_channels:media-download",
        method: "GET",
        endpoint,
        status: response.status,
        durationMs: Date.now() - startedAt,
        bytes: buffer.length,
        attempt,
        maxAttempts,
      });
      return buffer;
    } catch (error) {
      lastError = error;
      logger?.warn("external.request.error", {
        interface: "wechat_channels:media-download",
        method: "GET",
        endpoint,
        durationMs: Date.now() - startedAt,
        attempt,
        maxAttempts,
        error: error instanceof Error ? error.message : "Media download failed",
        code: error?.code,
      });
      if (attempt >= maxAttempts) break;
      await sleep(retryDelayMs(attempt, config.apiRetryBaseDelayMs));
    } finally {
      timeout.cancel();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new AgentError("WeChat Channels media download failed", { code: "WECHAT_MEDIA_DOWNLOAD_FAILED" });
};

/**
 * 流式下载视频号媒体，返回 response（含 body 流），供下游边读边处理。
 * 与 fetchBinary 共用重试/超时/大小上限逻辑，但不把整个 buffer 读进内存。
 * 成功返回的 response 由调用方负责消费/取消；body 在调用方读完后会自动关闭。
 */
const fetchMediaResponse = async (url, config, options = {}) => {
  const logger = options.logger;
  const maxAttempts = Math.max(1, Number(options.maxAttempts || Number(config.apiRetryAttempts || 0) + 1));
  const maxBytes = Number(options.maxBytes || config.wechatMediaMaxBytes || 220 * 1024 * 1024);
  const interfaceName = options.interfaceName || "wechat_channels:media-download-stream";
  const errorLabel = options.errorLabel || "WeChat Channels media";
  const tooLargeCode = options.tooLargeCode || "WECHAT_MEDIA_TOO_LARGE";
  const failureCode = options.failureCode || "WECHAT_MEDIA_DOWNLOAD_FAILED";
  const logFields = options.logFields || {};
  const dispatcher = options.dispatcher || getMediaFetchDispatcher(config);
  const proxyEnabled = Boolean(dispatcher);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timeout = withTimeout(config.requestTimeoutMs || 120000);
    const startedAt = Date.now();
    const endpoint = mediaEndpointForLogs(url);
    logger?.info("external.request.start", {
      interface: interfaceName,
      method: "GET",
      endpoint,
      attempt,
      maxAttempts,
      proxyEnabled,
      ...logFields,
    });

    try {
      const response = await undiciFetch(url, {
        signal: timeout.signal,
        headers: options.headers,
        ...(dispatcher ? { dispatcher } : {}),
      });
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > maxBytes) {
        throw new AgentError(`${errorLabel} exceeded download limit`, {
          code: tooLargeCode,
          status: 413,
          details: { contentLength, maxBytes },
        });
      }
      if (!response.ok) {
        throw new AgentError(`HTTP ${response.status} from ${errorLabel}`, {
          code: "HTTP_ERROR",
          status: response.status,
        });
      }
      logger?.info("external.request.end", {
        interface: interfaceName,
        method: "GET",
        endpoint,
        status: response.status,
        durationMs: Date.now() - startedAt,
        contentLength,
        attempt,
        maxAttempts,
        proxyEnabled,
        ...logFields,
      });
      // response.body 可能因运行时而 null，调用方会规范化为可读流
      const body = response.body || Readable.from([]);
      return { response, body, contentLength, cancelTimeout: () => timeout.cancel() };
    } catch (error) {
      lastError = error;
      timeout.cancel();
      logger?.warn("external.request.error", {
        interface: interfaceName,
        method: "GET",
        endpoint,
        durationMs: Date.now() - startedAt,
        attempt,
        maxAttempts,
        error: error instanceof Error ? error.message : "Media stream failed",
        code: error?.code,
        details: compactDetails(fetchErrorDetails(error)),
        proxyEnabled,
        ...logFields,
      });
      if (attempt >= maxAttempts) break;
      await sleep(retryDelayMs(attempt, config.apiRetryBaseDelayMs));
    }
  }

  if (lastError instanceof AgentError) {
    throw lastError;
  }
  throw new AgentError(lastError instanceof Error ? lastError.message : `${errorLabel} download failed`, {
    code: failureCode,
    cause: lastError,
    details: fetchErrorDetails(lastError),
  });
};

/**
 * 创建一个 Transform 流，对经过的数据前 KEYSTREAM_SIZE 字节做 XOR 解密，其余原样透传。
 * 这样可把"下载流 → 解密 → ffmpeg stdin"串成管道，无需把整段视频读进内存或落盘。
 * 仅前 128KB 需解密，故用 processedBytes 计数控制何时停止 XOR。
 */
const createWeChatDecryptTransform = (keystream) => {
  let processedBytes = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        if (processedBytes < WECHAT_KEYSTREAM_SIZE && chunk.length > 0) {
          const limit = Math.min(chunk.length, WECHAT_KEYSTREAM_SIZE - processedBytes);
          for (let i = 0; i < limit; i += 1) {
            chunk[i] = chunk[i] ^ keystream[processedBytes + i];
          }
          processedBytes += limit;
        }
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    },
  });
};

const prepareVideoInput = async (videoMeta, config, options = {}) => {
  if (!isWeChatChannelsVideo(videoMeta)) {
    return { videoUrl: videoMeta.videoUrl, cleanup: async () => {}, localFile: false };
  }

  const logger = options.logger;
  logger?.info("wechat_channels.media.prepare.start", {
    title: videoMeta.title,
    ...describeVideoUrlForDiagnostics(videoMeta.videoUrl),
  });

  // 流式管道：下载 → 解密 transform → 返回给 transcribeVideo 喂 ffmpeg stdin。
  // 与旧的"全量下载到内存→解密→写临时文件"相比，内存恒定且无磁盘 I/O。
  // keystream 可在下载前同步生成（Isaac64 密钥流只依赖 decodeKey），无需等下载。
  const keystream = await generateKeystream(String(videoMeta.decodeKey));
  const { body, cancelTimeout } = await fetchMediaResponse(videoMeta.videoUrl, config, { logger });
  const decryptTransform = createWeChatDecryptTransform(keystream);
  // web stream (response.body) 转 Node readable 后过解密 transform
  const decryptedStream = toNodeReadable(body).pipe(decryptTransform);

  logger?.info("wechat_channels.media.prepare.end", {
    title: videoMeta.title,
    strategy: "isaac64-stream",
  });

  return {
    videoUrl: null,
    stream: decryptedStream,
    localFile: false,
    cleanup: async () => {
      cancelTimeout();
      try {
        if (!decryptedStream.destroyed) decryptedStream.destroy();
      } catch {
        /* ignore */
      }
    },
  };
};

export const shouldStreamVideoInputForFfmpeg = value => isCdnDirectVideoUrl(value);

const shouldUseTikHubFfmpegProvider = videoMeta =>
  videoMeta?.sourceProvider === "tikhub" && getTikHubMediaCandidates(videoMeta).some(shouldStreamVideoInputForFfmpeg);

const getTikHubMediaCandidates = videoMeta => uniqueStrings([
  ...(Array.isArray(videoMeta?.videoUrls) ? videoMeta.videoUrls : []),
  videoMeta?.videoUrl,
]).filter(shouldStreamVideoInputForFfmpeg);

const audioOutputLimitBytes = (config, audioFormat) => {
  const format = normalizeAudioFormat(audioFormat);
  if (format === "wav") return Number(config.asrWavMaxBytes || 20 * 1024 * 1024);
  return Number(config.ffmpegAudioMaxBytes || 24 * 1024 * 1024);
};

const audioOutputLimitCode = audioFormat =>
  normalizeAudioFormat(audioFormat) === "wav" ? "ASR_WAV_TOO_LARGE" : "FFMPEG_OUTPUT_TOO_LARGE";

// ffmpeg 在 fast-probe（probesize/analyzeduration 很小）模式下，遇到无音轨或探测不到
// 音频流的视频时，可能 exit code === 0 却只写出文件头、没有有效采样帧。这种「空壳音频」
// 字节数 > 0，能绕过旧的 buffer.length === 0 校验，最终让豆包 ASR 报 11105 empty audio。
// 这里按格式给一个最小有效字节数阈值，低于它即视为无效音频，提前拒绝并走向兜底。
//
// 阈值取值依据：
//  - wav：标准 PCM 头 44 字节 + 至少 1 秒 mono/16k/16bit 采样 ≈ 32000 字节。留足余量。
//  - mp3：无固定头开销，一段有效 mp3 至少包含若干帧 + 一定持续时长，取保守下限。
const audioOutputMinBytes = audioFormat => {
  const format = normalizeAudioFormat(audioFormat);
  if (format === "wav") return 32 * 1024; // 32KB：覆盖 44 字节头 + ≥1s 单声道 16kHz 采样
  return 8 * 1024; // 8KB：mp3 一段有实际时长的音频，远大于纯头/单帧
};

// 判断 ffmpeg 输出的音频 buffer 是否「有效」：非零、且达到该格式的最小阈值。
// 无效时返回一个描述原因的字符串；有效时返回 null。
const describeInvalidAudio = (buffer, audioFormat) => {
  if (!buffer || buffer.length === 0) return "ffmpeg produced empty audio";
  const minBytes = audioOutputMinBytes(audioFormat);
  if (buffer.length < minBytes) {
    return `ffmpeg produced invalid audio: only ${buffer.length} bytes (below ${minBytes} threshold for ${normalizeAudioFormat(audioFormat)})`;
  }
  return null;
};

const extractAudioFromFetchedMedia = async (videoUrl, config, options = {}) => {
  const logger = options.logger;
  const { body, cancelTimeout } = await fetchMediaResponse(videoUrl, config, {
    logger,
    interfaceName: options.interfaceName || "video:media-download-stream",
    errorLabel: options.errorLabel || "video media",
    tooLargeCode: options.tooLargeCode || "MEDIA_TOO_LARGE",
    failureCode: options.failureCode || "MEDIA_DOWNLOAD_FAILED",
    headers: VIDEO_STREAM_FETCH_HEADERS,
  });
  const inputStream = toNodeReadable(body);

  try {
    return await extractAudioFromStream(inputStream, config, {
      logger,
      inputLabel: options.inputLabel || "http-media-stream",
      strategy: options.strategy || "stream",
      fastProbe: Boolean(options.fastProbe),
      audioFormat: options.audioFormat || "mp3",
    });
  } finally {
    cancelTimeout();
    try {
      if (!inputStream.destroyed) inputStream.destroy();
    } catch {
      /* ignore */
    }
  }
};

const shouldRetryFfmpegConservatively = error => (
  error?.code === "FFMPEG_FAILED" ||
  error?.code === "FFMPEG_EMPTY"
);

const tikhubAudioFormatAttempts = config => {
  const format = String(config.asrAudioFormat || "auto").toLowerCase();
  if (format === "wav") return ["wav"];
  if (format === "mp3") return ["mp3"];
  return ["wav", "mp3"];
};

// 豆包 ASR 返回的错误子码，嵌入在 details.apiMessage 里，形如 "code: 11105 message: empty audio"。
// 提取它以区分「换一种音频格式可能解决」和「上游压根没提到音频」两类失败。
const DOUBAO_ASR_EMPTY_AUDIO_SUBCODE = "11105"; // empty audio —— ffmpeg 提出的是空壳，换格式无济于事

const doubaoAsrSubCode = (error) => {
  const message = String(error?.details?.apiMessage || "");
  const match = message.match(/code:\s*(\d+)/i);
  return match ? match[1] : "";
};

const shouldFallbackAudioFormat = error => {
  if (error?.code === "ASR_WAV_TOO_LARGE") return true;
  if (error?.code === "DOUBAO_ASR_EMPTY") return true;
  // DOUBAO_ASR_FAILED 是个宽泛码，需要再细分子码：
  //  - 11105 empty audio：ffmpeg 提出的是空/坏音频，换 wav/mp3 也不会变好，
  //    不应触发格式回退，直接走向兜底 provider。
  //  - 其余（如 11103 convert failed、45000151 等）：换格式可能有效，回退。
  if (error?.code === "DOUBAO_ASR_FAILED") {
    return doubaoAsrSubCode(error) !== DOUBAO_ASR_EMPTY_AUDIO_SUBCODE;
  }
  if (String(error?.details?.statusCode || "") === "45000151") return true;
  return false;
};

const extractAudioWithTikHubFfmpegProvider = async (videoMeta, config, options = {}) => {
  if (!shouldUseTikHubFfmpegProvider(videoMeta)) {
    throw new AgentError("TikHub ffmpeg provider only handles TikHub CDN media URLs", {
      code: "TIKHUB_FFMPEG_NOT_APPLICABLE",
      status: 422,
      details: describeVideoUrlForDiagnostics(videoMeta?.videoUrl),
    });
  }
  const baseOptions = {
    ...options,
    interfaceName: "tikhub:media-download-stream",
    errorLabel: "TikHub media",
    tooLargeCode: "TIKHUB_MEDIA_TOO_LARGE",
    failureCode: "TIKHUB_MEDIA_DOWNLOAD_FAILED",
    inputLabel: "tikhub-media-stream",
    maxAttempts: 1,
  };
  const candidates = getTikHubMediaCandidates(videoMeta).slice(0, Math.max(1, Number(config.tikhubMediaUrlMaxAttempts || 6)));
  let lastError = null;

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidateUrl = candidates[candidateIndex];
    const candidateOptions = {
      ...baseOptions,
      logFields: {
        candidateIndex: candidateIndex + 1,
        candidateCount: candidates.length,
      },
    };
    try {
      return await extractAudioFromFetchedMedia(candidateUrl, config, {
        ...candidateOptions,
        strategy: "tikhub-fast-probe",
        fastProbe: true,
        audioFormat: options.audioFormat || "mp3",
      });
    } catch (error) {
      lastError = error;
      if (shouldRetryFfmpegConservatively(error)) {
        options.logger?.warn("tikhub.ffmpeg.fast_probe.retry_conservative", {
          code: error?.code,
          error: error instanceof Error ? error.message : "TikHub fast ffmpeg probe failed",
          details: compactDetails(error?.details),
          title: videoMeta.title,
          candidateIndex: candidateIndex + 1,
          candidateCount: candidates.length,
          ...describeVideoUrlForDiagnostics(candidateUrl),
        });
        try {
          return await extractAudioFromFetchedMedia(candidateUrl, config, {
            ...candidateOptions,
            strategy: "tikhub-conservative-probe",
            fastProbe: false,
            audioFormat: options.audioFormat || "mp3",
          });
        } catch (retryError) {
          lastError = retryError;
        }
      }
      if (candidateIndex < candidates.length - 1) {
        options.logger?.warn("tikhub.media.candidate.fallback", {
          code: lastError?.code,
          error: lastError instanceof Error ? lastError.message : "TikHub media candidate failed",
          details: compactDetails(lastError?.details),
          title: videoMeta.title,
          candidateIndex: candidateIndex + 1,
          nextCandidateIndex: candidateIndex + 2,
          candidateCount: candidates.length,
          ...describeVideoUrlForDiagnostics(candidateUrl),
        });
        continue;
      }
    }
  }

  throw lastError || new AgentError("TikHub media candidates failed", {
    code: "TIKHUB_MEDIA_CANDIDATES_FAILED",
  });
};

const extractAudioWithFfmpeg = async (videoUrl, config, options = {}) => {
  if (!config.ffmpegEnabled) {
    throw new AgentError("ffmpeg transcript provider is disabled", { code: "FFMPEG_DISABLED" });
  }
  if (shouldStreamVideoInputForFfmpeg(videoUrl)) {
    return extractAudioFromFetchedMedia(videoUrl, config, options);
  }
  const ffmpegPath = await loadFfmpegPath();
  const logger = options.logger;
  const startedAt = Date.now();
  const audioFormat = normalizeAudioFormat(options.audioFormat || "mp3");
  logger?.info("ffmpeg.extract.start", {
    interface: "ffmpeg-static",
    input: "video-url",
    output: `${audioFormat}-base64`,
    audioFormat,
  });

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let stderr = "";
    let finished = false;
    const child = spawn(ffmpegPath, buildFfmpegAudioExtractArgs({ input: videoUrl, audioFormat, config }));

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        reject(new AgentError("ffmpeg audio extraction timed out", { code: "FFMPEG_TIMEOUT" }));
      }
    }, config.ffmpegTimeoutMs);

    child.stdout.on("data", chunk => {
      totalBytes += chunk.length;
      if (totalBytes > audioOutputLimitBytes(config, audioFormat)) {
        child.kill("SIGKILL");
        reject(new AgentError("ffmpeg audio output exceeded limit", {
          code: audioOutputLimitCode(audioFormat),
          details: { audioFormat, bytes: totalBytes, maxBytes: audioOutputLimitBytes(config, audioFormat) },
        }));
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on("error", error => {
      clearTimeout(timer);
      logger?.error("ffmpeg.extract.error", {
        interface: "ffmpeg-static",
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
      reject(new AgentError(error.message, { code: "FFMPEG_SPAWN_FAILED", cause: error }));
    });

    child.on("close", code => {
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        logger?.error("ffmpeg.extract.error", {
          interface: "ffmpeg-static",
          durationMs: Date.now() - startedAt,
          exitCode: code,
          error: stderr.trim(),
        });
        reject(new AgentError("ffmpeg audio extraction failed", {
          code: "FFMPEG_FAILED",
          details: stderr.trim(),
        }));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const invalidReason = describeInvalidAudio(buffer, audioFormat);
      if (invalidReason) {
        // exit code === 0 但输出是空/空壳音频：fast-probe 没真正读到音频流的典型症状。
        // 统一抛 FFMPEG_EMPTY，让 provider 编排切到 conservative-probe / 下一个候选 URL / 兜底。
        logger?.error("ffmpeg.extract.error", {
          interface: "ffmpeg-static",
          durationMs: Date.now() - startedAt,
          exitCode: code,
          bytes: buffer.length,
          threshold: audioOutputMinBytes(audioFormat),
          error: invalidReason,
        });
        reject(new AgentError(invalidReason, {
          code: "FFMPEG_EMPTY",
          details: { bytes: buffer.length, threshold: audioOutputMinBytes(audioFormat) },
        }));
        return;
      }
      logger?.info("ffmpeg.extract.end", {
        interface: "ffmpeg-static",
        durationMs: Date.now() - startedAt,
        bytes: buffer.length,
        audioFormat,
      });
      resolve({
        audioDataBase64: buffer.toString("base64"),
        audioFormat,
        audioBytes: buffer.length,
      });
    });
  });
};

/**
 * 从可读流（如视频号解密后的流）提取音频，ffmpeg 通过 stdin (pipe:0) 读取输入。
 * 与 extractAudioWithFfmpeg 的区别仅在于输入：stdin 流 vs -i url/路径。
 * 用于视频号流式管道，避免把整段解密视频写临时文件再读回。
 */
const extractAudioFromStream = async (inputStream, config, options = {}) => {
  if (!config.ffmpegEnabled) {
    throw new AgentError("ffmpeg transcript provider is disabled", { code: "FFMPEG_DISABLED" });
  }
  const ffmpegPath = await loadFfmpegPath();
  const logger = options.logger;
  const startedAt = Date.now();
  const audioFormat = normalizeAudioFormat(options.audioFormat || "mp3");
  logger?.info("ffmpeg.extract.start", {
    interface: "ffmpeg-static",
    input: options.inputLabel || "stdin-stream",
    output: `${audioFormat}-base64`,
    strategy: options.strategy || "standard",
    fastProbe: Boolean(options.fastProbe),
    audioFormat,
  });

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let stderr = "";
    let finished = false;
    const child = spawn(ffmpegPath, buildFfmpegAudioExtractArgs({
      input: "pipe:0",
      fastProbe: Boolean(options.fastProbe),
      audioFormat,
      config,
    }));

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        reject(new AgentError("ffmpeg audio extraction timed out", { code: "FFMPEG_TIMEOUT" }));
      }
    }, config.ffmpegTimeoutMs);

    child.stdout.on("data", chunk => {
      totalBytes += chunk.length;
      if (totalBytes > audioOutputLimitBytes(config, audioFormat)) {
        child.kill("SIGKILL");
        reject(new AgentError("ffmpeg audio output exceeded limit", {
          code: audioOutputLimitCode(audioFormat),
          details: { audioFormat, bytes: totalBytes, maxBytes: audioOutputLimitBytes(config, audioFormat) },
        }));
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on("error", error => {
      clearTimeout(timer);
      logger?.error("ffmpeg.extract.error", {
        interface: "ffmpeg-static",
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
      reject(new AgentError(error.message, { code: "FFMPEG_SPAWN_FAILED", cause: error }));
    });

    child.on("close", code => {
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        logger?.error("ffmpeg.extract.error", {
          interface: "ffmpeg-static",
          durationMs: Date.now() - startedAt,
          exitCode: code,
          error: stderr.trim(),
        });
        reject(new AgentError("ffmpeg audio extraction failed", {
          code: "FFMPEG_FAILED",
          details: stderr.trim(),
        }));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const invalidReason = describeInvalidAudio(buffer, audioFormat);
      if (invalidReason) {
        // exit code === 0 但输出是空/空壳音频：fast-probe 没真正读到音频流的典型症状。
        // 统一抛 FFMPEG_EMPTY，让 provider 编排切到 conservative-probe / 下一个候选 URL / 兜底。
        logger?.error("ffmpeg.extract.error", {
          interface: "ffmpeg-static",
          durationMs: Date.now() - startedAt,
          exitCode: code,
          bytes: buffer.length,
          threshold: audioOutputMinBytes(audioFormat),
          error: invalidReason,
        });
        reject(new AgentError(invalidReason, {
          code: "FFMPEG_EMPTY",
          details: { bytes: buffer.length, threshold: audioOutputMinBytes(audioFormat) },
        }));
        return;
      }
      logger?.info("ffmpeg.extract.end", {
        interface: "ffmpeg-static",
        durationMs: Date.now() - startedAt,
        bytes: buffer.length,
        audioFormat,
      });
      resolve({
        audioDataBase64: buffer.toString("base64"),
        audioFormat,
        audioBytes: buffer.length,
      });
    });

    // 把输入流泵入 ffmpeg stdin；输入结束即关闭 stdin 通知 ffmpeg 收尾
    inputStream.on("error", error => {
      if (!finished) {
        child.kill("SIGKILL");
        reject(new AgentError("ffmpeg input stream failed", { code: "FFMPEG_INPUT_STREAM_FAILED", cause: error }));
      }
    });
    inputStream.pipe(child.stdin);
  });
};

const callDoubaoVideoUnderstanding = async (videoUrl, config, options = {}) => {
  if (!config.doubaoVideoEndpoint || !config.doubaoVideoApiKey) {
    throw new AgentError("Missing Doubao video understanding endpoint or credentials", {
      code: "DOUBAO_VIDEO_CREDENTIALS_MISSING",
    });
  }

  const headers = {
    "Content-Type": "application/json",
  };
  if (config.doubaoVideoAuthHeader.toLowerCase() === "authorization") {
    headers.Authorization = `Bearer ${config.doubaoVideoApiKey}`;
  } else {
    headers[config.doubaoVideoAuthHeader] = config.doubaoVideoApiKey;
  }

  const { data } = await fetchJson(config.doubaoVideoEndpoint, {
    method: "POST",
    timeoutMs: config.requestTimeoutMs,
    retries: config.apiRetryAttempts,
    retryBaseDelayMs: config.apiRetryBaseDelayMs,
    logger: options.logger,
    interfaceName: "doubao:video-understanding",
    headers,
    body: JSON.stringify({
      model: config.doubaoVideoModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: DOUBAO_VIDEO_TRANSCRIPT_PROMPT },
            { type: "video_url", video_url: { url: videoUrl } },
          ],
        },
      ],
      temperature: 0.1,
    }),
  });

  const text = cleanModelText(
    data?.choices?.[0]?.message?.content ||
      data?.output_text ||
      data?.text ||
      data?.result?.text ||
      "",
  );

  if (!text) {
    throw new AgentError("Doubao video understanding returned empty text", {
      code: "DOUBAO_VIDEO_EMPTY",
      details: data,
    });
  }
  return text;
};

export const transcribeVideo = async (videoMeta, config, options = {}) => {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const logger = options.logger;
  const cacheKey = videoMeta.awemeId || videoMeta.videoUrl || videoMeta.shareLink;
  const cached = transcriptCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < config.transcriptCacheTtlMs) {
    onProgress({
      step: "transcript-cache-hit",
      provider: cached.value.provider,
      message: `命中转写缓存：${cached.value.provider}`,
    });
    return { ...cached.value, cached: true };
  }

  const warnings = [];
  const prepared = await prepareVideoInput(videoMeta, config, { logger });
  const providers = Array.isArray(config.transcriptProviders) ? config.transcriptProviders : [];
  const hasTikHubProvider = providers.includes("tikhub-ffmpeg");
  try {
    for (const provider of providers) {
      if (provider === "tikhub-ffmpeg" && !shouldUseTikHubFfmpegProvider(videoMeta)) {
        logger?.info("transcript.provider.skipped", {
          provider,
          reason: "not TikHub CDN media",
          videoTitle: videoMeta.title,
        });
        continue;
      }
      if (provider === "ffmpeg" && hasTikHubProvider && shouldUseTikHubFfmpegProvider(videoMeta)) {
        logger?.info("transcript.provider.skipped", {
          provider,
          reason: "tikhub-ffmpeg handles TikHub CDN media",
          videoTitle: videoMeta.title,
        });
        onProgress({
          step: "transcript-provider-skipped",
          provider,
          message: "已跳过通用 ffmpeg：TikHub CDN 媒体由 tikhub-ffmpeg 专用方案处理",
        });
        continue;
      }
      try {
        logger?.info("transcript.provider.start", {
          provider,
          videoTitle: videoMeta.title,
        });
        onProgress({
          step: "transcript-provider-start",
          provider,
          message: `尝试转写方案：${provider}`,
        });
        if (provider === "tikhub-ffmpeg") {
          const audioFormats = tikhubAudioFormatAttempts(config);
          let lastAudioFormatError = null;
          for (let formatIndex = 0; formatIndex < audioFormats.length; formatIndex += 1) {
            const audioFormat = audioFormats[formatIndex];
            try {
              const audio = await extractAudioWithTikHubFfmpegProvider(videoMeta, config, { logger, audioFormat });
              onProgress({
                step: "audio-extracted",
                provider,
                audioFormat: audio.audioFormat,
                audioBytes: audio.audioBytes,
                message: `TikHub 媒体流已提取 ${audio.audioFormat.toUpperCase()} 音频，开始调用豆包 ASR`,
              });
              const asr = await recognizeDoubaoAudio(audio, config, { logger });
              const value = { ...asr, provider: `tikhub-ffmpeg+doubao-asr:${audio.audioFormat}`, warnings };
              logger?.info("transcript.provider.success", {
                provider: value.provider,
                textLength: value.text.length,
                duration: value.duration,
                audioFormat: audio.audioFormat,
                audioBytes: audio.audioBytes,
              });
              onProgress({
                step: "transcript-provider-success",
                provider: value.provider,
                message: `转写方案成功：${value.provider}`,
              });
              transcriptCache.set(cacheKey, { createdAt: Date.now(), value });
              return value;
            } catch (error) {
              lastAudioFormatError = error;
              const canFallbackFormat = formatIndex < audioFormats.length - 1 && shouldFallbackAudioFormat(error);
              if (!canFallbackFormat) throw error;
              logger?.warn("tikhub.asr.audio_format.fallback", {
                from: audioFormat,
                to: audioFormats[formatIndex + 1],
                code: error?.code,
                error: error instanceof Error ? error.message : "TikHub ASR audio format failed",
                details: compactDetails(error?.details),
                title: videoMeta.title,
              });
              warnings.push({
                provider,
                message: `TikHub ${audioFormat.toUpperCase()} audio failed, fallback to ${audioFormats[formatIndex + 1].toUpperCase()}`,
                code: error?.code,
              });
            }
          }
          throw lastAudioFormatError || new AgentError("TikHub ASR audio format attempts failed", {
            code: "TIKHUB_AUDIO_FORMAT_FAILED",
          });
        }
        if (provider === "ffmpeg") {
          // 视频号走流式管道（prepared.stream）；抖音/直链用 prepared.videoUrl
          const audio = prepared.stream
            ? await extractAudioFromStream(prepared.stream, config, { logger, audioFormat: "mp3" })
            : await extractAudioWithFfmpeg(prepared.videoUrl, config, { logger, audioFormat: "mp3" });
          onProgress({
            step: "audio-extracted",
            provider,
            message: "ffmpeg-static 已提取音频，开始调用豆包 ASR",
          });
          const asr = await recognizeDoubaoAudio(audio, config, { logger });
          const value = { ...asr, provider: `ffmpeg+doubao-asr:${audio.audioFormat}`, warnings };
          logger?.info("transcript.provider.success", {
            provider: value.provider,
            textLength: value.text.length,
            duration: value.duration,
          });
          onProgress({
            step: "transcript-provider-success",
            provider: value.provider,
            message: `转写方案成功：${value.provider}`,
          });
          transcriptCache.set(cacheKey, { createdAt: Date.now(), value });
          return value;
        }
        if (provider === "doubao-video") {
          // doubao-video 需要可公网访问的 URL，无法消费本地解密流/文件
          if (prepared.localFile || prepared.stream) {
            throw new AgentError("doubao-video cannot access local decrypted WeChat Channels media", {
              code: "DOUBAO_VIDEO_LOCAL_FILE_UNSUPPORTED",
            });
          }
          const text = await callDoubaoVideoUnderstanding(prepared.videoUrl, config, { logger });
          const value = { text, utterances: [], provider: "doubao-video", warnings };
          logger?.info("transcript.provider.success", {
            provider: value.provider,
            textLength: value.text.length,
          });
          onProgress({
            step: "transcript-provider-success",
            provider: value.provider,
            message: "多模态视频理解兜底成功：doubao-video",
          });
          transcriptCache.set(cacheKey, { createdAt: Date.now(), value });
          return value;
        }
        warnings.push({ provider, message: "Unknown transcript provider" });
      } catch (error) {
        logger?.warn("transcript.provider.failed", {
          provider,
          code: error?.code,
          status: error?.status,
          error: error instanceof Error ? error.message : "Transcript provider failed",
          details: compactDetails(error?.details),
        });
        onProgress({
          step: "transcript-provider-failed",
          provider,
          level: "warn",
          message: `转写方案失败：${provider}`,
          detail: error instanceof Error ? error.message : "Transcript provider failed",
          code: error?.code,
        });
        warnings.push({
          provider,
          message: error instanceof Error ? error.message : "Transcript provider failed",
          code: error?.code,
        });
      }
    }
  } finally {
    await prepared.cleanup();
  }

  throw new AgentError("All transcript providers failed", {
    code: "TRANSCRIPT_FAILED",
    details: warnings,
  });
};

const chatEndpoint = (baseUrl) => {
  const clean = String(baseUrl || "").replace(/\/$/, "");
  if (/\/chat\/completions$/i.test(clean)) return clean;
  return `${clean}/chat/completions`;
};

const callDeepSeek = async ({ system, user, jsonMode = false, interfaceName = "deepseek:chat" }, config, options = {}) => {
  if (!config.deepseekApiKey) {
    throw new AgentError("Missing DEEPSEEK_API_KEY", { code: "DEEPSEEK_TOKEN_MISSING" });
  }
  const body = {
    model: config.deepseekModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: config.deepseekTemperature,
    max_tokens: config.deepseekMaxTokens,
  };
  if (jsonMode && config.useDeepseekJsonMode) {
    body.response_format = { type: "json_object" };
  }

  const endpoint = chatEndpoint(config.deepseekBaseUrl);
  const headers = {
    Authorization: `Bearer ${config.deepseekApiKey}`,
    "Content-Type": "application/json",
  };
  const postChat = requestBody =>
    fetchJson(endpoint, {
      method: "POST",
      timeoutMs: config.requestTimeoutMs,
      retries: config.apiRetryAttempts,
      retryBaseDelayMs: config.apiRetryBaseDelayMs,
      logger: options.logger,
      interfaceName,
      headers,
      body: JSON.stringify(requestBody),
    });

  let data;
  try {
    ({ data } = await postChat(body));
  } catch (error) {
    if (body.response_format && error?.status === 400) {
      const retryBody = { ...body };
      delete retryBody.response_format;
      ({ data } = await postChat(retryBody));
    } else {
      throw error;
    }
  }

  const text = cleanModelText(data?.choices?.[0]?.message?.content || data?.output_text || "");
  if (!text) {
    throw new AgentError("DeepSeek returned empty content", { code: "DEEPSEEK_EMPTY", details: data });
  }
  return text;
};

const runJsonAgent = async ({ system, user, normalizer, interfaceName }, config, options = {}) => {
  const raw = await callDeepSeek({ system, user, jsonMode: true, interfaceName }, config, options);
  try {
    return normalizer(parseJsonAgentOutput(raw));
  } catch (firstError) {
    const repaired = await callDeepSeek({
      system: "你是严格 JSON 修复器。只把用户给出的内容修复为合法 JSON 对象，不添加解释。",
      user: `请把下面模型输出修复为合法 JSON，只输出 JSON：\n${extractFirstJsonObjectText(raw) || raw}`,
      jsonMode: true,
      interfaceName: "deepseek:json-repair",
    }, config, options);
    try {
      return normalizer(parseJsonAgentOutput(repaired));
    } catch {
      throw firstError;
    }
  }
};

const buildCreativeInput = (videoMeta, transcriptText) => {
  return [
    `原视频标题：${videoMeta.title || "未识别标题"}`,
    `原视频链接：${videoMeta.shareLink || ""}`,
    "原视频转写文案：",
    transcriptText,
  ].join("\n");
};

const compactText = (value, maxLength = 80) => {
  const text = cleanModelText(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
};

const firstSentence = (value, maxLength = 80) => {
  const text = cleanModelText(value).replace(/\s+/g, " ").trim();
  const sentence = text.split(/(?<=[。！？!?])|[\r\n]+/).map(item => item.trim()).find(Boolean) || text;
  return compactText(sentence, maxLength);
};

const fallbackOpeningHook = (videoMeta, transcriptText) => {
  const extracted = firstSentence(transcriptText, 90);
  const title = compactText(videoMeta.title || extracted || "这条对标视频", 32);
  const created = [
    title ? `${title}，这条内容值得你先看完` : "",
    extracted ? `开头这句话别划走：${compactText(extracted, 42)}` : "",
  ].filter(Boolean);

  return normalizeOpeningHook({
    extracted,
    created,
  });
};

const fallbackEndingHook = () => normalizeEndingHook({
  extracted_result: "无",
  rcs: [],
});

const fallbackTitleText = (videoMeta, transcriptText) => {
  const title = compactText(videoMeta.title || firstSentence(transcriptText, 32) || "对标视频核心内容拆解", 32);
  return [
    `1. 《${title}》`,
    "类型：原始标题保底",
    "优势：DeepSeek 创作 Agent 暂时不可用时，保留可编辑标题，避免任务中断",
    "技巧：使用原视频标题承接内容主题，后续可人工继续优化",
  ].join("\n");
};

const fallbackScriptText = (videoMeta, transcriptText) => {
  const text = cleanModelText(transcriptText).trim();
  if (text) return text;
  return cleanModelText(videoMeta.title || "当前视频已完成转写，但二创文案 Agent 暂时不可用，请稍后重新生成。");
};

export const buildCreativeFallback = (videoMeta = {}, transcript = {}, error = null) => {
  const transcriptText = typeof transcript === "string" ? transcript : String(transcript?.text || "");
  return {
    openingHook: fallbackOpeningHook(videoMeta, transcriptText),
    endingHook: fallbackEndingHook(),
    titleText: fallbackTitleText(videoMeta, transcriptText),
    scriptText: fallbackScriptText(videoMeta, transcriptText),
    warnings: [
      {
        agent: "creative-agents",
        code: error?.code || "CREATIVE_AGENT_FALLBACK",
        status: error?.status,
        error: error instanceof Error ? error.message : "Creative agents fell back to compatible output",
        details: compactDetails(error?.details),
        fallbackUsed: true,
      },
    ],
  };
};

const creativeErrorFields = (agent, error) => ({
  agent,
  code: error?.code,
  status: error?.status,
  error: error instanceof Error ? error.message : "Creative agent failed",
  details: compactDetails(error?.details),
});

const isRetryableCreativeError = (error) => {
  const code = String(error?.code || "");
  const status = Number(error?.status || 0);
  if (["DEEPSEEK_TOKEN_MISSING", "DEEPSEEK_CREDENTIALS_MISSING"].includes(code)) return false;
  if ([400, 401, 403, 404, 422].includes(status)) return false;
  return (
    code === "NETWORK_ERROR" ||
    code === "HTTP_ERROR" ||
    code === "DEEPSEEK_EMPTY" ||
    code === "MODEL_JSON_INVALID" ||
    code === "AGENT_ERROR" ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
};

const creativeRetryConfig = (config) => {
  const attempts = Number.parseInt(String(config.creativeAgentRetryAttempts ?? 2), 10);
  const baseDelayMs = Number.parseInt(String(config.creativeAgentRetryBaseDelayMs ?? 1200), 10);
  return {
    maxAttempts: Math.max(1, Number.isFinite(attempts) ? attempts + 1 : 3),
    baseDelayMs: Math.max(0, Number.isFinite(baseDelayMs) ? baseDelayMs : 1200),
  };
};

const runCreativeStep = async ({ agent, interfaceName, run, fallback }, config, options = {}) => {
  const logger = options.logger;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const { maxAttempts, baseDelayMs } = creativeRetryConfig(config);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    logger?.info("creative.agent.attempt.start", {
      interface: interfaceName,
      agent,
      attempt,
      maxAttempts,
    });
    onProgress({
      step: "creative-agent-attempt",
      agent,
      interface: interfaceName,
      attempt,
      maxAttempts,
      message: `创作 Agent ${agent} 第 ${attempt}/${maxAttempts} 次执行`,
    });

    try {
      const value = await run();
      logger?.info("creative.agent.attempt.success", {
        interface: interfaceName,
        agent,
        attempt,
        maxAttempts,
      });
      return {
        value,
        warning: null,
        attempts: attempt,
        fallbackUsed: false,
      };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableCreativeError(error);
      const fields = {
        interface: interfaceName,
        attempt,
        maxAttempts,
        retryable,
        ...creativeErrorFields(agent, error),
      };
      logger?.warn("creative.agent.attempt.failed", fields);
      onProgress({
        step: "creative-agent-attempt-failed",
        agent,
        interface: interfaceName,
        attempt,
        maxAttempts,
        level: "warn",
        retryable,
        code: error?.code,
        message: `创作 Agent ${agent} 第 ${attempt}/${maxAttempts} 次执行失败`,
      });

      if (attempt < maxAttempts && retryable) {
        const delayMs = retryDelayMs(attempt, baseDelayMs);
        logger?.warn("creative.agent.retry", {
          interface: interfaceName,
          agent,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          code: error?.code,
          status: error?.status,
        });
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }

  const warning = creativeErrorFields(agent, lastError);
  logger?.warn("creative.agent.fallback", {
    interface: interfaceName,
    maxAttempts,
    ...warning,
  });
  onProgress({
    step: "creative-agent-fallback",
    agent,
    interface: interfaceName,
    level: "warn",
    code: lastError?.code,
    message: `创作 Agent ${agent} 多次失败，已使用兼容保底结果`,
  });
  return {
    value: fallback(),
    warning: {
      ...warning,
      attempts: maxAttempts,
      fallbackUsed: true,
    },
    attempts: maxAttempts,
    fallbackUsed: true,
  };
};

export const runCreativeAgents = async (videoMeta, transcript, config, options = {}) => {
  const creativeInput = buildCreativeInput(videoMeta, transcript.text);
  const logger = options.logger;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const transcriptText = transcript.text || "";
  const [openingHook, endingHook, titleText, scriptText] = await Promise.all([
    runCreativeStep({
      agent: "opening-hook",
      interfaceName: "deepseek:agent-opening-hook",
      run: () => runJsonAgent({
        system: OPENING_HOOK_PROMPT,
        user: creativeInput,
        interfaceName: "deepseek:agent-opening-hook",
        normalizer: normalizeOpeningHook,
      }, config, { logger }),
      fallback: () => fallbackOpeningHook(videoMeta, transcriptText),
    }, config, { logger, onProgress }),
    runCreativeStep({
      agent: "ending-hook",
      interfaceName: "deepseek:agent-ending-hook",
      run: () => runJsonAgent({
        system: ENDING_HOOK_PROMPT,
        user: creativeInput,
        interfaceName: "deepseek:agent-ending-hook",
        normalizer: normalizeEndingHook,
      }, config, { logger }),
      fallback: fallbackEndingHook,
    }, config, { logger, onProgress }),
    runCreativeStep({
      agent: "title",
      interfaceName: "deepseek:agent-title",
      run: () => callDeepSeek({ system: TITLE_PROMPT, user: creativeInput, interfaceName: "deepseek:agent-title" }, config, { logger }),
      fallback: () => fallbackTitleText(videoMeta, transcriptText),
    }, config, { logger, onProgress }),
    runCreativeStep({
      agent: "script",
      interfaceName: "deepseek:agent-script",
      run: () => callDeepSeek({ system: SCRIPT_REWRITE_PROMPT, user: creativeInput, interfaceName: "deepseek:agent-script" }, config, { logger }),
      fallback: () => fallbackScriptText(videoMeta, transcriptText),
    }, config, { logger, onProgress }),
  ]);
  const warnings = [openingHook.warning, endingHook.warning, titleText.warning, scriptText.warning].filter(Boolean);
  if (warnings.length > 0) {
    logger?.warn("creative.agents.completed_with_fallback", {
      failedAgents: warnings.map(item => item.agent).join(","),
      count: warnings.length,
    });
  }

  return {
    openingHook: openingHook.value,
    endingHook: endingHook.value,
    titleText: cleanModelText(titleText.value),
    scriptText: cleanModelText(scriptText.value),
    warnings,
  };
};

const normalizeTranslationResult = (value, sourcePayload) => {
  const output = value?.output && typeof value.output === "object" ? value.output : value;
  const rawList = Array.isArray(output?.translations)
    ? output.translations
    : Array.isArray(output?.results)
      ? output.results
      : [];
  const sourceItems = [
    ...(Array.isArray(sourcePayload?.titles) ? sourcePayload.titles.map(text => ({ sourceType: "title", original: text })) : []),
    ...(Array.isArray(sourcePayload?.hooks) ? sourcePayload.hooks.map(text => ({ sourceType: "hook", original: text })) : []),
    ...(Array.isArray(sourcePayload?.scripts) ? sourcePayload.scripts.map(text => ({ sourceType: "script", original: text })) : []),
  ];

  const translations = rawList
    .map((item, index) => {
      const source = sourceItems[index] || {};
      const original = String(item?.original || item?.source || item?.zh || source.original || "").trim();
      const translated = String(item?.translated || item?.target || item?.en || item?.english || "").trim();
      const sourceType = item?.sourceType || item?.type || source.sourceType || "script";
      if (!original || !translated) return null;
      return {
        id: `${sourceType}-${index + 1}`,
        sourceType,
        original,
        translated,
        zh: original,
        en: translated,
      };
    })
    .filter(Boolean);

  return { translations };
};

export const runTranslationAgent = async (sourcePayload, config, options = {}) => {
  const system = [
    "你是专业短视频文案中英翻译助手。",
    "请把用户提供的标题、钩子和文案翻译成自然、适合内容生产场景的英文。",
    "必须输出严格 JSON：{\"translations\":[{\"sourceType\":\"title|hook|script\",\"original\":\"原文\",\"translated\":\"英文翻译\"}]}。",
    "不要输出 Markdown，不要添加解释。",
  ].join("\n");
  const user = JSON.stringify(sourcePayload || {});
  const raw = await callDeepSeek({
    system,
    user,
    jsonMode: true,
    interfaceName: "deepseek:agent-translation",
  }, config, options);
  return normalizeTranslationResult(parseJsonAgentOutput(raw), sourcePayload || {});
};

export const runRewriteAgent = async ({ targetPlatform, scripts }, config, options = {}) => {
  const system = [
    "你是资深新媒体编辑，请将用户给出的文案改写为指定平台风格。",
    "保持原意、核心卖点和行动指令，语言贴合目标平台，不输出分析过程。",
    "必须输出严格 JSON：{\"results\":[{\"id\":\"原id\",\"rewritten\":\"改写结果\"}]}。",
    "不要输出 Markdown，不要添加解释。",
  ].join("\n");
  const user = JSON.stringify({ targetPlatform, scripts: Array.isArray(scripts) ? scripts : [] });
  const raw = await callDeepSeek({
    system,
    user,
    jsonMode: true,
    interfaceName: "deepseek:agent-platform-rewrite",
  }, config, options);
  const output = parseJsonAgentOutput(raw);
  const rawResults = Array.isArray(output?.results) ? output.results : [];
  return {
    results: rawResults
      .map((item, index) => {
        const source = scripts?.[index] || {};
        const id = String(item?.id || source.id || `rw-${index + 1}`);
        const rewritten = String(item?.rewritten || item?.content || item?.text || "").trim();
        if (!rewritten) return null;
        return { id, rewritten };
      })
      .filter(Boolean),
  };
};

export const clearTranscriptCacheForTests = () => {
  transcriptCache.clear();
};

export const parseJsonForTests = (raw) => {
  return safeJsonParse(extractFirstJsonObjectText(raw), null);
};
