import { formatNumber } from "./benchmarkAnalysis";
import { profileLevelLabelOf, type BasisField, type ProfileEvidenceLevel } from "./benchmarkProfile";
import { safeDocxFileName, type DocxBlock } from "./docx";

/**
 * 模块 2「账号定位」(1.3) 的客户端类型与导出：一、IP定位 / 二、账号搭建 / 三、视频选题库（第一批）
 * 与 四、短视频内容框架 / 五、拍摄与剪辑建议 / 六、起号与运营（第二批）。
 *
 * ⚠️ 两批是**同一份报告**：第二批只是把章节从 3 节扩到 6 节（`ACCOUNT_PLAN_SECTIONS`），
 * 不新增报告类型、不新增存储、不新增接口。因此**第一批存下来的旧报告没有四 / 五 / 六** ——
 * 那三节在 `AccountPlanReport` 上是可选字段，界面与两个导出都必须 `?.` 兜住。
 *
 * 报告形状**完全由** `api/_lib/accountPlan.js` 的 `normalizeAccountPlan` 决定 —— 这里只做镜像：
 * 不新增字段、不重算条数与占比、不改证据等级。等级标签与配色一律复用
 * `benchmarkProfile.ts` 的 `profileLevelLabelOf` / `profileLevelToneOf`（§6.4⑲ 的兜底也在那边）。
 *
 * ⚠️ 与 1.2 一样，每个叙述字段都带 `level`：evidence（输入证据）/ inference（Agent 推断）/
 * manual（待人工补充）。本模块的数据格外稀疏（实测 5 个客户只有 1 个有 IP 档案，那一个的
 * `userProfile` 8 项还只填了 1 项），所以界面上会**大量**出现「待人工补充」与「Agent 推断」——
 * 那是后端的如实结果（见 `ipProfile.coverage` 与 `missingInputs`），不是功能坏了。
 * 界面必须把这些等级和「缺什么」一起显示出来，否则项目经理会把推断当成调研结论。
 */

export type AccountPlanEvidenceLevel = ProfileEvidenceLevel;

/** 一段带证据分级的叙述。形状与 1.2 的 `BasisField` 完全一致，直接复用同一个类型。 */
export type AccountPlanField = BasisField;

// ---------- 客户（模块 2 的第一份输入） ----------

/** 客户名册列表项（`GET /api/customers`）。**不含访谈原文**（§6.2⑥ 同一条契约）。 */
export type CustomerSummary = {
  id: string;
  name: string;
  occupation: string;
  /** 文档里到底有没有 `ipProfile`。全空档案也算「有」——所以还要看 `filledFieldCount`。 */
  hasProfile: boolean;
  profileStatus: string;
  /** 19 项访谈清单里已填的项数。为 0 时下游结论只能落推断或待人工补充。 */
  filledFieldCount: number;
};

/**
 * 单个客户（`GET /api/customers?id=`），含完整 `ipProfile`。
 *
 * 三个分组下的字段都是**去空白后的字符串**（后端 `normalizeIpProfile` 保证永不为 undefined），
 * 空串就是「客户没填」——不要拿它当线索去猜。分组的字段清单在后端
 * `IP_PROFILE_GROUPS`（唯一来源），这里按 `Record<string, string>` 收，避免把 19 个字段名抄第二遍。
 */
export type CustomerIpProfile = {
  status: string;
  schemaVersion: string;
  profileVersion: string;
  identity: Record<string, string>;
  product: Record<string, string>;
  userProfile: Record<string, string>;
  interview: {
    rawNotes: string;
    source: string;
    completedAt: string;
    rawNotesLength: number;
    rawNotesTruncated: boolean;
  };
  updatedAt: string;
  confirmedAt: string;
};

export type CustomerDetail = {
  id: string;
  name: string;
  occupation: string;
  contact: string;
  notes: string;
  /** 项目经理在名册里填的对接账号（换行分隔的抖音主页链接），用于自动挑 1.2 报告。 */
  benchmarkAccounts: string;
  ipPositioning: string;
  contentNeeds: string;
  hasProfile: boolean;
  ipProfile: CustomerIpProfile;
};

// ---------- 报告正文（`POST /api/agent/account-plan`） ----------

/** 目标人群的一个固定维度：结论的证据上限由它在档案里的来源字段决定（不变量②）。 */
export type AccountPlanAudienceDimension = AccountPlanField & {
  key: string;
  label: string;
  /** 档案里的来源字段路径，如 `userProfile.age`。档案里为空时这一行最多是推断。 */
  sourceKey: string;
  /** 档案里的原始取值；空串 = 客户没填，界面显示「档案未填写」。 */
  profileValue: string;
  note: string;
};

export type AccountPlanContentDirection = {
  name: string;
  description: string;
  basis: string[];
  level: AccountPlanEvidenceLevel;
  levelLabel: string;
};

/** 变现产品的四个层级口径（引流 → 信任 → 核心 → 利润），由后端随报告给。 */
export type AccountPlanTierGuide = { tier: string; role: string; pricing: string };

export type AccountPlanMonetizationProduct = {
  tier: string;
  product: string;
  /** 空串 = 输入里没有定价依据，界面要显示 `priceNote`，不许拿编造的价位顶替。 */
  price: string;
  priceNote: string;
  positioning: string;
  role: string;
  level: AccountPlanEvidenceLevel;
  levelLabel: string;
  basis: string[];
};

export type AccountPlanMonetizationStep = {
  step: number;
  description: string;
  /** 是否按「通过xx方法——使用户产生xx行为，购买/获得xx产品」书写；false 时必须显示 `patternNote`。 */
  patternOk: boolean;
  patternNote: string;
  level: AccountPlanEvidenceLevel;
  levelLabel: string;
  basis: string[];
};

export type AccountPlanBusinessPositioning = {
  targetAudience: AccountPlanField;
  audienceDimensions: AccountPlanAudienceDimension[];
  corePain: AccountPlanField;
  contentDirections: AccountPlanContentDirection[];
  monetization: {
    products: AccountPlanMonetizationProduct[];
    path: AccountPlanMonetizationStep[];
    note: string;
    tierGuide: AccountPlanTierGuide[];
  };
  summary: string;
};

/** 1.2 报告里的一个选题：库里通常只有 `{ id, title }`，所以 link / stats 常常是空的。 */
export type AccountPlanTopicStats = {
  likes?: number;
  comments?: number;
  shares?: number;
  bookmarks?: number;
};

export type AccountPlanClassificationTopic = {
  id: string;
  title: string;
  link: string;
  /** 没有互动数据时是 null（不是全 0）——编一个 0 会被读成「真实互动为 0」。 */
  stats: AccountPlanTopicStats | null;
};

export type AccountPlanClassificationSubcategory = {
  id: string;
  name: string;
  description: string;
  topics: AccountPlanClassificationTopic[];
  topicCount: number;
  percentage: number;
};

export type AccountPlanClassificationCategory = {
  id: string;
  name: string;
  /** 1.2 生成的两项，客户明确要求只在分析与定位中使用，透传时必须保留。 */
  coreFunction: string;
  keywords: string[];
  subcategories: AccountPlanClassificationSubcategory[];
  topics: AccountPlanClassificationTopic[];
  topicCount: number;
  percentage: number;
};

/** 「选题库建立」的正式产出 —— **原样透传 1.2 报告，不重跑分类**。 */
export type AccountPlanClassification = {
  source: string;
  contentStyle: string;
  contentStyleLabel: string;
  benchmarkSourceNote: string;
  benchmarkAnalyzedCount: number;
  sampleWindow: string;
  summary: string;
  categoryCount: number;
  subcategoryCount: number;
  topicTotal: number;
  /** 条数与占比由后端按 topics 重算的说明，界面要带出来（模型自填的数字一概不采信）。 */
  recomputeNote: string;
  categories: AccountPlanClassificationCategory[];
};

export type AccountPlanContentPositioning = {
  core: AccountPlanField;
  classification: AccountPlanClassification;
  frequentTags: Array<{ tag: string; count: number; percentage: number }>;
  frequentTagsNote: string;
  summary: string;
};

export type AccountPlanPersonalityKeyword = {
  keyword: string;
  expression: string;
  basis: string[];
  level: AccountPlanEvidenceLevel;
  levelLabel: string;
};

/** 三类 IP 记忆锚点：视觉 / 行为 / 语言。语言锚点额外带规格给的建议句式。 */
export type AccountPlanMemoryAnchor = {
  key: string;
  label: string;
  dimension: string;
  fits: string;
  /** 只有语言锚点有。 */
  template?: string;
  items: Array<{ text: string; basis: string[]; level: AccountPlanEvidenceLevel; levelLabel: string }>;
  count: number;
  note: string;
};

export type AccountPlanPersonaPositioning = {
  role: AccountPlanField;
  personality: {
    expectedCount: number;
    count: number;
    keywords: AccountPlanPersonalityKeyword[];
    note: string;
  };
  memoryAnchors: AccountPlanMemoryAnchor[];
  summary: string;
};

export type AccountPlanIpPositioning = {
  businessPositioning: AccountPlanBusinessPositioning;
  contentPositioning: AccountPlanContentPositioning;
  personaPositioning: AccountPlanPersonaPositioning;
};

