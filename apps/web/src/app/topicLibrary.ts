import { apiUrl, fetchWithRetry, parseApiJson } from "./api";

/**
 * 正式选题库与新视频筛选的客户端类型与接口。
 *
 * ── 业务口径（用户已拍板，见 HANDOFF §0.1）────────────────────────────────
 * 1. 正式库来自 **2.1 分类分析报告**，不是 1.3 的客户报告。
 * 2. 归属是**客户级**：一个客户一份库，可纳入多个对标账号。
 * 3. 多个账号的分类**各自独立保留、不合并**，且分类 id 一律带账号作用域，
 *    避免同名大类被误当成同一个。
 * 4. **落库靠人工点「保存入库」**；新视频列表的勾选只留在前端，不入库。
 */

export type TopicContentStyle = "spoken" | "drama";

/** 库里的一个小类。`id` 由后端加了账号作用域，全局唯一。 */
export type TopicLibrarySubcategory = {
  id: string;
  sourceId: string;
  name: string;
  description: string;
};

/**
 * 库里的一个大类。
 *
 * 口播大类带「核心功能 + 判断核心关键词」，演绎大类这两项为空 —— 用户明确要求
 * 这些判断依据要一起存，不能只存分类名称（HANDOFF §0.1 第 3 条）。
 */
export type TopicLibraryCategory = {
  id: string;
  sourceId: string;
  name: string;
  coreFunction: string;
  keywords: string[];
  count: number;
  percentage: number;
  subcategories: TopicLibrarySubcategory[];
};

/**
 * 库里某一项分析的纳入状态。
 *
 * 用户 2026-09-21 要求：正式选题库**不只纳入 2.1 分类报告，也要纳入 2.2 黄金三秒与
 * 2.3 结尾钩子**。取不到就如实标 `missing`，不拿别的报告顶替。
 */
export type TopicLibraryAnalysisStatus = "included" | "missing" | "sample_mismatch";

export type TopicLibraryAnalysis<TReport = unknown> = {
  status: TopicLibraryAnalysisStatus;
  /** 来源报告 id（0 表示没匹配到）。 */
  reportId: string;
  analyzedAt: string;
  /** 报告正文快照。 */
  report: TReport | null;
};

/** 一个账号在库里的**三份分析**。 */
export type TopicLibraryAnalyses = {
  classification: TopicLibraryAnalysis & { categories: TopicLibraryCategory[] };
  goldThreeSeconds: TopicLibraryAnalysis;
  endingHooks: TopicLibraryAnalysis;
};

/** 库里纳入的一个对标账号 —— 一个账号一棵独立分类树 + 三份分析快照。 */
export type TopicLibraryAccount = {
  accountKey: string;
  /** 来源追溯：这份库条目来自哪一份 2.1 分类报告。 */
  sourceReportId: string;
  accountName: string;
  accountUrl: string;
  platform: "douyin" | "tiktok";
  contentStyle: TopicContentStyle;
  contentStyleLabel: string;
  analyzedCount: number;
  analyses: TopicLibraryAnalyses;
  /** 兼容别名：等于 `analyses.classification.categories`。 */
  categories: TopicLibraryCategory[];
  addedAt: string;
};

/** 跨账号的扁平标签词典，新视频打标签时作为唯一词典来源。 */
export type TopicTagDictionaryEntry = {
  id: string;
  name: string;
  /** 带账号名前缀的显示名；只有一个账号时与 `name` 相同。 */
  label: string;
  coreFunction: string;
  keywords: string[];
  subcategories: Array<{ id: string; name: string; label: string }>;
};

export type TopicLibrary = {
  id: string;
  reportType: "topic_library";
  customerId: string;
  customerName: string;
  accountCount: number;
  accounts: TopicLibraryAccount[];
  createdAt: string;
  updatedAt: string;
};

/**
 * 列表接口的形状：**不带 `accounts` 正文**（分类树按 customerId 单取），
 * 只保留库级元数据 + 账号名。与分类报告列表「只给元数据」的契约一致。
 *
 * ⚠️ `accountCount` / `accountNames` 是**服务端加的**（列表投影排除了 `accounts`，
 * 数不到数组长度，所以服务端另外 `distinct` 一次账号名），不在 `TopicLibrary` 上。
 */
export type TopicLibrarySummary = Omit<TopicLibrary, "accounts"> & { accountNames: string[] };

export type TopicLibraryDetail = TopicLibrary & { tagDictionary: TopicTagDictionaryEntry[] };

