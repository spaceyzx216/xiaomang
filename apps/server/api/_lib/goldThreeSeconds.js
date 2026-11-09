import { REVIEW_CATEGORY_ID, REVIEW_CATEGORY_NAME } from "./benchmarkAnalysis.js";
import { MAX_STAGE_VIDEOS, categoryForVideo as categoryForStageVideo, selectStageVideos } from "./stageSampleWindow.js";
import { buildCategoryTypeBreakdown } from "./categoryTypeBreakdown.js";

// 样本窗口（取多少条 / 怎么排序 / 归到哪个大类）与 2.3 结尾钩子共用同一份实现，
// 见 stageSampleWindow.js —— 两个子步骤必须吃同一批样本，否则大类配比没法互相印证。
const MAX_GOLD_VIDEOS = MAX_STAGE_VIDEOS;

/**
 * 黄金三秒的 8 个分析维度。
 *
 * **定义放在这里一份**，同时喂给提示词和前端展示 —— 保证「模型按什么标准判」和
 * 「用户看到的定义」是同一套，不会两边各写一遍然后漂移。
 *
 * 2026-09-17 曾把「反差」临时换成「需求」，用户随后确认**要反差、不要需求**，已换回。
 * 别再改这一个维度 —— 判定口径和例句是照用户给的原话写的，只有「反差」那条是补写的。
 */
export const GOLD_THREE_SECOND_DIMENSIONS = [
  { type: "curiosity", definition: "制造疑问、反常、留白", example: "我敢说 90% 的人都做错了", strength: "强" },
  { type: "fear", definition: "点出风险、损失、隐患", example: "不防晒脸会老得比同龄人快 10 岁", strength: "中" },
  { type: "anger", definition: "戳中不公、憋屈、被坑等愤慨情绪", example: "这破规则坑了多少人", strength: "强" },
  { type: "contrast", definition: "打破预期、认知反转", example: "都以为要赔钱，其实一分不用", strength: "强" },
  { type: "pain", definition: "命中麻烦、困扰、低效问题", example: "厨房油污擦不干净？", strength: "强" },
  { type: "interest", definition: "贴合爱好、热门话题", example: "养猫人必看的 6 个冷知识", strength: "中" },
  { type: "knowledge", definition: "明确可学技巧、干货", example: "3 个步骤轻松搞定房贷", strength: "强" },
  { type: "desire", definition: "指向美好结果、稀缺资源、优越感", example: "月入过万的副业秘密", strength: "强" },
];

// 类型集合直接从维度定义推导，避免两边各维护一份然后对不上。
export const GOLD_THREE_SECOND_TYPES = GOLD_THREE_SECOND_DIMENSIONS.map(item => item.type);

export const GOLD_THREE_SECOND_TYPE_LABELS = {
  curiosity: "好奇心",
  fear: "恐惧",
  anger: "愤怒",
  contrast: "反差",
  pain: "痛点",
  interest: "兴趣",
  knowledge: "求知欲",
  desire: "欲望",
  review: "待人工复核",
};

const TYPE_ALIASES = {
  curiosity: "curiosity",
  "好奇": "curiosity",
  "好奇心": "curiosity",
  fear: "fear",
  "恐惧": "fear",
  anger: "anger",
  "愤怒": "anger",
  contrast: "contrast",
  "反差": "contrast",
  pain: "pain",
  "痛点": "pain",
  interest: "interest",
  "兴趣": "interest",
  knowledge: "knowledge",
  "求知欲": "knowledge",
  desire: "desire",
  "欲望": "desire",
  review: "review",
  "待人工复核": "review",
  // 「需求」只在 2026-09-17 短暂存在过一天，用户已确认不要它。
  // 留成别名映射到 contrast，避免那期间产生的报告静默掉进「待人工复核」。
  needs: "contrast",
  "需求": "contrast",
};

const asText = (value, fallback = "") => String(value ?? fallback).trim();

const asNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

const cleanText = (value, maxLength = 900) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

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

const normalizeType = value => {
  const key = asText(value).toLowerCase();
  return TYPE_ALIASES[key] || "review";
};