export type AccountPlanTrioItem = AccountPlanField & { key: string; label: string; rule: string };

export type AccountPlanBioRow = {
  row: number;
  key: string;
  label: string;
  rule: string;
  /** 这一行的信息优先顺序（后端 `BIO_ROWS`）。 */
  priority: string[];
  candidates: Array<{ text: string; basis: string[]; level: AccountPlanEvidenceLevel; levelLabel: string }>;
  candidateCount: number;
  note: string;
};

export type AccountPlanBioPlatform = {
  key: string;
  label: string;
  rows: AccountPlanBioRow[];
  candidateCount: number;
};

export type AccountPlanSetup = {
  trio: AccountPlanTrioItem[];
  /** 客户照片不在 1.3 的输入里：头像只能给拍摄 / 着装建议。 */
  photoNote: string;
  bio: { platforms: AccountPlanBioPlatform[]; structureNote: string };
  summary: string;
};

export type AccountPlanTopicEntry = {
  title: string;
  angle: string;
  /** 只有「客户提问整理」这一组有：这条提问对应的客户痛点。 */
  painPoint: string;
  basis: string[];
  level: AccountPlanEvidenceLevel;
  levelLabel: string;
};

/** 热点条目：**整体上限 inference**（模型凭自身知识推断，无法联网核实）。 */
export type AccountPlanTrendEntry = {
  topic: string;
  titles: string[];
  titleCount: number;
  basis: string[];
  level: AccountPlanEvidenceLevel;
  levelLabel: string;
  timelinessNote: string;
  category: string;
};

export type AccountPlanSameTrackAccounts = {
  /** 恒为空数组：本步骤不抓取同赛道账号，模型给的一律丢弃。 */
  items: unknown[];
  count: number;
  /** 被丢弃的模型建议条数，如实带出来。 */
  discardedCount: number;
  level: AccountPlanEvidenceLevel;
  levelLabel: string;
  note: string;
};

export type AccountPlanTopicMethod = {
  key: string;
  label: string;
  /** 方法一（对标账号）独有：同赛道账号的人工补充位。 */
  sameTrackAccounts?: AccountPlanSameTrackAccounts;
  topics?: AccountPlanTopicEntry[];
  topicCount: number;
  duplicateCount?: number;
  /** 方法三（蹭热点）独有：按时事 / 政策 / 时间节点分组。 */
  groups?: Array<{ key: string; label: string; items: AccountPlanTrendEntry[]; count: number; note: string }>;
  /** 方法三独有：`HOT_TOPIC_DISCLAIMER`，必须显示出来。 */
  disclaimer?: string;
  note: string;
};

export type AccountPlanTopicLibrary = {
  methods: AccountPlanTopicMethod[];
  topicTotal: number;
  classificationTopicTotal: number;
  classificationTopicNote: string;
  summary: string;
};

// ---------- 第二批（四 / 五 / 六） ----------
//
// ⚠️ 下面三节在**第一批的报告里根本不存在**（同一份报告从 3 节扩到 6 节，不是新报告类型），
// 所以它们在 `AccountPlanReport` 上是可选字段，渲染时必须 `?.` + `|| []` 兜住。

/** 一条钩子的类型标签（后端权威清单：开头 8 种 / 结尾 5 种）。 */
export type AccountPlanHookType = {
  type: string;
  label: string;
  definition: string;
  example: string;
  strength: string;
};

export type AccountPlanHook = {
  type: string;
  typeLabel: string;
  definition: string;
  example: string;
  /** 可直接照念的文案 —— 不是「可以用提问开头」这类描述。 */
  text: string;
  reason: string;
  basis: string[];
  level: AccountPlanEvidenceLevel;
  levelLabel: string;
  /** 是否属于 1.2 统计出的对标账号常用类型；false 时是补充类型。 */
  benchmarkUsed: boolean;
  typeNote: string;
};

/** 一组钩子（开头 3 秒 / 结尾）。条数与丢弃数一律后端重算。 */
export type AccountPlanHookGroup = {
  key: string;
  label: string;
  requiredCount: number;
  count: number;
  hooks: AccountPlanHook[];
  types: AccountPlanHookType[];
  benchmarkAvailable: boolean;
  benchmarkTopTypes: Array<{ type: string; typeLabel: string; count: number; percentage: number }>;
  benchmarkMatchedCount: number;
  discardedCount: number;
  discarded: { unknownType: number; duplicateType: number; emptyText: number; overflow: number };
  discardedTypes: string[];
  discardedNote: string;
  typeNote: string;
  note: string;
};

export type AccountPlanContentFramework = {
  /** 钩子是创作建议、不是对该账号的观测 —— 这套说明必须显示出来。 */
  note: string;
  openingHooks: AccountPlanHookGroup;
  endingHooks: AccountPlanHookGroup;
  benchmarkReference: {
    threeSeconds: { available: boolean; itemCount: number; topTypes: AccountPlanHookGroup["benchmarkTopTypes"]; typeDistribution: AccountPlanHookGroup["benchmarkTopTypes"]; analysisReason: string; note: string };
    endingHooks: { available: boolean; itemCount: number; topTypes: AccountPlanHookGroup["benchmarkTopTypes"]; typeDistribution: AccountPlanHookGroup["benchmarkTopTypes"]; analysisReason: string; note: string };
    note: string;
  };
  summary: string;
};

/** 五 的一项：**最高只能是 inference**（输入里没有拍摄 / 剪辑数据）。 */
export type AccountPlanProductionItem = AccountPlanField & { key: string; label: string; rule: string };

export type AccountPlanProductionGroup = {
  key: string;
  label: string;
  requiredCount: number;
  count: number;
  items: AccountPlanProductionItem[];
  levelCap: string;
  note: string;
};

export type AccountPlanProduction = {
  /** 「基于人设与内容定位的建议，不是对该账号实际拍摄方式的观测」——必须显眼地渲染。 */
  note: string;
  levelCapNote: string;
  shooting: AccountPlanProductionGroup;
  editing: AccountPlanProductionGroup;
  summary: string;
};

export type AccountPlanTrafficScriptType = {
  key: string;
  label: string;
  rule: string;
  purpose: string;
  direction: string;
  scripts: Array<{ text: string; basis: string[]; level: AccountPlanEvidenceLevel; levelLabel: string }>;
  scriptCount: number;
  note: string;
};

/** 1.2 报告 operationStrategy 的原样透传：**等级沿用 1.2 自己的判定**，前端不重算。 */
export type AccountPlanBenchmarkPublishing = {
  available: boolean;
  videoCount: number;
  datedCount: number;
  spanDays: number;
  perWeek: number;
  weekdayDistribution: Array<{ weekday: string; count: number }>;
  hasTimeOfDay: boolean;
  note: string;
  analysis: string;
  level: AccountPlanEvidenceLevel;
  levelLabel: string;
  sourceNote: string;
  missingNote: string;
};

export type AccountPlanOperations = {
  note: string;
  platformStrategy: {
    primary: AccountPlanField;
    secondary: AccountPlanField;
    matchAnalysis: AccountPlanField;
    publish: {
      window: AccountPlanField;
      frequency: AccountPlanField;
      rhythmNote: string;
      benchmark: AccountPlanBenchmarkPublishing;
    };
    trafficScripts: {
      types: AccountPlanTrafficScriptType[];
      benchmark: {
        bio: { text: string; basis: string[]; level: AccountPlanEvidenceLevel; levelLabel: string; note: string };
        comments: { text: string; basis: string[]; level: AccountPlanEvidenceLevel; levelLabel: string; note: string };
        note: string;
      };
    };
    note: string;
  };
  /** 起号策略：`template: true` 表示这是**行业通用模板**，不是对这家客户的推断。 */
  launchPlan: {
    key: string;
    label: string;
    template: boolean;
    source: string;
    note: string;
    steps: Array<{ step: number; name: string; action: string }>;
    stepCount: number;
  };
  /** 数据复盘重点：同上，通用模板。 */
  reviewPlan: {
    key: string;
    label: string;
    template: boolean;
    source: string;
    note: string;
    dimensions: Array<{ key: string; label: string; focus: string }>;
    dimensionCount: number;
  };
  contentMix: {
    source: string;
    /** 占比由后端按大类重算（合计恰好 100），这里带出口径说明。 */
    recomputeNote: string;
    categories: string[];
    categoryCount: number;
    periods: Array<{
      key: string;
      label: string;
      rows: Array<{
        category: string;
        intent: string;
        intentLabel: string;
        weight: number;
        percentage: number;
        reason: string;
        basis: string[];
        level: AccountPlanEvidenceLevel;
        levelLabel: string;
        intentNote: string;
      }>;
      total: number;
      level: AccountPlanEvidenceLevel;
      levelLabel: string;
      discardedCount: number;
      discardedCategories: string[];
      discardedNote: string;
      note: string;
    }>;
    unmatchedCount: number;
    unmatchedNote: string;
    note: string;
  };
  summary: string;
};

/** 档案覆盖率（后端 `describeIpProfileCoverage` 的产出），缺哪些字段就看它。 */
export type AccountPlanCoverageEntry = {
  key: string;
  path: string;
  label: string;
  group: string;
  groupLabel: string;
  value: string;
};

