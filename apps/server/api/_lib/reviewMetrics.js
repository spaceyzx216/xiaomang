/**
 * 复盘分析（模块 4）的**指标口径与判定规则** —— 全项目唯一的一份。
 *
 * 为什么单独成文件、而且必须唯一：
 *   · 用户给的是**一张确定性的阈值表**（互动率 >5% 优秀、5s完播率 <25% 要调 3s 和标题…）。
 *     按项目铁律（见 `categoryTypeBreakdown.js` 顶部与 HANDOFF §6.3-⑬），
 *     **这类换算一律后端实算，绝不交给模型**：模型只负责「为什么好 / 该怎么调」的文字。
 *   · 抖音与视频号的指标集**不一样**（视频号没有 2s 跳出率，用的是 3 秒以上播放率），
 *     阈值也不一样。用一张平台规则表驱动，避免 if/else 散落到各处后互相漂移。
 *   · 前端**不另存一份**，只按本文件产出的判定结果渲染（同 §6.3-⑫ 的纪律）。
 *
 * 本文件**无网络、无 DB、无模型**，全部是纯函数 —— 单测直接打在这里。
 */

const asText = value => String(value ?? "").trim();

/**
 * 数值归一化：认 `123`、`"123"`、`"1,234"`、`"1.2万"`、`"3.4w"`、空值。
 *
 * 取不到时返回 `null` 而不是 0 —— **「没给」和「给了 0」必须区分开**
 * （这是本项目踩过的坑：`asNumber(undefined)` 是 0，把「不传门槛」悄悄变成「不限点赞」）。
 */
export const toNumber = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = asText(value).replace(/[,\s，]/g, "");
  if (!text) return null;
  const wan = text.match(/^(-?\d+(?:\.\d+)?)\s*(?:万|w|W)$/);
  if (wan) return Number(wan[1]) * 10000;
  const plain = Number(text);
  return Number.isFinite(plain) ? plain : null;
};

/**
 * 比率归一化 → 小数（0.32 表示 32%）。
 *
 * 🔴 这是本项目最容易错的一处：**Excel 里同一列可能是 `0.32`、`32`、`"32%"`、`"0.32"`**，
 *    取决于那一列的单元格格式。三种写法必须都认，否则「完播率 32%」会被读成
 *    「完播率 0.32%」而永远判成「需要优化」—— 用户看到的是一份全错的报告，却不报错。
 *
 * 规则：带 `%` ⇒ 除以 100；纯数字 > 1 ⇒ 视作百分数除以 100；≤ 1 ⇒ 视作小数。
 * ⚠️ 归一化后**不做区间夹取**：> 1 说明数据本身可疑（完播率不可能超过 100%），
 *    交给判定层标成「数据可疑」如实暴露，而不是悄悄夹成 100% 掩盖过去。
 */
export const toRate = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.includes("%")) {
    const parsed = toNumber(value.replace(/%/g, ""));
    return parsed === null ? null : parsed / 100;
  }
  const parsed = toNumber(value);
  if (parsed === null) return null;
  return Math.abs(parsed) > 1 ? parsed / 100 : parsed;
};

/** 一位小数的百分比（用于展示）。 */
export const toPercent = value => (value === null || value === undefined ? null : Math.round(value * 1000) / 10);

// ─────────────────────────────────────────────────────────────────────────────
// 1. 指标目录：每个指标「是什么、代表什么意义、属于直观数据还是专业数据」
//
//    用户原话要求「把数据背后代表的含义简单备注在后面，便于理解每个数据的意义」，
//    所以 `meaning` 是要**原样显示给用户看**的文案，不是内部注释。
// ─────────────────────────────────────────────────────────────────────────────

