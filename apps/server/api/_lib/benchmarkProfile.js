import { REVIEW_CATEGORY_NAME } from "./benchmarkAnalysis.js";
import { buildDemographicsFromPortrait, describePortraitDimension } from "./douyinFansPortrait.js";
// 证据助手（分级、引文核对、价格核对）与 1.3 **共用一份实现**，实现见 `evidence.js`。
import {
  PROFILE_EVIDENCE_LEVELS,
  asNumber,
  asText,
  cleanText,
  joinEvidenceParts,
  normalizeBasisField,
  normalizePrice,
  ratio,
} from "./evidence.js";
import { ENDING_HOOK_TYPES, ENDING_HOOK_TYPE_LABELS, lastSentenceOf, normalizeEndingHookType } from "./endingHooks.js";
import {
  GOLD_THREE_SECOND_DIMENSIONS,
  GOLD_THREE_SECOND_TYPE_LABELS,
  firstSentenceOf,
  normalizeGoldThreeSecondType,
} from "./goldThreeSeconds.js";
import { selectStageVideos } from "./stageSampleWindow.js";

// 证据标签表挪进了公共层，但**这里继续原样转出**：它是 1.2 报告的证据分级口径，
// 外部一直从这个模块取；换了实现位置不等于要改调用方。
export { PROFILE_EVIDENCE_LEVELS } from "./evidence.js";

/**
 * 模块 1「对标账号分析」(1.2) 的核心。
 *
 * 它与模块 3 的三个子步骤是**不同性质**的东西，别照抄：
 *   - 2.1/2.2/2.3 各自只看一件事（分类 / 开场 / 结尾），产出可复用的选题库素材；
 *   - 1.2 是**上层综合模块**：复用 2.1 的分类产出，自己只新跑「点赞前 20 条」的
 *     三秒与结尾简化分析，再综合账号简介、评论区、发布数据，输出商业定位 / 用户画像 /
 *     内容定位 / 高频标签 / 运营策略。
 *
 * ── 本文件承载的三条硬性不变量（改之前先读 HANDOFF §5 / §6.3）────────────────────
 *
 * ① **证据必须分级，不许编造。** 每个叙述字段都带 `level`：
 *      evidence（输入证据）/ inference（Agent 推断）/ manual（待人工补充）。
 *    模型自报的 level **不采信**：它声明引用证据时，引文必须真能在输入里找到，
 *    否则后端压到 inference（与 §6.3⑭「不信模型自称引用了转写」同一条原则）。
 *
 * ② **用户画像的人口属性默认不能是 evidence —— 除非有真实画像数据支撑。**
 *    2026-09-18 已接入抖音热榜「粉丝画像」（`douyinFansPortrait.js`），它给出真实的
 *    性别/年龄/手机价格/城市等级/手机品牌/兴趣分布。**命中这些维度时可以且应当标
 *    evidence**（basis 就是那份分布原文）；没有画像数据时才退回旧的硬上限
 *    （最多 inference，没依据就 manual）。职业/行业没有对应维度，永远不是 evidence。
 *    这一段对应 HANDOFF §5「不要输出看似完整但没有数据依据的用户画像」。
 *
 * ③ **价格必须能在输入里找到数字，否则留空。**
 *    模型手里根本没有产品定价数据。HANDOFF §5 同样点名禁止编造变现产品价格。
 */

/**
 * 1.2 的三秒 / 结尾分析样本数：**只取点赞最高的前 20 条**。
 *
 * 与 2.2/2.3 刻意不同 —— 那两步要覆盖全部 60 条，因为它们的产出是「每个大类的配比」，
 * 样本少了没有统计意义；1.2 要的是「这个账号最常用的 3 种类型及其原因」，看头部样本即可。
 * 这也是用户在 1.2 规格里明确写死的口径（正文写「前 20 条」）。
 */
export const PROFILE_SAMPLE_LIMIT = 20;

