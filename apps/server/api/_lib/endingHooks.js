import { REVIEW_CATEGORY_ID, REVIEW_CATEGORY_NAME } from "./benchmarkAnalysis.js";
import { MAX_STAGE_VIDEOS, categoryForVideo, selectStageVideos } from "./stageSampleWindow.js";
import { buildCategoryTypeBreakdown, buildTypeDistribution } from "./categoryTypeBreakdown.js";

/**
 * 2.3 结尾钩子库分析的核心：类型定义 + 输入组装 + 后端归一化 + 规则兜底。
 *
 * 和 2.2 黄金三秒同构，但**看的是视频的结尾**而不是开头 —— 转写取的是最后几秒
 * （`scope = "tail"`，ffmpeg `-sseof`，见 goldThreeSecondTranscripts.js）。
 *
 * ⚠️ **结尾类型清单的来源**：2026-09-17 用户给定的口径是
 * 「引导互动、引导转化、反转、金句、共鸣＋IP符号（口头禅）」。**这里只写一份**，
 * 提示词从它生成、前端从报告的 `types` 字段读 —— 别在任何地方再抄一遍
 * （2.2 曾经因为两处各写一份导致提示词里写「反差」而别处写「需求」）。
 */

/**
 * 结尾钩子的 5 个类型。
 *
 * `definition` 是判定口径，`example` 是例句，`strength` 是该类型常见的钩子力度。
 * 提示词、报告、前端展示全部从这里派生。
 */
export const ENDING_HOOK_TYPES = [
  {
    type: "interaction",
    definition: "结尾明确引导观众互动：点赞、评论、转发、收藏、提问或投票",
    example: "你们公司有没有遇到过这种情况？评论区告诉我",
    strength: "中",
  },
  {
    type: "conversion",
    definition: "结尾引导转化动作：私信、咨询、留资、加微信、下单或领取资料",
    example: "遇到这种情况别自己扛，私信我帮你看一眼",
    strength: "强",
  },
  {
    type: "twist",
    definition: "结尾给出与前面预期相反的结果、判断或身份反转",
    example: "结果仲裁下来，公司一分钱都不用赔",
    strength: "强",
  },
  {
    type: "punchline",
    definition: "用一句高度凝练、可被单独摘出来传播的话收尾",
    example: "员工签字，比民主程序更重要",
    strength: "强",
  },
  {
    type: "resonance_ip",
    definition: "用共情式总结收尾，并带上账号固定的口头禅或标志性说法（IP 符号）",
    example: "老板不容易，我是夏律师，只讲老板用得上的用工知识",
    strength: "中",
  },
];

export const ENDING_HOOK_TYPE_LABELS = {
  interaction: "引导互动",
  conversion: "引导转化",
  twist: "反转",
  punchline: "金句",
  resonance_ip: "共鸣＋IP符号",
  review: "待人工复核",
};

/** 类型集合直接从定义推导，避免两边各维护一份然后对不上。 */
export const ENDING_HOOK_TYPE_KEYS = ENDING_HOOK_TYPES.map(item => item.type);

/**
 * 模型可能回中文、英文 key 或近义说法，统一映射到规范 key。
 * 认不出的落到 review（待人工复核），**不猜**。
 */
const TYPE_ALIASES = {
  interaction: "interaction",
  engage: "interaction",
  cta_interaction: "interaction",
  引导互动: "interaction",
  互动: "interaction",
  引导评论: "interaction",
  引导点赞: "interaction",

  conversion: "conversion",
  convert: "conversion",
  cta_conversion: "conversion",
  引导转化: "conversion",
  转化: "conversion",
  引导私信: "conversion",
  引导咨询: "conversion",
  引流: "conversion",

  twist: "twist",
  reversal: "twist",
  反转: "twist",
  反转型: "twist",
  认知反转: "twist",

  punchline: "punchline",
  quote: "punchline",
  金句: "punchline",
  金句收尾: "punchline",
  一句话总结: "punchline",

  resonance_ip: "resonance_ip",
  resonanceip: "resonance_ip",
  resonance: "resonance_ip",
  ip: "resonance_ip",
  共鸣: "resonance_ip",
  共鸣ip: "resonance_ip",
  "共鸣+ip符号": "resonance_ip",
  "共鸣＋ip符号": "resonance_ip",
  ip符号: "resonance_ip",
  口头禅: "resonance_ip",

  review: "review",
  待人工复核: "review",
  待复核: "review",
};

const CONFIDENCE_ALIASES = {
  high: "high",
  高: "high",
  高置信度: "high",
  medium: "medium",
  mid: "medium",
  中: "medium",
  中置信度: "medium",
  low: "low",
  低: "low",
  低置信度: "low",
};

