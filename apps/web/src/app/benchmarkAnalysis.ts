export type BenchmarkContentStyle = "spoken" | "drama";
export type BenchmarkPlatform = "douyin" | "tiktok";

export type BenchmarkVideo = {
  id: string;
  title: string;
  link: string;
  authorName: string;
  publishDate: string;
  sourceText: string;
  coverUrl?: string;
  platform: BenchmarkPlatform;
  stats: {
    likes: number;
    comments: number;
    shares: number;
    bookmarks: number;
  };
};

/**
 * 大类 / 小类下的选题条目。
 *
 * 新报告里只存引用 `{ id, title }`，完整视频数据统一放在 `report.videos` ——
 * 之前大类和小类下各存一份完整对象，单份报告因此从 62 KB 涨到 146 KB。
 * **旧报告里这里是完整视频对象**，所以读取一律走 `resolveTopicVideo`。
 */
export type BenchmarkTopicRef = { id: string; title: string };
export type BenchmarkTopicEntry = BenchmarkTopicRef | BenchmarkVideo;

export type BenchmarkSubcategory = {
  id: string;
  name: string;
  description: string;
  topics: BenchmarkTopicEntry[];
};

export type BenchmarkCategory = {
  id: string;
  name: string;
  count: number;
  percentage: number;
  coreFunction: string;
  keywords: string[];
  subcategories: BenchmarkSubcategory[];
  topics: BenchmarkTopicEntry[];
};

const isFullVideo = (topic: BenchmarkTopicEntry): topic is BenchmarkVideo =>
  Boolean((topic as BenchmarkVideo)?.stats);

/**
 * 把选题引用还原成完整视频。旧报告里本来就是完整的，直接返回。
 *
 * 引用不到对应视频时给一个只有标题的空壳（展示用），让界面显示标题而不是崩掉。
 */
export const resolveTopicVideo = (topic: BenchmarkTopicEntry, videos: BenchmarkVideo[]): BenchmarkVideo => {
  if (isFullVideo(topic)) return topic;
  const list = Array.isArray(videos) ? videos : [];
  const found = list.find(video => video.id === topic?.id);
  if (found) return found;
  return {
    id: String(topic?.id || ""),
    title: String(topic?.title || ""),
    link: "",
    authorName: "",
    publishDate: "",
    sourceText: "",
    platform: list[0]?.platform || "douyin",
    stats: { likes: 0, comments: 0, shares: 0, bookmarks: 0 },
  };
};

export type BenchmarkReport = {
  version: string;
  reportType?: "benchmark_classification";
  contentStyle: BenchmarkContentStyle;
  contentStyleLabel: string;
  account: {
    name: string;
    url: string;
    platform: BenchmarkPlatform;
    platformLabel: string;
    /**
     * 账号简介与粉丝数。**旧报告里没有这两个字段**（2026-09-18 才打通），
     * 所以 1.2 必须容忍缺失并如实标「待人工补充」。
     */
    signature?: string;
    followerCount?: number;
    /** 抖音 sec_user_id。模块 1 拉真实粉丝画像要用，旧报告没有这个字段。 */
    secUserId?: string;
  };
  analyzedCount: number;
  fetchMode: "latest" | "recent";
  sampleWindow: string;
  summary: string;
  methodology: string;
  categories: BenchmarkCategory[];
  videos: BenchmarkVideo[];
  analysisSource: "agent" | "heuristic";
  warnings: Array<{ code?: string; error?: string; fallbackUsed?: boolean }>;
  analyzedAt: string;
};

export type SavedBenchmarkReport = {
  id: string;
  reportType?: "benchmark_classification";
  accountName: string;
  accountUrl: string;
  platform: BenchmarkPlatform;
  contentStyle: BenchmarkContentStyle;
  analyzedCount: number;
  selectedCount: number;
  selectedVideoIds: string[];
  report: BenchmarkReport;
  createdAt: string;
};

/**
 * 列表接口（GET /api/benchmark-reports）返回的形状：只有元数据，没有 report 正文。
 *
 * 单份报告正文约 148 KB（60 条视频在 videos 和 categories[].topics 里各存一份），
 * 列表一次拉 12 份就是近 2 MB，而调用方只是想「挑一份」。正文改用
 * GET /api/benchmark-reports?id= 单独取。
 */
export type SavedBenchmarkReportSummary = Omit<SavedBenchmarkReport, "report">;

export const parseAccountLinks = (value: string) => Array.from(new Set(
  String(value || "")
    .split(/[\n，,；;]+/)
    .map(item => item.trim())
    .filter(Boolean),
));

const toNumber = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
};

const toText = (value: unknown, fallback = "") => String(value ?? fallback).trim();