/**
 * 类型归一化单独导出，给模块 1「对标账号分析」复用。
 *
 * 1.2 的三秒分析与 2.2 看的是同一套 8 个维度，别名表必须共用一份 ——
 * 各写一份的结果就是「模型回『反差』，一边认、一边掉进待人工复核」（§6.3⑫）。
 */
export const normalizeGoldThreeSecondType = normalizeType;

const CONFIDENCE_ALIASES = {
  high: "high", "高": "high", "高置信度": "high",
  medium: "medium", "中": "medium", "中等": "medium", "中置信度": "medium",
  low: "low", "低": "low", "低置信度": "low",
};

// 提示词和输出 schema 都处在中文语境，模型很自然地会回「高 / 中 / 低」。
// 只认英文白名单会把模型的「低」静默升级成默认值；识别不了时一律落到 low：
// 证据不足时给出比规则降级路径更高的置信度，是不诚实的。
const normalizeConfidence = (value, fallback = "low") => CONFIDENCE_ALIASES[asText(value).toLowerCase()] || fallback;

const isReviewCategory = category => (
  asText(category?.id) === REVIEW_CATEGORY_ID || asText(category?.name) === REVIEW_CATEGORY_NAME
);

// 取样口径必须如实反映分类阶段实际使用的抓取方式：
// 走时间窗口抓取时，报告里再写「最新 60 条」就是把口径报错了。
//
// 2026-09-17：不再挑前 20 条，分类报告里的样本**全部**纳入分析，
// 这样每个内容大类都有足够样本算配比。所以这里只说「全部」，不再提点赞优先。
const sampleRuleFor = fetchMode => (
  asText(fetchMode).toLowerCase() === "recent"
    ? "分类报告的时间窗口样本全部纳入分析。"
    : "最新 60 条样本全部纳入分析。"
);

const firstSentence = value => {
  const text = cleanText(value, 240);
  if (!text) return "";
  const sentence = text.split(/(?<=[。！？!?])|[\r\n]+/).map(item => item.trim()).find(Boolean);
  return (sentence || text).slice(0, 120);
};

/** 「取首句」的口径导出给模块 1 复用（1.2 没有转写时也要从发布文案取开场兜底）。 */
export const firstSentenceOf = firstSentence;

// 比对时先去掉空白和标点：模型复述转写时标点和断句几乎不可能和原文完全一致。
const stripForMatch = value => asText(value).replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】[\]…—-]/g, "");

// 模型自称「引用了转写」不算数，要真的能在转写原文里找到这句话。
// 与项目其它地方一致：不信任 Agent 的自我声明，只认能回到输入核对的证据。
const quotedFromTranscript = (openingText, transcript) => {
  const needle = stripForMatch(openingText);
  if (!needle) return false;
  return stripForMatch(transcript).includes(needle);
};

/**
 * 决定一条样本的「开场 3 秒」从哪来、算多可信。
 *
 *  1. 有真实转写，且模型引用了它 → transcript，用模型自评置信度（认不出时 medium）
 *  2. 有真实转写但模型没给文案 → 取转写首句兜底，仍是 transcript / medium
 *     （转写首句就是开场，比发布文案可靠得多，不该压到 low）
 *  3. 没有转写 → 只能靠发布文案，沿用原规则：模型没给就强制 low
 */
const resolveOpening = ({ rawOpeningText, rawConfidence, hasTranscript, transcriptText, sourceText }) => {
  // 1. 有转写，且模型确实引用了它 —— 最可信的情况
  if (hasTranscript && rawOpeningText && quotedFromTranscript(rawOpeningText, transcriptText)) {
    return {
      openingText: cleanText(rawOpeningText, 160),
      openingSource: "transcript",
      confidence: normalizeConfidence(rawConfidence, "medium"),
    };
  }
  // 2. 有转写但模型没给文案 —— 转写首句就是真实开场，比发布文案可靠得多，给 medium
  if (hasTranscript && !rawOpeningText) {
    return {
      openingText: cleanText(firstSentence(transcriptText), 160),
      openingSource: "transcript",
      confidence: "medium",
    };
  }
  // 3. 有转写，但模型给的文案不在转写里 —— 它违背了「有转写必须引用转写」的要求，
  //    实际用的是发布文案。来源如实标 caption，置信度压到 low，不采信它的自评。
  if (hasTranscript) {
    return {
      openingText: cleanText(rawOpeningText || firstSentence(sourceText), 160),
      openingSource: "caption",
      confidence: "low",
    };
  }
  // 4. 没有转写：沿用原规则。模型给了文案就沿用它的自评；没给就用发布文案兜底并强制 low ——
  //    那只是发布文案、不是真实开场，即使模型标了 high 也不能当真。
  return {
    openingText: cleanText(rawOpeningText || firstSentence(sourceText), 160),
    openingSource: "caption",
    confidence: rawOpeningText ? normalizeConfidence(rawConfidence) : "low",
  };
};