const parseDateMs = value => {
  const text = asText(value);
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isReviewCategory = category => asText(category?.name) === REVIEW_CATEGORY_NAME;

/** 1.2 的样本窗口：点赞最高的前 20 条。排序与归类口径复用 stageSampleWindow.js。 */
export const selectProfileVideos = (videos, limit = PROFILE_SAMPLE_LIMIT) =>
  selectStageVideos(videos, Math.min(Number(limit) || PROFILE_SAMPLE_LIMIT, PROFILE_SAMPLE_LIMIT));

const categoryNameForVideo = (videoId, categories) => {
  for (const category of Array.isArray(categories) ? categories : []) {
    if (category?.topics?.some(topic => asText(topic?.id) === asText(videoId))) return asText(category.name);
  }
  return REVIEW_CATEGORY_NAME;
};

/**
 * 高频标签：**后端直接从发布文案统计**，不采用模型给的词频。
 *
 * 抖音发布文案里的 `#话题` 是结构化信息，模型数的「出现频次」既不可核对也常算错，
 * 与 §6.3⑬「配比由后端按条数统计，模型只给原因」是同一条原则。
 *
 * ⚠️ 窗口口径：统计范围是**分类报告里那 60 条样本**，不是「最近三个月」。
 * 本阶段抓取口径就是「最新 60 条」（§6.1① 明确禁止恢复三个月规则），
 * 报告里必须如实写清窗口，不能假装是三个月全量。
 */
export const extractFrequentTags = (videos, limit = 8) => {
  const list = Array.isArray(videos) ? videos : [];
  const counts = new Map();
  for (const video of list) {
    const text = `${asText(video?.title)} ${asText(video?.sourceText)}`;
    // 同一条视频里重复刷同一个话题只算一次，否则「一条视频刷 10 遍标签」会污染排名。
    const seen = new Set();
    for (const match of text.matchAll(/#\s*([^#\s[\]，。、,]{1,30})/g)) {
      const tag = asText(match[1]);
      if (tag) seen.add(tag);
    }
    for (const tag of seen) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const max = Math.max(1, Math.min(Number(limit) || 8, 8));
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count, percentage: ratio(count, list.length) }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag))
    .slice(0, max);
};

/**
 * 发布时间与频率：同样由后端从 `publishDate` 实算。
 *
 * 注意只到**日**粒度 —— 分类报告里存的是发布日期的日期串，没有时刻。
 * 拿不到时刻时如实说明「时段无法从现有数据得出」，不要编一个「晚 8 点」出来。
 */
export const summarizePublishing = (videos) => {
  const list = Array.isArray(videos) ? videos : [];
  const stamps = list.map(video => parseDateMs(video?.publishDate)).filter(value => value > 0).sort((a, b) => a - b);
  const hasTimeOfDay = list.some(video => /\d{1,2}:\d{2}/.test(asText(video?.publishDate)));
  if (stamps.length === 0) {
    return {
      videoCount: list.length,
      datedCount: 0,
      spanDays: 0,
      perWeek: 0,
      weekdayDistribution: [],
      hasTimeOfDay: false,
      note: "样本里没有可解析的发布日期，发布频率待人工补充。",
    };
  }
  const earliest = stamps[0];
  const latest = stamps[stamps.length - 1];
  // +1 天：同一天发的两条，跨度应该是 1 天而不是 0，否则 perWeek 会除零/爆表。
  const spanDays = Math.max(1, Math.round((latest - earliest) / 86_400_000) + 1);
  const weekdayLabels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const weekdayCounts = new Array(7).fill(0);
  for (const stamp of stamps) weekdayCounts[new Date(stamp).getDay()] += 1;
  return {
    videoCount: list.length,
    datedCount: stamps.length,
    earliest: new Date(earliest).toISOString().slice(0, 10),
    latest: new Date(latest).toISOString().slice(0, 10),
    spanDays,
    perWeek: Math.round((stamps.length / (spanDays / 7)) * 10) / 10,
    weekdayDistribution: weekdayCounts
      .map((count, index) => ({ weekday: weekdayLabels[index], count }))
      .sort((left, right) => right.count - left.count),
    hasTimeOfDay,
    note: hasTimeOfDay
      ? "按样本的发布日期与时刻统计。"
      : "样本只带发布日期、不带时刻，具体发布时段待人工补充。",
  };
};

/** 供「引文是否真在输入里」核对用的全文索引。 */
const buildEvidenceHaystack = ({ account, videos, comments, categories, extra = [] }) => {
  const parts = [asText(account?.signature), asText(account?.name)];
  for (const video of Array.isArray(videos) ? videos : []) {
    parts.push(asText(video?.title), asText(video?.sourceText));
  }
  for (const comment of Array.isArray(comments) ? comments : []) {
    parts.push(asText(comment?.text));
  }
  for (const category of Array.isArray(categories) ? categories : []) {
    parts.push(asText(category?.coreFunction), ...(Array.isArray(category?.keywords) ? category.keywords : []));
  }
  // 真实粉丝画像的分布原文也算输入证据 —— 模型引用「男性 78.3%」时应当能核对上。
  for (const item of Array.isArray(extra) ? extra : []) parts.push(asText(item));
  return joinEvidenceParts(parts);
};

