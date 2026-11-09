import type { BenchmarkContentStyle, BenchmarkPlatform } from "./benchmarkAnalysis";
import { safeDocxFileName, type DocxBlock } from "./docx";
import type { EndingHookType } from "./endingHooks";
import type { GoldThreeSecondType } from "./goldThreeSeconds";
import type { FansPortraitDimension } from "./reportApi";

/**
 * 模块 1「对标账号分析」(1.2) 的客户端类型。
 *
 * 与 2.2/2.3 的两点本质差别（渲染时别照抄那两步）：
 *   ① 样本是**点赞最高的前 20 条**，不是全部 60 条；
 *   ② 三秒/结尾的「原因」是按 **4 个角度**（账号定位 / 内容定位 / 人设定位 / 用户痛点）
 *      成段给出的，而不是按内容大类拆配比。
 *
 * ⚠️ 每个叙述字段都带 `level`（证据分级）。**界面上必须把 level 显示出来** ——
 * 「输入证据」「Agent 推断」「待人工补充」三者对项目经理的含义完全不同，
 * 尤其是用户画像的人口属性与变现产品定价：定价天生缺少数据源；人口属性自接入
 * 抖音热榜粉丝画像后**有了一手证据**（见 `ProfileFansPortrait`），拿不到时才是推断。
 * 不标出来就会被当成调研结论。详见 api/_lib/benchmarkProfile.js 顶部的说明。
 */

export type ProfileEvidenceLevel = "evidence" | "inference" | "manual";

export const PROFILE_LEVEL_LABELS: Record<ProfileEvidenceLevel, string> = {
  evidence: "输入证据",
  inference: "Agent 推断",
  manual: "待人工补充",
};

/**
 * 证据分级的配色。**必须带兜底**：数据库里可能有旧报告或后端新增了分级，
 * 直接查表会拿到 undefined，拼进 className 就是 "undefined"（§6.4⑲）。
 */
const LEVEL_TONES: Record<string, string> = {
  evidence: "border-emerald-200 bg-emerald-50 text-emerald-700",
  inference: "border-amber-200 bg-amber-50 text-amber-700",
  manual: "border-slate-200 bg-slate-100 text-slate-500",
};
export const UNKNOWN_LEVEL_TONE = "border-slate-200 bg-slate-100 text-slate-600";

export const profileLevelLabelOf = (level: string) =>
  PROFILE_LEVEL_LABELS[level as ProfileEvidenceLevel] || level || "待人工补充";
export const profileLevelToneOf = (level: string) => LEVEL_TONES[level] || UNKNOWN_LEVEL_TONE;

/** 一段带证据分级的叙述。`text` 为空表示待人工补充。 */
export type BasisField = {
  text: string;
  basis: string[];
  level: ProfileEvidenceLevel;
  levelLabel: string;
};

export type ProfileDemographic = BasisField & { key: string; label: string };

export type ProfileBehavior = {
  behavior: string;
  reason: string;
  example: string;
  basis: string[];
  level: ProfileEvidenceLevel;
  levelLabel: string;
};

export type ProfileReasonAngle = { key: string; label: string; text: string };

/**
 * 真实粉丝画像（抖音热榜）—— 用户画像里**唯一的一手证据**。
 *
 * 有它时后端会把性别 / 年龄 / 收入 / 消费习惯的 `level` 升为 `evidence`；没有时这几项
 * 退回推断或待人工补充。`available` 为 false 也要把 `reason` 如实显示出来，
 * 而不是把这一节藏起来 —— 用户得知道「为什么这里只有推断」。
 */