/** 保留这个名字：测试、转写编排、2.3 都按它引用；实现在共用的 stageSampleWindow.js。 */
export const selectGoldThreeSecondVideos = selectStageVideos;

const categoryForVideo = (videoId, categories) => categoryForStageVideo(videoId, categories, REVIEW_CATEGORY_NAME);

export const buildGoldThreeSecondsInput = (classificationReport, options = {}) => {
  const report = classificationReport && typeof classificationReport === "object" ? classificationReport : {};
  const limit = Number(options?.limit) || MAX_GOLD_VIDEOS;
  // 真实口播转写（ASR / 豆包视频理解）。没有转写的样本仍按发布文案处理，
  // 提示词要求模型对这类样本把 confidence 压到 low。
  const transcripts = options?.transcripts instanceof Map ? options.transcripts : new Map();
  const selectedVideos = selectGoldThreeSecondVideos(report.videos, limit);
  return {
    account: report.account || {},
    contentStyle: report.contentStyle || "spoken",
    classificationSummary: asText(report.summary),
    // 「待人工复核」是人工待办队列，不是真实内容主题：它既不能作为内容大类送给模型，
    // 也不能出现在三秒阶段的推荐配比里。落到这个队列的样本本身仍然保留在 videos 中，
    // 并照常通过 categoryForVideo 标注为待复核。
    categories: (Array.isArray(report.categories) ? report.categories : [])
      .filter(category => !isReviewCategory(category))
      .map(category => ({
        name: asText(category?.name),
        coreFunction: cleanText(category?.coreFunction, 500),
        keywords: Array.isArray(category?.keywords) ? category.keywords.map(item => cleanText(item, 80)).filter(Boolean).slice(0, 12) : [],
      }))
      .filter(category => category.name),
    videos: selectedVideos.map(video => {
      const videoId = asText(video?.id);
      const transcript = transcripts.get(videoId);
      // 只要开场，不需要整条口播。正常路径下转写本来就只有开头几秒（几十字），
      // 这里主要是给「开头没人声 → 回退完整转写」那条路径兜底：60 条样本都要进同一个
      // prompt，每条塞 3000 字会把请求撑到没有必要的大。
      const transcriptText = cleanText(transcript?.text, 800);
      return {
        videoId,
        categoryName: categoryForVideo(videoId, report.categories),
        title: cleanText(video?.title, 240),
        link: asText(video?.link),
        sourceText: cleanText(video?.sourceText, 900),
        // 有真实口播时带上原文；模型必须从这里取开场 3 秒，不能再靠发布文案猜。
        ...(transcriptText ? { transcript: transcriptText, transcriptProvider: asText(transcript?.provider) } : {}),
        publishDate: cleanText(video?.publishDate, 40),
        stats: video?.stats || {},
      };
    }),
  };
};

