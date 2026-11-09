/**
 * 模块 4「复盘分析」的客户端类型与接口。
 *
 * 与 `reportApi.ts` 同一套约定：
 *   1. **列表只返回元数据**，正文按 id 单独取；
 *   2. **一律不自动重试** —— POST 重试会重复分析（要花模型的钱），
 *      GET 失败让用户手动重来更可控。
 *
 * ── 这条链路与其它模块最大的不同 ──────────────────────────────────────────
 *
 * 分析对象是**客户自己发布的视频**，数据只能由人工从平台后台导出后上传。
 * 所以流程是两段：
 *   ① 上传 Excel → 后端解析 → **用户确认列映射**（`parseReviewWorkbook`）
 *   ② 用确认后的映射跑分析 → 出报告 → 用户看过再保存（`analyzeVideoReview` / `saveVideoReview`）
 * 第 ① 步不花钱、不落库，用户可以反复调整。
 */

import { apiUrl, fetchWithRetry, parseApiJson } from "./api";

const request = async (path: string, init: RequestInit = {}) => {
  const response = await fetchWithRetry(apiUrl(path), { retries: 0, ...init });
  const data = await parseApiJson(response);
  if (!response.ok || data?.success === false) {
    throw new Error(String(data?.error || `请求失败（HTTP ${response.status}）`));
  }
  return data;
};

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// ---------- 类型 ----------

export type ReviewPlatform = "douyin" | "wechat_channels";

/** 后端返回的、针对某平台可用的指标（供列映射界面渲染下拉）。 */
export type ReviewMetricOption = {
  key: string;
  label: string;
  meaning: string;
  optional: boolean;
  group: "engagement" | "professional";
  kind?: 'count' | 'rate' | 'seconds';
};

export type ParsedWorkbook = {
  fileName: string;
  sheetNames: string[];
  sheetName: string;
  headers: string[];
  rows: string[][];
  records: Record<string, string>[];
  suggestedMapping: Record<string, string>;
  unmatchedHeaders: string[];
  missingMetrics: string[];
  /** 列映射下拉的选项 —— **后端下发**，前端不另存一份指标定义。 */
  metricOptions: ReviewMetricOption[];
  truncated: boolean;
};

export type ReviewJudgment = {
  metric: string;
  label: string;
  value: number | null;
  level: "good" | "watch" | "bad" | "missing" | "suspicious";
  levelLabel: string;
  conclusion: string;
  affects: string[];
  direction: "up" | "down";
  good: number;
  bad: number;
};

export type ReviewStructure = {
  key: string;
  label: string;
  hint: string;
  verdict: "reuse" | "optimize" | "watch" | "missing";
  verdictLabel: string;
  reasons: string[];
  missingMetrics: string[];
};

export type ReviewSuggestionItem = {
  key: string;
  label: string;
  hint: string;
  verdict: string;
  verdictLabel: string;
  reasons: string[];
  /** 模型写的「为什么」；为空表示待人工补充（后端规则兜底时一定为空）。 */
  why: string;
  /** 模型写的「怎么调」；同上。 */
  how: string;
};

export type ReviewMetricReadout = {
  key: string;
  label: string;
  meaning: string;
  optional: boolean;
  weightRank: number | null;
  value: number | null;
  display: string;
};

export type VideoAnalysisReport = {
  version: number;
  reportType: "video_analysis";
  platform: ReviewPlatform;
  platformLabel: string;
  video: { title: string; link: string; authorName: string; publishedAt: string };
  script: { text: string; charCount: number };
  structureTags: {
    source: "manual" | "agent";
    categoryName: string;
    subcategoryName: string;
    goldThreeSecondsType: string;
    goldThreeSecondsLabel: string;
    goldThreeSecondsReason: string;
    titleType: string;
    titleLabel: string;
    titleReason: string;
    endingHookType: string;
    endingHookLabel: string;
    endingHookReason: string;
  };
  metrics: Record<string, number | null>;
  optionalMissing: string[];
  derived: {
    engagementTotal: number | null;
    interactionRate: number | null;
    interactionRatePercent: number | null;
    avgPlayRate: number | null;
    avgPlayRatePercent: number | null;
  };
  metricReadout: { engagement: ReviewMetricReadout[]; professional: ReviewMetricReadout[]; weights: unknown };
  judgments: ReviewJudgment[];
  rules: Array<{ metric: string; label: string; threshold: string }>;
  structures: ReviewStructure[];
  playBucket: { key: string; label: string; hint: string; ambiguous: boolean };
  suggestions: { summary: string; items: ReviewSuggestionItem[]; analysisSource: string };
  analysisSource: "agent" | "heuristic";
  warnings: string[];
  analyzedAt: string;
};

