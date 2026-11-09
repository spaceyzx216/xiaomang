import { AgentError, fetchJson } from "./contentAgent/http.js";
import {
  MAX_RECENT_DAYS,
  MAX_TOPIC_PAGES,
  MAX_TOPIC_SLICE_PAGES,
  MAX_TOPIC_VIDEOS,
  parseRecentDays,
  reachedRecentTimeBoundary,
  stableVideoFingerprint,
} from "./topicPagination.js";

export const normalizePlatform = (value) => {
  const text = String(value || "").trim().toLowerCase();
  if (text === "wechat" || text === "wechat_channels" || text === "channels" || text === "视频号") {
    return "wechat_channels";
  }
  if (text === "tiktok" || text === "抖音国际版" || text === "international") {
    return "tiktok";
  }
  return "douyin";
};

const trimHtml = (value) => String(value || "").replace(/<[^>]+>/g, "").trim();

const firstText = (...values) => {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstText(...value);
      if (nested) return nested;
      continue;
    }
    if (value && typeof value === "object") {
      const nested = firstText(
        value.shortTitle,
        value.short_title,
        value.title,
        value.desc,
        value.description,
        value.content,
      );
      if (nested) return nested;
      continue;
    }
    const text = trimHtml(value);
    if (text) return text;
  }
  return "";
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const normalizePublishDate = (value) => {
  if (!value) return "";
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric <= 0) return "";
    return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString().slice(0, 10);
  }
  return text.slice(0, 10);
};

