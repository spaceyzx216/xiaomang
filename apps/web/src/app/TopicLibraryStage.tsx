import { useEffect, useRef, useState } from "react";
import { apiUrl, fetchWithRetry } from "./api";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Database,
  FolderPlus,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { StageChip, StageShell } from "./StageShell";
import { useStageDraft } from "./stageDraft";
import {
  normalizeBenchmarkVideosFromBatch,
  type BenchmarkPlatform,
  type SavedBenchmarkReport,
  type SavedBenchmarkReportSummary,
} from "./benchmarkAnalysis";
import { getBenchmarkReport, listBenchmarkReports, listCustomers, parseApiError } from "./reportApi";
import type { CustomerSummary } from "./accountPlan";
import { topicRequestLimits } from "./topicTimeWindow";
import {
  analyzeTopicRefresh,
  clearTopicRefreshSession,
  deleteTopicLibrary,
  getTopicCategoryDictionary,
  getTopicLibrary,
  getTopicRefreshSession,
  removeTopicLibraryAccount,
  saveTopicLibraryAccount,
  saveTopicRefreshCandidates,
  transcribeTopicRefresh,
  type TopicCategoryDictionary,
  type TopicLibraryDetail,
  type TopicRefreshItem,
  type TopicRefreshReport,
  type TopicRefreshVideo,
} from "./topicLibrary";

/**
 * 模块 3 的产出步骤（2.4）：正式选题库 + 近期新更新视频筛选。
 *
 * ── 业务口径（用户已拍板，别再自行发明，见 HANDOFF §0.1）──────────────────
 * 1. 库来自 **2.1 分类分析报告**（不是 1.3 的客户报告）。
 * 2. **客户级**：一个客户一份库，可纳入多个对标账号；各账号分类**各自独立、不合并**。
 * 3. 落库靠**人工点「保存入库」**；下面列表的勾选**只留在前端，不入库**。
 * 4. 筛选是**严格 `likes > 100`**（100 不达标），不是「按点赞排序」。
 * 5. 时间窗口默认近 7 天、可选；**不要把模块 3 的「最新 60 条」口径改成这个增量口径**，
 *    两者是不同业务（HANDOFF §0.1 第 3 条）。
 * 6. 默认时间范围复用 `topicTimeWindow`，不另造一套组件。
 */

type Props = {
  embedded?: boolean;
  /** 2.1 刚保存的分类报告：直接交接过来，用户不必再挑一次。 */
  preselectedReport?: SavedBenchmarkReport | null;
  onSaved?: () => void;
  /**
   * 库被删除 / 清空时回调 —— 让外面撤掉「2.4 已完成」标记。
   * 少了它，删掉库之后步骤仍显示 ✓ 已完成，那是在撒谎。
   */
  onCleared?: () => void;
  onGoToClassification?: () => void;
  /**
   * 员工只读模式（2026-09-21 用户拍板：员工也要能跑新视频筛选打标签）。
   *
   * 员工**不建库也不改库** —— 库由项目经理在 2.4 里建。员工只把库里的分类当词典用，
   * 所以这里藏掉客户/报告选择与保存/删除/移除入口，只留「新更新视频筛选与标签」。
   * 后端写操作仍然是 manager-only，前端藏起来只是不让人白点。
   */
  readOnly?: boolean;
  /** 员工侧由临时任务的「绑定客户」带进来：直接锁定该客户的库，不再给客户下拉。 */
  lockedCustomerId?: string;
};

/** 点赞门槛：用户口径是严格大于，100 不满足。 */
const MIN_LIKES = 100;

/** 时间窗口可选项，默认近 7 天。 */
const DAY_OPTIONS = [7, 15, 30, 90] as const;

/** 分批转写的安全上限：避免后端异常时前端死循环。 */
const TRANSCRIBE_MAX_ROUNDS = 20;

/** 单次抓取的候选上限。抓满这个数就说明窗口内还有没拿到的作品，界面要如实提示。 */
const FETCH_MAX_VIDEOS = 200;

/**
 * 从主页链接判断平台。
 *
 * ⚠️ 必须**锚定 host**，不能拿整个 URL 去 test：否则
 * `https://www.douyin.com/user/x?from=tiktok.com` 会被判成 tiktok，
 * 于是抓取请求带着错误的平台打给 TikHub。解析失败时保守回退 douyin。
 */
const platformFromUrl = (url: string): BenchmarkPlatform => {
  try {
    const host = new URL(String(url || "").trim()).hostname.toLowerCase();
    return host === "tiktok.com" || host.endsWith(".tiktok.com") ? "tiktok" : "douyin";
  } catch {
    return "douyin";
  }
};

const formatTime = (value?: string) => {
  const text = String(value || "").trim();
  if (!text) return "—";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const compactNumber = (value: number) => {
  const n = Number(value) || 0;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  return String(n);
};

const sourceLabel = (item: TopicRefreshItem) =>
  item.scriptSource === "transcript" ? "真实转写" : "发布文案推断";

const confidenceTone = (confidence: TopicRefreshItem["confidence"]) => {
  if (confidence === "high") return "bg-emerald-100 text-emerald-700";
  if (confidence === "medium") return "bg-blue-100 text-blue-700";
  return "bg-amber-100 text-amber-700";
};

/**
 * 某一项分析在库里进没进来。
 *
 * 用户要求库里同时纳入 2.1/2.2/2.3，但 2.2/2.3 报告**没有存来源分类报告的 id**，
 * 只能按采样视频集合关联 —— 匹配不上就如实显示「未纳入」，让人知道该去补跑哪一步。
 */
function AnalysisBadge({ label, status }: { label: string; status: "included" | "missing" | "sample_mismatch" }) {
  const tone = status === "included"
    ? "bg-emerald-50 text-emerald-700"
    : status === "sample_mismatch"
      ? "bg-amber-50 text-amber-700"
      : "bg-slate-100 text-slate-400";
  const suffix = status === "included" ? "" : status === "sample_mismatch" ? "采样不一致" : "未纳入";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {label}{suffix ? ` · ${suffix}` : " ✓"}
    </span>
  );
}

const isReviewItem = (item: TopicRefreshItem) => item.category.id === "review";

