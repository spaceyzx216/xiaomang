import type { TopicRefreshVideo } from "./topicLibrary";

/**
 * 「今日选题」内容分析的**纯规则**（无副作用、无网络、无浏览器 API）。
 *
 * 单独拆出来是为了能被 `node --test` 直接加载（`tests/topic-content-rules.test.mjs`）：
 * 这个文件**不能 import 任何会拉进浏览器依赖的模块**，否则测试跑不起来。
 * 真正的网络编排在 `topicContentAnalysis.ts` 里。
 *
 * ── 用户口径（2026-09-21）────────────────────────────────────────────────
 * 1. 列表只保留**严格 `likes > 100`**（100 不达标，缺失点赞算 0）。
 * 2. **近 7 天**：给达标视频**语音提取完整脚本**，供下一步二创直接复用。
 * 3. **15 天及以上**：**不提取脚本**，只做点赞筛选 + 标签判定。
 * 4. 两边都按**本账号选题库**的大类/小类打标签。
 */

/** 点赞门槛默认值。口径是**大于等于**（填 100 时 100 算达标），可被用户自定义。 */
export const TOPIC_MIN_LIKES = 100;

/** 只有近 7 天（含）才提取完整脚本。 */
export const TRANSCRIPT_MAX_DAYS = 7;

/**
 * 点赞数归一化，**与后端 `benchmarkTopicRefresh.asNumber` 保持同一口径**：
 * 非有限值（`"abc"`、`NaN`、`Infinity`）与负数一律当 0。
 *
 * 🔴 原来直接写 `Number(topic?.stats?.likes || 0) >= minLikes`，于是
 *    `likes: "abc"` 得到 `NaN`，而 `NaN >= 0` 是 **false** —— 门槛填 0 时
 *    前端把它挡掉、后端却按 0 放它进来，同一批数据两边筛出不同结果。
 *    这类"两边各算一套"最难查：界面少了几条，但两边都说自己是对的。
 */
export const normalizeLikes = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
};

/** 只保留点赞**大于等于**门槛的条目。缺失/非法点赞归一化成 0 —— 所以门槛填 0 时它们会被纳入（这是有意的）。 */
export const filterByLikes = <T extends { stats?: { likes?: number } }>(topics: T[], minLikes: number = TOPIC_MIN_LIKES): T[] =>
  topics.filter(topic => normalizeLikes(topic?.stats?.likes) >= minLikes);

/** 自定义点赞门槛的允许区间。上界只是防手滑（填 999999999 等于把列表清空）。 */
export const MIN_LIKES_FLOOR = 0;
export const MIN_LIKES_CEILING = 10_000_000;

/**
 * 解析用户填的点赞门槛。
 *
 * 返回 `{ ok, value, error }` 而不是抛异常：界面上要**当场**告诉用户哪里不对，
 * 而不是等提交时才炸。空字符串按"用默认值"处理（把输入框清空是常见操作）。
 *
 * 🔴 刻意**不做静默夹取**。后端 `resolveMinLikes` 是 `Math.max(下界, 传入值)`：
 *    前端填 50 会被悄悄夹成 100 —— 界面显示 50、实际按 100 过滤，而且不报错。
 *    这类"显示与实际不一致"比直接报错难查得多，所以这里超范围一律明确报错。
 */
export const parseMinLikes = (value: unknown): { ok: boolean; value: number; error: string } => {
  const text = String(value ?? "").trim();
  if (!text) return { ok: true, value: TOPIC_MIN_LIKES, error: "" };
  if (!/^\d+$/.test(text)) {
    return { ok: false, value: TOPIC_MIN_LIKES, error: `点赞门槛要填非负整数（当前填的是「${text}」）` };
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_LIKES_FLOOR || parsed > MIN_LIKES_CEILING) {
    return { ok: false, value: TOPIC_MIN_LIKES, error: `点赞门槛要在 ${MIN_LIKES_FLOOR} – ${MIN_LIKES_CEILING} 之间` };
  }
  return { ok: true, value: parsed, error: "" };
};