const buildThreeSecondsBlock = ({ agentOutput, input, transcripts }) => {
  const byId = new Map(input.videos.map(video => [video.videoId, video]));
  const rawItems = Array.isArray(agentOutput?.threeSeconds?.items)
    ? agentOutput.threeSeconds.items
    : Array.isArray(agentOutput?.threeSecondItems) ? agentOutput.threeSecondItems : [];
  const seen = new Set();
  const items = [];

  for (const rawItem of rawItems) {
    const videoId = asText(rawItem?.videoId || rawItem?.video_id || rawItem?.id);
    const source = byId.get(videoId);
    // 只接受输入里真实存在的样本，认不出的直接丢（§6.3⑪）。
    if (!source || seen.has(videoId)) continue;
    seen.add(videoId);
    const type = normalizeGoldThreeSecondType(rawItem?.type || rawItem?.primaryType);
    items.push({
      videoId,
      categoryName: source.categoryName,
      title: source.title,
      link: source.link,
      openingText: cleanText(rawItem?.openingText || rawItem?.opening_text || source.openingFallback, 160),
      openingSource: source.hasHeadTranscript ? "transcript" : "caption",
      type,
      typeLabel: GOLD_THREE_SECOND_TYPE_LABELS[type],
      evidence: cleanText(rawItem?.evidence || rawItem?.reason || "", 320),
      stats: source.stats,
    });
  }

  // 模型漏掉的样本补成「待人工复核」，但**不进配比**（它是人工待办队列，不是类型）。
  for (const source of input.videos) {
    if (seen.has(source.videoId)) continue;
    items.push({
      videoId: source.videoId,
      categoryName: source.categoryName,
      title: source.title,
      link: source.link,
      openingText: source.openingFallback,
      openingSource: source.hasHeadTranscript ? "transcript" : "caption",
      type: "review",
      typeLabel: GOLD_THREE_SECOND_TYPE_LABELS.review,
      evidence: "Agent 未返回该样本的稳定判断，保留人工复核。",
      stats: source.stats,
    });
  }

  const counts = new Map();
  for (const item of items) counts.set(item.type, (counts.get(item.type) || 0) + 1);
  // 8 个维度全部列出（没命中的计 0），否则用户没法确认到底是哪 8 个维度在参与分析。
  const typeDistribution = [
    ...GOLD_THREE_SECOND_DIMENSIONS.map(dimension => ({
      type: dimension.type,
      typeLabel: GOLD_THREE_SECOND_TYPE_LABELS[dimension.type],
      count: counts.get(dimension.type) || 0,
      percentage: ratio(counts.get(dimension.type) || 0, items.length),
    })),
    ...(counts.get("review") ? [{
      type: "review",
      typeLabel: GOLD_THREE_SECOND_TYPE_LABELS.review,
      count: counts.get("review"),
      percentage: ratio(counts.get("review"), items.length),
    }] : []),
  ].sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));

  // 「最常用的 3 种」只算真正命中过的，且**配比由后端按条数统计**，模型只提供原因。
  const rawTop = Array.isArray(agentOutput?.threeSeconds?.topTypes) ? agentOutput.threeSeconds.topTypes : [];
  const topTypes = typeDistribution
    .filter(item => item.type !== "review" && item.count > 0)
    .slice(0, 3)
    .map(item => {
      const matched = rawTop.find(entry => normalizeGoldThreeSecondType(entry?.type || entry?.name) === item.type);
      return { ...item, reason: cleanText(matched?.reason || matched?.explanation || "", 600) };
    });

  return {
    sampleLimit: PROFILE_SAMPLE_LIMIT,
    itemCount: items.length,
    items,
    typeDistribution,
    topTypes,
    // 4 个分析角度固定输出，缺哪个都会被前端如实显示为「待人工补充」。
    analysisReason: cleanText(agentOutput?.threeSeconds?.analysisReason || "", 1200),
    reasonAngles: normalizeReasonAngles(agentOutput?.threeSeconds?.reasonAngles),
    transcriptCoverage: {
      fromTranscript: items.filter(item => item.openingSource === "transcript").length,
      fromCaption: items.filter(item => item.openingSource === "caption").length,
      total: items.length,
    },
    dimensions: GOLD_THREE_SECOND_DIMENSIONS.map(item => ({
      ...item,
      label: GOLD_THREE_SECOND_TYPE_LABELS[item.type],
    })),
  };
};

/**
 * 三秒/结尾的「原因分析」固定按 4 个角度看（用户在 1.2 规格的图里给的口径）：
 * 账号定位、内容定位、人设定位、用户痛点。
 *
 * 这与 2.2/2.3 的口径**刻意相反** —— 那两步明确禁止从账号定位/人设定位/用户画像
 * 角度解释（见 HANDOFF §3.3(c)）。1.2 正是那个「上层模块」，所以这里要求必须给全。
 */