/**
 * 流式打标签的**批大小**。
 *
 * 实测（2026-09-21，deepseek-v4-flash，真实库+真实视频）：一次判 8 条要 21.6s，
 * 一次判 30 条要 22.8s —— **模型调用有个 ~20s 的固定开销**，跟条数几乎无关。
 * 所以批不能开太小（批越多、固定开销付得越多），也不能太大（首条结果来得太晚）。
 * 取 5：首屏大约 20~30s 出第一批，同时总调用数不会爆炸。
 */
const TAG_BATCH_SIZE = 5;

/** 把数组切成固定大小的批（最后一批可能不足）。 */
const chunkItems = <T,>(items: T[], size: number): T[][] => {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

export function TopicLibraryStage({
  embedded = false,
  preselectedReport,
  onSaved,
  onCleared,
  onGoToClassification,
  readOnly = false,
  lockedCustomerId = "",
}: Props) {
  // ---- 选题库 ----
  const [library, setLibrary] = useState<TopicLibraryDetail | null>(null);
  /**
   * 员工端的**轻量**词典（只要大类/小类，不含三份报告快照）。
   *
   * 用户 2026-09-21 拍板的新顺序：**抓视频 → 提脚本 → 再读库 → 打标签**。
   * 所以员工侧不再在挂载时把整个库读回来（那会把每账号三份报告一起拖下来，
   * 单份分类报告正文就约 148 KB，首屏白等）—— 改成按需读，而且只读词典这一支。
   */
  const [dictionary, setDictionary] = useState<TopicCategoryDictionary | null>(null);
  const [dictionaryLoading, setDictionaryLoading] = useState(false);
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [savedReports, setSavedReports] = useState<SavedBenchmarkReportSummary[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState("");
  const [savingLibrary, setSavingLibrary] = useState(false);
  const [busyAccountKey, setBusyAccountKey] = useState("");
  const [libraryMessage, setLibraryMessage] = useState("");

  // 草稿：切步骤/刷新不丢已选客户与链接（但不存 loading/error 这类瞬时状态）。
  const [customerId, setCustomerId] = useStageDraft<string>("topicLibrary.customerId", "");
  // 员工侧：客户由临时任务的「绑定客户」定死，覆盖草稿里的旧值。
  // ⚠️ 不能只把 lockedCustomerId 当初始值：草稿（sessionStorage）里可能残留上次
  // 看过的别的客户，只当初始值的话会被草稿盖掉，员工就会读到**别人的库**。
  useEffect(() => {
    if (lockedCustomerId && lockedCustomerId !== customerId) setCustomerId(lockedCustomerId);
  }, [lockedCustomerId, customerId, setCustomerId]);

  // 换客户必须把**上一个客户**的词典与提取进度清掉，否则会拿 A 客户的分类去给 B 客户的
  // 视频打标签 —— 而且不会有任何报错（分类 id 带了账号作用域，但客户之间是会串的）。
  useEffect(() => {
    setDictionary(null);
    setExtractedCount(0);
  }, [customerId]);

  const [accountUrl, setAccountUrl] = useStageDraft<string>("topicLibrary.accountUrl", "");
  const [recentDays, setRecentDays] = useStageDraft<number>("topicLibrary.recentDays", 7);
  const [selectedReportId, setSelectedReportId] = useStageDraft<string>("topicLibrary.reportId", "");

  // ---- 新视频筛选 ----
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [fetchMessage, setFetchMessage] = useState("");
  const [fetchedTotal, setFetchedTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [candidates, setCandidates] = useState<TopicRefreshVideo[]>([]);
  const [transcribing, setTranscribing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  /** 本轮已提取到的完整脚本条数（提取在打标签之前发生，用它给用户一个即时反馈）。 */
  const [extractedCount, setExtractedCount] = useState(0);
  /** 流式打标签：已经判完的条目（**边判边贴**，不等全批）。 */
  const [streamItems, setStreamItems] = useState<TopicRefreshItem[]>([]);
  /** 还在处理的条数（用于「还剩 N 条」提示）。 */
  const [pendingCount, setPendingCount] = useState(0);
  /** 脚本已转写好的条数（流式过程中实时更新）。 */
  const [transcribedCount, setTranscribedCount] = useState(0);
  /** 流式过程中的汇总（结果面板顶部的统计 chips 用）。 */
  const [streamSummary, setStreamSummary] = useState<TopicRefreshReport | null>(null);
  /** 本次的候选与标签是从**上次的处理进度**恢复来的（非空则表示「续跑」而不是新跑）。 */
  const [restoredAt, setRestoredAt] = useState("");
  const [refreshReport, setRefreshReport] = useState<TopicRefreshReport | null>(null);
  const [selectedVideoIds, setSelectedVideoIds] = useState<string[]>([]);
  const [expandedVideoId, setExpandedVideoId] = useState("");

  // 载入客户名册 + 已保存的分类报告（都是挑「要纳入库的那一份」用的）。
  //
  // 🔴 **员工只读模式必须提前退出**：这两份列表只有经理端的两个下拉用得到，而
  // `/api/customers` 与 `/api/benchmark-reports` 都是 **manager-only**（员工拿 403）。
  // 少了这个守卫，员工一进 `/topics?view=newVideos` 就会在白发两个必然失败的请求，
  // 并把 403 文案「该功能仅供项目经理使用」渲染成页面顶部的红色错误条 ——
  // 员工看到一句与自己无关的报错，会以为功能坏了（2026-09-21 无头 Chrome 实测复现）。
  useEffect(() => {
    if (readOnly) return;
    let cancelled = false;
    (async () => {
      try {
        const [customerList, reportList] = await Promise.all([listCustomers(), listBenchmarkReports()]);
        if (cancelled) return;
        setCustomers(customerList);
        setSavedReports(reportList);
      } catch (error) {
        if (!cancelled) setLibraryError(error instanceof Error ? error.message : "客户名册 / 分类报告读取失败");
      }
    })();
    return () => { cancelled = true; };
  }, [readOnly]);

  // 选了客户就取它的库；没选时看有没有已建的库，方便用户知道该选哪个客户。
  //
  // ⚠️ **员工只读模式不走这条路**：员工端要的是「先抓视频、先提脚本，最后才读库」，
  // 而且只需要轻量词典（见 ensureDictionary）。这里读的是完整库正文（含三份报告快照），
  // 对员工既没必要也慢 —— 只有经理端的建库/维护界面才需要。
  useEffect(() => {
    let cancelled = false;
    if (readOnly) return;
    if (!customerId) {
      setLibrary(null);
      setLibraryLoading(false);
      return () => { cancelled = true; };
    }
    setLibraryLoading(true);
    setLibraryError("");
    (async () => {
      try {
        const detail = await getTopicLibrary(customerId);
        if (!cancelled) setLibrary(detail);
      } catch (error) {
        if (!cancelled) setLibraryError(error instanceof Error ? error.message : "选题库读取失败");
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [customerId, readOnly]);

  /**
   * 按需取「打标签用的分类词典」（员工端）。
   *
   * 只在真的要打标签时才读，且走 `?view=categories` 轻量视图：
   * 只要大类/小类，不把每账号三份报告快照一起拖回来。
   * 已经有词典就不重复请求（同一轮里三番五次点「打标签」不该反复打网络）。
   *
   * 返回 null 表示这个客户**还没有正式选题库** —— 打标签没有词典可用，
   * 调用方必须如实告诉用户去让项目经理建库，而不是打出一堆「待人工复核」。
   */
  const ensureDictionary = async (): Promise<TopicCategoryDictionary | null> => {
    if (!customerId) return null;
    if (dictionary) return dictionary;
    setDictionaryLoading(true);
    setLibraryError("");
    try {
      const detail = await getTopicCategoryDictionary(customerId);
      setDictionary(detail);
      return detail;
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "选题库词典读取失败");
      return null;
    } finally {
      setDictionaryLoading(false);
    }
  };

  /**
   * 挂载时先看看上次的进度还在不在（B2：刷新/离开再回来直接续上）。
   *
   * ⚠️ 只在员工只读视图做：那里的客户由 URL 锁定，语义明确。
   * 恢复失败一律静默 —— 拿不到旧进度只是「要重跑」，不该把新的一轮也挡住。
   */
  useEffect(() => {
    if (!readOnly || !customerId) return;
    let cancelled = false;
    (async () => {
      try {
        const session = await getTopicRefreshSession(customerId);
        if (cancelled || !session) return;
        if (session.videos.length === 0) return;
        setCandidates(session.videos);
        setStreamItems(session.items);
        setRestoredAt(session.updatedAt);
        setStreamSummary({
          version: "1.0",
          reportType: "benchmark_topic_refresh",
          recentDays: session.recentDays,
          minLikes: session.minLikes,
          analyzedCount: session.items.length,
          transcriptCount: 0,
          captionFallbackCount: 0,
          categories: [],
          items: session.items,
          analysisSource: "agent",
          warnings: [],
          analyzedAt: session.updatedAt,
        });
        setFetchMessage(
          session.items.length > 0
            ? `已恢复上次的处理进度：${session.items.length} 条已判完，可以接着往下跑。`
            : `已恢复上次抓取的 ${session.videos.length} 条候选，可以接着提取脚本与打标签。`,
        );
      } catch {
        // 读不到就当没有进度
      }
    })();
    return () => { cancelled = true; };
  }, [readOnly, customerId]);

  // 默认选中 2.1 刚交接过来的那份报告。
  useEffect(() => {
    if (preselectedReport?.id && !selectedReportId) setSelectedReportId(preselectedReport.id);
  }, [preselectedReport?.id, selectedReportId]);

  // ⚠️ 直接进 2.4（没走 2.1→2.4 的交接）时，报告下拉**显示**第一份报告，
  // 但 `selectedReportId` 还是空的 —— 浏览器会自动把第一个 option 选中，
  // React 状态却不知道。结果就是「下拉看着已选好、『保存入库』却是灰的」。
  // 这里把「没选过就默认第一份」补进状态，让显示与可用性一致。
  useEffect(() => {
    if (readOnly) return;
    if (selectedReportId) return;
    const first = savedReports[0]?.id;
    if (first) setSelectedReportId(first);
  }, [readOnly, savedReports, selectedReportId, setSelectedReportId]);

  // 下拉框是「要纳入哪一份报告」的**唯一事实来源**。
  //
  // ⚠️ 这里必须用「下拉当前值」而不是 `selectedReportId` 状态：草稿里可能已经存着一个
  // 旧值，而 React 的 select 在没有匹配 option 时，`option[0]` 就是它实际显示的东西。
  // 只读状态会让「显示 A、实际入库 B」。下面按同一个值反查，显示与入库就不会分叉。
  const reportSelect = useRef<HTMLSelectElement | null>(null);
  const effectiveReportId = reportSelect.current?.value || selectedReportId || "";
  // 只有「2.1 刚交接的那份」才有内存正文，其余按 id 回库取。
  const canUsePreselected = Boolean(preselectedReport?.id) && effectiveReportId === preselectedReport?.id;
  const selectedSummary = savedReports.find(item => item.id === effectiveReportId) || null;
  // 报告下拉永远至少有一个 option（preselected 或已保存列表），所以这里不会恒 false。
  const canSaveLibrary = Boolean(customerId && (canUsePreselected || selectedSummary)) && !savingLibrary;

  const refreshLibraries = async () => {
    if (!customerId) return;
    const detail = await getTopicLibrary(customerId);
    setLibrary(detail);
  };

  const handleSaveLibrary = async () => {
    if (!customerId) {
      setLibraryError("请先选择这份选题库归属的客户");
      return;
    }
    const reportId = reportSelect.current?.value || selectedReportId || preselectedReport?.id || "";
    if (!reportId) {
      setLibraryError("请先选择要纳入选题库的分类报告");
      return;
    }
    setSavingLibrary(true);
    setLibraryError("");
    setLibraryMessage("");
    try {
      // 2.1 刚交接的那份直接用内存正文（不必再回库取一遍）；选别的才按 id 取。
      const usePreselected = Boolean(preselectedReport?.id) && reportId === preselectedReport?.id;
      const report: SavedBenchmarkReport | null = usePreselected
        ? (preselectedReport as SavedBenchmarkReport)
        : await getBenchmarkReport(reportId);
      if (!report?.report) throw new Error("没有取到可入库的分类报告正文，请重新选择一份");

      const detail = await saveTopicLibraryAccount(customerId, report.report);
      setLibrary(detail);
      setLibraryMessage(`已把「${report.report.account?.name || "该账号"}」纳入选题库`);
      onSaved?.();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "保存选题库失败");
    } finally {
      setSavingLibrary(false);
    }
  };

  const handleRemoveAccount = async (accountKey: string) => {
    if (!customerId) return;
    setBusyAccountKey(accountKey);
    setLibraryError("");
    setLibraryMessage("");
    try {
      const result = await removeTopicLibraryAccount(customerId, accountKey);
      await refreshLibraries();
      setLibraryMessage("已从选题库移除该对标账号");
      // 移掉最后一个账号时后端会把空壳库一起删掉，这时「已完成」必须撤掉。
      if (result.libraryDeleted) onCleared?.();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "移除失败");
    } finally {
      setBusyAccountKey("");
    }
  };

  const handleDeleteLibrary = async () => {
    if (!customerId) return;
    setSavingLibrary(true);
    setLibraryError("");
    setLibraryMessage("");
    try {
      await deleteTopicLibrary(customerId);
      setLibrary(null);
      setLibraryMessage("已删除该客户的选题库");
      onCleared?.();
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : "删除选题库失败");
    } finally {
      setSavingLibrary(false);
    }
  };

  /** 抓近期新更新的视频，再按严格 `likes > 100` 过滤。 */
  const handleFetchNewVideos = async () => {
    const url = String(accountUrl || "").trim();
    if (!url) {
      setFetchError("请填写对标账号的主页链接");
      return;
    }
    setFetching(true);
    setFetchError("");
    setFetchMessage("");
    setRefreshReport(null);
    setSelectedVideoIds([]);
    setFetchedTotal(0);
    setCandidates([]);
    setTruncated(false);
    setExtractedCount(0);
    // 换了一批视频，上一轮的流式结果必须清掉，否则新旧混在一起分不清
    setStreamItems([]);
    setStreamSummary(null);
    setPendingCount(0);
    try {
      const platform = platformFromUrl(url);
      const limits = topicRequestLimits(recentDays);
      setFetchMessage(`正在抓取近 ${recentDays} 天更新的作品…`);
      const response = await fetchWithRetry(apiUrl("/api/tikhub/batch"), {
        method: "POST",
        retries: 1,
        retryBaseDelayMs: 800,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: [url], platform, days: recentDays, ...limits }),
      });
      const data = await parseApiError(response);
      const result = data?.results?.[0];
      if (!result || result.error) throw new Error(String(result?.error || "未能获取该账号的视频作品"));

      const videos = normalizeBenchmarkVideosFromBatch(result, platform, { maxVideos: FETCH_MAX_VIDEOS });
      // 严格 `> 100`：点赞缺失（0）不算达标，也不能把「排序」当成「门槛」。
      const qualified = videos.filter(video => Number(video.stats?.likes || 0) > MIN_LIKES);
      setFetchedTotal(videos.length);
      // 抓满上限就说明窗口内还有没拿到的作品 —— 必须说出来，不能让用户以为已经抓全了。
      setTruncated(videos.length >= FETCH_MAX_VIDEOS);
      setCandidates(qualified.map(video => ({
        id: video.id,
        title: video.title,
        link: video.link,
        authorName: video.authorName,
        publishDate: video.publishDate,
        sourceText: video.sourceText,
        platform: video.platform,
        stats: video.stats,
      })));
      setFetchMessage(
        qualified.length === 0
          ? `近 ${recentDays} 天抓到 ${videos.length} 条，没有点赞超过 ${MIN_LIKES} 的作品（门槛是严格大于，${MIN_LIKES} 不算达标）。`
          : `近 ${recentDays} 天抓到 ${videos.length} 条，其中 ${qualified.length} 条点赞超过 ${MIN_LIKES}。`,
      );
      // 候选落库（B2）：后半程要跑几十秒到几分钟，刷新/离开再回来要能续上。
      // ⚠️ 换了候选就必须清掉旧标签 —— 否则会出现「这批没抓过的视频却带着上一批的标签」。
      setRestoredAt("");
      if (qualified.length > 0) {
        await saveTopicRefreshCandidates({
          customerId,
          accountUrl: url,
          recentDays,
          minLikes: MIN_LIKES,
          videos: qualified.map(video => ({
            id: video.id,
            title: video.title,
            link: video.link,
            authorName: video.authorName,
            publishDate: video.publishDate,
            sourceText: video.sourceText,
            platform: video.platform,
            stats: video.stats,
          })),
        }).catch(() => {
          // 落进度失败不该让已经抓到的结果作废：界面上照旧可用，只是没法续跑
          setFetchMessage(previous => `${previous}（进度没能保存，刷新后需要重跑）`);
        });
      }
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "抓取失败");
    } finally {
      setFetching(false);
    }
  };

  /**
   * 提取完整脚本（分批循环，直到后端说 finished）。
   *
   * ⚠️ 这一步**不需要选题库**：转写只认视频链接。所以放在「读库」之前，
   * 用户看到顺序就是「抓视频 → 提脚本 → 打标签」。
   */
  const handleExtractScripts = async () => {
    if (candidates.length === 0) return;
    setTranscribing(true);
    setFetchError("");
    setRefreshReport(null);
    setStreamItems([]);
    setStreamSummary(null);
    setPendingCount(0);
    try {
      let round = 0;
      let progress = { total: candidates.length, ok: 0, failed: 0, attempted: 0, finished: false };
      setFetchMessage("正在提取完整脚本（真实口播转写）…");
      while (round < TRANSCRIBE_MAX_ROUNDS) {
        round += 1;
        progress = await transcribeTopicRefresh({
          videos: candidates,
          recentDays,
          minLikes: MIN_LIKES,
        });
        setFetchMessage(
          `正在提取完整脚本：已处理 ${progress.attempted}/${progress.total}（成功 ${progress.ok}，失败 ${progress.failed}）`,
        );
        if (progress.finished) break;
      }
      if (!progress.finished) throw new Error("脚本提取没有在预期轮数内完成，请重试剩余部分");
      // 失败条目要把原因说出来 —— 只报「成功 0 条」等于没说（2026-09-21 踩过：
      // 转写其实成功了，只是记到了别的 scope 上，界面上却只显示「0 条」）。
      const failures = (progress.batch || []).filter(item => item.status === "failed");
      setFetchMessage(
        failures.length === 0
          ? `脚本提取完成：成功 ${progress.ok} 条，失败 ${progress.failed} 条（失败的会退回发布文案）。`
          : `脚本提取完成：成功 ${progress.ok} 条，失败 ${progress.failed} 条。失败原因示例：${failures[0].error || "未返回原因"}`,
      );
      if (progress.ok > 0) setExtractedCount(progress.ok);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "脚本提取失败");
    } finally {
      setTranscribing(false);
    }
  };

  /**
   * 按库内分类给新视频打标签 —— **流式**：一条（一小批）处理好就立刻显示，
   * 不再等全部脚本转写完才出结果。
   *
   * 为什么这么改（2026-09-21 用户反馈「等所有脚本都转完才显示标签，体感太慢」）：
   * 老流程是「全部转写 → 一次打标签 → 一次性出结果」，中间几十秒到几分钟里界面上
   * 什么都没有。现在改成**小批流水线**：
   *   ① 先读一次轻量词典（只要大类/小类）—— 与用户拍板的顺序一致：
   *      抓视频 → 提脚本 → **再读库** → 打标签；没有库就没词典，直接如实拒掉，
   *      不去打一堆「待人工复核」让用户以为标签错了；
   *   ② 每批 N 条：先转写这一批，转完**立刻发这一批的打标签请求**（不 await，
   *      让它的模型调用与下一批的转写**并行**）；
   *   ③ 哪一批回来就把哪一批的标签贴到列表上 —— 用户从头到尾都在看着东西变多。
   *
   * 后端不需要新接口：`phase=analyze` 本来就只处理传进去的视频，
   * 传一小批就等于「给这一小批打标签」。
   */
  const handleAnalyze = async ({ reset = false }: { reset?: boolean } = {}) => {
    if (candidates.length === 0) return;
    // 续跑：只处理**还没判过**的（刷新回来接着跑时，已经花过钱的不能再来一遍）
    const taggedIds = new Set(streamItems.map(item => item.video.id));
    const todo = reset ? candidates : candidates.filter(video => !taggedIds.has(video.id));
    if (todo.length === 0) {
      setFetchMessage("这一批已经全部判完了；要重判请点「重新打标签」。");
      return;
    }
    setAnalyzing(true);
    setFetchError("");
    setRefreshReport(null);
    if (reset) {
      setStreamItems([]);
      setStreamSummary(null);
      setRestoredAt("");
      // 会话里的旧条目也要一起清，否则刷新后又「恢复」出已经被重判掉的旧标签
      await saveTopicRefreshCandidates({
        customerId,
        accountUrl: String(accountUrl || "").trim(),
        recentDays,
        minLikes: MIN_LIKES,
        videos: candidates,
      }).catch(() => {});
    }
    setPendingCount(todo.length);
    try {
      setFetchMessage("正在读取这个客户的选题库分类…");
      const dictionaryDetail = await ensureDictionary();
      if (!dictionaryDetail || dictionaryDetail.tagDictionary.length === 0) {
        setFetchMessage("");
        setFetchError("这个客户还没有正式选题库，请联系项目经理先在账号定位里建库，否则无法打标签。");
        return;
      }

      const batches = chunkItems(todo, TAG_BATCH_SIZE);
      const failures: string[] = [];
      const tagging: Array<Promise<void>> = [];

      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        setFetchMessage(`正在提取脚本并打标签：第 ${index + 1}/${batches.length} 批（共 ${todo.length} 条）…`);
        // ① 先把这一批的脚本转出来（已经转过的会被后端跳过，不会重复花钱）
        const progress = await transcribeTopicRefresh({ videos: batch, recentDays, minLikes: MIN_LIKES });
        setTranscribedCount(previous => previous + progress.ok);
        for (const entry of progress.batch || []) {
          if (entry.status === "failed" && entry.error) failures.push(entry.error);
        }

        // ② 不 await：让这一批的模型调用与下一批的转写并行跑
        tagging.push(
          analyzeTopicRefresh({
            videos: batch,
            categories: dictionaryDetail.tagDictionary,
            recentDays,
            minLikes: MIN_LIKES,
            // 后端据此把这一批的条目落进「处理进度」——刷新后能续上（B2）
            customerId,
          }).then(report => {
            // ③ 哪批回来贴哪批 —— 列表当场变长，用户不用干等
            setStreamSummary(report);
            setStreamItems(previous => [...previous, ...report.items]);
            setPendingCount(previous => Math.max(0, previous - batch.length));
          }),
        );
      }

      const settled = await Promise.allSettled(tagging);
      const rejected = settled.filter(item => item.status === "rejected");
      if (rejected.length > 0) {
        const first = rejected[0] as PromiseRejectedResult;
        throw new Error(first.reason instanceof Error ? first.reason.message : "标签分析失败");
      }
      setFetchMessage(
        failures.length > 0
          ? `打标签完成。有 ${failures.length} 条脚本没转出来，已退回发布文案判断（示例：${failures[0]}）。`
          : "打标签完成。",
      );
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "标签分析失败");
    } finally {
      setAnalyzing(false);
      setPendingCount(0);
    }
  };

  /** 「重新开始」：清掉后端存的进度与界面上的结果，回到刚抓完视频的状态。 */
  const handleRestart = async () => {
    setRestoredAt("");
    setStreamItems([]);
    setStreamSummary(null);
    setPendingCount(0);
    setRefreshReport(null);
    setFetchMessage("");
    await clearTopicRefreshSession(customerId).catch(() => {});
  };

  const toggleVideo = (videoId: string) => {
    setSelectedVideoIds(previous =>
      previous.includes(videoId) ? previous.filter(id => id !== videoId) : [...previous, videoId]);
  };

  // ---------- 选题库面板 ----------
  // ---------- 选题库面板 ----------
  //
  // 项目经理：选客户 + 选报告 → 保存入库；可移除账号、删除整库。
  // 员工（readOnly）：库由项目经理建，这里只显示「用哪个库当词典」，不给任何改库入口。
  const libraryPanel = (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600"><Database className="h-4 w-4" /></span>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">正式选题库</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {readOnly
                ? "打标签用的分类词典来自这个客户的选题库，由项目经理维护。"
                : "一个客户一份库，可纳入多个对标账号的分析结果；各账号的分类各自独立保留，不做合并。"}
            </p>
          </div>
        </div>
        {!readOnly && library ? (
          <button
            type="button"
            onClick={handleDeleteLibrary}
            disabled={savingLibrary}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:border-red-200 hover:text-red-600 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />删除这个库
          </button>
        ) : null}
      </div>

      {readOnly ? (
        <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-xs leading-5 text-slate-600">
          {dictionary
            ? `打标签的词典来自客户「${dictionary.customerName}」的选题库，共 ${dictionary.accountCount} 个对标账号、${dictionary.tagDictionary.length} 个大类。`
            : dictionaryLoading
              ? "正在读取这个客户的选题库分类…"
              : "打标签时会读取这个客户的选题库（只要大类/小类当词典，不读分析报告）。"}
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold text-slate-600">库归属客户</span>
              <select
                value={customerId}
                onChange={event => { setCustomerId(event.target.value); setLibraryMessage(""); }}
                className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-blue-400"
              >
                <option value="">请选择客户…</option>
                {customers.map(customer => (
                  <option key={customer.id} value={customer.id}>{customer.name || customer.id}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-semibold text-slate-600">要纳入的 2.1 分类报告</span>
              <select
                ref={reportSelect}
                value={selectedReportId || preselectedReport?.id || ""}
                onChange={event => { setSelectedReportId(event.target.value); setLibraryMessage(""); }}
                className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-blue-400"
              >
                {preselectedReport ? (
                  <option value={preselectedReport.id}>
                    刚保存：{preselectedReport.accountName || "未命名账号"}（{preselectedReport.analyzedCount} 条）
                  </option>
                ) : null}
                {savedReports.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.accountName || "未命名账号"} · {item.contentStyle === "drama" ? "演绎类" : "口播类"} · {item.analyzedCount} 条 · {formatTime(item.createdAt)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSaveLibrary}
              disabled={!canSaveLibrary}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
            >
              {savingLibrary ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
              保存入库
            </button>
            {savedReports.length === 0 && !preselectedReport ? (
              <button type="button" onClick={onGoToClassification} className="text-xs font-medium text-blue-600 hover:text-blue-700">
                还没有分类报告，先去 2.1 分析一个对标账号
              </button>
            ) : null}
          </div>

          {libraryMessage ? (
            <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-700">{libraryMessage}</div>
          ) : null}
        </>
      )}

      {!readOnly && libraryLoading && customerId ? (
        <div className="mt-5 flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在读取选题库…</div>
      ) : null}

      {/* 员工侧（readOnly）不再在挂载时读整个库，所以这里只对经理端提示「还没建库」；
          员工侧的「有没有库」在真的要打标签时由 ensureDictionary 如实回答。 */}
      {!readOnly && !libraryLoading && customerId && !library ? (
        <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-4 py-3 text-xs leading-5 text-slate-500">
          这个客户还没有正式选题库。选好上面的分类报告后点「保存入库」即可建库。
        </div>
      ) : null}

      {library ? (
        <div className="mt-5 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <StageChip tone="accent">{library.customerName || "未命名客户"}</StageChip>
            <StageChip>{library.accountCount} 个对标账号</StageChip>
            <span>更新于 {formatTime(library.updatedAt)}</span>
          </div>
          {library.accounts.map(account => (
            <div key={account.accountKey} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">{account.accountName || "未命名账号"}</span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">{account.contentStyleLabel}</span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">{account.analyses.classification.categories.length} 个大类</span>
                    {/* 三份分析各自进没进来，卡片上直接说明白，别让人以为库里只有分类。 */}
                    <AnalysisBadge label="2.1 分类" status={account.analyses.classification.status} />
                    <AnalysisBadge label="2.2 黄金三秒" status={account.analyses.goldThreeSeconds.status} />
                    <AnalysisBadge label="2.3 结尾钩子" status={account.analyses.endingHooks.status} />
                    {/*
                      标题库没有自己的第 4 份分析：标题类型就是黄金三秒那 8 个类型
                      （好奇心/恐惧/愤怒/反差/痛点/兴趣/求知欲/欲望），所以标题配比
                      直接复用 2.2 报告的「大类 × 类型」配比。
                      这里用同状态徽章跟着 2.2 走，是为了让用户看得见「标题库是有的、
                      它跟着 2.2 一起进来」，而不是以为标题功能没做。
                    */}
                    <AnalysisBadge
                      label="标题库（同源 2.2）"
                      status={account.analyses.goldThreeSeconds.status}
                    />
                  </div>
                  <p className="mt-1.5 truncate text-xs text-slate-400">{account.accountUrl || "（未记录链接）"}</p>
                </div>
                {!readOnly ? (
                  <button
                    type="button"
                    onClick={() => handleRemoveAccount(account.accountKey)}
                    disabled={busyAccountKey === account.accountKey}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-500 transition hover:border-red-200 hover:text-red-600 disabled:opacity-50"
                  >
                    {busyAccountKey === account.accountKey ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                    移除
                  </button>
                ) : null}
              </div>
              <div className="mt-3 space-y-2">
                {account.analyses.classification.categories.map(category => (
                  <div key={category.id} className="rounded-xl border border-slate-200 bg-white px-3.5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold text-slate-800">{category.name}</span>
                      <span className="text-[11px] text-slate-400">{category.count} 条 · {category.percentage}%</span>
                    </div>
                    {category.coreFunction ? (
                      <p className="mt-1.5 text-[11px] leading-5 text-slate-500">核心功能：{category.coreFunction}</p>
                    ) : null}
                    {category.keywords.length > 0 ? (
                      <p className="mt-1 text-[11px] leading-5 text-slate-500">判断关键词：{category.keywords.join("、")}</p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {category.subcategories.map(subcategory => (
                        <span key={subcategory.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{subcategory.name}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );

  // ---------- 新视频筛选 ----------
  // 员工侧只用「轻量词典」；经理侧走完整库（library）。两边都不再用「库正文」当门槛：
  // 抓视频与提脚本跟库无关，只有打标签需要词典。
  const hasDictionary = Boolean(dictionary && dictionary.tagDictionary.length > 0);
  const dictionaryLoaded = dictionary !== null;
  /**
   * 结果面板与主按钮共用的派生值。
   *
   * ⚠️ 必须定义在 `newVideoPanel` **之前**：按钮文案要用 `untaggedCount`，
   * 而 `const` 在声明前引用会直接 TDZ 崩掉（不是 undefined，是整页白屏）。
   */
  const shownIds = new Set((refreshReport?.items ?? streamItems).map(item => item.video.id));
  const untaggedCount = candidates.filter(video => !shownIds.has(video.id)).length;

  const newVideoPanel = (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600"><Search className="h-4 w-4" /></span>
        <div>
          <h3 className="text-sm font-semibold text-slate-900">新更新视频筛选与标签</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            抓取对标账号近期更新的视频，只保留点赞严格大于 {MIN_LIKES} 的作品，提取完整脚本后按本客户选题库的大类/小类打标签。
          </p>
        </div>
      </div>

      {/* 顺序按用户拍板：先抓视频 → 再提脚本 → 最后才读库打标签。
          所以前两步**不要求选题库存在**，只有「按库内分类打标签」才需要词典。 */}
      {dictionaryLoaded && !hasDictionary && (
        <div className="mt-5 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          这个客户还没有选题库，抓视频与提取脚本不受影响，但「按库内分类打标签」需要库里的分类当词典 —— 请联系项目经理先在账号定位里建库。
        </div>
      )}

      <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_200px]">
        <label className="block">
          <span className="text-xs font-semibold text-slate-600">对标账号主页链接</span>
          <input
            value={accountUrl}
            onChange={event => setAccountUrl(event.target.value)}
            placeholder="https://www.douyin.com/user/..."
            className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400"
          />
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-slate-600">发布时间范围</span>
          <select
            value={recentDays}
            onChange={event => setRecentDays(Number(event.target.value))}
            className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none transition focus:border-blue-400"
          >
            {DAY_OPTIONS.map(days => <option key={days} value={days}>近 {days} 天</option>)}
          </select>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleFetchNewVideos}
          disabled={fetching}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
        >
          {fetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          抓取新更新视频
        </button>
        <button
          type="button"
          onClick={handleExtractScripts}
          disabled={transcribing || analyzing || candidates.length === 0}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:border-blue-300 hover:text-blue-700 disabled:opacity-50"
        >
          {transcribing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          提取完整脚本
        </button>
        <button
          type="button"
          onClick={() => handleAnalyze({ reset: untaggedCount === 0 })}
          disabled={transcribing || analyzing || dictionaryLoading || candidates.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
        >
          {analyzing || dictionaryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {analyzing
            ? `处理中…（已出 ${streamItems.length} 条）`
            : untaggedCount > 0
              ? `提取脚本并打标签（剩 ${untaggedCount} 条）`
              : "重新打标签"}
        </button>
      </div>

      {extractedCount > 0 && !refreshReport && (
        <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2.5 text-xs leading-5 text-emerald-700">
          已提取 {extractedCount} 条完整脚本，可以继续「提取脚本并打标签」了（已转好的不会重复花钱）。
        </div>
      )}

      {fetchMessage && <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs leading-5 text-slate-600">{fetchMessage}</div>}
      {restoredAt && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-2.5 text-xs leading-5 text-blue-700">
          <span>
            以下是你上次的处理进度（{formatTime(restoredAt)}），可以直接接着跑；
            直接点「提取脚本并打标签」只会处理**还没判过**的那些，不会重复花钱。
          </span>
          <button
            type="button"
            onClick={handleRestart}
            className="shrink-0 rounded-lg border border-blue-200 bg-white px-2.5 py-1 font-medium text-blue-700 transition hover:border-blue-300"
          >
            重新开始
          </button>
        </div>
      )}
      {truncated && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50 px-4 py-2.5 text-xs leading-5 text-amber-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          已达到单次抓取上限（{FETCH_MAX_VIDEOS} 条），这个时间窗口内可能还有更新的作品没有纳入。建议把时间范围调小一些再抓一次。
        </div>
      )}
    </section>
  );

  // ---------- 结果列表 ----------
  //
  // 流式打标签：面板一有第一条就出现，之后**边判边长**。
  // `refreshReport`（非流式路径留下的完整报告）优先；否则用累积出来的 streamItems。
  const shownItems = refreshReport?.items ?? streamItems;
  /** 还没判完的排队项（只在处理过程中显示）。 */
  const pendingItems = pendingCount > 0 ? candidates.filter(video => !shownIds.has(video.id)) : [];
  /**
   * 顶部的统计 chips 按**已贴出来的条目**实时重算 —— 不能直接用某一批的报告：
   * 那是那一批的局部统计，跟列表长度对不上（会显示「真实转写 5 条」而列表有 15 条）。
   */
  const shownStats = {
    recentDays: refreshReport?.recentDays ?? streamSummary?.recentDays ?? recentDays,
    minLikes: refreshReport?.minLikes ?? streamSummary?.minLikes ?? MIN_LIKES,
    transcriptCount: shownItems.filter(item => item.scriptSource === "transcript").length,
    captionFallbackCount: shownItems.filter(item => item.scriptSource === "caption").length,
    analysisSource: refreshReport?.analysisSource ?? streamSummary?.analysisSource ?? "agent",
    warnings: refreshReport?.warnings ?? streamSummary?.warnings ?? [],
  };
  const resultPanel = (refreshReport || streamItems.length > 0 || pendingCount > 0) ? (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <StageChip tone="accent">{shownItems.length} 条已判完</StageChip>
          {pendingCount > 0 && <StageChip>还剩 {pendingCount} 条在处理</StageChip>}
          {analyzing && transcribedCount > 0 && <StageChip>脚本已就绪 {transcribedCount} 条</StageChip>}
          <StageChip>近 {shownStats.recentDays} 天</StageChip>
          <StageChip>点赞 &gt; {shownStats.minLikes}</StageChip>
          <StageChip>真实转写 {shownStats.transcriptCount} 条</StageChip>
          <StageChip>发布文案推断 {shownStats.captionFallbackCount} 条</StageChip>
          {shownStats.analysisSource === "heuristic" && <StageChip>规则兜底（Agent 未返回）</StageChip>}
        </div>
        {/* 后端归一化的告警要显示真实内容，不要只写一句硬编码的话（HANDOFF §4.3 第 1 条）。 */}
        {(shownStats.warnings.length || 0) > 0 && (
          <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-4 py-2.5 text-xs leading-5 text-amber-700">
            {shownStats.warnings.map((warning, index) => (
              <div key={index}>Agent 返回的错误：[{warning.code || "UNKNOWN"}] {warning.error || "（无详细信息）"}</div>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <button
            type="button"
            onClick={() => setSelectedVideoIds(
              selectedVideoIds.length === shownItems.length ? [] : shownItems.map(item => item.video.id),
            )}
            className="font-medium text-blue-600 hover:text-blue-700"
          >
            {selectedVideoIds.length === shownItems.length ? "取消全选" : "全选"}
          </button>
          <span>已勾选 {selectedVideoIds.length} 条</span>
          {/* 勾选语义必须写清楚：它是挑重点，不是入库。 */}
          <span className="text-slate-400">勾选只标记本次要用的选题，不会自动写入正式选题库。</span>
        </div>
      </div>

      <ul className="divide-y divide-slate-100">
        {shownItems.map(item => {
          const review = isReviewItem(item);
          const expanded = expandedVideoId === item.video.id;
          return (
            <li key={item.video.id} className="px-5 py-4 sm:px-6">
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selectedVideoIds.includes(item.video.id)}
                  onChange={() => toggleVideo(item.video.id)}
                  aria-label={`选择 ${item.video.title || item.video.id}`}
                  className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-blue-600"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="text-sm font-medium leading-6 text-slate-900">{item.video.title || "（无标题）"}</span>
                    <span className="shrink-0 text-[11px] text-slate-400">{formatTime(item.video.publishDate)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${review ? "bg-amber-100 text-amber-700" : "bg-blue-50 text-blue-700"}`}>
                      {item.category.name}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${review ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                      {item.subcategory.name}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${item.scriptSource === "transcript" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                      {sourceLabel(item)}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${confidenceTone(item.confidence)}`}>
                      置信度 {item.confidence}
                    </span>
                    <span className="text-[11px] text-slate-400">
                      赞 {compactNumber(item.video.stats.likes)} · 评 {compactNumber(item.video.stats.comments)} · 转 {compactNumber(item.video.stats.shares)}
                    </span>
                  </div>
                  {item.basis && <p className="mt-2 text-[11px] leading-5 text-slate-500">判断依据：{item.basis}</p>}
                  <button
                    type="button"
                    onClick={() => setExpandedVideoId(expanded ? "" : item.video.id)}
                    aria-expanded={expanded}
                    className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:text-blue-700"
                  >
                    <ChevronDown className={`h-3 w-3 transition ${expanded ? "rotate-180" : ""}`} />
                    {expanded ? "收起脚本" : "展开完整脚本"}
                  </button>
                  {expanded && (
                    <div className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 px-3.5 py-3 text-xs leading-6 text-slate-700">
                      {item.script || "（没有取到脚本，也没有发布文案）"}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* 还没判完的排队项：让用户看得见「后面还有哪些」，而不是盯着一个静止的列表。 */}
      {pendingItems.length > 0 && (
        <div className="border-t border-slate-100 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            还有 {pendingItems.length} 条在提取脚本 / 打标签…
          </div>
          <ul className="mt-3 space-y-2">
            {pendingItems.map(video => (
              <li key={video.id} className="flex items-start gap-2 text-xs text-slate-400">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                <span className="min-w-0 flex-1 truncate">{video.title || "（无标题）"}</span>
                <span className="shrink-0">赞 {compactNumber(video.stats.likes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  ) : null;

  const body = readOnly ? (
    // 员工只读视图（`/topics?view=newVideos`）：库只作为「词典来源」展示，主体是
    // 抓取 → 严格 >100 筛选 → 完整脚本 → 按库内分类打标签 → 可勾选列表。
    <div className="space-y-5">
      {libraryError && <div className="whitespace-pre-wrap rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs leading-5 text-red-600">{libraryError}</div>}
      {fetchError && <div className="whitespace-pre-wrap rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs leading-5 text-red-600">{fetchError}</div>}
      {libraryPanel}
      {newVideoPanel}
      {resultPanel}
      {candidates.length > 0 && !refreshReport && streamItems.length === 0 && pendingCount === 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="text-xs text-slate-500">
            已筛出 {candidates.length} 条点赞超过 {MIN_LIKES} 的新视频（共抓取 {fetchedTotal} 条）。点「提取脚本并打标签」即可，结果会**一条条滚动出现**。
          </div>
        </section>
      )}
    </div>
  ) : (
    // 项目经理的 2.4：只负责建库与维护库。
    // 用户要求（2026-09-21）「新更新视频筛选与标签」**只留在员工端** —— 这里不仅不渲染，
    // 连那两个面板的构造都跳过，免得白做一遍渲染工作。
    <div className="space-y-5">
      {libraryError && <div className="whitespace-pre-wrap rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs leading-5 text-red-600">{libraryError}</div>}
      {libraryPanel}
    </div>
  );

  if (embedded) return body;
  return (
    <StageShell
      hasResult={Boolean(refreshReport || streamItems.length > 0)}
      summary={<StageChip>{library ? `${library.customerName} · ${library.accountCount} 个账号` : "尚未建库"}</StageChip>}
      setup={body}
      error=""
    />
  );
}

export default TopicLibraryStage;
