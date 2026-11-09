import { apiUrl, fetchWithRetry } from "./api";
// 沿用全项目统一的接口错误口径（`reportApi.ts` 导出的那个）——
// 不要再写第二份 `parseApiError`，否则「success:false 也算失败」这条规则会两边漂移。
import { parseApiError } from "./reportApi";

/**
 * 发布仓的客户端接口（3.1 封面 / 3.2 发布文案 / 3.3 发布标签 + 持久化）。
 *
 * 沿用 `topicLibrary.ts` / `reportApi.ts` 的约定：
 *   - **不自动重试 Agent 调用**（一次调用可能几十秒，重试会让用户等两倍）；
 *   - 错误一律 `parseApiError`，把后端的可读消息透出来（不吞成「请求失败」）。
 */

/** 角度定义与后端 `publishWarehouse.js` 镜像。前端只用来渲染标签，不参与判定。 */
export const ACCOUNT_TAG_ANGLES = [
  { key: "track", label: "细分赛道" },
  { key: "painPoint", label: "用户核心痛点" },
  { key: "positioning", label: "内容核心定位" },
] as const;

export type PublishTopicLike = {
  id?: string;
  title?: string;
  link?: string;
  shareLink?: string;
  content?: {
    script?: string;
    scriptSource?: string;
    categoryName?: string;
    subcategoryName?: string;
  };
};

export type CoverBackground = {
  id: string;
  title: string;
  keywords: string[];
  prompt: string;
  reservedAreas: string[];
};

export type CoverTitleStyle = {
  fontFamily: string;
  fontSize: string;
  color: string;
  position: string;
  alignment: string;
  note: string;
};

export type CoverPlan = {
  ipPortrait: { outfitScene: string; expressionAction: string; prompt: string; basis: string };
  backgroundAnalysis: {
    artStyle: string; elements: string; layout: string; visualStyle: string;
    reservedAreas: string[]; summary: string;
  };
  titleStyle: CoverTitleStyle;
  backgrounds: CoverBackground[];
  summary: string;
};

export type PublishCopyKind = {
  kind: string;
  label: string;
  rule: string;
  /** `reuse` = 复用内容生成页已确认的标题/3s，不是 AI 现写的。 */
  source: "agent" | "reuse";
  options: string[];
};

export type PublishCopyResult = {
  items: PublishCopyKind[];
  missing: string[];
};

export type TagGroup = { key: string; label: string; quota: number; tags: string[] };

export type TopicTagsResult = {
  groups: TagGroup[];
  tags: string[];
  missing: string[];
};

export type AccountTagLibrary = {
  customerId: string;
  customerName: string;
  angles: Array<{ key: string; label: string; candidates: string[] }>;
  referenceTags: string[];
  summary: string;
};

export type CoverCandidate = {
  id: string;
  title: string;
  keywords: string[];
  prompt: string;
  image: { url: string; dataUrl: string };
  /** 出这张封面时用的是哪一类（换类型后旧封面仍保留并标出当时的类型）。 */
  tier?: string;
};

export type PublishSelection = {
  topicId: string;
  title: string;
  cover: { selectedId: string; candidates: CoverCandidate[]; titleStyle: CoverTitleStyle | null };
  publishCopy: { items: PublishCopyKind[]; selected: string[] };
  topicTags: { groups: TagGroup[]; selected: string[]; missing: string[] };
  updatedAt: string;
};

// ── 封面基底（账号级，3.1 三类共用）─────────────────────────────────────────

/**
 * 三类封面。**定义在后端**（`publishWarehouse.js` 的 `COVER_TIERS`），
 * 前端从 `?resource=cover-tiers` 读回来渲染 —— 不在这里再写一份清单（§6.3⑫）。
 */
export type CoverTier = {
  id: string;
  code: string;
  label: string;
  summary: string;
  whenToUse: string;
  /** 这条类型要不要一张固定人像。 */
  needsPortrait: boolean;
  /** 能不能用「IP 形象照」agent 产出/更新它（二类不用该 agent，沿用已有的那张）。 */
  canGeneratePortrait: boolean;
  /** 要不要「背景风格模板」（上传对标封面 → 拆解 → 生成模板）。 */
  needsBackgroundTemplate: boolean;
  /** 每条选题在这条类型下要人工确认哪些字段。 */
  perIssueFields: string[];
  note: string;
};

export type CoverAnalysis = {
  artStyle: string;
  elements: string;
  layout: string;
  visualStyle: string;
  reservedAreas: string[];
  summary: string;
};

