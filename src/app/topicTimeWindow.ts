export const DEFAULT_TOPIC_DAYS = 7;
export const MAX_TOPIC_DAYS = 730;
export const TOPIC_GROUP_DAYS = 7;
export const MAX_TOPIC_PAGES = 100;
export const MAX_TOPIC_VIDEOS = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TopicTimeItem = {
  id: string;
  publishDate?: string;
  rawData?: unknown;
};

export type TopicWeekGroup<T> = {
  index: number;
  startDay: number;
  endDay: number;
  label: string;
  topics: T[];
};

type TopicBatchResult<T extends TopicTimeItem = TopicTimeItem> = {
  url?: string;
  inputName?: string;
  finderUsername?: string;
  secUserId?: string;
  topics?: T[];
  videosCount?: number;
  videosResponse?: unknown;
  pageCount?: number;
  totalPageCount?: number;
  rawVideosCount?: number;
  resume?: {
    cursor?: unknown;
    pageOffset?: number;
    secUserId?: string;
    username?: string;
    accountResolved?: boolean;
    sourceUrl?: string;
  } | null;
  stopReason?: string;
  isComplete?: boolean;
  errorStatus?: number | null;
  error?: string | null;
  backgroundError?: string | null;
};

export const parseTopicDays = (value: unknown): number => {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new RangeError(`时间范围必须是 1–${MAX_TOPIC_DAYS} 的整数`);
  }
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    throw new RangeError(`时间范围必须是 1–${MAX_TOPIC_DAYS} 的整数`);
  }
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_TOPIC_DAYS) {
    throw new RangeError(`时间范围必须是 1–${MAX_TOPIC_DAYS} 的整数`);
  }
  return days;
};

export const topicRequestLimits = (value: unknown) => {
  const days = parseTopicDays(value);
  return {
    maxPages: Math.min(MAX_TOPIC_PAGES, Math.max(20, Math.ceil(days / TOPIC_GROUP_DAYS) * 5)),
    count: Math.min(MAX_TOPIC_VIDEOS, Math.max(400, days * 15)),
  };
};

const timestampFromValue = (value: unknown): number => {
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

export const topicTimestampMs = (topic: TopicTimeItem): number => {
  const raw = topic?.rawData as Record<string, unknown> | undefined;
  const values = [raw?.create_time, raw?.createTime, raw?.publish_time, raw?.publishTime, topic?.publishDate];
  for (const value of values) {
    const timestamp = timestampFromValue(value);
    if (timestamp > 0) return timestamp;
  }
  return 0;
};

export const isTopicWithinDays = (topic: TopicTimeItem, days: number, nowMs = Date.now()): boolean => {
  const timestamp = topicTimestampMs(topic);
  const windowDays = parseTopicDays(days);
  return timestamp > 0 && timestamp <= nowMs && timestamp >= nowMs - windowDays * DAY_MS;
};

const topicAgeDay = (topic: TopicTimeItem, nowMs: number): number => {
  const timestamp = topicTimestampMs(topic);
  if (!timestamp || timestamp > nowMs) return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.ceil((nowMs - timestamp) / DAY_MS));
};

export const groupTopicsByWeek = <T extends TopicTimeItem>(
  topics: T[],
  days: number,
  nowMs = Date.now(),
): TopicWeekGroup<T>[] => {
  const windowDays = parseTopicDays(days);
  const groupCount = Math.ceil(windowDays / TOPIC_GROUP_DAYS);
  const groups = Array.from({ length: groupCount }, (_, index) => {
    const startDay = index * TOPIC_GROUP_DAYS + 1;
    const endDay = Math.min((index + 1) * TOPIC_GROUP_DAYS, windowDays);
    return {
      index,
      startDay,
      endDay,
      label: startDay === 1 ? `近 ${endDay} 天` : `第 ${startDay}–${endDay} 天`,
      topics: [] as T[],
    };
  });

  const seen = new Set<string>();
  for (const topic of Array.isArray(topics) ? topics : []) {
    if (!topic?.id || seen.has(topic.id) || !isTopicWithinDays(topic, windowDays, nowMs)) continue;
    seen.add(topic.id);
    const ageDay = topicAgeDay(topic, nowMs);
    const groupIndex = Math.min(groupCount - 1, Math.floor((ageDay - 1) / TOPIC_GROUP_DAYS));
    groups[groupIndex].topics.push(topic);
  }
  for (const group of groups) {
    group.topics.sort((left, right) => topicTimestampMs(right) - topicTimestampMs(left));
  }
  return groups;
};

