import { apiUrl, fetchWithRetry, parseApiJson } from "./api";
import type { BenchmarkReport, SavedBenchmarkReport, SavedBenchmarkReportSummary } from "./benchmarkAnalysis";
import type { GoldThreeSecondReport, SavedGoldThreeSecondReport, SavedGoldThreeSecondReportSummary } from "./goldThreeSeconds";
import type { EndingHookReport, SavedEndingHookReport, SavedEndingHookReportSummary } from "./endingHooks";
import type {
  BenchmarkProfileReport,
  SavedBenchmarkProfileReport,
  SavedBenchmarkProfileReportSummary,
} from "./benchmarkProfile";
import type {
  AccountPlanReport,
  CustomerDetail,
  CustomerSummary,
  SavedAccountPlanReport,
  SavedAccountPlanReportSummary,
} from "./accountPlan";

/**
 * 报告接口客户端。
 *
 * 两个约定：
 * 1. **列表只返回元数据**，正文按 id 单独取。单份分类报告正文约 148 KB，列表拉 12 份
 *    就是近 2 MB，而调用方只是想挑一份 —— 这是黄金三秒页读历史很慢的根因。
 * 2. **一律不自动重试**。POST 重试会重复写入（后端虽然做了幂等，也不该靠它兜），
 *    GET 失败让用户手动重来更可控。
 */

export const parseApiError = async (response: Response) => {
  const data = await parseApiJson(response);
  if (!response.ok || data?.success === false) {
    throw new Error(String(data?.error || `请求失败（HTTP ${response.status}）`));
  }
  return data;
};

const request = async (path: string, init: RequestInit = {}) => {
  const response = await fetchWithRetry(apiUrl(path), { retries: 0, ...init });
  return parseApiError(response);
};

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const idQuery = (path: string, id: string) => `${path}?id=${encodeURIComponent(id)}`;

// ---------- 分类分析报告 ----------

export const listBenchmarkReports = async (): Promise<SavedBenchmarkReportSummary[]> => {
  const data = await request("/api/benchmark-reports");
  return Array.isArray(data?.items) ? data.items as SavedBenchmarkReportSummary[] : [];
};

/** 按 id 取单份完整报告（含正文）。列表不带正文，要点开/使用某一份时调这个。 */
export const getBenchmarkReport = async (id: string): Promise<SavedBenchmarkReport | null> => {
  const data = await request(idQuery("/api/benchmark-reports", id));
  return (data?.item as SavedBenchmarkReport) || null;
};

export const saveBenchmarkReport = async (
  report: BenchmarkReport,
  selectedVideoIds: string[],
): Promise<SavedBenchmarkReportSummary> => {
  const data = await request("/api/benchmark-reports", jsonInit("POST", { report, selectedVideoIds }));
  if (!data?.item) throw new Error("保存分类分析报告失败：后端没有返回报告记录");
  return data.item as SavedBenchmarkReportSummary;
};

export const deleteBenchmarkReport = async (id: string): Promise<void> => {
  await request(idQuery("/api/benchmark-reports", id), { method: "DELETE" });
};

// ---------- 黄金三秒报告 ----------

export const listGoldThreeSecondReports = async (): Promise<SavedGoldThreeSecondReportSummary[]> => {
  const data = await request("/api/gold-three-second-reports");
  return Array.isArray(data?.items) ? data.items as SavedGoldThreeSecondReportSummary[] : [];
};

export const getGoldThreeSecondReport = async (id: string): Promise<SavedGoldThreeSecondReport | null> => {
  const data = await request(idQuery("/api/gold-three-second-reports", id));
  return (data?.item as SavedGoldThreeSecondReport) || null;
};

export const saveGoldThreeSecondReport = async (report: GoldThreeSecondReport): Promise<SavedGoldThreeSecondReportSummary> => {
  const data = await request("/api/gold-three-second-reports", jsonInit("POST", { report }));
  if (!data?.item) throw new Error("保存黄金三秒报告失败：后端没有返回报告记录");
  return data.item as SavedGoldThreeSecondReportSummary;
};

export const deleteGoldThreeSecondReport = async (id: string): Promise<void> => {
  await request(idQuery("/api/gold-three-second-reports", id), { method: "DELETE" });
};

