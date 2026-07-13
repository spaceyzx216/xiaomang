const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RECENT_DAYS = 730;
export const MAX_TOPIC_PAGES = 100;
export const MAX_TOPIC_VIDEOS = 2000;
export const MAX_TOPIC_SLICE_PAGES = 3;

export const parseRecentDays = (value = 7) => {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new RangeError(`days must be an integer between 1 and ${MAX_RECENT_DAYS}`);
  }
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    throw new RangeError(`days must be an integer between 1 and ${MAX_RECENT_DAYS}`);
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_RECENT_DAYS) {
    throw new RangeError(`days must be an integer between 1 and ${MAX_RECENT_DAYS}`);
  }
  return days;
};

export const awemeTimestampMs = (video) => {
  const value = video?.create_time ?? video?.createTime ?? video?.publish_time ?? video?.publishTime;
  if (value === undefined || value === null || value === "") return 0;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const awemeIdentity = (video) => String(
  video?.aweme_id ??
  video?.awemeId ??
  video?.id ??
  video?.item_id ??
  video?.itemId ??
  "",
).trim();

export const stableVideoFingerprint = (video) => {
  const serialized = JSON.stringify(video || {});
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fallback:${(hash >>> 0).toString(16)}:${serialized.length}`;
};

export const extractAwemeList = (payload) => {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.aweme_list)) return data.aweme_list;
  if (Array.isArray(data?.item_list)) return data.item_list;
  if (Array.isArray(payload?.aweme_list)) return payload.aweme_list;
  return [];
};

const firstPresent = (...values) => values.find(value => value !== undefined && value !== null && value !== "");

const extractNextCursor = (payload) => {
  const data = payload?.data || {};
  // TikHub 的抖音和 TikTok APP V3 账号作品接口均以 max_cursor 续拉。
  // 保留 cursor 作为兼容旧响应的 fallback，不能反过来优先使用它。
  return firstPresent(data?.max_cursor, data?.cursor, payload?.max_cursor, payload?.cursor);
};

const extractHasMore = (payload) => {
  const data = payload?.data || {};
  const value = firstPresent(data?.has_more, data?.hasMore, payload?.has_more, payload?.hasMore);
  if (value === undefined) return undefined;
  return value === true || value === 1 || value === "1" || value === "true";
};

/**
 * 解析可选的 daysFrom 参数（时间区间下界，距今天数，含）。
 * 返回毫秒时间戳下界；若未指定则返回 -Infinity（无下界限制）。
 */
const parseOptionalDaysFrom = (daysFrom) => {
  if (daysFrom === undefined || daysFrom === null || daysFrom === "") return -Infinity;
  const text = String(daysFrom).trim();
  if (!/^\d+$/.test(text)) {
    throw new RangeError(`daysFrom must be a positive integer`);
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`daysFrom must be a positive integer`);
  }
  return value;
};

export const reachedRecentTimeBoundary = (videos, days, nowMs = Date.now()) => {
  const cutoffMs = nowMs - parseRecentDays(days) * DAY_MS;
  return (Array.isArray(videos) ? videos : []).some((video) => {
    const timestamp = awemeTimestampMs(video);
    if (timestamp <= 0) return false;
    return timestamp < cutoffMs;
  });
};

export const filterRecentAwemes = (videos, days, nowMs = Date.now(), daysFrom) => {
  const cutoffMs = nowMs - parseRecentDays(days) * DAY_MS;
  const fromMs = parseOptionalDaysFrom(daysFrom);
  // daysFrom 下界：排除比 daysFrom-1 天更新的视频（只保留 daysFrom 天及更早的）
  const upperExcludeMs = fromMs === -Infinity ? Infinity : nowMs - (fromMs - 1) * DAY_MS;
  return (Array.isArray(videos) ? videos : [])
    .filter((video) => {
      const timestamp = awemeTimestampMs(video);
      if (timestamp <= 0) return false;
      if (timestamp > nowMs) return false;       // 未来时间
      if (timestamp < cutoffMs) return false;     // 超出 days 上界（太旧）
      if (timestamp > upperExcludeMs) return false; // 在 daysFrom 下界之内（太新）
      return true;
    })
    .sort((left, right) => awemeTimestampMs(right) - awemeTimestampMs(left));
};

export const buildCombinedVideosResponse = (pages, videos, metadata = {}) => {
  const firstPayload = pages?.[0]?.data || {};
  const firstData = firstPayload?.data;
  const topicWindow = {
    pageCount: metadata.pageCount,
    rawVideosCount: metadata.rawVideosCount,
    recentDays: metadata.recentDays,
    hasMore: metadata.hasMore,
    stopReason: metadata.stopReason,
    isComplete: metadata.isComplete,
    incompleteReason: metadata.incompleteReason,
    totalPageCount: metadata.totalPageCount,
    resume: metadata.resume || null,
    ...(metadata.partialError ? { partialError: metadata.partialError } : {}),
  };
  if (Array.isArray(firstData)) {
    return {
      ...firstPayload,
      data: videos,
      topicWindow,
    };
  }
  return {
    ...firstPayload,
    data: {
      ...(firstData && typeof firstData === "object" ? firstData : {}),
      aweme_list: videos,
      ...(firstData && typeof firstData === "object" && Array.isArray(firstData.item_list)
        ? { item_list: videos }
        : {}),
    },
    topicWindow,
  };
};

export const collectRecentAwemePages = async ({
  platform,
  days,
  daysFrom,
  fetchPage,
  maxPages = 20,
  slicePages = MAX_TOPIC_SLICE_PAGES,
  maxVideos = 400,
  expectedPageSize = 20,
  nowMs = Date.now(),
  startCursor = 0,
  pageOffset = 0,
  logger = null,
  logFields = {},
}) => {
  const recentDays = parseRecentDays(days);
  const totalPageLimit = Math.max(1, Math.min(Number(maxPages) || 20, MAX_TOPIC_PAGES));
  const normalizedPageOffset = Math.max(0, Math.min(Number(pageOffset) || 0, totalPageLimit));
  const remainingPages = Math.max(0, totalPageLimit - normalizedPageOffset);
  const pageLimit = Math.min(
    remainingPages,
    Math.max(1, Math.min(Number(slicePages) || MAX_TOPIC_SLICE_PAGES, MAX_TOPIC_SLICE_PAGES)),
  );
  const videoLimit = Math.max(20, Math.min(Number(maxVideos) || 400, MAX_TOPIC_VIDEOS));
  const pages = [];
  const allVideos = [];
  const initialCursor = startCursor ?? 0;
  logger?.info?.("topic.pagination.start", {
    ...logFields,
    platform,
    days: recentDays,
    daysFrom: daysFrom ?? "",
    maxPages: totalPageLimit,
    slicePages: pageLimit,
    maxVideos: videoLimit,
    startCursor: String(initialCursor),
    pageOffset: normalizedPageOffset,
  });
  const seenVideos = new Set();
  const seenCursors = new Set([String(initialCursor)]);
  let cursor = initialCursor;
  let hasMore = false;
  let stopReason = remainingPages === 0 ? "safety_limit" : "slice_limit";
  let partialError = null;
  let partialErrorStatus = null;
  let hitVideoLimit = false;
  let consecutiveDuplicatePages = 0;
  const MAX_CONSECUTIVE_DUPLICATE_PAGES = 2;

  for (let page = 1; page <= pageLimit && allVideos.length < videoLimit; page += 1) {
    const logicalPage = normalizedPageOffset + page;
    let pageResult;
    try {
      pageResult = await fetchPage(cursor, logicalPage);
    } catch (error) {
      if (pages.length === 0) throw error;
      partialError = error instanceof Error ? error.message : "Page fetch failed";
      partialErrorStatus = Number(error?.status) || null;
      hasMore = true;
      stopReason = "page_error";
      break;
    }
    pages.push(pageResult);
    const pageVideos = extractAwemeList(pageResult?.data);
    let addedCount = 0;
    for (const video of pageVideos) {
      if (allVideos.length >= videoLimit) {
        hitVideoLimit = true;
        break;
      }
      const identity = awemeIdentity(video) || stableVideoFingerprint(video);
      if (seenVideos.has(identity)) continue;
      seenVideos.add(identity);
      allVideos.push(video);
      addedCount += 1;
    }

    const nextCursor = extractNextCursor(pageResult?.data);
    const upstreamHasMore = extractHasMore(pageResult?.data);
    hasMore = upstreamHasMore === undefined
      ? nextCursor !== undefined && String(nextCursor) !== String(cursor)
      : upstreamHasMore;
    const canAdvance = nextCursor !== undefined && !seenCursors.has(String(nextCursor));

    logger?.debug?.("topic.pagination.page", {
      ...logFields,
      page: logicalPage,
      cursor: String(cursor),
      nextCursor: nextCursor === undefined ? "" : String(nextCursor),
      hasMore,
      upstreamHasMore: upstreamHasMore === undefined ? "" : String(upstreamHasMore),
      pageVideosCount: pageVideos.length,
      addedCount,
      rawVideosCount: allVideos.length,
      canAdvance,
    });

    // 首页可能混入置顶旧作品，不能据此断言后续没有新作品；其余页面按
    // newest-first 的接口顺序，出现时间窗外作品即可安全停止。
    if (logicalPage > 1 && reachedRecentTimeBoundary(pageVideos, recentDays, nowMs, daysFrom)) {
      hasMore = false;
      stopReason = "time_boundary";
      logger?.info?.("topic.pagination.stop", {
        ...logFields,
        page: logicalPage,
        stopReason,
        cursor: String(cursor),
        nextCursor: nextCursor === undefined ? "" : String(nextCursor),
        pageVideosCount: pageVideos.length,
        addedCount,
      });
      break;
    }

    // 空页代表账号作品已取尽。即使上游仍给了游标，也不再为不存在的作品付费。
    if (pageVideos.length === 0) {
      stopReason = "upstream_exhausted";
      hasMore = false;
      logger?.info?.("topic.pagination.stop", {
        ...logFields,
        page: logicalPage,
        stopReason,
        cursor: String(cursor),
        nextCursor: nextCursor === undefined ? "" : String(nextCursor),
        pageVideosCount: pageVideos.length,
        addedCount,
      });
      break;
    }

    if (addedCount === 0) {
      consecutiveDuplicatePages += 1;
      // 允许穿过一次重复页，避免偶发的重叠页漏数据；连续两页都没有新作品
      // 则视为上游已到尾部，避免在无效游标上持续消耗额度。
      if (consecutiveDuplicatePages >= MAX_CONSECUTIVE_DUPLICATE_PAGES || !hasMore || !canAdvance) {
        stopReason = "upstream_exhausted";
        hasMore = false;
        logger?.info?.("topic.pagination.stop", {
          ...logFields,
          page: logicalPage,
          stopReason,
          cursor: String(cursor),
          nextCursor: nextCursor === undefined ? "" : String(nextCursor),
          pageVideosCount: pageVideos.length,
          addedCount,
        });
        break;
      }
      if (hasMore && canAdvance) {
        cursor = nextCursor;
        seenCursors.add(String(cursor));
        stopReason = "duplicate_page_advanced";
        logger?.info?.("topic.pagination.advance", {
          ...logFields,
          page: logicalPage,
          stopReason,
          cursor: String(cursor),
          nextCursor: nextCursor === undefined ? "" : String(nextCursor),
          pageVideosCount: pageVideos.length,
          addedCount,
        });
        continue;
      }
    }
    consecutiveDuplicatePages = 0;

    if (!hasMore) {
      stopReason = "upstream_exhausted";
      logger?.info?.("topic.pagination.stop", {
        ...logFields,
        page: logicalPage,
        stopReason,
        cursor: String(cursor),
        nextCursor: nextCursor === undefined ? "" : String(nextCursor),
        pageVideosCount: pageVideos.length,
        addedCount,
      });
      break;
    }
    if (!canAdvance) {
      stopReason = "upstream_exhausted";
      hasMore = false;
      logger?.info?.("topic.pagination.stop", {
        ...logFields,
        page: logicalPage,
        stopReason,
        cursor: String(cursor),
        nextCursor: nextCursor === undefined ? "" : String(nextCursor),
        pageVideosCount: pageVideos.length,
        addedCount,
      });
      break;
    }
    cursor = nextCursor;
    seenCursors.add(String(cursor));
  }

  const totalPageCount = normalizedPageOffset + pages.length;
  if (hitVideoLimit || (hasMore && allVideos.length >= videoLimit)) {
    hasMore = true;
    stopReason = "safety_limit";
  } else if (hasMore && totalPageCount >= totalPageLimit) {
    stopReason = "safety_limit";
  } else if (hasMore && pages.length >= pageLimit && stopReason !== "page_error") {
    stopReason = "slice_limit";
  }

  logger?.info?.("topic.pagination.done", {
    ...logFields,
    stopReason,
    hasMore,
    pageCount: pages.length,
    totalPageCount,
    rawVideosCount: allVideos.length,
    videoCount: filterRecentAwemes(allVideos, recentDays, nowMs, daysFrom).length,
    startCursor: String(initialCursor),
    endCursor: String(cursor),
  });

  const videos = filterRecentAwemes(allVideos, recentDays, nowMs, daysFrom);
  const isComplete = !["slice_limit", "safety_limit", "page_error"].includes(stopReason);
  const canResume = hasMore && ["slice_limit", "page_error"].includes(stopReason);
  return {
    videos,
    pages,
    pageCount: pages.length,
    rawVideosCount: allVideos.length,
    recentDays,
    totalPageCount,
    hasMore: !isComplete && hasMore,
    stopReason,
    isComplete,
    resume: canResume ? { cursor, pageOffset: totalPageCount } : null,
    incompleteReason: stopReason === "page_error"
      ? partialError
      : stopReason === "safety_limit" ? "已达到安全翻页上限，结果可能不完整" : null,
    partialError,
    partialErrorStatus,
  };
};
