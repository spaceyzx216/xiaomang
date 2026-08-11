import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { apiUrl, fetchWithRetry, parseApiJson } from "./api";
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
  raw?: unknown;
};

type WeChatAccountSearchResult = {
  inputName: string;
  candidates: WeChatAccountCandidate[];
  error?: string | null;
};

type TaskItem = {
  _id: string;
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

const TASK_AUTH_TOKEN_KEY = "kk_task_token";
const TASK_USER_ID_KEY = "kk_task_user_id";
const WECHAT_CHANNELS_ACCOUNT_CACHE_KEY = "wechatChannelsAccountCache";
const TOPIC_FETCH_CONTEXT_KEY = "topicFetchContext";

const base64UrlToUtf8 = (input: string) => {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return decodeURIComponent(
    Array.from(atob(padded))
      .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("")
  );
};

function parseTodayTasksFromUrl(params: URLSearchParams): TaskItem[] {
  const payloadRaw = String(params.get("todayTasks") || "").trim();
  if (!payloadRaw) return [];

  try {
    const decoded = base64UrlToUtf8(payloadRaw);
    const parsed = JSON.parse(decoded);
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    return tasks as TaskItem[];
  } catch (error) {
    console.warn("todayTasks 参数解析失败:", error);
    return [];
  }
}

function getTaskAuthContext() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = String(params.get("taskToken") || "").trim();
  const urlUserId = String(params.get("taskUserId") || "").trim();
  const urlTodayTasks = parseTodayTasksFromUrl(params);

  const storedToken = String(localStorage.getItem(TASK_AUTH_TOKEN_KEY) || "").trim();
  const storedUserId = String(localStorage.getItem(TASK_USER_ID_KEY) || "").trim();

  const token = urlToken || storedToken;
  const userId = urlUserId || storedUserId;

  if (urlToken) localStorage.setItem(TASK_AUTH_TOKEN_KEY, urlToken);
  if (urlUserId) localStorage.setItem(TASK_USER_ID_KEY, urlUserId);

  if (urlToken || urlUserId || params.has("from") || params.has("todayTasks") || params.has("todayTaskCount")) {
    params.delete("taskToken");
    params.delete("taskUserId");
    params.delete("todayTasks");
    params.delete("todayTaskCount");
    params.delete("from");

    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }

  return { token, userId, urlTodayTasks };
}

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
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeWeChatAccountCache = (cache: Record<string, WeChatAccountCandidate>) => {
  localStorage.setItem(WECHAT_CHANNELS_ACCOUNT_CACHE_KEY, JSON.stringify(cache));
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
      const params = new URLSearchParams(window.location.search);
      const fromUrl = parseTodayTasksFromUrl(params);
      if (fromUrl.length > 0) {
        sessionStorage.setItem("contentTasks", JSON.stringify(fromUrl));
        return fromUrl;
      }

      const raw = sessionStorage.getItem("contentTasks");
      return raw ? (JSON.parse(raw) as TaskItem[]) : [];
    } catch {
      return [];
    }
  });
  const [taskLoading, setTaskLoading] = useState(tasks.length === 0);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskIndex, setTaskIndex] = useState(0);
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
  const [olderTopicsLoading, setOlderTopicsLoading] = useState(false);
  const [olderTopicsError, setOlderTopicsError] = useState<string | null>(null);
  const [expandedTopicGroups, setExpandedTopicGroups] = useState<number[]>([0]);
  const topicFetchGeneration = useRef(0);
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

  const topicGroups = useMemo(
    () => groupTopicsByWeek(tikhubTopics, topicDays),
    [tikhubTopics, topicDays],
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
        const { token, urlTodayTasks } = getTaskAuthContext();

        if (Array.isArray(urlTodayTasks) && urlTodayTasks.length > 0) {
          setTasks(urlTodayTasks);
          sessionStorage.setItem("contentTasks", JSON.stringify(urlTodayTasks));
          setTaskIndex(0);
          return;
        }

        if (!token) {
          throw new Error("未检测到登录态，请从 KKClaw 登录后再打开工作站");
        }

        const response = await fetch("http://127.0.0.1:18891/api/tasks/today", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        const data = await response.json();
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
    const limits = topicRequestLimits(days);
    const response = await fetchWithRetry(apiUrl("/api/platform/topics/batch"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "wechat_channels",
        accounts: [{ ...target, resume }],
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

    setTikhubLoading(true);
    setTikhubError(null);

    try {
      if (sourcePlatform === "wechat_channels") {
        const missingNames = rawItems.filter(name => !confirmedWechatAccounts[name]);
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
          } else {
            setTikhubError("没有搜索到可确认的视频号账号，可换一个更完整的账号名称。");
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
    const accounts = names
      .map(name => confirmedWechatAccounts[name])
      .filter(Boolean)
      .map(candidate => ({
        inputName: candidate.inputName,
        displayName: candidate.displayName,
        finderUsername: candidate.finderUsername,
      }));

    if (accounts.length === 0) {
      setTikhubError("请先搜索并确认视频号账号。");
      return;
    }
    const missingNames = names.filter(name => !confirmedWechatAccounts[name]);
    if (missingNames.length > 0) {
      setTikhubError(`还有账号未确认：${missingNames.join("、")}`);
      return;
    }

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
  const activeTask = useMemo(() => tasks[taskIndex], [tasks, taskIndex]);

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

  const handleSubmit = () => {
    const selectedData = tikhubTopics.filter(topic => selectedTopics.includes(topic.id));
    sessionStorage.setItem("selectedTopics", JSON.stringify(selectedData));
    sessionStorage.setItem("contentTasks", JSON.stringify(tasks));
    sessionStorage.setItem("selectedTopicIds", JSON.stringify(selectedTopics));
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
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-8 py-6">
        <h1 className="text-2xl font-semibold text-slate-900">选题生成与选择</h1>
        <p className="text-sm text-slate-500 mt-1">
          已导入客户信息与内容需求，系统自动生成运营选题
        </p>
      </header>

      {/* Main Content */}
      <div className="p-8 max-w-[1600px] mx-auto">
        <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-6">
          {/* Left Panel - Decision Support Area */}
          <div className="space-y-6">
            <Card className="bg-white border-slate-200 shadow-sm overflow-hidden">
              <CardHeader className="pb-3 border-b border-slate-100 bg-gradient-to-r from-indigo-50 via-white to-white">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold text-slate-900">客户信息 & 内容需求</CardTitle>
                    <p className="text-xs text-slate-500 mt-1">一个任务对应一个展示面板，左右滑动切换</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="bg-indigo-100 text-indigo-700 border-indigo-200">
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
                                  <div className="mt-2 text-lg font-semibold text-slate-900">
                                    {task.customerName || "未命名客户"}
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
                                    <Sparkles className="h-4 w-4 text-indigo-500" />
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
                                          <span className="mt-0.5 h-2 w-2 rounded-full bg-indigo-400" />
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
                    <Target className="w-5 h-5 text-indigo-600" />
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
                          ? "border-indigo-500 bg-indigo-50 text-indigo-700"
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
                              ? "border-indigo-500 bg-indigo-50 text-indigo-700"
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
                      className="ml-2 h-8 w-20 rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                    />
                  </label>
                  {topicDaysError && <div className="w-full text-xs text-red-500">{topicDaysError}</div>}
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
                    }}
                    placeholder={sourcePlatform === "wechat_channels" ? "每行一个账号名称，例如：人民日报" : sourcePlatform === "tiktok" ? "每行一个 TikTok 主页，例如：https://www.tiktok.com/@username" : "每行一个主页链接"}
                    className="mt-2 h-32 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 outline-none focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                  />
                  {tikhubError && (
                    <div className="mt-2 text-xs text-red-500">{tikhubError}</div>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <Button
                    onClick={runTikhubFetch}
                    disabled={tikhubLoading}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
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
                          {result.error ? (
                            <div className="mt-2 text-xs text-red-500">{result.error}</div>
                          ) : result.candidates.length === 0 ? (
                            <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
                              未找到候选账号
                            </div>
                          ) : (
                            <div className="mt-3 space-y-2">
                              {result.candidates.map(candidate => {
                                const isSelected = confirmed?.finderUsername === candidate.finderUsername;
                                return (
                                  <div
                                    key={`${result.inputName}-${candidate.finderUsername}`}
                                    className={`rounded-lg border px-3 py-3 ${
                                      isSelected ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-slate-50"
                                    }`}
                                  >
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2 text-sm font-medium text-slate-900">
                                          {candidate.displayName || result.inputName}
                                          {isSelected && <CheckCircle2 className="h-4 w-4 text-indigo-600" />}
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
                                        className={isSelected ? "bg-slate-700 hover:bg-slate-800 text-white" : "bg-indigo-600 hover:bg-indigo-700 text-white"}
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
                    <Target className="w-5 h-5 text-indigo-600" />
                    <CardTitle className="text-lg font-medium text-slate-900">今日选题</CardTitle>
                    <Badge className="bg-indigo-100 text-indigo-700 ml-2">
                      已合并推荐 + 全部
                    </Badge>
                  </div>
                  <div className="text-xs text-slate-500 flex items-center gap-2">
                    <TrendingUp className="w-3.5 h-3.5" />
                    共 {tikhubTopics.length} 个选题
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
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
                            ? "border-indigo-500 bg-indigo-50 text-indigo-700"
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
                        {isOlderGroup && olderTopicsLoading && <LoaderCircle className="h-4 w-4 animate-spin text-indigo-500" />}
                        {group.topics.length} 条
                      </span>
                    </button>
                    {expanded && (
                    <div className="space-y-3 border-t border-slate-100 p-3">
                      {olderTopicsLoading && group.topics.length === 0 && (
                        <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-500">
                          <LoaderCircle className="h-5 w-5 animate-spin text-indigo-500" />
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
                                ? "bg-indigo-50 border-indigo-300"
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
                                  </div>
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
                                  className="text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 px-3 h-8 sm:-mr-2"
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
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-6 py-4">
        <div className="max-w-[1600px] mx-auto flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-slate-600">
            已选选题：
            <span className="ml-2 font-semibold text-slate-900">
              {selectedTopics.length} 个
            </span>
          </div>
          <Button
            onClick={handleSubmit}
            disabled={selectedTopics.length === 0}
            className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            发送（下一步）
          </Button>
        </div>
      </div>
    </div>
  );
}