export type AccountPlanCoverage = {
  filledCount: number;
  emptyCount: number;
  totalCount: number;
  filled: AccountPlanCoverageEntry[];
  empty: AccountPlanCoverageEntry[];
  hasAnyValue: boolean;
  note: string;
};

export type AccountPlanMissingInput = { key: string; label: string; note: string };

export type AccountPlanWarning = { code?: string; error?: string; fallbackUsed?: boolean };

export type AccountPlanReport = {
  version: string;
  reportType: "account_plan";
  batch: number;
  batchLabel: string;
  /** 本批产出的章节 key（第一批 3 个，第二批 6 个）。 */
  sections: string[];
  customer: {
    id: string;
    name: string;
    occupation: string;
    hasProfile: boolean;
    profileStatus: string;
    /** 名册里的原始诉求，原样带上供审核对照（**不**参与证据分级）。 */
    ipPositioning: string;
    contentNeeds: string;
    notes: string;
    benchmarkAccounts: string;
  };
  ipProfile: {
    status: string;
    schemaVersion: string;
    identity: Record<string, string>;
    product: Record<string, string>;
    userProfile: Record<string, string>;
    /** 访谈原文不落进报告（最长 6000 字），只记长度与截断标记。 */
    interview: { source: string; completedAt: string; rawNotesLength: number; rawNotesTruncated: boolean };
    coverage: AccountPlanCoverage;
    note: string;
  };
  benchmark: {
    reportId: string;
    reportType: string;
    accountName: string;
    accountUrl: string;
    contentStyle: string;
    contentStyleLabel: string;
    analyzedAt: string;
    /** 这份 1.2 报告是「本次请求传进来的」还是「按 id 从库里读的」——报告里如实写明。 */
    source: string;
    evidenceNote: string;
  };
  ipPositioning: AccountPlanIpPositioning;
  accountSetup: AccountPlanSetup;
  topicLibrary: AccountPlanTopicLibrary;
  /**
   * 四 / 五 / 六（第二批）。**第一批的旧报告没有这三节** —— 一律当可选字段处理，
   * 缺哪节就不渲染哪节，不要留空壳（否则旧报告看起来像「生成失败」）。
   */
  contentFramework?: AccountPlanContentFramework;
  production?: AccountPlanProduction;
  operations?: AccountPlanOperations;
  missingInputs: AccountPlanMissingInput[];
  dataCoverage: {
    profileFilledFieldCount: number;
    profileTotalFieldCount: number;
    profileHasAnyValue: boolean;
    interviewRawNotesLength: number;
    audienceDimensionFilledCount: number;
    benchmarkCategoryCount: number;
    benchmarkSubcategoryCount: number;
    benchmarkTopicTotal: number;
    benchmarkFrequentTagCount: number;
    producedSectionCount: number;
    producedSections: string[];
    topicCount: { benchmark: number; questions: number; trends: number; total: number };
    /** 第二批的覆盖率（旧报告没有这几项）。 */
    openingHookCount?: number;
    endingHookCount?: number;
    hookDiscardedCount?: number;
    productionItemCount?: number;
    contentMixPeriodCount?: number;
  };
  analysisSource: "agent" | "heuristic";
  warnings: AccountPlanWarning[];
  analyzedAt: string;
};

/** 保存后列表里返回的元数据（`accountPlanStore.serializeSummary`，**不带正文**）。 */
export type SavedAccountPlanReportSummary = {
  id: string;
  reportType: "account_plan";
  customerId: string;
  customerName: string;
  benchmarkAccountName: string;
  contentStyle: string;
  batch: number;
  /** 1.3 的「分析了多少条」存的是**产出章节数**（0~3），不是样本数。 */
  analyzedCount: number;
  createdAt: string;
};

export type SavedAccountPlanReport = SavedAccountPlanReportSummary & { report: AccountPlanReport };

/**
 * 前端的分节标题。
 *
 * ⚠️ 与后端 `ACCOUNT_PLAN_SECTIONS`（`api/_lib/accountPlan.js`）**一一对应**：那边是后端 .js，
 * 浏览器里引不进来（它连带引入 MongoDB 层），所以这里镜像一份。改章节名时两处一起改。
 */
export const ACCOUNT_PLAN_SECTION_LABELS = {
  ipPositioning: "一、IP定位",
  accountSetup: "二、账号搭建",
  topicLibrary: "三、视频选题库",
  framework: "四、短视频内容框架",
  production: "五、拍摄与剪辑建议",
  operations: "六、起号与运营",
} as const;

const asText = (value: unknown) => String(value ?? "").trim();

const isReviewCategory = (name: string) => asText(name) === "待人工复核";

/**
 * 与 `benchmarkProfile.ts` 的 `basisLine` 是**同一套实现**。
 *
 * 那边没有导出它，而本批不改 1.2 那个已验收的文件（与 `accountPlan.js` 顶部对
 * 同名助手重复一份的理由完全一样），所以这里再写一份。**改动时两处必须同步** ——
 * 两边都是「导出文档里那一行证据怎么写」，漂移了就会出现两份口径不同的报告。
 */
const basisLine = (field?: AccountPlanField | null) => {
  if (!field || !field.text) return "待人工补充";
  const basis = field.basis?.length ? `（依据：${field.basis.join("；")}）` : "";
  return `${field.text}${basis}｜${field.levelLabel || profileLevelLabelOf(field.level)}`;
};

/**
 * 互动数据：读不到就不写（绝不补 0），四项全空时整行不出现。
 * 1.2 的选题在库里通常只剩 `{ id, title }`，所以这一行大多数时候是空的。
 * 导出（Markdown / Word）与界面共用它，三处不会出现两种口径。
 */
export const accountPlanTopicStatsLine = (stats?: AccountPlanTopicStats | null) => {
  const source = stats || {};
  const read = (key: keyof AccountPlanTopicStats) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return [
    read("likes") ? `点赞 ${formatNumber(read("likes"))}` : "",
    read("comments") ? `评论 ${formatNumber(read("comments"))}` : "",
    read("shares") ? `分享 ${formatNumber(read("shares"))}` : "",
    read("bookmarks") ? `收藏 ${formatNumber(read("bookmarks"))}` : "",
  ].filter(Boolean).join(" · ");
};

/** 等级 + 引文，用在没有 `basisLine` 那种「字段」形状的条目上（方向 / 候选 / 选题 / 锚点）。 */
const gradedLine = (item: { text?: string; name?: string; title?: string; basis?: string[]; level?: string; levelLabel?: string }) => {
  const text = asText(item.text || item.name || item.title);
  const basis = (item.basis || []).filter(Boolean);
  const parts = [text || "待人工补充"];
  if (basis.length > 0) parts.push(`（依据：${basis.join("；")}）`);
  parts.push(`｜${item.levelLabel || profileLevelLabelOf(String(item.level || "manual"))}`);
  return parts.join("");
};

/** 导出文件名前缀，Markdown 与 Word 共用，避免两边各拼一次。 */
const accountPlanTitleOf = (report: AccountPlanReport) => {
  const customer = asText(report?.customer?.name) || "未命名客户";
  const account = asText(report?.benchmark?.accountName) || "未识别对标账号";
  return `${customer} × ${account}`;
};

/**
 * 导出成 Markdown，供项目经理复制到文档里。
 *
 * 与 1.2 的 `formatBenchmarkProfileMarkdown` 同一口径：**如实标注每个字段的证据等级**，
 * 并先把「缺了哪些输入」写在最前面 —— 1.3 的大部分字段天生没有档案依据，
 * 不写清楚「为什么这么多待人工补充」，拿到文档的人只会以为报告没生成完。
 */