export type ProfileFansPortrait = {
  /** 是否真的拿到了分布（`dimensions` 非空）。 */
  available: boolean;
  /** "" 表示成功；否则是 "missing_sec_user_id" | "no_dimensions" 等，界面按它给文案。 */
  reason: string;
  secUserId: string;
  fetchedAt: string;
  fromCache: boolean;
  dimensions: FansPortraitDimension[];
  /**
   * 上游没取到的维度明细。**后端目前不一定随报告返回这个字段**，带了就如实列出来，
   * 没带就不显示 —— 这里的 `failed` 单指「抓取失败」，与证据等级无关。
   */
  failed?: Array<{ option: number; label: string; error: string }>;
};

/**
 * 粉丝画像维度的展示顺序：性别 → 年龄 → 手机价格 → 城市等级 → 手机品牌 → 兴趣 → 省份 → 城市。
 *
 * 与后端 `PORTRAIT_DIMENSIONS` 的 option 顺序**刻意不同**：这里按对用户画像的决策价值排，
 * 前几项直接对应人口属性，省份 / 城市只是补充。不在这张表里的维度排到最后并保持原有
 * 相对顺序 —— 后端将来加维度时，不会因为这里查不到 key 就整段消失。
 */
const FANS_PORTRAIT_ORDER = ["gender", "age", "mobilePrice", "cityLevel", "mobileBrand", "interest", "province", "city"];

export const sortFansPortraitDimensions = <TDimension extends { key?: string }>(dimensions?: TDimension[]) => {
  const rankOf = (key?: string) => {
    const index = FANS_PORTRAIT_ORDER.indexOf(String(key || ""));
    return index < 0 ? FANS_PORTRAIT_ORDER.length : index;
  };
  return [...(dimensions || [])]
    .map((dimension, index) => ({ dimension, index }))
    .sort((left, right) => rankOf(left.dimension?.key) - rankOf(right.dimension?.key) || left.index - right.index)
    .map(item => item.dimension);
};

export type ProfileThreeSecondItem = {
  videoId: string;
  categoryName: string;
  title: string;
  link: string;
  openingText: string;
  openingSource?: "transcript" | "caption";
  type: GoldThreeSecondType | "review";
  typeLabel: string;
  evidence: string;
  stats: { likes: number; comments: number; shares: number; bookmarks: number };
};

export type ProfileEndingItem = {
  videoId: string;
  categoryName: string;
  title: string;
  link: string;
  endingText: string;
  endingSource?: "transcript" | "caption";
  type: EndingHookType;
  typeLabel: string;
  evidence: string;
  stats: { likes: number; comments: number; shares: number; bookmarks: number };
};

export type ProfileTypeDistribution = {
  type: string;
  typeLabel: string;
  count: number;
  percentage: number;
};

export type ProfileTopType = ProfileTypeDistribution & { reason: string };

export type ProfileHookBlock<TItem> = {
  sampleLimit: number;
  itemCount: number;
  items: TItem[];
  typeDistribution: ProfileTypeDistribution[];
  topTypes: ProfileTopType[];
  analysisReason: string;
  reasonAngles: ProfileReasonAngle[];
  transcriptCoverage?: { fromTranscript: number; fromCaption: number; total: number };
  /** 8 个维度 / 5 个类型的判定口径，由后端随报告返回。 */
  dimensions?: Array<{ type: string; label: string; definition: string; example: string; strength: string }>;
  types?: Array<{ type: string; label: string; definition: string; example: string; strength: string }>;
};

export type ProfileCategory = {
  name: string;
  coreFunction: string;
  keywords: string[];
  count: number;
  percentage: number;
  subcategories: Array<{ name: string; topics: string[] }>;
};

