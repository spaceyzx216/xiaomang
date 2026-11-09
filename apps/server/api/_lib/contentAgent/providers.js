import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { Transform } from "stream";
import { Readable } from "stream";
import { extractPcmAudio } from "./audioPcm.js";
import { recognizeDoubaoStreamAudio } from "./asrStreamClient.js";
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
  SPOKEN_BENCHMARK_ANALYSIS_PROMPT,
  DRAMA_BENCHMARK_ANALYSIS_PROMPT,
  BENCHMARK_TOPIC_REFRESH_PROMPT,
  BENCHMARK_PROFILE_PROMPT,
  ACCOUNT_PLAN_PROMPT,
  ENDING_HOOKS_PROMPT,
  GOLD_THREE_SECONDS_PROMPT,
  ENDING_HOOK_PROMPT,
  OPENING_HOOK_PROMPT,
  CREATIVE_ENDING_HOOKS_PROMPT,
  CREATIVE_GOLD_THREE_SECONDS_PROMPT,
  CREATIVE_TITLE_PROMPT,
  SCRIPT_REWRITE_PROMPT,
  TITLE_PROMPT,
} from "./prompts.js";
import { normalizeEndingHook, normalizeOpeningHook, parseJsonAgentOutput } from "./adapter.js";
import { generateKeystream } from "./vendor/wechatKeystream.mjs";
import { buildGoldThreeSecondsInput } from "../goldThreeSeconds.js";
import { buildEndingHooksInput } from "../endingHooks.js";
import { buildBenchmarkProfileInput } from "../benchmarkProfile.js";
import { buildAccountPlanInput } from "../accountPlan.js";
import { GOLD_THREE_SECOND_TYPE_LABELS } from "../goldThreeSeconds.js";
import {
  TITLE_TYPE_KEYS,
  TITLE_TYPE_LABELS,
  formatTitleCandidatesAsText,
} from "../titleLibrary.js";
import { ENDING_HOOK_TYPE_LABELS } from "../endingHooks.js";
import { CREATIVE_CANDIDATE_COUNT, formatAdaptationForPrompt } from "../topicCreativeAdaptation.js";

const transcriptCache = new Map();

/**
 * TikHub 解析结果缓存（2026-09-24）。
 *
 * 为什么需要：`resolveTikHubVideo` 原本**完全没有缓存**，而它每解析一条要
 * 3.4~4.7s（实测，见 goldThreeSecondTranscripts.js 顶部的数字）—— 比裁剪后的
 * 转写本身（~1.7s）还贵一倍多。2.2 黄金三秒与 2.3 结尾钩子跑的是**同一批视频、
 * 同一个 link**；转写片段虽然不同（head / tail，不能共用），但「视频在哪、直链是
 * 什么」这一步是纯重复劳动：不缓存就要把解析成本付两遍，外加 TikHub 的额度。
 *
 * 缓存的是**一次解析的全部产物**，2.2 / 2.3 / 二创都要用：
 *   - `videoUrl`         → 转写要下载 / 作为 ffmpeg 输入
 *   - `musicUrl`         → `tikhub-music` provider 直接用它，比 ffmpeg 快约 12 倍
 *   - `title` / `cover`  → 日志与展示
 *
 * ⚠️ 三条必须守住的纪律：
 *   1. **只缓存成功**。失败（`VIDEO_URL_MISSING` 等）立刻删掉，让下一批还能重试 ——
 *      把一次网络抖动缓存成 30 分钟的「这条视频解析不出来」是最难查的那类 bug。
 *   2. **存的是 Promise，不是解析完的值**。同一批里预取窗口会并发请求同一个 link，
 *      存值挡不住这种并发（两个请求都 miss、再各打一次 TikHub）；存 Promise 才能
 *      把并发收敛成一次真实调用。
 *   3. **`warnings` 不进缓存**：那是这次请求的日志/遥测，不是视频的属性。
 *      （顺带说明：`resolveTikHubVideo` 返回的 `warnings` 字段目前没有任何调用方
 *       消费 —— 失败路径是用 `AgentError.details` 带出去的，所以这里不再往外传。）
 *
 * TTL 刻意比转写缓存短：转写缓存 1 小时（文本不变），而这里的 CDN 直链会过期，
 * 拿到过期直链会让下载 403/404。默认 30 分钟。
 */
const resolveCache = new Map();

/** 键里必须带 platform：同一条链接在不同平台下解析出的是不同结果，不能混用。 */
const resolveCacheKey = (shareLink, platform) => `${platform}::${String(shareLink ?? "").trim()}`;

/** 命中时重新打 `cached`，避免把上一次的标记嵌套成 `cached: { cached: true }`。 */
const withoutCacheFlag = value => {
  if (!value || typeof value !== "object" || !("cached" in value)) return value;
  const { cached: _ignored, ...rest } = value;
  return rest;
};

/** 超出容量时按插入顺序丢最旧的（Map 保序）。 */
const trimResolveCache = max => {
  while (resolveCache.size > max) {
    const oldest = resolveCache.keys().next();
    if (oldest.done) break;
    resolveCache.delete(oldest.value);
  }
};

/**
 * 清空解析缓存。给测试用：同一进程里多条用例共享这个 Map，
 * 不清理会让「后一条用例」直接命中「前一条」造的数据，出现莫名其妙的串味。
 */
export const clearResolveCacheForTests = () => {
  resolveCache.clear();
};

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

