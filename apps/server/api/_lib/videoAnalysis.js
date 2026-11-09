/**
 * 4.1 单条视频数据分析 —— 复盘分析的**第一期核心**。
 *
 * 用户口径（2026-09-30）：
 *   「输入单个视频的文案与相关数据，由数据对应不同文案结构，生成数据分析报告与优化建议方案。」
 *
 * 报告由三段组成，**责任边界必须分清**：
 *
 *   ① 数据分析报告  —— 哪些指标高于/低于标准值、对应哪个结构、为什么。
 *                      **全部后端实算**（`reviewMetrics.js`），模型不参与。
 *   ② 文案结构标签  —— 这条视频属于哪个选题大类/小类，3s / 标题 / 结尾钩子各是什么类型。
 *                      人工选 + Agent 判，缺哪个就如实标「待人工复核」。
 *   ③ 优化建议方案  —— 「数据好的怎么复用、数据差的怎么调」的**文字**。
 *                      只有这一段交给模型；而且**结论以后端判定为准**，
 *                      模型若说反了（把「需要优化」说成「优秀」）要记 warning。
 *
 * 🔴 一条重要的前提（用户 2026-09-30 明确纠正过，别再搞错）：
 *    这里分析的是**客户自己发布的视频**，不是选题库里那些对标视频。
 *    所以这些数据系统**拿不到、也不能自动补**，只能由人工上传。
 *    选题库在这条链路上的作用只有两个：提供大类/小类**词典**，以及（二期）承接复盘后的新配比。
 *
 * 本模块**无网络、无 DB、无模型**，纯函数 —— 单测直接打在这里。
 */

import {
  GOLD_THREE_SECOND_TYPE_LABELS,
  normalizeGoldThreeSecondType,
} from "./goldThreeSeconds.js";
import { ENDING_HOOK_TYPE_LABELS, normalizeEndingHookType } from "./endingHooks.js";
import {
  ENGAGEMENT_METRIC_CATALOG,
  PROFESSIONAL_METRIC_CATALOG,
  REVIEW_STRUCTURES,
  buildStructureDirections,
  classifyPlayBucket,
  computeDerivedMetrics,
  describeWeights,
  formatMetricValue,
  formatThreshold,
  judgeVideoMetrics,
  metricsForPlatform,
  normalizeMetrics,
  normalizeReviewPlatform,
  toPercent,
} from "./reviewMetrics.js";

export const VIDEO_ANALYSIS_REPORT_TYPE = "video_analysis";
export const VIDEO_ANALYSIS_VERSION = 1;

/** 文案长度上限（与其它链路的 cleanText 同量级）。 */
const MAX_SCRIPT_CHARS = 12000;

const asText = value => String(value ?? "").trim();

/** 压缩空白并截断 —— 入参一律不可信（HANDOFF §2.1：校验与裁剪在共享层做）。 */
const cleanText = (value, maxLength = 500) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

/** 「待人工复核」的哨兵值。它是人工待办队列名，**永远不进配比**。 */
export const REVIEW_TYPE = "review";

// ─────────────────────────────────────────────────────────────────────────────
// 一、文案结构标签
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 归一化「文案结构标签」。
 *
 * 四类标签各有各的唯一来源，**不在这里另立一份定义**：
 *   · 3s 与标题 → `GOLD_THREE_SECOND_TYPE_LABELS`（8 个类型，标题与三秒同源）
 *   · 结尾钩子   → `ENDING_HOOK_TYPE_LABELS`（5 个类型）
 *   · 选题类型   → 客户选题库里的大类 / 小类（由 `categoryDictionary` 传进来校验）
 *
 * 认不出的类型**一律落 `review`**（待人工复核），不猜、不丢。
 * 选题库词典里没有的大类/小类**保留原值但记 warning** —— 用户选的东西不能被我静默改掉。
 *
 * @param categoryDictionary [{ name, subcategories: [{ name }] }]，可不传（不校验）
 */