const REASON_ANGLE_KEYS = ["accountPositioning", "contentPositioning", "personaPositioning", "userPain"];
const REASON_ANGLE_LABELS = {
  accountPositioning: "账号定位",
  contentPositioning: "内容定位",
  personaPositioning: "人设定位",
  userPain: "用户痛点",
};

const normalizeReasonAngles = raw => {
  const source = raw && typeof raw === "object" ? raw : {};
  return REASON_ANGLE_KEYS.map(key => ({
    key,
    label: REASON_ANGLE_LABELS[key],
    text: cleanText(source[key] || source[REASON_ANGLE_LABELS[key]], 600),
  }));
};

const buildEndingHooksBlock = ({ agentOutput, input }) => {
  const byId = new Map(input.videos.map(video => [video.videoId, video]));
  const rawItems = Array.isArray(agentOutput?.endingHooks?.items)
    ? agentOutput.endingHooks.items
    : Array.isArray(agentOutput?.endingHookItems) ? agentOutput.endingHookItems : [];
  const seen = new Set();
  const items = [];

  for (const rawItem of rawItems) {
    const videoId = asText(rawItem?.videoId || rawItem?.video_id || rawItem?.id);
    const source = byId.get(videoId);
    if (!source || seen.has(videoId)) continue;
    seen.add(videoId);
    const type = normalizeEndingHookType(rawItem?.type);
    items.push({
      videoId,
      categoryName: source.categoryName,
      title: source.title,
      link: source.link,
      endingText: cleanText(rawItem?.endingText || rawItem?.ending_text || source.endingFallback, 200),
      endingSource: source.hasTailTranscript ? "transcript" : "caption",
      type,
      typeLabel: ENDING_HOOK_TYPE_LABELS[type],
      evidence: cleanText(rawItem?.evidence || rawItem?.reason || "", 320),
      stats: source.stats,
    });
  }

  for (const source of input.videos) {
    if (seen.has(source.videoId)) continue;
    items.push({
      videoId: source.videoId,
      categoryName: source.categoryName,
      title: source.title,
      link: source.link,
      endingText: source.endingFallback,
      endingSource: source.hasTailTranscript ? "transcript" : "caption",
      type: "review",
      typeLabel: ENDING_HOOK_TYPE_LABELS.review,
      evidence: "Agent 未返回该样本的稳定判断，保留人工复核。",
      stats: source.stats,
    });
  }

  const counts = new Map();
  for (const item of items) counts.set(item.type, (counts.get(item.type) || 0) + 1);
  const typeDistribution = [
    ...ENDING_HOOK_TYPES.map(definition => ({
      type: definition.type,
      typeLabel: ENDING_HOOK_TYPE_LABELS[definition.type],
      count: counts.get(definition.type) || 0,
      percentage: ratio(counts.get(definition.type) || 0, items.length),
    })),
    ...(counts.get("review") ? [{
      type: "review",
      typeLabel: ENDING_HOOK_TYPE_LABELS.review,
      count: counts.get("review"),
      percentage: ratio(counts.get("review"), items.length),
    }] : []),
  ].sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));

  const rawTop = Array.isArray(agentOutput?.endingHooks?.topTypes) ? agentOutput.endingHooks.topTypes : [];
  const topTypes = typeDistribution
    .filter(item => item.type !== "review" && item.count > 0)
    .slice(0, 3)
    .map(item => {
      const matched = rawTop.find(entry => normalizeEndingHookType(entry?.type || entry?.name) === item.type);
      return { ...item, reason: cleanText(matched?.reason || matched?.explanation || "", 600) };
    });

  return {
    sampleLimit: PROFILE_SAMPLE_LIMIT,
    itemCount: items.length,
    items,
    typeDistribution,
    topTypes,
    analysisReason: cleanText(agentOutput?.endingHooks?.analysisReason || "", 1200),
    reasonAngles: normalizeReasonAngles(agentOutput?.endingHooks?.reasonAngles),
    transcriptCoverage: {
      fromTranscript: items.filter(item => item.endingSource === "transcript").length,
      fromCaption: items.filter(item => item.endingSource === "caption").length,
      total: items.length,
    },
    types: ENDING_HOOK_TYPES.map(item => ({
      ...item,
      label: ENDING_HOOK_TYPE_LABELS[item.type],
    })),
  };
};