// 抖音/视频号 URL 的来源类型分级，用于候选排序。
// 抖音使用 MPEG-DASH 分离音画：高码率 play_addr variant 可能是纯视频流（无音频），
// 而 download_addr 是音视频合成流、music.play_url 是纯音频直链。
// 转写只需音频，故按"含音频的确定性"分级，而非画质/码率。
// 数值越小优先级越高（0 最先试）。
const urlSourcePriority = path => {
  // music.play_url：纯音频直链（mp3），无需 ffmpeg 提取，确定性最高
  if (/music.*play_url/i.test(path)) return 0;
  // download_addr：音视频合成流，ffprobe 实测含 audio 流
  if (/download_addr/i.test(path)) return 1;
  // bit_rate 数组里的非 original 档位：低/中码率合成流，通常含音频
  if (/bit_rate\[\d+\]/i.test(path) && !/original/i.test(path)) return 2;
  // play_addr（顶层）：可能是纯视频 DASH 流，音频不确定
  if (/play_addr/i.test(path)) return 3;
  // 其余未知来源（含 high_quality 端点返回的裸 URL）排最后
  return 4;
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
  // URL 选择优先级（videoUrls 数组顺序，用于 videoUrl 首选 + 兜底）：
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

  // 为每个 URL 记录来源类型优先级和文件大小，供 getTikHubMediaCandidates 做复合排序：
  //   主排序键 = urlSourcePriority（music/download_addr > play_addr > 未知）
  //   次排序键 = data_size 升序（同类型内小文件优先，转写不需高画质）
  // 抖音 API 中 data_size 与 url_list 同级，配对规则：把 path 末尾 .url_list[N]/.url 替换为 .data_size。
  const sizeByPath = {};
  for (const item of strings) {
    if (/\.data_size$/i.test(item.path) && /^\d+$/.test(item.value)) {
      sizeByPath[item.path] = Number(item.value);
    }
  }
  const videoUrlSizes = {};
  const videoUrlPriorities = {};
  for (const item of strings) {
    if (!isHttpUrl(item.value)) continue;
    const sizePath = item.path
      .replace(/\.url_list\[\d+\]$/i, ".data_size")
      .replace(/\.url$/i, ".data_size");
    if (sizeByPath[sizePath]) videoUrlSizes[item.value] = sizeByPath[sizePath];
    if (videoUrlPriorities[item.value] === undefined) {
      videoUrlPriorities[item.value] = urlSourcePriority(item.path);
    }
  }

  // music.play_url：抖音单独返回的原声音频 mp3 直链（douyinstatic.com/obj/ies-music/*.mp3）。
  // 用于 tikhub-music provider 实验：直接下载 mp3 送 ASR，跳过 ffmpeg 提取（省 55s+）。
  // 风险：可能是纯背景音乐无人声，ASR 返回空时 provider 链会自动回退到 tikhub-ffmpeg。
  const musicUrl = firstByPath(data, [/music.*play_url.*url_list/i], isHttpUrl) || "";

  return {
    awemeId: extractAwemeId(data, shareLink),
    title,
    cover,
    videoUrl,
    videoUrls,
    videoUrlSizes,
    videoUrlPriorities,
    musicUrl,
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
  // 合并 url→size/priority 映射：next 优先（preferVideo 端点的 data_size 更准确），再补 base
  const videoUrlSizes = { ...(base.videoUrlSizes || {}), ...(next.videoUrlSizes || {}) };
  const videoUrlPriorities = { ...(base.videoUrlPriorities || {}), ...(next.videoUrlPriorities || {}) };
  return {
    ...base,
    awemeId: base.awemeId || next.awemeId || "",
    title: base.title || next.title || "",
    cover: base.cover || next.cover || "",
    videoUrl: preferVideo ? next.videoUrl || base.videoUrl || "" : base.videoUrl || next.videoUrl || "",
    videoUrls,
    videoUrlSizes,
    videoUrlPriorities,
    musicUrl: base.musicUrl || next.musicUrl || "",
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
  // 默认抖音：优先用字段最全的 APP V3 端点（含 data_size + download_addr + bit_rate）。
  // 已移除 fetch_video_high_quality_play_url（web/app）：调研确认它返回的最高画质直链
  // 最可能是纯视频 DASH 流（无音频），且不返回 data_size，对转写有害无益。
  // hybrid 端点作为兜底保留（自动判定，多数走 APP V3）。
  return [
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
      path: "/api/v1/hybrid/video_data",
      params: { url: shareLink, minimal: false },
      preferVideo: false,
    },
  ];
};

export const resolveTikHubVideo = async (shareLink, config, options = {}) => {
  const logger = options.logger;
  const platform = options.platform === "tiktok" ? "tiktok" : "douyin";

  // ── 解析缓存 ──────────────────────────────────────────────────────────
  // 2.2 与 2.3 跑同一批视频的同一个 link，解析（3.4~4.7s/条）是纯重复劳动。
  // 详见 resolveCache 的注释：只缓存成功、存 Promise（收敛并发）、不缓存 warnings。
  const cacheKey = resolveCacheKey(shareLink, platform);
  const ttlMs = Math.max(0, Number(config?.resolveCacheTtlMs) || 0);
  const maxEntries = Math.max(1, Number(config?.resolveCacheMaxEntries) || 500);
  if (ttlMs > 0) {
    const entry = resolveCache.get(cacheKey);
    if (entry) {
      if (Date.now() - entry.createdAt < ttlMs) {
        // ⚠️ 返回**同一个包裹对象**，不是缓存里存的那个：调用方（例如
        // transcribeVideo 的 provider 循环）可能改动 meta，不能让它污染缓存。
        const value = await entry.promise;
        return { ...withoutCacheFlag(value), cached: true };
      }
      // 过期：先删掉再重新解析，避免下面 await 期间的并发又命中了旧条目。
      resolveCache.delete(cacheKey);
    }
  }

  const resolving = (async () => {
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
        // 拿到完整信息（标题 + 封面 + 可用视频 URL）即提前结束，避免无谓的串行调用。
        // 旧的 break 条件要求 attempt.preferVideo，是因为旧列表里有专门拿高清直链的端点；
        // 现在该端点已移除（返回纯视频流对转写有害），故改为信息完整即 break。
        if (meta.title && meta.cover && meta.videoUrl) break;
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
    };
  })();

  if (ttlMs > 0) {
    resolveCache.set(cacheKey, { createdAt: Date.now(), promise: resolving });
    trimResolveCache(maxEntries);
  }
  try {
    return await resolving;
  } catch (error) {
    // 失败不进缓存：一次抖动不该被记住 30 分钟。
    if (resolveCache.get(cacheKey)?.promise === resolving) resolveCache.delete(cacheKey);
    throw error;
  }
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

/**
 * 录音文件识别 2.0 的格式白名单（官方口径）：`wav / mp3 / ogg / spx / amr / aac / m4a`。
 *
 * 🔴 这里**不能复用上面的 `normalizeAudioFormat`**：那个只认 wav/mp3，会把 `m4a`
 *    **静默改写成 mp3**（实测踩到过：日志里 video 源报的 format 一直是 mp3，
 *    排查了三轮才发现是归一化改的值）。这类"悄悄改一个值、不报错"的处理，
 *    最容易让人误判成"服务端不支持这个格式"。
 */
const FILE_ASR_FORMATS = new Set(["wav", "mp3", "ogg", "spx", "amr", "aac", "m4a"]);
const normalizeFileAsrFormat = value => {
  const text = String(value || "").trim().toLowerCase();
  return FILE_ASR_FORMATS.has(text) ? text : "mp3";
};

/**
 * 读 API 状态码。规范位置是响应头 `X-Api-Status-Code`，
 * 但兼容响应体里也带一份的网关变体 —— 只认响应头的话，那种变体会让整条通道
 * 每次都误判成"submit failed"，而错误信息还看不出是状态码读错了。
 */
const readDoubaoApiCode = (response, data) => (
  String(response?.headers?.get?.("X-Api-Status-Code") || data?.code || data?.status_code || "").trim()
);

/**
 * 给「豆包录音文件识别 2.0」挑出**所有**可直接交给服务端去拉的音频源，按优先级排序。
 *
 * 为什么返回数组而不是单个：实测同一条抖音视频的 `music.play_url`（mp3）与视频直链
 * （mp4）里是**同一段音频**（308 vs 305 字，时长 57.2s vs 57.0s），互为等价来源。
 * 一个源返回空（静音 / 被截断 / 文件异常）时**换另一个源重试成本接近零**；
 * 而换 ffmpeg 要下整条视频、抽出**同一段音频**（最长 45 秒），结果大概率一样
 * —— 见 `recognizeDoubaoFileAudio` 顶部的说明。
 *
 * 顺序：music(mp3) 优先 —— 纯音频、体积小、服务端无需解封装（实测 8.8s vs 14.0s）。
 * 视频直链声明成 `m4a`（落在官方白名单内），而不是未文档化的 `mp4`；
 * 实测服务端按内容嗅探、不看这个字段，选文档内写法只是为了不赌。
 *
 * ⚠️ 只接受 http(s)：视频号那条路 `videoUrl` 为 null（走本地解密流），本地文件路径
 *    也没法给远端拉 —— 这两种情况如实返回空数组，让 provider 链跳过这一条。
 */
const pickDoubaoFileAudioSources = (videoMeta = {}) => {
  const asHttpUrl = value => {
    const text = String(value || "").trim();
    return /^https?:\/\//i.test(text) ? text : "";
  };
  const sources = [];
  const music = asHttpUrl(videoMeta.musicUrl);
  if (music) sources.push({ url: music, format: "mp3", kind: "music" });
  const video = asHttpUrl(videoMeta.videoUrl);
  if (video && video !== music) {
    const lower = video.split("?")[0].toLowerCase();
    const format = lower.endsWith(".mp3") ? "mp3" : lower.endsWith(".wav") ? "wav" : "m4a";
    sources.push({ url: video, format, kind: "video" });
  }
  return sources;
};

/**
 * 豆包**录音文件识别模型 2.0**（异步 submit + 轮询 query），2026-09-28 接入。
 *
 * 与 `recognizeDoubaoAudio`（flash 同步）的根本差别：**这条通道不接受 base64，
 * 只接受一个音频 URL**，服务端自己去拉。好处是**完全不需要本地 ffmpeg** ——
 * 直接把 CDN 上的 mp3（`music.play_url`）或 mp4 地址交过去即可。
 * 实测：一条 57 秒的视频，submit 660ms + 轮询到结果共约 10 秒。
 *
 * ── 协议要点（都是实测出来的，官方文档没写全）─────────────────────────
 *   ① **`task_id` 就是你自己传的 `X-Api-Request-Id`**。submit 的响应体是 `{}`，
 *      不返回 task_id；query 时把同一个 UUID 放在同一个头里带过去即可。
 *      所以这个 UUID 必须由调用方生成并保存，不能每次重新随机。
 *   ② query 的状态在 **响应头** `X-Api-Status-Code`，不在响应体：
 *        `20000001` = 处理中（msg `[Processing in progress]`）
 *        `20000000` = 成功，响应体里是 `{"audio_info":{...},"result":{"text":"..."}}`
 *   ③ 成功时的响应体形状与 flash **完全一致**（`result.text`），所以
 *      `extractAsrTranscript` 那套解析可以原样复用。
 *
 * 🔴 这是**异步任务**，官方口径「通常 3 小时内完成」。延迟不可控是这条通道最大的
 * 风险，所以这里必须有轮询上限与总预算：**超时就算这个 provider 失败**，
 * 交给 provider 链回退到别的方案 —— 绝不能让一条视频把整批挂死。
 */
const recognizeDoubaoFileAudioOnce = async ({ audioUrl, audioFormat = "mp3" } = {}, config, options = {}) => {
  const logger = options.logger;
  const url = String(audioUrl || "").trim();
  if (!url) {
    throw new AgentError("audioUrl is required for Doubao file ASR", {
      code: "ASR_INPUT_MISSING",
      status: 422,
    });
  }

  const normalizedAudioFormat = normalizeFileAsrFormat(audioFormat);
  // 这个 UUID 同时是 task_id：submit 与后续每一次 query 必须用同一个。
  const requestId = randomUUID();
  const headers = {
    ...buildDoubaoAsrHeaders(config, { sequence: "-1", requestId }),
    "X-Api-Resource-Id": config.doubaoFileAsrResourceId,
  };
  const budgetMs = Math.max(1000, Number(config.doubaoFileAsrBudgetMs) || 120000);
  const pollIntervalMs = Math.max(200, Number(config.doubaoFileAsrPollIntervalMs) || 2000);
  const startedAt = Date.now();
  const logFields = {
    requestId,
    audioFormat: normalizedAudioFormat,
    resourceId: config.doubaoFileAsrResourceId,
    budgetMs,
  };

  // ① submit
  const submit = await fetchJson(config.doubaoFileAsrSubmitUrl, {
    method: "POST",
    timeoutMs: config.requestTimeoutMs,
    retries: config.apiRetryAttempts,
    retryBaseDelayMs: config.apiRetryBaseDelayMs,
    logger,
    interfaceName: "doubao:asr.file.submit",
    logFields,
    headers,
    body: JSON.stringify({
      user: { uid: getDoubaoUid(config) },
      audio: { url, format: normalizedAudioFormat },
      request: { model_name: "bigmodel" },
    }),
  });
  const submitCode = readDoubaoApiCode(submit.response, submit.data);
  const submitMessage = submit.response.headers.get("X-Api-Message");
  if ((submitCode && submitCode !== "20000000") || !submit.response.ok) {
    throw new AgentError(`Doubao file ASR submit failed with code ${submitCode || submit.response.status}`, {
      code: "DOUBAO_ASR_FAILED",
      status: submit.response.status,
      details: { submitCode, submitMessage, phase: "submit", requestId },
    });
  }

  // ② 轮询 query
  for (;;) {
    if (Date.now() - startedAt >= budgetMs) {
      // 超时不是"失败得莫名其妙"，而是这条通道的已知特性：如实报出来，让上层回退。
      const error = new AgentError(`Doubao file ASR did not finish within ${budgetMs}ms`, {
        code: "DOUBAO_ASR_TIMEOUT",
        details: { requestId, elapsedMs: Date.now() - startedAt, budgetMs },
      });
      logger?.warn("external.request.timeout", {
        interface: "doubao:asr.file.query",
        endpoint: config.doubaoFileAsrQueryUrl,
        error: error.message,
        code: error.code,
        ...logFields,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }

    await sleep(pollIntervalMs);
    const query = await fetchJson(config.doubaoFileAsrQueryUrl, {
      method: "POST",
      timeoutMs: config.requestTimeoutMs,
      retries: 0,
      logger,
      interfaceName: "doubao:asr.file.query",
      logFields: { ...logFields, elapsedMs: Date.now() - startedAt },
      headers,
      body: JSON.stringify({}),
    });
    const code = readDoubaoApiCode(query.response, query.data);
    const message = query.response.headers.get("X-Api-Message");
    const logid = query.response.headers.get("X-Tt-Logid");

    if (code === "20000001") continue;   // 处理中

    if (code !== "20000000" || !query.response.ok) {
      logger?.error("external.request.error", {
        interface: "doubao:asr.file.query",
        endpoint: config.doubaoFileAsrQueryUrl,
        error: `Doubao file ASR query failed with code ${code}`,
        code: "DOUBAO_ASR_FAILED",
        status: query.response.status,
        details: { code, message, logid, requestId },
      });
      throw new AgentError(`Doubao file ASR query failed with code ${code}`, {
        code: "DOUBAO_ASR_FAILED",
        status: query.response.status,
        details: { code, message, logid, requestId, phase: "query" },
      });
    }

    const transcript = extractAsrTranscript(query.data);
    if (!transcript) {
      throw new AgentError("Doubao file ASR returned empty transcript", {
        code: "DOUBAO_ASR_EMPTY",
        status: query.response.status,
        details: { code, message, logid, requestId, data: query.data },
      });
    }

    logger?.info("doubao.asr.result", {
      interface: "doubao:asr.file.query",
      status: query.response.status,
      apiStatusCode: code,
      apiMessage: message,
      logid,
      requestId,
      transcriptLength: transcript.length,
      audioFormat: normalizedAudioFormat,
      elapsedMs: Date.now() - startedAt,
    });

    return {
      text: transcript,
      utterances: extractAsrUtterances(query.data),
      logid,
      duration: extractAsrDuration(query.data),
      taskId: requestId,
    };
  }
};

/**
 * 录音文件识别的对外入口：**同一条视频的两个等价音源依次尝试**。
 *
 * 🔴 为什么要有这层（2026-09-28 实测得出，不是设计洁癖）：
 *   同一条抖音视频，`music.play_url`（mp3）与视频直链（mp4）里是**同一段音频** ——
 *   实测两条分别转写出 308 / 305 字，逐句几乎一致（只差 BKR5/BK25 这类同音字），
 *   时长 57.2s / 57.0s。所以它们互为等价来源，**换源重试不是"降级"，是第二次尝试**。
 *
 * 这一步的价值在于：ASR 返回空的原因**可能只是这一个源不好**（该源静音/被截断/
 * 文件异常），而另一个源完全正常。换 URL 的成本是**零额外下载**，远低于
 * 下整条视频用 ffmpeg 重抽音频（实测最长 45 秒）—— 而 ffmpeg 抽出来还是同一段音频，
 * 结果大概率一样。
 *
 * 关于 `format`：第二个源声明成 **`m4a`**（在官方白名单 wav/mp3/ogg/spx/amr/aac/m4a 内），
 * 而不是未文档化的 `mp4`。实测服务端**按内容嗅探、根本不看这个字段**：
 * 同一个 mp4 URL 分别声明 mp4 / m4a / aac / mp3 四种格式**全部成功**，且字数与时长完全一致。
 * 所以这里选文档内的写法，失败模式也是良性的（报错 → provider 链照常回退）。
 */
export const recognizeDoubaoFileAudio = async ({ audioSources = [], audioUrl = "", audioFormat = "mp3" } = {}, config, options = {}) => {
  const logger = options.logger;
  // 兼容单源调用：只给 audioUrl 时就是一次普通调用（早期调用方与测试这么用）。
  const sources = (Array.isArray(audioSources) && audioSources.length > 0
    ? audioSources
    : [{ url: audioUrl, format: audioFormat, kind: "single" }]
  ).filter(source => String(source?.url || "").trim());
  if (sources.length === 0) {
    throw new AgentError("audioUrl is required for Doubao file ASR", { code: "ASR_INPUT_MISSING", status: 422 });
  }

  const failures = [];
  let lastError = null;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    try {
      const result = await recognizeDoubaoFileAudioOnce(
        // ⚠️ format 必须在这里就定下来：`source.format || audioFormat` 在外层 audioFormat
        //    未传时会得到 `undefined`，而内层的 `audioFormat = "mp3"` **默认值**会把它
        //    变成 "mp3" —— 于是第二个音源声明的 m4a 被静默改写成 mp3。
        //    （实测踩到过：日志里 video 源报的 format 是 mp3，而不是 m4a。）
        {
          audioUrl: source.url,
          audioFormat: String(source.format || audioFormat || "mp3").toLowerCase(),
        },
        config,
        options,
      );
      if (index > 0) {
        logger?.info("doubao.file_asr.source_retry_ok", {
          kind: source.kind || `source${index + 1}`,
          attempt: index + 1,
          total: sources.length,
        });
      }
      return { ...result, sourceKind: source.kind || `source${index + 1}` };
    } catch (error) {
      lastError = error;
      failures.push({
        kind: source.kind || `source${index + 1}`,
        code: error?.code,
        message: error instanceof Error ? error.message : "source failed",
      });
      logger?.warn("doubao.file_asr.source_failed", {
        kind: source.kind || `source${index + 1}`,
        attempt: index + 1,
        total: sources.length,
        code: error?.code,
        error: error instanceof Error ? error.message : "source failed",
        willRetryNextSource: index + 1 < sources.length,
      });
      // 参数类错误（没给 URL 之类）换源也没用，直接抛。
      if (error?.code === "ASR_INPUT_MISSING") throw error;
    }
  }

  // 🔴 单源调用**原样抛出内层错误**：调用方依赖 `details.phase`、上游状态码这些内层
  //    字段定位问题；包一层"所有音源都失败"反而把最有用的信息盖掉（实测会盖掉
  //    `details.code = 45000002` 这类上游错误码）。
  if (sources.length === 1 && lastError) throw lastError;

  // 多源全部失败：把每个源的原因一起带出去，别只报最后一个 —— 排查时要知道
  // 是"两个源都空"还是"第一个源文件坏了"。
  const wrapper = new AgentError("Doubao file ASR failed for every audio source", {
    code: failures.some(item => item.code === "DOUBAO_ASR_TIMEOUT") ? "DOUBAO_ASR_TIMEOUT" : "DOUBAO_ASR_FAILED",
    details: { failures },
  });
  // 保留最后一个源的内层 details（上游状态码 / logid 等），否则多源失败时更难查。
  if (lastError?.details) wrapper.details.lastSource = lastError.details;
  throw wrapper;
};

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
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const imported = await import("ffmpeg-static");
  const ffmpegPath = imported.default || imported;
  if (!ffmpegPath || typeof ffmpegPath !== "string") {
    throw new AgentError("ffmpeg-static did not expose a binary path", { code: "FFMPEG_MISSING" });
  }
  return ffmpegPath;
};

export const buildFfmpegAudioExtractArgs = ({ input = "pipe:0", fastProbe = false, audioFormat = "mp3", config = {}, clipSeconds = 0, tailSeconds = 0 } = {}) => {
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
  // 取**结尾**几秒（2.3 结尾钩子用）：`-sseof` 相对 EOF 定位，是**输入选项**，必须在 -i 之前。
  // ⚠️ 它要求输入可 seek —— 管道（pipe:0）seek 不了，所以尾部裁剪必须让 ffmpeg 直接读 URL，
  // 依赖 CDN 支持 Range 请求（实测抖音 CDN 支持）。详见 transcribeVideo 里的分支。
  const tail = Number(tailSeconds);
  const tailClip = Number.isFinite(tail) && tail > 0 ? tail : 0;
  if (tailClip > 0) {
    args.push("-sseof", `-${tailClip}`);
  }
  args.push(
    "-i",
    input,
  );
  // 只取开头的一小段音频（黄金三秒只需要开场，见 GOLD_TRANSCRIPT_CLIP_SECONDS）。
  // 必须放在 -i 之后：作为**输出选项**才生效，ffmpeg 拿到够用的输出就会停止读取输入，
  // 于是「下载/解码整条视频」这段最贵的时间被省掉。
  // 默认 0 = 不裁剪，员工二创链路需要完整转写，不要给它加这个参数。
  // 取结尾时不用 -t：`-sseof -N` 本身就只读到文件末尾，正好 N 秒。
  const clip = Number(clipSeconds);
  if (tailClip === 0 && Number.isFinite(clip) && clip > 0) {
    args.push("-t", String(clip));
  }
  args.push(
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

/**
 * 给流挂一个**兜底 error 监听**。
 *
 * 🔴 这是为了修一个会把整个 Node 进程打死的问题（2026-09-28 用户实测）：
 *
 *   视频号媒体走「下载 → 解密 transform → 喂 ffmpeg stdin」。`fetchMediaResponse` 的
 *   try/catch **只覆盖"拿到响应头"那一段** —— 头一到就 `return`，之后流式传输期间
 *   对端断流（CDN 很常见，堆栈里是 `UND_ERR_SOCKET: other side closed`，已读 3.4MB），
 *   错误就发生在返回**之后**，那个 catch 管不着。
 *
 *   而 `Readable.fromWeb(response.body)` 包出来的流一旦出错且当时**没有** error 监听，
 *   Node 会把它当 unhandled 'error' event 直接抛出 → 进程退出。
 *   实测表现：`Failed running 'src/index.js'` + 前端 `socket hang up` 长时间无结果。
 *
 *   窗口期真实存在：流在 `prepareVideoInput` 里创建（1423 行），而消费侧
 *   `inputStream.on("error", ...)` 要等 ffmpeg 启动后才挂上 —— 头刚拿到、ffmpeg
 *   还没起来时对端断流，就落在这个窗口里。
 *
 * ⚠️ 有了兜底监听**不会**吞掉错误，消费侧照样能感知失败 —— 但机制要说准：
 *    Node 的 `pipe()` **不转发**源流的 error（出错时只调 `dest.end()`，不 emit error）。
 *    真正让 ffmpeg 链路能感知失败的是 `extractAudioFromStream` 里在**同一个流**上
 *    直接挂的 `inputStream.on("error", ...)`（它负责 kill ffmpeg 并 reject）。
 *    多个监听互不影响，所以兜底只负责**不让进程死** + 留一条可定位的日志。
 */
export const guardStreamErrors = (stream, { logger, label = "media stream", logFields = {} } = {}) => {
  if (!stream || typeof stream.on !== "function") return stream;
  stream.on("error", error => {
    // 不 re-throw、不 destroy：错误已经由 pipe 链传给下游，这里只是兜住
    // "没有任何监听者"这个会让进程退出的状态。
    logger?.warn("stream.error_guarded", {
      label,
      code: error?.code || error?.cause?.code,
      error: error instanceof Error ? error.message : String(error),
      ...logFields,
    });
  });
  return stream;
};

const fetchBinary = async (url, config, options = {}) => {
  const logger = options.logger;
  const maxAttempts = Math.max(1, Number(config.apiRetryAttempts || 0) + 1);
  const maxBytes = Number(config.wechatMediaMaxBytes || 220 * 1024 * 1024);
  const interfaceName = options.interfaceName || "wechat_channels:media-download";
  const errorLabel = options.errorLabel || "WeChat Channels media";
  const failureCode = options.failureCode || "WECHAT_MEDIA_DOWNLOAD_FAILED";
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
    });

    try {
      const response = await fetch(url, { signal: timeout.signal });
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > maxBytes) {
        throw new AgentError(`${errorLabel} exceeded download limit`, {
          code: "WECHAT_MEDIA_TOO_LARGE",
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
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        throw new AgentError(`${errorLabel} exceeded download limit`, {
          code: "WECHAT_MEDIA_TOO_LARGE",
          status: 413,
          details: { bytes: buffer.length, maxBytes },
        });
      }
      logger?.info("external.request.end", {
        interface: interfaceName,
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
        interface: interfaceName,
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
    : new AgentError(`${errorLabel} download failed`, { code: failureCode });
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
      // 外部可以主动中止下载（例如 ffmpeg 裁够了就收工）。不接这个信号的话，
      // ffmpeg 提前退出后下载会一直挂着白拉，还会把数据写向已经关闭的 socket。
      const signal = options.signal ? AbortSignal.any([timeout.signal, options.signal]) : timeout.signal;
      const response = await undiciFetch(url, {
        signal,
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

  // 🔴 立刻给源流挂兜底 error 监听，堵住「流已创建、ffmpeg 还没挂监听」那段窗口 ——
  //    否则对端在这里断流就是 unhandled 'error'，**整个进程退出**（见 guardStreamErrors）。
  const source = guardStreamErrors(toNodeReadable(body), {
    logger,
    label: "wechat_channels:media",
    logFields: { title: videoMeta.title },
  });
  // web stream (response.body) 转 Node readable 后过解密 transform
  const decryptedStream = source.pipe(decryptTransform);
  // 解密 transform 自己也要兜住：源流错误经 `source.pipe` 已经会让它 destroy，
  // 但 destroy 期间若无人接手 'error'，同样是进程级事故。
  guardStreamErrors(decryptedStream, {
    logger,
    label: "wechat_channels:decrypted",
    logFields: { title: videoMeta.title },
  });

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

const getTikHubMediaCandidates = videoMeta => {
  const sizes = videoMeta?.videoUrlSizes || {};
  const priorities = videoMeta?.videoUrlPriorities || {};
  return uniqueStrings([
    ...(Array.isArray(videoMeta?.videoUrls) ? videoMeta.videoUrls : []),
    videoMeta?.videoUrl,
  ])
    .filter(shouldStreamVideoInputForFfmpeg)
    .sort((a, b) => {
      // 复合排序：先按来源类型优先级（music/download_addr > play_addr > 未知），
      // 再按文件大小升序（同类型内小文件优先，转写不需高画质）。
      // 无信息的 URL 排最后，但不会被丢弃。
      // 这是解决抖音 DASH 音画分离问题的关键：避免选到纯视频流（无音频）的高码率 URL。
      const pa = priorities[a] ?? 4;
      const pb = priorities[b] ?? 4;
      if (pa !== pb) return pa - pb;
      const sa = sizes[a] || Infinity;
      const sb = sizes[b] || Infinity;
      return sa - sb;
    });
};

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
  // ffmpeg 拿到足够的数据（裁剪秒数到了）就立刻中止下载：既不白拉整条视频，
  // 也避免继续往已经关闭的管道里写。中止由 extractAudioFromStream 在 ffmpeg
  // 退出时回调触发。
  const abortController = new AbortController();
  const { body, contentLength, cancelTimeout } = await fetchMediaResponse(videoUrl, config, {
    logger,
    interfaceName: options.interfaceName || "video:media-download-stream",
    errorLabel: options.errorLabel || "video media",
    tooLargeCode: options.tooLargeCode || "MEDIA_TOO_LARGE",
    failureCode: options.failureCode || "MEDIA_DOWNLOAD_FAILED",
    headers: VIDEO_STREAM_FETCH_HEADERS,
    signal: abortController.signal,
  });
  // 方案 B：超大文件预警。配合方案 A 的 URL 按大小排序，正常情况下小文件已优先命中，
  // 只有所有小文件都失败时才会试到大文件。这里只记录警告，不硬拒绝（避免误伤正常高清视频）。
  const largeThreshold = Number(config.tikhubMediaLargeBytes || 50 * 1024 * 1024);
  if (contentLength > largeThreshold) {
    logger?.warn("media.download.large_file", {
      interface: options.interfaceName || "video:media-download-stream",
      contentLength,
      threshold: largeThreshold,
      ...describeVideoUrlForDiagnostics(videoUrl),
    });
  }
  // 🔴 同视频号那条：源流在交给 ffmpeg **之前**必须有兜底 error 监听。
  //    `extractAudioFromStream` 里虽然会挂 `inputStream.on("error")`，但那是进入它之后
  //    才挂的；这段窗口里对端断流就是 unhandled 'error' → 进程退出。
  const inputStream = guardStreamErrors(toNodeReadable(body), {
    logger,
    label: "tikhub:media-stream",
    logFields: describeVideoUrlForDiagnostics(videoUrl),
  });

  try {
    return await extractAudioFromStream(inputStream, config, {
      logger,
      inputLabel: options.inputLabel || "http-media-stream",
      strategy: options.strategy || "stream",
      fastProbe: Boolean(options.fastProbe),
      audioFormat: options.audioFormat || "mp3",
      clipSeconds: options.clipSeconds,
      // ffmpeg 一退出就中止下载。
      onFfmpegSettled: () => abortController.abort(),
    });
  } finally {
    // ffmpeg 正常收尾时 onFfmpegSettled 已经中止过了；这里兜住抛异常等路径。
    abortController.abort();
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
  const candidates = getTikHubMediaCandidates(videoMeta).slice(0, Math.max(1, Number(config.tikhubMediaUrlMaxAttempts || 2)));
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
  // 取结尾（tailSeconds）时**必须**让 ffmpeg 直接读 URL：`-sseof` 要 seek，
  // 而流式分支喂的是 pipe:0，seek 不了。这里显式绕开流式分支。
  const wantsTail = Number(options.tailSeconds) > 0;
  if (!wantsTail && shouldStreamVideoInputForFfmpeg(videoUrl)) {
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
    ...(wantsTail ? { tailSeconds: Number(options.tailSeconds) } : {}),
    ...(Number(options.clipSeconds) > 0 ? { clipSeconds: Number(options.clipSeconds) } : {}),
  });

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let stderr = "";
    let finished = false;
    const child = spawn(ffmpegPath, buildFfmpegAudioExtractArgs({ input: videoUrl, audioFormat, config, clipSeconds: options.clipSeconds, tailSeconds: options.tailSeconds, fastProbe: Boolean(options.fastProbe) }));

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
  // 管道不可 seek，`-sseof` 在这里必然失败。与其让用户拿到一段**位置错误**的音频
  // （那会静默毁掉结尾钩子的分析），不如显式报错，让编排层回退到别的方案。
  if (Number(options.tailSeconds) > 0) {
    throw new AgentError("tailSeconds requires a seekable URL input, not a stream", {
      code: "FFMPEG_TAIL_NEEDS_SEEKABLE_INPUT",
    });
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
      clipSeconds: options.clipSeconds,
    }));

    /**
     * ffmpeg 退出后把输入侧收干净。
     *
     * **这是 2026-09-17 那个崩溃（`write EPIPE`）的修复点。** 裁剪让 ffmpeg 提前退出，
     * 于是：① 下载还在继续白拉；② `pipe` 仍可能往已关闭的 `child.stdin` 写入。
     * Node 的 `pipe` **不会**替调用方吞掉 destination 的 error —— 没有监听就是
     * 未捕获异常，整个进程直接挂掉（本地 Express / serverless 实例一起没）。
     *
     * 所以这里必须显式做三件事：解绑、销毁输入流、中止下载。
     */
    const stopInput = () => {
      try { inputStream.unpipe(child.stdin); } catch { /* ignore */ }
      try { if (!inputStream.destroyed) inputStream.destroy(); } catch { /* ignore */ }
      try { options.onFfmpegSettled?.(); } catch { /* 中止回调失败不该影响转写结果 */ }
    };

    // EPIPE / ERR_STREAM_DESTROYED 是「ffmpeg 已经退出」的正常后果，不是错误；
    // 其余 stdin 写入失败才值得记一笔。
    child.stdin.on("error", error => {
      const code = error?.code;
      if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED") {
        logger?.warn("ffmpeg.stdin.error", {
          interface: "ffmpeg-static",
          code,
          error: error instanceof Error ? error.message : "ffmpeg stdin 写入失败",
        });
      }
    });

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        child.kill("SIGKILL");
        stopInput();
        reject(new AgentError("ffmpeg audio extraction timed out", { code: "FFMPEG_TIMEOUT" }));
      }
    }, config.ffmpegTimeoutMs);

    child.stdout.on("data", chunk => {
      totalBytes += chunk.length;
      if (totalBytes > audioOutputLimitBytes(config, audioFormat)) {
        finished = true;
        child.kill("SIGKILL");
        stopInput();
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
      finished = true;
      clearTimeout(timer);
      stopInput();
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
      // 最关键的一处：裁剪让 ffmpeg 正常提前退出，`finished` 已置位，
      // 随后 stopInput 触发的流/socket 错误会被下面的 inputStream error 兜底忽略。
      stopInput();
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

/**
 * 豆包多模态共用的鉴权头。
 *
 * 视频理解与图片拆解走的是同一个 endpoint、同一套凭据，头怎么拼只能有一份 ——
 * 两边各写一遍的话，换 header 名时必漏一个（那种错不会报错，只会 401）。
 */
const doubaoMultimodalHeaders = config => {
  if (!config.doubaoVideoEndpoint || !config.doubaoVideoApiKey) {
    throw new AgentError("Missing Doubao multimodal endpoint or credentials", {
      code: "DOUBAO_VIDEO_CREDENTIALS_MISSING",
    });
  }
  const headers = { "Content-Type": "application/json" };
  if (config.doubaoVideoAuthHeader.toLowerCase() === "authorization") {
    headers.Authorization = `Bearer ${config.doubaoVideoApiKey}`;
  } else {
    headers[config.doubaoVideoAuthHeader] = config.doubaoVideoApiKey;
  }
  return headers;
};

/** 豆包多模态返回的正文（兼容 choices / output_text / result.text 几种形状）。 */
const doubaoMultimodalText = data => cleanModelText(
  data?.choices?.[0]?.message?.content ||
    data?.output_text ||
    data?.text ||
    data?.result?.text ||
    "",
);

const callDoubaoVideoUnderstanding = async (videoUrl, config, options = {}) => {
  const headers = doubaoMultimodalHeaders(config);

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

  const text = doubaoMultimodalText(data);

  if (!text) {
    throw new AgentError("Doubao video understanding returned empty text", {
      code: "DOUBAO_VIDEO_EMPTY",
      details: data,
    });
  }
  return text;
};

/**
 * 豆包多模态：**图片**理解（对标封面拆解用）。
 *
 * 与视频理解同一条链路、同一套凭据，只是 content 里换成 `image_url`。
 * 2026-09-23 实测：同一个 endpoint + `doubao-seed-2-0-mini` 收 base64 dataURL 返回 200，
 * 且描述准确（测试卡的彩条、渐变带、弧形里的数字都认出来了）——
 * 所以「用户上传对标封面 → 拆解画风/元素/排版/视觉风格」**不需要新增供应商或密钥**。
 *
 * @param imageUrl  http(s) 链接，或 `data:image/...;base64,...`
 * @param prompt    拆解提示词（见 prompts.js 的 BENCHMARK_COVER_ANALYSIS_PROMPT）
 */
export const understandDoubaoImage = async (imageUrl, prompt, config, options = {}) => {
  const target = String(imageUrl || "").trim();
  if (!target) {
    throw new AgentError("Missing image for understanding", { code: "DOUBAO_IMAGE_MISSING" });
  }
  const headers = doubaoMultimodalHeaders(config);

  const { data } = await fetchJson(config.doubaoVideoEndpoint, {
    method: "POST",
    timeoutMs: config.requestTimeoutMs,
    retries: config.apiRetryAttempts,
    retryBaseDelayMs: config.apiRetryBaseDelayMs,
    logger: options.logger,
    interfaceName: "doubao:image-understanding",
    headers,
    body: JSON.stringify({
      model: config.doubaoVideoModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: String(prompt || "") },
            { type: "image_url", image_url: { url: target } },
          ],
        },
      ],
      temperature: 0.1,
    }),
  });

  const text = doubaoMultimodalText(data);
  if (!text) {
    throw new AgentError("Doubao image understanding returned empty text", {
      code: "DOUBAO_IMAGE_EMPTY",
      details: data,
    });
  }
  return text;
};

// 流式识别 2.0 的重试白名单：只重试「连接/超时/坏帧」这类可恢复错误。
// 凭据缺失（配置问题）、空文本（再跑一遍大概率还是空，且会重复计费）都不重试。
const STREAM_RETRYABLE_CODES = new Set([
  "DOUBAO_STREAM_ASR_FAILED",
  "DOUBAO_STREAM_ASR_TIMEOUT",
  "DOUBAO_STREAM_ASR_BAD_FRAME",
]);

/**
 * 流式识别 2.0 的「同一份 PCM 重试一次」包装（2026-10-18 A 方案）。
 *
 * 为什么必须在 provider 层重试、而不是让上层重新抽音频：
 *   · 视频号的解密流是**一次性**的，`prepareVideoInput` 只能消费一次；重新抽 PCM 等于重新
 *     下载 + 解密整条视频，代价很高；
 *   · PCM 已经以 Buffer 形式在内存里，WS 失败时直接复用同一份 PCM 再连一次即可。
 *
 * 预算：第一次用 `doubaoStreamAsrBudgetMs`（默认 120s）；第二次重试默认压到 60s，
 * 避免 120s + 120s 叠加把端点 maxDuration（300s）和批预算（240s）顶穿。
 * 只对「可恢复错误」重试；空文本/缺凭据/输入缺失直接抛给 provider 链。
 *
 * @param {object} options
 * @param {Buffer|Uint8Array} options.pcm
 * @param {object} options.config
 * @param {object} [options.logger]
 * @param {number} [options.maxAttempts=2] 总尝试次数（含第一次）
 * @param {number} [options.retryBudgetMs=60000] 第二次及以后每次的 WS 预算
 * @param {number} [options.retryDelayMs=300]
 * @param {Function} [options.recognizeImpl] 测试注入点，默认 recognizeDoubaoStreamAudio
 */
export const recognizeDoubaoStreamAudioWithRetry = async ({
  pcm,
  config,
  logger,
  maxAttempts = 2,
  retryBudgetMs = 60000,
  retryDelayMs = 300,
  recognizeImpl = recognizeDoubaoStreamAudio,
} = {}) => {
  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 2));
  const baseBudget = Number(config?.doubaoStreamAsrBudgetMs) || 120000;
  const retryBudget = Math.max(1000, Math.min(Number(retryBudgetMs) || 60000, baseBudget));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const attemptConfig = attempt === 1
        ? config
        : { ...config, doubaoStreamAsrBudgetMs: retryBudget };
      return await recognizeImpl({ pcm, config: attemptConfig, logger });
    } catch (error) {
      lastError = error;
      const code = error?.code || "";
      const retryable = !code || STREAM_RETRYABLE_CODES.has(code);
      if (!retryable || attempt >= attempts) throw error;

      logger?.warn("doubao.stream.asr.retry", {
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: attempts,
        code,
        error: error instanceof Error ? error.message : "Doubao stream ASR failed",
        retryBudgetMs: retryBudget,
        audioBytes: pcm?.length || 0,
      });
      await sleep(Math.max(0, Number(retryDelayMs) || 0));
    }
  }

  throw lastError;
};

