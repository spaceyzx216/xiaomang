import { useEffect, useState } from "react";
import { ArrowUpRight, BriefcaseBusiness, Layers3, PlayCircle, UsersRound, ClipboardList, Loader2, TriangleAlert } from "lucide-react";
import { useNavigate } from "react-router";
import { useAuth } from "./auth";
import { POSITIONING_MODULES } from "./accountPositioningModules";
import { taskAPI, customerAPI } from "../manager/services/api";

// 账号定位只暴露一个入口，这里列出它的三个模块。模块清单从 accountPositioningModules.ts
// 读，不再在这里另写一份平级列表 —— 之前两处各写一遍，2.3 上线时要记得同时改两处。
// 这个页面读不到账号定位页的阶段草稿，所以只按清单里的 available 报「能不能跑」，
// 不谎报「已完成」。
const moduleReadiness = (module: (typeof POSITIONING_MODULES)[number]) => {
  if (!module.available) return "待实现";
  if (module.steps.length === 0) return "可执行";
  const ready = module.steps.filter(step => step.available).length;
  return ready === module.steps.length ? "可执行" : `${ready}/${module.steps.length} 可执行`;
};

/**
 * 工作台的去处清单 —— 全页唯一一份。
 *
 * 2026-09-23：原来这里是「两张不可点的说明卡 + 一排四个按钮」，两处讲的是同一批
 * 目的地，卡片还因为没有 onClick 而看着能点、实际没反应。现在合并成一组真正可点
 * 的入口卡，并让每一张都说明「进去能做什么」。
 */
const DESTINATIONS = [
  {
    to: "/manager/customers",
    title: "客户与 IP 档案",
    description: "维护客户信息与已确认的 IP 账号规划资料，是账号定位流程的起点数据。",
    icon: BriefcaseBusiness,
    iconClass: "text-blue-600",
  },
  {
    to: "/manager/tasks",
    title: "任务与分配",
    description: "为客户创建内容任务、指派负责人，追踪每一条任务的进度与产出。",
    icon: Layers3,
    iconClass: "text-violet-600",
  },
  {
    to: "/manager/employees",
    title: "团队成员",
    description: "为员工创建账号、分配任务；员工登录后只看到自己的今日任务。",
    icon: UsersRound,
    iconClass: "text-emerald-600",
  },
  {
    to: "/workbench",
    title: "内容生产",
    description: "进入今日任务，按「选题 → 内容生成 → 发布仓 → 最终文案」推进本轮生产。",
    icon: PlayCircle,
    iconClass: "text-amber-600",
  },
] as const;

/** 工作台顶部计数条的取值；undefined 表示还没取到，界面显示为「—」。 */
type Overview = {
  pending: number;
  inProgress: number;
  overdue: number;
  unconfirmedProfiles: number;
};