/** 近 7 天（含）才提取脚本；更长的窗口只筛点赞 + 打标签。 */
export const shouldExtractTranscripts = (days: number) => Number(days) <= TRANSCRIPT_MAX_DAYS;

/** 每个视频的分析结果：脚本 + 标签。 */
export type TopicContent = {
  script: string;
  scriptSource: "transcript" | "caption";
  categoryName: string;
  subcategoryName: string;
  categoryId: string;
  confidence: string;
  basis: string;
};

export type TopicContentMap = Record<string, TopicContent>;

/**
 * 把分析结果挂到 topic 对象上（**返回新对象，不改原数组**）。
 *
 * ⚠️ 这一步是「二创不用再提取脚本」的关键：勾选后 `handleSubmit` 会把选中的 topic
 * 整体序列化进 `sessionStorage.selectedTopics`，脚本只有挂在 topic 上才能跟着走过去。
 */
export const attachContent = <T extends { id: string }>(
  topics: T[],
  content: TopicContentMap,
): Array<T & { content?: TopicContent }> =>
  topics.map(topic => (content[topic.id] ? { ...topic, content: content[topic.id] } : topic));

/** 拼成后端要的刷新视频形状。 */
export const toRefreshVideo = (topic: {
  id: string;
  title?: string;
  link?: string;
  authorName?: string;
  publishDate?: string;
  platform?: string;
  source?: { mediaUrl?: string; decodeKey?: string };
  rawData?: { media?: { url?: string; full_url?: string; decode_key?: string } };
  stats?: { likes?: number; comments?: number; shares?: number; bookmarks?: number };
}): TopicRefreshVideo => {
  const rawMedia = topic.rawData?.media;
  const platform = topic.platform === "tiktok"
    ? "tiktok"
    : topic.platform === "wechat_channels" ? "wechat_channels" : "douyin";
  // 视频号没有分享链接：媒体直链在 source.mediaUrl（兜底 rawData.media）。
  // 抽成这里是为了让"能不能转写"的判断只写一份 —— 与后端的判定保持同一口径。
  const mediaUrl = String(topic.source?.mediaUrl || rawMedia?.full_url || rawMedia?.url || "");
  const decodeKey = String(topic.source?.decodeKey || rawMedia?.decode_key || "");
  return {
    id: String(topic.id || ""),
    title: String(topic.title || "").slice(0, 240),
    link: String(topic.link || ""),
    authorName: String(topic.authorName || ""),
    publishDate: String(topic.publishDate || ""),
    sourceText: "",
    platform,
    stats: {
      likes: Number(topic.stats?.likes || 0),
      comments: Number(topic.stats?.comments || 0),
      shares: Number(topic.stats?.shares || 0),
      bookmarks: Number(topic.stats?.bookmarks || 0),
    },
    ...(platform === "wechat_channels" ? { mediaUrl, decodeKey } : {}),
  };
};

/**
 * 能进入「提取脚本」的条目 —— 两种平台各有各的必备字段：
 *   · 抖音/TikTok：必须**有分享链接**（后端靠它去 TikHub 解析直链）；
 *   · 视频号：必须**有媒体直链 + decodeKey**（它没有分享链接，靠本地解密后转写）。
 *
 * ⚠️ 原来这里一律要求 `video.link`，于是**视频号选题在第一步就被静默丢掉**，
 *    表现就是"选题页永远分析不了视频号"。现在按平台分别判断。
 * ⚠️ **不要求 `title`**：抖音允许无描述发布，后端 `normalizeTopicRefreshVideos`
 *    也刻意放行了这类作品。前端过滤比后端严会导致条目在到达后端前就被丢掉，
 *    症状是"少分析了几条却看不出原因"。
 */
export const transcribableVideos = (
  topics: Array<Parameters<typeof toRefreshVideo>[0]>,
): TopicRefreshVideo[] => topics
  .map(toRefreshVideo)
  .filter(video => Boolean(video.id) && (
    video.platform === "wechat_channels"
      ? Boolean(video.mediaUrl && video.decodeKey)
      : Boolean(video.link)
  ));