const asText = value => String(value ?? "").trim();

const asNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

const cleanText = (value, maxLength = 900) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

const ratio = (count, total) => (total > 0 ? Math.round((count / total) * 1000) / 10 : 0);

const normalizeType = value => {
  const key = asText(value).toLowerCase().replace(/\s+/g, "");
  return TYPE_ALIASES[key] || TYPE_ALIASES[asText(value)] || "review";
};

/**
 * 类型归一化单独导出，给模块 1「对标账号分析」复用。
 *
 * 1.2 的结尾分析与 2.3 看的是同一套 5 个类型，别名表必须共用一份 ——
 * 各写一份的结果就是「模型回『共鸣＋IP符号』，一边认、一边掉进待人工复核」（§6.3⑫）。
 */
export const normalizeEndingHookType = normalizeType;

/** 置信度归一化同样导出，理由同上：中文「高/中/低」的兜底口径只能有一份。 */
export const normalizeEndingHookConfidence = (value, fallback = "low") =>
  CONFIDENCE_ALIASES[asText(value).toLowerCase()] || fallback;

// 提示词和输出 schema 都处在中文语境，模型很自然地会回「高 / 中 / 低」。
// 只认英文白名单会把模型的「低」静默升级成默认值；识别不了时一律落到 low：
// 证据不足时给出比规则降级路径更高的置信度，是不诚实的。
const normalizeConfidence = (value, fallback = "low") => CONFIDENCE_ALIASES[asText(value).toLowerCase()] || fallback;

const isReviewCategory = category => (
  asText(category?.id) === REVIEW_CATEGORY_ID || asText(category?.name) === REVIEW_CATEGORY_NAME
);

// 比对时先去掉空白和标点：模型复述转写时标点和断句几乎不可能和原文完全一致。
const stripForMatch = value => asText(value).replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】[\]…—-]/g, "");

// 模型自称「引用了转写」不算数，要真的能在转写原文里找到那句话。
// 与项目其它地方一致：不信任 Agent 的自我声明，只认能回到输入核对的证据。
const quotedFromTranscript = (endingText, transcript) => {
  const needle = stripForMatch(endingText);
  if (!needle) return false;
  return stripForMatch(transcript).includes(needle);
};

/**
 * 取文本的**最后一句** —— 结尾钩子要看的就是收尾那句话。
 *
 * 与 2.2 的 `firstSentence` 对称。分句后从后往前找第一段非空内容；
 * 全都分不出来时退回整段文本的尾部若干字。
 */
const lastSentence = value => {
  const text = cleanText(value, 900);
  if (!text) return "";
  const parts = text.split(/(?<=[。！？!?])|[\r\n]+/).map(item => item.trim()).filter(Boolean);
  const sentence = parts.length > 0 ? parts[parts.length - 1] : text;
  // 结尾通常很短，取尾部 160 字足够；超长时从**尾部**截，别把结尾截掉。
  return sentence.length > 160 ? sentence.slice(-160) : sentence;
};

/** 「取末句」的口径导出给模块 1 复用（1.2 没有结尾转写时也要从发布文案兜底）。 */
export const lastSentenceOf = lastSentence;

/**
 * 决定一条样本的「结尾文案」从哪来、算多可信。
 *
 * 与 2.2 的 resolveOpening 完全对称，只是把「首句」换成「末句」：
 *  1. 有真实转写，且模型引用了它 → transcript，用模型自评置信度（认不出时 medium）
 *  2. 有真实转写但模型没给文案 → 取转写末句兜底，仍是 transcript / medium
 *  3. 有转写但模型给的文案不在转写里 → 它实际用的是发布文案，如实标 caption、压到 low
 *  4. 没有转写 → 只能靠发布文案，模型没给就强制 low
 */
const resolveEnding = ({ rawEndingText, rawConfidence, hasTranscript, transcriptText, sourceText }) => {
  if (hasTranscript && rawEndingText && quotedFromTranscript(rawEndingText, transcriptText)) {
    return {
      endingText: cleanText(rawEndingText, 160),
      endingSource: "transcript",
      confidence: normalizeConfidence(rawConfidence, "medium"),
    };
  }
  if (hasTranscript && !rawEndingText) {
    return {
      endingText: lastSentence(transcriptText),
      endingSource: "transcript",
      confidence: "medium",
    };
  }
  if (hasTranscript) {
    return {
      endingText: cleanText(rawEndingText || lastSentence(sourceText), 160),
      endingSource: "caption",
      confidence: "low",
    };
  }
  return {
    endingText: cleanText(rawEndingText || lastSentence(sourceText), 160),
    endingSource: "caption",
    confidence: rawEndingText ? normalizeConfidence(rawConfidence) : "low",
  };
};