export const normalizeStructureTags = ({ tags = {}, categoryDictionary = null } = {}) => {
  const warnings = [];
  const source = tags?.source === "agent" ? "agent" : tags?.source === "manual" ? "manual" : "manual";

  const rawGold = tags?.goldThreeSecondsType ?? tags?.goldThreeSeconds?.type;
  const goldThreeSecondsType = normalizeGoldThreeSecondType(rawGold);
  if (rawGold && goldThreeSecondsType === REVIEW_TYPE) {
    warnings.push(`黄金三秒类型「${cleanText(rawGold, 40)}」不在 8 个类型里，已标为待人工复核`);
  }

  const rawTitle = tags?.titleType ?? tags?.title?.type;
  const titleType = normalizeGoldThreeSecondType(rawTitle);
  if (rawTitle && titleType === REVIEW_TYPE) {
    warnings.push(`标题类型「${cleanText(rawTitle, 40)}」不在 8 个类型里，已标为待人工复核`);
  }

  const rawEnding = tags?.endingHookType ?? tags?.endingHook?.type;
  const endingHookType = normalizeEndingHookType(rawEnding);
  if (rawEnding && endingHookType === REVIEW_TYPE) {
    warnings.push(`结尾钩子类型「${cleanText(rawEnding, 40)}」不在 5 个类型里，已标为待人工复核`);
  }

  const categoryName = cleanText(tags?.categoryName ?? tags?.category?.name, 120);
  const subcategoryName = cleanText(tags?.subcategoryName ?? tags?.subcategory?.name, 120);

  // 选题库校验：只提示，不替换。用户选的小类如果不在库里，是他该知道的事实。
  if (categoryDictionary && (categoryName || subcategoryName)) {
    const dictionary = (Array.isArray(categoryDictionary) ? categoryDictionary : [])
      .filter(item => item && asText(item.name));
    if (dictionary.length > 0) {
      const category = dictionary.find(item => asText(item.name) === categoryName);
      if (categoryName && !category) {
        warnings.push(`所选大类「${categoryName}」不在当前客户的选题库里`);
      } else if (category && subcategoryName) {
        const subcategories = (Array.isArray(category.subcategories) ? category.subcategories : [])
          .map(item => asText(item?.name)).filter(Boolean);
        if (subcategories.length > 0 && !subcategories.includes(subcategoryName)) {
          warnings.push(`所选小类「${subcategoryName}」不属于大类「${categoryName}」`);
        }
      }
    }
  }

  return {
    tags: {
      source,
      categoryName,
      subcategoryName,
      goldThreeSecondsType,
      goldThreeSecondsLabel: GOLD_THREE_SECOND_TYPE_LABELS[goldThreeSecondsType] || "待人工复核",
      goldThreeSecondsReason: cleanText(tags?.goldThreeSecondsReason ?? tags?.goldThreeSeconds?.reason, 300),
      titleType,
      titleLabel: GOLD_THREE_SECOND_TYPE_LABELS[titleType] || "待人工复核",
      titleReason: cleanText(tags?.titleReason ?? tags?.title?.reason, 300),
      endingHookType,
      endingHookLabel: ENDING_HOOK_TYPE_LABELS[endingHookType] || "待人工复核",
      endingHookReason: cleanText(tags?.endingHookReason ?? tags?.endingHook?.reason, 300),
    },
    warnings,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 二、指标读数表（把「这个数字代表什么」原样带给界面）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 生成报告里的指标读数表。
 *
 * 用户明确要求「把数据背后代表的含义简单备注在后面，便于理解每个数据的意义」——
 * 所以 `meaning` 是要**显示给用户看**的文案，不是内部注释。
 * 前端**不另存一份指标定义**（同 §6.3-⑫ 的纪律），只渲染这里给的东西。
 */
export const buildMetricReadout = ({ platform, metrics = {}, derived = {} } = {}) => {
  const target = normalizeReviewPlatform(platform);
  const weights = describeWeights(target);
  const rankOf = (key, groups) => {
    const hit = (groups || []).findIndex(group => group.items.includes(key));
    return hit >= 0 ? hit + 1 : null;
  };
  const available = new Set(metricsForPlatform(target).map(item => item.key));

  const render = (catalog, groups) => catalog
    .filter(metric => available.has(metric.key))
    .map(metric => {
      const value = metric.key === "interactionRate" || metric.key === "avgPlayRate"
        ? derived[metric.key]
        : metrics[metric.key];
      return {
        key: metric.key,
        label: metric.label,
        meaning: metric.meaning,
        optional: Boolean(metric.optional),
        weightRank: rankOf(metric.label, groups),
        value: typeof value === "number" ? value : null,
        display: typeof value === "number" ? formatMetricValue(metric.key, value) : "—",
      };
    });

  return {
    engagement: render(ENGAGEMENT_METRIC_CATALOG, weights.engagement),
    professional: render(PROFESSIONAL_METRIC_CATALOG, weights.professional),
    weights,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// 三、优化建议方案（模型只写文字，结论以后端为准）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 归一化模型给出的优化建议。
 *
 * 🔴 三条纪律（照 `goldThreeSeconds.js` / `evidence.js` 的同一套）：
 *   1. **结论不由模型决定**：`verdict` / `verdictLabel` 一律取后端实算结果，
 *      模型就算返回了一个 verdict 也会被丢掉；**与后端不一致时记 warning**（防它误导用户）；
 *   2. 模型没给文字就**留空字符串**，前端如实显示「待人工补充」——
 *      不许编一句「建议优化内容」糊过去；
 *   3. 只认四大结构里存在的 key，多出来的丢弃并记 warning。
 */
export const normalizeVideoAnalysisSuggestions = ({ agentOutput = {}, structures = [], analysisSource = "agent" } = {}) => {
  const warnings = [];
  const byKey = new Map(structures.map(item => [item.key, item]));

  const raw = agentOutput?.structures ?? agentOutput?.suggestions ?? [];
  const list = Array.isArray(raw) ? raw : [];
  const texts = new Map();

  for (const entry of list) {
    const key = asText(entry?.key ?? entry?.structure ?? entry?.structureKey);
    if (!byKey.has(key)) {
      if (key) warnings.push(`模型返回了不认识的结构「${cleanText(key, 40)}」，已忽略`);
      continue;
    }
    const structure = byKey.get(key);
    // 模型若自报了结论，与后端实算核对 —— 对不上以**后端**为准并留痕。
    const claimed = asText(entry?.verdict ?? entry?.conclusion ?? entry?.level).toLowerCase();
    if (claimed && claimed !== structure.verdict) {
      warnings.push(`模型把「${structure.label}」判为「${claimed}」，与后端实算的「${structure.verdict}」不一致，已以后端为准`);
    }
    texts.set(key, {
      why: cleanText(entry?.why ?? entry?.reason ?? entry?.analysis, 600),
      how: cleanText(entry?.how ?? entry?.advice ?? entry?.suggestion, 600),
    });
  }

  const items = REVIEW_STRUCTURES.map(structure => {
    const computed = byKey.get(structure.key);
    const text = texts.get(structure.key) || { why: "", how: "" };
    return {
      key: structure.key,
      label: structure.label,
      hint: structure.hint,
      verdict: computed?.verdict || "missing",
      verdictLabel: computed?.verdictLabel || "数据缺失",
      /** 后端实算给出的判定依据（一定非空，除非数据全缺失）。 */
      reasons: computed?.reasons || [],
      /** 模型写的「为什么」；为空时前端显示「待人工补充」。 */
      why: text.why,
      /** 模型写的「怎么调」；为空同上。 */
      how: text.how,
    };
  });

  const summary = cleanText(agentOutput?.summary ?? agentOutput?.overview, 800);

  return {
    suggestions: { summary, items, analysisSource },
    warnings,
  };
};

/**
 * 规则兜底：模型不可用或返回无效时用。
 *
 * ⚠️ 兜底**只给得出从数据能核对的部分**（判定结论 + 判定依据），
 *    `why` / `how` 一律留空，由前端如实显示「待人工补充」——
 *    这是本项目一贯的诚实性规则，别在这里补一句通用话术凑数。
 */
export const buildHeuristicVideoAnalysisSuggestions = ({ structures = [] } = {}) => ({
  summary: "",
  analysisSource: "heuristic",
  items: REVIEW_STRUCTURES.map(structure => {
    const computed = structures.find(item => item.key === structure.key);
    return {
      key: structure.key,
      label: structure.label,
      hint: structure.hint,
      verdict: computed?.verdict || "missing",
      verdictLabel: computed?.verdictLabel || "数据缺失",
      reasons: computed?.reasons || [],
      why: "",
      how: "",
    };
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、组装报告
// ─────────────────────────────────────────────────────────────────────────────

/** 归一化视频元信息。链接只留 http(s)，其余如实留空。 */
export const normalizeVideoMeta = (video = {}) => {
  const link = asText(video?.link);
  return {
    title: cleanText(video?.title, 300),
    link: /^https?:\/\//i.test(link) ? link : "",
    authorName: cleanText(video?.authorName, 120),
    publishedAt: cleanText(video?.publishedAt, 40),
  };
};

/**
 * 组装 4.1 报告。
 *
 * @param platform            douyin | wechat_channels
 * @param rawMetrics          原始指标（来自 Excel 行或手工输入）
 * @param scriptText          该视频的文案（结构标签的判定依据）
 * @param structureTags       四类结构标签
 * @param categoryDictionary  选题库大类/小类词典（可为空，为空则不校验）
 * @param agentOutput         模型输出（可为空 → 走规则兜底）
 */
export const buildVideoAnalysisReport = ({
  platform,
  rawMetrics = {},
  scriptText = "",
  structureTags = {},
  categoryDictionary = null,
  video = {},
  agentOutput = null,
  extraWarnings = [],
  analyzedAt = new Date().toISOString(),
} = {}) => {
  const target = normalizeReviewPlatform(platform);
  const warnings = [...(Array.isArray(extraWarnings) ? extraWarnings : [])];

  // ① 指标：先归一化（认 0.32 / 32 / "32%" 三种写法），再实算派生量，再判定。
  const { metrics, missing, optionalMissing, suspicious } = normalizeMetrics({ platform: target, raw: rawMetrics });
  const { judgments, derived } = judgeVideoMetrics({ platform: target, metrics });
  const structures = buildStructureDirections({ platform: target, judgments });

  for (const key of missing) {
    const metric = metricsForPlatform(target).find(item => item.key === key);
    warnings.push(`「${metric?.label || key}」没有取到数值，相关结论无法判定`);
  }
  for (const key of suspicious) {
    const metric = metricsForPlatform(target).find(item => item.key === key);
    warnings.push(`「${metric?.label || key}」的数值超出合理范围，请核对 Excel 里这一列的口径`);
  }
  // ⚠️ 「关注」缺失**不进 warnings**：它不参与任何判定，每份报告都挂一条会是纯噪声。
  //    改为在报告里单列 `optionalMissing`，界面按需提示（指标表里它也会显示成「—」）。

  // ② 结构标签（选题类型 + 三个文案结构类型）
  const tagResult = normalizeStructureTags({ tags: structureTags, categoryDictionary });
  warnings.push(...tagResult.warnings);

  // ③ 优化建议：模型只写文字，结论以后端为准；模型不可用则规则兜底。
  const suggestionResult = agentOutput
    ? normalizeVideoAnalysisSuggestions({ agentOutput, structures, analysisSource: "agent" })
    : { suggestions: buildHeuristicVideoAnalysisSuggestions({ structures }), warnings: [] };
  warnings.push(...suggestionResult.warnings);

  const script = asText(scriptText).slice(0, MAX_SCRIPT_CHARS);

  return {
    version: VIDEO_ANALYSIS_VERSION,
    reportType: VIDEO_ANALYSIS_REPORT_TYPE,
    platform: target,
    platformLabel: target === "wechat_channels" ? "视频号" : "抖音",
    video: normalizeVideoMeta(video),
    script: { text: script, charCount: script.length },
    structureTags: tagResult.tags,
    metrics,
    /** 判定用不到的指标缺失（当前只有「关注」）——单独给出，不混进 warnings。 */
    optionalMissing,
    derived: {
      engagementTotal: derived.engagementTotal,
      interactionRate: derived.interactionRate,
      interactionRatePercent: toPercent(derived.interactionRate),
      avgPlayRate: derived.avgPlayRate,
      avgPlayRatePercent: toPercent(derived.avgPlayRate),
    },
    metricReadout: buildMetricReadout({ platform: target, metrics, derived }),
    judgments,
    /** 每个指标「标准是什么」，供界面把判定线一并显示出来。 */
    rules: judgments.map(item => ({ metric: item.metric, label: item.label, threshold: formatThreshold(item) })),
    structures,
    playBucket: classifyPlayBucket(metrics.plays),
    suggestions: suggestionResult.suggestions,
    analysisSource: suggestionResult.suggestions.analysisSource,
    warnings,
    analyzedAt,
  };
};

/** 报告摘要（列表只给元数据，正文按 id 取 —— 合同见 HANDOFF §6.2-⑥）。 */
export const summarizeVideoAnalysisReport = (report = {}) => ({
  reportType: report.reportType,
  platform: report.platform,
  platformLabel: report.platformLabel,
  videoTitle: report.video?.title || "",
  videoLink: report.video?.link || "",
  categoryName: report.structureTags?.categoryName || "",
  subcategoryName: report.structureTags?.subcategoryName || "",
  plays: report.metrics?.plays ?? null,
  playBucketLabel: report.playBucket?.label || "",
  optimizeCount: (report.structures || []).filter(item => item.verdict === "optimize").length,
  analysisSource: report.analysisSource,
  analyzedAt: report.analyzedAt,
});