/** 历史列表统一显示到秒：同一天保存多份时，只显示日期根本分不清哪份是哪份。 */
export const formatReportTime = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 19);
  return date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
};

// ---------- 黄金三秒的真实口播转写 ----------

export type TranscriptProgress = {
  total: number;
  ok: number;
  failed: number;
  attempted: number;
  finished: boolean;
  /** 服务端关掉了转写（GOLD_TRANSCRIPT_ENABLED=false）。 */
  disabled?: boolean;
  /** 这一批之后还剩几条没跑。 */
  remaining?: number;
  batch?: Array<{ videoId: string; status: string; provider: string; durationMs: number }>;
};

/**
 * 驱动**一批**真实口播转写，返回累计进度。
 *
 * 单条实测约 89 秒，20 条装不进任何 serverless 请求，所以由调用方循环调用直到
 * `finished`。转写结果按视频落库，同一个视频只付一次成本，重跑直接命中缓存。
 */
export const transcribeGoldSamples = async (classificationReport: BenchmarkReport): Promise<TranscriptProgress | null> => {
  const data = await request(
    "/api/agent/gold-three-seconds",
    jsonInit("POST", { classificationReport, phase: "transcribe" }),
  );
  return (data?.progress as TranscriptProgress) || null;
};

// ---------- 结尾钩子报告（2.3，与 2.2 完全同构） ----------

export const listEndingHookReports = async (): Promise<SavedEndingHookReportSummary[]> => {
  const data = await request("/api/ending-hook-reports");
  return Array.isArray(data?.items) ? data.items as SavedEndingHookReportSummary[] : [];
};

export const getEndingHookReport = async (id: string): Promise<SavedEndingHookReport | null> => {
  const data = await request(idQuery("/api/ending-hook-reports", id));
  return (data?.item as SavedEndingHookReport) || null;
};

export const saveEndingHookReport = async (report: EndingHookReport): Promise<SavedEndingHookReportSummary> => {
  const data = await request("/api/ending-hook-reports", jsonInit("POST", { report }));
  return data?.item as SavedEndingHookReportSummary;
};

export const deleteEndingHookReport = async (id: string): Promise<void> => {
  await request(idQuery("/api/ending-hook-reports", id), { method: "DELETE" });
};

/**
 * 驱动**一批**结尾片段转写，返回累计进度。
 *
 * 与 `transcribeGoldSamples` 同构，但服务端用的是 `scope: "tail"` —— 取视频**结尾**
 * 几秒（ffmpeg `-sseof`），而不是开头。两边缓存分开存，不会互相覆盖。
 */
export const transcribeEndingSamples = async (classificationReport: BenchmarkReport): Promise<TranscriptProgress | null> => {
  const data = await request(
    "/api/agent/ending-hooks",
    jsonInit("POST", { classificationReport, phase: "transcribe" }),
  );
  return (data?.progress as TranscriptProgress) || null;
};

// ---------- 模块 1　对标账号分析（1.2） ----------

/**
 * 驱动**一批**前 20 条样本的转写，返回累计进度。
 *
 * 与 2.2/2.3 的转写驱动同构，但有两个差别：
 *   - 服务端只取**点赞最高的前 20 条**；
 *   - 必须显式带 `scope`：先 `head`（判断三秒）再 `tail`（判断结尾钩子）。
 * 转写结果按 (videoId, scope) 落库，2.2/2.3 跑过的样本这里直接命中缓存、几乎零成本。
 */
export const transcribeProfileSamples = async (
  classificationReport: BenchmarkReport,
  scope: "head" | "tail",
): Promise<TranscriptProgress | null> => {
  const data = await request(
    "/api/agent/benchmark-profile",
    jsonInit("POST", { classificationReport, phase: "transcribe", scope }),
  );
  return (data?.progress as TranscriptProgress) || null;
};

export type CommentProgress = {
  total: number;
  ok: number;
  failed: number;
  attempted: number;
  finished: boolean;
  remaining?: number;
  batch?: Array<{ videoId: string; status: string; provider: string; durationMs: number }>;
};