export type SavedVideoReviewSummary = {
  id: string;
  reportType: string;
  customerId: string;
  customerName: string;
  platform: string;
  platformLabel: string;
  videoTitle: string;
  videoLink: string;
  categoryName: string;
  subcategoryName: string;
  plays: number | null;
  playBucketLabel: string;
  optimizeCount: number;
  analysisSource: string;
  createdAt: string;
};

export type SavedVideoReview = SavedVideoReviewSummary & { report: VideoAnalysisReport | null };

// ---------- 接口 ----------

/**
 * 上传并解析 Excel。
 *
 * 🔴 文件走 **base64 + JSON**（不是 FormData）：本地 Express 与 Vercel 两套后端
 *    都要能跑，而 multer 只有前者有（理由见 `_lib/reviewWorkbook.js`）。
 *    实测一周 60 条视频的导出表只有几十 KB，base64 之后远小于上限。
 */
export const parseReviewWorkbook = async (
  file: File,
  options: { platform?: ReviewPlatform; sheetName?: string } = {},
): Promise<ParsedWorkbook> => {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取文件失败，请重新选择"));
    reader.readAsDataURL(file);
  });
  const data = await request("/api/review/workbook", jsonInit("POST", {
    fileName: file.name,
    dataBase64,
    platform: options.platform || "douyin",
    sheetName: options.sheetName || "",
  }));
  return data as ParsedWorkbook;
};

/** 跑 4.1 分析。**不落库** —— 用户看过、必要时改过之后再调 `saveVideoReview`。 */
export const analyzeVideoReview = async (payload: {
  customerId: string;
  platform: ReviewPlatform;
  metrics: Record<string, string | number>;
  script: string;
  video?: { title?: string; link?: string; publishedAt?: string; authorName?: string };
  structureTags?: Record<string, string>;
}): Promise<VideoAnalysisReport> => {
  const data = await request("/api/agent/video-analysis", jsonInit("POST", payload));
  if (!data?.report) throw new Error("分析失败：后端没有返回报告");
  return data.report as VideoAnalysisReport;
};

export const saveVideoReview = async (payload: {
  customerId: string;
  customerName?: string;
  report: VideoAnalysisReport;
}): Promise<SavedVideoReviewSummary> => {
  const data = await request("/api/video-analysis-reports", jsonInit("POST", payload));
  if (!data?.item) throw new Error("保存失败：后端没有返回报告记录");
  return data.item as SavedVideoReviewSummary;
};

export const listVideoReviewsForCustomer = async (customerId: string, limit = 20): Promise<SavedVideoReviewSummary[]> => {
  const data = await request(`/api/video-analysis-reports?customerId=${encodeURIComponent(customerId)}&limit=${limit}`);
  return Array.isArray(data?.items) ? data.items as SavedVideoReviewSummary[] : [];
};

export const getVideoReviewForCustomer = async (customerId: string, id: string): Promise<SavedVideoReview | null> => {
  const data = await request(`/api/video-analysis-reports?customerId=${encodeURIComponent(customerId)}&id=${encodeURIComponent(id)}`);
  return (data?.item as SavedVideoReview) || null;
};

export const deleteVideoReview = async (id: string): Promise<void> => {
  await request(`/api/video-analysis-reports?id=${encodeURIComponent(id)}`, { method: "DELETE" });
};

/** 客户下拉用。与其它阶段同一口径：复用 `/api/customers`。 */
export const listReviewCustomers = async (): Promise<Array<{ id: string; name: string }>> => {
  const data = await request("/api/customers");
  return Array.isArray(data?.items) ? data.items.map((item: { id: string; name: string }) => ({ id: String(item.id), name: String(item.name || "") })) : [];
};