const toTimestampMs = (value) => {
  if (!value) return 0;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const isWithinRecentDays = (value, days, nowMs = Date.now(), daysFrom) => {
  const timestamp = toTimestampMs(value);
  if (!timestamp) return false;
  if (timestamp > nowMs) return false;
  const elapsedDays = (nowMs - timestamp) / (24 * 60 * 60 * 1000);
  if (elapsedDays > days) return false;
  const fromValue = daysFrom !== undefined && daysFrom !== null && daysFrom !== ""
    ? Number(daysFrom) : 0;
  if (fromValue > 0 && elapsedDays < fromValue - 1) return false;
  return true;
};

// 注意：isWithinRecentDays 的 daysFrom 语义与 filterRecentAwemes 一致——
// elapsedDays >= daysFrom-1 表示视频年龄至少 daysFrom-1 天（即第 daysFrom 天或更早）。

const authHeaders = (config) => {
  if (!config?.tikhubApiToken) {
    throw new AgentError("Missing TIKHUB_API_TOKEN", { code: "TIKHUB_TOKEN_MISSING", status: 500 });
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.tikhubApiToken}`,
  };
};

export const postTikHub = async (path, body, config, options = {}) => {
  const url = `${config.tikhubBaseUrl.replace(/\/$/, "")}${path}`;
  const interfaceName = `tikhub:${path}`;
  const logDiagnostic = (level, status, payload) => {
    if (!config?.tikhubWechatResponseLogEnabled || !options.wechatResponseDiagnostic || !options.logger) return;
    const method = level === "error" ? options.logger.errorJson : options.logger.infoJson;
    if (typeof method !== "function") return;
    try {
      method.call(options.logger, "wechat_channels.account_response", {
        stage: options.wechatResponseDiagnostic.stage,
        interface: interfaceName,
        inputName: options.wechatResponseDiagnostic.inputName,
        status,
      }, payload);
    } catch {
      // 日志是排障辅助；终端 sink 异常绝不能影响上游响应的解析或重试。
    }
  };
  try {
    const { data, response } = await fetchJson(url, {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify(body || {}),
      timeoutMs: config.requestTimeoutMs,
      retries: config.apiRetryAttempts,
      retryBaseDelayMs: config.apiRetryBaseDelayMs,
      logger: options.logger,
      interfaceName,
      logFields: options.logFields,
    });
    logDiagnostic("info", response?.status, data);
    return data;
  } catch (error) {
    // fetchJson 会把可解析的 HTTP JSON 放到 AgentError.details；网络错误没有响应体，
    // 不制造空诊断日志，也不改变既有异常路径。
    const isRawTextFallback = error?.details
      && typeof error.details === "object"
      && !Array.isArray(error.details)
      && Object.keys(error.details).length === 1
      && Object.prototype.hasOwnProperty.call(error.details, "raw");
    if (error?.details !== undefined && !isRawTextFallback) {
      logDiagnostic("error", error.status, error.details);
    }
    throw error;
  }
};

const findValuesByKey = (value, matcher, depth = 0, values = []) => {
  if (!value || depth > 5) return values;
  if (Array.isArray(value)) {
    for (const item of value) {
      findValuesByKey(item, matcher, depth + 1, values);
    }
    return values;
  }
  if (typeof value !== "object") return values;
  for (const [key, nested] of Object.entries(value)) {
    if (matcher(key) && typeof nested === "string" && nested.trim()) values.push(nested.trim());
    findValuesByKey(nested, matcher, depth + 1, values);
  }
  return values;
};

const findFinderUsername = (value) => {
  const direct = findValuesByKey(value, key => /^(finder_)?username$|finderusername|userName$/i.test(key));
  const anyFinder = findValuesByKey(value, key => /username|finder|user/i.test(key));
  return [...direct, ...anyFinder].find(item => /^v2_.+@finder$/i.test(item)) || "";
};

const findChannelId = (value) => {
  const values = [];
  const visit = (nested, depth = 0) => {
    if (!nested || depth > 5) return;
    if (typeof nested === "string") {
      if (/^sph/i.test(nested.trim())) values.push(nested.trim());
      return;
    }
    if (Array.isArray(nested)) {
      nested.forEach(item => visit(item, depth + 1));
      return;
    }
    if (typeof nested === "object") Object.values(nested).forEach(item => visit(item, depth + 1));
  };
  visit(value);
  return values[0] || "";
};

const getSearchItems = (payload) => {
  const data = payload?.data || {};
  if (Array.isArray(data.items) && data.items.length > 0) return data.items;
  const boxes = Array.isArray(data?.results?.data) ? data.results.data : [];
  return boxes.flatMap(box => [
    ...(Array.isArray(box?.items) ? box.items : []),
    ...(Array.isArray(box?.subBoxes) ? box.subBoxes.flatMap(sub => Array.isArray(sub?.items) ? sub.items : []) : []),
  ]);
};

const candidateFromAccountData = (inputName, data, sampleTitle = "") => {
  const jumpInfo = data?.jumpInfo || data?.jump_info || {};
  const finderUsername = findFinderUsername(data);
  if (!finderUsername) return null;
  return {
    platform: "wechat_channels",
    inputName,
    displayName: trimHtml(jumpInfo.nickName || data?.nickName || data?.nickname || data?.title || inputName),
    finderUsername,
    signature: trimHtml(jumpInfo.signature || data?.signature || data?.desc || ""),
    verifiedInfo: trimHtml(jumpInfo.verifyInfo || jumpInfo.authInfo || data?.verifyInfo || data?.authInfo || ""),
    sampleVideos: [trimHtml(sampleTitle || data?.title || "")].filter(Boolean),
  };
};

const candidateFromSearchItem = (inputName, item) => candidateFromAccountData(inputName, item);

const candidateFromVideoDetail = (inputName, detail, sampleTitle = "") => {
  return candidateFromAccountData(inputName, detail?.data || {}, sampleTitle);
};

const candidateFromChannelIdLookup = (inputName, payload, sampleTitle = "") =>
  candidateFromAccountData(inputName, payload?.data || {}, sampleTitle);

const createSearchDiagnostics = () => ({
  accountSearch: { items: 0, candidates: 0, missingFinderUsername: 0 },
  videoSearch: { items: 0, usableItems: 0, missingExportId: 0 },
  videoDetail: { requested: 0, succeeded: 0, missingFinderUsername: 0, missingChannelId: 0 },
  channelIdLookup: { requested: 0, resolved: 0, missingFinderUsername: 0 },
  errors: [],
  outcome: "not_found",
});

const recordSearchError = (diagnostics, stage, error) => {
  diagnostics.errors.push({
    stage,
    message: error instanceof Error ? error.message : "TikHub 请求失败",
  });
};

const mergeCandidates = (items) => {
  const map = new Map();
  for (const item of items.filter(Boolean)) {
    const existing = map.get(item.finderUsername);
    if (!existing) {
      map.set(item.finderUsername, item);
      continue;
    }
    map.set(item.finderUsername, {
      ...existing,
      displayName: existing.displayName || item.displayName,
      signature: existing.signature || item.signature,
      verifiedInfo: existing.verifiedInfo || item.verifiedInfo,
      sampleVideos: Array.from(new Set([...(existing.sampleVideos || []), ...(item.sampleVideos || [])])).slice(0, 3),
    });
  }
  return Array.from(map.values());
};

const searchWeChatAccountCandidates = async (inputName, config, logger) => {
  const accountPayload = await postTikHub(
    "/api/v1/wechat_search/v2/fetch_search",
    {
      keyword: inputName,
      business_type: "account",
      raw: false,
    },
    config,
    {
      logger,
      logFields: { inputName },
      wechatResponseDiagnostic: { stage: "account_search", inputName },
    },
  );
  const items = getSearchItems(accountPayload);
  const candidates = items.map(item => candidateFromSearchItem(inputName, item));
  return {
    items,
    candidates,
    missingFinderUsername: candidates.filter(candidate => !candidate).length,
  };
};

const searchWeChatVideoCandidates = async (inputName, config, logger, diagnostics) => {
  const videoPayload = await postTikHub(
    "/api/v1/wechat_search/v2/fetch_search_videos",
    {
      keyword: inputName,
      sort: "hot",
      publish_time: "half_year",
      duration: "all",
      raw: false,
    },
    config,
    {
      logger,
      logFields: { inputName },
      wechatResponseDiagnostic: { stage: "video_search", inputName },
    },
  );
  const items = getSearchItems(videoPayload).slice(0, 3);
  diagnostics.videoSearch.items = items.length;
  const candidates = [];
  const seenExportIds = new Set();
  for (const item of items) {
    const exportId = item?.exportId || item?.export_id;
    if (!exportId) {
      diagnostics.videoSearch.missingExportId += 1;
      continue;
    }
    if (seenExportIds.has(exportId)) continue;
    seenExportIds.add(exportId);
    diagnostics.videoSearch.usableItems += 1;
    const objectNonceId =
      item?.objectNonceId ||
      item?.object_nonce_id ||
      item?.feedNonceId ||
      item?.jumpInfo?.extInfo?.feedNonceId ||
      item?.jump_info?.ext_info?.feed_nonce_id ||
      "";
    try {
      diagnostics.videoDetail.requested += 1;
      const detail = await postTikHub(
        "/api/v1/wechat_channels/v2/fetch_video_detail",
        {
          export_id: exportId,
          object_nonce_id: objectNonceId,
          raw: false,
        },
        config,
        {
          logger,
          logFields: { inputName, exportId },
          wechatResponseDiagnostic: { stage: "video_detail", inputName },
        },
      );
      diagnostics.videoDetail.succeeded += 1;
      const sampleTitle = item?.title || item?.desc || "";
      const detailCandidate = candidateFromVideoDetail(inputName, detail, sampleTitle);
      if (detailCandidate) {
        return [detailCandidate];
      }
      diagnostics.videoDetail.missingFinderUsername += 1;
      const channelId = findChannelId(detail?.data || {});
      if (!channelId) {
        diagnostics.videoDetail.missingChannelId += 1;
        continue;
      }
      try {
        diagnostics.channelIdLookup.requested += 1;
        const lookup = await postTikHub(
          "/api/v1/wechat_channels/v2/fetch_channel_id_to_username",
          { channel_id: channelId, raw: false },
          { ...config, requestTimeoutMs: Math.max(Number(config?.requestTimeoutMs) || 0, 30_000) },
          {
            logger,
            logFields: { inputName, channelId },
            wechatResponseDiagnostic: { stage: "channel_id_lookup", inputName },
          },
        );
        const lookupCandidate = candidateFromChannelIdLookup(inputName, lookup, sampleTitle);
        if (lookupCandidate) {
          diagnostics.channelIdLookup.resolved += 1;
          return [lookupCandidate];
        } else {
          diagnostics.channelIdLookup.missingFinderUsername += 1;
        }
      } catch (error) {
        recordSearchError(diagnostics, "视频号 ID 转账号标识", error);
        logger?.warn("wechat_channels.candidate.channel_id_lookup_failed", {
          inputName,
          channelId,
          error: error instanceof Error ? error.message : "channel ID lookup failed",
        });
      }
    } catch (error) {
      recordSearchError(diagnostics, "视频详情", error);
      logger?.warn("wechat_channels.candidate.detail_failed", {
        inputName,
        exportId,
        error: error instanceof Error ? error.message : "detail failed",
      });
    }
  }
  return candidates;
};

export const searchPlatformAccounts = async ({ platform, keywords }, config, options = {}) => {
  const normalizedPlatform = normalizePlatform(platform);
  if (normalizedPlatform !== "wechat_channels") {
    throw new AgentError("Only wechat_channels account search is supported", { code: "PLATFORM_UNSUPPORTED", status: 400 });
  }

  const names = Array.from(new Set((Array.isArray(keywords) ? keywords : [])
    .map(item => String(item || "").trim())
    .filter(Boolean)));
  if (names.length === 0) {
    throw new AgentError("keywords must be a non-empty array", { code: "KEYWORDS_EMPTY", status: 400 });
  }

  const results = [];
  for (const inputName of names) {
    const diagnostics = createSearchDiagnostics();
    let candidates = [];
    try {
      const accountSearch = await searchWeChatAccountCandidates(inputName, config, options.logger);
      diagnostics.accountSearch.items = accountSearch.items.length;
      diagnostics.accountSearch.candidates = accountSearch.candidates.filter(Boolean).length;
      diagnostics.accountSearch.missingFinderUsername = accountSearch.missingFinderUsername;
      candidates = mergeCandidates(accountSearch.candidates);
    } catch (error) {
      recordSearchError(diagnostics, "账号搜索", error);
    }
    if (candidates.length === 0) {
      try {
        candidates = mergeCandidates(await searchWeChatVideoCandidates(inputName, config, options.logger, diagnostics));
      } catch (error) {
        recordSearchError(diagnostics, "作品搜索", error);
      }
    }
    diagnostics.outcome = candidates.length > 0
      ? "resolved"
      : diagnostics.errors.length > 0 ? "upstream_error" : "missing_finder_username";
    results.push({
      inputName,
      candidates,
      diagnostics,
      error: candidates.length === 0 && diagnostics.errors.length > 0
        ? `${diagnostics.errors[0].stage}请求失败：${diagnostics.errors[0].message}`
        : null,
    });
  }
  return { platform: normalizedPlatform, results };
};

export const normalizeWeChatChannelsTopic = (video, account = {}) => {
  const objectId = String(video?.id || video?.object_id || video?.objectId || "");
  const objectNonceId = String(video?.object_nonce_id || video?.objectNonceId || "");
  const finderUsername = String(video?.username || account.finderUsername || "");
  const media = video?.media || {};
  const title = firstText(video?.title, video?.desc, video?.description) || "未命名视频";
  const rawLink = video?.share_url || video?.shareUrl || media?.share_url || "";
  const coverUrl = [media?.cover_url, media?.cover_url_token].filter(Boolean).join("") || video?.cover_img_url || "";
  return {
    id: `wechat_channels:${objectId || objectNonceId || title}`,
    platform: "wechat_channels",
    title,
    tags: [],
    stats: {
      comments: toNumber(video?.comment_count || video?.comments),
      likes: toNumber(video?.like_count || video?.likes),
      shares: toNumber(video?.forward_count || video?.share_count || video?.shares),
      bookmarks: toNumber(video?.fav_count || video?.favorite_count || video?.bookmarks),
    },
    link: String(rawLink || ""),
    coverUrl,
    durationSeconds: toNumber(media?.duration || video?.duration),
    authorName: trimHtml(video?.nickname || account.displayName || account.inputName || "未知"),
    publishDate: normalizePublishDate(video?.create_time || video?.createTime),
    hotTopics: [],
    source: {
      platform: "wechat_channels",
      objectId,
      objectNonceId,
      finderUsername,
      mediaUrl: String(media?.full_url || ""),
      decodeKey: String(media?.decode_key || ""),
      coverUrl,
    },
    rawData: video,
  };
};

export const fetchWeChatChannelsShareLink = async ({ objectId, object_id }, config, options = {}) => {
  const id = String(objectId || object_id || "").trim();
  if (!id) {
    throw new AgentError("objectId is required", { code: "OBJECT_ID_EMPTY", status: 400 });
  }
  const payload = await postTikHub(
    "/api/v1/wechat_channels/v2/fetch_video_share_url",
    {
      object_id: id,
      raw: false,
    },
    config,
    { logger: options.logger, logFields: { objectId: id } },
  );
  const shareUrl = String(payload?.data?.share_url || payload?.data?.feedH5Url || "").trim();
  if (!shareUrl) {
    throw new AgentError("TikHub did not return a share URL", {
      code: "SHARE_URL_MISSING",
      status: 502,
      details: payload,
    });
  }
  return {
    platform: "wechat_channels",
    objectId: id,
    shareUrl,
    raw: payload,
  };
};

const hasNextPage = (value) => value === true || value === 1 || value === "1";

const videoIdentity = (video) => String(
  video?.id ||
  video?.object_id ||
  video?.objectId ||
  video?.object_nonce_id ||
  video?.objectNonceId ||
  "",
).trim();

export const fetchPlatformTopics = async ({ platform, accounts, count = 200, days = 7, maxPages = 10 }, config, options = {}) => {
  const normalizedPlatform = normalizePlatform(platform);
  if (normalizedPlatform !== "wechat_channels") {
    throw new AgentError("Only wechat_channels topics are supported here", { code: "PLATFORM_UNSUPPORTED", status: 400 });
  }
  const selectedAccounts = (Array.isArray(accounts) ? accounts : [])
    .map(item => ({
      inputName: String(item?.inputName || item?.displayName || "").trim(),
      displayName: String(item?.displayName || item?.inputName || "").trim(),
      finderUsername: String(item?.finderUsername || item?.finder_username || "").trim(),
      resume: item?.resume && typeof item.resume === "object" ? item.resume : null,
    }))
    .filter(item => item.finderUsername);
  if (selectedAccounts.length === 0) {
    throw new AgentError("accounts must include finderUsername", { code: "ACCOUNTS_EMPTY", status: 400 });
  }
  if (selectedAccounts.length !== 1) {
    throw new AgentError("Each topic slice must include exactly one account", { code: "TOPIC_SINGLE_ACCOUNT_REQUIRED", status: 400 });
  }

  const limit = Math.max(1, Math.min(Number(count) || 200, MAX_TOPIC_VIDEOS));
  let recentDays;
  try {
    recentDays = parseRecentDays(days);
  } catch {
    throw new AgentError(`days must be an integer between 1 and ${MAX_RECENT_DAYS}`, { code: "TOPIC_DAYS_INVALID", status: 400 });
  }
  const totalPageLimit = Math.max(1, Math.min(Number(maxPages) || 10, MAX_TOPIC_PAGES));
  const topicConfig = {
    ...config,
    requestTimeoutMs: Math.min(Number(config?.requestTimeoutMs) || 120_000, 25_000),
  };
  // 允许测试/调用方注入统一的时间基准；生产环境仍使用当前时间。
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const results = [];
  for (const account of selectedAccounts) {
    try {
      const pageOffset = Math.max(0, Math.min(Number(account.resume?.pageOffset) || 0, totalPageLimit));
      const pageLimit = Math.min(MAX_TOPIC_SLICE_PAGES, Math.max(0, totalPageLimit - pageOffset));
      const pageResponses = [];
      const allVideos = [];
      const seenVideoKeys = new Set();
      let lastBuffer = String(account.resume?.cursor || "").trim();
      const seenBuffers = new Set([lastBuffer]);
      let hasMore = false;
      let stopReason = pageLimit === 0 ? "safety_limit" : "slice_limit";
      let partialError = null;
      let partialErrorStatus = null;
      let hitVideoLimit = false;
      let consecutiveEmptyPages = 0;
      const MAX_CONSECUTIVE_EMPTY_PAGES = 2;

      for (let page = 1; page <= pageLimit && allVideos.length < limit; page += 1) {
        const logicalPage = pageOffset + page;
        let videosResponse;
        try {
          videosResponse = await postTikHub(
            "/api/v1/wechat_channels/v2/fetch_user_videos",
            {
              username: account.finderUsername,
              last_buffer: lastBuffer,
              raw: false,
            },
            topicConfig,
            {
              logger: options.logger,
              logFields: {
                inputName: account.inputName,
                finderUsername: account.finderUsername,
                page: logicalPage,
              },
            },
          );
        } catch (error) {
          if (pageResponses.length === 0) throw error;
          partialError = error instanceof Error ? error.message : "Page fetch failed";
          partialErrorStatus = Number(error?.status) || null;
          hasMore = true;
          stopReason = "page_error";
          break;
        }
        pageResponses.push(videosResponse);
        const data = videosResponse?.data || {};
        const videos = Array.isArray(data?.videos) ? data.videos : [];
        let addedCount = 0;
        for (const video of videos) {
          if (allVideos.length >= limit) {
            hitVideoLimit = true;
            break;
          }
          const identity = videoIdentity(video) || stableVideoFingerprint(video);
          if (seenVideoKeys.has(identity)) continue;
          seenVideoKeys.add(identity);
          allVideos.push(video);
          addedCount += 1;
        }

        const nextBuffer = String(data?.last_buffer || data?.lastBuffer || "").trim();
        const upContinue = data?.up_continue ?? data?.upContinueFlag;
        const apiHasNext = hasNextPage(upContinue);
        const canAdvance = Boolean(nextBuffer) && nextBuffer !== lastBuffer && !seenBuffers.has(nextBuffer);
        // 视频号的 up_continue 不是可靠的账号作品结束标记：它可能为 0，
        // 但同一 last_buffer 链后仍有更早的作品。只要 last_buffer 有变化，
        // 就必须继续续拉；真正的结束由空 buffer、重复 buffer、空页或时间边界判定。
        hasMore = Boolean(nextBuffer);
        // 首页可能包含置顶旧作品；后续页面按时间倒序，遇到时间窗外作品即可停止。
        if (logicalPage > 1 && reachedRecentTimeBoundary(videos, recentDays, nowMs)) {
          stopReason = "time_boundary";
          hasMore = false;
          break;
        }
        if (!nextBuffer) {
          stopReason = "no_next_buffer";
          hasMore = false;
          break;
        }
        if (videos.length === 0) {
          stopReason = "upstream_exhausted";
          hasMore = false;
          break;
        }
        if (addedCount === 0) {
          consecutiveEmptyPages += 1;
          // 连续多页无新增：上游 buffer 虽在前进但实际已无新内容（账号作品已取尽），
          // 继续翻只会浪费 API 余额。
          if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY_PAGES) {
            stopReason = "upstream_exhausted";
            hasMore = false;
            break;
          }
          if (canAdvance) {
            stopReason = "duplicate_page_advanced";
            lastBuffer = nextBuffer;
            seenBuffers.add(lastBuffer);
            continue;
          }
          stopReason = "upstream_exhausted";
          hasMore = false;
          break;
        }
        consecutiveEmptyPages = 0;
        if (!hasMore) {
          stopReason = "upstream_exhausted";
          break;
        }
        if (!canAdvance) {
          stopReason = "upstream_exhausted";
          hasMore = false;
          break;
        }
        stopReason = apiHasNext ? "api_has_next" : "buffer_probe";
        lastBuffer = nextBuffer;
        seenBuffers.add(lastBuffer);
      }

      const totalPageCount = pageOffset + pageResponses.length;
      if (hitVideoLimit || (hasMore && allVideos.length >= limit) || (hasMore && totalPageCount >= totalPageLimit)) {
        hasMore = true;
        stopReason = "safety_limit";
      } else if (hasMore && pageResponses.length >= pageLimit && stopReason !== "page_error") {
        stopReason = "slice_limit";
      }

      const topics = allVideos
        .filter(video => isWithinRecentDays(video?.create_time || video?.createTime, recentDays, nowMs))
        .map(video => normalizeWeChatChannelsTopic(video, account))
        .sort((a, b) => toTimestampMs(b.rawData?.create_time || b.publishDate) - toTimestampMs(a.rawData?.create_time || a.publishDate))
        .slice(0, limit);
      // 🔴 诊断：视频号选题**必须**带 `source.mediaUrl` + `source.decodeKey` 才能提取脚本
      //    （媒体在 CDN 上且被 Isaac64 加密，缺这两个字段就解不开、也就转写不了）。
      //    它们来自 TikHub 列表响应的 `media.full_url` / `media.decode_key` —— 文档**没有**
      //    承诺这两个字段一定存在，实测口径一变就可能整批缺字段。
      //    缺字段时若静默返回，下游 `transcribableVideos` 会把整批过滤掉，
      //    表现是「选题列表有内容，但脚本/标签一直不动」——极难定位。
      const missingMedia = topics.filter(topic => !topic?.source?.mediaUrl || !topic?.source?.decodeKey).length;
      if (missingMedia > 0) {
        options.logger?.warn("wechat.topics.missing_media", {
          interface: "wechat_channels:topics",
          finderUsername: account.finderUsername,
          topicCount: topics.length,
          missingMedia,
          // 把响应里 media 的实际字段名记下来：下一轮就能照着改字段映射
          mediaKeys: Object.keys(allVideos?.[0]?.media || {}),
        });
      }
      results.push({
        inputName: account.inputName || account.displayName,
        authorName: pageResponses?.[0]?.data?.nickname || account.displayName || account.inputName,
        finderUsername: account.finderUsername,
        videosCount: topics.length,
        // 如实告诉前端"这批里有多少条拿不到媒体直链"，界面据此提示用户，而不是装作正常。
        missingMediaCount: missingMedia,
        topics,
        videosResponse: pageResponses?.[0],
        pageCount: pageResponses.length,
        totalPageCount,
        rawVideosCount: allVideos.length,
        recentDays,
        hasMore,
        stopReason,
        isComplete: !["slice_limit", "safety_limit", "page_error"].includes(stopReason),
        incompleteReason: partialError || (stopReason === "safety_limit" ? "已达到安全翻页上限，结果可能不完整" : null),
        backgroundError: partialError,
        errorStatus: partialErrorStatus,
        resume: hasMore && ["slice_limit", "page_error"].includes(stopReason)
          ? { cursor: lastBuffer, pageOffset: totalPageCount }
          : null,
        error: null,
      });
    } catch (error) {
      results.push({
        inputName: account.inputName || account.displayName,
        finderUsername: account.finderUsername,
        videosCount: 0,
        topics: [],
        recentDays,
        errorStatus: Number(error?.status) || null,
        resume: account.resume || { cursor: "", pageOffset: 0 },
        error: error instanceof Error ? error.message : "Failed to fetch videos",
      });
    }
  }
  return { platform: normalizedPlatform, results };
};
