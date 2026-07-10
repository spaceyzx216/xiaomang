import { AgentError, fetchJson } from "./contentAgent/http.js";
import {
  MAX_TOPIC_PAGES,
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

export const isWithinRecentDays = (value, days, nowMs = Date.now()) => {
  const timestamp = toTimestampMs(value);
  if (!timestamp) return false;
  return timestamp <= nowMs && nowMs - timestamp <= days * 24 * 60 * 60 * 1000;
};

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
  const { data } = await fetchJson(url, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(body || {}),
    timeoutMs: config.requestTimeoutMs,
    retries: config.apiRetryAttempts,
    retryBaseDelayMs: config.apiRetryBaseDelayMs,
    logger: options.logger,
    interfaceName: `tikhub:${path}`,
    logFields: options.logFields,
  });
  return data;
};

const findValueByKey = (value, matcher, depth = 0) => {
  if (!value || depth > 5) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findValueByKey(item, matcher, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  for (const [key, nested] of Object.entries(value)) {
    if (matcher(key) && typeof nested === "string" && nested.trim()) return nested.trim();
    const found = findValueByKey(nested, matcher, depth + 1);
    if (found) return found;
  }
  return "";
};

const findFinderUsername = (value) => {
  const direct = findValueByKey(value, key => /^(finder_)?username$|finderusername|userName$/i.test(key));
  if (/^v2_.+@finder$/i.test(direct)) return direct;
  const anyFinder = findValueByKey(value, key => /username|finder|user/i.test(key));
  return /^v2_.+@finder$/i.test(anyFinder) ? anyFinder : "";
};

const getSearchItems = (payload) => {
  const data = payload?.data || {};
  if (Array.isArray(data.items)) return data.items;
  const boxes = Array.isArray(data?.results?.data) ? data.results.data : [];
  return boxes.flatMap(box => [
    ...(Array.isArray(box?.items) ? box.items : []),
    ...(Array.isArray(box?.subBoxes) ? box.subBoxes.flatMap(sub => Array.isArray(sub?.items) ? sub.items : []) : []),
  ]);
};

const candidateFromSearchItem = (inputName, item) => {
  const jumpInfo = item?.jumpInfo || item?.jump_info || {};
  const finderUsername = findFinderUsername(item);
  if (!finderUsername) return null;
  return {
    platform: "wechat_channels",
    inputName,
    displayName: trimHtml(jumpInfo.nickName || item?.nickName || item?.nickname || item?.title || inputName),
    finderUsername,
    signature: trimHtml(jumpInfo.signature || item?.signature || item?.desc || ""),
    verifiedInfo: trimHtml(jumpInfo.verifyInfo || jumpInfo.authInfo || item?.verifyInfo || item?.authInfo || ""),
    sampleVideos: [],
    raw: item,
  };
};

const candidateFromVideoDetail = (inputName, detail, sampleTitle = "") => {
  const data = detail?.data || {};
  const finderUsername = data?.username || findFinderUsername(data);
  if (!finderUsername) return null;
  return {
    platform: "wechat_channels",
    inputName,
    displayName: trimHtml(data?.nickname || data?.nickName || inputName),
    finderUsername,
    signature: trimHtml(data?.signature || ""),
    verifiedInfo: trimHtml(data?.auth_info || data?.authInfo || ""),
    sampleVideos: [trimHtml(sampleTitle || data?.title || "")].filter(Boolean),
    raw: data,
  };
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
    { logger, logFields: { inputName } },
  );
  return getSearchItems(accountPayload).map(item => candidateFromSearchItem(inputName, item));
};