export const formatAccountPlanMarkdown = (report: AccountPlanReport) => {
  const customer = report?.customer || ({} as AccountPlanReport["customer"]);
  const benchmark = report?.benchmark || ({} as AccountPlanReport["benchmark"]);
  const coverage = report?.ipProfile?.coverage;
  const business = report?.ipPositioning?.businessPositioning;
  const content = report?.ipPositioning?.contentPositioning;
  const persona = report?.ipPositioning?.personaPositioning;
  const setup = report?.accountSetup;
  const topics = report?.topicLibrary;

  const lines = [
    `# 账号定位｜${accountPlanTitleOf(report)}`,
    "",
    `- 客户：${customer.name || "未命名客户"}${customer.occupation ? `（${customer.occupation}）` : ""}`,
    `- 对标账号：${benchmark.accountName || "未识别对标账号"}${benchmark.accountUrl ? `（${benchmark.accountUrl}）` : ""}`,
    `- 1.2 报告来源：${benchmark.source || "未记录"}`,
    `- 本批章节：${report?.batchLabel || "未记录"}`,
    `- IP 档案覆盖率：已填 ${coverage?.filledCount ?? 0} 项 / 共 ${coverage?.totalCount ?? 0} 项（空 ${coverage?.emptyCount ?? 0} 项）`,
    coverage?.note ? `- ${coverage.note}` : "",
    `- 分析时间：${report?.analyzedAt ? new Date(report.analyzedAt).toLocaleString("zh-CN") : "未知"}`,
    `- 分析来源：${report?.analysisSource === "agent" ? "Agent 分析" : "规则兜底"}`,
    "",
  ].filter(line => line !== "");

  // 先把「缺什么」写在正文之前：这是下面大量「待人工补充」的直接原因。
  const missingInputs = report?.missingInputs || [];
  if (missingInputs.length > 0) {
    lines.push("## 缺失输入", ...missingInputs.map(item => `- ${item.label || item.key}：${item.note || ""}`.trim()), "");
  }
  const warnings = report?.warnings || [];
  if (warnings.length > 0) {
    lines.push("## 自动告警", ...warnings.map(item => `- ${item.code ? `[${item.code}] ` : ""}${item.error || ""}`.trim()), "");
  }
  const originalRequests = [
    customer.ipPositioning ? `- 账号定位：${customer.ipPositioning}` : "",
    customer.contentNeeds ? `- 内容需求：${customer.contentNeeds}` : "",
    customer.notes ? `- 备注：${customer.notes}` : "",
    customer.benchmarkAccounts ? `- 名册里登记的对标账号：${customer.benchmarkAccounts.replace(/\s*\n\s*/g, "、")}` : "",
  ].filter(Boolean);
  if (originalRequests.length > 0) {
    lines.push("## 客户名册里的原始诉求", ...originalRequests, "");
  }

  // ── 一、IP定位 ────────────────────────────────────────────────────────────
  lines.push("## 一、IP定位", "", "### 1、商业定位");
  lines.push(`- 目标人群：${basisLine(business?.targetAudience)}`);
  lines.push("", "#### 目标人群维度", "", "| 维度 | 档案里的值 | 结论 | 证据等级 |", "| --- | --- | --- | --- |");
  (business?.audienceDimensions || []).forEach(item => {
    lines.push(`| ${item.label || item.key || "-"} | ${item.profileValue || "档案未填写"} | ${item.text || item.note || "待人工补充"} | ${item.levelLabel || profileLevelLabelOf(item.level)} |`);
  });
  lines.push(`- 核心痛点：${basisLine(business?.corePain)}`);
  if ((business?.contentDirections || []).length > 0) {
    lines.push("- 核心内容方向：");
    (business?.contentDirections || []).forEach(item => lines.push(`  - ${gradedLine(item)}${item.description ? `　${item.description}` : ""}`));
  } else {
    lines.push("- 核心内容方向：待人工补充");
  }
  lines.push("", "#### 变现转化", "", "| 层级 | 产品 | 定价 | 定位 | 在变现路径中的作用 | 证据等级 |", "| --- | --- | --- | --- | --- | --- |");
  (business?.monetization?.products || []).forEach(item => {
    lines.push(`| ${item.tier || "-"} | ${item.product || "-"} | ${item.price || item.priceNote || "待人工补充"} | ${item.positioning || "-"} | ${item.role || "-"} | ${item.levelLabel || profileLevelLabelOf(item.level)} |`);
  });
  (business?.monetization?.tierGuide || []).forEach(item => {
    lines.push(`- 层级口径｜${item.tier}：${item.role}（${item.pricing}）`);
  });
  if ((business?.monetization?.path || []).length > 0) {
    lines.push("", "#### 变现路径");
    (business?.monetization?.path || []).forEach(item => {
      lines.push(`${item.step}. ${item.description || ""}`);
      if (item.patternOk === false) lines.push(`   - ⚠️ ${item.patternNote || "未按标准句式书写，需人工改写。"}`);
    });
  }
  if (business?.monetization?.note) lines.push("", `> ${business.monetization.note}`);

  lines.push("", "### 2、内容定位");
  lines.push(`- 核心内容定位：${basisLine(content?.core)}`);
  const classification = content?.classification;
  if (classification) {
    lines.push(`- 选题库：${classification.source || "原样透传 1.2 报告"}（大类 ${classification.categoryCount ?? 0} 个 / 小类 ${classification.subcategoryCount ?? 0} 个 / 选题 ${classification.topicTotal ?? 0} 条）`);
    if (classification.recomputeNote) lines.push(`- ${classification.recomputeNote}`);
    if (classification.summary) lines.push(`- 分类概括：${classification.summary}`);
    (classification.categories || []).forEach(category => {
      lines.push("", `#### 大类｜${category.name || "未命名大类"}（${category.topicCount ?? 0} 条 · ${category.percentage ?? 0}%）`);
      if (category.coreFunction) lines.push(`- 核心功能：${category.coreFunction}`);
      if ((category.keywords || []).length > 0) lines.push(`- 判断关键词：${category.keywords.join("、")}`);
      (category.subcategories || []).forEach(subcategory => {
        lines.push(`- 小类｜${subcategory.name || "未命名小类"}（${subcategory.topicCount ?? 0} 条）${subcategory.description ? `：${subcategory.description}` : ""}`);
        (subcategory.topics || []).forEach(topic => {
          const stats = accountPlanTopicStatsLine(topic.stats);
          lines.push(`  - ${topic.title || "未命名选题"}${topic.link ? `（${topic.link}）` : ""}${stats ? `｜${stats}` : ""}`);
        });
      });
    });
  }
  if ((content?.frequentTags || []).length > 0) {
    lines.push("", `#### 高频标签（${content.frequentTagsNote || "来自 1.2 报告，原样透传"}）`);
    content.frequentTags.forEach(item => lines.push(`- #${String(item.tag || "").replace(/^#+/, "")}（${item.count ?? 0} 条 · ${item.percentage ?? 0}%）`));
  }

  lines.push("", "### 3、人设定位");
  lines.push(`- 角色定位：${basisLine(persona?.role)}`);
  const personality = persona?.personality;
  if (personality) {
    lines.push(`- 性格关键词（${personality.count ?? 0}/${personality.expectedCount ?? 0}）：`);
    if ((personality.keywords || []).length === 0) lines.push("  - 待人工补充");
    (personality.keywords || []).forEach(item => {
      lines.push(`  - ${item.keyword}${item.expression ? `：${item.expression}` : ""}｜${item.levelLabel || profileLevelLabelOf(item.level)}`);
    });
    if (personality.note) lines.push(`  - ${personality.note}`);
  }
  (persona?.memoryAnchors || []).forEach(anchor => {
    lines.push(`- ${anchor.label}（${anchor.dimension} · 对应${anchor.fits}）：`);
    if ((anchor.items || []).length === 0) lines.push(`  - ${anchor.note || "本类锚点暂无内容，待人工补充。"}`);
    (anchor.items || []).forEach(item => lines.push(`  - ${gradedLine(item)}`));
    if (anchor.template) lines.push(`  - 建议句式：${anchor.template}`);
  });

  // ── 二、账号搭建 ──────────────────────────────────────────────────────────
  lines.push("", "## 二、账号搭建", "", "### 1、账号三件套");
  (setup?.trio || []).forEach(item => {
    lines.push(`- ${item.label}（${item.rule}）：${basisLine(item)}`);
  });
  lines.push(`- 客户照片：${setup?.photoNote || "输入里没有客户照片。"}`);

  lines.push("", "### 2、账号简介");
  if (setup?.bio?.structureNote) lines.push(`- 结构：${setup.bio.structureNote}`);
  (setup?.bio?.platforms || []).forEach(platform => {
    lines.push("", `#### ${platform.label}（共 ${platform.candidateCount ?? 0} 条候选）`);
    (platform.rows || []).forEach(row => {
      lines.push(`- 第${row.row}行 ${row.label}${row.rule ? `（${row.rule}）` : ""}`);
      if ((row.priority || []).length > 0) lines.push(`  - 优先顺序：${row.priority.join(" → ")}`);
      if ((row.candidates || []).length === 0) lines.push(`  - ${row.note || "本行暂无候选，待人工补充。"}`);
      (row.candidates || []).forEach(candidate => lines.push(`  - ${gradedLine(candidate)}`));
    });
  });

  // ── 三、视频选题库 ────────────────────────────────────────────────────────
  lines.push("", "## 三、视频选题库");
  lines.push(`- 共 ${topics?.topicTotal ?? 0} 条；其中 1.2 分类选题库 ${topics?.classificationTopicTotal ?? 0} 条。${topics?.classificationTopicNote || ""}`);
  (topics?.methods || []).forEach(method => {
    lines.push("", `### ${method.label || method.key}（${method.topicCount ?? 0} 条）`);
    if (method.note) lines.push(`- ${method.note}`);
    if (method.duplicateCount) lines.push(`- 已按标题去重 ${method.duplicateCount} 条重复项。`);
    // 方法一：同赛道对标账号。有客户名册登记时会填充，没有则是人工补充位 ——
    // 两种情况都如实说明；模型给的账号后端已全部丢弃。
    if (method.sameTrackAccounts) {
      const sameTrack = method.sameTrackAccounts;
      lines.push(`- 同赛道对标账号（${sameTrack.levelLabel || profileLevelLabelOf(sameTrack.level)}）：${sameTrack.note || ""}`);
      // ⚠️ 已填充时必须把账号**本身**列出来。
      // 只打印 note 的话，导出的文档里一个链接都没有 —— 而这一节的价值就在于这些账号。
      (sameTrack.items || []).forEach(item => {
        const title = typeof item === "string" ? item : String(item?.title || "");
        const url = typeof item === "string" ? "" : String(item?.url || "");
        if (title || url) lines.push(`  - ${title}${url ? `：${url}` : ""}`);
      });
      if (sameTrack.discardedCount > 0) {
        lines.push(`- 本次丢弃了 ${sameTrack.discardedCount} 条无法核对的账号建议。`);
      }
    }
    (method.topics || []).forEach(item => {
      lines.push(`- ${item.title}${item.painPoint ? `（对应痛点：${item.painPoint}）` : ""}${item.angle ? `（角度：${item.angle}）` : ""}｜${item.levelLabel || profileLevelLabelOf(item.level)}`);
      if ((item.basis || []).length > 0) lines.push(`  - 依据：${item.basis.join("；")}`);
    });
    // 方法三：热点是模型推断的，时效性提示必须跟着走。
    if (method.disclaimer) lines.push("", `> ${method.disclaimer}`);
    (method.groups || []).forEach(group => {
      lines.push("", `#### ${group.label}（${group.count ?? 0} 条）`);
      if ((group.items || []).length === 0) lines.push(`- ${group.note || "本组暂无内容，待人工补充。"}`);
      (group.items || []).forEach(item => {
        lines.push(`- ${item.topic}｜${item.levelLabel || profileLevelLabelOf(item.level)}`);
        (item.titles || []).forEach(title => lines.push(`  - 标题示例：${title}`));
      });
    });
  });
  if (topics?.summary) lines.push("", `> ${topics.summary}`);

  // ── 四、短视频内容框架（第二批；旧报告没有这一节，下面整段跳过）────────────────
  const framework = report?.contentFramework;
  if (framework) {
    lines.push("", "## 四、短视频内容框架");
    if (framework.note) lines.push(`> ${framework.note}`);
    ([framework.openingHooks, framework.endingHooks].filter(Boolean) as AccountPlanHookGroup[]).forEach((group, groupIndex) => {
      lines.push("", `### ${groupIndex === 0 ? "1" : "2"}、${group.label || ""}（${group.count ?? 0}/${group.requiredCount ?? 0} 种类型）`);
      if (group.typeNote) lines.push(`- ${group.typeNote}`);
      if (group.discardedCount > 0) lines.push(`- ${group.discardedNote || ""}（丢弃 ${group.discardedCount} 条）`.trim());
      (group.hooks || []).forEach(hook => {
        lines.push(`- 【${hook.typeLabel || hook.type || "未标类型"}】${hook.text || "待人工补充"}｜${hook.levelLabel || profileLevelLabelOf(hook.level)}`);
        if (hook.reason) lines.push(`  - 理由：${hook.reason}`);
        if (hook.definition) lines.push(`  - 类型口径：${hook.definition}`);
        if ((hook.basis || []).length > 0) lines.push(`  - 依据：${hook.basis.join("；")}`);
        if (hook.typeNote) lines.push(`  - 类型说明：${hook.typeNote}`);
      });
      if ((group.hooks || []).length === 0) lines.push(`- ${group.note || "本组暂无钩子，待人工补充。"}`);
      if (group.note && (group.hooks || []).length > 0) lines.push(`- ${group.note}`);
      if (group.benchmarkTopTypes?.length > 0) {
        lines.push(`- 1.2 里对标账号最常用的类型：${group.benchmarkTopTypes.map(item => `${item.typeLabel}（${item.count} 条 · ${item.percentage}%）`).join("、")}`);
      }
    });
    if (framework.summary) lines.push("", `> ${framework.summary}`);
  }

  // ── 五、拍摄与剪辑建议（第二批）─────────────────────────────────────────────
  const production = report?.production;
  if (production) {
    lines.push("", "## 五、拍摄与剪辑建议");
    // ⚠️ 这一句是硬要求：本节没有输入数据，是建议不是观测，导出文档里也必须写清楚。
    if (production.note) lines.push(`> ${production.note}`);
    if (production.levelCapNote) lines.push(`> ${production.levelCapNote}`);
    ([production.shooting, production.editing].filter(Boolean) as AccountPlanProductionGroup[]).forEach((group, groupIndex) => {
      lines.push("", `### ${groupIndex === 0 ? "1" : "2"}、${group.label || ""}（${group.count ?? 0}/${group.requiredCount ?? 0} 项）`);
      (group.items || []).forEach(item => {
        lines.push(`- ${item.label || item.key}（${item.rule || ""}）：${item.text || "待人工补充"}｜${item.levelLabel || profileLevelLabelOf(item.level)}`);
        if ((item.basis || []).length > 0) lines.push(`  - 依据：${item.basis.join("；")}`);
      });
      if (group.note) lines.push(`- ${group.note}`);
    });
    if (production.summary) lines.push("", `> ${production.summary}`);
  }

  // ── 六、起号与运营（第二批）─────────────────────────────────────────────────
  const operations = report?.operations;
  if (operations) {
    const platform = operations.platformStrategy;
    lines.push("", "## 六、起号与运营");
    if (operations.note) lines.push(`> ${operations.note}`);
    lines.push("", "### 1、平台与矩阵策略");
    if (platform?.note) lines.push(`- ${platform.note}`);
    lines.push(`- 主阵地：${basisLine(platform?.primary)}`);
    lines.push(`- 辅阵地：${basisLine(platform?.secondary)}`);
    lines.push(`- 匹配分析：${basisLine(platform?.matchAnalysis)}`);
    lines.push(`- 发布时间段：${basisLine(platform?.publish?.window)}`);
    lines.push(`- 发布频率：${basisLine(platform?.publish?.frequency)}`);
    if (platform?.publish?.rhythmNote) lines.push(`- 节奏说明：${platform.publish.rhythmNote}`);
    // 1.2 的发布节奏原样带出来，等级沿用 1.2 自己的判定。
    const publishing = platform?.publish?.benchmark;
    if (publishing) {
      lines.push(`- 1.2 实测发布节奏（${publishing.levelLabel || profileLevelLabelOf(publishing.level)}）：样本 ${publishing.videoCount ?? 0} 条 · 有日期 ${publishing.datedCount ?? 0} 条 · 跨度 ${publishing.spanDays ?? 0} 天 · 约 ${publishing.perWeek ?? 0} 条/周`);
      if (publishing.note) lines.push(`  - ${publishing.note}`);
      if (publishing.analysis) lines.push(`  - 节奏分析：${publishing.analysis}`);
      if (publishing.sourceNote) lines.push(`  - ${publishing.sourceNote}`);
      if (!publishing.available && publishing.missingNote) lines.push(`  - ${publishing.missingNote}`);
    }
    lines.push("", "### 2、引流话术");
    (platform?.trafficScripts?.types || []).forEach(item => {
      lines.push(`- ${item.label || item.key}（${item.scriptCount ?? 0} 条）`);
      if (item.purpose) lines.push(`  - 目的：${item.purpose}`);
      if (item.direction) lines.push(`  - 引流导向：${item.direction}`);
      if ((item.scripts || []).length === 0) lines.push(`  - ${item.note || "这一类暂无可直接使用的话术，待人工补充。"}`);
      (item.scripts || []).forEach(script => lines.push(`  - ${gradedLine({ text: script.text, basis: script.basis, level: script.level, levelLabel: script.levelLabel })}`));
    });
    const benchmarkScripts = platform?.trafficScripts?.benchmark;
    if (benchmarkScripts) {
      lines.push(`- 1.2 报告的引流话术（${benchmarkScripts.note || ""}）`);
      lines.push(`  - 简介：${basisLine({ text: benchmarkScripts.bio?.text, basis: benchmarkScripts.bio?.basis, level: benchmarkScripts.bio?.level, levelLabel: benchmarkScripts.bio?.levelLabel } as AccountPlanField)}`);
      lines.push(`  - 评论区：${basisLine({ text: benchmarkScripts.comments?.text, basis: benchmarkScripts.comments?.basis, level: benchmarkScripts.comments?.level, levelLabel: benchmarkScripts.comments?.levelLabel } as AccountPlanField)}`);
    }

    // 起号策略 / 数据复盘：**通用模板**，marker 与 note 必须出现在导出文档里。
    const launch = operations.launchPlan;
    if (launch) {
      lines.push("", `### 3、${launch.label || "起号策略"}${launch.template ? "（通用模板，非针对该客户的推断）" : ""}`, "");
      if (launch.note) lines.push(`> ${launch.note}`);
      if (launch.source) lines.push(`> 来源：${launch.source}`);
      lines.push("", "| 步骤 | 具体操作 |", "| --- | --- |");
      (launch.steps || []).forEach(step => lines.push(`| ${step.step}. ${step.name || ""} | ${step.action || ""} |`));
    }
    const review = operations.reviewPlan;
    if (review) {
      lines.push("", `### 4、${review.label || "数据复盘重点"}${review.template ? "（通用模板，非针对该客户的推断）" : ""}`, "");
      if (review.note) lines.push(`> ${review.note}`);
      if (review.source) lines.push(`> 来源：${review.source}`);
      lines.push("", "| 复盘维度 | 关注什么 |", "| --- | --- |");
      (review.dimensions || []).forEach(item => lines.push(`| ${item.label || item.key} | ${item.focus || ""} |`));
    }

    // 内容配比：占比由后端按大类重算（每个时期合计恰好 100）。
    const mix = operations.contentMix;
    if (mix) {
      lines.push("", "### 5、内容配比");
      if (mix.source) lines.push(`- ${mix.source}`);
      if (mix.recomputeNote) lines.push(`- ${mix.recomputeNote}`);
      if (mix.unmatchedCount > 0) lines.push(`- ${mix.unmatchedNote}`);
      if (mix.note) lines.push(`- ${mix.note}`);
      (mix.periods || []).forEach(period => {
        lines.push("", `#### ${period.label || period.key}（合计 ${period.total ?? 0}%）｜${period.levelLabel || profileLevelLabelOf(period.level)}`);
        if ((period.rows || []).length === 0) lines.push(`- ${period.note || "配比待人工补充。"}`);
        if ((period.rows || []).length > 0) {
          lines.push("", "| 内容大类 | 比重意图 | 占比 | 理由 | 证据等级 |", "| --- | --- | --- | --- | --- |");
          (period.rows || []).forEach(row => {
            lines.push(`| ${row.category} | ${row.intentLabel || "-"} | ${row.percentage ?? 0}% | ${row.reason || "-"}${row.intentNote ? `（${row.intentNote}）` : ""} | ${row.levelLabel || profileLevelLabelOf(row.level)} |`);
          });
        }
        if (period.discardedCount > 0) lines.push(`- ${period.discardedNote || ""}`);
      });
    }
    if (operations.summary) lines.push("", `> ${operations.summary}`);
  }

  return lines.join("\n");
};