export type BenchmarkProfileReport = {
  version: string;
  reportType: "benchmark_profile";
  account: {
    name: string;
    url: string;
    platform: BenchmarkPlatform;
    platformLabel: string;
    /** 账号简介。空串 = 没取到（不是「这个账号没有简介」），商业定位会因此落待人工补充。 */
    signature: string;
    followerCount: number;
    /**
     * 抖音 sec_user_id。拉真实粉丝画像要用它；**旧分类报告没有这个字段**，
     * 那时画像拿不到（界面如实说明原因），人口属性保持推断。
     */
    secUserId?: string;
  };
  contentStyle: BenchmarkContentStyle;
  contentStyleLabel: string;
  classificationReportType: string;
  sampleWindow: {
    classificationSampleCount: number;
    classificationSampleRule: string;
    profileSampleLimit: number;
    profileSampleCount: number;
    profileSampleRule: string;
    tagWindowNote: string;
  };
  businessPositioning: {
    persona: BasisField;
    corePain: BasisField;
    summary: string;
  };
  userProfile: {
    demographics: ProfileDemographic[];
    pains: BasisField;
    goals: BasisField;
    behaviors: ProfileBehavior[];
    /**
     * 真实粉丝画像（抖音热榜）。有它时人口属性的 `level` 是 `evidence`。
     * 旧报告没有这个字段 —— 那时界面不额外渲染，保持原有的「待人工补充」徽章。
     */
    fansPortrait?: ProfileFansPortrait;
    dataSources: {
      hasComments: boolean;
      commentCount: number;
      hasSignature: boolean;
      /** 早期字段名（等同 hasPortraitData）。后端为兼容保留，前端不再依赖它。 */
      platformPortraitAvailable: boolean;
      /** 真实粉丝画像是否拿到。拿到则人口属性是「输入证据」而不是推断。旧报告没有这个字段。 */
      hasPortraitData: boolean;
      note: string;
    };
  };
  contentPositioning: {
    classification: {
      source: string;
      contentStyle: BenchmarkContentStyle;
      contentStyleLabel: string;
      analyzedCount: number;
      sampleWindow: string;
      summary: string;
      categories: ProfileCategory[];
    };
    threeSeconds: ProfileHookBlock<ProfileThreeSecondItem>;
    endingHooks: ProfileHookBlock<ProfileEndingItem>;
    sampleRule: string;
  };
  frequentTags: Array<{ tag: string; count: number; percentage: number }>;
  operationStrategy: {
    publishing: {
      videoCount: number;
      datedCount: number;
      earliest?: string;
      latest?: string;
      spanDays: number;
      perWeek: number;
      weekdayDistribution: Array<{ weekday: string; count: number }>;
      hasTimeOfDay: boolean;
      note: string;
      level: ProfileEvidenceLevel;
      levelLabel: string;
      analysis: string;
    };
    trafficScripts: { bio: BasisField; comments: BasisField };
    monetization: {
      products: Array<{
        tier: string;
        product: string;
        price: string;
        priceNote: string;
        positioning: string;
        role: string;
        level: ProfileEvidenceLevel;
        levelLabel: string;
        basis: string[];
      }>;
      path: Array<{ step: number; description: string }>;
      note: string;
    };
  };
  dataCoverage: {
    profileSampleCount: number;
    headTranscriptCount: number;
    tailTranscriptCount: number;
    videosWithComments: number;
    commentCount: number;
  };
  analysisSource: "agent" | "heuristic";
  warnings: Array<{ code?: string; error?: string; fallbackUsed?: boolean }>;
  analyzedAt: string;
};

/** 保存后列表里返回的元数据。 */
export type SavedBenchmarkProfileReportSummary = {
  id: string;
  reportType: "benchmark_profile";
  accountName: string;
  accountUrl: string;
  contentStyle: BenchmarkContentStyle;
  analyzedCount: number;
  createdAt: string;
};

export type SavedBenchmarkProfileReport = SavedBenchmarkProfileReportSummary & {
  report: BenchmarkProfileReport;
};

const basisLine = (field?: BasisField | null) => {
  if (!field || !field.text) return "待人工补充";
  const basis = field.basis?.length ? `（依据：${field.basis.join("；")}）` : "";
  return `${field.text}${basis}｜${field.levelLabel || profileLevelLabelOf(field.level)}`;
};

/** Markdown 里每个维度最多列几项：省份这类维度可能二三十项，全列会把正文撑得没法读。 */
const PORTRAIT_MARKDOWN_ITEMS = 8;