const searchWeChatVideoCandidates = async (inputName, config, logger) => {
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
    { logger, logFields: { inputName } },
  );
  const items = getSearchItems(videoPayload).slice(0, 3);
  const candidates = [];
  for (const item of items) {
    const exportId = item?.exportId || item?.export_id;
    if (!exportId) continue;
    const objectNonceId =
      item?.objectNonceId ||
      item?.object_nonce_id ||
      item?.feedNonceId ||
      item?.jumpInfo?.extInfo?.feedNonceId ||
      item?.jump_info?.ext_info?.feed_nonce_id ||
      "";
    try {
      const detail = await postTikHub(
        "/api/v1/wechat_channels/v2/fetch_video_detail",
        {
          export_id: exportId,
          object_nonce_id: objectNonceId,
          raw: false,
        },
        config,
        { logger, logFields: { inputName, exportId } },
      );
      candidates.push(candidateFromVideoDetail(inputName, detail, item?.title || item?.desc || ""));
    } catch (error) {
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
    try {
      let candidates = mergeCandidates(await searchWeChatAccountCandidates(inputName, config, options.logger));
      if (candidates.length === 0) {
        candidates = mergeCandidates(await searchWeChatVideoCandidates(inputName, config, options.logger));
      }
      results.push({ inputName, candidates, error: null });
    } catch (error) {
      results.push({
        inputName,
        candidates: [],
        error: error instanceof Error ? error.message : "Account search failed",
      });
    }
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
    }))
    .filter(item => item.finderUsername);
  if (selectedAccounts.length === 0) {
    throw new AgentError("accounts must include finderUsername", { code: "ACCOUNTS_EMPTY", status: 400 });
  }

  const limit = Math.max(1, Math.min(Number(count) || 200, MAX_TOPIC_VIDEOS));
  let recentDays;
  try {
    recentDays = parseRecentDays(days);
  } catch {
    throw new AgentError("days must be an integer between 1 and 90", { code: "TOPIC_DAYS_INVALID", status: 400 });
  }
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 10, MAX_TOPIC_PAGES));
  const nowMs = Date.now();
  const results = [];
  for (const account of selectedAccounts) {
    try {
      const pageResponses = [];
      const allVideos = [];
      const seenVideoKeys = new Set();
      const seenBuffers = new Set([""]);
      let lastBuffer = "";
      let hasMore = false;
      let stopReason = "page_limit";
      let partialError = null;
      let hitVideoLimit = false;

      for (let page = 1; page <= pageLimit && allVideos.length < limit; page += 1) {
        let videosResponse;
        try {
          videosResponse = await postTikHub(
            "/api/v1/wechat_channels/v2/fetch_user_videos",
            {
              username: account.finderUsername,
              last_buffer: lastBuffer,
              raw: false,
            },
            config,
            {
              logger: options.logger,
              logFields: {
                inputName: account.inputName,
                finderUsername: account.finderUsername,
                page,
              },
            },
          );
        } catch (error) {
          if (pageResponses.length === 0) throw error;
          partialError = error instanceof Error ? error.message : "Page fetch failed";
          hasMore = true;
          stopReason = "page_error";
          break;
        }
        pageResponses.push(videosResponse);
        const data = videosResponse?.data || {};
        const videos = Array.isArray(data?.videos) ? data.videos : [];
        let addedCount = 0;
        const newPageVideos = [];
        for (const video of videos) {
          if (allVideos.length >= limit) {
            hitVideoLimit = true;
            break;
          }
          const identity = videoIdentity(video) || stableVideoFingerprint(video);
          if (seenVideoKeys.has(identity)) continue;
          seenVideoKeys.add(identity);
          allVideos.push(video);
          newPageVideos.push(video);
          addedCount += 1;
        }

        if (page > 1 && reachedRecentTimeBoundary(newPageVideos, recentDays, nowMs)) {
          stopReason = "time_boundary";
          hasMore = false;
          break;
        }

        const nextBuffer = String(data?.last_buffer || data?.lastBuffer || "").trim();
        const apiHasNext = hasNextPage(data?.up_continue) || hasNextPage(data?.upContinueFlag);
        const canAdvance = Boolean(nextBuffer) && nextBuffer !== lastBuffer && !seenBuffers.has(nextBuffer);
        hasMore = Boolean(nextBuffer);
        if (!nextBuffer) {
          stopReason = "no_next_buffer";
          hasMore = false;
          break;
        }
        if (videos.length === 0 || addedCount === 0) {
          if (canAdvance) {
            stopReason = "duplicate_page_advanced";
            lastBuffer = nextBuffer;
            seenBuffers.add(lastBuffer);
            continue;
          }
          stopReason = "repeated_buffer";
          break;
        }
        if (!canAdvance) {
          stopReason = "repeated_buffer";
          break;
        }
        stopReason = apiHasNext ? "api_has_next" : "buffer_probe";
        lastBuffer = nextBuffer;
        seenBuffers.add(lastBuffer);
      }

      if (hitVideoLimit || (hasMore && (pageResponses.length >= pageLimit || allVideos.length >= limit))) {
        hasMore = true;
        stopReason = "safety_limit";
      }

      const topics = allVideos
        .filter(video => isWithinRecentDays(video?.create_time || video?.createTime, recentDays, nowMs))
        .map(video => normalizeWeChatChannelsTopic(video, account))
        .sort((a, b) => toTimestampMs(b.rawData?.create_time || b.publishDate) - toTimestampMs(a.rawData?.create_time || a.publishDate))
        .slice(0, limit);
      results.push({
        inputName: account.inputName || account.displayName,
        authorName: pageResponses?.[0]?.data?.nickname || account.displayName || account.inputName,
        finderUsername: account.finderUsername,
        videosCount: topics.length,
        topics,
        videosResponse: pageResponses?.[0],
        pageCount: pageResponses.length,
        rawVideosCount: allVideos.length,
        recentDays,
        hasMore,
        stopReason,
        isComplete: !["safety_limit", "page_error", "repeated_buffer"].includes(stopReason),
        incompleteReason: partialError || (stopReason === "safety_limit"
          ? "已达到安全翻页上限，结果可能不完整"
          : stopReason === "repeated_buffer" ? "上游翻页游标重复，结果可能不完整" : null),
        backgroundError: partialError,
        error: null,
      });
    } catch (error) {
      results.push({
        inputName: account.inputName || account.displayName,
        finderUsername: account.finderUsername,
        videosCount: 0,
        topics: [],
        recentDays,
        error: error instanceof Error ? error.message : "Failed to fetch videos",
      });
    }
  }
  return { platform: normalizedPlatform, results };
};