/** 样本窗口与 2.2 共用同一份实现（见 stageSampleWindow.js），保证两份报告能互相印证。 */
export const selectEndingHookVideos = selectStageVideos;

export const buildEndingHooksInput = (classificationReport, options = {}) => {
  const report = classificationReport && typeof classificationReport === "object" ? classificationReport : {};
  const limit = Number(options?.limit) || MAX_STAGE_VIDEOS;
  // 真实口播转写（**结尾**片段）。没有转写的样本仍按发布文案处理，
  // 提示词要求模型对这类样本把 confidence 压到 low。
  const transcripts = options?.transcripts instanceof Map ? options.transcripts : new Map();
  const selectedVideos = selectEndingHookVideos(report.videos, limit);
  return {
    account: report.account || {},
    contentStyle: report.contentStyle || "spoken",
    classificationSummary: asText(report.summary),
    // 「待人工复核」是人工待办队列，不是真实内容主题：它既不能作为内容大类送给模型，
    // 也不能出现在结尾钩子的配比里。落到这个队列的样本本身仍然保留在 videos 中。
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
      const transcriptText = cleanText(transcript?.text, 900);
      return {
        videoId,
        categoryName: categoryForVideo(videoId, report.categories, REVIEW_CATEGORY_NAME),
        title: cleanText(video?.title, 240),
        link: asText(video?.link),
        sourceText: cleanText(video?.sourceText, 900),
        // 有真实口播时带上原文（这是**结尾**片段）；模型必须从这里取结尾文案。
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

/**
 * 输入里每个大类自己的「核心功能 + 判断关键词」。
 * 结尾类型的原因必须建立在这上面，**不是**账号定位/人设定位（那是模块 1.2 的活）。
 */
const buildCategoryBreakdown = ({ items, inputCategories, categoryReasons }) => buildCategoryTypeBreakdown({
  items,
  inputCategories,
  categoryReasons,
  typeLabels: ENDING_HOOK_TYPE_LABELS,
  normalizeType,
  isReviewCategory,
  reviewCategoryName: REVIEW_CATEGORY_NAME,
});

/**
 * 把 Agent 输出归一化成报告。
 *
 * **不信任模型的任何统计**：只接受输入里已有的 videoId，条数与配比全部后端重算，
 * 认不出的类型落到「待人工复核」且不进配比。
 */
export const normalizeEndingHooks = ({ classificationReport, agentOutput = {}, analysisSource = "agent", warnings = [], transcripts } = {}) => {
  const input = buildEndingHooksInput(classificationReport, { transcripts });
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
    const ending = resolveEnding({
      rawEndingText: asText(rawItem?.endingText || rawItem?.ending_text || rawItem?.ending),
      rawConfidence: rawItem?.confidence,
      hasTranscript,
      transcriptText,
      sourceText: source.sourceText,
    });
    items.push({
      videoId,
      categoryName: source.categoryName,
      title: source.title,
      ...ending,
      transcriptProvider: hasTranscript ? asText(source.transcriptProvider) : "",
      type,
      typeLabel: ENDING_HOOK_TYPE_LABELS[type],
      evidence: cleanText(rawItem?.evidence || rawItem?.reason || "", 320),
      stats: source.stats,
      link: source.link,
    });
  }

  // 模型漏掉的样本仍然进报告（标待人工复核），不让样本凭空消失。
  for (const source of sourceVideos) {
    if (seen.has(source.videoId)) continue;
    const transcriptText = asText(source.transcript);
    const hasTranscript = Boolean(transcriptText);
    items.push({
      videoId: source.videoId,
      categoryName: source.categoryName,
      title: source.title,
      endingText: lastSentence(hasTranscript ? transcriptText : source.sourceText) || "未返回可提取的结尾文案",
      endingSource: hasTranscript ? "transcript" : "caption",
      transcriptProvider: hasTranscript ? asText(source.transcriptProvider) : "",
      type: "review",
      typeLabel: ENDING_HOOK_TYPE_LABELS.review,
      evidence: "Agent 未返回该样本的稳定判断，保留人工复核。",
      confidence: "low",
      stats: source.stats,
      link: source.link,
    });
  }

  const counts = countTypes(items);
  // 5 个类型**全部列出**（含计 0），与 2.2 的 8 维度分布同构。
  const typeDistribution = [
    ...buildTypeDistribution({ items, allTypes: ENDING_HOOK_TYPE_KEYS, typeLabels: ENDING_HOOK_TYPE_LABELS }),
    ...(counts.get("review") ? [{
      type: "review",
      typeLabel: ENDING_HOOK_TYPE_LABELS.review,
      count: counts.get("review"),
      percentage: ratio(counts.get("review"), items.length),
    }] : []),
  ].sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));

  // 「最常用的 3 种」只算真正命中过的：计 0 的类型不能被当成「常用」列出来。
  const topTypes = typeDistribution
    .filter(item => item.type !== "review" && item.count > 0)
    .slice(0, 3)
    .map(item => {
      const rawReason = (Array.isArray(agentOutput?.topTypes) ? agentOutput.topTypes : [])
        .find(reason => normalizeType(reason?.type || reason?.name) === item.type);
      return {
        ...item,
        reason: cleanText(rawReason?.reason || rawReason?.explanation || `该类型在本次样本中出现 ${item.count} 次，建议结合各大类的核心功能复核。`, 420),
      };
    });

  const categoryBreakdown = buildCategoryBreakdown({
    items,
    inputCategories: input.categories,
    categoryReasons: agentOutput?.categoryReasons || agentOutput?.category_reasons,
  });

  return {
    version: "1.0",
    reportType: "ending_hooks",
    account: classificationReport?.account || {},
    contentStyle: classificationReport?.contentStyle || "spoken",
    classificationReportType: classificationReport?.reportType || "benchmark_classification",
    sampleRule: "最新 60 条样本全部纳入分析，结尾文案取自每条作品的收尾片段。",
    analyzedCount: items.length,
    sourceVideoCount: sourceVideos.length,
    items,
    // 5 个类型的口径随报告返回，前端直接渲染 —— 不在前端另存一份定义。
    types: ENDING_HOOK_TYPES.map(item => ({
      type: item.type,
      label: ENDING_HOOK_TYPE_LABELS[item.type],
      definition: item.definition,
      example: item.example,
      strength: item.strength,
    })),
    // 有多少条样本的结尾文案真的来自转写（而不是发布文案推断）。
    transcriptCoverage: {
      fromTranscript: items.filter(item => item.endingSource === "transcript").length,
      fromCaption: items.filter(item => item.endingSource === "caption").length,
      total: items.length,
    },
    typeDistribution,
    topTypes,
    categoryBreakdown,
    accountSummary: cleanText(agentOutput?.accountSummary || agentOutput?.account_summary || "", 1200),
    analysisReason: cleanText(agentOutput?.analysisReason || agentOutput?.analysis_reason || "", 1200),
    analysisSource,
    warnings: Array.isArray(warnings) ? warnings : [],
    analyzedAt: new Date().toISOString(),
  };
};