/**
 * **轻量**视图：只要「打标签用的分类词典」，不含任何报告快照。
 *
 * 完整库正文里挂着每个账号的三份报告（2.1 分类 + 2.2 黄金三秒 + 2.3 结尾钩子），
 * 单份分类报告正文就约 148 KB —— 而员工端打标签只需要大类/小类名。
 * 走 `?view=categories` 就只取分类树那一支，首屏不再白等。
 */
export type TopicCategoryDictionary = {
  customerId: string;
  customerName: string;
  accountCount: number;
  updatedAt: string;
  tagDictionary: TopicTagDictionaryEntry[];
};

// ---------- 新视频筛选（近期更新选题标签）----------

export type TopicRefreshVideo = {
  id: string;
  title: string;
  link: string;
  authorName: string;
  publishDate: string;
  sourceText: string;
  platform: "douyin" | "tiktok" | "wechat_channels";
  stats: { likes: number; comments: number; shares: number; bookmarks: number };
  /**
   * 视频号专用：媒体直链与解密密钥。
   *
   * 视频号**没有分享链接**，媒体在 CDN 上且被 Isaac64 加密，必须靠 decodeKey 在本地
   * 解密后才能抽音频。所以它的转写路径与抖音不同 —— 见后端
   * `transcribeTargets` 里按 platform 分流。
   */
  mediaUrl?: string;
  decodeKey?: string;
};

export type TopicRefreshItem = {
  video: TopicRefreshVideo;
  /** 完整脚本；取不到转写时退回发布文案。 */
  script: string;
  scriptSource: "transcript" | "caption";
  category: { id: string; name: string };
  subcategory: { id: string; name: string };
  confidence: "high" | "medium" | "low";
  basis: string;
};

export type TopicRefreshReport = {
  version: string;
  reportType: "benchmark_topic_refresh";
  recentDays: number;
  minLikes: number;
  analyzedCount: number;
  transcriptCount: number;
  captionFallbackCount: number;
  categories: Array<{
    id: string;
    name: string;
    coreFunction: string;
    keywords: string[];
    subcategories: Array<{ id: string; name: string; description: string; topics: number }>;
  }>;
  items: TopicRefreshItem[];
  analysisSource: "agent" | "heuristic";
  warnings: Array<{ code?: string; error?: string; fallbackUsed?: boolean }>;
  analyzedAt: string;
};

// ---------- 接口客户端 ----------

/**
 * 与 reportApi 同一套约定：**一律不自动重试**（POST 重试会重复写入），
 * 列表只取元数据，正文按 id 单取。
 */