const countTypes = items => {
  const counts = new Map();
  for (const item of items) {
    const type = normalizeType(item?.type || item?.primaryType || item?.primary_type);
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return counts;
};

/** 保留本地别名：占比与配比都走共用的 categoryTypeBreakdown.js（2.3 结尾钩子用同一份）。 */
const ratio = (count, total) => (total > 0 ? Math.round((count / total) * 1000) / 10 : 0);

const buildCategoryBreakdown = ({ items, inputCategories, categoryReasons }) => buildCategoryTypeBreakdown({
  items,
  inputCategories,
  categoryReasons,
  typeLabels: GOLD_THREE_SECOND_TYPE_LABELS,
  normalizeType,
  isReviewCategory,
  reviewCategoryName: REVIEW_CATEGORY_NAME,
});

export const normalizeGoldThreeSeconds = ({ classificationReport, agentOutput = {}, analysisSource = "agent", warnings = [], transcripts } = {}) => {
  const input = buildGoldThreeSecondsInput(classificationReport, { transcripts });
  const sourceVideos = input.videos;
  const byId = new Map(sourceVideos.map(video => [video.videoId, video]));
  const rawItems = Array.isArray(agentOutput?.items)
    ? agentOutput.items
    : Array.isArray(agentOutput?.videos) ? agentOutput.videos : [];
  const seen = new Set();
  const items = [];

  for (const rawItem of rawItems) {
    const videoId = asText(rawItem?.videoId || rawItem?.video_id || rawItem?.id);
    const source = byId.get(videoId);
    if (!source || seen.has(videoId)) continue;
    seen.add(videoId);
    const type = normalizeType(rawItem?.type || rawItem?.primaryType || rawItem?.primary_type);
    const transcriptText = asText(source.transcript);
    const hasTranscript = Boolean(transcriptText);
    const opening = resolveOpening({
      rawOpeningText: asText(rawItem?.openingText || rawItem?.opening_text || rawItem?.opening),
      rawConfidence: rawItem?.confidence,
      hasTranscript,
      transcriptText,
      sourceText: source.sourceText,
    });
    items.push({
      videoId,
      categoryName: source.categoryName,
      title: source.title,
      ...opening,
      transcriptProvider: hasTranscript ? asText(source.transcriptProvider) : "",
      type,
      typeLabel: GOLD_THREE_SECOND_TYPE_LABELS[type],
      evidence: cleanText(rawItem?.evidence || rawItem?.reason || "", 320),
      stats: source.stats,
      link: source.link,
    });
  }

  for (const source of sourceVideos) {
    if (seen.has(source.videoId)) continue;
    const transcriptText = asText(source.transcript);
    const hasTranscript = Boolean(transcriptText);
    items.push({
      videoId: source.videoId,
      categoryName: source.categoryName,
      title: source.title,
      openingText: firstSentence(hasTranscript ? transcriptText : source.sourceText) || "未返回可提取的开场文案",
      openingSource: hasTranscript ? "transcript" : "caption",
      transcriptProvider: hasTranscript ? asText(source.transcriptProvider) : "",
      type: "review",
      typeLabel: GOLD_THREE_SECOND_TYPE_LABELS.review,
      evidence: "Agent 未返回该样本的稳定判断，保留人工复核。",
      confidence: "low",
      stats: source.stats,
      link: source.link,
    });
  }

  const counts = countTypes(items);
  // 8 个维度**全部列出**，没命中的计 0。
  // 只列出现过的类型时，界面上永远只能看到「这次碰巧命中过的 4~5 个」，
  // 用户没法确认到底是哪 8 个维度在参与分析 —— 这正是「怎么只有 4~5 个」的来源。
  const typeDistribution = [
    ...GOLD_THREE_SECOND_TYPES.map(type => ({
      type,
      typeLabel: GOLD_THREE_SECOND_TYPE_LABELS[type],
      count: counts.get(type) || 0,
      percentage: ratio(counts.get(type) || 0, items.length),
    })),
    ...(counts.get("review") ? [{
      type: "review",
      typeLabel: GOLD_THREE_SECOND_TYPE_LABELS.review,
      count: counts.get("review"),
      percentage: ratio(counts.get("review"), items.length),
    }] : []),
  ].sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
  // 「最常用的 3 种」只算真正命中过的：计 0 的维度不能被当成「常用」列出来。
  const topTypes = typeDistribution
    .filter(item => item.type !== "review" && item.count > 0)
    .slice(0, 3)
    .map(item => {
      const rawReason = (Array.isArray(agentOutput?.topTypes) ? agentOutput.topTypes : [])
        .find(reason => normalizeType(reason?.type || reason?.name) === item.type);
      return {
        ...item,
        reason: cleanText(rawReason?.reason || rawReason?.explanation || `该类型在本次高互动样本中出现 ${item.count} 次，建议结合各大类的核心功能复核。`, 420),
      };
    });
  const categoryBreakdown = buildCategoryBreakdown({
    items,
    inputCategories: input.categories,
    categoryReasons: agentOutput?.categoryReasons || agentOutput?.category_reasons,
  });

  return {
    version: "1.0",
    reportType: "gold_three_seconds",
    account: classificationReport?.account || {},
    contentStyle: classificationReport?.contentStyle || "spoken",
    classificationReportType: classificationReport?.reportType || "benchmark_classification",
    sampleRule: sampleRuleFor(classificationReport?.fetchMode),
    analyzedCount: items.length,
    sourceVideoCount: sourceVideos.length,
    items,
    // 有多少条样本的开场文案真的来自转写（而不是发布文案推断）。
    // 前端据此告诉用户这份报告的可信度基础，别让人对着猜测出来的开场当下结论。
    transcriptCoverage: {
      fromTranscript: items.filter(item => item.openingSource === "transcript").length,
      fromCaption: items.filter(item => item.openingSource === "caption").length,
      total: items.length,
    },
    // 8 个维度的口径随报告一起返回，前端直接渲染。
    // 刻意不让前端再维护一份定义 —— 两边各写一份正是「维度集对不上」的成因。
    // 缺这个字段的是旧报告，前端会退回只显示分布。
    dimensions: GOLD_THREE_SECOND_DIMENSIONS.map(item => ({
      ...item,
      label: GOLD_THREE_SECOND_TYPE_LABELS[item.type],
    })),
    typeDistribution,
    topTypes,
    // 按大类的三秒维度配比。**配比是后端按每条样本的 type 实际统计的**，
    // 模型只提供原因解释。这是本阶段的主结构：账号 → 大类 → 3s维度/配比/原因。
    categoryBreakdown,
    accountSummary: cleanText(agentOutput?.accountSummary || agentOutput?.summary || "", 800),
    analysisReason: cleanText(agentOutput?.analysisReason || agentOutput?.overallReason || "", 900),
    analysisSource,
    warnings: Array.isArray(warnings) ? warnings : [],
    analyzedAt: new Date().toISOString(),
  };
};

const fallbackType = text => {
  const value = asText(text).toLowerCase();
  const rules = [
    ["fear", ["赔偿", "风险", "违法", "损失", "后果", "千万别", "小心"]],
    ["anger", ["拒绝", "欺骗", "不公平", "离谱", "竟然", "还敢", "坑了"]],
    ["contrast", ["不是", "却", "原来", "没想到", "误区", "真相", "以为"]],
    ["pain", ["痛点", "问题", "不会", "难", "踩坑", "怎么办", "擦不干净", "搞不定"]],
    ["knowledge", ["为什么", "如何", "怎么", "方法", "步骤", "规则", "教你"]],
    ["desire", ["省钱", "赚钱", "月入", "变美", "提升", "快速", "最好", "秘密"]],
    ["interest", ["实测", "体验", "推荐", "分享", "案例", "冷知识"]],
  ];
  const match = rules.find(([, keywords]) => keywords.some(keyword => value.includes(keyword)));
  return match?.[0] || "curiosity";
};

export const buildHeuristicGoldThreeSeconds = (classificationReport) => {
  const input = buildGoldThreeSecondsInput(classificationReport);
  const items = input.videos.map(video => ({
    videoId: video.videoId,
    openingText: firstSentence(video.sourceText) || video.title,
    type: fallbackType(`${video.title} ${video.sourceText}`),
    evidence: "基于标题与平台返回文案的规则初步判断，建议结合完整脚本复核。",
    confidence: "low",
  }));
  return {
    accountSummary: "当前使用标题与平台返回文案完成黄金三秒的初步提取与分类，完整脚本不足的样本需人工复核。",
    analysisReason: "优先观察开场是否制造损失预期、冲突反差、直接痛点或求知缺口，再结合账号的内容大类判断适配性。",
    items,
    topTypes: [],
    // 配比由后端从样本统计，模型只需要给原因；规则兜底给不出原因，留空。
    categoryReasons: [],
  };
};

export const goldThreeSecondTypeLabels = GOLD_THREE_SECOND_TYPE_LABELS;
export const MAX_GOLD_THREE_SECOND_VIDEOS = MAX_GOLD_VIDEOS;
