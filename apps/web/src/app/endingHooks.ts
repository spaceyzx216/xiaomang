import type { BenchmarkContentStyle, BenchmarkPlatform } from "./benchmarkAnalysis";

/**
 * 2.3 结尾钩子的客户端类型。
 *
 * 与 `goldThreeSeconds.ts`（2.2）同构，差别只在看的是**结尾**而不是开头：
 * `endingText` / `endingSource` 对应 2.2 的 `openingText` / `openingSource`。
 */

export type EndingHookType = "interaction" | "conversion" | "twist" | "punchline" | "resonance_ip" | "review";

export const ENDING_HOOK_TYPE_LABELS: Record<EndingHookType, string> = {
  interaction: "引导互动",
  conversion: "引导转化",
  twist: "反转",
  punchline: "金句",
  resonance_ip: "共鸣＋IP符号",
  review: "待人工复核",
};

/**
 * 未知类型的兜底标签 / 配色。
 * 与 2.2 同样的理由：数据库里可能有旧 key 的报告，直接查表会拿到 undefined，
 * 配色 class 拼成 "undefined" 就是渲染异常。
 */
export const UNKNOWN_ENDING_TYPE_LABEL = "未识别类型";
export const UNKNOWN_ENDING_TYPE_TONE = "border-slate-200 bg-slate-100 text-slate-600";

const LEGACY_TYPE_LABELS: Record<string, string> = {};

export const endingTypeLabelOf = (type: string) =>
  ENDING_HOOK_TYPE_LABELS[type as EndingHookType] || LEGACY_TYPE_LABELS[type] || type || UNKNOWN_ENDING_TYPE_LABEL;

export type EndingHookItem = {
  videoId: string;
  categoryName: string;
  title: string;
  link: string;
  endingText: string;
  /**
   * 结尾文案的来源。
   * - `transcript`：来自视频**结尾片段**的真实转写（ASR）或视频理解 —— 可信。
   * - `caption`：只能从发布文案推断 —— 那往往只是标题加话题标签，不等于真实结尾。
   */
  endingSource?: "transcript" | "caption";
  /** 命中的转写方案，例如 `ffmpeg+doubao-asr:mp3+tail5s`。 */
  transcriptProvider?: string;
  type: EndingHookType;
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

export type EndingTypeDistribution = {
  type: EndingHookType;
  typeLabel: string;
  count: number;
  percentage: number;
};

export type EndingCategoryDimension = {
  type: EndingHookType;
  typeLabel: string;
  count: number;
  ratio: number;
  reason: string;
};

export type EndingCategoryBreakdown = {
  categoryName: string;
  count: number;
  percentage: number;
  coreFunction: string;
  keywords: string[];
  dimensions: EndingCategoryDimension[];
  reviewCount: number;
};

export type EndingHookReport = {
  version: string;
  reportType: "ending_hooks";
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
  items: EndingHookItem[];
  /** 5 个类型的判定口径，由后端随报告返回。旧报告没有这个字段。 */
  types?: Array<{ type: string; label: string; definition: string; example: string; strength: string }>;
  /** 有多少条样本的结尾文案真的来自转写。 */
  transcriptCoverage?: { fromTranscript: number; fromCaption: number; total: number };
  typeDistribution: EndingTypeDistribution[];
  topTypes: Array<EndingTypeDistribution & { reason: string }>;
  categoryBreakdown: EndingCategoryBreakdown[];
  accountSummary: string;
  analysisReason: string;
  analysisSource: "agent" | "heuristic";
  warnings: Array<{ code?: string; error?: string; fallbackUsed?: boolean }>;
  analyzedAt: string;
};

/** 保存后列表里返回的元数据。 */
export type SavedEndingHookReportSummary = {
  id: string;
  reportType: "ending_hooks";
  accountName: string;
  accountUrl: string;
  contentStyle: BenchmarkContentStyle;
  analyzedCount: number;
  createdAt: string;
};

export type SavedEndingHookReport = SavedEndingHookReportSummary & {
  report: EndingHookReport;
};

export const confidenceLabel = (confidence: EndingHookItem["confidence"]) => (
  confidence === "high" ? "高" : confidence === "medium" ? "中" : "低"
);

/** 导出成 Markdown，供项目经理复制到文档里。与 2.2 的导出同构。 */
export const formatEndingHooksMarkdown = (report: EndingHookReport) => {
  const lines = [
    `# 结尾钩子库分析｜${report.account.name || "未识别账号"}`,
    "",
    `- 平台：${report.account.platformLabel}`,
    `- 分析视频：${report.analyzedCount} 条`,
    `- 分析时间：${report.analyzedAt ? new Date(report.analyzedAt).toLocaleString("zh-CN") : "未知"}`,
    "",
    `## 账号结尾钩子概括\n${report.accountSummary || "待补充"}`,
    "",
    "## 最常用的 3 种结尾类型",
  ];
  report.topTypes.forEach(item => lines.push(`- ${item.typeLabel} ${item.percentage}%（${item.count} 条）：${item.reason}`));
  lines.push("", "## 各大类的结尾类型配比");
  (report.categoryBreakdown || []).forEach(category => {
    lines.push(`### ${category.categoryName}（本次样本 ${category.count} 条 · ${category.percentage}%）`);
    if (category.coreFunction) lines.push(`核心功能：${category.coreFunction}`);
    if (category.keywords.length > 0) lines.push(`判断核心关键词/语句：${category.keywords.join("、")}`);
    if (category.dimensions.length === 0) lines.push("- 本次样本里没有该大类的有效结尾类型判断");
    category.dimensions.forEach(item => {
      lines.push(`- ${ENDING_HOOK_TYPE_LABELS[item.type] || item.type} ${item.ratio}%（${item.count} 条）：${item.reason || "Agent 未给出原因，待人工补充"}`);
    });
    if (category.reviewCount > 0) lines.push(`- 另有 ${category.reviewCount} 条判为待人工复核，未计入配比`);
  });
  return lines.join("\n");
};
