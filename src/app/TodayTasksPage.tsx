import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ClipboardList,
  Layers3,
  LoaderCircle,
  Sparkles,
  UserRound,
} from "lucide-react";
import { apiUrl } from "./api";

type TaskStatus = "pending" | "in_progress" | "completed";

type TodayTask = {
  _id: string;
  customerName: string;
  customerOccupation?: string;
  contact?: string;
  ownerName?: string;
  platformName?: string;
  collaborationPeriod?: { start?: string; end?: string };
  notes?: string;
  ipPositioning?: string;
  contentDirection?: string;
  benchmarkAccounts?: string;
  contentRequirements?: string[];
  priority?: "low" | "medium" | "high";
  status?: TaskStatus;
};

const toDate = (offset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const previewTasks: TodayTask[] = [
  {
    _id: "preview-fashion-founder",
    customerName: "冯总",
    customerOccupation: "羊毛衫品牌创始人",
    ownerName: "蓬辰",
    platformName: "视频号",
    collaborationPeriod: { start: toDate(), end: toDate(1) },
    ipPositioning: "用经营者视角，讲清羊毛衫的品质与穿搭价值",
    contentDirection: "视频号创作 · 品牌故事与秋冬穿搭",
    contentRequirements: ["围绕品牌创始人的真实经历", "兼顾专业感与生活化表达"],
    benchmarkAccounts: "https://www.douyin.com/user/example-a",
    priority: "medium",
  },
  {
    _id: "preview-labor-lawyer",
    customerName: "夏律",
    customerOccupation: "劳动法律师",
    ownerName: "蓬辰",
    platformName: "视频号",
    collaborationPeriod: { start: toDate(), end: toDate(1) },
    ipPositioning: "面向企业客户，拆解劳动用工中的高频风险",
    contentDirection: "视频号创作 · 企业劳动用工避坑",
    contentRequirements: ["选题需要贴近日常管理场景", "结尾给出可执行的建议"],
    benchmarkAccounts: "https://www.douyin.com/user/example-b",
    priority: "high",
  },
  {
    _id: "preview-health-coach",
    customerName: "林教练",
    customerOccupation: "健康管理师",
    ownerName: "蓬辰",
    platformName: "抖音",
    collaborationPeriod: { start: toDate(), end: toDate(2) },
    ipPositioning: "把复杂的健康知识，变成普通人愿意跟练的习惯",
    contentDirection: "短视频创作 · 轻量化健康习惯",
    contentRequirements: ["内容节奏轻快", "适合通勤时间观看"],
    benchmarkAccounts: "https://www.douyin.com/user/example-c",
    priority: "low",
  },
];

const formatPeriod = (period?: TodayTask["collaborationPeriod"]) => {
  if (!period?.start || !period?.end) return "未设置任务周期";
  return `${String(period.start).slice(5, 10).replace("-", "/")} — ${String(period.end).slice(5, 10).replace("-", "/")}`;
};

const taskStatus = (task: TodayTask): TaskStatus => task.status || "pending";

export default function TodayTasksPage() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TodayTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingPreview, setUsingPreview] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlUserId = String(params.get("taskUserId") || "").trim();

    if (params.has("taskToken") || urlUserId || params.has("from") || params.has("todayTasks") || params.has("todayTaskCount")) {
      ["taskToken", "taskUserId", "todayTasks", "todayTaskCount", "from"].forEach(key => params.delete(key));
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }

    const loadTasks = async () => {
      try {
        let response: Response;
        if (urlUserId) {
          response = await fetch(apiUrl("/api/tasks/session"), {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskUserId: urlUserId }),
          });
        } else {
          response = await fetch(apiUrl("/api/tasks/today"), { credentials: "same-origin" });
        }

        const data = await response.json();
        if (!response.ok || !data?.success) throw new Error("任务服务不可用");
        setTasks(Array.isArray(data.data) ? data.data as TodayTask[] : []);
        setUsingPreview(false);
      } catch {
        setTasks(previewTasks);
        setUsingPreview(true);
      } finally {
        setLoading(false);
      }
    };

    void loadTasks();
  }, []);

  const counts = useMemo(() => ({
    pending: tasks.filter(task => taskStatus(task) === "pending").length,
    inProgress: tasks.filter(task => taskStatus(task) === "in_progress").length,
    completed: tasks.filter(task => taskStatus(task) === "completed").length,
  }), [tasks]);

  const openTask = (task: TodayTask) => {
    sessionStorage.setItem("contentTasks", JSON.stringify([task]));
    ["selectedTopics", "selectedTopicIds", "tikhubResults", "topicFetchContext", "contentAutoRunKey", "contentActiveGroupIndex", "sourcePlatform", "sourcePlatformUserLocked"].forEach(key => sessionStorage.removeItem(key));
    navigate("/topics");
  };

  const statCards = [
    { label: "待处理", count: counts.pending, icon: Clock3, tint: "bg-amber-50 text-amber-600", line: "border-amber-200" },
    { label: "进行中", count: counts.inProgress, icon: Sparkles, tint: "bg-sky-50 text-sky-600", line: "border-sky-200" },
    { label: "已完成", count: counts.completed, icon: CheckCircle2, tint: "bg-emerald-50 text-emerald-600", line: "border-emerald-200" },
  ];

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-900">
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[420px] overflow-hidden" aria-hidden="true">
        <div className="absolute -top-48 left-[14%] h-96 w-96 rounded-full bg-blue-200/30 blur-3xl" />
        <div className="absolute -right-20 top-0 h-80 w-80 rounded-full bg-violet-200/25 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-[1480px] px-5 py-6 sm:px-8 lg:px-12 lg:py-9">
        <header className="flex flex-col gap-5 border-b border-slate-200/80 pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600">
              <span className="h-2 w-2 rounded-full bg-blue-600" /> XIAOMANG AI · WORKSPACE
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">今日任务</h1>
            <p className="mt-2 text-sm text-slate-500">选择一个客户任务，开始生成今天值得做的选题。</p>
          </div>
          <div className="flex items-center gap-3 self-start rounded-2xl border border-white/80 bg-white/80 px-4 py-3 shadow-[0_8px_28px_rgba(30,41,59,0.06)] backdrop-blur sm:self-auto">
            <CalendarDays className="h-5 w-5 text-blue-600" />
            <div>
              <div className="text-xs text-slate-400">TODAY</div>
              <div className="text-sm font-semibold text-slate-700">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</div>
            </div>
          </div>
        </header>

        <section className="mt-7 grid gap-3 sm:grid-cols-3" aria-label="任务概览">
          {statCards.map(item => (
            <div key={item.label} className={`flex items-center gap-4 rounded-2xl border bg-white/90 px-5 py-4 shadow-[0_10px_30px_rgba(30,41,59,0.05)] ${item.line}`}>
              <div className={`grid h-11 w-11 place-items-center rounded-xl ${item.tint}`}><item.icon className="h-5 w-5" /></div>
              <div><div className="text-2xl font-semibold tracking-tight text-slate-900">{loading ? "—" : item.count}</div><div className="text-sm text-slate-500">{item.label}</div></div>
            </div>
          ))}
        </section>

        <section className="mt-8 overflow-hidden rounded-[28px] border border-slate-200/90 bg-white shadow-[0_20px_60px_rgba(31,41,55,0.08)]">
          <div className="flex flex-col gap-4 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
            <div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-slate-950 text-white"><ClipboardList className="h-4 w-4" /></div><div><h2 className="font-semibold text-slate-900">待处理任务</h2><p className="text-xs text-slate-500">点击任务卡，进入选题生成</p></div></div>
            {usingPreview && <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-500">当前展示为示例任务</span>}
          </div>

          {loading ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-sm text-slate-500"><LoaderCircle className="h-6 w-6 animate-spin text-blue-600" />正在同步今日任务…</div>
          ) : tasks.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-5 text-center"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400"><ClipboardList className="h-6 w-6" /></div><div className="font-medium text-slate-700">今天还没有待处理任务</div><p className="max-w-sm text-sm text-slate-500">任务中心同步后，新任务会出现在这里。</p></div>
          ) : (
            <div className="divide-y divide-slate-100">
              {tasks.map((task, index) => {
                const requirements = (task.contentRequirements || []).filter(Boolean);
                const priority = task.priority === "high" ? { label: "高", className: "bg-rose-50 text-rose-600" } : task.priority === "low" ? { label: "低", className: "bg-slate-100 text-slate-500" } : { label: "中", className: "bg-amber-50 text-amber-600" };
                return (
                  <button key={task._id || index} type="button" onClick={() => openTask(task)} className="group grid w-full gap-5 px-5 py-6 text-left transition hover:bg-[#f8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 sm:grid-cols-[minmax(0,1.65fr)_minmax(145px,.7fr)_minmax(160px,.75fr)_auto] sm:items-center sm:px-7">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><span className="text-[11px] font-semibold tracking-[0.14em] text-slate-400">TASK {String(index + 1).padStart(2, "0")}</span><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${priority.className}`}>{priority.label}优先级</span></div>
                      <h3 className="mt-2 text-lg font-semibold text-slate-900 group-hover:text-blue-700">{task.customerName || "未命名客户"}<span className="ml-2 text-sm font-normal text-slate-400">{task.customerOccupation || "内容创作任务"}</span></h3>
                      <p className="mt-1.5 max-w-2xl truncate text-sm text-slate-500">{task.contentDirection || task.ipPositioning || "补充任务信息后即可生成对应选题"}</p>
                      {requirements.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{requirements.slice(0, 2).map((item, itemIndex) => <span key={itemIndex} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500">{item}</span>)}</div>}
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-600"><UserRound className="h-4 w-4 text-slate-400" />{task.ownerName || "待分配"}</div>
                    <div className="flex items-center gap-2 text-sm text-slate-600"><Layers3 className="h-4 w-4 text-slate-400" /><div><div>{task.platformName || "内容平台待定"}</div><div className="mt-0.5 text-xs text-slate-400">{formatPeriod(task.collaborationPeriod)}</div></div></div>
                    <div className="flex items-center justify-between gap-4 sm:justify-end"><span className="text-sm font-medium text-blue-600">开始选题</span><span className="grid h-9 w-9 place-items-center rounded-full border border-slate-200 text-slate-400 transition group-hover:border-blue-600 group-hover:bg-blue-600 group-hover:text-white"><ArrowUpRight className="h-4 w-4" /></span></div>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