/**
 * 驱动**一批**高赞评论抓取，返回累计进度。
 *
 * 只传 videoId 与平台：TikHub 的评论接口按 `aweme_id` 取，不需要链接。
 * 抓取结果按视频永久缓存（成功与失败都缓存），同一个视频一个项目经理只付一次成本；
 * 想让失败的视频重试，需要后端 `clearComments`。
 */
export const fetchProfileComments = async (
  videos: Array<{ videoId: string; platform?: string }>,
): Promise<CommentProgress | null> => {
  const data = await request("/api/tikhub/comments", jsonInit("POST", { videos }));
  return (data?.progress as CommentProgress) || null;
};

/** 粉丝画像的一个维度（性别 / 年龄 / 手机价格 …），已按占比降序归一化。 */
export type FansPortraitDimension = {
  option: number;
  /** 稳定 key：gender / age / mobilePrice / cityLevel / mobileBrand / interest / province / city。 */
  key: string;
  /** 中文维度名，如「性别分布」。 */
  label: string;
  /** 这个维度供给用户画像的哪一项（gender / income / region …）。 */
  specField: string;
  specLabel: string;
  /** 已按占比降序；`percentage` 是 0-100 的百分数，不是 0-1 的比例。 */
  items: Array<{ name: string; percentage: number }>;
  dominant: { name: string; percentage: number };
  /** TGI 指数（>100 表示该人群偏好高于大盘）。当前界面不展示，保留给后续分析用。 */
  tgi: Array<{ name: string; index: number }>;
};

/** 抖音热榜粉丝画像的整体返回。`reason` 为空的唯一情况是 `ok`（拿到了至少一个维度）。 */
export type FansPortrait = {
  ok: boolean;
  /** "" 表示成功；否则是 "missing_sec_user_id" | "no_dimensions" | "missing_token" 等。 */
  reason: string;
  secUserId: string;
  dimensions: FansPortraitDimension[];
  /** 单个维度失败不影响其余维度，失败的维度在这里如实列出。 */
  failed: Array<{ option: number; label: string; error: string }>;
  fetchedAt: string;
  fromCache?: boolean;
};

/**
 * 拉一个账号的真实粉丝画像（性别 / 年龄 / 手机价格 / 城市等级 / 手机品牌 / 兴趣 / 省份 / 城市）。
 *
 * **只调一次，不要循环**：上游一次只能取一个维度，后端在这一次请求里并发打 8 个 GET
 * 并按账号缓存（同一账号 7 天内只付一次钱），前端再拆批只会白白放大付费调用。
 * 拿到画像后**不需要**把它传给分析端点 —— 分析端点自己从缓存读。
 */
export const fetchFansPortrait = async (secUserId: string): Promise<FansPortrait | null> => {
  const data = await request("/api/tikhub/fans-portrait", jsonInit("POST", { secUserId }));
  return (data?.portrait as FansPortrait) || null;
};

/**
 * 跑 1.2 的分析 Agent，产出对标账号分析报告。
 *
 * `classificationSource` 告诉后端这份分类报告是**复用已保存的**还是**本次运行里现跑的**：
 * 1.2 允许直接分析新账号（会先跑一次分类，不落库），报告里必须如实区分，
 * 不能一律写「复用模块 3 的 2.1 产出」。
 */
export const analyzeBenchmarkProfile = async (
  classificationReport: BenchmarkReport,
  classificationSource: "fresh" | "reused" = "reused",
): Promise<BenchmarkProfileReport> => {
  const data = await request(
    "/api/agent/benchmark-profile",
    jsonInit("POST", { classificationReport, phase: "analyze", classificationSource }),
  );
  if (!data?.report) throw new Error("对标账号分析 Agent 没有返回有效报告");
  return data.report as BenchmarkProfileReport;
};

export const listBenchmarkProfileReports = async (): Promise<SavedBenchmarkProfileReportSummary[]> => {
  const data = await request("/api/benchmark-profile-reports");
  return Array.isArray(data?.items) ? data.items as SavedBenchmarkProfileReportSummary[] : [];
};

export const getBenchmarkProfileReport = async (id: string): Promise<SavedBenchmarkProfileReport | null> => {
  const data = await request(idQuery("/api/benchmark-profile-reports", id));
  return (data?.item as SavedBenchmarkProfileReport) || null;
};

