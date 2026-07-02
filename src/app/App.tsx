import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { apiUrl, fetchWithRetry, parseApiJson } from "./api";
import {
  type CarouselApi,
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "./components/ui/carousel";
import { Target, TrendingUp, MessageCircle, ThumbsUp, Share2, Bookmark, ExternalLink, User, CalendarDays, Phone, Layers, Sparkles } from "lucide-react";

interface Topic {
  id: string;
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
  rawData?: unknown;
}

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
  const [tikhubInput, setTikhubInput] = useState(() => sessionStorage.getItem("tikhubInput") || "");
  const [tikhubLoading, setTikhubLoading] = useState(false);
  const [tikhubError, setTikhubError] = useState<string | null>(null);
  const [tikhubResults, setTikhubResults] = useState<Array<{
    url: string;
    secUserId?: string;
    authorName?: string;
    videosCount?: number;
    secUserResponse?: unknown;
    videosResponse?: unknown;
    error?: string | null;
  }>>(() => {
    try {
      const raw = sessionStorage.getItem("tikhubResults");
      return raw ? (JSON.parse(raw) as Array<{ url: string; secUserId?: string; authorName?: string; videosCount?: number; secUserResponse?: unknown; videosResponse?: unknown; error?: string | null; }>) : [];
    } catch {
      return [];
    }
  });

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
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

    return tikhubResults.flatMap(result => {
      if (result.error || !result.videosResponse) return [];
      const dataBlock = (result.videosResponse as any)?.data;
      const videosList = Array.isArray(dataBlock)
        ? dataBlock
        : Array.isArray(dataBlock?.aweme_list)
          ? dataBlock.aweme_list
          : [];

      return videosList
        .map((video: any) => {
          const createdAt = typeof video?.create_time === "number" ? video.create_time * 1000 : null;
          if (!createdAt || now - createdAt > sevenDaysMs) {
            return null;
          }

          const stats = video?.statistics || {};
          const id = String(video?.aweme_id || video?.awemeId || Math.random());
          const title = video?.desc || "未命名视频";
          const authorName = video?.author?.nickname || result.authorName || "未知";
          const publishDate = createdAt ? new Date(createdAt).toISOString().slice(0, 10) : undefined;
          const link = video?.share_url || `https://www.douyin.com/video/${id}`;
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
  }, [tikhubResults]);

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

  const runTikhubFetch = async () => {
    const rawLinks = tikhubInput
      .split("\n")
      .map(link => link.trim())
      .filter(Boolean);

    if (rawLinks.length === 0) {
      setTikhubError("请输入抖音博主主页分享链接（每行一个）");
      return;
    }

    setTikhubLoading(true);
    setTikhubError(null);

    try {
      const response = await fetchWithRetry(apiUrl("/api/tikhub/batch"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ urls: rawLinks }),
      });

      const data = await parseApiJson(response);
      if (!response.ok) {
        throw new Error(data?.error || "请求失败");
      }

      const results = Array.isArray(data?.results) ? data.results : [];
      setTikhubResults(results);
      sessionStorage.setItem("tikhubResults", JSON.stringify(results));
      sessionStorage.setItem("tikhubInput", tikhubInput);
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败";
      setTikhubError(message);
    } finally {
      setTikhubLoading(false);
    }
  };

  const taskCount = tasks.length;
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
                    <CardTitle className="text-lg font-medium text-slate-900">批量获取主页作品数据</CardTitle>
                  </div>
                  <div className="text-xs text-slate-500 flex items-center gap-2">
                    <TrendingUp className="w-3.5 h-3.5" />
                    {tikhubLoading ? "请求中" : "每行一个主页链接"}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="text-xs font-semibold text-slate-600">抖音博主主页分享链接（多行）</div>
                  <textarea
                    value={tikhubInput}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setTikhubInput(nextValue);
                      sessionStorage.setItem("tikhubInput", nextValue);
                    }}
                    placeholder="每行一个主页链接"
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
                    {tikhubLoading ? "获取中..." : "开始获取"}
                  </Button>
                </div>

                {tikhubResults.length > 0 && (
                  <div className="space-y-3">
                    {tikhubResults.map((item, index) => (
                      <div key={`${item.url}-${index}`} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                        <div className="text-xs text-slate-500">{item.url}</div>
                        {item.error ? (
                          <div className="mt-2 text-sm text-red-600">{item.error}</div>
                        ) : (
                          <div className="mt-2 space-y-3 text-sm text-slate-700">
                            <div className="space-y-1">
                              <div>作者：{item.authorName || "未知"}</div>
                              <div>sec_user_id：{item.secUserId || "未获取"}</div>
                              <div>作品数量：{item.videosCount ?? 0}</div>
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
                              <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                                <summary className="cursor-pointer text-xs font-semibold text-slate-600">主页作品接口返回</summary>
                                <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-slate-600">
                                  {JSON.stringify(item.videosResponse, null, 2)}
                                </pre>
                              </details>
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
                {tikhubTopics
                  .sort((a, b) => b.stats[sortKey] - a.stats[sortKey])
                  .map(topic => (
                  <div
                    key={topic.id}
                    className={`rounded-lg border transition-all ${
                      selectedTopics.includes(topic.id)
                        ? "bg-indigo-50 border-indigo-300"
                        : "bg-slate-50 border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-4">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          id={topic.id}
                          checked={selectedTopics.includes(topic.id)}
                          onCheckedChange={() => handleTopicToggle(topic.id)}
                          className="mt-1"
                        />
                        <label htmlFor={topic.id} className="cursor-pointer">
                          <div className="text-base font-medium text-slate-900 mb-2">
                            {topic.title}
                          </div>
                          <div className="flex flex-wrap gap-2 mb-3">
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
                          onClick={() => window.open(topic.link, '_blank')}
                        >
                          查看链接
                          <ExternalLink className="ml-1 w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
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
