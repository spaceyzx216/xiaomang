import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { ArrowLeft } from "lucide-react";
import { apiUrl, fetchWithRetry, parseApiJson } from "./api";
import { useAuth } from "./auth.tsx";
import { getActiveReviewMemory, type ReviewMemory } from "./weeklyReviewApi";
import { selectTopicsByWeeklyPlan } from "./weeklyTopicSelection";
import { loadLibraryForCustomer, runTopicContentAnalysis, type TopicAnalysis } from "./topicContentAnalysis";
import { buildTopicAnalysisScopeKey, canReuseTopicAnalysis, decideTopicAnalysisAction } from "./topicAnalysisPipeline";
import { useStageDraft } from "./stageDraft";
import {
  TOPIC_MIN_LIKES,
  parseMinLikes,
  attachContent,
  filterByLikes,
  shouldExtractTranscripts,
  type TopicContentMap,
} from "./topicContentRules";
import {
  DEFAULT_TOPIC_DAYS,
  MAX_TOPIC_DAYS,
  groupTopicsByWeek,
  isTopicWithinDays,
  mergeTopicBatchResults,
  parseTopicDays,
  topicRequestLimits,
  topicTimestampMs,
} from "./topicTimeWindow";
import { isConfirmedWechatAccount, isFinderUsername, retainConfirmedWechatAccounts } from "./wechatAccountValidation";
import {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "./components/ui/carousel";
import { Target, TrendingUp, MessageCircle, ThumbsUp, Share2, Bookmark, ExternalLink, User, CalendarDays, Phone, Layers, Sparkles, CheckCircle2, RefreshCw, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";

// 跨账号节流：连续抓取多个对标账号时，账号之间间隔一段时间再发请求，
// 规避上游（TikHub）对短时间高频连续请求的限流——其表现为不报错而返回空数据，
// 导致第 4 个及以后的账号被误判为"无作品"。同一账号的游标续拉不受此限制。
const TOPIC_ACCOUNT_THROTTLE_MS = 1500;
// 视频号分享链接接口按次计费且存在限流；仅为已勾选选题自动补链，并严格串行。
const WECHAT_SHARE_LINK_THROTTLE_MS = 1200;
const sleepMs = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

interface Topic {
  id: string;
  platform?: "douyin" | "wechat_channels" | "tiktok";
  title: string;
  tags: string[];
  isRecommended?: boolean;
  stats: {
    comments: number;
    likes: number;
    shares: number;
    bookmarks: number;
  };
  link: string;
  authorName?: string;
  publishDate?: string;
  hotTopics?: string[];
  source?: {
    platform?: string;
    objectId?: string;
    objectNonceId?: string;
    finderUsername?: string;
    mediaUrl?: string;
    decodeKey?: string;
    coverUrl?: string;
  };
  rawData?: unknown;
  /**
   * 本条的脚本与大类/小类标签（2026-09-21）。
   * 勾选后 `handleSubmit` 会把 topic 整体序列化进 `sessionStorage.selectedTopics`，
   * 所以脚本挂在这里就能被下一步二创直接复用，**不必再提取一次**。
   */
  content?: {
    script: string;
    scriptSource: "transcript" | "caption";
    categoryName: string;
    subcategoryName: string;
    categoryId: string;
    confidence: string;
    basis: string;
  };
}

type SourcePlatform = "douyin" | "wechat_channels" | "tiktok";

type TopicResumeState = {
  cursor?: unknown;
  pageOffset?: number;
  secUserId?: string;
  username?: string;
  accountResolved?: boolean;
  sourceUrl?: string;
};

type TikhubBatchResult = {
  url?: string;
  platform?: "douyin" | "tiktok";
  inputName?: string;
  secUserId?: string;
  finderUsername?: string;
  authorName?: string;
  videosCount?: number;
  /**
   * 视频号专有：这批里有多少条**拿不到媒体直链 / 解密密钥**（后端算好如实回传）。
   * 缺这两个字段的条目无法在本地解密转写 —— 界面要如实提示，不能装作正常。
   */
  missingMediaCount?: number;
  secUserResponse?: unknown;
  videosResponse?: unknown;
  topics?: Topic[];
  pageCount?: number;
  totalPageCount?: number;
  rawVideosCount?: number;
  recentDays?: number;
  hasMore?: boolean;
  stopReason?: string;
  isComplete?: boolean;
  incompleteReason?: string | null;
  error?: string | null;
  backgroundError?: string | null;
  errorStatus?: number | null;
  resume?: TopicResumeState | null;
};

type TopicFetchTarget = string | Record<string, string>;
type TopicFetchJob = {
  key: string;
  target: TopicFetchTarget;
  resume?: TopicResumeState | null;
  failed: boolean;
  done: boolean;
  errorMessage?: string;
  warningMessage?: string;
};
type TopicSliceFetcher = (
  target: TopicFetchTarget,
  days: number,
  resume?: TopicResumeState | null,
) => Promise<TikhubBatchResult[]>;

type PersistedTopicFetchContext = {
  requestedDays: number;
  platform: SourcePlatform;
  jobs: TopicFetchJob[];
};

type WeChatAccountCandidate = {
  platform: "wechat_channels";
  inputName: string;
  displayName: string;
  finderUsername: string;
  signature?: string;
  verifiedInfo?: string;
  sampleVideos?: string[];
};

type WeChatSearchDiagnostics = {
  accountSearch: { items: number; candidates: number; missingFinderUsername: number };
  videoSearch: { items: number; usableItems: number; missingExportId: number };
  videoDetail: { requested: number; succeeded: number; missingFinderUsername: number; missingChannelId: number };
  channelIdLookup: { requested: number; resolved: number; missingFinderUsername: number };
  errors: Array<{ stage: string; message: string }>;
  outcome: "resolved" | "not_found" | "missing_finder_username" | "upstream_error";
};

type WeChatAccountSearchResult = {
  inputName: string;
  candidates: WeChatAccountCandidate[];
  error?: string | null;
  diagnostics?: WeChatSearchDiagnostics;
};

type TaskItem = {
  _id: string;
  /** 客户 id：决定用**哪份选题库**给视频打标签（临时任务/指派任务都会带）。 */
  customerId?: string;
  customerName: string;
  customerOccupation?: string;
  contact?: string;
  ownerName?: string;
  ownerId?: { _id?: string; name?: string } | string;
  platformName?: string;
  collaborationPeriod?: {
    start?: string;
    end?: string;
  };
  notes?: string;
  ipPositioning?: string;
  contentDirection?: string;
  benchmarkAccounts?: string;
  contentRequirements?: string[];
  priority?: "low" | "medium" | "high";
};

const mockData = {
  recommendationLogic: [
    "起号期优先选择高互动、易共鸣的内容形式",
    "平台偏好真实测评与使用场景展示",
    "当前季节护肤需求上升，建议结合时令话题",
    "目标人群关注性价比与实用性"
  ],
  recommendedTopics: [
    {
      id: "1",
      title: "平价底妆实测：100 元内打造通勤妆容",
      tags: ["适合起号", "高互动潜力", "近期热度上升"],
      isRecommended: true,
      stats: {
        comments: 3240,
        likes: 18500,
        shares: 1820,
        bookmarks: 5670
      },
      link: "https://example.com/topic/1"
    }
  ],
  allTopics: [
    {
      id: "5",
      title: "办公室妆容不脱妆小技巧",
      tags: ["实用内容", "场景化"],
      isRecommended: false,
      stats: {
        comments: 1890,
        likes: 9800,
        shares: 890,
        bookmarks: 2340
      },
      link: "https://example.com/topic/5"
    }
  ]
};

const WECHAT_CHANNELS_ACCOUNT_CACHE_KEY = "wechatChannelsAccountCache";
const TOPIC_FETCH_CONTEXT_KEY = "topicFetchContext";

const parseLines = (value: string) => Array.from(
  new Set(
    String(value || "")
      .split(/[\n，,；;]+/)
      .map(item => item.trim())
      .filter(Boolean)
  )
);

const readWeChatAccountCache = (): Record<string, WeChatAccountCandidate> => {
  try {
    const raw = localStorage.getItem(WECHAT_CHANNELS_ACCOUNT_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const validCache = retainConfirmedWechatAccounts(Object.keys(parsed), parsed as Record<string, WeChatAccountCandidate>);
    if (Object.keys(validCache).length !== Object.keys(parsed).length) {
      localStorage.setItem(WECHAT_CHANNELS_ACCOUNT_CACHE_KEY, JSON.stringify(validCache));
    }
    return validCache;
  } catch {
    return {};
  }
};

const writeWeChatAccountCache = (cache: Record<string, WeChatAccountCandidate>) => {
  const validCache = retainConfirmedWechatAccounts(Object.keys(cache), cache);
  const safeCache = Object.fromEntries(Object.entries(validCache).map(([inputName, candidate]) => {
    const { raw: _raw, ...safeCandidate } = candidate as WeChatAccountCandidate & { raw?: unknown };
    return [inputName, safeCandidate];
  }));
  try {
    localStorage.setItem(WECHAT_CHANNELS_ACCOUNT_CACHE_KEY, JSON.stringify(safeCache));
  } catch {
    // 本次已确认账号仍保留在内存中；浏览器存储不可用时不应中断后续作品抓取。
  }
};

const compactStoredVideo = (video: Record<string, any>) => ({
  aweme_id: video?.aweme_id ?? video?.awemeId ?? video?.id,
  id: video?.id,
  create_time: video?.create_time ?? video?.createTime,
  desc: video?.desc,
  share_url: video?.share_url,
  statistics: video?.statistics,
  author: video?.author ? { nickname: video.author.nickname } : undefined,
  suggest_words: Array.isArray(video?.suggest_words) ? video.suggest_words.slice(0, 5) : undefined,
});

const compactStoredVideosResponse = (response: unknown) => {
  const payload = response as Record<string, any> | undefined;
  if (!payload) return response;
  const data = payload.data;
  const list = Array.isArray(data) ? data : Array.isArray(data?.aweme_list) ? data.aweme_list : [];
  const compact = list.map(compactStoredVideo);
  return {
    data: Array.isArray(data) ? compact : { aweme_list: compact },
    topicWindow: payload.topicWindow,
  };
};

const persistTikhubResults = (results: TikhubBatchResult[]) => {
  try {
    const compact = results.map(result => ({
      ...result,
      secUserResponse: undefined,
      videosResponse: compactStoredVideosResponse(result.videosResponse),
      topics: Array.isArray(result.topics)
        ? result.topics.map(({ rawData: _rawData, ...topic }) => topic)
        : result.topics,
    }));
    sessionStorage.setItem("tikhubResults", JSON.stringify(compact));
  } catch {
    // 极端高频账号仍可能超过配额；当前页面内状态继续可用。
    try {
      sessionStorage.removeItem("tikhubResults");
    } catch {
      // Storage can be fully unavailable in privacy-restricted contexts.
    }
  }
};

const persistTopicFetchContext = (
  context: { requestedDays: number; jobs: TopicFetchJob[] },
  platform: SourcePlatform,
) => {
  try {
    const payload: PersistedTopicFetchContext = {
      requestedDays: context.requestedDays,
      platform,
      jobs: context.jobs.map(job => ({ ...job })),
    };
    sessionStorage.setItem(TOPIC_FETCH_CONTEXT_KEY, JSON.stringify(payload));
  } catch {
    // 续拉上下文很小；存储不可用时仍保留当前页面内的 useRef 作业。
  }
};

const readTopicFetchContext = (): PersistedTopicFetchContext | null => {
  try {
    const raw = sessionStorage.getItem(TOPIC_FETCH_CONTEXT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedTopicFetchContext;
    if (!parsed || !Array.isArray(parsed.jobs) || !Number.isInteger(parsed.requestedDays)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const summarizeVideosResponse = (response: unknown) => {
  const payload = response as Record<string, any> | undefined;
  if (!payload) return response;
  const data = payload.data;
  if (Array.isArray(data)) {
    return { ...payload, data: data.slice(0, 3), previewOnly: data.length > 3 };
  }
  if (data && typeof data === "object" && Array.isArray(data.aweme_list)) {
    return {
      ...payload,
      data: { ...data, aweme_list: data.aweme_list.slice(0, 3) },
      previewOnly: data.aweme_list.length > 3,
    };
  }
  return payload;
};

const inferDefaultPlatform = (tasks: TaskItem[]): SourcePlatform => {
  const text = tasks
    .map(task => [task.platformName, task.benchmarkAccounts].filter(Boolean).join(" "))
    .join(" ");
  return /视频号|微信/i.test(text) ? "wechat_channels" : "douyin";
};

/**
 * 「临时分析」伪任务 —— 由 `TodayTasksPage` 在员工分析**不关联客户**的对标账号时合成，
 * `_id` 带 `adhoc-` 前缀。下游据此把它与真实客户任务区分开
 * （例如不把它的成稿写进客户维度的多维表格）。
 */
const isAdhocTask = (task?: { _id?: string }) => String(task?._id || "").startsWith("adhoc-");

/**
 * IntersectionObserver 懒渲染 hook：元素进入视口（或接近视口）时才标记为可见。
 * 用于 topic 卡片懒渲染——只有用户滚动到附近时才挂载完整卡片内容，
 * 避免展开含数百条的分组时一次性渲染全部 DOM。
 */
function useInView(rootMargin = "600px") {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some(entry => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView, rootMargin]);
  return { ref, inView };
}

/**
 * 懒渲染卡片包装器：卡片进入视口附近前只渲染一个占位 div，
 * 进入视口后才挂载 children（完整的 topic 卡片内容）。
 * 配合 CSS contentVisibility 双重保障大列表渲染性能。
 */
/**
 * 懒计算 JSON 摘要的 <details> 面板：
 * 只在用户展开时才执行 summarizeVideosResponse + JSON.stringify，
 * 避免每次渲染都对所有账号结果同步计算。
 */
function LazyVideosResponseDetails({ response }: { response: unknown }) {
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  useEffect(() => {
    setJson(open ? JSON.stringify(summarizeVideosResponse(response), null, 2) : null);
  }, [open, response]);
  return (
    <details
      className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-xs font-semibold text-slate-600">主页作品接口摘要（最多 3 条）</summary>
      <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-slate-600">
        {json ?? ""}
      </pre>
    </details>
  );
}

function LazyTopicCard({ children }: { children: ReactNode }) {
  const { ref, inView } = useInView("600px");
  return (
    <div
      ref={ref}
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 180px" }}
    >
      {inView ? children : <div className="h-[140px] rounded-lg border border-slate-100 bg-slate-50/50" />}
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // 返回目标按角色分岔：员工回「今日任务」，经理回项目经理工作台 ——
  // 直接把经理送去 /workbench 是把他扔进员工页（同一份代码两种角色都会进这一页）。
  const isManager = user?.role === "manager";
  const workbenchBackTo = isManager ? "/manager" : "/workbench";
  const workbenchBackLabel = isManager ? "返回项目经理工作台" : "返回今日任务";
  const [selectedTopics, setSelectedTopics] = useState<string[]>(() => {
    try {
      const raw = sessionStorage.getItem("selectedTopicIds");
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [sortKey, setSortKey] = useState<"comments" | "likes" | "shares" | "bookmarks">("comments");
  const [tasks, setTasks] = useState<TaskItem[]>(() => {
    try {
      const raw = sessionStorage.getItem("contentTasks");
      return raw ? (JSON.parse(raw) as TaskItem[]) : [];
    } catch {
      return [];
    }
  });
  const [taskLoading, setTaskLoading] = useState(tasks.length === 0);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskIndex, setTaskIndex] = useState(0);
  // ⚠️ 提前到这里：下面「脚本 + 标签」的分析 effect 要用 `activeTask.customerId`
  // （决定用哪份选题库当词典），声明顺序不能晚于那个 effect。
  const activeTask = useMemo(() => tasks[taskIndex], [tasks, taskIndex]);
  const [taskCarouselApi, setTaskCarouselApi] = useState<CarouselApi | null>(null);
  const [sourcePlatform, setSourcePlatform] = useState<SourcePlatform>(() => {
    const stored = sessionStorage.getItem("sourcePlatform");
    return stored === "wechat_channels" || stored === "douyin" || stored === "tiktok" ? stored : inferDefaultPlatform(tasks);
  });
  const [tikhubInput, setTikhubInput] = useState(() => sessionStorage.getItem("tikhubInput") || "");
  const [tikhubLoading, setTikhubLoading] = useState(false);
  const [tikhubError, setTikhubError] = useState<string | null>(null);
  const [tikhubResults, setTikhubResults] = useState<TikhubBatchResult[]>(() => {
    try {
      const raw = sessionStorage.getItem("tikhubResults");
      return raw ? (JSON.parse(raw) as TikhubBatchResult[]) : [];
    } catch {
      return [];
    }
  });
  const [topicDays, setTopicDays] = useState(() => {
    try {
      return parseTopicDays(sessionStorage.getItem("topicWindowDays") || DEFAULT_TOPIC_DAYS);
    } catch {
      return DEFAULT_TOPIC_DAYS;
    }
  });
  const [topicDaysInput, setTopicDaysInput] = useState(() => String(topicDays));
  const [topicDaysError, setTopicDaysError] = useState<string | null>(null);
  /**
   * 点赞门槛：**用户可自定义**（2026-09-28），默认 {@link TOPIC_MIN_LIKES}。
   *
   * 口径是**大于等于**（填 100 时 100 算达标）—— 之前是严格大于，这次一并改了口径。
   * 用 useStageDraft 持久化：从二创页返回时组件会卸载重建，不存的话门槛会退回默认值，
   * 而门槛一变 `qualifiedTopics` 就变 → 整批重新分析（转写+打标签，真花钱）。
   */
  const [minLikes, setMinLikes] = useStageDraft<number>("topics.minLikes", TOPIC_MIN_LIKES);
  const [minLikesInput, setMinLikesInput] = useStageDraft<string>("topics.minLikesInput", String(TOPIC_MIN_LIKES));
  const [minLikesError, setMinLikesError] = useState<string | null>(null);
  const [olderTopicsLoading, setOlderTopicsLoading] = useState(false);
  const [olderTopicsError, setOlderTopicsError] = useState<string | null>(null);
  const [expandedTopicGroups, setExpandedTopicGroups] = useState<number[]>([0]);
  const topicFetchGeneration = useRef(0);
  /** 一次性自动抓取：记住本次挂载已经为哪个 key 触发过（见下面那个 effect）。 */
  const topicsAutoFetchRef = useRef("");
  const lastTopicFetchRef = useRef<{
    requestedDays: number;
    jobs: TopicFetchJob[];
    fetchSlice: TopicSliceFetcher;
  } | null>(null);
  const [wechatSearchResults, setWechatSearchResults] = useState<WeChatAccountSearchResult[]>(() => {
    try {
      const raw = sessionStorage.getItem("wechatAccountSearchResults");
      return raw ? (JSON.parse(raw) as WeChatAccountSearchResult[]) : [];
    } catch {
      return [];
    }
  });
  const [confirmedWechatAccounts, setConfirmedWechatAccounts] = useState<Record<string, WeChatAccountCandidate>>(() => readWeChatAccountCache());
  const [topicLinkLoadingId, setTopicLinkLoadingId] = useState<string | null>(null);
  const [wechatShareLinksLoading, setWechatShareLinksLoading] = useState(false);
  const autoWechatShareLinkRef = useRef({
    runId: 0,
    running: false,
    attemptedIds: new Set<string>(),
  });
  const selectedTopicIdsRef = useRef(new Set(selectedTopics));

  useEffect(() => {
    if (sourcePlatform !== "wechat_channels") return;
    const inputNames = parseLines(tikhubInput);
    const inputNameSet = new Set(inputNames);
    setWechatSearchResults(previous => {
      const next = previous.filter(result => inputNameSet.has(result.inputName));
      if (next.length === previous.length) return previous;
      sessionStorage.setItem("wechatAccountSearchResults", JSON.stringify(next));
      return next;
    });
    setConfirmedWechatAccounts(previous => {
      const next = retainConfirmedWechatAccounts(inputNames, previous);
      if (Object.keys(next).length === Object.keys(previous).length) return previous;
      writeWeChatAccountCache(next);
      return next;
    });
  }, [sourcePlatform, tikhubInput]);

  useEffect(() => {
    const selectedIds = new Set(selectedTopics);
    selectedTopicIdsRef.current = selectedIds;
    for (const topicId of autoWechatShareLinkRef.current.attemptedIds) {
      if (!selectedIds.has(topicId)) {
        autoWechatShareLinkRef.current.attemptedIds.delete(topicId);
      }
    }
  }, [selectedTopics]);

  const resetAutoWechatShareLinkGeneration = () => {
    const state = autoWechatShareLinkRef.current;
    state.runId += 1;
    state.running = false;
    state.attemptedIds.clear();
    setWechatShareLinksLoading(false);
  };

  const handleTopicToggle = (topicId: string) => {
    setSelectedTopics(prev => {
      const next = prev.includes(topicId)
        ? prev.filter(id => id !== topicId)
        : [...prev, topicId];
      sessionStorage.setItem("selectedTopicIds", JSON.stringify(next));
      return next;
    });
  };

  const normalizeNumber = (value?: number) => (typeof value === "number" ? value : 0);

  const tikhubTopics = useMemo(() => {
    const now = Date.now();
    // result.platform 由后端 batch 返回标记；抖音/C TikTok 走同一套 aweme 字段映射，
    // 仅 platform 标记与 link 兜底域名不同。
    const resolveTopicPlatform = (result: TikhubBatchResult): Topic["platform"] =>
      result.platform === "tiktok" ? "tiktok" : "douyin";
    const fallbackLink = (id: string, platform: Topic["platform"], authorName?: string) => {
      if (platform === "tiktok") {
        const handle = authorName ? `@${String(authorName).replace(/^@/, "")}` : "user";
        return `https://www.tiktok.com/${handle}/video/${id}`;
      }
      return `https://www.douyin.com/video/${id}`;
    };

    const topics = tikhubResults.flatMap(result => {
      if (Array.isArray(result.topics)) {
        return result.topics;
      }
      if (result.error || !result.videosResponse) return [];
      const topicPlatform = resolveTopicPlatform(result);
      const dataBlock = (result.videosResponse as any)?.data;
      const videosList = Array.isArray(dataBlock)
        ? dataBlock
        : Array.isArray(dataBlock?.aweme_list)
          ? dataBlock.aweme_list
          : [];

      return videosList
        .map((video: any) => {
          const createdAt = topicTimestampMs({ id: "", rawData: video }) || null;
          if (!createdAt) return null;

          const stats = video?.statistics || {};
          const title = video?.desc || "未命名视频";
          const authorName = video?.author?.nickname || result.authorName || "未知";
          const id = String(video?.aweme_id || video?.awemeId || `${result.url || result.inputName || authorName}:${createdAt}:${title}`);
          const publishDate = createdAt ? new Date(createdAt).toISOString().slice(0, 10) : undefined;
          const link = video?.share_url || fallbackLink(id, topicPlatform, authorName);
          const hotTopics = Array.isArray(video?.suggest_words)
            ? Array.from(
                new Set(
                  video.suggest_words
                    .filter((item: any) => !item?.hint_text || item?.hint_text === "大家都在搜：")
                    .flatMap((item: any) => Array.isArray(item?.words) ? item.words : [])
                    .map((word: any) => word?.word)
                    .filter(Boolean)
                )
              )
            : [];

          return {
            id,
            platform: topicPlatform,
            title,
            tags: [],
            stats: {
              comments: normalizeNumber(stats.comment_count),
              likes: normalizeNumber(stats.digg_count),
              shares: normalizeNumber(stats.share_count),
              bookmarks: normalizeNumber(stats.collect_count),
            },
            link,
            authorName,
            publishDate,
            hotTopics,
            rawData: video,
          } as Topic;
        })
        .filter(Boolean) as Topic[];
    });
    const unique = new Map<string, Topic>();
    topics.forEach((topic) => {
      if (!isTopicWithinDays(topic, topicDays, now)) return;
      unique.set(topic.id, { ...unique.get(topic.id), ...topic });
    });
    return Array.from(unique.values()).sort((left, right) => topicTimestampMs(right) - topicTimestampMs(left));
  }, [tikhubResults, topicDays]);

  /**
   * 点赞门槛：**列表只保留严格 `> 100`** 的视频（用户 2026-09-21 口径）。
   *
   * 这不是"按点赞排序"——排序仍然由上面的 sortKey 决定；这里是**过滤**。
   * 缺失点赞归一化成 0；门槛填 0 时它们会被纳入（有意的）。
   */
  // 脚本 + 标签：按视频 id 索引。单独放 state 是因为它要跨「抓取 / 切窗口」保留。
  //
  // ⚠️ 这两个 useState 必须声明在下面 `topicsWithContent` 的 useMemo **之前**：
  // 反过来的话 useMemo 会在初始化前读 `topicContent` → TDZ 报错
  // （`Cannot access 'topicContent' before initialization`）整页白屏。
  // `npm run build` 和单元测试都拦不住这个，是无头浏览器渲染时才炸出来的。
  //
  // 🔴 这两个都用 `useStageDraft` 持久化（2026-09-28）：选题页 →「开始二创」→
  //    返回，路由会让本组件**卸载重建**，普通 useState 一重建就归零，于是整批
  //    重新分析一遍 —— 转写虽然被后端缓存兜住（快），但**打标签要重跑 DeepSeek**，
  //    是真实的钱和时间。`tikhubResults` 早就有持久化（所以列表还在），
  //    偏偏结果没存，症状就是"每次返回都重新跑一遍"。
  const [topicContent, setTopicContent] = useStageDraft<TopicContentMap>("topics.content", {});
  const [topicAnalysis, setTopicAnalysis] = useStageDraft<TopicAnalysis>("topics.analysis", {
    status: "idle", message: "", transcriptsExtracted: false, taggedCount: 0, scriptCount: 0, error: "",
  });
  // 上一轮分析覆盖的「范围指纹」。存下来才能在重建后判断"这批视频已经分析过了"。
  const [topicAnalysisScope, setTopicAnalysisScope] = useStageDraft<string>("topics.analysisScope", "");

  /**
   * 点赞门槛：**列表只保留严格 `> 100`** 的视频（用户 2026-09-21 口径）。
   *
   * 这不是「按点赞排序」——排序仍由 sortKey 决定；这里是**过滤**。
   * 缺失点赞归一化成 0，天然被挡掉。
   */
  const qualifiedTopics = useMemo(() => filterByLikes(tikhubTopics, minLikes), [tikhubTopics, minLikes]);
  // 脚本与标签是异步补上的；挂到 topic 上之后，列表渲染与 handleSubmit 共用同一份数据。
  const topicsWithContent = useMemo(() => attachContent(qualifiedTopics, topicContent), [qualifiedTopics, topicContent]);
  const [reviewMemory, setReviewMemory] = useState<ReviewMemory | null>(null);
  const [reviewSelectionMessage, setReviewSelectionMessage] = useState('');
  const [reviewMemoryError, setReviewMemoryError] = useState('');

  const topicGroups = useMemo(
    () => groupTopicsByWeek(topicsWithContent, topicDays),
    [topicsWithContent, topicDays],
  );

  // 排序 memo 化：只在 sortKey 或 topicGroups 变化时重排，
  // 避免每次勾选/取消 topic 时对所有分组全量重排。
  const sortedTopicGroups = useMemo(
    () => topicGroups.map(group => ({
      ...group,
      topics: group.topics.length > 1
        ? [...group.topics].sort((a, b) => b.stats[sortKey] - a.stats[sortKey])
        : group.topics,
    })),
    [topicGroups, sortKey],
  );

  // Set 查找优化：O(1) 替代 O(n) 的 includes
  const selectedTopicIdSet = useMemo(() => new Set(selectedTopics), [selectedTopics]);

  useEffect(() => {
    if (tasks.length > 0) return;

    const fetchTasks = async () => {
      setTaskLoading(true);
      setTaskError(null);
      try {
        const response = await fetch(apiUrl("/api/tasks/today"), { credentials: "include" });
        const data = await response.json();
        if (response.status === 401 && typeof window !== "undefined") {
          window.dispatchEvent(new Event("auth:logout"));
        }
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || "任务服务不可用");
        }
        const taskData = Array.isArray(data.data) ? data.data : [];
        setTasks(taskData);
        sessionStorage.setItem("contentTasks", JSON.stringify(taskData));
        setTaskIndex(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : "任务服务不可用";
        setTaskError(message);
      } finally {
        setTaskLoading(false);
      }
    };

    fetchTasks();
  }, [tasks.length]);

  useEffect(() => {
    if (tasks.length === 0) return;
    const inferred = inferDefaultPlatform(tasks);
    const userLocked = sessionStorage.getItem("sourcePlatformUserLocked") === "1";
    if (!userLocked && inferred !== sourcePlatform) {
      setSourcePlatform(inferred);
    }
  }, [tasks, sourcePlatform]);

  useEffect(() => {
    sessionStorage.setItem("sourcePlatform", sourcePlatform);
    topicFetchGeneration.current += 1;
    lastTopicFetchRef.current = null;
    setOlderTopicsLoading(false);
    setOlderTopicsError(null);
    setTikhubError(null);
  }, [sourcePlatform]);

  const storeTikhubResults = (results: TikhubBatchResult[]) => {
    setTikhubResults(results);
    persistTikhubResults(results);
  };

  const requestTikhubSlice = async (
    target: TopicFetchTarget,
    days: number,
    resume?: TopicResumeState | null,
  ) => {
    const url = String(target || "").trim();
    if (!url) throw new Error("账号链接为空");
    const limits = topicRequestLimits(days);
    const response = await fetchWithRetry(apiUrl("/api/tikhub/batch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: [url], platform: sourcePlatform, days, resume, ...limits }),
    });
    const data = await parseApiJson(response);
    if (!response.ok) throw new Error(data?.error || "请求失败");
    const results = Array.isArray(data?.results) ? data.results as TikhubBatchResult[] : [];
    if (results.length !== 1) throw new Error("接口返回的账号结果不完整，请重试");
    return results;
  };

  const requestWechatSlice = async (
    target: TopicFetchTarget,
    days: number,
    resume?: TopicResumeState | null,
  ) => {
    if (typeof target === "string") throw new Error("视频号账号信息无效");
    const finderUsername = String(target.finderUsername || "").trim();
    if (!isFinderUsername(finderUsername)) {
      throw new Error("视频号账号标识无效，请重新搜索并确认账号后再获取作品。");
    }
    const limits = topicRequestLimits(days);
    const response = await fetchWithRetry(apiUrl("/api/platform/topics/batch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "wechat_channels",
        accounts: [{ ...target, finderUsername, resume }],
        days,
        ...limits,
      }),
    });
    const data = await parseApiJson(response);
    if (!response.ok) throw new Error(data?.error || "获取视频号作品失败");
    const results = Array.isArray(data?.results) ? data.results as TikhubBatchResult[] : [];
    if (results.length !== 1) throw new Error("视频号接口返回的账号结果不完整，请重试");
    return results;
  };

  useEffect(() => {
    const saved = readTopicFetchContext();
    if (!saved || saved.platform !== sourcePlatform) return;
    try {
      parseTopicDays(saved.requestedDays);
    } catch {
      sessionStorage.removeItem(TOPIC_FETCH_CONTEXT_KEY);
      return;
    }
    const jobs = saved.jobs.map(job => job.done
      ? { ...job }
      : {
          ...job,
          failed: true,
          errorMessage: job.errorMessage || "页面刷新后任务已暂停，可从保存游标继续",
        });
    const fetchSlice = sourcePlatform === "wechat_channels" ? requestWechatSlice : requestTikhubSlice;
    lastTopicFetchRef.current = { requestedDays: saved.requestedDays, jobs, fetchSlice };
    const failedCount = jobs.filter(job => job.failed).length;
    const warningCount = jobs.filter(job => job.warningMessage).length;
    if (failedCount > 0) {
      setOlderTopicsError(`${failedCount} 个账号任务已暂停，可从保存游标继续`);
    } else if (warningCount > 0) {
      setOlderTopicsError(`${warningCount} 个账号已达到安全上限，结果可能不完整`);
    }
  }, [sourcePlatform]);

  const mergeTopicSlice = (sliceResults: TikhubBatchResult[]) => {
    setTikhubResults((previous) => {
      const next = mergeTopicBatchResults<Topic>(previous, sliceResults) as TikhubBatchResult[];
      persistTikhubResults(next);
      return next;
    });
  };

  const runTopicJobs = async (
    generation: number,
    context: NonNullable<typeof lastTopicFetchRef.current>,
  ) => {
    let lastAccountKey = "";
    // 视频号媒体直链缺失的累计数（后端逐段回传）。抓完统一提示，避免用户干等。
    let missingMediaTotal = 0;
    while (generation === topicFetchGeneration.current) {
      const runnable = context.jobs.filter(job => !job.done && !job.failed);
      if (runnable.length === 0) break;

      for (const job of runnable) {
        if (generation !== topicFetchGeneration.current) return;
        // 切换到新账号时先节流等待，规避上游对连续高频请求的限流。
        // 同一账号的游标续拉（slice_limit）不等待。
        if (lastAccountKey && job.key !== lastAccountKey) {
          await sleepMs(TOPIC_ACCOUNT_THROTTLE_MS);
          if (generation !== topicFetchGeneration.current) return;
        }
        lastAccountKey = job.key;
        try {
          const sliceResults = await context.fetchSlice(job.target, context.requestedDays, job.resume);
          if (generation !== topicFetchGeneration.current) return;
          mergeTopicSlice(sliceResults);
          const result = sliceResults[0];
          if (!result) throw new Error("接口未返回账号结果");
          // 视频号：累计"没拿到媒体直链"的条数（后端算好回传），抓完统一提示。
          missingMediaTotal += Number(result.missingMediaCount || 0);

          job.resume = result.resume || null;
          if (result.error || result.stopReason === "page_error") {
            job.failed = true;
            job.errorMessage = result.error || result.backgroundError || "账号获取暂停";
          } else if (result.stopReason === "slice_limit" && result.resume) {
            // 只是一段三页切片完成，后端提供的游标应由下一轮原样续拉。
          } else if (result.stopReason === "time_boundary" || result.stopReason === "upstream_exhausted") {
            job.done = true;
          } else if (result.stopReason === "safety_limit" || result.isComplete === false) {
            job.done = true;
            job.warningMessage = result.incompleteReason || "已达到安全翻页上限，结果可能不完整";
          } else {
            job.done = true;
          }
          // 诊断日志：记录每个账号每一段的抓取结果，便于排查"第 N 个账号没抓到"类问题。
          // eslint-disable-next-line no-console
          console.info("[topic-fetch]", job.key, {
            stopReason: result.stopReason,
            isComplete: result.isComplete,
            videosCount: result.videosCount,
            rawVideosCount: result.rawVideosCount,
            hasMore: result.hasMore,
            hasResume: Boolean(result.resume),
            done: job.done,
            failed: job.failed,
          });
        } catch (error) {
          job.failed = true;
          job.errorMessage = error instanceof Error ? error.message : "账号获取暂停";
        }
        persistTopicFetchContext(context, sourcePlatform);
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
    }

    if (generation !== topicFetchGeneration.current) return;
    // 🔴 视频号缺媒体直链要**抓完就提示**：缺 mediaUrl/decodeKey 的条目无法在本地
    //    解密转写，最终表现是"选题列表有内容、但脚本和标签一直不动"，用户看不出原因。
    //    这里说清楚，用户就知道该重新获取作品，而不是干等。
    if (missingMediaTotal > 0) {
      setTikhubError(
        `有 ${missingMediaTotal} 条视频号作品没有拿到媒体直链或解密密钥，这些条无法提取脚本与打标签（其余条目不受影响）。` +
        "若全部如此，请重新获取该账号的作品后重试。",
      );
    }
    const failedJobs = context.jobs.filter(job => job.failed);
    const warningJobs = context.jobs.filter(job => job.warningMessage);
    const paymentRequired = failedJobs.some(job => /HTTP 402|Payment Required/i.test(job.errorMessage || ""));
    setOlderTopicsError(failedJobs.length > 0
      ? paymentRequired
        ? `${failedJobs.length} 个账号因 TikHub 余额不足暂停；充值后可从失败页继续`
        : `${failedJobs.length} 个账号获取暂停，可从失败页重试`
      : warningJobs.length > 0
        ? `${warningJobs.length} 个账号已达到安全上限，结果可能不完整`
        : null);
    if (failedJobs.length === 0 && warningJobs.length === 0) {
      sessionStorage.removeItem(TOPIC_FETCH_CONTEXT_KEY);
    } else {
      persistTopicFetchContext(context, sourcePlatform);
    }
  };

  const startProgressiveTopicFetch = async (
    requestedDays: number,
    targets: TopicFetchTarget[],
    fetchSlice: TopicSliceFetcher,
  ) => {
    const generation = ++topicFetchGeneration.current;
    const jobs = targets.map((target, index) => ({
      key: typeof target === "string" ? target : String(target.finderUsername || target.inputName || index),
      target,
      resume: null,
      failed: false,
      done: false,
    }));
    const context = { requestedDays, jobs, fetchSlice };
    lastTopicFetchRef.current = context;
    persistTopicFetchContext(context, sourcePlatform);
    setExpandedTopicGroups([0]);
    setOlderTopicsLoading(true);
    setOlderTopicsError(null);
    setTopicDays(requestedDays);
    setTopicDaysInput(String(requestedDays));
    setTopicDaysError(null);
    sessionStorage.setItem("topicWindowDays", String(requestedDays));
    storeTikhubResults([]);
    setSelectedTopics([]);
    sessionStorage.removeItem("selectedTopicIds");
    await runTopicJobs(generation, context);
    if (generation === topicFetchGeneration.current) setOlderTopicsLoading(false);
  };

  const retryOlderTopics = async () => {
    if (olderTopicsLoading) return;
    const context = lastTopicFetchRef.current;
    if (!context) {
      setOlderTopicsError("缺少上一次获取上下文，请重新开始获取");
      return;
    }
    const failedJobs = context.jobs.filter(job => job.failed);
    if (failedJobs.length === 0) {
      setOlderTopicsError(null);
      return;
    }
    const generation = topicFetchGeneration.current;
    setOlderTopicsLoading(true);
    failedJobs.forEach(job => {
      job.failed = false;
      job.done = false;
      job.errorMessage = undefined;
    });
    await runTopicJobs(generation, context);
    if (generation === topicFetchGeneration.current) setOlderTopicsLoading(false);
  };

  const runTikhubFetch = async () => {
    const rawItems = parseLines(tikhubInput);

    if (rawItems.length === 0) {
      setTikhubError(
        sourcePlatform === "wechat_channels"
          ? "请输入视频号对标账号名称（每行一个）"
          : sourcePlatform === "tiktok"
            ? "请输入 TikTok 博主主页链接（每行一个，如 https://www.tiktok.com/@username）"
            : "请输入抖音博主主页分享链接（每行一个）",
      );
      return;
    }

    let requestedDays: number;
    try {
      requestedDays = parseTopicDays(topicDaysInput);
      setTopicDaysError(null);
    } catch (error) {
      setTopicDaysError(error instanceof Error ? error.message : "时间范围无效");
      return;
    }

    // 点赞门槛：就地校验并**在这里生效**（不随输入框即时生效，见 UI 处的说明）。
    // 校验失败直接中止 —— 不能拿一个没生效的门槛去抓数据，否则筛出来的列表
    // 和界面显示的数值对不上。
    const parsedMinLikes = parseMinLikes(minLikesInput);
    setMinLikesError(parsedMinLikes.ok ? null : parsedMinLikes.error);
    if (!parsedMinLikes.ok) return;
    setMinLikes(parsedMinLikes.value);

    setTikhubLoading(true);
    setTikhubError(null);

    try {
      if (sourcePlatform === "wechat_channels") {
        const missingNames = rawItems.filter(name => !isConfirmedWechatAccount(name, confirmedWechatAccounts[name]));
        if (missingNames.length > 0) {
          const response = await fetchWithRetry(apiUrl("/api/platform/accounts/search"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              platform: "wechat_channels",
              keywords: missingNames,
            }),
          });
          const data = await parseApiJson(response);
          if (!response.ok) {
            throw new Error(data?.error || "账号搜索失败");
          }
          const results = Array.isArray(data?.results) ? data.results : [];
          setWechatSearchResults(results);
          sessionStorage.setItem("wechatAccountSearchResults", JSON.stringify(results));
          sessionStorage.setItem("tikhubInput", tikhubInput);
          if (results.some((item: WeChatAccountSearchResult) => item.candidates?.length > 0)) {
            setTikhubError("请选择每个视频号名称对应的正确账号，然后点击获取已确认账号作品。");
          } else if (results.some((item: WeChatAccountSearchResult) => item.diagnostics?.outcome === "upstream_error")) {
            setTikhubError("部分视频号账号搜索请求失败，请查看每个账号的具体失败阶段后重试。");
          } else {
            setTikhubError("上游没有返回可用的视频号账号标识，请查看每个账号的字段诊断后调整名称或稍后重试。");
          }
          return;
        }

        await fetchConfirmedWechatTopics(rawItems, requestedDays);
        return;
      }

      await startProgressiveTopicFetch(
        requestedDays,
        rawItems,
        requestTikhubSlice,
      );
      sessionStorage.setItem("tikhubInput", tikhubInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败";
      setTikhubError(message);
    } finally {
      setTikhubLoading(false);
    }
  };

  const confirmWechatCandidate = (inputName: string, candidate: WeChatAccountCandidate) => {
    const next = {
      ...confirmedWechatAccounts,
      [inputName]: candidate,
    };
    setConfirmedWechatAccounts(next);
    writeWeChatAccountCache(next);
    setTikhubError(null);
  };

  const resetWechatCandidate = (inputName: string) => {
    const next = { ...confirmedWechatAccounts };
    delete next[inputName];
    setConfirmedWechatAccounts(next);
    writeWeChatAccountCache(next);
  };

  const fetchConfirmedWechatTopics = async (
    names = parseLines(tikhubInput),
    requestedDaysValue?: number,
  ) => {
    if (names.length === 0) {
      setTikhubError("请输入视频号对标账号名称（每行一个）");
      return;
    }
    let requestedDays: number;
    try {
      requestedDays = parseTopicDays(requestedDaysValue ?? topicDaysInput);
      setTopicDaysError(null);
    } catch (error) {
      setTopicDaysError(error instanceof Error ? error.message : "时间范围无效");
      return;
    }
    const missingNames = names.filter(name => !isConfirmedWechatAccount(name, confirmedWechatAccounts[name]));
    if (missingNames.length > 0) {
      setTikhubError(`以下视频号尚未搜索并确认有效账号：${missingNames.join("、")}`);
      return;
    }
    const accounts = names.map(name => {
      const candidate = confirmedWechatAccounts[name];
      return {
        inputName: candidate.inputName,
        displayName: candidate.displayName,
        finderUsername: candidate.finderUsername.trim(),
      };
    });

    setTikhubLoading(true);
    setTikhubError(null);
    resetAutoWechatShareLinkGeneration();
    try {
      await startProgressiveTopicFetch(
        requestedDays,
        accounts,
        requestWechatSlice,
      );
      sessionStorage.setItem("tikhubInput", tikhubInput);
      sessionStorage.setItem("sourcePlatform", "wechat_channels");
    } catch (error) {
      const message = error instanceof Error ? error.message : "获取视频号作品失败";
      setTikhubError(message);
    } finally {
      setTikhubLoading(false);
    }
  };

  const updateTopicLink = (topicId: string, link: string) => {
    setTikhubResults(prev => {
      const next = prev.map(result => ({
        ...result,
        topics: Array.isArray(result.topics)
          ? result.topics.map(topic => topic.id === topicId ? { ...topic, link } : topic)
          : result.topics,
      }));
      persistTikhubResults(next);
      return next;
    });
  };

  const requestWechatShareLink = async (topic: Topic) => {
    const objectId = String(topic.source?.objectId || "").trim();
    if (!objectId) {
      throw new Error("该视频号作品缺少 objectId，无法生成分享链接。");
    }

    const response = await fetchWithRetry(apiUrl("/api/platform/topics/share-link"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        platform: "wechat_channels",
        objectId,
      }),
    });
    const data = await parseApiJson(response);
    if (!response.ok) {
      throw new Error(data?.error || "生成视频号分享链接失败");
    }
    const shareUrl = String(data?.shareUrl || "").trim();
    if (!shareUrl) {
      throw new Error("接口未返回可用分享链接");
    }
    return shareUrl;
  };

  const generateWechatShareLink = async (topic: Topic) => {
    const objectId = String(topic.source?.objectId || "").trim();
    if (!objectId) {
      setTikhubError("该视频号作品缺少 objectId，无法生成分享链接。");
      return;
    }

    setTopicLinkLoadingId(topic.id);
    setTikhubError(null);
    autoWechatShareLinkRef.current.attemptedIds.add(topic.id);
    try {
      const shareUrl = await requestWechatShareLink(topic);
      updateTopicLink(topic.id, shareUrl);
      window.open(shareUrl, "_blank");
    } catch (error) {
      setTikhubError(error instanceof Error ? error.message : "生成视频号分享链接失败");
    } finally {
      setTopicLinkLoadingId(null);
    }
  };

  useEffect(() => {
    if (sourcePlatform !== "wechat_channels") {
      const state = autoWechatShareLinkRef.current;
      state.runId += 1;
      state.running = false;
      setWechatShareLinksLoading(false);
      return;
    }
    if (tikhubLoading || olderTopicsLoading || autoWechatShareLinkRef.current.running) return;

    const state = autoWechatShareLinkRef.current;
    const selectedIds = new Set(selectedTopics);
    // 未勾选的作品不请求 TikHub，避免为不会使用的链接消耗调用次数。
    const pendingTopics = tikhubResults.flatMap(result => Array.isArray(result.topics) ? result.topics : [])
      .filter(topic => (
        topic.platform === "wechat_channels"
        && !topic.link
        && Boolean(String(topic.source?.objectId || "").trim())
        && selectedIds.has(topic.id)
        && !state.attemptedIds.has(topic.id)
      ));
    if (pendingTopics.length === 0) return;

    state.running = true;
    const runId = ++state.runId;
    setWechatShareLinksLoading(true);
    setTikhubError(null);

    void (async () => {
      const failedTopics: string[] = [];
      for (const topic of pendingTopics) {
        if (autoWechatShareLinkRef.current.runId !== runId) break;
        if (!selectedTopicIdsRef.current.has(topic.id)) continue;
        state.attemptedIds.add(topic.id);
        setTopicLinkLoadingId(topic.id);
        try {
          const shareUrl = await requestWechatShareLink(topic);
          if (autoWechatShareLinkRef.current.runId !== runId) break;
          updateTopicLink(topic.id, shareUrl);
        } catch {
          failedTopics.push(topic.title || topic.id);
        } finally {
          if (autoWechatShareLinkRef.current.runId === runId) {
            setTopicLinkLoadingId(null);
          }
        }

        if (autoWechatShareLinkRef.current.runId === runId) {
          await sleepMs(WECHAT_SHARE_LINK_THROTTLE_MS);
        }
      }

      if (autoWechatShareLinkRef.current.runId !== runId) return;
      state.running = false;
      setWechatShareLinksLoading(false);
      setTopicLinkLoadingId(null);
      if (failedTopics.length > 0) {
        setTikhubError(`${failedTopics.length} 条已勾选的视频号作品未能自动生成分享链接，取消勾选后重新勾选可重试。`);
      }
    })();
  }, [olderTopicsLoading, selectedTopics, sourcePlatform, tikhubLoading, tikhubResults, wechatShareLinksLoading]);

  const taskCount = tasks.length;
  const hasRetryableTopicJobs = Boolean(lastTopicFetchRef.current?.jobs.some(job => job.failed));

  useEffect(() => {
    if (!taskCarouselApi) return;
    taskCarouselApi.scrollTo(taskIndex, true);
  }, [taskCarouselApi, taskIndex]);

  useEffect(() => {
    const links = parseBenchmarkLinks(activeTask?.benchmarkAccounts);
    if (links.length === 0) return;

    const nextValue = links.join("\n");
    setTikhubInput(nextValue);
    sessionStorage.setItem("tikhubInput", nextValue);
  }, [activeTask?._id, activeTask?.benchmarkAccounts]);

  /**
   * 一次性自动抓取 —— 员工刚**新建**「临时分析」时，链接已经在抓取框里了，
   * 再让他点一次「开始获取」纯属多余。`TodayTasksPage` 写下 `topicsAutoFetchKey`，
   * 这里消费一次就记下 `topicsAutoFetchConsumedKey`（与 `ContentPage` 的
   * `contentAutoRunKey` / `...ConsumedKey` 同一套惯例）。
   *
   * ⚠️ 三条守卫缺一不可：
   *   · `topicsAutoFetchRef` —— 同一次挂载内只跑一次（deps 再变也不重跑）；
   *   · `...ConsumedKey` —— **刷新 / 返回本页不重跑**。少了它每刷新一次就重新抓一遍，
   *     而每次抓取都是真金白银的 TikHub 调用；
   *   · `tikhubInput` 非空 —— 输入还没落地时不抓（否则会抓到上一轮的残留输入）。
   *
   * ⚠️ **视频号那条路上，自动抓取只能推进到「请选择正确账号」就停下**：
   * `runTikhubFetch` 需要用户从候选里选定账号，这一步没法也不该替他做。
   * 抖音 / TikTok 没有这个中间态，会一路抓完。
   */
  useEffect(() => {
    const autoFetchKey = sessionStorage.getItem("topicsAutoFetchKey") || "";
    if (!autoFetchKey) return;
    if (sessionStorage.getItem("topicsAutoFetchConsumedKey") === autoFetchKey) return;
    if (topicsAutoFetchRef.current === autoFetchKey) return;
    if (tikhubLoading) return;
    if (parseLines(tikhubInput).length === 0) return;

    topicsAutoFetchRef.current = autoFetchKey;
    sessionStorage.setItem("topicsAutoFetchConsumedKey", autoFetchKey);
    void runTikhubFetch();
  }, [tikhubInput, tikhubLoading]);

  /**
   * 抓取完成后自动跑一次：**（近 7 天）提取完整脚本 + 按库内分类打标签**。
   *
   * 词典来自**入口就定好的那个客户**：临时任务/指派任务都会带 `customerId`。
   * 没有客户或没建库时不打标签，并如实说明原因 —— 不猜、不静默跳过。
   *
   * ⚠️ 用 `analyzedKeyRef` 记住"这一批视频 + 这个窗口 + 这个客户"只跑一次：
   *    每次调用都是真金白银的 TikHub / 豆包 / DeepSeek 调用，重渲染绝不能再触发一次。
   *    转写结果在后端按 `scope: "script"` 永久缓存，所以换窗口回来是秒开的。
   */
  const analyzedKeyRef = useRef("");

  /**
   * 「这批视频」的范围指纹 —— **effect 的唯一依赖**。
   *
   * 用 `useMemo` 保证它是稳定的**字符串**：值相同就是同一个字符串（原始类型比较），
   * 不会像数组/对象那样每次渲染都是新引用而误触发 effect 重跑。
   */
  const customerIdForAnalysis = String(activeTask?.customerId || "");
  const topicAnalysisScopeKey = useMemo(() => (
    qualifiedTopics.length === 0
      ? ""
      : buildTopicAnalysisScopeKey(customerIdForAnalysis, topicDays, qualifiedTopics.map(topic => topic.id))
  ), [qualifiedTopics, topicDays, customerIdForAnalysis]);

  /**
   * 下面这些值 effect 里要用，但**绝不能进依赖数组**。
   *
   * 🔴 它们中的 `topicContent` / `topicAnalysisScope` 会被这个 effect **自己改写**
   *    （`setTopicContent` / `setTopicAnalysisScope`）。进了依赖就是「启动即自我取消」：
   *    effect 一跑就改依赖 → cleanup 执行 → 正在进行的分析被永久取消，界面停在第一句
   *    文案上、不报错也不推进。详见 `shouldCancelAnalysisRun` 的注释。
   *    用 ref 读取最新值即可满足这些副作用的需要。
   */
  const qualifiedTopicsRef = useRef(qualifiedTopics);
  qualifiedTopicsRef.current = qualifiedTopics;
  const topicContentRef = useRef(topicContent);
  topicContentRef.current = topicContent;
  const topicAnalysisScopeRef = useRef(topicAnalysisScope);
  topicAnalysisScopeRef.current = topicAnalysisScope;
  const minLikesRef = useRef(minLikes);
  minLikesRef.current = minLikes;
  const topicDaysRef = useRef(topicDays);
  topicDaysRef.current = topicDays;

  useEffect(() => {
    const key = topicAnalysisScopeKey;
    const action = decideTopicAnalysisAction({
      scopeKey: key,
      analyzedKey: analyzedKeyRef.current,
      // 复用判断依据是持久化下来的「范围指纹」：客户 + 时间窗口 + 这批视频 id。
      // 三者任一变化（换任务 / 换窗口 / 抓到新视频）就必须重新分析 —— 复用错批次的
      // 标签比重新跑一遍更糟，用户会拿着上一批的标签去二创。
      savedScopeKey: topicAnalysisScopeRef.current,
      contentCount: Object.keys(topicContentRef.current).length,
    });
    if (action === "skip") return;
    // 无论复用还是重跑，都先登记这个 key，避免同批范围重复触发。
    analyzedKeyRef.current = key;
    if (action === "reuse") return;

    const topics = qualifiedTopicsRef.current;
    const customerId = customerIdForAnalysis;
    const days = topicDaysRef.current;
    const threshold = minLikesRef.current;

    setTopicAnalysisScope(key);

    let cancelled = false;
    setTopicAnalysis(previous => ({ ...previous, status: "loading-library", message: "", error: "" }));
    // ⚠️ 同时清空旧的脚本/标签：换任务或换时间窗口后，上一次的结果若留在 state 里，
    //    界面会拿**上一批视频**的标签渲染这一批（错得很难发现）。清空后由下面的
    //    `onContent` 逐条填回来。
    setTopicContent({});
    (async () => {
      try {
        const { content, analysis } = await runTopicContentAnalysis({
          topics,
          customerId,
          days,
          minLikes: threshold,
          onProgress: patch => { if (!cancelled) setTopicAnalysis(previous => ({ ...previous, ...patch })); },
          // 逐条/逐批推进：每完成一条就把**累计**结果推进 state，用户不必等全部跑完。
          onContent: next => { if (!cancelled) setTopicContent(next); },
        });
        if (cancelled) return;
        setTopicContent(content);
        setTopicAnalysis(previous => ({ ...previous, ...analysis, error: "" }));
      } catch (error) {
        if (cancelled) return;
        // 失败要说清楚，但**不能挡住列表**：筛选结果本身仍然可用。
        // 已经逐条落地的内容也**不清空** —— 方案一的意义就是"出了几条是几条"。
        setTopicAnalysis(previous => ({
          ...previous,
          status: "error",
          error: error instanceof Error ? error.message : "脚本 / 标签分析失败",
        }));
      }
    })();
    // 这个 cleanup 只在**范围指纹变化**（或卸载）时执行 —— 此时取消旧的分析是对的。
    // 依赖数组里只有 key，所以它不会因为"进度文案变了""逐条结果落地了"而被误触发。
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 唯一依赖就是范围指纹，其余值走 ref（见上方注释）
  }, [topicAnalysisScopeKey]);
  useEffect(() => {
    let cancelled = false;
    setReviewMemory(null); setReviewSelectionMessage(''); setReviewMemoryError('');
    const customerId = String(activeTask?.customerId || '');
    if (customerId && ['douyin', 'wechat_channels'].includes(sourcePlatform)) {
      getActiveReviewMemory(customerId, sourcePlatform).then(memory => { if (!cancelled) setReviewMemory(memory); })
        .catch(error => { if (!cancelled) setReviewMemoryError(`复盘配比读取失败：${error.message}`); });
    }
    return () => { cancelled = true; };
  }, [activeTask?.customerId, sourcePlatform]);

  /**
   * 预热选题库词典：**一进入选题页就发请求**，不等视频抓完。
   *
   * 用户口径（2026-09-24）：创建任务进入选题生成页时就该开始读库。
   * 读库是纯 Mongo 查询、几百毫秒到几秒；而它和「抓视频」是两件互不依赖的事，
   * 串起来做成"抓完再读库"白等一段时间。这里提前把 Promise 发出去，
   * 后面 `runTopicContentAnalysis` 走同一份 memo（见 `loadLibraryForCustomer`），
   * 命中就是 0 成本。
   *
   * ⚠️ 只预热，不 setState、不报错：库不存在 / 没有 customerId 都在真正分析时
   *    按原口径如实说明。预热失败最坏结果就是分析时重新请求一次。
   */
  useEffect(() => {
    const customerId = String(activeTask?.customerId || "");
    if (!customerId) return;
    void loadLibraryForCustomer(customerId).catch(() => {});
  }, [activeTask?.customerId]);

  const handleSubmit = () => {
    // ⚠️ 用挂上 content 的版本：脚本与标签要跟着 topic 一起进 sessionStorage，
    //    下一步二创才不用重新提取（用户明确要求）。
    const selectedData = topicsWithContent.filter(topic => selectedTopics.includes(topic.id));
    sessionStorage.setItem("selectedTopics", JSON.stringify(selectedData));
    sessionStorage.setItem("contentTasks", JSON.stringify(tasks));
    sessionStorage.setItem("selectedTopicIds", JSON.stringify(selectedTopics));
    // ⚠️ 客户必须跟着落到 sessionStorage：二创页要拿它去选题库取「大类 → 三秒/结尾钩子配比」。
    //    它只在 activeTask 的内存里，`selectedTopics` 上**没有**这个字段，
    //    不单独存一份的话二创页永远拼不出配比请求（表现为功能静默不生效）。
    sessionStorage.setItem("contentCustomerId", String(activeTask?.customerId || ""));
    sessionStorage.setItem("contentActiveGroupIndex", "0");
    sessionStorage.setItem("contentAutoRunKey", `${activeTask?._id || "task"}:${selectedTopics.join(",")}`);
    navigate("/content");
  };


  const formatNumber = (num: number): string => {
    if (num >= 10000) {
      return (num / 10000).toFixed(1) + '万';
    }
    return num.toString();
  };

  const formatPeriod = (period?: { start?: string; end?: string }) => {
    if (!period?.start || !period?.end) return "未设置周期";
    const start = String(period.start).slice(0, 10);
    const end = String(period.end).slice(0, 10);
    return `${start} ~ ${end}`;
  };

  const splitRequirements = (items?: string[]) => {
    if (!Array.isArray(items)) return [];
    return items.filter(item => item && item.trim().length > 0);
  };

  const parseBenchmarkLinks = (value?: string) => {
    const raw = String(value || "").trim();
    if (!raw) return [] as string[];

    const urlMatches = raw.match(/https?:\/\/[^\s，,；;]+/g) || [];
    if (urlMatches.length > 0) {
      return Array.from(new Set(urlMatches.map(link => link.trim()).filter(Boolean)));
    }

    return Array.from(
      new Set(
        raw
          .split(/[\n，,；;\s]+/)
          .map(link => link.trim())
          .filter(Boolean)
      )
    );
  };

  const metaChips = (task?: TaskItem) => {
    if (!task) return [];
    const chips = [];
    if (task.ownerName) chips.push({ label: task.ownerName, icon: User });
    if (task.platformName) chips.push({ label: task.platformName, icon: Layers });
    if (task.contact) chips.push({ label: task.contact, icon: Phone });
    return chips;
  };

  return (
    <div className="min-h-screen bg-[#f5f7fb] pb-24">
      {/* Header */}
      <header className="border-b border-slate-200/80 bg-white/80 px-5 py-6 backdrop-blur sm:px-8 lg:px-10">
        <div className="mx-auto max-w-[1500px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600">
                <span className="h-2 w-2 rounded-full bg-blue-600" />
                TOPIC WORKBENCH
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">选题生成与选择</h1>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                已导入客户信息与内容需求，系统自动生成运营选题
              </p>
            </div>
            {/* 这一页是员工的第二步，得能退回第一步 —— 原来没有返回入口，
                进来就只能靠浏览器后退。与内容生成页/最终编辑页同一套按钮样式。 */}
            <Button
              variant="outline"
              className="h-10 rounded-xl border-slate-200 bg-white text-slate-600 shadow-sm hover:border-slate-300 hover:text-slate-900"
              onClick={() => navigate(workbenchBackTo)}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {workbenchBackLabel}
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="mx-auto max-w-[1500px] px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-6">
          {/* Left Panel - Decision Support Area */}
          <div className="space-y-6">
            <Card className="bg-white border-slate-200 shadow-sm overflow-hidden">
              <CardHeader className="pb-3 border-b border-slate-100 bg-gradient-to-r from-blue-50 via-white to-white">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold text-slate-900">客户信息 & 内容需求</CardTitle>
                    <p className="text-xs text-slate-500 mt-1">一个任务对应一个展示面板，左右滑动切换</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="bg-blue-100 text-blue-700 border-blue-200">
                      {taskCount > 0 ? `${taskIndex + 1} / ${taskCount}` : "暂无"}
                    </Badge>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-700 disabled:opacity-40"
                        onClick={() => taskCarouselApi?.scrollPrev()}
                        disabled={!taskCarouselApi?.canScrollPrev()}
                        aria-label="上一任务"
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-700 disabled:opacity-40"
                        onClick={() => taskCarouselApi?.scrollNext()}
                        disabled={!taskCarouselApi?.canScrollNext()}
                        aria-label="下一任务"
                      >
                        ›
                      </button>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-4">
                {taskLoading ? (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                    正在连接任务系统...
                  </div>
                ) : taskError ? (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-600">
                    {taskError}
                  </div>
                ) : taskCount === 0 ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                    暂无待处理任务
                  </div>
                ) : (
                  <Carousel
                    opts={{ align: "start", loop: false }}
                    className="relative"
                    setApi={(api) => {
                      setTaskCarouselApi(api);
                      api.on("select", () => {
                        setTaskIndex(api.selectedScrollSnap());
                      });
                    }}
                  >
                    <CarouselContent className="py-2">
                      {tasks.map(task => {
                        const requirements = splitRequirements(task.contentRequirements);
                        return (
                          <CarouselItem key={task._id} className="pl-0">
                            <div className="rounded-2xl border border-slate-200 bg-white/95 px-4 py-4 shadow-sm transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-xl">
                              <div className="space-y-5">
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
                                  <div className="flex items-center gap-2 text-xs text-slate-500">
                                    <CalendarDays className="h-4 w-4" />
                                    {formatPeriod(task.collaborationPeriod)}
                                  </div>
                                  <div className="mt-2 flex flex-wrap items-center gap-2">
                                    <span className="text-lg font-semibold text-slate-900">{task.customerName || "未命名客户"}</span>
                                    {isAdhocTask(task) && <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">临时分析 · 未关联客户</span>}
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    {metaChips(task).map((chip, index) => (
                                      <div key={`${chip.label}-${index}`} className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
                                        <chip.icon className="h-3.5 w-3.5" />
                                        {chip.label}
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-white to-slate-50 px-4 py-4">
                                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                                    <Sparkles className="h-4 w-4 text-blue-500" />
                                    核心客户信息
                                  </div>
                                  <div className="mt-2 space-y-1.5 text-sm text-slate-600 leading-relaxed">
                                    <p>客户职业：{task.customerOccupation || "未提供"}</p>
                                    <p>个人IP定位：{task.ipPositioning || "未提供"}</p>
                                  </div>
                                </div>

                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
                                  <div className="flex items-center justify-between">
                                    <div>
                                      <div className="text-sm font-semibold text-slate-900">内容需求要点</div>
                                      <div className="text-xs text-slate-500 mt-1">与任务需求表单同步</div>
                                    </div>
                                    <Badge className="bg-slate-100 text-slate-600 border-slate-200">
                                      {requirements.length} 条
                                    </Badge>
                                  </div>
                                  <div className="mt-3 space-y-2">
                                    <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                                      <span className="text-xs text-slate-500">创意方向：</span>
                                      <span>{task.contentDirection || "未提供"}</span>
                                    </div>

                                    {requirements.length > 0 ? (
                                      requirements.map((item, index) => (
                                        <div key={`${task._id}-req-${index}`} className="flex items-start gap-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                                          <span className="mt-0.5 h-2 w-2 rounded-full bg-blue-400" />
                                          <span>{item}</span>
                                        </div>
                                      ))
                                    ) : (
                                      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500">
                                        暂无内容需求
                                      </div>
                                    )}
                                  </div>
                                </div>

                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
                                  <div className="text-sm font-semibold text-slate-900">对标账号</div>
                                  <p className="mt-2 text-sm text-slate-600 leading-relaxed break-all whitespace-pre-line">
                                    {task.benchmarkAccounts || "未提供"}
                                  </p>
                                </div>

                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
                                  <div className="text-sm font-semibold text-slate-900">补充说明</div>
                                  <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                                    {task.notes || "暂无补充说明"}
                                  </p>
                                </div>
                              </div>
                            </div>
                          </CarouselItem>
                        );
                      })}
                    </CarouselContent>
                  </Carousel>
                )}
              </CardContent>
            </Card>

          </div>

          {/* Right Panel - Topic Selection Area */}
          <div className="space-y-6">
            <div className="flex flex-col gap-1">
              <div className="text-sm text-slate-500">今日选题</div>
              <h2 className="text-xl font-semibold text-slate-900">先生成选题再进行筛选</h2>
            </div>

            <Card className="bg-white border-slate-200 shadow-sm overflow-hidden">
              <CardHeader className="pb-4 border-b border-slate-100">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Target className="w-5 h-5 text-blue-600" />
                    <CardTitle className="text-lg font-medium text-slate-900">批量获取对标作品数据</CardTitle>
                  </div>
                  <div className="text-xs text-slate-500 flex items-center gap-2">
                    <TrendingUp className="w-3.5 h-3.5" />
                    {tikhubLoading ? "请求中" : sourcePlatform === "wechat_channels" ? "每行一个视频号名称" : sourcePlatform === "tiktok" ? "每行一个 TikTok 主页链接" : "每行一个主页链接"}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: "douyin", label: "抖音" },
                    { id: "wechat_channels", label: "视频号" },
                    { id: "tiktok", label: "TikTok" },
                  ].map(option => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        sessionStorage.setItem("sourcePlatformUserLocked", "1");
                        setSourcePlatform(option.id as SourcePlatform);
                      }}
                      className={`rounded-full border px-3 py-1.5 text-xs transition ${
                        sourcePlatform === option.id
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <div>
                    <div className="text-xs font-semibold text-slate-600">发布时间范围</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {[7, 15, 30, 90, 180, 365, 730].map(days => (
                        <button
                          key={days}
                          type="button"
                          onClick={() => {
                            setTopicDaysInput(String(days));
                            setTopicDaysError(null);
                          }}
                          className={`rounded-full border px-3 py-1 text-xs transition ${
                            topicDaysInput === String(days)
                              ? "border-blue-500 bg-blue-50 text-blue-700"
                              : "border-slate-200 text-slate-600 hover:border-slate-300"
                          }`}
                        >
                          近 {days} 天
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="ml-auto text-xs text-slate-600">
                    自定义 1–{MAX_TOPIC_DAYS} 天
                    <input
                      type="number"
                      min={1}
                      max={MAX_TOPIC_DAYS}
                      step={1}
                      value={topicDaysInput}
                      onChange={event => {
                        setTopicDaysInput(event.target.value);
                        setTopicDaysError(null);
                      }}
                      className="ml-2 h-8 w-20 rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                  {topicDaysError && <div className="w-full text-xs text-red-500">{topicDaysError}</div>}
                </div>
                {/*
                  点赞门槛：用户可自定义（2026-09-28）。
                  ⚠️ 只改输入框、**不立即改门槛** —— 门槛一变 `qualifiedTopics` 就变，
                     会触发整批重新分析（转写 + 打标签，真花钱）。所以这里沿用时间窗口
                     同一套做法：输入先落在 `minLikesInput`，点下方「开始获取」时才生效。
                */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-slate-600">点赞门槛</span>
                  {[0, 100, 500, 1000, 5000].map(value => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => {
                        setMinLikesInput(String(value));
                        setMinLikesError(null);
                      }}
                      className={`rounded-full border px-3 py-1 text-xs transition ${
                        minLikesInput === String(value)
                          ? "border-blue-500 bg-blue-50 text-blue-700"
                          : "border-slate-200 text-slate-600 hover:border-slate-300"
                      }`}
                    >
                      ≥ {value}
                    </button>
                  ))}
                  <label className="ml-auto text-xs text-slate-600">
                    自定义
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={minLikesInput}
                      onChange={event => {
                        setMinLikesInput(event.target.value);
                        setMinLikesError(null);
                      }}
                      className="ml-2 h-8 w-24 rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                    />
                    <span className="ml-1 text-slate-400">赞及以上</span>
                  </label>
                  {minLikesError && <div className="w-full text-xs text-red-500">{minLikesError}</div>}
                  {/*
                    ⚠️ 门槛是**点击获取时才生效**，所以当输入值与生效值不一致时要说出来，
                       否则用户改完输入框看列表没变，会以为功能坏了。
                  */}
                  {!minLikesError && minLikesInput !== String(minLikes) && (
                    <div className="w-full text-xs text-amber-600">
                      门槛已改为 {minLikesInput}，点「开始获取」后按新门槛筛选。
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="text-xs font-semibold text-slate-600">
                    {sourcePlatform === "wechat_channels" ? "视频号对标账号名称（多行）" : sourcePlatform === "tiktok" ? "TikTok 博主主页链接（多行）" : "抖音博主主页分享链接（多行）"}
                  </div>
                  <textarea
                    value={tikhubInput}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setTikhubInput(nextValue);
                      sessionStorage.setItem("tikhubInput", nextValue);
                      if (sourcePlatform === "wechat_channels") setTikhubError(null);
                    }}
                    placeholder={sourcePlatform === "wechat_channels" ? "每行一个账号名称，例如：人民日报" : sourcePlatform === "tiktok" ? "每行一个 TikTok 主页，例如：https://www.tiktok.com/@username" : "每行一个主页链接"}
                    className="mt-2 h-32 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                  />
                  {tikhubError && (
                    <div className="mt-2 text-xs text-red-500">{tikhubError}</div>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <Button
                    onClick={runTikhubFetch}
                    disabled={tikhubLoading}
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    {tikhubLoading ? "处理中..." : sourcePlatform === "wechat_channels" ? "搜索/获取视频号作品" : "开始获取"}
                  </Button>
                  {sourcePlatform === "wechat_channels" && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={tikhubLoading}
                      onClick={() => fetchConfirmedWechatTopics()}
                      className="border-slate-200 text-slate-600 hover:text-slate-800"
                    >
                      <RefreshCw className="mr-2 h-4 w-4" />
                      获取已确认账号作品
                    </Button>
                  )}
                </div>

                {sourcePlatform === "wechat_channels" && wechatSearchResults.length > 0 && (
                  <div className="space-y-3">
                    {wechatSearchResults.map(result => {
                      const confirmed = confirmedWechatAccounts[result.inputName];
                      return (
                        <div key={result.inputName} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">{result.inputName}</div>
                              <div className="text-xs text-slate-500">
                                {confirmed ? `已确认：${confirmed.displayName}` : "请选择正确的视频号账号"}
                              </div>
                            </div>
                            {confirmed && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-slate-500 hover:text-slate-800"
                                onClick={() => resetWechatCandidate(result.inputName)}
                              >
                                重新选择
                              </Button>
                            )}
                          </div>
                          {result.diagnostics && (
                            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                              <div>
                                账号搜索：候选 {result.diagnostics.accountSearch.candidates}/{result.diagnostics.accountSearch.items}
                                {result.diagnostics.accountSearch.missingFinderUsername > 0
                                  ? `，${result.diagnostics.accountSearch.missingFinderUsername} 条缺少 finderUsername`
                                  : ""}
                              </div>
                              {result.diagnostics.accountSearch.candidates === 0 && (
                                <div className="mt-1">
                                  作品搜索：{result.diagnostics.videoSearch.items} 条，
                                  可查询详情 {result.diagnostics.videoSearch.usableItems} 条
                                  {result.diagnostics.videoSearch.missingExportId > 0
                                    ? `，${result.diagnostics.videoSearch.missingExportId} 条缺少 exportId`
                                    : ""}
                                </div>
                              )}
                              {result.diagnostics.videoDetail.requested > 0 && (
                                <div className="mt-1">
                                  视频详情：成功 {result.diagnostics.videoDetail.succeeded}/{result.diagnostics.videoDetail.requested}
                                  {result.diagnostics.videoDetail.missingFinderUsername > 0
                                    ? `，${result.diagnostics.videoDetail.missingFinderUsername} 条缺少 finderUsername`
                                    : ""}
                                  {result.diagnostics.videoDetail.missingChannelId > 0
                                    ? `，${result.diagnostics.videoDetail.missingChannelId} 条也没有可转换的视频号 ID`
                                    : ""}
                                </div>
                              )}
                              {result.diagnostics.channelIdLookup.requested > 0 && (
                                <div className="mt-1">
                                  视频号 ID 转换：成功 {result.diagnostics.channelIdLookup.resolved}/{result.diagnostics.channelIdLookup.requested}
                                  {result.diagnostics.channelIdLookup.missingFinderUsername > 0
                                    ? `，${result.diagnostics.channelIdLookup.missingFinderUsername} 条未返回 finderUsername`
                                    : ""}
                                </div>
                              )}
                              {result.diagnostics.errors.map((item, index) => (
                                <div key={`${item.stage}-${index}`} className="mt-1 text-red-500">
                                  {item.stage}失败：{item.message}
                                </div>
                              ))}
                            </div>
                          )}
                          {result.error && (
                            <div className="mt-2 text-xs text-red-500">{result.error}</div>
                          )}
                          {result.candidates.length === 0 ? (
                            <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
                              {result.diagnostics?.outcome === "upstream_error"
                                ? "账号搜索未完成，请查看上游失败阶段后重试"
                                : "上游未返回可用账号标识，请根据上述字段情况更换名称或稍后重试"}
                            </div>
                          ) : (
                            <div className="mt-3 space-y-2">
                              {result.candidates.map(candidate => {
                                const isSelected = confirmed?.finderUsername === candidate.finderUsername;
                                return (
                                  <div
                                    key={`${result.inputName}-${candidate.finderUsername}`}
                                    className={`rounded-lg border px-3 py-3 ${
                                      isSelected ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-slate-50"
                                    }`}
                                  >
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                                          {candidate.displayName || result.inputName}
                                          {isSelected && <CheckCircle2 className="h-4 w-4 text-blue-600" />}
                                        </div>
                                        <div className="mt-1 break-all text-xs text-slate-500">{candidate.finderUsername}</div>
                                        {candidate.signature && (
                                          <div className="mt-1 text-xs text-slate-600">{candidate.signature}</div>
                                        )}
                                        {candidate.sampleVideos && candidate.sampleVideos.length > 0 && (
                                          <div className="mt-2 text-xs text-slate-500">
                                            样例作品：{candidate.sampleVideos.join(" / ")}
                                          </div>
                                        )}
                                      </div>
                                      <Button
                                        type="button"
                                        size="sm"
                                        onClick={() => confirmWechatCandidate(result.inputName, candidate)}
                                        className={isSelected ? "bg-slate-700 hover:bg-slate-800 text-white" : "bg-blue-600 hover:bg-blue-700 text-white"}
                                      >
                                        {isSelected ? "已选择" : "选择账号"}
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {tikhubResults.length > 0 && (
                  <div className="space-y-3">
                    {tikhubResults.map((item, index) => (
                      <div key={`${item.url || item.inputName || index}-${index}`} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <div className="text-xs text-slate-500">{item.url || item.inputName}</div>
                        {item.error ? (
                          <div className="mt-2 text-sm text-red-600">{item.error}</div>
                        ) : (
                          <div className="mt-2 space-y-3 text-sm text-slate-700">
                            <div className="space-y-1">
                              <div>作者：{item.authorName || "未知"}</div>
                              {sourcePlatform === "wechat_channels" ? (
                                <div>finderUsername：{item.finderUsername || "未获取"}</div>
                              ) : (
                                <div>sec_user_id：{item.secUserId || "未获取"}</div>
                              )}
                              <div>作品数量：{item.videosCount ?? 0}</div>
                              {item.recentDays && (
                                <div className="text-xs text-slate-500">
                                  已拉取 {item.rawVideosCount ?? item.videosCount ?? 0} 条原始作品，
                                  近 {item.recentDays ?? 7} 天命中 {item.videosCount ?? 0} 条，
                                  翻页 {item.pageCount ?? 1} 次
                                  {item.hasMore ? "，可能仍有下一页" : "，已停止翻页"}
                                  {item.stopReason ? `（${item.stopReason}）` : ""}
                                </div>
                              )}
                              {item.incompleteReason && (
                                <div className="text-xs text-amber-600">{item.incompleteReason}</div>
                              )}
                              {item.backgroundError && (
                                <div className="text-xs text-amber-600">旧作品：{item.backgroundError}</div>
                              )}
                            </div>
                            {item.secUserResponse && (
                              <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                                <summary className="cursor-pointer text-xs font-semibold text-slate-600">sec_user_id 接口返回</summary>
                                <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-slate-600">
                                  {JSON.stringify(item.secUserResponse, null, 2)}
                                </pre>
                              </details>
                            )}
                            {item.videosResponse && (
                              <LazyVideosResponseDetails response={item.videosResponse} />
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-white border-slate-200 shadow-sm">
              <CardHeader className="pb-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Target className="w-5 h-5 text-blue-600" />
                    <CardTitle className="text-lg font-medium text-slate-900">今日选题</CardTitle>
                    <Badge className="bg-blue-100 text-blue-700 ml-2">
                      已合并推荐 + 全部
                    </Badge>
                  </div>
                  <div className="text-xs text-slate-500 flex items-center gap-2">
                    <TrendingUp className="w-3.5 h-3.5" />
                    共 {topicsWithContent.length} 个选题
                    {/* 筛选口径必须写出来，否则"少了很多条"看着像 bug。 */}
                    <span className="text-slate-400">（已筛选：点赞 ≥ {minLikes}）</span>
                  </div>
                </div>
                {/* 脚本 + 标签的进度 / 结果 / 失败原因：都如实写出来。
                    近 7 天会提取完整脚本（供二创直接复用），更长的窗口只筛点赞 + 打标签。 */}
                {(topicAnalysis.status !== "idle" || topicAnalysis.error) && (
                  <div className={`mt-4 rounded-lg border px-3 py-2 text-xs leading-5 ${
                    topicAnalysis.status === "error" || topicAnalysis.status === "no-library"
                      ? "border-amber-200 bg-amber-50 text-amber-800"
                      : "border-slate-200 bg-slate-50 text-slate-600"
                  }`}>
                    {topicAnalysis.error
                      ? `脚本 / 标签分析失败：${topicAnalysis.error}（列表与点赞筛选仍然可用）`
                      : topicAnalysis.message || "正在准备脚本与标签…"}
                    {topicAnalysis.status === "done" && !shouldExtractTranscripts(topicDays) && (
                      <span className="text-slate-400">　超过 7 天的时间范围不提取脚本，只做点赞筛选与标签判定。</span>
                    )}
                  </div>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {reviewMemory && <div className="flex w-full flex-wrap items-center gap-3 rounded-xl bg-blue-50 p-3 text-xs text-blue-800">
                    <span>已确认的复盘配比 · {reviewMemory.period.start}～{reviewMemory.period.end} · 计划 {reviewMemory.nextWeekCount} 条</span>
                    <Button size="sm" variant="outline" disabled={!topicsWithContent.some(topic => topic.content?.categoryName)} onClick={() => {
                      const selection = selectTopicsByWeeklyPlan(topicsWithContent, reviewMemory.plan);
                      setSelectedTopics(selection.ids);
                      setReviewSelectionMessage(`已勾选 ${selection.ids.length} 条。${selection.shortages.length ? selection.shortages.join('；') : '各类配额已满足。'}`);
                    }}>按复盘配比勾选</Button>
                    {(reviewMemory.notes || reviewMemory.experience?.summary || reviewMemory.experience?.actions?.length > 0) && <details className="w-full">
                      <summary className="cursor-pointer">查看经理确认的复盘经验</summary>
                      {reviewMemory.notes && <p className="mt-2 whitespace-pre-wrap">{reviewMemory.notes}</p>}
                      {reviewMemory.experience?.summary && <p className="mt-2">{reviewMemory.experience.summary}</p>}
                      {reviewMemory.experience?.actions?.map((action, index) => <p key={index} className="mt-1">· {action}</p>)}
                    </details>}
                    {reviewSelectionMessage && <p className="w-full">{reviewSelectionMessage}</p>}
                  </div>}
                  {reviewMemoryError && <p className="w-full text-xs text-amber-700">{reviewMemoryError}</p>}
                  <span className="text-xs text-slate-500">排序依据</span>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { key: "comments", label: "按评论" },
                      { key: "likes", label: "按点赞" },
                      { key: "shares", label: "按转发" },
                      { key: "bookmarks", label: "按收藏" }
                    ].map(option => (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => setSortKey(option.key as "comments" | "likes" | "shares" | "bookmarks")}
                        className={`rounded-full border px-3 py-1 text-xs transition ${
                          sortKey === option.key
                            ? "border-blue-500 bg-blue-50 text-blue-700"
                            : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {sortedTopicGroups.map(group => {
                  const expanded = group.index === 0 || expandedTopicGroups.includes(group.index);
                  const isOlderGroup = group.index > 0;
                  return (
                  <section key={group.index} className="rounded-xl border border-slate-200 bg-white">
                    <button
                      type="button"
                      onClick={() => {
                        if (!isOlderGroup) return;
                        setExpandedTopicGroups(previous => previous.includes(group.index)
                          ? previous.filter(index => index !== group.index)
                          : [...previous, group.index]);
                      }}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left ${isOlderGroup ? "cursor-pointer" : "cursor-default"}`}
                    >
                      <span className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        {isOlderGroup && (expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)}
                        {group.label}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-slate-500">
                        {isOlderGroup && olderTopicsLoading && <LoaderCircle className="h-4 w-4 animate-spin text-blue-500" />}
                        {group.topics.length} 条
                      </span>
                    </button>
                    {expanded && (
                    <div className="space-y-3 border-t border-slate-100 p-3">
                      {olderTopicsLoading && group.topics.length === 0 && (
                        <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-500">
                          <LoaderCircle className="h-5 w-5 animate-spin text-blue-500" />
                          正在获取这一时间段的作品…
                        </div>
                      )}
                      {group.index === 0 && olderTopicsError && (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                          <span>{olderTopicsError}</span>
                          {hasRetryableTopicJobs && (
                            <Button type="button" size="sm" variant="outline" onClick={retryOlderTopics} disabled={olderTopicsLoading}>
                              重试
                            </Button>
                          )}
                        </div>
                      )}
                      {group.topics.length === 0 && !olderTopicsLoading && !olderTopicsError && (
                        <div className="py-5 text-center text-sm text-slate-400">这一时间段暂无作品</div>
                      )}
                      {group.topics.map(topic => {
                        const isSelected = selectedTopicIdSet.has(topic.id);
                        return (
                        <LazyTopicCard key={topic.id}>
                          <div
                            className={`rounded-lg border transition-all ${
                              isSelected
                                ? "bg-blue-50 border-blue-300"
                                : "bg-slate-50 border-slate-200 hover:border-slate-300"
                            }`}
                          >
                            <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-4">
                              <div className="flex items-start gap-3">
                                <Checkbox
                                  id={topic.id}
                                  checked={isSelected}
                                  onCheckedChange={() => handleTopicToggle(topic.id)}
                                  className="mt-1"
                                />
                                <label htmlFor={topic.id} className="cursor-pointer">
                                  <div className="text-base font-medium text-slate-900 mb-2">
                                    {topic.title}
                                  </div>
                                  <div className="flex flex-wrap gap-2 mb-3">
                                    <Badge variant="secondary" className="bg-white text-slate-600 border-slate-200 text-xs">
                                      {topic.platform === "wechat_channels" ? "视频号" : topic.platform === "tiktok" ? "TikTok" : "抖音"}
                                    </Badge>
                                    <Badge variant="secondary" className="bg-white text-slate-600 border-slate-200 text-xs">
                                      作者：{topic.authorName || "未知"}
                                    </Badge>
                                    <Badge variant="secondary" className="bg-white text-slate-600 border-slate-200 text-xs">
                                      发布：{topic.publishDate || "未知"}
                                    </Badge>
                                    <Badge variant="secondary" className="bg-white text-slate-600 border-slate-200 text-xs">
                                      大家都在搜：{topic.hotTopics && topic.hotTopics.length > 0 ? topic.hotTopics.join(" / ") : "暂无推荐热词"}
                                    </Badge>
                                    {topic.tags.length > 0 && topic.tags.map(tag => (
                                      <Badge
                                        key={tag}
                                        variant="secondary"
                                        className="bg-white text-slate-600 border-slate-200 text-xs"
                                      >
                                        {tag}
                                      </Badge>
                                    ))}
                                    {/* 库内大类/小类标签：只认选题库里真实存在的分类，
                                        「待人工复核」单独用琥珀色标出（2026-09-21）。 */}
                                    {topic.content?.categoryName && (
                                      <Badge
                                        variant="secondary"
                                        className={topic.content.categoryId === "review"
                                          ? "bg-amber-50 text-amber-700 border-amber-200 text-xs"
                                          : "bg-blue-50 text-blue-700 border-blue-200 text-xs"}
                                      >
                                        {topic.content.categoryName}
                                      </Badge>
                                    )}
                                    {topic.content?.subcategoryName && topic.content.categoryId !== "review" && (
                                      <Badge variant="secondary" className="bg-slate-100 text-slate-600 border-slate-200 text-xs">
                                        {topic.content.subcategoryName}
                                      </Badge>
                                    )}
                                  </div>
                                  {/* 脚本：默认收起，展开就能看到二创要用的原文。
                                      ⚠️ 这里刻意**不标**「已提取脚本」徽章、也不在入口上写
                                      「（真实转写）/（发布文案）」：卡片上已经有大类/小类标签，
                                      再加一行状态徽章会把这一行挤散。来源差异不丢 —— 展开后的
                                      正文里有「脚本来源」一行（见下）。 */}
                                  {topic.content?.script && (
                                    <details className="mb-2">
                                      <summary className="cursor-pointer text-xs font-medium text-blue-600 hover:text-blue-700">
                                        查看脚本
                                      </summary>
                                      <div className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                                        {/* 来源仍然如实说明，只是从入口挪进正文：需要判断可信度的人
                                            展开就能看到，不需要的人不会被它打扰。 */}
                                        <div className="mb-1.5 text-[11px] text-slate-400">
                                          脚本来源：{topic.content.scriptSource === "transcript" ? "真实转写" : "发布文案"}
                                        </div>
                                        <div className="whitespace-pre-wrap text-xs leading-6 text-slate-700">
                                          {topic.content.script}
                                        </div>
                                      </div>
                                    </details>
                                  )}
                                </label>
                              </div>
                              <div className="flex flex-1 flex-col gap-2 sm:items-end sm:text-right">
                                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
                                  <div className="flex items-center gap-1">
                                    <MessageCircle className="w-3.5 h-3.5" />
                                    <span>{formatNumber(topic.stats.comments)}</span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <ThumbsUp className="w-3.5 h-3.5" />
                                    <span>{formatNumber(topic.stats.likes)}</span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <Share2 className="w-3.5 h-3.5" />
                                    <span>{formatNumber(topic.stats.shares)}</span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <Bookmark className="w-3.5 h-3.5" />
                                    <span>{formatNumber(topic.stats.bookmarks)}</span>
                                  </div>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 px-3 h-8 sm:-mr-2"
                                  disabled={topicLinkLoadingId === topic.id || (!topic.link && (wechatShareLinksLoading || topic.platform !== "wechat_channels"))}
                                  onClick={() => {
                                    if (topic.link) {
                                      window.open(topic.link, "_blank");
                                      return;
                                    }
                                    if (topic.platform === "wechat_channels") {
                                      generateWechatShareLink(topic);
                                    }
                                  }}
                                >
                                  {topicLinkLoadingId === topic.id
                                    ? "生成中..."
                                    : topic.link
                                      ? "查看链接"
                                      : topic.platform === "wechat_channels"
                                        ? "生成链接"
                                        : "暂无链接"}
                                  <ExternalLink className="ml-1 w-3.5 h-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        </LazyTopicCard>
                        );
                      })}
                    </div>
                    )}
                  </section>
                  );
                })}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Bottom Action Bar */}
      <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-200/80 bg-white/90 px-5 py-3.5 backdrop-blur sm:px-8 lg:px-10">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-slate-600">
            已选选题：
            <span className="ml-2 font-semibold text-slate-950">
              {selectedTopics.length} 个
            </span>
          </div>
          <Button
            onClick={handleSubmit}
            disabled={selectedTopics.length === 0}
            className="h-10 rounded-xl bg-blue-600 px-6 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
          >
            发送（下一步）
          </Button>
        </div>
      </div>
    </div>
  );
}