/** 用户画像里人口属性的固定字段。全部**永远输出**，没有依据就落 manual。 */
const DEMOGRAPHIC_FIELDS = [
  { key: "gender", label: "性别" },
  { key: "age", label: "年龄" },
  { key: "occupation", label: "职业/行业" },
  { key: "income", label: "收入水平" },
  { key: "consumption", label: "消费习惯" },
];

/**
 * 组装送给模型的输入。
 *
 * 只带点赞前 20 条（与三秒/结尾分析同一批样本），每条带上：
 * 分类报告给出的大类/小类、发布文案、开头转写、结尾转写、该视频的评论。
 */
export const buildBenchmarkProfileInput = (classificationReport, options = {}) => {
  const report = classificationReport && typeof classificationReport === "object" ? classificationReport : {};
  const headTranscripts = options?.headTranscripts instanceof Map ? options.headTranscripts : new Map();
  const tailTranscripts = options?.tailTranscripts instanceof Map ? options.tailTranscripts : new Map();
  const commentsByVideo = options?.commentsByVideo instanceof Map ? options.commentsByVideo : new Map();
  const limit = Math.min(Number(options?.limit) || PROFILE_SAMPLE_LIMIT, PROFILE_SAMPLE_LIMIT);

  const selectedVideos = selectProfileVideos(report.videos, limit);
  const categories = (Array.isArray(report.categories) ? report.categories : []).filter(category => !isReviewCategory(category));

  return {
    account: {
      name: asText(report.account?.name),
      url: asText(report.account?.url),
      platform: asText(report.account?.platform),
      platformLabel: asText(report.account?.platformLabel),
      // 简介是「商业定位」的唯一直接依据（用户规格：通过拆解简介进行分析）。
      // 旧分类报告里没有这个字段 —— 那时只能如实落 manual，不能靠模型猜。
      signature: cleanText(report.account?.signature, 1000),
      followerCount: asNumber(report.account?.followerCount),
    },
    contentStyle: report.contentStyle || "spoken",
    contentStyleLabel: asText(report.contentStyleLabel),
    classificationSummary: cleanText(report.summary, 800),
    categories: categories.map(category => ({
      name: asText(category?.name),
      coreFunction: cleanText(category?.coreFunction, 500),
      keywords: Array.isArray(category?.keywords) ? category.keywords.map(item => cleanText(item, 80)).filter(Boolean).slice(0, 12) : [],
      count: asNumber(category?.count),
      percentage: asNumber(category?.percentage),
      subcategories: (Array.isArray(category?.subcategories) ? category.subcategories : []).map(sub => ({
        name: asText(sub?.name),
        topics: (Array.isArray(sub?.topics) ? sub.topics : []).map(topic => asText(topic?.title)).filter(Boolean).slice(0, 20),
      })),
    })).filter(category => category.name),
    videos: selectedVideos.map(video => {
      const videoId = asText(video?.id);
      const head = headTranscripts.get(videoId);
      const tail = tailTranscripts.get(videoId);
      const comments = commentsByVideo.get(videoId) || [];
      const headText = cleanText(head?.text, 800);
      const tailText = cleanText(tail?.text, 800);
      return {
        videoId,
        categoryName: categoryNameForVideo(videoId, report.categories),
        title: cleanText(video?.title, 240),
        link: asText(video?.link),
        sourceText: cleanText(video?.sourceText, 900),
        publishDate: cleanText(video?.publishDate, 40),
        stats: video?.stats || {},
        ...(headText ? { openingTranscript: headText } : {}),
        ...(tailText ? { endingTranscript: tailText } : {}),
        // 评论是「用户画像」与「引流话术」的证据来源。只带有真实抓取结果的评论。
        ...(comments.length > 0
          ? { comments: comments.map(comment => cleanText(comment?.text, 200)).filter(Boolean).slice(0, 30) }
          : {}),
        // 下面这几个是给归一化用的内部字段。**默认不发给模型**（见 includeInternalFields）：
        // 提示词要求模型「有转写就必须从转写原文里取文案」，把已经算好的兜底文案一起塞过去，
        // 等于给它一条抄近路的捷径，会让它绕过转写原文。
        ...(options?.includeInternalFields ? {
          hasHeadTranscript: Boolean(headText),
          hasTailTranscript: Boolean(tailText),
          openingFallback: headText ? firstSentenceOf(headText) : firstSentenceOf(video?.sourceText) || cleanText(video?.title, 120),
          endingFallback: tailText ? lastSentenceOf(tailText) : lastSentenceOf(video?.sourceText) || cleanText(video?.title, 120),
        } : {}),
      };
    }),
    frequentTags: extractFrequentTags(report.videos),
    publishing: summarizePublishing(report.videos),
    // 真实粉丝画像分布（抖音热榜）。**这是用户画像里唯一的一手证据**，
    // 有它就不要再让模型凭空推断人口属性了。
    ...(Array.isArray(options?.fansPortrait?.dimensions) && options.fansPortrait.dimensions.length > 0
      ? {
        fansPortrait: options.fansPortrait.dimensions.map(dimension => ({
          label: dimension.label,
          specLabel: dimension.specLabel,
          dominant: dimension.dominant,
          items: dimension.items.slice(0, 8),
        })),
      }
      : {}),
  };
};