const formatDate = (value: unknown) => {
  const text = toText(value);
  if (!text) return "未知日期";
  const number = /^\d+$/.test(text) ? Number(text) : NaN;
  const date = Number.isFinite(number)
    ? new Date(number < 10_000_000_000 ? number * 1000 : number)
    : new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 20);
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
};

const extractVideos = (videosResponse: any) => {
  const data = videosResponse?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.aweme_list)) return data.aweme_list;
  if (Array.isArray(data?.item_list)) return data.item_list;
  if (Array.isArray(videosResponse?.aweme_list)) return videosResponse.aweme_list;
  return [];
};

// 单条上游作品是否可分析。
// 抖音允许「无描述发布」，所以「有文案」不是必要条件；但至少要能拿到真实作品 id，
// 或者「真实文案 + 真实分享链接」。上游偶尔夹带的空壳（无 id、无文案、无统计）必须
// 在这里被拦住：它既不能占用 60 条窗口的名额，也不能被兜底标题洗成一条看起来合法的
// 作品 —— 否则下游没有任何一层还能把它和真实作品区分开。
const isAnalysableRawVideo = (raw: any) => {
  if (!raw || typeof raw !== "object") return false;
  const id = toText(raw?.aweme_id || raw?.awemeId || raw?.item_id || raw?.id);
  const title = toText(raw?.desc || raw?.title || raw?.description);
  const shareLink = toText(raw?.share_url || raw?.shareUrl || raw?.share_link);
  return Boolean(id) || Boolean(title && shareLink);
};

export type BenchmarkAccountProfile = {
  /** 账号简介（签名）。模块 1「商业定位」的唯一直接依据。 */
  signature: string;
  /** 粉丝数。取不到就是 0 —— 不要拿 0 当「没有粉丝」的结论，只当「没取到」。 */
  followerCount: number;
  /**
   * 抖音 sec_user_id。模块 1「用户画像」要用它去拉**真实的粉丝画像**分布
   * （性别/年龄/收入/消费习惯）。取不到就是空串，此时画像只能靠推断。
   */
  secUserId: string;
};

const PROFILE_TEXT_KEYS = ["signature", "signatureText", "bio", "desc"];
const PROFILE_COUNT_KEYS = ["follower_count", "followerCount", "fans_count", "fansCount"];

/**
 * 从 TikHub 抓取结果里提取账号资料（简介 / 粉丝数）。
 *
 * **为什么要写得这么容错**：TikHub 的 `get_sec_user_id` 在官方文档里只给了泛型
 * `ResponseModel`，**没有描述嵌套字段**，而作品列表里的 `author` 对象又是另一套字段名。
 * 所以这里按「多个候选根 × 多个候选键」提取，思路与 `normalizeBenchmarkVideos` 的
 * 字段别名兼容一致。
 *
 * 取不到一律返回空串 —— 绝不编一个简介出来。1.2 的商业定位完全建立在这段文字上，
 * 宁可让项目经理看到「待人工补充」，也不要给他一段看着像简介的假话。
 */
export const extractAccountProfile = (result: any): BenchmarkAccountProfile => {
  const secUser = result?.secUserResponse;
  const videos = extractVideos(result?.videosResponse);
  const firstVideo = videos[0] as any;
  const author = firstVideo?.author || firstVideo?.user || {};
  // 候选根按可信度排序：账号接口的返回体 > 作品里的作者对象。
  const roots = [
    secUser?.data?.user,
    secUser?.data?.user_info,
    secUser?.data,
    secUser?.user,
    secUser,
    author,
  ].filter(root => root && typeof root === "object");

  let signature = "";
  let followerCount = 0;
  for (const root of roots) {
    if (!signature) {
      for (const key of PROFILE_TEXT_KEYS) {
        const value = toText((root as any)?.[key]).replace(/\s+/g, " ").trim();
        if (value) { signature = value.slice(0, 1000); break; }
      }
    }
    if (!followerCount) {
      for (const key of PROFILE_COUNT_KEYS) {
        const value = toNumber((root as any)?.[key]);
        if (value > 0) { followerCount = value; break; }
      }
    }
    if (signature && followerCount) break;
  }

  // sec_user_id 在批次结果上是**顶层字段**（batch 解析账号时就已经拿到），
  // 也可能藏在 secUserResponse 里（实测 `data` 直接就是那串 id）。两条都认。
  const secUserId = toText(
    result?.secUserId
    || (typeof secUser?.data === "string" ? secUser.data : "")
    || secUser?.data?.sec_uid
    || author?.sec_uid,
  );
  return { signature, followerCount, secUserId };
};