export type TitleStyleTemplate = {
  fontFamily: string;
  /** **合法 CSS 颜色**（后端把模型的自然语言收敛过了；认不出时是空串）。 */
  color: string;
  /** 模型对颜色的**原话**（例如「白色、橙色，无描边或阴影」）—— 显示用，不能当 CSS。 */
  colorDescription?: string;
  position: string;
  alignment: string;
  note: string;
  /** 字号是**模板参数**：基准 / 下限 / 行数上限。逐条最终字号由后端现算。 */
  fontSizePx: number;
  minFontSizePx: number;
  maxLines: number;
  /** 旧数据可能只有这个字符串（没有数字字号），界面据此提示「待重新识别」。 */
  fontSize?: string;
};

export type ImageRef = { url: string; dataUrl: string };

export type CoverBase = {
  customerId: string;
  customerName: string;
  tier: string;
  /** 一类：上传的固定封面模板；二/三类：上传的对标封面（用于拆解）。 */
  sourceImage: ImageRef | null;
  analysis: CoverAnalysis;
  titleStyle: TitleStyleTemplate;
  /** 背景风格模板图。 */
  backgroundTemplate: ImageRef | null;
  backgroundPrompt: string;
  portrait: { prompt: string; basis: string; image: ImageRef | null };
  updatedAt: string;
};

export type TitleMetric = { title: string; fontSizePx: number; lines: number; shrunk: boolean };

const post = async <T,>(path: string, body: unknown, options: { retries?: number } = {}): Promise<T> => {
  const response = await fetchWithRetry(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  });
  const data = await parseApiError(response);
  return data as T;
};

const get = async <T,>(path: string): Promise<T> => {
  const response = await fetchWithRetry(apiUrl(path));
  const data = await parseApiError(response);
  return data as T;
};

// ── Agent 调用 ──────────────────────────────────────────────────────────────

export const requestCoverPlan = (payload: {
  customerId: string;
  topic: Record<string, unknown>;
  benchmarkCover?: unknown;
}) => post<{ plan: CoverPlan; imageGenerationAvailable: boolean }>("/api/agent/publish", {
  phase: "cover-plan",
  ...payload,
});

export const generateCoverImage = (payload: {
  prompt: string;
  referenceImages?: Array<{ url?: string; dataUrl?: string }>;
  size?: string;
  quality?: string;
  aspectRatio?: string;
}) => post<{ images: Array<{ url: string; dataUrl: string }>; model: string; elapsedMs: number }>(
  "/api/agent/publish",
  { phase: "cover-image", ...payload },
);

export const requestPublishCopy = (payload: {
  customerId: string;
  topic: Record<string, unknown>;
  reuseTitles: string[];
  reuseThreeSeconds: string[];
  accountTags?: string[];
}) => post<{ publishCopy: PublishCopyResult }>("/api/agent/publish", { phase: "publish-copy", ...payload });

export const requestAccountTags = (payload: { customerId: string; accountPlan?: unknown }) =>
  post<{ accountTags: AccountTagLibrary }>("/api/agent/publish", { phase: "account-tags", ...payload });

export const requestTopicTags = (payload: { customerId: string; topic: Record<string, unknown> }) =>
  post<{ topicTags: TopicTagsResult }>("/api/agent/publish", { phase: "topic-tags", ...payload });

// ── 封面基底的两个阶段（都不出图；出图仍走 cover-image）────────────────────

/** 拆解用户上传的对标封面图：画风 / 元素 / 排版 / 视觉风格 + 留白。**视觉模型，不花钱**。 */
export const analyzeBenchmarkCover = (payload: { image: { url?: string; dataUrl?: string } }) =>
  post<{ analysis: CoverAnalysis; titleStyle: TitleStyleTemplate; summary: string; imageGenerationAvailable: boolean }>(
    "/api/agent/publish",
    { phase: "cover-base-analysis", ...payload },
  );

/** IP 形象照的提示词建议（账号级；topic 由后端固定传空，不被某条选题影响）。 */
export const requestPortraitPlan = (payload: { customerId: string }) =>
  post<{ ipPortrait: { outfitScene: string; expressionAction: string; prompt: string; basis: string }; imageGenerationAvailable: boolean }>(
    "/api/agent/publish",
    { phase: "cover-portrait-plan", ...payload },
  );

/** 按基底里的标题样式，给候选标题算最终字号与行数（纯计算，无模型）。 */
export const requestCoverTitleMetrics = (payload: { titles: string[]; titleStyle: Partial<TitleStyleTemplate> }) =>
  post<{ items: TitleMetric[] }>("/api/agent/publish", { phase: "cover-title-metrics", ...payload });

/**
 * 用自然语言微调标题样式（用户口径：样式由视觉模型识别，之后用聊天框说怎么改）。
 * 纯文本调用，不出图。
 */