export default function ManagerHomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      // 工作台的计数只是「一眼看清」，任何一边失败都不该把整个页面打挂，
      // 所以分开兜底：失败的那一块显示「—」，页面其余部分照常可用。
      const [taskResult, customerResult] = await Promise.allSettled([
        taskAPI.getAll(),
        customerAPI.getAll(),
      ]);
      if (cancelled) return;

      const next: Overview = { pending: 0, inProgress: 0, overdue: 0, unconfirmedProfiles: 0 };
      let failed = false;
      const now = new Date();

      if (taskResult.status === "fulfilled") {
        const tasks = taskResult.value.data || [];
        next.pending = tasks.filter((t: any) => t.status === "pending").length;
        next.inProgress = tasks.filter((t: any) => t.status === "in_progress").length;
        next.overdue = tasks.filter((t: any) => t.status !== "completed"
          && t.collaborationPeriod?.end
          && new Date(t.collaborationPeriod.end) < now).length;
      } else {
        failed = true;
      }

      if (customerResult.status === "fulfilled") {
        next.unconfirmedProfiles = (customerResult.value.data || [])
          .filter((c: any) => c.ipProfileSummary?.status !== "confirmed").length;
      } else {
        failed = true;
      }

      setOverview(next);
      setOverviewFailed(failed);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // 计数条：工作台不只是「去哪儿」的目录，也要能回答「现在有什么在等我处理」。
  const overviewCards = [
    { key: "pending", label: "待处理任务", value: overview?.pending, to: "/manager/tasks", icon: ClipboardList, cls: "text-amber-600", hint: "还没开始" },
    { key: "inProgress", label: "进行中", value: overview?.inProgress, to: "/manager/tasks", icon: Loader2, cls: "text-blue-600", hint: "员工正在做" },
    { key: "overdue", label: "已逾期", value: overview?.overdue, to: "/manager/tasks", icon: TriangleAlert, cls: "text-rose-600", hint: "超期未完成" },
    { key: "unconfirmed", label: "档案待确认", value: overview?.unconfirmedProfiles, to: "/manager/customers", icon: BriefcaseBusiness, cls: "text-violet-600", hint: "未确认会影响任务" },
  ];

  return (
    <div>
      {/* 页头和「任务 / 客户档案 / 团队成员」三页保持同一套结构：
          大标题 + 灰色副标题，没有英文眉题，标题下也不画分隔线。
          原来这里是一行蓝紫大写英文（MANAGER WORKSPACE），
          经理端内部各页头部长得不一样，进来会以为是两个系统。 */}
      <div className="page-header">
        <div>
          <h1 className="page-title">项目经理工作台</h1>
          <div className="page-subtitle max-w-3xl">
            欢迎回来，{user?.name || user?.email || "项目经理"}。管理端与员工端使用同一套账号认证。
          </div>
        </div>
      </div>

      <section aria-label="当前概况">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {overviewCards.map(item => {
            const Icon = item.icon;
            const dash = item.value === undefined;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => navigate(item.to)}
                className="group flex items-center gap-3.5 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-50">
                  <Icon className={`h-5 w-5 ${item.cls}`} />
                </span>
                <span className="min-w-0">
                  <span className="block text-2xl font-semibold leading-tight tracking-tight text-slate-950">
                    {dash ? "—" : item.value}
                  </span>
                  <span className="block truncate text-xs font-medium text-slate-600">{item.label}</span>
                  <span className="block truncate text-[11px] text-slate-400">{item.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        {overviewFailed && (
          <p className="mt-2.5 text-xs text-amber-600">
            部分统计暂时取不到（可能是服务未启动），显示为「—」，不影响下面的功能使用。
          </p>
        )}
      </section>

      <section className="mt-5 overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-sm">
        <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-center">
          <div>
            {/* 原来这里还有一行 ACCOUNT POSITIONING 英文眉题，和中文标题重复，
                而且经理端其它页面都没有这种小字，一并去掉。 */}
            <h2 className="text-2xl font-semibold tracking-tight text-slate-950">账号定位</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">从对标账号链接到账号定位规划的一条完整流程。每个阶段各自保存报告，但共用同一个入口，按顺序往下走即可，不需要在不同功能之间来回切换。</p>
            <button type="button" onClick={() => navigate("/manager/account-positioning")} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700">进入账号定位流程<ArrowUpRight className="h-4 w-4" /></button>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
            <div className="px-1 text-xs font-semibold tracking-wide text-slate-400">流程模块</div>
            <ol className="mt-3 space-y-2">
              {POSITIONING_MODULES.map(module => {
                const readiness = moduleReadiness(module);
                const ready = readiness !== "待实现";
                return (
                  <li key={module.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">{module.code}</span>
                      <span className="truncate text-sm font-medium text-slate-800">{module.title}</span>
                      <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${ready ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{readiness}</span>
                    </div>
                    {/* 2.1～2.3 是模块 3 的内部子步骤，不是平级模块，所以嵌在它下面显示。 */}
                    {module.steps.length > 0 && (
                      <ul className="mt-2 space-y-1 border-l-2 border-slate-200 pl-3">
                        {module.steps.map(step => (
                          <li key={step.id} className="flex items-center gap-2">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{step.code}</span>
                            <span className="truncate text-xs text-slate-600">{step.title}</span>
                            <span className={`ml-auto shrink-0 text-[10px] font-medium ${step.available ? "text-emerald-600" : "text-amber-600"}`}>{step.available ? "可执行" : "待实现"}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      </section>

      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        {DESTINATIONS.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.to}
              type="button"
              onClick={() => navigate(item.to)}
              className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md"
            >
              <div className="flex w-full items-start justify-between">
                <Icon className={`h-6 w-6 ${item.iconClass}`} />
                <ArrowUpRight className="h-4 w-4 text-slate-300 transition group-hover:text-blue-600" />
              </div>
              <h2 className="mt-5 text-lg font-semibold text-slate-900">{item.title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">{item.description}</p>
            </button>
          );
        })}
      </section>
    </div>
  );
}
