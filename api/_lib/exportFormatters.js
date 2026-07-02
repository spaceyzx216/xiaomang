const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const pickStat = (item, keys) => {
  const blocks = [
    item,
    item?.stats,
    item?.rawData?.statistics,
    item?.rawData?.stats,
    item?.rawData?.statistics_data,
  ].filter(Boolean);

  for (const block of blocks) {
    for (const key of keys) {
      const value = block?.[key];
      if (value !== undefined && value !== null) return toNumber(value);
    }
  }
  return 0;
};

const normalizePublishDate = (value) => {
  if (!value) return "";
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return "";
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(value);
};

const firstHttpUrl = (...values) => {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstHttpUrl(...value);
      if (nested) return nested;
      continue;
    }
    if (value && typeof value === "object") {
      const nested = firstHttpUrl(value.url_list, value.url, value.uri);
      if (nested) return nested;
      continue;
    }
    const text = String(value || "").trim();
    if (/^https?:\/\//i.test(text)) return text;
  }
  return "";
};

const normalizeDurationSeconds = (...values) => {
  for (const value of values) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return Math.round(parsed > 10000 ? parsed / 1000 : parsed);
  }
  return 0;
};

export const normalizeBenchmarkVideos = (input = []) => {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const rawData = item?.rawData || item?.raw || {};
      const link =
        item?.link ||
        item?.shareLink ||
        rawData?.share_url ||
        rawData?.share_info?.share_url ||
        rawData?.video?.play_addr?.url_list?.[0] ||
        "";

      return {
        title: String(item?.title || rawData?.desc || rawData?.title || "未命名选题"),
        link: String(link || ""),
        coverUrl: firstHttpUrl(
          item?.coverUrl,
          item?.cover,
          rawData?.cover,
          rawData?.cover_url,
          rawData?.video?.cover,
          rawData?.video?.origin_cover,
          rawData?.video?.dynamic_cover,
          rawData?.video?.animated_cover,
        ),
        durationSeconds: normalizeDurationSeconds(
          item?.durationSeconds,
          item?.duration,
          rawData?.duration,
          rawData?.video_duration,
          rawData?.video?.duration,
          rawData?.video?.duration_ms,
        ),
        authorName: String(item?.authorName || rawData?.author?.nickname || rawData?.author_name || "未知"),
        publishDate: normalizePublishDate(item?.publishDate || rawData?.create_time || rawData?.createTime),
        likes: pickStat(item, ["likes", "digg_count", "like_count"]),
        comments: pickStat(item, ["comments", "comment_count"]),
        shares: pickStat(item, ["shares", "share_count"]),
        bookmarks: pickStat(item, ["bookmarks", "collect_count", "favorite_count", "bookmark_count"]),
        hotTopics: Array.isArray(item?.hotTopics) ? item.hotTopics.map(value => String(value || "")).filter(Boolean) : [],
      };
    })
    .filter(item => item.title || item.link);
};

export const formatMetric = (value) => {
  const numeric = toNumber(value);
  if (numeric >= 10000) return `${(numeric / 10000).toFixed(1)}万`;
  return String(numeric);
};

export const formatDuration = (value) => {
  const total = Math.max(0, Math.round(Number(value || 0)));
  if (!total) return "未知";
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
};

export const formatBenchmarkVideo = (item, index = 0) => [
  `对标视频 ${index + 1}`,
  `标题：${item?.title || "未命名选题"}`,
  `链接：${item?.link || "未提供"}`,
  item?.coverUrl ? `封面：${item.coverUrl}` : "",
  `时长：${formatDuration(item?.durationSeconds)}`,
  `作者：${item?.authorName || "未知"}`,
  item?.publishDate ? `发布时间：${item.publishDate}` : "",
  `数据：点赞 ${formatMetric(item?.likes)} / 评论 ${formatMetric(item?.comments)} / 转发 ${formatMetric(item?.shares)} / 收藏 ${formatMetric(item?.bookmarks)}`,
  Array.isArray(item?.hotTopics) && item.hotTopics.length > 0 ? `热词：${item.hotTopics.join("、")}` : "",
].filter(Boolean).join("\n");

export const formatBenchmarkSection = (videos) => {
  const normalized = normalizeBenchmarkVideos(videos);
  if (normalized.length === 0) return "未提供";
  return normalized.map(formatBenchmarkVideo).join("\n\n");
};

export const buildFinalDraftMarkdown = (draft = {}, options = {}) => {
  const heading = options.heading || "最终文案";
  return [
    `# ${heading}`,
    "",
    "## 对标选题视频",
    formatBenchmarkSection(draft.benchmarkVideos),
    "",
    "## 标题",
    String(draft.titleDraft || ""),
    "",
    "## 3 秒留存",
    String(draft.hookDraft || ""),
    "",
    "## 二创文案",
    String(draft.scriptDraft || ""),
    "",
    "## 风格转写结果",
    String(draft.rewriteDraft || ""),
    "",
    "## 中英翻译结果",
    String(draft.translationDraft || ""),
    "",
  ].join("\n");
};

export const csvEscape = (value) => `"${String(value || "").replace(/"/g, '""')}"`;

export const rowsToCsv = (rows) => rows.map(row => row.map(csvEscape).join(",")).join("\n");

export const buildFinalDraftCsvRows = (draft = {}) => [
  ["板块", "内容"],
  ["对标选题视频", formatBenchmarkSection(draft.benchmarkVideos)],
  ["标题", String(draft.titleDraft || "")],
  ["3秒留存", String(draft.hookDraft || "")],
  ["二创文案", String(draft.scriptDraft || "")],
  ["风格转写结果", String(draft.rewriteDraft || "")],
  ["中英翻译结果", String(draft.translationDraft || "")],
];

export const buildDraftListCsvRows = (items = []) => [
  ["序号", "保存时间", "对标选题视频", "标题", "3秒留存", "二创文案", "风格转写结果", "中英翻译结果"],
  ...items.map((item, index) => [
    String(index + 1),
    String(item?.createdAt || ""),
    formatBenchmarkSection(item?.benchmarkVideos),
    String(item?.titleDraft || ""),
    String(item?.hookDraft || ""),
    String(item?.scriptDraft || ""),
    String(item?.rewriteDraft || ""),
    String(item?.translationDraft || ""),
  ]),
];