export const refineCoverStyle = (payload: {
  titleStyle: Partial<TitleStyleTemplate>;
  instruction: string;
  /** 视觉模型识别出来的原始描述 —— 用户常常是在否定它（「这不是书法体」）。 */
  recognized?: Record<string, unknown> | null;
  history?: Array<{ role: string; text: string }>;
}) => post<{ titleStyle: TitleStyleTemplate; reply: string }>("/api/agent/publish", { phase: "cover-style-refine", ...payload });

/**
 * 对话式改图：以**当前这张封面**为参考图重新出图，只改用户提到的部分。
 *
 * 与 `refineCoverStyle` 的区别：那个只改标题样式参数（纯文本，不重新出图）；
 * 这个会真的重新出一张图，所以慢（实测单张约 50s）且花钱。
 * 带上 `history`：用户常说「再亮一点」这类相对说法，没有上文模型不知道相对哪一版。
 */
export const refineCoverImage = (payload: {
  image: { url?: string; dataUrl?: string };
  instruction: string;
  history?: string[];
  title?: string;
  titleStyle?: Partial<TitleStyleTemplate> | null;
}) => post<{ images: Array<{ url: string; dataUrl: string }>; model: string; elapsedMs: number }>(
  "/api/agent/publish",
  { phase: "cover-refine-image", ...payload },
);

// ── 持久化 ──────────────────────────────────────────────────────────────────

export const listPublishSelections = async (customerId: string): Promise<PublishSelection[]> => {
  const data = await get<{ items: PublishSelection[] }>(
    `/api/publish-warehouse?customerId=${encodeURIComponent(customerId)}`,
  );
  return Array.isArray(data?.items) ? data.items : [];
};

export const savePublishSelection = async (payload: {
  customerId: string;
  topicId: string;
  title?: string;
  cover?: unknown;
  publishCopy?: unknown;
  topicTags?: unknown;
}): Promise<PublishSelection> => {
  const data = await post<{ item: PublishSelection }>("/api/publish-warehouse", payload, { retries: 0 });
  return data.item;
};

export const deletePublishSelection = (customerId: string, topicId?: string) =>
  fetchWithRetry(
    apiUrl(`/api/publish-warehouse?customerId=${encodeURIComponent(customerId)}${topicId ? `&topicId=${encodeURIComponent(topicId)}` : ""}`),
    { method: "DELETE" },
  ).then(parseApiError);

export const clearPublishSelections = (customerId: string) => deletePublishSelection(customerId);

export const getAccountTags = async (customerId: string): Promise<AccountTagLibrary | null> => {
  const data = await get<{ item: AccountTagLibrary | null }>(
    `/api/publish-warehouse?resource=account-tags&customerId=${encodeURIComponent(customerId)}`,
  );
  return data?.item || null;
};

export const saveAccountTags = async (payload: {
  customerId: string;
  customerName?: string;
  angleGroups: unknown;
  confirmed: unknown;
  referenceTags?: string[];
  summary?: string;
}): Promise<AccountTagLibrary> => {
  const data = await post<{ item: AccountTagLibrary }>("/api/publish-warehouse?resource=account-tags", payload);
  return data.item;
};

// ── 封面基底（账号级）───────────────────────────────────────────────────────

/** 三类封面的定义（后端 `COVER_TIERS`）。读一次缓存，不重复请求。 */
let coverTiersPromise: Promise<CoverTier[]> | null = null;
export const listCoverTiers = (): Promise<CoverTier[]> => {
  if (!coverTiersPromise) {
    coverTiersPromise = get<{ items: CoverTier[] }>("/api/publish-warehouse?resource=cover-tiers")
      .then(data => (Array.isArray(data?.items) ? data.items : []))
      .catch(error => {
        // 失败要允许重试：缓存住一个 rejected promise 会让整页永远读不到类型定义。
        coverTiersPromise = null;
        throw error;
      });
  }
  return coverTiersPromise;
};

export const getCoverBase = async (customerId: string): Promise<CoverBase | null> => {
  const data = await get<{ item: CoverBase | null }>(
    `/api/publish-warehouse?resource=cover-base&customerId=${encodeURIComponent(customerId)}`,
  );
  return data?.item || null;
};

export const saveCoverBase = async (payload: Partial<CoverBase> & { customerId: string; tier: string }): Promise<CoverBase> => {
  const data = await post<{ item: CoverBase }>("/api/publish-warehouse?resource=cover-base", payload);
  return data.item;
};

export const deleteCoverBase = (customerId: string) =>
  fetchWithRetry(
    apiUrl(`/api/publish-warehouse?resource=cover-base&customerId=${encodeURIComponent(customerId)}`),
    { method: "DELETE" },
  ).then(parseApiError);