export const saveBenchmarkProfileReport = async (
  report: BenchmarkProfileReport,
): Promise<SavedBenchmarkProfileReportSummary> => {
  const data = await request("/api/benchmark-profile-reports", jsonInit("POST", { report }));
  if (!data?.item) throw new Error("保存对标账号分析报告失败：后端没有返回报告记录");
  return data.item as SavedBenchmarkProfileReportSummary;
};

export const deleteBenchmarkProfileReport = async (id: string): Promise<void> => {
  await request(idQuery("/api/benchmark-profile-reports", id), { method: "DELETE" });
};

// ---------- 客户名册（模块 2「账号定位」(1.3) 的第一份输入） ----------

/**
 * 客户名册（**只给元数据**）。
 *
 * 列表刻意不带 `ipProfile.interview.rawNotes`（实测一份就 4150 字）：调用方只是想
 * 「挑一个客户」，把全部访谈原文一起拖回来只会让列表白白变慢 —— 与报告接口
 * 「列表只给元数据、正文按 id 取」是同一条契约（§6.2⑥）。
 * 有没有档案看 `hasProfile`，填了几项看 `filledFieldCount`（19 项访谈清单）。
 */
export const listCustomers = async (): Promise<CustomerSummary[]> => {
  const data = await request("/api/customers");
  return Array.isArray(data?.items) ? data.items as CustomerSummary[] : [];
};

/** 按 id 取单个客户（含完整 `ipProfile` 与访谈原文）。列表不带这一份，选中某个客户时才调它。 */
export const getCustomer = async (id: string): Promise<CustomerDetail | null> => {
  const data = await request(idQuery("/api/customers", id));
  return (data?.item as CustomerDetail) || null;
};

// ---------- 模块 2　账号定位（1.3） ----------

/**
 * 跑 1.3 的分析 Agent，产出账号定位报告（一、IP定位 / 二、账号搭建 / 三、视频选题库）。
 *
 * 只有 `analyze` 一个阶段：1.3 不抓视频、不转写、不抓评论，两份输入都是现成的，
 * 一次调用就出报告，所以**没有** 1.2 那种前端驱动的分批循环。
 *
 * 两份输入的取法刻意不同：
 *   - **客户档案只按 id**：后端自己从 `customers` 集合读（公司共用名册，权限收口在端点层），
 *     前端没有机会伪造一份档案；
 *   - **1.2 报告优先用请求体里传进来的正文**（用户刚跑出来、还没保存的那一份也认），
 *     没传正文时才退回 `benchmarkProfileReportId` 按 id 读，并在报告里如实写明是哪种来源。
 */
export const analyzeAccountPlan = async (input: {
  customerId: string;
  benchmarkProfileReport?: BenchmarkProfileReport | null;
  benchmarkProfileReportId?: string;
}): Promise<AccountPlanReport> => {
  const data = await request("/api/agent/account-plan", jsonInit("POST", {
    customerId: input.customerId,
    benchmarkProfileReport: input.benchmarkProfileReport,
    benchmarkProfileReportId: input.benchmarkProfileReportId,
  }));
  if (!data?.report) throw new Error("账号定位 Agent 没有返回有效报告");
  return data.report as AccountPlanReport;
};

export const listAccountPlanReports = async (): Promise<SavedAccountPlanReportSummary[]> => {
  const data = await request("/api/account-plan-reports");
  return Array.isArray(data?.items) ? data.items as SavedAccountPlanReportSummary[] : [];
};

export const getAccountPlanReport = async (id: string): Promise<SavedAccountPlanReport | null> => {
  const data = await request(idQuery("/api/account-plan-reports", id));
  return (data?.item as SavedAccountPlanReport) || null;
};

export const saveAccountPlanReport = async (report: AccountPlanReport): Promise<SavedAccountPlanReportSummary> => {
  const data = await request("/api/account-plan-reports", jsonInit("POST", { report }));
  if (!data?.item) throw new Error("保存账号定位报告失败：后端没有返回报告记录");
  return data.item as SavedAccountPlanReportSummary;
};

export const deleteAccountPlanReport = async (id: string): Promise<void> => {
  await request(idQuery("/api/account-plan-reports", id), { method: "DELETE" });
};