/**
 * 导出成 Word（.docx）的块列表，交给 `docx.ts` 渲染。
 *
 * ⚠️ 本函数与上面的 `formatAccountPlanMarkdown` **刻意互为镜像**：章节、顺序、字段与
 * 证据口径必须逐条一致，两边只是载体不同（Markdown 文本 / Word 块）。**改其中一处必须同时
 * 改另一处**，否则「复制 Markdown」与「导出 Word」会给出两份内容对不上的报告。
 *
 * 与 Markdown 版的差异只有两处，都是载体限制而不是内容取舍：
 *   ① Markdown 的 `##` / `###` / `####` 对应块里的 `heading` level 1 / 2 / 3；
 *   ② 所有值都强制成字符串 —— 旧报告可能整段字段缺失，`undefined` 一旦拼进 XML 就会以
 *      字面量出现在 Word 正文里，比 Markdown 里更难发现。
 */
export const accountPlanToDocxBlocks = (report: AccountPlanReport): DocxBlock[] => {
  // ⚠️ 报告是后端按当前版本生成的，但历史报告可能来自更早的批次：
  // 整段字段缺失时用可选链兜住，别让「导出 Word」直接 TypeError。
  const customer = report?.customer || ({} as AccountPlanReport["customer"]);
  const benchmark = report?.benchmark || ({} as AccountPlanReport["benchmark"]);
  const coverage = report?.ipProfile?.coverage;
  const business = report?.ipPositioning?.businessPositioning;
  const content = report?.ipPositioning?.contentPositioning;
  const persona = report?.ipPositioning?.personaPositioning;
  const setup = report?.accountSetup;
  const topics = report?.topicLibrary;

  const blocks: DocxBlock[] = [
    { type: "title", text: `账号定位｜${accountPlanTitleOf(report)}` },
    { type: "bullet", text: `客户：${customer.name || "未命名客户"}${customer.occupation ? `（${customer.occupation}）` : ""}` },
    { type: "bullet", text: `对标账号：${benchmark.accountName || "未识别对标账号"}${benchmark.accountUrl ? `（${benchmark.accountUrl}）` : ""}` },
    { type: "bullet", text: `1.2 报告来源：${benchmark.source || "未记录"}` },
    { type: "bullet", text: `本批章节：${report?.batchLabel || "未记录"}` },
    { type: "bullet", text: `IP 档案覆盖率：已填 ${coverage?.filledCount ?? 0} 项 / 共 ${coverage?.totalCount ?? 0} 项（空 ${coverage?.emptyCount ?? 0} 项）` },
  ];
  if (coverage?.note) blocks.push({ type: "bullet", text: String(coverage.note) });
  blocks.push(
    { type: "bullet", text: `分析时间：${report?.analyzedAt ? new Date(report.analyzedAt).toLocaleString("zh-CN") : "未知"}` },
    { type: "bullet", text: `分析来源：${report?.analysisSource === "agent" ? "Agent 分析" : "规则兜底"}` },
  );

  const missingInputs = report?.missingInputs || [];
  if (missingInputs.length > 0) {
    blocks.push(
      { type: "heading", level: 1, text: "缺失输入" },
      ...missingInputs.map(item => ({ type: "bullet" as const, text: `${item.label || item.key || ""}：${item.note || ""}`.trim() })),
    );
  }
  const warnings = report?.warnings || [];
  if (warnings.length > 0) {
    blocks.push(
      { type: "heading", level: 1, text: "自动告警" },
      ...warnings.map(item => ({ type: "bullet" as const, text: `${item.code ? `[${item.code}] ` : ""}${item.error || ""}`.trim() })),
    );
  }
  const originalRequests = [
    customer.ipPositioning ? `账号定位：${customer.ipPositioning}` : "",
    customer.contentNeeds ? `内容需求：${customer.contentNeeds}` : "",
    customer.notes ? `备注：${customer.notes}` : "",
    customer.benchmarkAccounts ? `名册里登记的对标账号：${customer.benchmarkAccounts.replace(/\s*\n\s*/g, "、")}` : "",
  ].filter(Boolean);
  if (originalRequests.length > 0) {
    blocks.push({ type: "heading", level: 1, text: "客户名册里的原始诉求" }, ...originalRequests.map(text => ({ type: "bullet" as const, text })));
  }

  // ── 一、IP定位 ────────────────────────────────────────────────────────────
  blocks.push({ type: "heading", level: 1, text: "一、IP定位" }, { type: "heading", level: 2, text: "1、商业定位" });
  blocks.push({ type: "bullet", text: `目标人群：${basisLine(business?.targetAudience)}` });
  blocks.push(
    { type: "heading", level: 3, text: "目标人群维度" },
    {
      type: "table",
      headers: ["维度", "档案里的值", "结论", "证据等级"],
      rows: (business?.audienceDimensions || []).map(item => [
        item.label || item.key || "-",
        item.profileValue || "档案未填写",
        item.text || item.note || "待人工补充",
        item.levelLabel || profileLevelLabelOf(item.level),
      ]),
    },
  );
  blocks.push({ type: "bullet", text: `核心痛点：${basisLine(business?.corePain)}` });
  if ((business?.contentDirections || []).length > 0) {
    (business?.contentDirections || []).forEach(item => {
      blocks.push({ type: "bullet", text: `${gradedLine(item)}${item.description ? `　${item.description}` : ""}` });
    });
  } else {
    blocks.push({ type: "bullet", text: "核心内容方向：待人工补充" });
  }
  blocks.push(
    { type: "heading", level: 3, text: "变现转化" },
    {
      type: "table",
      headers: ["层级", "产品", "定价", "定位", "在变现路径中的作用", "证据等级"],
      rows: (business?.monetization?.products || []).map(item => [
        item.tier || "-",
        item.product || "-",
        item.price || item.priceNote || "待人工补充",
        item.positioning || "-",
        item.role || "-",
        item.levelLabel || profileLevelLabelOf(item.level),
      ]),
    },
  );
  (business?.monetization?.tierGuide || []).forEach(item => {
    blocks.push({ type: "bullet", text: `层级口径｜${item.tier || ""}：${item.role || ""}（${item.pricing || ""}）` });
  });
  if ((business?.monetization?.path || []).length > 0) {
    blocks.push({ type: "heading", level: 3, text: "变现路径" });
    (business?.monetization?.path || []).forEach(item => {
      blocks.push({ type: "bullet", text: `${item.step ?? ""}. ${item.description || ""}` });
      // 句式不合规的步骤**保留原文并标出来**：它是交付物，必须让人看见要改哪一步。
      if (item.patternOk === false) blocks.push({ type: "bullet", text: `⚠️ ${item.patternNote || "未按标准句式书写，需人工改写。"}` });
    });
  }
  if (business?.monetization?.note) blocks.push({ type: "text", text: String(business.monetization.note) });

  blocks.push({ type: "heading", level: 2, text: "2、内容定位" });
  blocks.push({ type: "bullet", text: `核心内容定位：${basisLine(content?.core)}` });
  const classification = content?.classification;
  if (classification) {
    blocks.push(
      { type: "bullet", text: `选题库：${classification.source || "原样透传 1.2 报告"}（大类 ${classification.categoryCount ?? 0} 个 / 小类 ${classification.subcategoryCount ?? 0} 个 / 选题 ${classification.topicTotal ?? 0} 条）` },
    );
    if (classification.recomputeNote) blocks.push({ type: "bullet", text: String(classification.recomputeNote) });
    if (classification.summary) blocks.push({ type: "bullet", text: `分类概括：${classification.summary}` });
    (classification.categories || []).forEach(category => {
      blocks.push({ type: "heading", level: 3, text: `大类｜${category.name || "未命名大类"}（${category.topicCount ?? 0} 条 · ${category.percentage ?? 0}%）` });
      if (category.coreFunction) blocks.push({ type: "bullet", text: `核心功能：${category.coreFunction}` });
      if ((category.keywords || []).length > 0) blocks.push({ type: "bullet", text: `判断关键词：${category.keywords.join("、")}` });
      (category.subcategories || []).forEach(subcategory => {
        blocks.push({ type: "bullet", text: `小类｜${subcategory.name || "未命名小类"}（${subcategory.topicCount ?? 0} 条）${subcategory.description ? `：${subcategory.description}` : ""}` });
        (subcategory.topics || []).forEach(topic => {
          const stats = accountPlanTopicStatsLine(topic.stats);
          blocks.push({ type: "bullet", text: `\u3000${topic.title || "未命名选题"}${topic.link ? `（${topic.link}）` : ""}${stats ? `｜${stats}` : ""}` });
        });
      });
    });
  }
  if ((content?.frequentTags || []).length > 0) {
    blocks.push({ type: "heading", level: 3, text: `高频标签（${content.frequentTagsNote || "来自 1.2 报告，原样透传"}）` });
    content.frequentTags.forEach(item => {
      blocks.push({ type: "bullet", text: `#${String(item.tag || "").replace(/^#+/, "")}（${item.count ?? 0} 条 · ${item.percentage ?? 0}%）` });
    });
  }

  blocks.push({ type: "heading", level: 2, text: "3、人设定位" });
  blocks.push({ type: "bullet", text: `角色定位：${basisLine(persona?.role)}` });
  const personality = persona?.personality;
  if (personality) {
    blocks.push({ type: "bullet", text: `性格关键词（${personality.count ?? 0}/${personality.expectedCount ?? 0}）：` });
    if ((personality.keywords || []).length === 0) blocks.push({ type: "bullet", text: "待人工补充" });
    (personality.keywords || []).forEach(item => {
      blocks.push({ type: "bullet", text: `${item.keyword || ""}${item.expression ? `：${item.expression}` : ""}｜${item.levelLabel || profileLevelLabelOf(item.level)}` });
    });
    if (personality.note) blocks.push({ type: "bullet", text: String(personality.note) });
  }
  (persona?.memoryAnchors || []).forEach(anchor => {
    blocks.push({ type: "bullet", text: `${anchor.label || ""}（${anchor.dimension || ""} · 对应${anchor.fits || ""}）：` });
    if ((anchor.items || []).length === 0) blocks.push({ type: "bullet", text: anchor.note || "本类锚点暂无内容，待人工补充。" });
    (anchor.items || []).forEach(item => blocks.push({ type: "bullet", text: gradedLine(item) }));
    if (anchor.template) blocks.push({ type: "bullet", text: `建议句式：${anchor.template}` });
  });

  // ── 二、账号搭建 ──────────────────────────────────────────────────────────
  blocks.push({ type: "heading", level: 1, text: "二、账号搭建" }, { type: "heading", level: 2, text: "1、账号三件套" });
  (setup?.trio || []).forEach(item => {
    blocks.push({ type: "bullet", text: `${item.label || ""}（${item.rule || ""}）：${basisLine(item)}` });
  });
  blocks.push({ type: "bullet", text: `客户照片：${setup?.photoNote || "输入里没有客户照片。"}` });

  blocks.push({ type: "heading", level: 2, text: "2、账号简介" });
  if (setup?.bio?.structureNote) blocks.push({ type: "bullet", text: `结构：${setup.bio.structureNote}` });
  (setup?.bio?.platforms || []).forEach(platform => {
    blocks.push({ type: "heading", level: 3, text: `${platform.label || ""}（共 ${platform.candidateCount ?? 0} 条候选）` });
    (platform.rows || []).forEach(row => {
      blocks.push({ type: "bullet", text: `第${row.row ?? ""}行 ${row.label || ""}${row.rule ? `（${row.rule}）` : ""}` });
      if ((row.priority || []).length > 0) blocks.push({ type: "bullet", text: `优先顺序：${row.priority.join(" → ")}` });
      if ((row.candidates || []).length === 0) blocks.push({ type: "bullet", text: row.note || "本行暂无候选，待人工补充。" });
      (row.candidates || []).forEach(candidate => blocks.push({ type: "bullet", text: gradedLine(candidate) }));
    });
  });

  // ── 三、视频选题库 ────────────────────────────────────────────────────────
  blocks.push({ type: "heading", level: 1, text: "三、视频选题库" });
  blocks.push({ type: "bullet", text: `共 ${topics?.topicTotal ?? 0} 条；其中 1.2 分类选题库 ${topics?.classificationTopicTotal ?? 0} 条。${topics?.classificationTopicNote || ""}` });
  (topics?.methods || []).forEach(method => {
    blocks.push({ type: "heading", level: 2, text: `${method.label || method.key || ""}（${method.topicCount ?? 0} 条）` });
    if (method.note) blocks.push({ type: "bullet", text: String(method.note) });
    if (method.duplicateCount) blocks.push({ type: "bullet", text: `已按标题去重 ${method.duplicateCount} 条重复项。` });
    if (method.sameTrackAccounts) {
      const manual = method.sameTrackAccounts;
      blocks.push({ type: "bullet", text: `同赛道对标账号（${manual.levelLabel || profileLevelLabelOf(manual.level)}）：${manual.note || ""}` });
      // 与 Markdown 导出保持一致：已填充时把账号本身也写出来（见那边的同款注释）。
      (manual.items || []).forEach(item => {
        const title = typeof item === "string" ? item : String(item?.title || "");
        const url = typeof item === "string" ? "" : String(item?.url || "");
        if (title || url) blocks.push({ type: "bullet", text: `${title}${url ? `：${url}` : ""}` });
      });
      if (manual.discardedCount > 0) blocks.push({ type: "bullet", text: `本次丢弃了 ${manual.discardedCount} 条无法核对的账号建议。` });
    }
    (method.topics || []).forEach(item => {
      blocks.push({ type: "bullet", text: `${item.title || ""}${item.painPoint ? `（对应痛点：${item.painPoint}）` : ""}${item.angle ? `（角度：${item.angle}）` : ""}｜${item.levelLabel || profileLevelLabelOf(item.level)}` });
      if ((item.basis || []).length > 0) blocks.push({ type: "bullet", text: `依据：${item.basis.join("；")}` });
    });
    if (method.disclaimer) blocks.push({ type: "text", text: `热点时效性说明：${method.disclaimer}` });
    (method.groups || []).forEach(group => {
      blocks.push({ type: "heading", level: 3, text: `${group.label || ""}（${group.count ?? 0} 条）` });
      if ((group.items || []).length === 0) blocks.push({ type: "bullet", text: group.note || "本组暂无内容，待人工补充。" });
      (group.items || []).forEach(item => {
        blocks.push({ type: "bullet", text: `${item.topic || ""}｜${item.levelLabel || profileLevelLabelOf(item.level)}` });
        (item.titles || []).forEach(title => blocks.push({ type: "bullet", text: `标题示例：${title}` }));
      });
    });
  });
  if (topics?.summary) blocks.push({ type: "text", text: String(topics.summary) });

  // ── 四、短视频内容框架（第二批；与 Markdown 版逐条镜像）──────────────────────
  const framework = report?.contentFramework;
  if (framework) {
    blocks.push({ type: "heading", level: 1, text: "四、短视频内容框架" });
    if (framework.note) blocks.push({ type: "text", text: String(framework.note) });
    ([framework.openingHooks, framework.endingHooks].filter(Boolean) as AccountPlanHookGroup[]).forEach((group, groupIndex) => {
      blocks.push({ type: "heading", level: 2, text: `${groupIndex === 0 ? "1" : "2"}、${group.label || ""}（${group.count ?? 0}/${group.requiredCount ?? 0} 种类型）` });
      if (group.typeNote) blocks.push({ type: "bullet", text: group.typeNote });
      if (group.discardedCount > 0) blocks.push({ type: "bullet", text: `${group.discardedNote || ""}（丢弃 ${group.discardedCount} 条）`.trim() });
      (group.hooks || []).forEach(hook => {
        blocks.push({ type: "bullet", text: `【${hook.typeLabel || hook.type || "未标类型"}】${hook.text || "待人工补充"}｜${hook.levelLabel || profileLevelLabelOf(hook.level)}` });
        if (hook.reason) blocks.push({ type: "bullet", text: `理由：${hook.reason}` });
        if (hook.definition) blocks.push({ type: "bullet", text: `类型口径：${hook.definition}` });
        if ((hook.basis || []).length > 0) blocks.push({ type: "bullet", text: `依据：${hook.basis.join("；")}` });
        if (hook.typeNote) blocks.push({ type: "bullet", text: `类型说明：${hook.typeNote}` });
      });
      if ((group.hooks || []).length === 0) blocks.push({ type: "bullet", text: group.note || "本组暂无钩子，待人工补充。" });
      if (group.note && (group.hooks || []).length > 0) blocks.push({ type: "bullet", text: group.note });
      if ((group.benchmarkTopTypes || []).length > 0) {
        blocks.push({ type: "bullet", text: `1.2 里对标账号最常用的类型：${group.benchmarkTopTypes.map(item => `${item.typeLabel}（${item.count} 条 · ${item.percentage}%）`).join("、")}` });
      }
    });
    if (framework.summary) blocks.push({ type: "text", text: String(framework.summary) });
  }

  // ── 五、拍摄与剪辑建议（第二批）─────────────────────────────────────────────
  const production = report?.production;
  if (production) {
    blocks.push({ type: "heading", level: 1, text: "五、拍摄与剪辑建议" });
    // ⚠️ 「是建议不是观测」这两句必须在 Word 里也出现（见 Markdown 版注释）。
    if (production.note) blocks.push({ type: "text", text: String(production.note) });
    if (production.levelCapNote) blocks.push({ type: "text", text: String(production.levelCapNote) });
    ([production.shooting, production.editing].filter(Boolean) as AccountPlanProductionGroup[]).forEach((group, groupIndex) => {
      blocks.push({ type: "heading", level: 2, text: `${groupIndex === 0 ? "1" : "2"}、${group.label || ""}（${group.count ?? 0}/${group.requiredCount ?? 0} 项）` });
      (group.items || []).forEach(item => {
        blocks.push({ type: "bullet", text: `${item.label || item.key || ""}（${item.rule || ""}）：${item.text || "待人工补充"}｜${item.levelLabel || profileLevelLabelOf(item.level)}` });
        if ((item.basis || []).length > 0) blocks.push({ type: "bullet", text: `依据：${item.basis.join("；")}` });
      });
      if (group.note) blocks.push({ type: "bullet", text: group.note });
    });
    if (production.summary) blocks.push({ type: "text", text: String(production.summary) });
  }

  // ── 六、起号与运营（第二批）─────────────────────────────────────────────────
  const operations = report?.operations;
  if (operations) {
    const platform = operations.platformStrategy;
    blocks.push({ type: "heading", level: 1, text: "六、起号与运营" });
    if (operations.note) blocks.push({ type: "text", text: String(operations.note) });
    blocks.push({ type: "heading", level: 2, text: "1、平台与矩阵策略" });
    if (platform?.note) blocks.push({ type: "bullet", text: platform.note });
    blocks.push({ type: "bullet", text: `主阵地：${basisLine(platform?.primary)}` });
    blocks.push({ type: "bullet", text: `辅阵地：${basisLine(platform?.secondary)}` });
    blocks.push({ type: "bullet", text: `匹配分析：${basisLine(platform?.matchAnalysis)}` });
    blocks.push({ type: "bullet", text: `发布时间段：${basisLine(platform?.publish?.window)}` });
    blocks.push({ type: "bullet", text: `发布频率：${basisLine(platform?.publish?.frequency)}` });
    if (platform?.publish?.rhythmNote) blocks.push({ type: "bullet", text: `节奏说明：${platform.publish.rhythmNote}` });
    const publishing = platform?.publish?.benchmark;
    if (publishing) {
      blocks.push({ type: "bullet", text: `1.2 实测发布节奏（${publishing.levelLabel || profileLevelLabelOf(publishing.level)}）：样本 ${publishing.videoCount ?? 0} 条 · 有日期 ${publishing.datedCount ?? 0} 条 · 跨度 ${publishing.spanDays ?? 0} 天 · 约 ${publishing.perWeek ?? 0} 条/周` });
      if (publishing.note) blocks.push({ type: "bullet", text: publishing.note });
      if (publishing.analysis) blocks.push({ type: "bullet", text: `节奏分析：${publishing.analysis}` });
      if (publishing.sourceNote) blocks.push({ type: "bullet", text: publishing.sourceNote });
      if (!publishing.available && publishing.missingNote) blocks.push({ type: "bullet", text: publishing.missingNote });
    }
    blocks.push({ type: "heading", level: 2, text: "2、引流话术" });
    (platform?.trafficScripts?.types || []).forEach(item => {
      blocks.push({ type: "bullet", text: `${item.label || item.key || ""}（${item.scriptCount ?? 0} 条）` });
      if (item.purpose) blocks.push({ type: "bullet", text: `目的：${item.purpose}` });
      if (item.direction) blocks.push({ type: "bullet", text: `引流导向：${item.direction}` });
      if ((item.scripts || []).length === 0) blocks.push({ type: "bullet", text: item.note || "这一类暂无可直接使用的话术，待人工补充。" });
      (item.scripts || []).forEach(script => blocks.push({ type: "bullet", text: gradedLine({ text: script.text, basis: script.basis, level: script.level, levelLabel: script.levelLabel }) }));
    });
    const benchmarkScripts = platform?.trafficScripts?.benchmark;
    if (benchmarkScripts) {
      blocks.push({ type: "bullet", text: `1.2 报告的引流话术（${benchmarkScripts.note || ""}）` });
      blocks.push({ type: "bullet", text: `简介：${basisLine({ text: benchmarkScripts.bio?.text, basis: benchmarkScripts.bio?.basis, level: benchmarkScripts.bio?.level, levelLabel: benchmarkScripts.bio?.levelLabel } as AccountPlanField)}` });
      blocks.push({ type: "bullet", text: `评论区：${basisLine({ text: benchmarkScripts.comments?.text, basis: benchmarkScripts.comments?.basis, level: benchmarkScripts.comments?.level, levelLabel: benchmarkScripts.comments?.levelLabel } as AccountPlanField)}` });
    }

    // 起号策略 / 数据复盘：**通用模板** —— Word 里同样要带模板标记与说明。
    const launch = operations.launchPlan;
    if (launch) {
      blocks.push({ type: "heading", level: 2, text: `3、${launch.label || "起号策略"}${launch.template ? "（通用模板，非针对该客户的推断）" : ""}` });
      if (launch.note) blocks.push({ type: "text", text: String(launch.note) });
      if (launch.source) blocks.push({ type: "text", text: `来源：${launch.source}` });
      blocks.push({
        type: "table",
        headers: ["步骤", "具体操作"],
        rows: (launch.steps || []).map(step => [`${step.step ?? ""}. ${step.name || ""}`, step.action || ""]),
      });
    }
    const review = operations.reviewPlan;
    if (review) {
      blocks.push({ type: "heading", level: 2, text: `4、${review.label || "数据复盘重点"}${review.template ? "（通用模板，非针对该客户的推断）" : ""}` });
      if (review.note) blocks.push({ type: "text", text: String(review.note) });
      if (review.source) blocks.push({ type: "text", text: `来源：${review.source}` });
      blocks.push({
        type: "table",
        headers: ["复盘维度", "关注什么"],
        rows: (review.dimensions || []).map(item => [item.label || item.key || "", item.focus || ""]),
      });
    }

    const mix = operations.contentMix;
    if (mix) {
      blocks.push({ type: "heading", level: 2, text: "5、内容配比" });
      if (mix.source) blocks.push({ type: "bullet", text: mix.source });
      if (mix.recomputeNote) blocks.push({ type: "bullet", text: mix.recomputeNote });
      if (mix.unmatchedCount > 0) blocks.push({ type: "bullet", text: mix.unmatchedNote });
      if (mix.note) blocks.push({ type: "bullet", text: mix.note });
      (mix.periods || []).forEach(period => {
        blocks.push({ type: "heading", level: 3, text: `${period.label || period.key || ""}（合计 ${period.total ?? 0}%）｜${period.levelLabel || profileLevelLabelOf(period.level)}` });
        if ((period.rows || []).length === 0) {
          blocks.push({ type: "bullet", text: period.note || "配比待人工补充。" });
        } else {
          blocks.push({
            type: "table",
            headers: ["内容大类", "比重意图", "占比", "理由", "证据等级"],
            rows: (period.rows || []).map(row => [
              row.category || "-",
              row.intentLabel || "-",
              `${row.percentage ?? 0}%`,
              `${row.reason || "-"}${row.intentNote ? `（${row.intentNote}）` : ""}`,
              row.levelLabel || profileLevelLabelOf(row.level),
            ]),
          });
        }
        if (period.discardedCount > 0) blocks.push({ type: "bullet", text: period.discardedNote || "" });
      });
    }
    if (operations.summary) blocks.push({ type: "text", text: String(operations.summary) });
  }

  return blocks;
};

/** 导出 Word 的文件名：账号定位-<客户名>-<对标账号名>-<YYYYMMDD>，日期取分析时间（缺失或非法时退回当天）。 */
export const formatAccountPlanDocxFileName = (report: AccountPlanReport) => {
  const analyzedAt = report?.analyzedAt ? new Date(report.analyzedAt) : null;
  const date = analyzedAt && !Number.isNaN(analyzedAt.getTime()) ? analyzedAt : new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const customer = asText(report?.customer?.name) || "未命名客户";
  const account = asText(report?.benchmark?.accountName) || "未识别对标账号";
  return safeDocxFileName(`账号定位-${customer}-${account}-${stamp}`);
};

/** 判断一条大类是不是 1.2 的「待人工复核」桶 —— 它不算内容大类，两侧渲染都不展示。 */
export const isAccountPlanReviewCategory = (category: AccountPlanClassificationCategory) => isReviewCategory(category?.name);