export const normalizeBenchmarkVideosFromBatch = (
  result: any,
  platform: BenchmarkPlatform,
  options: { minLikes?: number; maxVideos?: number } = {},
): BenchmarkVideo[] => {
  const accountName = toText(result?.authorName, "未知作者");
  const minLikes = Math.max(0, toNumber(options.minLikes));
  const maxVideos = Math.max(1, Math.min(200, toNumber(options.maxVideos) || 60));
  // 顺序很重要：先剔除不可分析条目，再截取 60 条窗口，最后才做字段映射。
  return extractVideos(result?.videosResponse)
    .filter(isAnalysableRawVideo)
    .filter((raw: any) => {
      if (minLikes <= 0) return true;
      const statistics = raw?.statistics || raw?.stats || {};
      return toNumber(statistics?.digg_count ?? statistics?.like_count ?? raw?.like_count) >= minLikes;
    })
    .slice(0, maxVideos)
    .map((raw: any, index: number) => {
      const rawId = toText(raw?.aweme_id || raw?.awemeId || raw?.item_id || raw?.id);
      const id = rawId || `benchmark-${index + 1}`;
      const title = toText(raw?.desc || raw?.title || raw?.description).replace(/\s+/g, " ").slice(0, 240);
      const author = raw?.author || raw?.user || {};
      const statistics = raw?.statistics || raw?.stats || {};
      const tiktokUsername = toText(author?.unique_id || author?.uniqueId);
      // 只有拿到真实作品 id 时才用 id 拼作品链接；拿不到就宁可留空，
      // 绝不用本地占位 id 造一个能打开却指向别处的假链接。
      const idLink = rawId
        ? (platform === "tiktok"
          ? (tiktokUsername ? `https://www.tiktok.com/@${tiktokUsername}/video/${rawId}` : `https://www.tiktok.com/video/${rawId}`)
          : `https://www.douyin.com/video/${rawId}`)
        : "";
      const link = toText(raw?.share_url || raw?.shareUrl || raw?.share_link, idLink);
      const rawText = toText(raw?.desc || raw?.description || raw?.title).replace(/\s+/g, " ");
      const createTime = raw?.create_time ?? raw?.createTime ?? raw?.publish_time ?? raw?.publishTime;
      return {
        id,
        title,
        link,
        authorName: toText(author?.nickname || author?.name || result?.authorName, accountName),
        publishDate: formatDate(createTime),
        sourceText: rawText.slice(0, 900),
        coverUrl: toText(raw?.cover || raw?.cover_url || raw?.video?.cover),
        platform,
        stats: {
          likes: toNumber(statistics?.digg_count ?? statistics?.like_count ?? raw?.like_count),
          comments: toNumber(statistics?.comment_count ?? raw?.comment_count),
          shares: toNumber(statistics?.share_count ?? raw?.share_count),
          bookmarks: toNumber(statistics?.collect_count ?? statistics?.favorite_count ?? raw?.collect_count),
        },
      };
    });
};

export const formatNumber = (value: number) => {
  const number = toNumber(value);
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
  return number.toLocaleString("zh-CN");
};

export const reportToMarkdown = (report: BenchmarkReport, selectedIds: Set<string>) => {
  const lines = [
    `# ${report.contentStyleLabel}｜${report.account.name}`,
    "",
    `- 平台：${report.account.platformLabel}`,
    `- 分析作品：${report.analyzedCount} 条`,
    `- 重点样本：${selectedIds.size} 条（人工标记的研究重点，供后续步骤参考）`,
    `- 分析时间：${report.analyzedAt ? new Date(report.analyzedAt).toLocaleString("zh-CN") : "未知"}`,
    "",
    `## 账号整体概括\n${report.summary}`,
    "",
  ];
  report.categories.forEach((category, index) => {
    lines.push(`## ${index + 1}. ${category.name} ${category.percentage}%（${category.count} 条）`);
    lines.push(`核心作用：${category.coreFunction}`);
    if (category.keywords.length > 0) lines.push(`关键词：${category.keywords.join("、")}`);
    category.subcategories.forEach(subcategory => {
      lines.push(`### ${subcategory.name}（${subcategory.topics.length} 条）`);
      if (subcategory.description) lines.push(subcategory.description);
      subcategory.topics.forEach(entry => {
        // 新报告的选题只存了引用，导出时要回查 videos 才能拿到链接和点赞。
        const topic = resolveTopicVideo(entry, report.videos);
        lines.push(`- ${selectedIds.has(topic.id) ? "[重点]" : "[ ]"} ${topic.title}｜${topic.link}｜点赞 ${topic.stats.likes}`);
      });
    });
    lines.push("");
  });
  return lines.join("\n");
};