/** 直观数据 —— 用户能直接看到的互动数。 */
export const ENGAGEMENT_METRIC_CATALOG = [
  { key: "likes", label: "点赞", aliases: ["点赞", "点赞数", "赞", "like", "likes", "digg_count"], meaning: "内容使用户产生共鸣 / 情绪" },
  { key: "comments", label: "评论", aliases: ["评论", "评论数", "comment", "comments", "comment_count"], meaning: "内容话题度高 / 有槽点" },
  { key: "shares", label: "转发", aliases: ["转发", "分享", "转发数", "share", "shares", "share_count"], meaning: "内容有分享价值、有转化潜力" },
  { key: "bookmarks", label: "收藏", aliases: ["收藏", "收藏数", "bookmark", "bookmarks", "collect_count", "favorite_count"], platforms: ["douyin"], meaning: "内容干货含量高、对用户有价值" },
  { key: "recommends", label: "红心（推荐）", aliases: ["红心", "推荐", "推荐数", "recommend", "recommends"], platforms: ["wechat_channels"], meaning: "内容干货含量高、对用户有价值" },
  // ⚠️ 「关注」标 `optional`：它只在权重表里出现，**不参与任何判定公式**
  //    （互动率的分子按用户口径只有四项，不含关注）。很多平台的导出表里也没有这一列，
  //    把它算进「缺失」会让每份报告都挂一条与结论无关的噪声。缺失它只影响权重展示。
  { key: "follows", label: "关注", aliases: ["关注", "涨粉", "关注数", "follow", "follows", "follower_count"], optional: true, meaning: "对 IP 本身有认同" },
];

/** 专业数据 —— 需要平台后台才看得到的指标。 */
export const PROFESSIONAL_METRIC_CATALOG = [
  { key: "plays", label: "播放量", aliases: ["播放量", "播放", "播放数", "play", "plays", "play_count", "view_count", "vv"], platforms: ["douyin", "wechat_channels"], meaning: "结果指标：由其它数据共同决定，本身不作为原因分析" },
  { key: "completionRate", label: "完播率", aliases: ["完播率", "完播", "completion_rate", "finish_rate"], platforms: ["douyin", "wechat_channels"], kind: "rate", meaning: "有多少人把整条看完了" },
  { key: "avgPlaySeconds", label: "平均播放时长", aliases: ["平均播放时长", "平均播放", "平均时长", "avg_play", "avg_play_time", "average_play_time"], platforms: ["douyin", "wechat_channels"], kind: "seconds", meaning: "平均每个人看了多少秒" },
  { key: "durationSeconds", label: "视频时长", aliases: ["视频时长", "时长", "duration", "video_duration", "duration_seconds"], platforms: ["douyin", "wechat_channels"], kind: "seconds", meaning: "本条视频的总长度，用于算平均播放率" },
  { key: "bounce2sRate", label: "2s 跳出率", aliases: ["2s跳出率", "2秒跳出率", "2s跳出", "两秒跳出率", "bounce_2s", "bounce2s"], platforms: ["douyin"], kind: "rate", meaning: "开头两秒就走掉的比例，直接反映黄金三秒和标题的抓人能力" },
  { key: "completion5sRate", label: "5s 完播率", aliases: ["5s完播率", "5秒完播率", "5s完播", "completion_5s", "completion5s"], platforms: ["douyin"], kind: "rate", meaning: "看到第 5 秒的比例，反映开场是否留得住人" },
  { key: "play3sRate", label: "3 秒以上播放率", aliases: ["3秒以上播放率", "3s以上播放率", "3秒播放率", "3s播放率", "play_3s", "play3s"], platforms: ["wechat_channels"], kind: "rate", meaning: "视频号对应的「开场抓人」指标，作用等同抖音的 2s 跳出率 + 5s 完播率" },
];

/** 全部指标（按平台过滤后使用）。 */
export const allMetrics = () => [...ENGAGEMENT_METRIC_CATALOG, ...PROFESSIONAL_METRIC_CATALOG];