const parseApiError = async (response: Response) => {
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

const customerQuery = (path: string, customerId: string) =>
  `${path}?customerId=${encodeURIComponent(customerId)}`;

export const listTopicLibraries = async (): Promise<TopicLibrarySummary[]> => {
  const data = await request("/api/topic-libraries");
  return Array.isArray(data?.items) ? data.items as TopicLibrarySummary[] : [];
};

/** 按客户取完整库。这个客户还没建库时后端返回 404，这里转成 null 让调用方好判断。 */
export const getTopicLibrary = async (customerId: string): Promise<TopicLibraryDetail | null> => {
  try {
    const data = await request(customerQuery("/api/topic-libraries", customerId));
    return (data?.item as TopicLibraryDetail) || null;
  } catch (error) {
    if (error instanceof Error && /还没有正式选题库/.test(error.message)) return null;
    throw error;
  }
};

/**
 * 按客户取**轻量**词典（`?view=categories`）。
 *
 * 员工端「按库内分类打标签」用它 —— 只要大类/小类，不要把三份报告快照一起拖回来。
 * 这个客户还没建库时后端返回 404，这里转成 null 让调用方好判断（与 getTopicLibrary 一致）。
 */
export const getTopicCategoryDictionary = async (customerId: string): Promise<TopicCategoryDictionary | null> => {
  try {
    const data = await request(`${customerQuery("/api/topic-libraries", customerId)}&view=categories`);
    return (data?.item as TopicCategoryDictionary) || null;
  } catch (error) {
    if (error instanceof Error && /还没有正式选题库/.test(error.message)) return null;
    throw error;
  }
};

/** 建库 / 追加账号。同一份报告重复纳入是幂等的（后端按 accountKey 覆盖）。 */export const saveTopicLibraryAccount = async (
  customerId: string,
  report: unknown,
): Promise<TopicLibraryDetail> => {
  const data = await request("/api/topic-libraries", jsonInit("POST", { customerId, report }));
  if (!data?.item) throw new Error("保存选题库失败：后端没有返回选题库记录");
  return data.item as TopicLibraryDetail;
};

/**
 * 从库里移除单个对标账号。
 *
 * 返回值带 `libraryDeleted`：移掉**最后一个**账号时后端会把空壳库一起删掉，
 * 调用方要靠它决定是否撤掉「已完成」标记。
 */
export const removeTopicLibraryAccount = async (
  customerId: string,
  accountKey: string,
): Promise<{ removedAccount: boolean; libraryDeleted?: boolean }> => {
  const data = await request(
    `${customerQuery("/api/topic-libraries", customerId)}&action=remove-account`,
    jsonInit("POST", { customerId, accountKey }),
  );
  return { removedAccount: data?.removedAccount === true, libraryDeleted: data?.libraryDeleted === true };
};

export const deleteTopicLibrary = async (customerId: string): Promise<void> => {
  await request(customerQuery("/api/topic-libraries", customerId), { method: "DELETE" });
};

// ---------- 处理进度（会话）：刷新/离开再回来能续上 ----------

/**
 * 「新更新视频筛选与打标签」的一次处理进度。
 *
 * 打标签要几十秒到几分钟（转写 ~10-15s/条 + 模型固定开销 ~20s），
 * 只放在前端内存里的话，刷新一下这段时间与花的钱就全没了 —— 用户不敢走开，只能干等。
 * 所以候选列表与**判完的条目**都落库，回来直接续上（用户 2026-09-21 拍板 B2）。
 */
export type TopicRefreshSession = {
  customerId: string;
  accountUrl: string;
  recentDays: number;
  minLikes: number;
  /** 当时用的词典指纹（选题库改了以后旧标签可能不再适用，界面上给「重新打标签」入口） */
  dictionaryHash: string;
  videos: TopicRefreshVideo[];
  items: TopicRefreshItem[];
  updatedAt: string;
};

export const getTopicRefreshSession = async (customerId: string): Promise<TopicRefreshSession | null> => {
  const data = await request(`${customerQuery("/api/topic-refresh-sessions", customerId)}`);
  return (data?.item as TopicRefreshSession) || null;
};

/** 保存/替换本轮候选（**会清掉旧标签**，因为换了一批视频）。每次抓完新视频调一次。 */
export const saveTopicRefreshCandidates = async (payload: {
  customerId: string;
  accountUrl: string;
  recentDays: number;
  minLikes: number;
  videos: TopicRefreshVideo[];
}): Promise<void> => {
  await request("/api/topic-refresh-sessions", jsonInit("POST", payload));
};

export const clearTopicRefreshSession = async (customerId: string): Promise<void> => {
  await request(customerQuery("/api/topic-refresh-sessions", customerId), { method: "DELETE" });
};

// ---------- 新视频筛选 Agent ----------

export type TopicRefreshProgress = {
  total: number;
  ok: number;
  failed: number;
  attempted: number;
  finished: boolean;
  disabled?: boolean;
  pendingIds?: string[];
  /** 这一批逐条的结果。失败条目带 `error`，让界面能说清「为什么没成功」。 */
  batch?: Array<{
    videoId: string;
    status: "ok" | "failed";
    provider: string;
    durationMs: number;
    error?: string;
  }>;
};

/**
 * 转写下一批新视频的完整脚本。
 *
 * `scope` 在后端固定为 `script` —— 完整脚本**不能**复用黄金三秒的 `head` 缓存，
 * 否则 2.2 会拿到完整脚本去判断「开场三秒」（HANDOFF §6.6㉚）。
 *
 * ⚠️ **不需要传 `categories`**：转写只认视频链接，分类词典是后面打标签那一步的事。
 * 所以调用顺序可以是「先提脚本、再读库」（用户 2026-09-21 拍板）。
 */
export const transcribeTopicRefresh = async (payload: {
  videos: TopicRefreshVideo[];
  recentDays: number;
  minLikes: number;
}): Promise<TopicRefreshProgress> => {
  const data = await request("/api/agent/benchmark-topic-refresh", jsonInit("POST", { ...payload, phase: "transcribe" }));
  return (data?.progress as TopicRefreshProgress) || { total: 0, ok: 0, failed: 0, attempted: 0, finished: true };
};

export const analyzeTopicRefresh = async (payload: {
  videos: TopicRefreshVideo[];
  categories: unknown;
  recentDays: number;
  minLikes: number;
  /** 带上客户 id，后端会把这一批判完的条目落进「处理进度」，刷新后可续跑（B2）。 */
  customerId?: string;
}): Promise<TopicRefreshReport> => {
  const data = await request("/api/agent/benchmark-topic-refresh", jsonInit("POST", { ...payload, phase: "analyze" }));
  const report = data?.report as TopicRefreshReport | undefined;
  if (!report) throw new Error("新视频标签分析失败：后端没有返回报告");
  return report;
};