/** 关键词规则兜底：Agent 不可用时也要给出一份可人工复核的报告。 */
export const buildHeuristicEndingHooks = (classificationReport) => {
  const input = buildEndingHooksInput(classificationReport);
  const patternHit = (text, patterns) => patterns.some(pattern => pattern.test(text));
  const fallbackType = text => {
    const value = asText(text);
    if (patternHit(value, [/私信|咨询|加我|领取|下单|链接|报名/])) return "conversion";
    if (patternHit(value, [/评论区|点赞|关注|转发|你怎么看|有没有遇到过/])) return "interaction";
    if (patternHit(value, [/其实|结果|反而|并不是|竟然|没想到/])) return "twist";
    if (patternHit(value, [/我是.{0,6}(律师|老师|老板)|记住|只讲|专讲/])) return "resonance_ip";
    return "review";
  };
  const items = input.videos.map(video => ({
    videoId: video.videoId,
    endingText: lastSentence(video.sourceText) || video.title,
    type: fallbackType(`${video.title} ${video.sourceText}`),
    evidence: "基于标题与平台返回文案的规则初步判断，建议结合完整脚本复核。",
    confidence: "low",
  }));
  return {
    accountSummary: "当前使用标题与平台返回文案完成结尾钩子的初步提取与分类，完整脚本不足的样本需人工复核。",
    analysisReason: "优先观察结尾是否引导互动、引导转化、制造反转、留下金句或带上固定口头禅，再结合账号的内容大类判断适配性。",
    items,
    topTypes: [],
    // 配比由后端从样本统计，模型只需要给原因；规则兜底给不出原因，留空。
    categoryReasons: [],
  };
};

export const endingHookTypeLabels = ENDING_HOOK_TYPE_LABELS;
export const MAX_ENDING_HOOK_VIDEOS = MAX_STAGE_VIDEOS;