export const transcribeVideo = async (videoMeta, config, options = {}) => {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const logger = options.logger;
  // 裁剪口径必须进缓存 key：黄金三秒只取**开头**几秒，结尾钩子只取**结尾**几秒，
  // 员工二创要完整脚本 —— 同一个视频三种完全不同的片段。
  // 只按 videoId 缓存的话，同一个视频在同一个进程里会串味：二创或 2.3 会拿到 2.2 的
  // 开头转写，而且不会有任何报错。
  const tailSeconds = Number(options.tailSeconds) > 0 ? Number(options.tailSeconds) : 0;
  const clipSeconds = tailSeconds > 0 ? 0 : (Number(options.clipSeconds) > 0 ? Number(options.clipSeconds) : 0);
  const clipMode = tailSeconds > 0 ? `tail${tailSeconds}` : (clipSeconds > 0 ? `head${clipSeconds}` : "full");
  const cacheKey = `${videoMeta.awemeId || videoMeta.videoUrl || videoMeta.shareLink}::${clipMode}`;
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
  // 调用方可以显式指定 provider 顺序（黄金三秒就是这么做的：本地 ffmpeg 排第一，
  // 见 config.goldTranscriptProviders）。显式指定时**不再套用**「有 TikHub 就跳过本地
  // ffmpeg」那条隐式优化 —— 否则显式顺序会被静默改掉，等于没指定。
  const explicitProviders = Array.isArray(options.providers) && options.providers.length > 0;
  const providers = explicitProviders
    ? options.providers
    : (Array.isArray(config.transcriptProviders) ? config.transcriptProviders : []);
  const hasTikHubProvider = providers.includes("tikhub-ffmpeg");
  const hasMusicProvider = providers.includes("tikhub-music");
  try {
    for (const provider of providers) {
      // ── 豆包录音文件识别 2.0：只传 URL，服务端自己拉，不需要本地 ffmpeg ──
      // 优先用 `music.play_url` 的 mp3（音量/人声与视频一致，且是纯音频、体积小）；
      // 音源按 music(mp3) → video(m4a) 排序；一个源空/坏时换另一个重试（成本接近零）。
      if (provider === "doubao-file") {
        const fileSources = pickDoubaoFileAudioSources(videoMeta);
        if (fileSources.length === 0) {
          logger?.info("transcript.provider.skipped", {
            provider,
            reason: "no direct http(s) media url for server-side fetch",
            videoTitle: videoMeta.title,
          });
          continue;
        }
        const providerStartedAt = Date.now();
        try {
          logger?.info("transcript.provider.start", {
            provider,
            videoTitle: videoMeta.title,
            sourceKinds: fileSources.map(source => source.kind).join(","),
            // 多源的意义：一个源空/坏时换另一个，成本接近零（见 recognizeDoubaoFileAudio）。
            sourceCount: fileSources.length,
          });
          onProgress({
            step: "transcript-provider-start",
            provider,
            message: `尝试转写方案：${provider}（豆包录音文件识别 2.0，服务端直接拉音频，${fileSources.length} 个音源）`,
          });
          const asr = await recognizeDoubaoFileAudio(
            { audioSources: fileSources },
            config,
            { logger },
          );
          const text = String(asr?.text || "").trim();
          if (!text) throw new Error("豆包录音文件识别返回空文本");
          const value = {
            text,
            provider: "doubao-file-asr",
            logid: asr.logid,
            duration: asr.duration,
          };
          logger?.info("transcript.provider.success", {
            provider: value.provider,
            videoTitle: videoMeta.title,
            textLength: text.length,
            audioSourceKind: asr.sourceKind || "",
            elapsedMs: Date.now() - providerStartedAt,
          });
          onProgress({
            step: "transcript-provider-success",
            provider: value.provider,
            message: `转写方案成功：${value.provider}`,
          });
          transcriptCache.set(cacheKey, { createdAt: Date.now(), value });
          return value;
        } catch (error) {
          logger?.warn("transcript.provider.failed", {
            provider,
            videoTitle: videoMeta.title,
            code: error?.code,
            error: error instanceof Error ? error.message : "doubao-file provider failed",
          });
          warnings.push({
            provider,
            step: "doubao-file",
            code: error?.code,
            message: error instanceof Error ? error.message : "doubao-file provider failed",
          });
          continue;
        }
      }
      // ── 豆包流式/实时语音识别 2.0（WebSocket，2026-10-18）────────────────
      // 与 doubao-file 的关键差别：
      //   · 音频不再交给服务端自己拉 URL，而是本地 ffmpeg 抽成 16k s16le PCM，
      //     经 WebSocket 二进制帧发送（burst 全速，实测 26.8s 音频约 2.6s 出结果）；
      //   · 因为 PCM 在本地裁剪，head/tail 的 5 秒 clip 对这条通道**真的生效**，
      //     不会像 doubao-file 那样整条音频计费；
      //   · 视频号用 prepareVideoInput 解密出来的 stream 作为输入，不再依赖公网 URL。
      // 失败/超时统一交给 provider 链回退，不影响其它通道。
      if (provider === "doubao-stream") {
        const providerStartedAt = Date.now();
        try {
          onProgress({
            step: "transcript-provider-start",
            provider,
            message: "尝试转写方案：doubao-stream（流式识别 2.0，本地抽 PCM 后 WebSocket 发送）",
          });
          const pcmAudio = await extractPcmAudio(videoMeta, prepared, config, {
            clipSeconds,
            tailSeconds,
            // head 裁剪（2.2/2.3/1.2 只取开头几秒）启用 fast-probe，明显减少远端探测开销；
            // 完整转写/尾部不启用（与既有 ffmpeg provider 的口径一致）。
            fastProbe: clipSeconds > 0 && tailSeconds === 0,
            logger,
          });
          // A 方案：PCM 只抽一次；WS 失败用同一份 PCM 重试一次（视频号解密流无法二次消费）。
          const asr = await recognizeDoubaoStreamAudioWithRetry({
            pcm: pcmAudio.pcm,
            config,
            logger,
          });
          const text = String(asr?.text || "").trim();
          if (!text) {
            throw new AgentError("豆包流式识别返回空文本", { code: "DOUBAO_STREAM_ASR_EMPTY" });
          }
          // provider 标签里带上裁剪口径，报告/DB 里能直接看出这条转写取的是开头还是结尾。
          const clipLabel = tailSeconds > 0 ? `+tail${tailSeconds}s` : (clipSeconds > 0 ? `+clip${clipSeconds}s` : "");
          const value = {
            text,
            utterances: Array.isArray(asr.utterances) ? asr.utterances : [],
            logid: asr.logid,
            duration: asr.duration,
            provider: `doubao-stream-asr${clipLabel}`,
            warnings,
          };
          logger?.info("transcript.provider.success", {
            provider: value.provider,
            videoTitle: videoMeta.title,
            textLength: text.length,
            audioBytes: pcmAudio.bytes,
            audioSourceKind: pcmAudio.sourceKind,
            elapsedMs: Date.now() - providerStartedAt,
          });
          onProgress({
            step: "transcript-provider-success",
            provider: value.provider,
            message: `转写方案成功：${value.provider}`,
          });
          transcriptCache.set(cacheKey, { createdAt: Date.now(), value });
          return value;
        } catch (error) {
          logger?.warn("transcript.provider.failed", {
            provider,
            videoTitle: videoMeta.title,
            code: error?.code,
            error: error instanceof Error ? error.message : "doubao-stream provider failed",
          });
          onProgress({
            step: "transcript-provider-failed",
            provider,
            level: "warn",
            message: `转写方案失败：${provider}`,
            detail: error instanceof Error ? error.message : "doubao-stream provider failed",
            code: error?.code,
          });
          warnings.push({
            provider,
            step: "doubao-stream",
            code: error?.code,
            message: error instanceof Error ? error.message : "doubao-stream provider failed",
          });
          continue;
        }
      }
      if (provider === "tikhub-music" && !videoMeta.musicUrl) {
        logger?.info("transcript.provider.skipped", {
          provider,
          reason: "no music.play_url available (non-TikHub video or missing field)",
          videoTitle: videoMeta.title,
        });
        continue;
      }
      if (provider === "tikhub-music" && isWeChatChannelsVideo(videoMeta)) {
        logger?.info("transcript.provider.skipped", {
          provider,
          reason: "tikhub-music only applies to douyin/tiktok videos",
          videoTitle: videoMeta.title,
        });
        continue;
      }
      if (provider === "tikhub-ffmpeg" && !shouldUseTikHubFfmpegProvider(videoMeta)) {
        logger?.info("transcript.provider.skipped", {
          provider,
          reason: "not TikHub CDN media",
          videoTitle: videoMeta.title,
        });
        continue;
      }
      if (provider === "ffmpeg" && !explicitProviders && hasTikHubProvider && shouldUseTikHubFfmpegProvider(videoMeta)) {
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
        if (provider === "tikhub-music") {
          // tikhub-music：直接下载 music.play_url 的 mp3 → base64 → 送 ASR，跳过 ffmpeg 提取。
          // 若 ASR 返回空（纯背景音乐无人声），抛 DOUBAO_ASR_EMPTY → provider 链自动回退到 tikhub-ffmpeg。
          logger?.info("tikhub.music.download.start", {
            musicUrl: describeVideoUrlForDiagnostics(videoMeta.musicUrl),
            title: videoMeta.title,
          });
          const buffer = await fetchBinary(videoMeta.musicUrl, config, {
            logger,
            interfaceName: "tikhub:music-download",
            errorLabel: "TikHub music audio",
            failureCode: "TIKHUB_MUSIC_DOWNLOAD_FAILED",
          });
          // 极小文件（<1KB）说明不是有效音频，直接跳过让回退
          if (buffer.length < 1024) {
            throw new AgentError("TikHub music audio too small, likely invalid", {
              code: "MUSIC_AUDIO_TOO_SMALL",
              details: { bytes: buffer.length },
            });
          }
          onProgress({
            step: "audio-extracted",
            provider,
            audioBytes: buffer.length,
            message: `music.play_url 已下载 ${buffer.length} 字节 mp3，直接调用豆包 ASR（跳过 ffmpeg）`,
          });
          const asr = await recognizeDoubaoAudio(
            { audioDataBase64: buffer.toString("base64"), audioFormat: "mp3", audioBytes: buffer.length },
            config,
            { logger },
          );
          const value = { ...asr, provider: "tikhub-music+doubao-asr:mp3", warnings };
          logger?.info("transcript.provider.success", {
            provider: value.provider,
            textLength: value.text.length,
            duration: value.duration,
            audioBytes: buffer.length,
          });
          onProgress({
            step: "transcript-provider-success",
            provider: value.provider,
            message: `转写方案成功：${value.provider}`,
          });
          transcriptCache.set(cacheKey, { createdAt: Date.now(), value });
          return value;
        }
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
          // clipSeconds / tailSeconds 在函数开头已按「二选一」归一化好了
          // （tail 优先，且 tail 时 clipSeconds 归 0）。
          // 视频号走流式管道（prepared.stream）；抖音/直链用 prepared.videoUrl。
          // 注意取结尾时 extractAudioWithFfmpeg 会强制走 URL 输入（管道 seek 不了）。
          const extract = useFastProbe => (prepared.stream
            ? extractAudioFromStream(prepared.stream, config, { logger, audioFormat: "mp3", clipSeconds, tailSeconds, fastProbe: useFastProbe })
            : extractAudioWithFfmpeg(prepared.videoUrl, config, { logger, audioFormat: "mp3", clipSeconds, tailSeconds, fastProbe: useFastProbe }));

          // 裁剪时用 fast-probe：ffmpeg 默认探测窗口是 probesize 5MB / analyzeduration 5s，
          // 对一条只要开头几秒的音频来说太重（实测占掉提取阶段的大头）。探不到音频流会抛
          // FFMPEG_EMPTY，这里回退一次保守探测，再不行才交给链上的下一个 provider。
          // 尾部裁剪不用 fast-probe：`-sseof` 本身已定位到文件尾，实测没有差别（§4.4）。
          // 完整转写（员工二创）也不加 —— 那边不能为了快冒丢音频流的风险。
          let audio;
          if (clipSeconds > 0) {
            try {
              audio = await extract(true);
            } catch (error) {
              if (!shouldRetryFfmpegConservatively(error)) throw error;
              logger?.warn("ffmpeg.fast_probe.retry_conservative", {
                interface: "ffmpeg-static",
                code: error?.code,
                error: error instanceof Error ? error.message : "fast-probe 提取失败",
              });
              audio = await extract(false);
            }
          } else {
            audio = await extract(false);
          }
          onProgress({
            step: "audio-extracted",
            provider,
            message: "ffmpeg-static 已提取音频，开始调用豆包 ASR",
          });
          const asr = await recognizeDoubaoAudio(audio, config, { logger });
          // provider 里带上裁剪口径：报告里的 transcriptProvider 会如实显示这条转写
          // 取的是开头还是结尾（`+clip5s` / `+tail5s`）。
          const clipLabel = tailSeconds > 0 ? `+tail${tailSeconds}s` : (clipSeconds > 0 ? `+clip${clipSeconds}s` : "");
          const value = { ...asr, provider: `ffmpeg+doubao-asr:${audio.audioFormat}${clipLabel}`, warnings };
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

/**
 * 跑一个「要 JSON 输出」的 Agent：模型回的不是合法 JSON 时，会再调一次 JSON 修复器。
 *
 * 导出给发布仓的三个 Agent 复用（§0.3）—— 不导出的话那边得把这段重写一遍，
 * 而「JSON 修复 + 归一化」正是最容易各自漂移的地方。
 */
export const runJsonAgent = async ({ system, user, normalizer, interfaceName }, config, options = {}) => {
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

/**
 * 归一化「按大类配比」的新选项。
 *
 * 🔴 **类型与条数以槽位计划为准，模型回什么都不改这个事实**（§6.3⑪⑬ 同一条纪律）：
 *   - 模型回的 `type` 与槽位对不上时，**以槽位为准**并记一条 warning ——
 *     配比是后端实算的，不能让模型用一句「我觉得这条是恐惧」把配比改掉；
 *   - 模型回的类型认不出 / 条数不够 / content 为空：**丢掉那一条**，
 *     绝不用空字符串占位（前端的空候选会渲染成一个点不了的按钮）。
 */
const normalizeCreativeCandidates = (value, adaptation, agentName, logger) => {
  const output = value?.output && typeof value.output === "object" ? value.output : value;
  const rawItems = Array.isArray(output?.items) ? output.items : [];
  const slots = Array.isArray(adaptation?.slots) ? adaptation.slots : [];
  if (slots.length === 0) return [];

  const byIndex = new Map();
  rawItems.forEach((item, position) => {
    const index = Number(item?.index);
    // 模型偶尔漏写 index：按出现顺序补位（它就是照着槽位顺序写的）。
    const key = Number.isFinite(index) && index > 0 ? index : position + 1;
    if (!byIndex.has(key)) byIndex.set(key, item);
  });

  const candidates = [];
  let mismatched = 0;
  let missing = 0;
  for (const slot of slots) {
    const item = byIndex.get(slot.index);
    const content = cleanModelText(item?.content || item?.text || "").trim();
    if (!content) {
      missing += 1;
      continue;
    }
    const returnedType = String(item?.type || "").trim();
    if (returnedType && returnedType !== slot.type) mismatched += 1;
    candidates.push({
      index: slot.index,
      type: slot.type,
      typeLabel: slot.typeLabel,
      content,
    });
  }

  if (missing > 0 || mismatched > 0) {
    logger?.warn("creative.adaptation.normalized", {
      interface: `deepseek:agent-${agentName}-adapt`,
      slotCount: slots.length,
      returnedCount: candidates.length,
      missing,
      mismatched,
      source: adaptation?.source || "",
    });
  }
  return candidates;
};

/** 原文案类型判断的归一化：认不出的类型一律 unknown，不猜。 */
const normalizeOriginalType = (value, allowedTypes, labels = {}) => {
  const output = value?.output && typeof value.output === "object" ? value.output : value;
  const type = String(output?.originalType || output?.original_type || "").trim();
  const valid = allowedTypes.includes(type);
  return {
    type: valid ? type : "unknown",
    // 命中时补中文标签，省得每个调用方各查一次；判不出时保留人工判断的措辞。
    typeLabel: valid ? (labels[type] || "") : "待人工判断",
    reason: cleanModelText(output?.reason || output?.originalReason || "").slice(0, 300),
  };
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

/**
 * 标题配比已生效、但标题 Agent 失败时的兜底。
 *
 * 与 `fallbackTitleText` 的区别：这里**已经拿到了配比计划**，所以只填第 1 个槽位
 * （用对标视频原标题顶位），并在文本里如实说明「只出了 1 条、原因是 Agent 不可用」。
 *
 * 🔴 刻意**不按槽位编满 10 条**：那会把「模型没写出来」伪装成「生成成功」，
 *    用户拿到 10 条看起来正常的标题却不知道其中 9 条是模板占位 —— 这正是
 *    HANDOFF 反复强调的「静默降级别当成成功」。宁可少给、并且说清楚。
 */
const buildTitleAdaptationFallback = (videoMeta, transcriptText, adaptation) => {
  const title = compactText(videoMeta.title || firstSentence(transcriptText, 32) || "对标视频核心内容拆解", 32);
  const slot = Array.isArray(adaptation?.slots) ? adaptation.slots[0] : null;
  const typeLabel = String(slot?.typeLabel || "").trim();
  const typeKey = String(slot?.type || "").trim();
  const candidates = [{
    index: 1,
    type: typeKey,
    typeLabel,
    content: title,
  }];
  return {
    titleText: formatTitleCandidatesAsText(candidates, null),
    candidates,
    originalType: null,
  };
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

// 通用的 Agent 错误重试判定，创作 Agent 和分类/三秒 Agent 共用。
// 凭证类错误和 4xx 不重试：重试也不会变好，只会白等一轮。
const isRetryableAgentError = (error) => {
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
      const retryable = isRetryableAgentError(error);
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

/**
 * 给某个 agent 拼「按大类配比二创」的输入。
 *
 * 没有任何配比（`slots.length === 0`）时返回空串 —— 调用方据此**退回原提示词**。
 * 这是刻意的降级：新功能依赖选题库，而库是项目经理人工建的，很多客户还没有。
 * 一条视频不该因为「这个客户没建库」就生成不出三秒和结尾钩子
 * （HANDOFF §5「真实库里 topic_libraries 可能是 0 条」就是常态）。
 */
const buildAdaptationInput = (creativeInput, adaptation) => {
  const plan = formatAdaptationForPrompt(adaptation);
  if (!plan) return "";
  return [creativeInput, "", "───────── 按选题库配比的二创要求 ─────────", plan].join("\n");
};

export const runCreativeAgents = async (videoMeta, transcript, config, options = {}) => {
  const creativeInput = buildCreativeInput(videoMeta, transcript.text);
  const logger = options.logger;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const transcriptText = transcript.text || "";
  // 选题库配比（可选）。取不到时三条 agent 各自走旧的自由二创提示词。
  const adaptation = options.adaptation || null;
  const goldAdaptation = adaptation?.goldThreeSeconds || null;
  const endingAdaptation = adaptation?.endingHooks || null;
  // 标题配比（2.3 标题）：来源是 2.2 黄金三秒报告的 categoryBreakdown，
  // 类型集合与三秒相同（见 titleLibrary.js 的两个设计决定）。
  const titleAdaptation = adaptation?.title || null;
  const goldInput = buildAdaptationInput(creativeInput, goldAdaptation);
  const endingInput = buildAdaptationInput(creativeInput, endingAdaptation);
  const titleInput = buildAdaptationInput(creativeInput, titleAdaptation);

  const runGoldOpeningHook = () => (goldInput
    ? runJsonAgent({
      system: CREATIVE_GOLD_THREE_SECONDS_PROMPT,
      user: goldInput,
      interfaceName: "deepseek:agent-opening-hook-adapt",
      normalizer: value => {
        const output = value?.output && typeof value.output === "object" ? value.output : value;
        return {
          extracted: "",
          created: [],
          candidates: normalizeCreativeCandidates(value, goldAdaptation, "opening-hook", logger),
          originalType: normalizeOriginalType(output, Object.keys(GOLD_THREE_SECOND_TYPE_LABELS)),
        };
      },
    }, config, { logger })
    : runJsonAgent({
      system: OPENING_HOOK_PROMPT,
      user: creativeInput,
      interfaceName: "deepseek:agent-opening-hook",
      normalizer: normalizeOpeningHook,
    }, config, { logger }));

  const runEndingHook = () => (endingInput
    ? runJsonAgent({
      system: CREATIVE_ENDING_HOOKS_PROMPT,
      user: endingInput,
      interfaceName: "deepseek:agent-ending-hook-adapt",
      normalizer: value => {
        const output = value?.output && typeof value.output === "object" ? value.output : value;
        return {
          extracted_result: "无",
          rcs: [],
          candidates: normalizeCreativeCandidates(value, endingAdaptation, "ending-hook", logger),
          originalType: normalizeOriginalType(output, Object.keys(ENDING_HOOK_TYPE_LABELS)),
        };
      },
    }, config, { logger })
    : runJsonAgent({
      system: ENDING_HOOK_PROMPT,
      user: creativeInput,
      interfaceName: "deepseek:agent-ending-hook",
      normalizer: normalizeEndingHook,
    }, config, { logger }));

  /**
   * 标题 agent（2.3 标题）。
   *
   * **有**标题配比：走「按槽位二创」（JSON 结构化输出）——模型判断原标题类型 +
   * 严格按槽位生成，归一化后由 `formatTitleCandidatesAsText` 渲染成前端能解析的
   * 文本块（类型标签随文本走，见 titleLibrary.js 的格式说明）。
   *
   * **没有**配比：原样保留旧的自由创作口径 —— 直接 `callDeepSeek` 拿纯文本，
   * 不经过 JSON 解析。⚠️ 这里**不能**顺手改成 `runJsonAgent`：旧口径的产物本来
   * 就是一段非 JSON 的标题列表文本，套上 JSON 解析必然失败，会白白多打一次
   * 「JSON 修复器」请求（实测确认过），既费 token 又让下游拿到 object 而不是文本。
   *
   * 两条路都归一成 `{ titleText, candidates, originalType }` 同一个形状，
   * 调用方不用分叉。
   */
  const runTitle = () => (titleInput
    ? runJsonAgent({
      system: CREATIVE_TITLE_PROMPT,
      user: titleInput,
      interfaceName: "deepseek:agent-title-adapt",
      normalizer: value => {
        const output = value?.output && typeof value.output === "object" ? value.output : value;
        const candidates = normalizeCreativeCandidates(value, titleAdaptation, "title", logger);
        const originalType = normalizeOriginalType(output, TITLE_TYPE_KEYS, TITLE_TYPE_LABELS);
        return {
          // 产物是**一个字符串**：工作流 payload 的 title 字段只接受字符串，
          // 前端再从字符串里解析候选列表（parseTitleBlocks）。
          titleText: formatTitleCandidatesAsText(candidates, originalType),
          candidates,
          originalType,
        };
      },
    }, config, { logger })
    : callDeepSeek({ system: TITLE_PROMPT, user: creativeInput, interfaceName: "deepseek:agent-title" }, config, { logger })
      .then(text => ({ titleText: cleanModelText(text), candidates: [], originalType: null })));

  const [openingHook, endingHook, titleText, scriptText] = await Promise.all([
    runCreativeStep({
      agent: "opening-hook",
      interfaceName: goldInput ? "deepseek:agent-opening-hook-adapt" : "deepseek:agent-opening-hook",
      run: runGoldOpeningHook,
      fallback: () => fallbackOpeningHook(videoMeta, transcriptText),
    }, config, { logger, onProgress }),
    runCreativeStep({
      agent: "ending-hook",
      interfaceName: endingInput ? "deepseek:agent-ending-hook-adapt" : "deepseek:agent-ending-hook",
      run: runEndingHook,
      fallback: fallbackEndingHook,
    }, config, { logger, onProgress }),
    // 标题：有标题配比时按大类配比逐槽位生成（2.3 标题），没有时保持原来的
    // 自由创作口径。降级不阻断内容生成。
    runCreativeStep({
      agent: "title",
      interfaceName: titleInput ? "deepseek:agent-title-adapt" : "deepseek:agent-title",
      run: runTitle,
      fallback: () => (titleAdaptation
        ? buildTitleAdaptationFallback(videoMeta, transcriptText, titleAdaptation)
        : { titleText: fallbackTitleText(videoMeta, transcriptText), candidates: [], originalType: null }),
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

  // 标题步骤现在统一产出 `{ titleText, candidates, originalType }`：
  // 有没有配比都是这个形状，调用方不用分叉。旧口径的裸字符串在 runTitle 里
  // 已经归一化过了（见上面的 runTitle）。
  const titleValue = titleText.value && typeof titleText.value === "object"
    ? titleText.value
    : { titleText: cleanModelText(titleText.value), candidates: [], originalType: null };

  return {
    openingHook: openingHook.value,
    endingHook: endingHook.value,
    titleText: cleanModelText(titleValue.titleText),
    titleCandidates: Array.isArray(titleValue.candidates) ? titleValue.candidates : [],
    titleOriginalType: titleValue.originalType || null,
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

/**
 * 通用 Agent 重试。
 *
 * 分类分析和黄金三秒这类「一次调用出一份报告」的 Agent 原先没有重试：一次瞬时故障
 * （网络抖动 / 429 / 5xx / 空响应 / JSON 解析失败）就直接掉进规则兜底，用户看到的是
 * 「分析 Agent 曾发生异常」。这里补上重试，避免一次性挂机。
 *
 * 两个刻意的约束：
 * 1. 凭证类错误和 4xx 不重试 —— 重试不会变好。
 * 2. 带总时间预算 —— 单次 HTTP 超时就有 120s，serverless 函数 maxDuration 也是 120s。
 *    没有预算守卫的话，重试会把函数拖到被平台强杀，那样连规则兜底的报告都拿不到，
 *    比直接降级更糟。所以预算用尽就立刻收手，把降级交回给上层。
 */
export const runAgentWithRetry = async ({ agent, interfaceName, run }, config, options = {}) => {
  const logger = options.logger;
  const maxAttempts = Math.max(1, Number(config.agentRetryAttempts ?? 0) + 1);
  const baseDelayMs = Math.max(0, Number(config.agentRetryBaseDelayMs ?? 0));
  const budgetMs = Math.max(0, Number(config.agentRetryBudgetMs ?? 0));
  const startedAt = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      const elapsedMs = Date.now() - startedAt;
      if (budgetMs > 0 && elapsedMs >= budgetMs) {
        logger?.warn("agent.retry.budget_exhausted", { agent, interfaceName, attempt, maxAttempts, elapsedMs, budgetMs });
        break;
      }
      // 线性退避：给上游一点恢复时间，同时避免所有请求同时重试。
      await sleep(baseDelayMs * (attempt - 1));
    }

    try {
      const value = await run();
      if (attempt > 1) {
        logger?.info("agent.retry.success", { agent, interfaceName, attempt, maxAttempts, elapsedMs: Date.now() - startedAt });
      }
      return value;
    } catch (error) {
      lastError = error;
      const retryable = isRetryableAgentError(error);
      logger?.warn("agent.attempt.failed", {
        agent,
        interfaceName,
        attempt,
        maxAttempts,
        retryable,
        code: error?.code,
        status: error?.status,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!retryable) break;
    }
  }

  throw lastError;
};

const runTypedBenchmarkAnalysisAgent = async ({ contentStyle, accountName, videos }, config, options = {}) => {
  const input = {
    contentStyle: String(contentStyle || "spoken"),
    accountName: String(accountName || "").trim(),
    videos: (Array.isArray(videos) ? videos : []).map(video => ({
      videoId: String(video?.id || video?.videoId || "").trim(),
      title: String(video?.title || "").trim(),
      sourceText: String(video?.sourceText || "").trim().slice(0, 900),
      authorName: String(video?.authorName || "").trim(),
      publishDate: String(video?.publishDate || "").trim(),
      stats: video?.stats || {},
    })),
  };

  const isDrama = contentStyle === "drama";
  const interfaceName = isDrama
    ? "deepseek:agent-benchmark-drama-classification"
    : "deepseek:agent-benchmark-spoken-classification";

  return runAgentWithRetry({
    agent: isDrama ? "benchmark-analysis-drama" : "benchmark-analysis-spoken",
    interfaceName,
    run: () => runJsonAgent({
      system: isDrama ? DRAMA_BENCHMARK_ANALYSIS_PROMPT : SPOKEN_BENCHMARK_ANALYSIS_PROMPT,
      user: JSON.stringify(input),
      interfaceName,
      normalizer: value => value && typeof value === "object" ? value : {},
    }, config, options),
  }, config, options);
};

export const runSpokenBenchmarkAnalysisAgent = async ({ accountName, videos }, config, options = {}) => (
  runTypedBenchmarkAnalysisAgent({ contentStyle: "spoken", accountName, videos }, config, options)
);

export const runDramaBenchmarkAnalysisAgent = async ({ accountName, videos }, config, options = {}) => (
  runTypedBenchmarkAnalysisAgent({ contentStyle: "drama", accountName, videos }, config, options)
);

// 兼容旧调用方；内部已按 contentStyle 选择独立的口播/演绎 Agent。
export const runBenchmarkAnalysisAgent = async ({ contentStyle, accountName, videos }, config, options = {}) => (
  String(contentStyle || "spoken").toLowerCase() === "drama"
    ? runDramaBenchmarkAnalysisAgent({ accountName, videos }, config, options)
    : runSpokenBenchmarkAnalysisAgent({ accountName, videos }, config, options)
);

export const runBenchmarkTopicRefreshAgent = async ({ videos, categories, transcripts, recentDays, minLikes }, config, options = {}) => {
  const input = {
    recentDays,
    minLikes,
    topicLibrary: Array.isArray(categories) ? categories : [],
    videos: (Array.isArray(videos) ? videos : []).map(video => ({
      videoId: String(video?.id || video?.videoId || "").trim(),
      title: String(video?.title || "").trim(),
      sourceText: String(video?.sourceText || "").trim().slice(0, 900),
      publishDate: String(video?.publishDate || "").trim(),
      stats: video?.stats || {},
      transcript: String(transcripts?.get?.(String(video?.id || video?.videoId || ""))?.text || "").trim().slice(0, 12_000),
    })),
  };
  const interfaceName = "deepseek:agent-benchmark-topic-refresh";
  return runAgentWithRetry({
    agent: "benchmark-topic-refresh",
    interfaceName,
    run: () => runJsonAgent({
      system: BENCHMARK_TOPIC_REFRESH_PROMPT,
      user: JSON.stringify(input),
      interfaceName,
      normalizer: value => value && typeof value === "object" ? value : {},
    }, config, options),
  }, config, options);
};

export const runGoldThreeSecondsAgent = async ({ classificationReport, transcripts }, config, options = {}) => {
  const input = buildGoldThreeSecondsInput(classificationReport, { transcripts });
  const interfaceName = "deepseek:agent-gold-three-seconds";
  return runAgentWithRetry({
    agent: "gold-three-seconds",
    interfaceName,
    run: () => runJsonAgent({
      system: GOLD_THREE_SECONDS_PROMPT,
      user: JSON.stringify(input),
      interfaceName,
      normalizer: value => value && typeof value === "object" ? value : {},
    }, config, options),
  }, config, options);
};

/**
 * 2.3 结尾钩子 Agent。与 runGoldThreeSecondsAgent 同构 —— 同样走 runAgentWithRetry
 * （带时间预算，见 §6.3⑯），归一化留给业务层的 normalizeEndingHooks。
 */
export const runEndingHooksAgent = async ({ classificationReport, transcripts }, config, options = {}) => {
  const input = buildEndingHooksInput(classificationReport, { transcripts });
  const interfaceName = "deepseek:agent-ending-hooks";
  return runAgentWithRetry({
    agent: "ending-hooks",
    interfaceName,
    run: () => runJsonAgent({
      system: ENDING_HOOKS_PROMPT,
      user: JSON.stringify(input),
      interfaceName,
      normalizer: value => value && typeof value === "object" ? value : {},
    }, config, options),
  }, config, options);
};

/**
 * 模块 1「对标账号分析」(1.2) 的 Agent。
 *
 * 与上面两个子步骤 Agent 同构（同样走 runAgentWithRetry 的时间预算守卫，见 §6.3⑯），
 * 但它吃的是**三份输入**：分类报告的产出、开头/结尾两份转写、以及真实抓取的评论。
 * 归一化与证据分级留给业务层的 normalizeBenchmarkProfile。
 *
 * ⚠️ 与 2.2/2.3 的关键差别：这里**必须**从账号定位 / 内容定位 / 人设定位 / 用户痛点
 * 4 个角度解释类型选择（那两步反而明令禁止这么做），提示词里已写明。
 */
export const runBenchmarkProfileAgent = async ({
  classificationReport,
  headTranscripts,
  tailTranscripts,
  commentsByVideo,
  fansPortrait,
}, config, options = {}) => {
  const input = buildBenchmarkProfileInput(classificationReport, { headTranscripts, tailTranscripts, commentsByVideo, fansPortrait });
  const interfaceName = "deepseek:agent-benchmark-profile";
  return runAgentWithRetry({
    agent: "benchmark-profile",
    interfaceName,
    run: () => runJsonAgent({
      system: BENCHMARK_PROFILE_PROMPT,
      user: JSON.stringify(input),
      interfaceName,
      normalizer: value => value && typeof value === "object" ? value : {},
    }, config, options),
  }, config, options);
};

/**
 * 模块 2「账号定位」(1.3) 第一批的 Agent。
 *
 * 与 runBenchmarkProfileAgent 同构（同样走 runAgentWithRetry 的时间预算守卫，见 §6.3⑯），
 * 但输入是**两份现成资料**：客户 IP 档案（`customers.ipProfile`）与 1.2 的报告 ——
 * 它不抓视频、不转写、不抓评论，所以端点那边也没有分批阶段。
 * 归一化、证据分级与后端重算留给业务层的 normalizeAccountPlan。
 */
export const runAccountPlanAgent = async ({ customer, benchmarkReport }, config, options = {}) => {
  const input = buildAccountPlanInput({ customer, benchmarkReport });
  const interfaceName = "deepseek:agent-account-plan";
  return runAgentWithRetry({
    agent: "account-plan",
    interfaceName,
    run: () => runJsonAgent({
      system: ACCOUNT_PLAN_PROMPT,
      user: JSON.stringify(input),
      interfaceName,
      normalizer: value => value && typeof value === "object" ? value : {},
    }, config, options),
  }, config, options);
};

export const clearTranscriptCacheForTests = () => {
  transcriptCache.clear();
};

export const parseJsonForTests = (raw) => {
  return safeJsonParse(extractFirstJsonObjectText(raw), null);
};