/**
 * 导出成 Markdown，供项目经理复制到文档里。
 *
 * 与 2.2/2.3 的导出一致：**如实标注每个字段的证据等级**，尤其是「待人工补充」——
 * 导出的文档会脱离界面单独流转，不标等级就没人知道哪些是推断出来的。
 */
export const formatBenchmarkProfileMarkdown = (report: BenchmarkProfileReport) => {
  const lines = [
    `# 对标账号分析｜${report.account.name || "未识别账号"}`,
    "",
    `- 平台：${report.account.platformLabel}${report.account.followerCount > 0 ? `　粉丝：${report.account.followerCount}` : ""}`,
    `- 内容形式：${report.contentStyleLabel || report.contentStyle}`,
    // 老报告可能整段缺 sampleWindow —— 直接插值会把「undefined 条（undefined）」写进导出文档。
    // docx 版从一开始就有兜底，这里是补齐 Markdown 版的同一个洞。
    `- 分类样本：${report.sampleWindow?.classificationSampleCount ?? 0} 条（${report.sampleWindow?.classificationSampleRule || "口径未记录"}）`,
    `- 三秒/结尾样本：${report.sampleWindow?.profileSampleRule || "口径未记录"}`,
    `- 分析时间：${report.analyzedAt ? new Date(report.analyzedAt).toLocaleString("zh-CN") : "未知"}`,
    `- 分析来源：${report.analysisSource === "agent" ? "Agent" : "规则兜底"}`,
    "",
    "## 账号简介",
    report.account.signature || "未取到简介，待人工补充",
    "",
    "## 一、商业定位",
    `- 人设定位：${basisLine(report.businessPositioning?.persona)}`,
    `- 核心痛点：${basisLine(report.businessPositioning?.corePain)}`,
    ...(report.businessPositioning?.summary ? [`- 整体概括：${report.businessPositioning.summary}`] : []),
    "",
    "## 二、用户画像",
  ];
  (report.userProfile?.demographics || []).forEach(item => {
    lines.push(`- ${item.label}：${item.text || "待人工补充"}｜${item.levelLabel || profileLevelLabelOf(item.level)}`);
  });
  // 真实粉丝画像：只在真的拿到分布时导出，拿不到就整段跳过 ——
  // 「为什么这里只有推断」由人口属性那几行自己的证据等级说明。
  const fansPortrait = report.userProfile?.fansPortrait;
  const portraitDimensions = sortFansPortraitDimensions(fansPortrait?.dimensions);
  if (fansPortrait?.available && portraitDimensions.length > 0) {
    lines.push(
      "",
      "### 粉丝画像（真实数据）",
      `> 抖音热榜粉丝画像｜抓取于 ${fansPortrait.fetchedAt ? new Date(fansPortrait.fetchedAt).toLocaleString("zh-CN") : "未知时间"}${fansPortrait.fromCache ? "（缓存）" : ""}`,
    );
    portraitDimensions.forEach(dimension => {
      const items = dimension.items || [];
      const listed = items.slice(0, PORTRAIT_MARKDOWN_ITEMS).map(item => `${item.name}(${item.percentage ?? 0}%)`).join("、");
      const more = items.length > PORTRAIT_MARKDOWN_ITEMS ? `…（共 ${items.length} 项）` : "";
      const conclusion = dimension.dominant?.name
        ? `｜结论：占比最高的是 ${dimension.dominant.name}（${dimension.dominant.percentage ?? 0}%）`
        : "";
      lines.push(`- ${dimension.label || dimension.key}：${listed}${more}${conclusion}`);
    });
  }
  lines.push(`- 痛点：${basisLine(report.userProfile?.pains)}`);
  lines.push(`- 目标 / 需求：${basisLine(report.userProfile?.goals)}`);
  if ((report.userProfile?.behaviors || []).length > 0) {
    lines.push("", "### 用户行为分析", "", "| 用户行为 | 原因 | 举例 | 证据等级 |", "| --- | --- | --- | --- |");
    report.userProfile.behaviors.forEach(item => {
      lines.push(`| ${item.behavior || "-"} | ${item.reason || "-"} | ${item.example || "-"} | ${item.levelLabel || profileLevelLabelOf(item.level)} |`);
    });
  }
  if (report.userProfile?.dataSources?.note) lines.push("", `> ${report.userProfile.dataSources.note}`);

  const hookSection = <TItem extends { title: string; link: string; typeLabel: string; evidence: string }>(
    title: string,
    block: ProfileHookBlock<TItem>,
    textOf: (item: TItem) => { text: string; source?: string },
  ) => {
    lines.push("", `## ${title}`);
    if (block?.analysisReason) lines.push(block.analysisReason, "");
    lines.push("### 最常用的 3 种类型");
    (block?.topTypes || []).forEach(item => {
      lines.push(`- ${item.typeLabel} ${item.percentage}%（${item.count} 条）：${item.reason || "Agent 未给出原因，待人工补充"}`);
    });
    // 4 个分析角度是 1.2 的主要人工判断依据，必须导出。
    (block?.reasonAngles || []).filter(angle => angle.text).forEach(angle => {
      lines.push(`  - **${angle.label}**：${angle.text}`);
    });
    lines.push("", "### 样本明细");
    (block?.items || []).forEach(item => {
      const detail = textOf(item);
      lines.push(`- ${item.title || item.link || "未命名"}｜${item.typeLabel}｜${detail.source === "transcript" ? "真实转写" : "发布文案推断"}`);
      if (detail.text) lines.push(`  - 文案：${detail.text}`);
      if (item.link) lines.push(`  - 链接：${item.link}`);
    });
  };
  hookSection("三、内容定位 —— 三秒分析", report.contentPositioning?.threeSeconds, item => ({
    text: item.openingText,
    source: item.openingSource,
  }));
  hookSection("三、内容定位 —— 结尾分析", report.contentPositioning?.endingHooks, item => ({
    text: item.endingText,
    source: item.endingSource,
  }));

  lines.push("", "## 高频标签", `> ${report.sampleWindow?.tagWindowNote || ""}`);
  (report.frequentTags || []).forEach(item => lines.push(`- ${item.tag}（${item.count} 条 · ${item.percentage}%）`));

  lines.push("", "## 四、运营策略", "### 发布频率");
  const publishing = report.operationStrategy?.publishing;
  if (publishing) {
    lines.push(`- 样本 ${publishing.videoCount} 条，跨度 ${publishing.spanDays} 天，约 ${publishing.perWeek} 条/周｜${publishing.levelLabel}`);
    lines.push(`- ${publishing.note}`);
    if (publishing.analysis) lines.push(`- 节奏分析：${publishing.analysis}`);
  }
  lines.push("", "### 引流话术");
  lines.push(`- 简介：${basisLine(report.operationStrategy?.trafficScripts?.bio)}`);
  lines.push(`- 评论区：${basisLine(report.operationStrategy?.trafficScripts?.comments)}`);
  lines.push("", "### 变现产品", "", "| 层级 | 产品 | 定价 | 定位 | 在路径中的作用 | 证据等级 |", "| --- | --- | --- | --- | --- | --- |");
  (report.operationStrategy?.monetization?.products || []).forEach(item => {
    lines.push(`| ${item.tier || "-"} | ${item.product || "-"} | ${item.price || item.priceNote || "待人工补充"} | ${item.positioning || "-"} | ${item.role || "-"} | ${item.levelLabel} |`);
  });
  lines.push("", "### 变现路径");
  (report.operationStrategy?.monetization?.path || []).forEach(item => {
    lines.push(`${item.step}. ${item.description}`);
  });
  if (report.operationStrategy?.monetization?.note) lines.push("", report.operationStrategy.monetization.note);

  if (report.analysisSource !== "agent" && report.warnings?.length > 0) {
    lines.push("", "## 警告", ...report.warnings.map(item => `- ${item.code || ""} ${item.error || ""}`.trim()));
  }
  return lines.join("\n");
};

