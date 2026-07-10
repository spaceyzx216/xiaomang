const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RECENT_DAYS = 90;
export const MAX_TOPIC_PAGES = 60;
export const MAX_TOPIC_VIDEOS = 1200;

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

const extractNextCursor = (payload, platform) => {
  const data = payload?.data || {};
  return platform === "tiktok"
    ? firstPresent(data?.cursor, data?.max_cursor, payload?.cursor, payload?.max_cursor)
    : firstPresent(data?.max_cursor, data?.cursor, payload?.max_cursor, payload?.cursor);
};

const extractHasMore = (payload) => {
  const data = payload?.data || {};
  const value = firstPresent(data?.has_more, data?.hasMore, payload?.has_more, payload?.hasMore);
  if (value === undefined) return undefined;
  return value === true || value === 1 || value === "1" || value === "true";
};

export const reachedRecentTimeBoundary = (videos, days, nowMs = Date.now()) => {
  const cutoffMs = nowMs - parseRecentDays(days) * DAY_MS;
  return (Array.isArray(videos) ? videos : []).some((video) => {
    const timestamp = awemeTimestampMs(video);
    return timestamp > 0 && timestamp <= cutoffMs;
  });
};

export const filterRecentAwemes = (videos, days, nowMs = Date.now()) => {
  const cutoffMs = nowMs - parseRecentDays(days) * DAY_MS;
  return (Array.isArray(videos) ? videos : [])
    .filter((video) => {
      const timestamp = awemeTimestampMs(video);
      return timestamp > 0 && timestamp <= nowMs && timestamp >= cutoffMs;
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
  fetchPage,
  maxPages = 20,
  maxVideos = 400,
  nowMs = Date.now(),
}) => {
  const recentDays = parseRecentDays(days);
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 20, MAX_TOPIC_PAGES));
  const videoLimit = Math.max(20, Math.min(Number(maxVideos) || 400, MAX_TOPIC_VIDEOS));
  const pages = [];
  const allVideos = [];
  const seenVideos = new Set();
  const seenCursors = new Set(["0"]);
  let cursor = 0;
  let hasMore = false;
  let stopReason = "safety_limit";
  let partialError = null;
  let hitVideoLimit = false;

  for (let page = 1; page <= pageLimit && allVideos.length < videoLimit; page += 1) {
    let pageResult;
    try {
      pageResult = await fetchPage(cursor, page);
    } catch (error) {
      if (pages.length === 0) throw error;
      partialError = error instanceof Error ? error.message : "Page fetch failed";
      hasMore = true;
      stopReason = "page_error";
      break;
    }
    pages.push(pageResult);
    const pageVideos = extractAwemeList(pageResult?.data);
    let addedCount = 0;
    const newPageVideos = [];
    for (const video of pageVideos) {
      if (allVideos.length >= videoLimit) {
        hitVideoLimit = true;
        break;
      }
      const identity = awemeIdentity(video) || stableVideoFingerprint(video);
      if (seenVideos.has(identity)) continue;
      seenVideos.add(identity);
      allVideos.push(video);
      newPageVideos.push(video);
      addedCount += 1;
    }

    if (page > 1 && reachedRecentTimeBoundary(newPageVideos, recentDays, nowMs)) {
      hasMore = false;
      stopReason = "time_boundary";
      break;
    }

    const nextCursor = extractNextCursor(pageResult?.data, platform);
    const upstreamHasMore = extractHasMore(pageResult?.data);
    hasMore = upstreamHasMore === undefined
      ? nextCursor !== undefined && String(nextCursor) !== String(cursor)
      : upstreamHasMore;
    const canAdvance = nextCursor !== undefined && !seenCursors.has(String(nextCursor));
    if (pageVideos.length === 0 || addedCount === 0) {
      if (hasMore && canAdvance) {
        cursor = nextCursor;
        seenCursors.add(String(cursor));
        stopReason = "duplicate_page_advanced";
        continue;
      }
      if (hasMore) {
        stopReason = "repeated_cursor";
        break;
      }
      stopReason = "upstream_exhausted";
      break;
    }
    if (!hasMore) {
      stopReason = "upstream_exhausted";
      break;
    }
    if (!canAdvance) {
      stopReason = "repeated_cursor";
      break;
    }
    cursor = nextCursor;
    seenCursors.add(String(cursor));
  }

  if (hitVideoLimit || (hasMore && allVideos.length >= videoLimit)) {
    hasMore = true;
    stopReason = "safety_limit";
  } else if (hasMore && pages.length >= pageLimit) {
    stopReason = "safety_limit";
  }

  const videos = filterRecentAwemes(allVideos, recentDays, nowMs);
  const isComplete = !["safety_limit", "page_error", "repeated_cursor"].includes(stopReason);
  return {
    videos,
    pages,
    pageCount: pages.length,
    rawVideosCount: allVideos.length,
    recentDays,
    hasMore: !isComplete && hasMore,
    stopReason,
    isComplete,
    incompleteReason: isComplete
      ? null
      : partialError || (stopReason === "repeated_cursor" ? "上游游标重复，结果可能不完整" : "已达到安全翻页上限，结果可能不完整"),
    partialError,
  };
};
