import type { BenchmarkContentStyle, BenchmarkPlatform } from "./benchmarkAnalysis";

export type GoldThreeSecondType = "curiosity" | "fear" | "anger" | "contrast" | "pain" | "interest" | "knowledge" | "desire" | "review";

export const GOLD_THREE_SECOND_TYPE_LABELS: Record<GoldThreeSecondType, string> = {
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

/**
 * 未知类型的兜底标签 / 配色。
 *
 * 维度集在 2026-09-17 变动过一次（「需求」短暂存在一天后换回「反差」），数据库里
 * 可能留着带旧 key 的报告。直接查表会拿到 undefined，轻则标签空白、重则渲染报错。
 * 一律走这两个兜底。
 */
export const UNKNOWN_TYPE_LABEL = "未识别类型";
export const UNKNOWN_TYPE_TONE = "border-slate-200 bg-slate-100 text-slate-600";

/** 已废弃维度的显示名。让旧报告还能正常渲染，而不是显示成一个裸 key。 */
const LEGACY_TYPE_LABELS: Record<string, string> = {
  // 「需求」只在 2026-09-17 存在过一天，用户随后确认要「反差」不要它。
  needs: "需求（旧）",
};

export const typeLabelOf = (type: string) =>
  GOLD_THREE_SECOND_TYPE_LABELS[type as GoldThreeSecondType] || LEGACY_TYPE_LABELS[type] || type || UNKNOWN_TYPE_LABEL;

export type GoldThreeSecondItem = {
  videoId: string;
  categoryName: string;
  title: string;
  link: string;
  openingText: string;
  /**
   * 开场文案的来源。
   * - `transcript`：来自视频音频的真实转写（ASR）或豆包视频理解 —— 可信。
   * - `caption`：只能从发布文案推断 —— 那往往只是标题加话题标签，不等于真实开场。
   */
  openingSource?: "transcript" | "caption";
  /** 命中的转写方案，例如 `tikhub-ffmpeg+doubao-asr:wav`。 */
  transcriptProvider?: string;
  type: GoldThreeSecondType;
  typeLabel: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
  stats: {
    likes: number;
    comments: number;
    shares: number;
    bookmarks: number;
  };
};

export type GoldTypeDistribution = {
  type: GoldThreeSecondType;
  typeLabel: string;
  count: number;
  percentage: number;
};

/**
 * 按大类的三秒维度配比。
 *
 * **配比由后端从每条样本的 type 实际统计**（每个大类的 ratio 合计 100），
 * 模型只提供 `reason` 解释。原因缺失时 `reason` 为空字符串 —— 由前端如实说明，
 * 不会用一句套话糊过去。
 */
export type GoldCategoryDimension = {
  type: GoldThreeSecondType;
  typeLabel: string;
  /** 该大类下判为该类型的样本条数。配比就是按它算的，样本量小的时候要看得见。 */
  count: number;
  ratio: number;
  reason: string;
};

export type GoldCategoryBreakdown = {
  categoryName: string;
  /** 该大类在本次分析样本里的条数。可能是 0（分类报告里有这个大类，但这批样本没抽到）。 */
  count: number;
  /** 占本次样本的比例。 */
  percentage: number;
  /** 来自上一步分类报告，方便对照「这个大类是干什么的」。 */
  coreFunction: string;
  keywords: string[];
  dimensions: GoldCategoryDimension[];
  /** 该大类下判为「待人工复核」的条数，不计入 dimensions。 */
  reviewCount: number;
};

export type GoldThreeSecondReport = {
  version: string;
  reportType: "gold_three_seconds";
  account: {
    name: string;
    url: string;
    platform: BenchmarkPlatform;
    platformLabel: string;
  };
  contentStyle: BenchmarkContentStyle;
  classificationReportType: string;
  sampleRule: string;
  analyzedCount: number;
  sourceVideoCount: number;
  items: GoldThreeSecondItem[];
  /**
   * 8 个分析维度的口径，由后端随报告返回（`api/_lib/goldThreeSeconds.js` 的
   * `GOLD_THREE_SECOND_DIMENSIONS`）。旧报告没有这个字段。
   */
  dimensions?: Array<{ type: string; label: string; definition: string; example: string; strength: string }>;
  /** 有多少条样本的开场文案真的来自转写。没有这个字段说明是旧报告（全部按发布文案推断）。 */
  transcriptCoverage?: { fromTranscript: number; fromCaption: number; total: number };
  typeDistribution: GoldTypeDistribution[];
  topTypes: Array<GoldTypeDistribution & { reason: string }>;
  categoryBreakdown: GoldCategoryBreakdown[];
  accountSummary: string;
  analysisReason: string;
  analysisSource: "agent" | "heuristic";
  warnings: Array<{ code?: string; error?: string; fallbackUsed?: boolean }>;
  analyzedAt: string;
};

export type SavedGoldThreeSecondReport = {
  id: string;
  reportType: "gold_three_seconds";
  accountName: string;
  accountUrl: string;
  contentStyle: BenchmarkContentStyle;
  analyzedCount: number;
  report: GoldThreeSecondReport;
  createdAt: string;
};

/** 列表接口返回的形状：只有元数据。正文用 GET /api/gold-three-second-reports?id= 单独取。 */
export type SavedGoldThreeSecondReportSummary = Omit<SavedGoldThreeSecondReport, "report">;

export const confidenceLabel = (confidence: GoldThreeSecondItem["confidence"]) => ({
  high: "高",
  medium: "中",
  low: "低",
}[confidence] || "中");

export const formatGoldThreeSecondsMarkdown = (report: GoldThreeSecondReport) => {
  const lines = [
    `# 黄金三秒分析｜${report.account.name || "未识别账号"}`,
    "",
    `- 平台：${report.account.platformLabel}`,
    `- 内容形式：${report.contentStyle === "drama" ? "演绎类" : "口播类"}`,
    `- 样本：${report.sampleRule}`,
    `- 分析视频：${report.analyzedCount} 条`,
    "",
    `## 账号黄金三秒概括\n${report.accountSummary || "待补充"}`,
    "",
    "## 最常用的 3 种类型",
  ];
  report.topTypes.forEach(item => lines.push(`- ${item.typeLabel} ${item.percentage}%（${item.count} 条）：${item.reason}`));
  lines.push("", "## 各大类的三秒维度配比");
  (report.categoryBreakdown || []).forEach(category => {
    lines.push(`### ${category.categoryName}（本次样本 ${category.count} 条 · ${category.percentage}%）`);
    if (category.coreFunction) lines.push(`核心功能：${category.coreFunction}`);
    if (category.keywords.length > 0) lines.push(`判断核心关键词/语句：${category.keywords.join("、")}`);
    if (category.dimensions.length === 0) lines.push("- 本次样本里没有该大类的有效三秒类型判断");
    category.dimensions.forEach(item => {
      lines.push(`- ${GOLD_THREE_SECOND_TYPE_LABELS[item.type] || item.type} ${item.ratio}%（${item.count} 条）：${item.reason || "Agent 未给出原因，待人工补充"}`);
    });
    if (category.reviewCount > 0) lines.push(`- 另有 ${category.reviewCount} 条判为待人工复核，未计入配比`);
  });
  return lines.join("\n");
};