const resultIdentity = (result: TopicBatchResult, index: number): string => {
  const url = String(result?.url || "").trim();
  if (url) return `url:${url}`;
  const finderUsername = String(result?.finderUsername || "").trim();
  if (finderUsername) return `finder:${finderUsername}`;
  const inputName = String(result?.inputName || "").trim();
  if (inputName) return `input:${inputName}`;
  const secUserId = String(result?.secUserId || "").trim();
  return secUserId ? `sec:${secUserId}` : `missing-result-identity:${index}`;
};

const uniqueTopics = <T extends TopicTimeItem>(...collections: Array<T[] | undefined>): T[] => {
  const byId = new Map<string, T>();
  for (const topics of collections) {
    for (const topic of Array.isArray(topics) ? topics : []) {
      if (!topic?.id) continue;
      byId.set(topic.id, { ...byId.get(topic.id), ...topic });
    }
  }
  return Array.from(byId.values()).sort((left, right) => topicTimestampMs(right) - topicTimestampMs(left));
};

const rawVideos = (response: unknown): Array<Record<string, unknown>> => {
  const payload = response as { data?: unknown } | undefined;
  const data = payload?.data;
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  if (data && typeof data === "object" && Array.isArray((data as { aweme_list?: unknown[] }).aweme_list)) {
    return (data as { aweme_list: Array<Record<string, unknown>> }).aweme_list;
  }
  return [];
};

const stableRecordFingerprint = (value: Record<string, unknown>) => {
  const serialized = JSON.stringify(value || {});
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fallback:${(hash >>> 0).toString(16)}:${serialized.length}`;
};

const mergeVideosResponse = (previous: unknown, incoming: unknown): unknown => {
  if (!incoming) return previous;
  const nextPayload = incoming as { data?: unknown };
  const nextData = nextPayload.data;
  const videos = [...rawVideos(previous), ...rawVideos(incoming)];
  const byId = new Map<string, Record<string, unknown>>();
  videos.forEach((video) => {
    const id = String(video?.aweme_id || video?.awemeId || video?.id || stableRecordFingerprint(video));
    byId.set(id, { ...byId.get(id), ...video });
  });
  const merged = Array.from(byId.values());
  if (Array.isArray(nextData)) return { ...nextPayload, data: merged };
  return {
    ...nextPayload,
    data: {
      ...(nextData && typeof nextData === "object" ? nextData : {}),
      aweme_list: merged,
    },
  };
};

export const mergeTopicBatchResults = <T extends TopicTimeItem>(
  previous: TopicBatchResult<T>[],
  incoming: TopicBatchResult<T>[],
): TopicBatchResult<T>[] => {
  const incomingItems = Array.isArray(incoming) ? incoming : [];
  const previousItems = Array.isArray(previous) ? previous : [];
  const incomingKeys = new Set(incomingItems.map((item, index) => resultIdentity(item, index)));
  const previousByKey = new Map(previousItems.map((item, index) => [resultIdentity(item, index), item]));
  const merged = incomingItems.map((next, index) => {
    const old = previousByKey.get(resultIdentity(next, index));
    if (!old) return next;
    // 仅当任一方已通过 topics 字段传递作品时才合并 topics；否则保留
    // undefined，让下游（App.tsx 的 tikhubTopics memo）继续走 videosResponse
    // 解析路径（抖音/TikTok）。若无条件合并，uniqueTopics(undefined, undefined)
    // 会得到 []，而 Array.isArray([]) 为真，反而短路掉 videosResponse 的解析，
    // 导致渐进分页第二次请求合并后内容被清空。
    const hadTopics = Array.isArray(old.topics) || Array.isArray(next.topics);
    const mergedTopicList = hadTopics ? uniqueTopics(old.topics, next.topics) : undefined;
    const mergedTopics = mergedTopicList ? { topics: mergedTopicList } : {};
    const mergedVideosResponse = mergeVideosResponse(old.videosResponse, next.videosResponse);
    const accumulated = {
      pageCount: (Number(old.pageCount) || 0) + (Number(next.pageCount) || 0),
      totalPageCount: Number(next.totalPageCount) || Number(old.totalPageCount) || 0,
      rawVideosCount: (Number(old.rawVideosCount) || 0) + (Number(next.rawVideosCount) || 0),
      videosCount: mergedTopicList?.length ?? rawVideos(mergedVideosResponse).length,
    };
    if (next.error) {
      return {
        ...old,
        ...next,
        ...mergedTopics,
        ...accumulated,
        videosResponse: mergedVideosResponse,
        backgroundError: next.error,
        error: old.error || null,
      };
    }
    return {
      ...old,
      ...next,
      ...mergedTopics,
      ...accumulated,
      videosResponse: mergedVideosResponse,
      error: null,
      backgroundError: next.backgroundError || null,
    };
  });
  for (const [index, old] of previousItems.entries()) {
    if (!incomingKeys.has(resultIdentity(old, index))) merged.push(old);
  }
  return merged;
};