/**
 * 导出成 Word（.docx）的块列表，交给 `docx.ts` 渲染。
 *
 * ⚠️ 本函数与上面的 `formatBenchmarkProfileMarkdown` **刻意互为镜像**：章节、顺序、字段与
 * 证据口径必须逐条一致，两边只是载体不同（Markdown 文本 / Word 块）。**改其中一处必须同时
 * 改另一处**，否则「复制 Markdown」与「导出 Word」会给出两份内容对不上的报告。
 *
 * 与 Markdown 版的差异只有三处，都是载体限制而不是内容取舍：
 *   ① Markdown 的 `##` / `###` 对应块里的 `heading` level 1 / 2；
 *   ② 引用块（`>`）在 Word 里没有对应样式，降级成普通段落；`dataSources.note` 这类靠文字
 *      前缀（「说明：」）保住语义；
 *   ③ 每个值都强制成字符串 —— 旧报告可能整段字段缺失，`undefined` 一旦拼进 XML 就会以
 *      字面量出现在 Word 正文里，比 Markdown 里更难发现。
 */
export const benchmarkProfileToDocxBlocks = (report: BenchmarkProfileReport): DocxBlock[] => {
  // ⚠️ `account` 与 `sampleWindow` 在**老报告里都可能整段缺失**，必须用可选链。
  // 少了 `?.` 就不是「少一行字」，而是直接 TypeError —— 用户点「导出 Word」会失败。
  // （Markdown 版早期也踩过同一个洞，导出过「分类样本：undefined 条」。）
  const account = report.account || ({} as BenchmarkProfileReport["account"]);
  const sampleWindow = report.sampleWindow || ({} as BenchmarkProfileReport["sampleWindow"]);
  const blocks: DocxBlock[] = [
    { type: "title", text: `对标账号分析｜${account.name || "未识别账号"}` },
    { type: "bullet", text: `平台：${account.platformLabel || ""}${(account.followerCount || 0) > 0 ? `　粉丝：${account.followerCount}` : ""}` },
    { type: "bullet", text: `内容形式：${report.contentStyleLabel || report.contentStyle || ""}` },
    { type: "bullet", text: `分类样本：${sampleWindow.classificationSampleCount ?? 0} 条（${sampleWindow.classificationSampleRule || "口径未记录"}）` },
    { type: "bullet", text: `三秒/结尾样本：${sampleWindow.profileSampleRule || "口径未记录"}` },
    { type: "bullet", text: `分析时间：${report.analyzedAt ? new Date(report.analyzedAt).toLocaleString("zh-CN") : "未知"}` },
    { type: "bullet", text: `分析来源：${report.analysisSource === "agent" ? "Agent" : "规则兜底"}` },
    { type: "heading", level: 1, text: "账号简介" },
    { type: "text", text: account.signature || "未取到简介，待人工补充" },
    { type: "heading", level: 1, text: "一、商业定位" },
    { type: "bullet", text: `人设定位：${basisLine(report.businessPositioning?.persona)}` },
    { type: "bullet", text: `核心痛点：${basisLine(report.businessPositioning?.corePain)}` },
  ];
  if (report.businessPositioning?.summary) blocks.push({ type: "bullet", text: `整体概括：${report.businessPositioning.summary}` });

  blocks.push({ type: "heading", level: 1, text: "二、用户画像" });
  (report.userProfile?.demographics || []).forEach(item => {
    blocks.push({ type: "bullet", text: `${item.label || ""}：${item.text || "待人工补充"}｜${item.levelLabel || profileLevelLabelOf(item.level)}` });
  });
  // 真实粉丝画像的位置与 Markdown 版一致：人口属性之后、痛点之前 —— 它是上面那几项人口属性的
  // 一手证据，挪到别处读者就对不上了。拿不到分布时整段跳过（原因由人口属性自己的等级说明）。
  const fansPortrait = report.userProfile?.fansPortrait;
  const portraitDimensions = sortFansPortraitDimensions(fansPortrait?.dimensions);
  if (fansPortrait?.available && portraitDimensions.length > 0) {
    blocks.push(
      { type: "heading", level: 2, text: "粉丝画像（真实数据）" },
      { type: "bullet", text: `抖音热榜粉丝画像｜抓取于 ${fansPortrait.fetchedAt ? new Date(fansPortrait.fetchedAt).toLocaleString("zh-CN") : "未知时间"}${fansPortrait.fromCache ? "（缓存）" : ""}` },
      {
        type: "table",
        headers: ["维度", "结论", "明细"],
        rows: portraitDimensions.map(dimension => {
          const items = dimension.items || [];
          const listed = items.slice(0, PORTRAIT_MARKDOWN_ITEMS).map(item => `${item.name || ""}(${item.percentage ?? 0}%)`).join("、");
          const more = items.length > PORTRAIT_MARKDOWN_ITEMS ? `…（共 ${items.length} 项）` : "";
          return [
            String(dimension.label || dimension.key || ""),
            dimension.dominant?.name ? `占比最高的是 ${dimension.dominant.name}（${dimension.dominant.percentage ?? 0}%）` : "待人工补充",
            `${listed}${more}`,
          ];
        }),
      },
    );
  }
  blocks.push(
    { type: "bullet", text: `痛点：${basisLine(report.userProfile?.pains)}` },
    { type: "bullet", text: `目标 / 需求：${basisLine(report.userProfile?.goals)}` },
  );
  if ((report.userProfile?.behaviors || []).length > 0) {
    blocks.push(
      { type: "heading", level: 2, text: "用户行为分析" },
      {
        type: "table",
        headers: ["用户行为", "原因", "举例", "证据等级"],
        rows: (report.userProfile?.behaviors || []).map(item => [
          item.behavior || "-",
          item.reason || "-",
          item.example || "-",
          item.levelLabel || profileLevelLabelOf(item.level),
        ]),
      },
    );
  }
  if (report.userProfile?.dataSources?.note) blocks.push({ type: "text", text: `说明：${report.userProfile.dataSources.note}` });

  const hookSection = <TItem extends { title: string; link: string; typeLabel: string; evidence: string }>(
    title: string,
    block: ProfileHookBlock<TItem> | undefined,
    textOf: (item: TItem) => { text: string; source?: string },
  ) => {
    blocks.push({ type: "heading", level: 1, text: title });
    if (block?.analysisReason) blocks.push({ type: "text", text: block.analysisReason });
    blocks.push({ type: "heading", level: 2, text: "最常用的 3 种类型" });
    (block?.topTypes || []).forEach(item => {
      blocks.push({ type: "bullet", text: `${item.typeLabel || ""} ${item.percentage ?? 0}%（${item.count ?? 0} 条）：${item.reason || "Agent 未给出原因，待人工补充"}` });
    });
    // 4 个分析角度是 1.2 的主要人工判断依据，必须导出。Markdown 里是嵌套子项（加粗标签），
    // Word 里平铺成同级项目符号，标签靠「角度名：」保住。
    (block?.reasonAngles || []).filter(angle => angle.text).forEach(angle => {
      blocks.push({ type: "bullet", text: `${angle.label || ""}：${angle.text}` });
    });
    blocks.push({ type: "heading", level: 2, text: "样本明细" });
    (block?.items || []).forEach(item => {
      const detail = textOf(item);
      // 文案与链接各占一行：docx.ts 会把 \n 转成 <w:br/>，与 Markdown 的嵌套子项等价。
      const extra = `${detail?.text ? `\n文案：${detail.text}` : ""}${item.link ? `\n链接：${item.link}` : ""}`;
      blocks.push({ type: "bullet", text: `${item.title || item.link || "未命名"}｜${item.typeLabel || ""}｜${detail?.source === "transcript" ? "真实转写" : "发布文案推断"}${extra}` });
    });
  };
  hookSection("三、内容定位 —— 三秒分析", report.contentPositioning?.threeSeconds, item => ({
    text: item.openingText,
    source: item.openingSource,
  }));
  hookSection("三、内容定位 —— 结尾分析", report.contentPositioning?.endingHooks, item => ({
    text: item.endingText,
    source: item.endingSource,
  }));

  blocks.push(
    { type: "heading", level: 1, text: "高频标签" },
    { type: "text", text: String(report.sampleWindow?.tagWindowNote || "") },
  );
  (report.frequentTags || []).forEach(item => {
    blocks.push({ type: "bullet", text: `${item.tag || ""}（${item.count ?? 0} 条 · ${item.percentage ?? 0}%）` });
  });

  blocks.push({ type: "heading", level: 1, text: "四、运营策略" }, { type: "heading", level: 2, text: "发布频率" });
  const publishing = report.operationStrategy?.publishing;
  if (publishing) {
    blocks.push({ type: "bullet", text: `样本 ${publishing.videoCount ?? 0} 条，跨度 ${publishing.spanDays ?? 0} 天，约 ${publishing.perWeek ?? 0} 条/周｜${publishing.levelLabel || profileLevelLabelOf(publishing.level)}` });
    if (publishing.note) blocks.push({ type: "bullet", text: String(publishing.note) });
    if (publishing.analysis) blocks.push({ type: "bullet", text: `节奏分析：${publishing.analysis}` });
  }
  blocks.push(
    { type: "heading", level: 2, text: "引流话术" },
    { type: "bullet", text: `简介：${basisLine(report.operationStrategy?.trafficScripts?.bio)}` },
    { type: "bullet", text: `评论区：${basisLine(report.operationStrategy?.trafficScripts?.comments)}` },
    { type: "heading", level: 2, text: "变现产品" },
    {
      type: "table",
      headers: ["层级", "产品", "定价", "定位", "在变现路径中的作用", "证据等级"],
      rows: (report.operationStrategy?.monetization?.products || []).map(item => [
        item.tier || "-",
        item.product || "-",
        item.price || item.priceNote || "待人工补充",
        item.positioning || "-",
        item.role || "-",
        item.levelLabel || profileLevelLabelOf(item.level),
      ]),
    },
    { type: "heading", level: 2, text: "变现路径" },
  );
  (report.operationStrategy?.monetization?.path || []).forEach(item => {
    blocks.push({ type: "bullet", text: `${item.step ?? ""}. ${item.description || ""}` });
  });
  if (report.operationStrategy?.monetization?.note) blocks.push({ type: "text", text: report.operationStrategy.monetization.note });

  if (report.analysisSource !== "agent" && (report.warnings || []).length > 0) {
    blocks.push(
      { type: "heading", level: 1, text: "警告" },
      ...(report.warnings || []).map(item => ({ type: "bullet" as const, text: `${item.code || ""} ${item.error || ""}`.trim() })),
    );
  }
  return blocks;
};

/** 导出 Word 的文件名：对标账号分析-<账号名>-<YYYYMMDD>，日期取分析时间（缺失或非法时退回当天）。 */
export const formatBenchmarkProfileDocxFileName = (report: BenchmarkProfileReport) => {
  const analyzedAt = report?.analyzedAt ? new Date(report.analyzedAt) : null;
  const date = analyzedAt && !Number.isNaN(analyzedAt.getTime()) ? analyzedAt : new Date();
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  return safeDocxFileName(`对标账号分析-${report?.account?.name || "未识别账号"}-${stamp}`);
};