export const normalizeBenchmarkProfile = ({
  classificationReport,
  agentOutput = {},
  analysisSource = "agent",
  warnings = [],
  headTranscripts,
  tailTranscripts,
  commentsByVideo,
  // 真实粉丝画像（抖音热榜）。由端点从缓存读出来传进来，不由前端传入。
  fansPortrait,
  // 这份分类报告是「复用已保存的」还是「本次运行里现跑的」。
  // 1.2 现在允许直接分析新账号，此时会先跑一次分类（不落库）——
  // 报告里再写「复用模块 3 的产出」就是不实描述，必须如实区分。
  classificationSource,
} = {}) => {
  const input = buildBenchmarkProfileInput(classificationReport, {
    headTranscripts,
    tailTranscripts,
    commentsByVideo,
    fansPortrait,
    // 归一化需要 hasHeadTranscript / openingFallback 这类内部字段来判断来源与兜底文案。
    includeInternalFields: true,
  });
  const report = classificationReport && typeof classificationReport === "object" ? classificationReport : {};

  const allComments = [];
  for (const comments of commentsByVideo instanceof Map ? commentsByVideo.values() : []) {
    for (const comment of Array.isArray(comments) ? comments : []) allComments.push(comment);
  }
  const haystack = buildEvidenceHaystack({
    account: input.account,
    videos: input.videos,
    comments: allComments,
    categories: input.categories,
    extra: (Array.isArray(fansPortrait?.dimensions) ? fansPortrait.dimensions : []).map(describePortraitDimension),
  });

  // ── 一、商业定位 ───────────────────────────────────────────────────────
  const businessPositioning = {
    persona: normalizeBasisField({ raw: agentOutput?.businessPositioning?.persona, haystack }),
    corePain: normalizeBasisField({ raw: agentOutput?.businessPositioning?.corePain, haystack }),
    summary: cleanText(agentOutput?.businessPositioning?.summary, 800),
  };

  // ── 二、用户画像 ───────────────────────────────────────────────────────
  // **真实粉丝画像优先**：命中的字段直接用分布的结论，证据等级升为 evidence
  // （basis 就是那份分布原文，人工可以自己回查）。这正是把 HANDOFF §5 那条
  // 「不要输出没有数据依据的用户画像」从禁令变成**可满足的要求**。
  const portraitDemographics = buildDemographicsFromPortrait(fansPortrait);
  const rawDemographics = agentOutput?.userProfile?.demographics;
  const demographics = DEMOGRAPHIC_FIELDS.map(field => {
    const backed = portraitDemographics[field.key];
    if (backed) {
      return {
        key: field.key,
        label: field.label,
        text: backed.text,
        basis: backed.basis,
        level: "evidence",
        levelLabel: PROFILE_EVIDENCE_LEVELS.evidence,
        // 标明这一项的来源，前端可以据此区分「真实分布」与「模型推断」。
        source: "fans_portrait",
      };
    }
    const raw = Array.isArray(rawDemographics)
      ? rawDemographics.find(item => asText(item?.key) === field.key || asText(item?.label) === field.label)
      : rawDemographics?.[field.key];
    // 没有画像数据支撑时才退回旧的硬上限：最多 inference，没依据就 manual。
    // 职业/行业永远走这一支 —— 热榜画像里没有对应维度。
    const normalized = normalizeBasisField({ raw, haystack, levelCap: "inference", maxLength: 400 });
    return { key: field.key, label: field.label, ...normalized, source: "agent" };
  });

  const portraitDimensions = Array.isArray(fansPortrait?.dimensions) ? fansPortrait.dimensions : [];
  const fansPortraitBlock = {
    available: portraitDimensions.length > 0,
    reason: asText(fansPortrait?.reason),
    secUserId: asText(fansPortrait?.secUserId),
    fetchedAt: asText(fansPortrait?.fetchedAt),
    fromCache: Boolean(fansPortrait?.fromCache),
    dimensions: portraitDimensions,
    // 部分维度抓取失败时如实带出来，界面要能显示「哪几维没拿到」——
    // 只给成功的维度会让用户以为画像就这 5 项，而其实是 8 项里缺了 3 项。
    failed: Array.isArray(fansPortrait?.failed) ? fansPortrait.failed : [],
  };

  const userProfile = {
    demographics,
    pains: normalizeBasisField({ raw: agentOutput?.userProfile?.pains, haystack }),
    goals: normalizeBasisField({ raw: agentOutput?.userProfile?.goals, haystack }),
    // 「用户行为 / 原因 / 举例」表。项目里没有行为埋点数据，行为与原因都是模型推断，
    // 所以等级上限是 inference —— 只有举例引用了真实评论或发布文案，basis 才能通过核对。
    behaviors: (Array.isArray(agentOutput?.userProfile?.behaviors) ? agentOutput.userProfile.behaviors : [])
      .slice(0, 12)
      .map(item => {
        const behavior = cleanText(item?.behavior, 120);
        const reason = cleanText(item?.reason, 400);
        const example = cleanText(item?.example, 400);
        const graded = normalizeBasisField({
          raw: item,
          haystack,
          fallbackText: [behavior, reason, example].filter(Boolean).join(" "),
          maxLength: 600,
          levelCap: "inference",
        });
        return { behavior, reason, example, basis: graded.basis, level: graded.level, levelLabel: graded.levelLabel };
      })
      .filter(item => item.behavior || item.reason),
    // 真实粉丝画像分布（抖音热榜）。available 为 false 时前端要如实说明原因，
    // 而不是把这一节藏起来 —— 用户得知道「为什么这里只有推断」。
    fansPortrait: fansPortraitBlock,
    // 数据来源说明：让项目经理一眼看出这一节的证据基础是什么。
    dataSources: {
      hasComments: allComments.length > 0,
      commentCount: allComments.length,
      hasSignature: Boolean(input.account.signature),
      // 真实粉丝画像是否拿到。拿到了，人口属性就是「输入证据」而不是推断。
      hasPortraitData: fansPortraitBlock.available,
      portraitDimensionCount: portraitDimensions.length,
      // 旧字段名保留：早期前端按它渲染说明文案，突然删掉会读到 undefined。
      platformPortraitAvailable: fansPortraitBlock.available,
      note: fansPortraitBlock.available
        ? `用户画像的人口属性来自抖音热榜的真实粉丝画像分布（${portraitDimensions.length} 个维度，抓取于 ${fansPortraitBlock.fetchedAt ? new Date(fansPortraitBlock.fetchedAt).toLocaleDateString("zh-CN") : "未知时间"}）；痛点、目标与用户行为结合账号简介和评论区推断。`
        : allComments.length > 0
          ? "评论区已抓取，用户画像基于账号简介、评论区真实评论与视频互动数据推断；未取到粉丝画像分布，人口属性为推断或待人工补充。"
          : "评论区与粉丝画像都没有取到，用户画像只能基于账号简介与视频内容推断，人口属性待人工补充。",
    },
  };

  // ── 三、内容定位（复用 2.1 分类 + 本模块自己的前 20 条三秒/结尾分析）────────
  const contentPositioning = {
    classification: {
      // 如实说明这份分类结果是怎么来的：复用已保存的报告，还是本次运行里现跑的一次。
      source: classificationSource === "fresh"
        ? "本次运行中先跑了一次分类分析（未落库）"
        : "复用模块 3 的 2.1 分类分析产出",
      contentStyle: report.contentStyle || "spoken",
      contentStyleLabel: asText(report.contentStyleLabel),
      analyzedCount: asNumber(report.analyzedCount),
      sampleWindow: asText(report.sampleWindow),
      summary: cleanText(report.summary, 800),
      categories: input.categories,
    },
    threeSeconds: buildThreeSecondsBlock({ agentOutput, input, transcripts: headTranscripts }),
    endingHooks: buildEndingHooksBlock({ agentOutput, input }),
    sampleRule: `三秒与结尾分析只取点赞最高的前 ${PROFILE_SAMPLE_LIMIT} 条。`,
  };

  // ── 四、运营策略 ───────────────────────────────────────────────────────
  const rawProducts = Array.isArray(agentOutput?.operationStrategy?.monetization?.products)
    ? agentOutput.operationStrategy.monetization.products
    : [];
  const monetizationProducts = rawProducts.slice(0, 10).map(item => {
    const tier = cleanText(item?.tier, 40);
    const product = cleanText(item?.product, 160);
    const positioning = cleanText(item?.positioning, 400);
    const role = cleanText(item?.role, 400);
    const price = normalizePrice(item?.price, haystack);
    const graded = normalizeBasisField({
      raw: item,
      haystack,
      fallbackText: [product, positioning, role].filter(Boolean).join(" "),
      maxLength: 600,
      // 定价没有输入依据时不许标 evidence —— 价格另由 normalizePrice 校验。
      levelCap: price.grounded ? "evidence" : "inference",
    });
    // 价格能在输入里核对上时，这一行整体算「输入证据」（产品与定价都有依据）；
    // 否则最多是推断，绝不能拿一个编造的价位去冒充调研结论。
    const level = price.grounded ? "evidence" : graded.level;
    return {
      tier,
      product,
      price: price.price,
      priceNote: price.price ? "" : "输入中没有定价依据，待人工补充",
      positioning,
      role,
      level,
      levelLabel: PROFILE_EVIDENCE_LEVELS[level],
      basis: graded.basis,
    };
  });

  const operationStrategy = {
    publishing: {
      ...input.publishing,
      level: input.publishing.datedCount > 0 ? "evidence" : "manual",
      levelLabel: PROFILE_EVIDENCE_LEVELS[input.publishing.datedCount > 0 ? "evidence" : "manual"],
      analysis: cleanText(agentOutput?.operationStrategy?.publishing?.analysis, 800),
    },
    trafficScripts: {
      bio: normalizeBasisField({ raw: agentOutput?.operationStrategy?.trafficScripts?.bio, haystack }),
      comments: normalizeBasisField({ raw: agentOutput?.operationStrategy?.trafficScripts?.comments, haystack }),
    },
    monetization: {
      products: monetizationProducts,
      path: (Array.isArray(agentOutput?.operationStrategy?.monetization?.path)
        ? agentOutput.operationStrategy.monetization.path
        : []
      ).slice(0, 8).map((item, index) => ({
        step: asNumber(item?.step) || index + 1,
        description: cleanText(item?.description || item?.text, 400),
      })).filter(item => item.description),
      note: cleanText(agentOutput?.operationStrategy?.monetization?.note, 600),
    },
  };

  const headHits = input.videos.filter(video => video.openingTranscript).length;
  const tailHits = input.videos.filter(video => video.endingTranscript).length;
  const videosWithComments = input.videos.filter(video => Array.isArray(video.comments) && video.comments.length > 0).length;

  return {
    version: "1.0",
    reportType: "benchmark_profile",
    account: { ...input.account },
    contentStyle: input.contentStyle,
    contentStyleLabel: input.contentStyleLabel,
    classificationReportType: asText(report.reportType) || "benchmark_classification",
    // 样本口径如实写清：1.2 的占比与标签统计都基于分类报告那 60 条，不是「最近三个月」。
    sampleWindow: {
      classificationSampleCount: asNumber(report.analyzedCount),
      classificationSampleRule: asText(report.sampleWindow),
      profileSampleLimit: PROFILE_SAMPLE_LIMIT,
      profileSampleCount: input.videos.length,
      profileSampleRule: `三秒与结尾分析取点赞最高的前 ${PROFILE_SAMPLE_LIMIT} 条。`,
      tagWindowNote: `高频标签基于分类报告的 ${asNumber(report.analyzedCount) || 0} 条样本统计（最新作品口径，非自然三个月）。`,
    },
    businessPositioning,
    userProfile,
    contentPositioning,
    frequentTags: input.frequentTags,
    operationStrategy,
    dataCoverage: {
      profileSampleCount: input.videos.length,
      headTranscriptCount: headHits,
      tailTranscriptCount: tailHits,
      videosWithComments,
      commentCount: allComments.length,
    },
    analysisSource,
    warnings: Array.isArray(warnings) ? warnings : [],
    analyzedAt: new Date().toISOString(),
  };
};

/**
 * 规则兜底：Agent 不可用时也要给出一份**诚实**的报告 ——
 * 能算的照算（标签、发布频率、样本清单），不能算的一律落「待人工补充」。
 */
export const buildHeuristicBenchmarkProfile = (classificationReport) => ({
  businessPositioning: {
    persona: { text: "", level: "manual" },
    corePain: { text: "", level: "manual" },
    summary: "Agent 暂时不可用，商业定位待人工补充。",
  },
  userProfile: {
    demographics: [],
    pains: { text: "", level: "manual" },
    goals: { text: "", level: "manual" },
    behaviors: [],
  },
  threeSeconds: { items: [], topTypes: [], analysisReason: "", reasonAngles: [] },
  endingHooks: { items: [], topTypes: [], analysisReason: "", reasonAngles: [] },
  operationStrategy: {
    publishing: { analysis: "" },
    trafficScripts: { bio: { text: "", level: "manual" }, comments: { text: "", level: "manual" } },
    monetization: { products: [], path: [], note: "" },
  },
});