/** 取某个平台可用的指标（`platforms` 缺省表示全平台通用）。 */
export const metricsForPlatform = platform => {
  const target = asText(platform) || "douyin";
  return allMetrics().filter(metric => !metric.platforms || metric.platforms.includes(target));
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. 平台与权重
// ─────────────────────────────────────────────────────────────────────────────

export const REVIEW_PLATFORMS = [
  { key: "douyin", label: "抖音" },
  { key: "wechat_channels", label: "视频号" },
];

export const isReviewPlatform = platform => REVIEW_PLATFORMS.some(item => item.key === platform);

/** 归一化平台名（本模块只认这两个；别名收口在这一处）。 */
export const normalizeReviewPlatform = value => {
  const text = asText(value).toLowerCase();
  if (["wechat_channels", "wechat", "channels", "视频号", "wx"].includes(text)) return "wechat_channels";
  return "douyin";
};

/**
 * 直观数据的权重序（**越靠前越重要**，同一档用数组表示并列）。
 *
 * 用户口径：
 *   抖音   关注 > 收藏 = 转发 > 评论 = 点赞
 *   视频号 关注 > 转发 > 评论 = 红心 > 点赞
 */
export const ENGAGEMENT_WEIGHT_ORDER = {
  douyin: [["follows"], ["bookmarks", "shares"], ["comments", "likes"]],
  wechat_channels: [["follows"], ["shares"], ["comments", "recommends"], ["likes"]],
};

/**
 * 专业数据的权重序。
 *
 * 用户只给了抖音的：`2s跳出率 > 5s完播率 > 完播率 = 平均播放时长`。
 * 视频号那份是**从用户给的「优化建议方案」优先级反推**的（3 秒以上播放率决定 3s 与标题，
 * 完播率决定选题与结尾钩子）—— 这里如实标注来源，不假装是用户原话。
 */
export const PROFESSIONAL_WEIGHT_ORDER = {
  douyin: [["bounce2sRate"], ["completion5sRate"], ["completionRate", "avgPlaySeconds"]],
  // ⚠️ 反推所得，非用户原话（用户未给视频号专业数据的权重序）。
  wechat_channels: [["play3sRate"], ["completionRate", "avgPlaySeconds"]],
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. 阈值表 —— 用户的「判断标准」
//
//    `direction: "up"`  越大越好（good 是下界，bad 是上界）
//    `direction: "down"` 越小越好（good 是上界，bad 是下界）—— 只有跳出率是这种
//
//    ⚠️ 用户只给了「优秀」与「需要优化」两条线，中间那段**用户没定义**。
//       这里如实标成 `watch`（未达优秀、也未触发优化），**不替用户编一个标准**。
// ─────────────────────────────────────────────────────────────────────────────

export const VERDICT_LEVELS = {
  good: { key: "good", label: "优秀", tone: "good" },
  watch: { key: "watch", label: "正常", tone: "watch" },
  bad: { key: "bad", label: "需要优化", tone: "bad" },
  missing: { key: "missing", label: "数据缺失", tone: "missing" },
  suspicious: { key: "suspicious", label: "数据可疑", tone: "bad" },
};

const RULE_TABLE = {
  douyin: [
    {
      metric: "interactionRate", label: "互动率",
      direction: "up", good: 0.05, bad: 0.03,
      goodText: "选题类型、结尾钩子优秀", badText: "优化调整选题内容、结尾钩子类型，增加互动",
      affects: ["topicType", "endingHook"],
      formula: "（点赞 + 评论 + 转发 + 收藏）/ 播放量",
    },
    {
      metric: "completion5sRate", label: "5s 完播率",
      direction: "up", good: 0.5, bad: 0.25,
      goodText: "3s 和标题类型优秀", badText: "调整 3s 和标题",
      affects: ["goldThreeSeconds", "title"],
    },
    {
      metric: "bounce2sRate", label: "2s 跳出率",
      direction: "down", good: 0.2, bad: 0.5,
      goodText: "3s 和标题类型优秀", badText: "调整 3s 和标题",
      affects: ["goldThreeSeconds", "title"],
    },
    {
      metric: "completionRate", label: "完播率",
      direction: "up", good: 0.3, bad: 0.15,
      goodText: "选题类型优秀", badText: "调整选题类型，内容不够有吸引",
      affects: ["topicType"],
    },
    {
      metric: "avgPlayRate", label: "平均播放率",
      direction: "up", good: 0.3, bad: 0.15,
      goodText: "选题类型优秀", badText: "调整选题类型，内容不够有吸引",
      affects: ["topicType"],
      formula: "平均播放时长 / 视频时长",
    },
  ],
  wechat_channels: [
    {
      metric: "interactionRate", label: "互动率",
      direction: "up", good: 0.05, bad: 0.03,
      goodText: "选题类型、结尾钩子优秀", badText: "优化调整选题内容、结尾钩子类型，增加互动",
      affects: ["topicType", "endingHook"],
      formula: "（点赞 + 评论 + 转发 + 红心）/ 播放量",
    },
    {
      metric: "play3sRate", label: "3 秒以上播放率",
      direction: "up", good: 0.7, bad: 0.6,
      goodText: "3s 和标题类型优秀", badText: "调整 3s 和标题",
      affects: ["goldThreeSeconds", "title"],
    },
    {
      metric: "completionRate", label: "完播率",
      direction: "up", good: 0.3, bad: 0.15,
      // ⚠️ 与抖音不同：视频号的完播率同时影响「选题类型」与「结尾钩子」（用户口径如此）。
      goodText: "选题类型、结尾钩子优秀", badText: "调整选题类型、结尾钩子，内容不够有吸引",
      affects: ["topicType", "endingHook"],
    },
    {
      metric: "avgPlayRate", label: "平均播放率",
      direction: "up", good: 0.3, bad: 0.15,
      goodText: "选题类型优秀", badText: "调整选题类型，内容不够有吸引",
      affects: ["topicType"],
      formula: "平均播放时长 / 视频时长",
    },
  ],
};

/** 取某平台的阈值规则表（返回副本，调用方改不到内部常量）。 */
export const metricRulesForPlatform = platform => (RULE_TABLE[normalizeReviewPlatform(platform)] || []).map(rule => ({ ...rule }));

const ruleByMetric = (platform, metric) => (RULE_TABLE[normalizeReviewPlatform(platform)] || []).find(rule => rule.metric === metric) || null;

// ─────────────────────────────────────────────────────────────────────────────
// 4. 四大文案结构的优化方向优先级（用户口径，逐条照录）
// ─────────────────────────────────────────────────────────────────────────────

export const REVIEW_STRUCTURES = [
  { key: "topicType", label: "选题类型（小类）", hint: "这条视频该归到哪个大类 / 小类，以及该不该继续做这类选题" },
  { key: "goldThreeSeconds", label: "黄金 3 秒", hint: "开场前三秒用什么类型抓人" },
  { key: "title", label: "标题", hint: "标题用什么类型；与 3s 同源，共用同一份类型表" },
  { key: "endingHook", label: "结尾钩子", hint: "结尾用什么类型收口、引导互动或转化" },
];

/** 每个结构按什么指标判定，**数组顺序就是优先级**。 */
export const STRUCTURE_METRIC_PRIORITY = {
  douyin: {
    topicType: ["completionRate", "avgPlayRate", "interactionRate"],
    goldThreeSeconds: ["bounce2sRate", "completion5sRate"],
    title: ["bounce2sRate", "completion5sRate"],
    endingHook: ["completionRate", "interactionRate"],
  },
  wechat_channels: {
    topicType: ["completionRate", "avgPlayRate", "interactionRate"],
    goldThreeSeconds: ["play3sRate"],
    title: ["play3sRate"],
    endingHook: ["completionRate", "interactionRate"],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. 播放量流量池分层（4.2 账号周报用；表定义在这一处，避免两处各写一份）
// ─────────────────────────────────────────────────────────────────────────────

export const PLAY_BUCKETS = [
  { key: "abnormal", label: "账号状态异常", max: 200, hint: "50~200：账号状态异常，先排查账号本身而不是内容" },
  { key: "base", label: "基础流量池", max: 1000, hint: "500~1000：基础流量池，属于正常起量" },
  { key: "potential", label: "有爆款潜力", max: 10000, hint: "1000~1w：有爆款潜力，逐个数据对照标准值找可复用与待优化项" },
  { key: "hit", label: "爆款", max: Infinity, hint: ">1w：拆解各个结构，分析爆款原因" },
];

/**
 * 播放量分层。
 *
 * ⚠️ 分档边界按用户给的区间**如实标注**，重叠处（例如 200~500）用户没定义，
 *    这里归入「基础流量池」并**在返回值里标出来**，不假装它被定义过。
 */
export const classifyPlayBucket = plays => {
  const value = toNumber(plays);
  if (value === null) return { key: "unknown", label: "无播放量数据", hint: "", ambiguous: false };
  // 用户给的是四段区间，但**段与段之间有空档**：50 以下、200~500 没有归属。
  // 空档里的播放量按就近归档，同时把 `ambiguous` 标出来，由界面如实提示
  // 「这段区间用户没有定义，分档仅供参考」——而不是假装它被定义过。
  if (value < 50) return { ...PLAY_BUCKETS[0], ambiguous: true };
  if (value <= 200) return { ...PLAY_BUCKETS[0], ambiguous: false };
  if (value < 500) return { ...PLAY_BUCKETS[1], ambiguous: true };
  if (value <= 1000) return { ...PLAY_BUCKETS[1], ambiguous: false };
  if (value <= 10000) return { ...PLAY_BUCKETS[2], ambiguous: false };
  return { ...PLAY_BUCKETS[3], ambiguous: false };
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. 实算与判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 归一化原始指标（从 Excel 行或手工输入来）。
 *
 * @returns { metrics, missing[], optionalMissing[], suspicious[] }
 *   · `missing`          判定会用到的指标缺失 —— 会影响结论，必须如实暴露；
 *   · `optionalMissing`  只用于权重展示的指标缺失（当前只有「关注」）—— 单列出来，
 *                        不混进 `missing` 制造与结论无关的噪声；
 *   · `suspicious`       数值越界（完播率 > 100% 之类）—— 不夹取，交判定层标可疑。
 *
 * ⚠️ 本函数**只归一化入参给的原始指标**。`interactionRate` / `avgPlayRate` 两个派生量
 *    不在这里生成（它们必须由 `computeDerivedMetrics` 按公式算），
 *    所以**调用方传进来的同名值一律无效** —— 这是有意的：派生量不允许被外部覆盖。
 */
export const normalizeMetrics = ({ platform, raw = {} } = {}) => {
  const target = normalizeReviewPlatform(platform);
  const metrics = {};
  const missing = [];
  const optionalMissing = [];
  const suspicious = [];

  for (const metric of metricsForPlatform(target)) {
    const value = raw[metric.key];
    if (metric.kind === "rate") {
      const rate = toRate(value);
      metrics[metric.key] = rate;
      if (rate === null) (metric.optional ? optionalMissing : missing).push(metric.key);
      else if (rate < 0 || rate > 1) suspicious.push(metric.key);
    } else {
      const number = toNumber(value);
      metrics[metric.key] = number;
      if (number === null) (metric.optional ? optionalMissing : missing).push(metric.key);
      else if (number < 0) suspicious.push(metric.key);
    }
  }
  return { metrics, missing, optionalMissing, suspicious };
};

/**
 * 实算派生指标。
 *
 * ⚠️ 分母缺失或为 0 时返回 `null`（而不是 0 或 Infinity）——
 *    这样判定层会说「数据缺失」，而不是拿一个假数字去下结论。
 */
export const computeDerivedMetrics = ({ platform, metrics = {} } = {}) => {
  const target = normalizeReviewPlatform(platform);
  const derived = {};

  const plays = metrics.plays;
  const engagementKeys = target === "wechat_channels"
    ? ["likes", "comments", "shares", "recommends"]
    : ["likes", "comments", "shares", "bookmarks"];
  const engagementValues = engagementKeys.map(key => metrics[key]).filter(value => typeof value === "number");
  derived.engagementTotal = engagementValues.length === engagementKeys.length
    ? engagementValues.reduce((sum, value) => sum + value, 0)
    : null;
  derived.interactionRate = derived.engagementTotal !== null && plays > 0
    ? derived.engagementTotal / plays
    : null;

  const { avgPlaySeconds, durationSeconds } = metrics;
  derived.avgPlayRate = typeof avgPlaySeconds === "number" && typeof durationSeconds === "number" && durationSeconds > 0
    ? avgPlaySeconds / durationSeconds
    : null;

  return derived;
};

/** 判定单个指标。 */
export const judgeMetric = ({ platform, metric, value }) => {
  const rule = ruleByMetric(platform, metric);
  if (!rule) return null;
  const level = VERDICT_LEVELS;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ...rule, metric, value: null, level: "missing", levelLabel: level.missing.label, conclusion: "数据缺失，无法判定", meaning: "" };
  }
  // 比率型指标越界（完播率 > 100% 等）：如实标可疑，不夹取、不硬判。
  const isRate = metric.endsWith("Rate") || metric === "interactionRate";
  if (isRate && (value < 0 || value > 1)) {
    return { ...rule, metric, value, level: "suspicious", levelLabel: level.suspicious.label, conclusion: "数值超出 0~100% 的合理范围，请核对这一列的口径（是否被识别成了别的单位）", meaning: "" };
  }
  if (rule.direction === "up") {
    if (value > rule.good) return { ...rule, metric, value, level: "good", levelLabel: level.good.label, conclusion: rule.goodText, meaning: "" };
    if (value < rule.bad) return { ...rule, metric, value, level: "bad", levelLabel: level.bad.label, conclusion: rule.badText, meaning: "" };
  } else {
    if (value < rule.good) return { ...rule, metric, value, level: "good", levelLabel: level.good.label, conclusion: rule.goodText, meaning: "" };
    if (value > rule.bad) return { ...rule, metric, value, level: "bad", levelLabel: level.bad.label, conclusion: rule.badText, meaning: "" };
  }
  return {
    ...rule, metric, value, level: "watch", levelLabel: level.watch.label,
    conclusion: "未达优秀线、也未触发优化线（用户未定义中间档口径），保持现状",
    meaning: "",
  };
};

/**
 * 判定一条视频的全部指标 —— 报告里「数据分析报告」那一节的数据来源。
 *
 * 返回顺序**按规则表顺序**（互动率 → 抓人指标 → 完播 → 平均播放率），
 * 这样界面上「数据好的在上面、待优化的在下面」不会随输入顺序乱跳。
 */
export const judgeVideoMetrics = ({ platform, metrics = {} } = {}) => {
  const target = normalizeReviewPlatform(platform);
  const derived = computeDerivedMetrics({ platform: target, metrics });
  const merged = { ...metrics, ...derived };
  const judgments = [];
  for (const rule of RULE_TABLE[target] || []) {
    const judgment = judgeMetric({ platform: target, metric: rule.metric, value: merged[rule.metric] });
    if (judgment) judgments.push(judgment);
  }
  const summary = {
    good: judgments.filter(item => item.level === "good").length,
    watch: judgments.filter(item => item.level === "watch").length,
    bad: judgments.filter(item => item.level === "bad").length,
    missing: judgments.filter(item => item.level === "missing").length,
    suspicious: judgments.filter(item => item.level === "suspicious").length,
  };
  return { judgments, derived, merged, summary };
};

/**
 * 逐结构给出优化方向 —— 报告里「优化建议方案」那一节的**数据依据**。
 *
 * 每个结构按 `STRUCTURE_METRIC_PRIORITY` 逐指标看：
 *   · 只要有**任意一个 bad** ⇒ 该结构判「需要优化」，并列出是哪个指标触发的（按优先级排序）；
 *   · 全部 good ⇒ 判「可复用」；
 *   · 其余（含中间档、数据缺失）⇒ 判「维持观察」，并如实说明缺了哪项数据。
 *
 * 🔴 **模型的文字建议必须以这个结论为准**：模型只写「为什么 / 怎么调」，
 *    不许把 good 说成 bad。归一化层会核对，对不上就记 warning（同 §6.3-⑭ 的纪律）。
 */
export const buildStructureDirections = ({ platform, judgments = [], metrics = {} } = {}) => {
  const target = normalizeReviewPlatform(platform);
  const priority = STRUCTURE_METRIC_PRIORITY[target] || {};
  const byMetric = new Map(judgments.map(item => [item.metric, item]));

  return REVIEW_STRUCTURES.map(structure => {
    const metricKeys = priority[structure.key] || [];
    const checked = metricKeys.map(key => byMetric.get(key)).filter(Boolean);
    const bad = checked.filter(item => item.level === "bad");
    const good = checked.filter(item => item.level === "good");
    const missing = checked.filter(item => item.level === "missing");

    let verdict = "watch";
    if (checked.length === 0 || missing.length === checked.length) verdict = "missing";
    else if (bad.length > 0) verdict = "optimize";
    else if (good.length === checked.length) verdict = "reuse";

    const reasons = bad.length > 0
      ? bad.map(item => `${item.label} 触发优化线（实测 ${formatMetricValue(item.metric, item.value)}，标准 ${formatThreshold(item)}）`)
      : good.map(item => `${item.label} 达优秀线（实测 ${formatMetricValue(item.metric, item.value)}，标准 ${formatThreshold(item)}）`);

    return {
      key: structure.key,
      label: structure.label,
      hint: structure.hint,
      verdict,
      verdictLabel: { reuse: "可模仿复用", optimize: "需要优化", watch: "维持观察", missing: "数据缺失" }[verdict],
      primaryMetric: metricKeys[0] ? (byMetric.get(metricKeys[0]) || null) : null,
      metrics: checked,
      reasons,
      missingMetrics: missing.map(item => item.label),
    };
  });
};

/** 指标值的展示口径（比率带 %、时长带 s、其余取整）。 */
export const formatMetricValue = (metric, value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const rule = allMetrics().find(item => item.key === metric);
  if (rule?.kind === "rate") return `${toPercent(value)}%`;
  if (rule?.kind === "seconds") return `${Math.round(value * 10) / 10}s`;
  if (metric === "interactionRate" || metric === "avgPlayRate") return `${toPercent(value)}%`;
  return String(Math.round(value));
};

/** 阈值文案（用于「标准是多少」那句话）。 */
export const formatThreshold = rule => {
  if (!rule) return "—";
  const good = formatMetricValue(rule.metric, rule.good);
  const bad = formatMetricValue(rule.metric, rule.bad);
  return rule.direction === "up" ? `优秀 > ${good}，优化 < ${bad}` : `优秀 < ${good}，优化 > ${bad}`;
};

/** 权重序 → 可直接渲染的「重要程度」列表。 */
export const describeWeights = platform => {
  const target = normalizeReviewPlatform(platform);
  const render = (order, catalog) => (order || []).map((group, index) => ({
    rank: index + 1,
    items: group.map(key => catalog.find(item => item.key === key)?.label || key),
  }));
  return {
    engagement: render(ENGAGEMENT_WEIGHT_ORDER[target], ENGAGEMENT_METRIC_CATALOG),
    professional: render(PROFESSIONAL_WEIGHT_ORDER[target], PROFESSIONAL_METRIC_CATALOG),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. Excel 表头 → 指标 key 的自动识别
// ─────────────────────────────────────────────────────────────────────────────

/** 表头归一化：去空白/标点、全角括号转半角、去掉括注、转小写，便于比对。 */
const normalizeHeader = value => String(value ?? "")
  .replace(/[\s\u3000]/g, "")
  .replace(/（/g, "(")
  .replace(/）/g, ")")
  .replace(/[：:]/g, "")
  .replace(/\(.*?\)/g, "")   // 去掉「播放量(次)」这类括注
  .toLowerCase();

/**
 * 按表头**猜**每一列对应哪个指标。
 *
 * 🔴 这只是一个**建议值**，界面必须让用户确认或改（用户 2026-09-30 明确要求
 *    「上传后确认列映射」）。所以这里的策略是**宁缺毋滥**：
 *    匹配不上就留空交给用户指认 —— 猜错一个百分比列的口径，
 *    整份报告会全错，而用户从界面上看不出来。
 *
 * 匹配优先级：中文标签精确 > 别名精确 > 包含（「视频播放量」「播放量(次)」这类）。
 * 一个指标只会被分配一次（先到先得），避免两列抢同一个指标。
 *
 * @returns { mapping, unmatched, missingMetrics }
 *   · `mapping`        { 表头: 指标key }
 *   · `unmatched`      没识别出的表头（界面提示「这列用不上」）
 *   · `missingMetrics` 没找到对应列的指标 key（界面提示「请指认播放量在哪一列」）
 */
export const suggestColumnMapping = ({ headers = [], platform = "douyin" } = {}) => {
  const target = normalizeReviewPlatform(platform);
  const catalog = metricsForPlatform(target);
  const list = (Array.isArray(headers) ? headers : []).map(header => String(header ?? ""));

  const mapping = {};
  const taken = new Set();

  const claim = (header, metricKey) => {
    if (taken.has(metricKey) || mapping[header]) return false;
    mapping[header] = metricKey;
    taken.add(metricKey);
    return true;
  };

  // 第 1 轮：中文标签精确匹配
  for (const header of list) {
    const key = normalizeHeader(header);
    if (!key) continue;
    const hit = catalog.find(metric => normalizeHeader(metric.label) === key);
    if (hit) claim(header, hit.key);
  }
  // 第 2 轮：别名精确匹配（含英文列名）
  for (const header of list) {
    const key = normalizeHeader(header);
    if (!key || mapping[header]) continue;
    const hit = catalog.find(metric => metric.aliases.some(alias => normalizeHeader(alias) === key));
    if (hit) claim(header, hit.key);
  }
  // 第 3 轮：包含匹配
  for (const header of list) {
    const key = normalizeHeader(header);
    if (!key || mapping[header]) continue;
    const hit = catalog.find(metric => !taken.has(metric.key)
      && (key.includes(normalizeHeader(metric.label)) || normalizeHeader(metric.label).includes(key)));
    if (hit) claim(header, hit.key);
  }

  const unmatched = list.filter(header => !mapping[header] && asText(header));
  // 「关注」是可选项，没识别到不算缺 —— 否则每份表都提示缺一列，纯噪声。
  const missingMetrics = catalog
    .filter(metric => !taken.has(metric.key) && !metric.optional)
    .map(metric => metric.key);

  return { mapping, unmatched, missingMetrics };
};
