import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  ClipboardCheck,
  Copy,
  ExternalLink,
  FileText,
  Flame,
  Hash,
  HelpCircle,
  Layers3,
  Link2,
  LoaderCircle,
  MessageCircle,
  Rocket,
  Target,
  Trash2,
  UserPlus,
  UserRound,
  UsersRound,
  Video,
} from "lucide-react";
import { parseAccountLinks } from "./benchmarkAnalysis";
import { profileLevelLabelOf, profileLevelToneOf, type SavedBenchmarkProfileReportSummary } from "./benchmarkProfile";
import {
  ACCOUNT_PLAN_SECTION_LABELS,
  accountPlanToDocxBlocks,
  accountPlanTopicStatsLine,
  formatAccountPlanDocxFileName,
  formatAccountPlanMarkdown,
  isAccountPlanReviewCategory,
  type AccountPlanClassificationCategory,
  type AccountPlanContentFramework,
  type AccountPlanField,
  type AccountPlanHookGroup,
  type AccountPlanOperations,
  type AccountPlanProduction,
  type AccountPlanReport,
  type AccountPlanTopicEntry,
  type CustomerDetail,
  type CustomerSummary,
  type SavedAccountPlanReportSummary,
} from "./accountPlan";
import { buildDocxBlob, downloadDocx } from "./docx";
import { useAuth } from "./auth";
import {
  analyzeAccountPlan,
  deleteAccountPlanReport,
  // 🔴 少了这个导入，`removeBenchmarkReport`（「删除 1.2 报告」）会直接抛
  //    `ReferenceError: deleteBenchmarkProfileReport is not defined` —— 点击即崩。
  //    本项目的构建只跑 `vite build`、**不做类型检查**，所以"调用了却没导入"
  //    在构建期完全不报错。这条是补上类型检查后暴露出来的真实缺陷。
  deleteBenchmarkProfileReport,
  formatReportTime,
  getAccountPlanReport,
  getBenchmarkProfileReport,
  getCustomer,
  listAccountPlanReports,
  listBenchmarkProfileReports,
  listCustomers,
  saveAccountPlanReport,
} from "./reportApi";
import { StageChip, StageDisclosure, StageShell } from "./StageShell";
import { useStageDraft } from "./stageDraft";

/**
 * 模块 2「账号定位」(1.3)：一、IP定位 / 二、账号搭建 / 三、视频选题库（第一批）
 * 与 四、短视频内容框架 / 五、拍摄与剪辑建议 / 六、起号与运营（第二批）—— **同一份报告**。
 *
 * 它只有**一次**调用：客户 IP 档案与 1.2 的报告都是现成的，没有 1.2 那种「转写 → 抓评论 →
 * 拉画像 → 分析」的前端驱动流水线，所以这里既没有 `driveBatches`，也没有进度分段 ——
 * 别把 1.2 的分批循环抄过来。
 *
 * ── 渲染上必须守住的四条 ────────────────────────────────────────────────────
 *
 * ① **后端给什么就渲染什么。** 证据等级、条数、占比、缺失输入、告警全部照抄后端；
 *    前端不重算、不升级也不降级等级（HANDOFF §5 的诚实性要求）。
 * ② **空不是错。** 实测 5 个客户只有 1 个有 IP 档案，那一个的 `userProfile` 8 项还只填了 1 项：
 *    报告里大量「待人工补充」是如实结果。界面要把「为什么空」讲清楚（缺失输入卡 +
 *    覆盖率 + 逐项 note），否则项目经理会以为功能坏了。
 * ③ **`result` 必须自己判空**（§6.4⑱）：JSX 属性值在父组件渲染时就算出来了，
 *    `StageShell` 内部的 `hasResult` 拦不住 `report.xxx`，少这层保护就是一进页面白屏。
 * ④ **四 / 五 / 六 是第二批才有的**：第一批存下来的旧报告没有这三个字段，
 *    所以整节都用 `report.contentFramework && (...)` 包起来 —— 缺哪节就不渲染哪节，
 *    绝不留一个空壳（那会让人以为这一段生成失败）。切模块时用到的历史报告同样走这条路。
 */

/** 证据分级徽章 —— 标签与配色都走 `benchmarkProfile.ts` 那对带兜底的函数，前端不另存一份（§6.4⑲）。 */
function LevelTag({ level, label }: { level?: string; label?: string }) {
  const safeLevel = level || "manual";
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${profileLevelToneOf(safeLevel)}`}>
      {label || profileLevelLabelOf(safeLevel)}
    </span>
  );
}

/**
 * 一段带证据分级的叙述。呈现与 1.2 的 `BasisCard` 刻意一致（那边没导出它，
 * 而两个模块的报告并排审核时，同一件事长得不一样会让人以为是不同的东西）。
 * `text` 为空时明确写「待人工补充」，不留白。
 */
function LevelFieldCard({ title, field, emptyHint }: { title: string; field?: AccountPlanField | null; emptyHint?: string }) {
  const text = String(field?.text || "").trim();
  const basis = (field?.basis || []).filter(Boolean);
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <LevelTag level={field?.level} label={field?.levelLabel} />
      </div>
      {text ? (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{text}</p>
      ) : (
        <p className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-3.5 py-3 text-xs leading-5 text-slate-400">
          {emptyHint || "待人工补充：输入里没有可用依据，这一项需要项目经理自己补。"}
        </p>
      )}
      {basis.length > 0 && (
        <div className="mt-3 border-t border-dashed border-slate-200 pt-3">
          <div className="text-[10px] font-semibold tracking-[0.12em] text-slate-400">引文依据</div>
          <ul className="mt-2 space-y-1.5">
            {basis.map((item, index) => (
              <li key={`${title}-${index}`} className="flex gap-2 text-xs leading-5 text-slate-600">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-300" />{item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/**
 * 条目的统一呈现：正文 + 引文依据 + 证据等级。
 * 内容方向 / 简介候选 / 三种方法的选题 / 记忆锚点共用这一份，四处不再各写一遍。
 */
function GradedText({ text, basis, level, levelLabel, extra }: {
  text?: string;
  basis?: string[];
  level?: string;
  levelLabel?: string;
  extra?: ReactNode;
}) {
  const body = String(text || "").trim();
  const quotes = (basis || []).filter(Boolean);
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <span className={`min-w-0 flex-1 text-sm leading-6 ${body ? "text-slate-800" : "text-slate-400"}`}>{body || "待人工补充"}</span>
        <LevelTag level={level} label={levelLabel} />
      </div>
      {extra}
      {quotes.length > 0 && <p className="mt-1.5 text-xs leading-5 text-slate-400">依据：{quotes.join("；")}</p>}
    </div>
  );
}

/** 宽表统一走横向滚动：列多，窄屏挤成一团还不如让用户横着看（与 1.2 同一套）。 */
function TableShell({ head, minWidth = "min-w-[720px]", children }: { head: string[]; minWidth?: string; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
      <table className={`w-full ${minWidth} border-collapse text-left`}>
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/80">
            {head.map(cell => (
              <th key={cell} scope="col" className="px-4 py-3 text-xs font-semibold tracking-wide text-slate-500">{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

/** 三个大章节的标题。文案取自 `ACCOUNT_PLAN_SECTION_LABELS`（与后端 ACCOUNT_PLAN_SECTIONS 镜像）。 */
function SectionHeader({ icon: Icon, title, hint }: { icon: ComponentType<{ className?: string }>; title: string; hint: string }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Icon className="h-5 w-5 text-blue-600" />{title}</div>
      <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p>
    </div>
  );
}

/** 章节内的小标题（1、商业定位 这样的序号 + 标题）。 */
function SubHeading({ index, title, hint }: { index: string; title: string; hint?: string }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-slate-950 text-[11px] font-semibold text-white">{index}</span>
        {title}
      </div>
      {hint && <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p>}
    </div>
  );
}

/** 空态占位（虚线框），全站同一套。 */
function EmptyHint({ text }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400">{text}</div>;
}

/**
 * 「选题库建立」的一个大类块 —— 与 1.2 / 2.2 / 2.3 的「大类块」同一套呈现：
 * 序号徽章 + 大类标签 + 占比进度条，展开后左边核心功能 / 判断关键词，右边小类与选题。
 *
 * ⚠️ 这里的分类是**1.2 报告的原样透传**（本模块不重跑分类），所以条数与占比都不在前端重算，
 * 只显示后端算好的 `topicCount` / `percentage`；每块上面会标出透传来源。
 */
function ClassificationCategoryBlock({ category, index }: { category: AccountPlanClassificationCategory; index: number }) {
  const [expanded, setExpanded] = useState(true);
  const subcategories = category.subcategories || [];
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={() => setExpanded(previous => !previous)} className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-slate-50 sm:px-6">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-950 text-xs font-semibold text-white">{String(index + 1).padStart(2, "0")}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="rounded-md bg-blue-50 px-2 py-1 text-[10px] font-semibold tracking-wide text-blue-700">大类</span>
            <span className="text-base font-semibold text-slate-900">{category.name || "未命名大类"}</span>
            <span className="text-xs font-medium text-blue-600">{category.topicCount ?? 0} 条 · {category.percentage ?? 0}%</span>
          </span>
          <span className="mt-2 block h-1.5 max-w-md overflow-hidden rounded-full bg-slate-100">
            <span className="block h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(2, category.percentage || 0))}%` }} />
          </span>
        </span>
        {expanded ? <ChevronDown className="h-5 w-5 shrink-0 text-slate-400" /> : <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" />}
      </button>

      {expanded && (
        <div className="border-t border-slate-100 px-5 py-5 sm:px-6">
          <div className="grid gap-5 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,2fr)]">
            <div className="rounded-xl bg-slate-50 p-4">
              <div className="text-xs font-semibold tracking-wide text-slate-400">核心功能</div>
              <p className="mt-2 text-sm leading-6 text-slate-700">{category.coreFunction || "待人工补充"}</p>
              <div className="mt-5 text-xs font-semibold tracking-wide text-slate-400">判断核心关键词 / 语句</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(category.keywords || []).length > 0
                  ? category.keywords.map(keyword => <span key={keyword} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">{keyword}</span>)
                  : <span className="text-xs text-slate-400">待人工补充</span>}
              </div>
            </div>

            <div className="space-y-4">
              {subcategories.length === 0 ? (
                <p className="text-xs leading-5 text-slate-400">这个大类下没有小类明细。</p>
              ) : subcategories.map((subcategory, subIndex) => (
                <div key={subcategory.id || `${subcategory.name}-${subIndex}`} className="border-l-2 border-blue-200 pl-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[10px] font-semibold tracking-[0.16em] text-blue-500">小类</span>
                    <h4 className="text-sm font-semibold text-slate-800">{subcategory.name || "未命名小类"}</h4>
                    <span className="text-xs text-slate-400">{subcategory.topicCount ?? (subcategory.topics || []).length} 条</span>
                  </div>
                  {subcategory.description && <p className="mt-1.5 text-xs leading-5 text-slate-500">{subcategory.description}</p>}
                  <div className="mt-3 border-t border-dashed border-slate-200 pt-3">
                    <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] text-slate-400"><span className="h-px w-4 bg-slate-300" />具体选题</div>
                    <div className="space-y-2">
                      {(subcategory.topics || []).map((topic, topicIndex) => {
                        // 库里通常只剩标题（§6.2⑨）：链接与互动数据读不到就不显示，绝不补零。
                        const stats = accountPlanTopicStatsLine(topic.stats);
                        return (
                          <div key={topic.id || `${topic.title}-${topicIndex}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              {topic.link ? (
                                <a href={topic.link} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-start gap-1 break-words text-sm leading-5 text-slate-800 hover:text-blue-700">
                                  {topic.title || topic.link}<ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
                                </a>
                              ) : (
                                <span className="text-sm leading-5 text-slate-800">{topic.title || "未命名选题"}</span>
                              )}
                              {stats && <span className="text-[11px] text-slate-400">{stats}</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** 比对主页链接时统一成小写、去掉查询串与末尾斜杠 —— 名册里的链接常带 `?from=...` 与尾斜杠。 */
const normalizeAccountUrl = (value?: string) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[?#].*$/, "")
  .replace(/\/+$/, "");

/**
 * 方法一(a) 同赛道对标账号的条目。
 *
 * ⚠️ `accountPlan.ts` 里 `sameTrackAccounts.items` 的类型还是 `unknown[]`（那份类型本批不动），
 * 所以在这里收口成后端的实际形状：`{ title, url }`；`url` 为空表示名册里那一项不是一个链接 ——
 * 原样显示、不给跳转（前端不猜域名，也不补一个出来）。**条数与等级一律照抄后端**，前端不重算。
 */
type AccountPlanSameTrackItem = { title?: string; url?: string };

const sameTrackItemsOf = (value?: { items?: unknown[] } | null): AccountPlanSameTrackItem[] =>
  (Array.isArray(value?.items) ? value.items : [])
    .filter((item): item is AccountPlanSameTrackItem => Boolean(item && typeof item === "object"));

/** 选题列表（方法一 / 方法二共用）：标题 + 角度 / 痛点 + 等级。 */
function TopicEntryList({ topics, emptyText }: { topics: AccountPlanTopicEntry[]; emptyText: string }) {
  if (topics.length === 0) return <p className="text-xs leading-5 text-slate-400">{emptyText}</p>;
  return (
    <div className="space-y-2">
      {topics.map((item, index) => (
        <GradedText
          key={`${item.title}-${index}`}
          text={item.title}
          basis={item.basis}
          level={item.level}
          levelLabel={item.levelLabel}
          extra={(
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-slate-500">
              {item.painPoint && <span>对应痛点：{item.painPoint}</span>}
              {item.angle && <span>切入角度：{item.angle}</span>}
            </div>
          )}
        />
      ))}
    </div>
  );
}

/**
 * 四 的一组钩子：4 张卡，每张 = 类型标签 + 可直接用的文案 + 理由 + 等级。
 *
 * ⚠️ 丢弃数照抄后端（类型不在权威清单内 / 类型重复 / 没有文案 / 超出 4 条），
 * 前端不重算；「可选类型清单」用 `StageDisclosure` 收起来 —— 它是对照用，不该抢正文的注意力。
 */
function HookGroupCard({ index, group }: { index: string; group: AccountPlanHookGroup }) {
  const hooks = group?.hooks || [];
  const types = group?.types || [];
  const discardedTypes = (group?.discardedTypes || []).filter(Boolean);
  return (
    <div className="space-y-3">
      <SubHeading
        index={index}
        title={group?.label || "钩子"}
        hint={`${group?.count ?? 0} / ${group?.requiredCount ?? 0} 种不同类型；类型只能来自后端权威清单，认不出的与重复的已丢弃。`}
      />
      {group?.typeNote && <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">{group.typeNote}</p>}
      {group?.discardedCount > 0 && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
          <span className="font-semibold">本次丢弃 {group.discardedCount} 条</span>：{group.discardedNote}
          {discardedTypes.length > 0 && <span className="ml-1">（原始类型：{discardedTypes.join("、")}）</span>}
        </p>
      )}
      {hooks.length === 0 ? (
        <EmptyHint text={group?.note || "这一组暂无钩子，待人工补充。"} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {hooks.map(hook => (
            <article key={`${group.key}-${hook.type}`} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-blue-50 px-2 py-1 text-[10px] font-semibold tracking-wide text-blue-700">{hook.typeLabel || hook.type}</span>
                  {hook.benchmarkUsed
                    ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">1.2 常用类型</span>
                    : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">补充类型</span>}
                </div>
                <LevelTag level={hook.level} label={hook.levelLabel} />
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm font-medium leading-6 text-slate-800">{hook.text || "待人工补充"}</p>
              {hook.reason && <p className="mt-2 text-xs leading-5 text-slate-500">理由：{hook.reason}</p>}
              {(hook.basis || []).length > 0 && <p className="mt-1.5 text-xs leading-5 text-slate-400">依据：{(hook.basis || []).join("；")}</p>}
              {(hook.definition || hook.example || hook.typeNote) && (
                <div className="mt-3">
                  <StageDisclosure label="类型口径" meta={hook.typeLabel || hook.type}>
                    <div className="space-y-1.5 px-1 py-1 text-xs leading-5 text-slate-500">
                      {hook.definition && <p>{hook.definition}</p>}
                      {hook.example && <p className="text-slate-400">例：{hook.example}</p>}
                      {hook.typeNote && <p className="text-amber-700">{hook.typeNote}</p>}
                    </div>
                  </StageDisclosure>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {group?.note && hooks.length > 0 && <p className="text-xs leading-5 text-amber-700">{group.note}</p>}
      {(group?.benchmarkTopTypes || []).length > 0 && (
        <p className="text-xs leading-5 text-slate-400">
          1.2 里对标账号最常用的类型：{(group.benchmarkTopTypes || []).map(item => `${item.typeLabel}（${item.count} 条 · ${item.percentage}%）`).join("、")}
        </p>
      )}
      {types.length > 0 && (
        <StageDisclosure label="可选类型清单（后端权威定义）" meta={`${types.length} 种`}>
          <ul className="space-y-2 px-1 py-1">
            {types.map(item => (
              <li key={item.type} className="text-xs leading-5 text-slate-500">
                <span className="font-semibold text-slate-700">{item.label}</span>
                <span className="ml-1.5 font-mono text-[10px] text-slate-400">{item.type}</span>
                <span className="ml-1.5">{item.definition}</span>
                {item.example && <span className="text-slate-400">　例：{item.example}</span>}
              </li>
            ))}
          </ul>
        </StageDisclosure>
      )}
    </div>
  );
}

/** 五 的一组建议（拍摄 5 项 / 剪辑 4 项）：逐项给建议 + 等级，缺项如实写「待人工补充」。 */
function ProductionGroupCard({ index, group }: { index: string; group: AccountPlanProduction["shooting"] }) {
  const items = group?.items || [];
  return (
    <div className="space-y-3">
      <SubHeading index={index} title={group?.label || "建议"} hint={`${group?.count ?? 0} / ${group?.requiredCount ?? 0} 项有内容；这些是建议，不是对该账号实际做法的观测。`} />
      <div className="grid gap-3 lg:grid-cols-2">
        {items.map(item => (
          <article key={item.key} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="text-sm font-semibold text-slate-900">{item.label || item.key}</div>
              <LevelTag level={item.level} label={item.levelLabel} />
            </div>
            <p className="mt-1.5 text-xs leading-5 text-slate-500">{item.rule}</p>
            {String(item.text || "").trim() ? (
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{item.text}</p>
            ) : (
              <p className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-3.5 py-3 text-xs leading-5 text-slate-400">待人工补充：这一项没有给出建议。</p>
            )}
            {(item.basis || []).length > 0 && <p className="mt-2 text-xs leading-5 text-slate-400">依据：{(item.basis || []).join("；")}</p>}
          </article>
        ))}
      </div>
      {group?.note && <p className="text-xs leading-5 text-slate-400">{group.note}</p>}
    </div>
  );
}

/**
 * 六 的两块**通用模板表**（起号四步 / 数据复盘四维）。
 *
 * ⚠️ `template: true` 的标记必须显示出来：这两块是行业通用模板，不是针对这家客户的推断，
 * 混在其它结论里会让人以为「分析师调研出这家客户要这么做」。
 */
function TemplateTableCard({ label, note, source, headers, rows }: {
  label: string;
  note: string;
  source: string;
  headers: [string, string];
  rows: Array<[string, string]>;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-800">{label}</span>
        <span className="rounded-full bg-slate-950 px-2.5 py-1 text-[11px] font-medium text-white">通用模板</span>
        <span className="text-[11px] text-slate-400">{source}</span>
      </div>
      <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs leading-5 text-slate-500">{note}</p>
      <TableShell head={headers} minWidth="min-w-[640px]">
        {rows.map((row, index) => (
          <tr key={`${label}-${index}`} className="align-top">
            <td className="w-40 px-4 py-3 text-sm font-medium text-slate-700">{row[0]}</td>
            <td className="px-4 py-3 text-sm leading-6 text-slate-600">{row[1]}</td>
          </tr>
        ))}
      </TableShell>
    </div>
  );
}

/** 六 的内容配比：每个时期一行大类占比条（占比由后端重算，前端只画）。 */
function ContentMixPeriodCard({ period }: { period: AccountPlanOperations["contentMix"]["periods"][number] }) {
  const rows = period?.rows || [];
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-slate-900">{period?.label || period?.key}</span>
          <LevelTag level={period?.level} label={period?.levelLabel} />
        </div>
        <span className={`rounded-full px-3 py-1.5 text-xs font-medium ${rows.length === 0 ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700"}`}>
          合计 {period?.total ?? 0}%
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-3.5 py-3 text-xs leading-5 text-slate-400">{period?.note || "这一时期的配比待人工补充。"}</p>
      ) : (
        <div className="mt-4 space-y-3.5">
          {rows.map(row => (
            <div key={`${period.key}-${row.category}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-medium text-slate-800">{row.category}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{row.intentLabel || row.intent}</span>
                  <span className="font-medium text-blue-600">{row.percentage ?? 0}%</span>
                  <LevelTag level={row.level} label={row.levelLabel} />
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(2, row.percentage || 0))}%` }} />
              </div>
              {row.reason && <p className="mt-1.5 text-xs leading-5 text-slate-500">理由：{row.reason}</p>}
              {(row.basis || []).length > 0 && <p className="mt-1 text-xs leading-5 text-slate-400">依据：{(row.basis || []).join("；")}</p>}
              {row.intentNote && <p className="mt-1 text-xs leading-5 text-amber-700">{row.intentNote}</p>}
            </div>
          ))}
        </div>
      )}
      {period?.discardedCount > 0 && <p className="mt-3 text-xs leading-5 text-amber-700">{period.discardedNote}</p>}
    </article>
  );
}

export type AccountPlanStageProps = {
  // 作为「账号定位」模块的 1.3 步骤嵌入时不渲染页面级外壳（返回按钮、大标题、登录信息）。
  embedded?: boolean;
  // 保存成功时通知模块壳，用于在模块卡片上标记「已完成」。
  onSaved?: () => void;
};

export function AccountPlanStage({ embedded = false, onSaved }: AccountPlanStageProps) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  // 这三项走草稿：切模块或刷新后，选中的客户、选中的 1.2 报告与生成结果都还在。
  // loading / progress / error / saving / copied / exporting / busy* 这些瞬时状态留在普通 useState 里。
  // 列表与客户档案**不进草稿**（访谈原文最长 6000 字），与 1.2 只把报告 id 留在草稿里同一套。
  const [selectedCustomerId, setSelectedCustomerId] = useStageDraft("accountPlan.selectedCustomerId", "");
  const [benchmarkReportId, setBenchmarkReportId] = useStageDraft("accountPlan.benchmarkReportId", "");
  const [report, setReport] = useStageDraft<AccountPlanReport | null>("accountPlan.report", null);

  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [customerDetail, setCustomerDetail] = useState<CustomerDetail | null>(null);
  const [benchmarkReports, setBenchmarkReports] = useState<SavedBenchmarkProfileReportSummary[]>([]);
  const [savedReports, setSavedReports] = useState<SavedAccountPlanReportSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingCustomer, setLoadingCustomer] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyReportId, setBusyReportId] = useState("");
  // 1.2 报告列表的删除守卫，与历史报告的 busyReportId 分开（两个列表互不影响，§6.2㉙）。
  const [busyBenchmarkId, setBusyBenchmarkId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);
  // 自动挑中的那一份 1.2 报告：只在提示条里说明「这份是系统按名册里的对标账号挑的」。
  const [autoMatchedReportId, setAutoMatchedReportId] = useState("");

  /**
   * 运行代号：每开始一轮生成 +1。1.3 只有一次调用，但用户完全可能在等结果时换客户 / 换报告，
   * 或者切到别的模块把本组件卸载 —— 回调写回前必须核对代号，否则旧结果会盖掉新的选择。
   */
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);
  // 同一个客户的档案同时只取一次（点击与「切模块回来恢复」两条路都会调它）。
  const loadingCustomerRef = useRef("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 卸载即作废在途的那一轮。
      runIdRef.current += 1;
    };
  }, []);

  // 三份列表都很轻（客户列表不含访谈原文，报告列表只给元数据），一次并发拉完。
  useEffect(() => {
    let active = true;
    setLoadingHistory(true);
    Promise.all([listCustomers(), listBenchmarkProfileReports(), listAccountPlanReports()])
      .then(([customerItems, benchmarkItems, planReports]) => {
        if (!active) return;
        setCustomers(customerItems);
        setBenchmarkReports(benchmarkItems);
        setSavedReports(planReports);
      })
      .catch(requestError => {
        if (active) setError(requestError instanceof Error ? requestError.message : "历史数据加载失败");
      })
      .finally(() => {
        if (active) setLoadingHistory(false);
      });
    return () => { active = false; };
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  /** 作废在途的那一轮：换了输入之后，旧的一轮不能再把结果写回来。 */
  const supersedeRun = () => {
    runIdRef.current += 1;
    setLoading(false);
    setProgress("");
  };

  const runIsCurrent = (runId: number) => mountedRef.current && runIdRef.current === runId;

  /**
   * 客户名册里登记的对接账号是换行分隔的抖音主页链接，1.2 报告列表带 `accountUrl`。
   * 两边都在时自动挑一份对得上的报告，省掉项目经理手工比对；**用户随时可以改选**。
   * 对不上就不动当前选择（宁可让人自己挑，也不要猜错一份）。
   */
  const autoMatchBenchmarkReportId = (customer: CustomerDetail) => {
    const urls = parseAccountLinks(customer?.benchmarkAccounts || "").map(normalizeAccountUrl).filter(Boolean);
    if (urls.length === 0) return "";
    return benchmarkReports.find(item => urls.includes(normalizeAccountUrl(item.accountUrl)))?.id || "";
  };

  /**
   * 按 id 取单个客户（含完整 `ipProfile`，含访谈原文）—— 列表接口刻意不带这一份。
   * 点击客户与「切模块回来恢复选择」两条路共用它，不各写一遍取数逻辑。
   */
  const loadCustomerDetail = async (id: string, options: { autoMatchReport?: boolean } = {}) => {
    if (!id || loadingCustomerRef.current === id) return;
    loadingCustomerRef.current = id;
    setLoadingCustomer(true);
    setError("");
    try {
      const detail = await getCustomer(id);
      if (!mountedRef.current) return;
      if (!detail) throw new Error("该客户不存在或已被删除");
      setCustomerDetail(detail);
      if (options.autoMatchReport) {
        const matchedId = autoMatchBenchmarkReportId(detail);
        if (matchedId) {
          setBenchmarkReportId(matchedId);
          setAutoMatchedReportId(matchedId);
        }
      }
    } catch (requestError) {
      if (!mountedRef.current) return;
      setCustomerDetail(null);
      setError(requestError instanceof Error ? requestError.message : "客户档案加载失败");
    } finally {
      loadingCustomerRef.current = "";
      if (mountedRef.current) setLoadingCustomer(false);
    }
  };

  // 切模块会把本组件卸载重建：草稿里留着客户 id，回来时按 id 重新取一次档案。
  useEffect(() => {
    if (!selectedCustomerId) {
      setCustomerDetail(null);
      return;
    }
    if (customerDetail?.id === selectedCustomerId) return;
    void loadCustomerDetail(selectedCustomerId);
    // customerDetail 只用来判断「内存里是不是已经有这一份」，不进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomerId]);

  // 当前选中的客户 / 报告：列表只有元数据，提示条里要说清这一轮到底在给谁、用哪一份。
  const selectedCustomer = customers.find(item => item.id === selectedCustomerId) || null;
  const selectedBenchmarkReport = benchmarkReports.find(item => item.id === benchmarkReportId) || null;

  /** 点一个客户：换输入即作废在途的那一轮，并清掉旧结果（结果必须与输入对得上）。 */
  const selectCustomer = (item: CustomerSummary) => {
    supersedeRun();
    setSelectedCustomerId(item.id);
    setCustomerDetail(null);
    setAutoMatchedReportId("");
    setReport(null);
    setMessage("");
    void loadCustomerDetail(item.id, { autoMatchReport: true });
  };

  /** 点一份 1.2 报告：同上，清掉旧结果，避免「报告头写着 A、结果其实是给 B 生成的」。 */
  const selectBenchmarkReport = (item: SavedBenchmarkProfileReportSummary) => {
    supersedeRun();
    setBenchmarkReportId(item.id);
    setAutoMatchedReportId("");
    setReport(null);
    setMessage("");
  };

  const canRun = Boolean(selectedCustomerId && benchmarkReportId);

  const runAnalysis = async () => {
    if (!selectedCustomerId) {
      setError("请先选择一个客户");
      return;
    }
    if (!benchmarkReportId) {
      setError("请选择一份 1.2 对标账号分析报告");
      return;
    }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setLoading(true);
    setError("");
    setMessage("");
    setProgress("正在生成账号定位…");
    try {
      // 1.2 的报告列表只有元数据，正文要按 id 取一份（§6.2⑥）。
      // 客户档案不需要前端传：后端按 customerId 从库里读，前端没有机会伪造一份档案。
      const full = await getBenchmarkProfileReport(benchmarkReportId);
      if (!runIsCurrent(runId)) return;
      if (!full?.report) throw new Error("这份 1.2 对标账号分析报告不存在或已被删除，请重新选择");
      const nextReport = await analyzeAccountPlan({ customerId: selectedCustomerId, benchmarkProfileReport: full.report });
      if (!runIsCurrent(runId)) return;
      setReport(nextReport);
    } catch (requestError) {
      if (runIsCurrent(runId)) setError(requestError instanceof Error ? requestError.message : "账号定位生成失败");
    } finally {
      if (runIsCurrent(runId)) {
        setLoading(false);
        setProgress("");
      }
    }
  };

  /** 保存 / 复制 / 导出三处都要 in-flight 守卫，否则双击会存出重复记录、导出两次（§6.4㉑）。 */
  const saveReport = async () => {
    if (!report || saving) return;
    setSaving(true);
    setError("");
    try {
      const item = await saveAccountPlanReport(report);
      setSavedReports(previous => [item, ...previous.filter(existing => existing.id !== item.id)].slice(0, 12));
      setMessage("账号定位报告已保存，可供后续账号搭建与选题执行使用。");
      onSaved?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "保存报告失败");
    } finally {
      setSaving(false);
    }
  };

  const copyReport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(formatAccountPlanMarkdown(report));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("当前浏览器不允许访问剪贴板，请手动复制报告内容");
    }
  };

  /**
   * 导出 Word。拼 zip 是同步的，但比复制重得多，双击会拼两份、下载两次（§6.4㉑），
   * 所以先置 `exporting` 挡住后续点击，等下一拍再真正拼装 —— 否则「导出中…」一帧都渲染不出来。
   */
  const exportReport = () => {
    if (!report || exporting) return;
    setExporting(true);
    setError("");
    window.setTimeout(() => {
      try {
        downloadDocx(buildDocxBlob(accountPlanToDocxBlocks(report)), formatAccountPlanDocxFileName(report));
        setExported(true);
        window.setTimeout(() => setExported(false), 1800);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "导出 Word 失败");
      } finally {
        setExporting(false);
      }
    }, 0);
  };

  // 删除一份 1.2 报告。它是本模块的输入，删掉后必须把当前选择与在途的那一轮一并清掉，
  // 否则「生成账号定位」会拿着一份已经不存在的报告去跑（§6.2㉙）。
  const removeBenchmarkReport = async (item: SavedBenchmarkProfileReportSummary) => {
    if (busyBenchmarkId) return;
    setBusyBenchmarkId(item.id);
    setError("");
    try {
      await deleteBenchmarkProfileReport(item.id);
      setBenchmarkReports(previous => previous.filter(existing => existing.id !== item.id));
      if (benchmarkReportId === item.id) {
        supersedeRun();
        setBenchmarkReportId("");
        setAutoMatchedReportId("");
        setReport(null);
      }
      setMessage("已删除该 1.2 对标账号分析报告。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除对标账号分析报告失败");
    } finally {
      setBusyBenchmarkId("");
    }
  };

  const loadSavedReport = async (item: SavedAccountPlanReportSummary) => {
    if (busyReportId) return;
    setBusyReportId(item.id);
    setError("");
    try {
      const full = await getAccountPlanReport(item.id);
      if (!full?.report) throw new Error("这份报告不存在或已被删除");
      // 载入历史报告同样要作废在途的那一轮，否则等它跑完就把刚载入的这份盖掉了。
      supersedeRun();
      setReport(full.report);
      setMessage("已载入历史账号定位报告。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "载入历史报告失败");
    } finally {
      setBusyReportId("");
    }
  };

  const removeSavedReport = async (item: SavedAccountPlanReportSummary) => {
    if (busyReportId) return;
    setBusyReportId(item.id);
    setError("");
    try {
      await deleteAccountPlanReport(item.id);
      setSavedReports(previous => previous.filter(existing => existing.id !== item.id));
      setMessage("已删除该历史报告。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除失败");
    } finally {
      setBusyReportId("");
    }
  };

  // ── 输入面板 ──────────────────────────────────────────────────────────────
  const customerListEmpty = !loadingHistory && customers.length === 0;
  /**
   * 档案填了几项。档案详情到手时按后端归一化后的三个分组现算 —— `normalizeIpProfile` 保证
   * 分组里**恰好就是**访谈清单的 19 个字段（空的也是空串），所以数非空值就是覆盖率口径；
   * 详情还没到时退回列表接口给的 `filledFieldCount`。
   */
  const profileFilledCount = customerDetail
    ? [
      ...Object.values(customerDetail.ipProfile?.identity || {}),
      ...Object.values(customerDetail.ipProfile?.product || {}),
      ...Object.values(customerDetail.ipProfile?.userProfile || {}),
    ].filter(value => String(value || "").trim()).length
    : (selectedCustomer?.filledFieldCount ?? 0);
  const profileHasProfile = customerDetail ? customerDetail.hasProfile : Boolean(selectedCustomer?.hasProfile);
  const profileKnown = Boolean(customerDetail || selectedCustomer);
  // 「没有档案」与「有档案但一项没填」对下游是同一件事：后端的 coverage.hasAnyValue 为 false，
  // 报告里所有以档案为依据的结论都会退成推断或待人工补充。两种情况合成同一句解释。
  const profileIsEmpty = profileKnown && (!profileHasProfile || profileFilledCount === 0);
  const benchmarkAccountUrls = parseAccountLinks(customerDetail?.benchmarkAccounts || "");
  const missingSelectionHints = [
    !selectedCustomerId ? "还没有选择客户" : "",
    !benchmarkReportId ? "还没有选择 1.2 对标账号分析报告" : "",
  ].filter(Boolean);

  const setupPanel = (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4 text-sm font-semibold text-slate-900">
        <UsersRound className="h-4 w-4 text-blue-600" />生成账号定位的输入
      </div>
      <div className="space-y-5 px-5 py-5">
        {/* ① 选客户 —— IP 档案的来源 */}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold tracking-wide text-slate-500">① 选择客户（IP 访谈档案的来源）</span>
            {selectedCustomer && <span className="text-xs text-slate-400">已选：{selectedCustomer.name || "未命名客户"}</span>}
          </div>
          <div className="mt-2.5">
            {loadingHistory ? (
              <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-6 text-xs text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />正在读取客户名册…</div>
            ) : customerListEmpty ? (
              <div className="rounded-xl bg-amber-50 px-4 py-3.5 text-xs leading-5 text-amber-700">
                客户名册里还没有读到客户。客户与 IP 档案在管理端另一个项目中录入（写入同一套线上数据库），本流程直接沿用。
              </div>
            ) : (
              <div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
                {customers.map(item => {
                  const selected = item.id === selectedCustomerId;
                  const emptyProfile = !item.hasProfile || item.filledFieldCount === 0;
                  return (
                    <div key={item.id} className={`rounded-xl border transition ${selected ? "border-blue-300 bg-blue-50/70" : "border-slate-200 hover:border-slate-300"}`}>
                      <button type="button" onClick={() => selectCustomer(item)} className="w-full px-3.5 py-3 text-left">
                        <div className="flex items-start justify-between gap-3">
                          <span className="truncate text-sm font-semibold text-slate-800">{item.name || "未命名客户"}</span>
                          {selected && <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-600" />}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                          <span>{item.occupation || "职业未填写"}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${emptyProfile ? "bg-amber-100 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                            {!item.hasProfile ? "未录入 IP 档案" : item.filledFieldCount === 0 ? "档案全空 · 0 项" : `档案已录入 · ${item.filledFieldCount} 项`}
                          </span>
                          {item.profileStatus && <span>档案状态：{item.profileStatus}</span>}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 选中之后的档案说明：这里必须把「为什么后面全是待人工补充」提前讲明白 */}
          {loadingCustomer ? (
            <div className="mt-3 flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-4 text-xs text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />正在读取该客户的 IP 访谈档案…</div>
          ) : customerDetail ? (
            <div className="mt-3 space-y-3">
              {profileIsEmpty ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-xs leading-5 text-amber-700">
                  <div className="flex items-center gap-2 text-sm font-semibold"><AlertTriangle className="h-4 w-4" />这个客户还没有 IP 访谈档案</div>
                  <p className="mt-2">
                    后端只能拿 1.2 报告和名册里的补充说明来推断，所以生成结果里的一、IP定位（目标人群、人设定位）与变现产品定价会<span className="font-semibold">大量</span>落在
                    「Agent 推断」或「待人工补充」。<span className="font-semibold">这是如实结果，不是生成失败</span>——
                    界面上每一处都会标出等级与原因。
                  </p>
                  <p className="mt-1.5">
                    想让这些字段变成「输入证据」，可以补客户档案里的 身份信息 / 产品信息 / 用户画像 三项清单
                    （尤其是年龄、性别、收入水平与价格区间），或者在名册里写清客户的补充说明 ——
                    两者都是一手输入，模型引用其中的原话才能标成「输入证据」；写完回到这里重新生成。
                  </p>
                </div>
              ) : (
                <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
                  <span className="font-semibold text-slate-600">IP 档案：</span>已填 {profileFilledCount} 项。
                  档案里为空的字段若连名册补充说明也没有，对应结论（例如目标人群的各个维度）仍会是「Agent 推断」或「待人工补充」，报告里会逐项标出。
                </div>
              )}
              <div className="rounded-xl border border-slate-200 px-4 py-3 text-xs leading-5 text-slate-500">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-semibold text-slate-600">档案信息</span>
                  <span>访谈原文 {customerDetail.ipProfile?.interview?.rawNotesLength || 0} 字</span>
                  {customerDetail.ipProfile?.interview?.rawNotesTruncated && <span className="text-amber-700">（超过上限，已截断后送入分析）</span>}
                  {customerDetail.ipProfile?.interview?.completedAt && <span>完成于 {formatReportTime(customerDetail.ipProfile.interview.completedAt)}</span>}
                  {customerDetail.ipProfile?.interview?.source && <span>来源：{customerDetail.ipProfile.interview.source}</span>}
                </div>
                <p className="mt-1.5">
                  访谈原文不落进报告，也不显示在这里（最长 6000 字）；它参与本次分析并计入证据核对范围，仍可在客户档案里回查。
                </p>
                {benchmarkAccountUrls.length > 0 && (
                  <p className="mt-1.5 break-all">名册里登记的对标账号：{benchmarkAccountUrls.join("、")}</p>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {/* ② 选 1.2 报告 —— 内容定位与选题库的唯一来源 */}
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold tracking-wide text-slate-500">② 选择 1.2 对标账号分析报告</span>
            {selectedBenchmarkReport && <span className="text-xs text-slate-400">已选：{selectedBenchmarkReport.accountName || "未识别账号"}</span>}
          </div>
          <div className="mt-2.5">
            {loadingHistory ? (
              <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-6 text-xs text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />正在读取历史报告…</div>
            ) : benchmarkReports.length === 0 ? (
              <div className="rounded-xl bg-amber-50 px-4 py-3.5 text-xs leading-5 text-amber-700">
                还没有保存过 1.2 对标账号分析报告。请先切到上方的「1.2 对标账号分析」跑一份并保存 —— 内容定位与选题库都从这里透传，没有它这一批产不出东西。
              </div>
            ) : (
              <div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
                {benchmarkReports.map(item => {
                  const busy = busyBenchmarkId === item.id;
                  const selected = benchmarkReportId === item.id;
                  return (
                    // 与 1.2 自己的已保存列表同一套：选中区 + 独立的删除按钮（删除带 in-flight 守卫）。
                    <div key={item.id} className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 transition ${busy ? "border-blue-200 bg-blue-50/40" : selected ? "border-blue-300 bg-blue-50/70" : "border-slate-200 hover:border-slate-300"}`}>
                      <button type="button" disabled={Boolean(busyBenchmarkId)} onClick={() => selectBenchmarkReport(item)} className="min-w-0 flex-1 text-left disabled:cursor-not-allowed">
                        <div className="flex items-start justify-between gap-3">
                          <span className="truncate text-sm font-semibold text-slate-800">{item.accountName || "未识别账号"}</span>
                          {selected && <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-600" />}
                        </div>
                        <div className="mt-1 text-xs text-slate-400">{item.analyzedCount || 0} 条样本 · {formatReportTime(item.createdAt)}</div>
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busyBenchmarkId)}
                        onClick={() => removeBenchmarkReport(item)}
                        aria-label={`删除 ${item.accountName || "该"} 的对标账号分析报告`}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}{busy ? "处理中" : "删除"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {autoMatchedReportId && autoMatchedReportId === benchmarkReportId && (
            <p className="mt-2 rounded-xl bg-blue-50 px-3.5 py-2.5 text-xs leading-5 text-blue-700">
              已按该客户名册里登记的对标账号自动选中了《{selectedBenchmarkReport?.accountName || "未识别账号"}》，可以改选别的报告。
            </p>
          )}
        </div>

        <p className="rounded-xl bg-slate-50 px-3.5 py-3 text-xs leading-5 text-slate-500">
          本次会用<span className="font-semibold">选中客户的 IP 档案</span>（后端按客户 id 从库里读，前端不传档案）与<span className="font-semibold">选中的这份 1.2 报告</span>合成账号定位。
          1.3 不抓视频、不转写、不抓评论：一次调用直接出报告，选题库与高频标签原样透传 1.2 的产出，不重跑分类。
        </p>

        <button
          type="button"
          onClick={runAnalysis}
          disabled={loading || !canRun}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50"
        >
          {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
          {loading ? "生成中…" : "生成账号定位"}
        </button>
        {loading ? (
          <p className="text-center text-xs leading-5 text-slate-500">{progress || "正在生成账号定位…"}</p>
        ) : missingSelectionHints.length > 0 ? (
          // 按钮为什么是灰的，就在按钮下面说清楚 —— 别让人对着一个点不动的按钮猜。
          <p className="text-center text-xs leading-5 text-slate-400">生成前请先：{missingSelectionHints.join("、")}。</p>
        ) : null}
      </div>
    </div>
  );

  // 已保存的账号定位报告不用第三张卡堆在侧栏 —— 收成一行可展开条目（与 1.2 同一套）。
  const historyDisclosure = savedReports.length > 0 ? (
    <StageDisclosure label="已保存的账号定位报告" meta={`${savedReports.length} 份`}>
      <div className="space-y-2">
        {savedReports.map(item => {
          const busy = busyReportId === item.id;
          return (
            <div key={item.id} className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 transition ${busy ? "border-blue-200 bg-blue-50/40" : "border-slate-200 hover:border-blue-300 hover:bg-blue-50/50"}`}>
              <button type="button" disabled={Boolean(busyReportId)} onClick={() => loadSavedReport(item)} className="min-w-0 flex-1 text-left disabled:cursor-not-allowed">
                <div className="truncate text-sm font-medium text-slate-800">{item.customerName || "未命名客户"} × {item.benchmarkAccountName || "未识别对标账号"}</div>
                <div className="mt-1 text-xs text-slate-400">{item.analyzedCount || 0} 个章节有内容 · {formatReportTime(item.createdAt)}</div>
              </button>
              <button
                type="button"
                disabled={Boolean(busyReportId)}
                onClick={() => removeSavedReport(item)}
                aria-label={`删除 ${item.customerName || "该"} 的账号定位报告`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}{busy ? "处理中" : "删除"}
              </button>
            </div>
          );
        })}
      </div>
    </StageDisclosure>
  ) : null;

  const stageSetup = <>{setupPanel}{historyDisclosure}</>;

  const summaryChips = report ? (
    <>
      <StageChip>{report.customer?.name || "未命名客户"}</StageChip>
      <StageChip>对标：{report.benchmark?.accountName || "未识别对标账号"}</StageChip>
      <StageChip tone="accent">{report.dataCoverage?.producedSectionCount || 0} / {report.sections?.length || 3} 个章节有内容</StageChip>
      <StageChip>选题 {report.topicLibrary?.topicTotal ?? 0} 条</StageChip>
    </>
  ) : null;

  // ── 报告正文 ──────────────────────────────────────────────────────────────
  const coverage = report?.ipProfile?.coverage;
  const business = report?.ipPositioning?.businessPositioning;
  const content = report?.ipPositioning?.contentPositioning;
  const persona = report?.ipPositioning?.personaPositioning;
  const setup = report?.accountSetup;
  const topicLibrary = report?.topicLibrary;
  // 第二批的三节：**旧报告（第一批）没有它们**，所以这里保持 undefined，整节不渲染。
  const framework: AccountPlanContentFramework | undefined = report?.contentFramework;
  const production: AccountPlanProduction | undefined = report?.production;
  const operations: AccountPlanOperations | undefined = report?.operations;
  // 章节总数按报告自己带的 sections 算（第一批 3 个 / 第二批 6 个），旧报告缺字段时退回 3。
  const sectionTotal = report?.sections?.length || 3;
  // 六 里反复用到的几个派生值先取出来 —— 别在 JSX 属性里连写五层可选链。
  const platform = operations?.platformStrategy;
  const publishingBenchmark = platform?.publish?.benchmark;
  const contentMix = operations?.contentMix;
  const missingInputs = report?.missingInputs || [];
  const warnings = report?.warnings || [];
  /**
   * Agent 降级时把**真实错误**带出来。
   * 与 1.2 同样的修法（HANDOFF §4.3.1）：后端本来就把错误码与消息写进了 `warnings`，
   * 界面写一句固定文案只会让人去翻 DevTools。「规则兜底」还必须说清哪几节不可信。
   */
  const fallbackWarning = warnings.find(item => item?.error || item?.code);
  const fallbackWarningText = fallbackWarning
    ? `${fallbackWarning.code ? `[${fallbackWarning.code}] ` : ""}${fallbackWarning.error || ""}`.trim()
    : "";
  const categories = (content?.classification?.categories || []).filter(category => !isAccountPlanReviewCategory(category));
  const audienceDimensions = business?.audienceDimensions || [];
  const contentDirections = business?.contentDirections || [];
  const monetizationProducts = business?.monetization?.products || [];
  const monetizationPath = business?.monetization?.path || [];
  const personality = persona?.personality;
  const memoryAnchors = persona?.memoryAnchors || [];
  const trio = setup?.trio || [];
  const bioPlatforms = setup?.bio?.platforms || [];
  const frequentTags = content?.frequentTags || [];
  // 后端固定按 方法一/二/三 的顺序返回；按 key 取而不是按下标取，将来加方法时不会错位。
  const methods = topicLibrary?.methods || [];
  const benchmarkMethod = methods.find(item => item.key === "benchmark") || null;
  const questionMethod = methods.find(item => item.key === "questions") || null;
  const trendMethod = methods.find(item => item.key === "trends") || null;
  // 方法一(a) 的同赛道对标账号：客户档案里登记了几个就填几个（等级由后端给 evidence），
  // 没有登记时后端仍落 manual + 占位说明，这时才回退成琥珀色的人工补充位。
  const sameTrack = benchmarkMethod?.sameTrackAccounts || null;
  const sameTrackItems = sameTrackItemsOf(sameTrack);
  // 规格外的方法（后端将来新增时）照样列出来，不静默丢掉。
  const otherMethods = methods.filter(item => !["benchmark", "questions", "trends"].includes(item.key));
  /**
   * 热点时效性提示。取后端随报告给的那一句（`HOT_TOPIC_DISCLAIMER`）——
   * 前端不另存一份文案，后端改了这里跟着变；条目自带的 `timelinessNote` 是同一句，用来兜底。
   */
  const trendDisclaimer = trendMethod?.disclaimer
    || (trendMethod?.groups || []).flatMap(group => group.items || []).find(item => item.timelinessNote)?.timelinessNote
    || "";
  const originalRequests = [
    { label: "账号定位", value: report?.customer?.ipPositioning || "" },
    { label: "内容需求", value: report?.customer?.contentNeeds || "" },
    { label: "备注", value: report?.customer?.notes || "" },
    { label: "名册里登记的对标账号", value: (report?.customer?.benchmarkAccounts || "").replace(/\s*\n\s*/g, "、") },
  ].filter(item => item.value);

  const stageBody = (
    <>
      {!embedded && (
        <header className="flex flex-col gap-5 border-b border-slate-200/80 pb-7 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <button type="button" onClick={() => navigate("/manager")} className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-slate-500 transition hover:text-slate-900"><ArrowLeft className="h-4 w-4" />返回项目经理工作台</button>
            <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600"><span className="h-2 w-2 rounded-full bg-blue-600" /> ACCOUNT PLAN</div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">账号定位</h1>
          </div>
          <div className="flex items-center gap-3 self-start sm:self-auto"><div className="hidden text-right sm:block"><div className="text-sm font-medium text-slate-800">{user?.name || user?.email || "项目经理"}</div><div className="mt-1 text-xs text-slate-400">项目经理账号</div></div><button type="button" onClick={handleLogout} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-500 transition hover:border-slate-300 hover:text-slate-900">退出登录</button></div>
        </header>
      )}

      <div className={embedded ? "" : "mt-7"}>
        <StageShell
          hasResult={Boolean(report)}
          loading={loading}
          error={error}
          summary={summaryChips}
          setup={stageSetup}
          result={
            // 这里的判空不能删：result 的 JSX 是在本组件渲染时就被求值的，
            // StageShell 内部的 hasResult 拦不住 report.xxx。report 初始为 null，
            // 少了这层保护，一进入本模块就抛 TypeError、整页白屏（§6.4⑱）。
            report && (
              <>
                {/* 报告头：客户 / 对标账号 / 1.2 报告来源 / 覆盖率 / 缺失输入 / 告警 */}
                <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="bg-slate-950 px-5 py-5 text-white sm:px-7 sm:py-6">
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                          <span>{report.customer?.occupation || "职业未填写"}</span>
                          <span className="text-slate-600">/</span>
                          <span>{report.batchLabel || "第 1 批"}</span>
                          <span className={`rounded-full px-2 py-0.5 ${report.analysisSource === "agent" ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"}`}>{report.analysisSource === "agent" ? "Agent 分析" : "规则兜底"}</span>
                        </div>
                        <h2 className="mt-3 break-words text-2xl font-semibold tracking-tight">{report.customer?.name || "未命名客户"}</h2>
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                          <span>对标账号：</span>
                          <span className="text-slate-200">{report.benchmark?.accountName || "未识别对标账号"}</span>
                          {report.benchmark?.accountUrl && (
                            <a href={report.benchmark.accountUrl} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate hover:text-white"><Link2 className="h-3.5 w-3.5 shrink-0" />{report.benchmark.accountUrl}</a>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{coverage?.filledCount ?? 0}</div><div className="mt-1 text-xs text-slate-400">档案已填字段</div></div>
                        <div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{report.dataCoverage?.producedSectionCount ?? 0} / {sectionTotal}</div><div className="mt-1 text-xs text-slate-400">章节有内容</div></div>
                        <div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{topicLibrary?.topicTotal ?? 0}</div><div className="mt-1 text-xs text-slate-400">选题条数</div></div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4 px-5 py-5 sm:px-7">
                    {/* 规则兜底：必须把真实错误带出来 */}
                    {report.analysisSource !== "agent" && (
                      <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
                        <div>本次是「规则兜底」结果（Agent 未返回有效报告）：只保留能从输入核对的部分 —— 一、IP定位 / 二、账号搭建 / 三、视频选题库以及四、五、六 的正文务必人工补齐后再用；六 里的「起号策略」与「数据复盘重点」是固定模板，照常输出。</div>
                        {fallbackWarningText && (
                          <div className="mt-1.5 break-words font-mono text-[11px] leading-4 text-amber-600">Agent 返回的错误：{fallbackWarningText}</div>
                        )}
                      </div>
                    )}

                    {/* 缺失输入：下面每一处「待人工补充」几乎都能在这里找到原因 */}
                    {missingInputs.length > 0 && (
                      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3.5">
                        <div className="flex items-center gap-2 text-sm font-semibold text-amber-800"><AlertTriangle className="h-4 w-4" />缺失输入（{missingInputs.length} 项）</div>
                        <p className="mt-1.5 text-xs leading-5 text-amber-700">
                          下列输入本次没有拿到。报告里标着「Agent 推断」或「待人工补充」的字段，绝大多数就是缺了它们 —— 补齐后重新生成即可升级为「输入证据」。
                        </p>
                        <ul className="mt-3 space-y-2">
                          {missingInputs.map(item => (
                            <li key={item.key} className="rounded-xl bg-white/70 px-3.5 py-2.5 text-xs leading-5 text-amber-800">
                              <span className="font-semibold">{item.label || item.key}</span>
                              <span className="ml-1.5 text-amber-700">{item.note}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="grid gap-3 lg:grid-cols-2">
                      <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
                        <span className="font-semibold text-slate-600">IP 档案覆盖率：</span>
                        已填 {coverage?.filledCount ?? 0} 项 / 共 {coverage?.totalCount ?? 0} 项（空 {coverage?.emptyCount ?? 0} 项）。{coverage?.note || ""}
                      </div>
                      <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
                        <span className="font-semibold text-slate-600">1.2 报告来源：</span>{report.benchmark?.source || "未记录"}。
                        {report.benchmark?.accountName ? `账号《${report.benchmark.accountName}》` : ""}
                        {report.benchmark?.analyzedAt ? `，分析于 ${formatReportTime(report.benchmark.analyzedAt)}` : ""}。
                        {report.benchmark?.evidenceNote || ""}
                      </div>
                    </div>

                    {/* 客户当初要的是什么：原样带出来，方便对着审核这份方案 */}
                    {originalRequests.length > 0 && (
                      <div className="rounded-xl border border-slate-200 px-4 py-3">
                        <div className="text-xs font-semibold tracking-wide text-slate-400">客户名册里的原始诉求（客户方一手输入，可作引文依据）</div>
                        <dl className="mt-2 space-y-1.5">
                          {originalRequests.map(item => (
                            <div key={item.label} className="flex flex-wrap gap-x-2 text-xs leading-5">
                              <dt className="shrink-0 font-medium text-slate-500">{item.label}：</dt>
                              <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-700">{item.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    )}

                    {/* 全部告警收进可展开条目：报告头只放最要紧的那条真实错误 */}
                    {warnings.length > 0 && (
                      <StageDisclosure label="自动告警" meta={`${warnings.length} 条`}>
                        <ul className="space-y-2">
                          {warnings.map((item, index) => (
                            <li key={`${item.code || "warning"}-${index}`} className="rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs leading-5 text-slate-600">
                              {item.code && <span className="mr-1.5 font-mono text-[11px] text-slate-400">[{item.code}]</span>}
                              {item.error || ""}
                            </li>
                          ))}
                        </ul>
                      </StageDisclosure>
                    )}
                  </div>
                </section>

                {/* 一、IP定位 */}
                <section className="space-y-4">
                  <SectionHeader
                    icon={Target}
                    title={ACCOUNT_PLAN_SECTION_LABELS.ipPositioning}
                    hint="商业定位、内容定位、人设定位三块。每个字段右上角的徽章标明证据等级：标「输入证据」的能对回客户档案或 1.2 报告，标「Agent 推断」的只是推断，标「待人工补充」的需要项目经理自己补。"
                  />

                  {/* 1、商业定位 */}
                  <div className="space-y-4">
                    <SubHeading index="1" title="商业定位" hint="先定人群与痛点，再定内容方向，最后才是变现转化 —— 顺序反了，转化路径就是硬凑的。" />
                    <LevelFieldCard
                      title="目标人群"
                      field={business?.targetAudience}
                      emptyHint="待人工补充：客户档案里没有画像字段、1.2 报告也推不出来，目标人群需要项目经理向客户确认后自己补。"
                    />

                    <div>
                      <div className="mb-3 text-sm font-semibold text-slate-800">目标人群维度</div>
                      <TableShell head={["维度", "档案里的值", "结论", "证据等级"]} minWidth="min-w-[860px]">
                        {audienceDimensions.map(item => (
                          <tr key={item.key || item.label} className="align-top">
                            <td className="px-4 py-3 text-sm font-medium text-slate-700">{item.label || item.key}</td>
                            <td className="px-4 py-3 text-sm leading-6">
                              {item.profileValue
                                ? <span className="text-slate-800">{item.profileValue}</span>
                                : <span className="text-slate-400">档案未填写</span>}
                              {/* 来源字段一并给出：项目经理才知道该去档案里补哪一项 */}
                              <div className="mt-1 font-mono text-[10px] text-slate-400">{item.sourceKey}</div>
                            </td>
                            <td className="px-4 py-3 text-sm leading-6 text-slate-600">
                              {item.text || <span className="text-slate-400">待人工补充</span>}
                              {/* 档案字段为空时后端会给一句 note，说明这里的一手依据是什么（名册补充说明 / 没有） */}
                              {item.note && <div className="mt-1.5 text-xs leading-5 text-amber-700">{item.note}</div>}
                            </td>
                            <td className="px-4 py-3"><LevelTag level={item.level} label={item.levelLabel} /></td>
                          </tr>
                        ))}
                      </TableShell>
                    </div>

                    <LevelFieldCard
                      title="核心痛点"
                      field={business?.corePain}
                      emptyHint="待人工补充：核心痛点没有可直接引用的输入，需要项目经理向客户确认后自己补。"
                    />

                    <div>
                      <div className="mb-3 text-sm font-semibold text-slate-800">核心内容方向（{contentDirections.length} 个）</div>
                      {contentDirections.length === 0 ? (
                        <EmptyHint text="这份报告没有给出核心内容方向，待人工补充。" />
                      ) : (
                        <div className="space-y-2">
                          {contentDirections.map((item, index) => (
                            <GradedText
                              key={`${item.name}-${index}`}
                              text={item.name}
                              basis={item.basis}
                              level={item.level}
                              levelLabel={item.levelLabel}
                              extra={item.description ? <p className="mt-1.5 text-xs leading-5 text-slate-500">{item.description}</p> : null}
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 变现转化：产品分层 + 路径逐步校验 */}
                    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-900">变现转化</div>
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">{monetizationProducts.length} 个产品 · {monetizationPath.length} 步路径</span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-500">按引流 / 信任 / 核心 / 利润四层列出产品。定价没有输入依据时一律显示「待人工补充」，不拿编造的价位冒充调研结论。</p>
                      {(business?.monetization?.tierGuide || []).length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(business?.monetization?.tierGuide || []).map(item => (
                            <span key={item.tier} className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] leading-4 text-slate-500">
                              <span className="font-semibold text-slate-600">{item.tier}</span>：{item.role}（{item.pricing}）
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="mt-4">
                        {monetizationProducts.length === 0 ? (
                          <EmptyHint text="这份报告没有给出变现产品，待人工补充。" />
                        ) : (
                          <TableShell head={["层级", "产品", "定价", "定位", "在变现路径中的作用", "证据等级"]} minWidth="min-w-[980px]">
                            {monetizationProducts.map((item, index) => (
                              <tr key={`${item.product}-${index}`} className="align-top">
                                <td className="px-4 py-3 text-sm font-medium text-slate-700">{item.tier || "-"}</td>
                                <td className="px-4 py-3 text-sm font-medium text-slate-800">{item.product || <span className="text-slate-400">待人工补充</span>}</td>
                                <td className="px-4 py-3 text-sm leading-6">
                                  {item.price
                                    ? <span className="font-medium text-slate-800">{item.price}</span>
                                    : <span className="text-slate-400">{item.priceNote || "输入中没有定价依据，待人工补充"}</span>}
                                </td>
                                <td className="px-4 py-3 text-sm leading-6 text-slate-600">{item.positioning || <span className="text-slate-400">待人工补充</span>}</td>
                                <td className="px-4 py-3 text-sm leading-6 text-slate-600">{item.role || <span className="text-slate-400">待人工补充</span>}</td>
                                <td className="px-4 py-3"><LevelTag level={item.level} label={item.levelLabel} /></td>
                              </tr>
                            ))}
                          </TableShell>
                        )}
                      </div>

                      <div className="mt-5">
                        <div className="text-sm font-semibold text-slate-800">变现路径</div>
                        <p className="mt-1 text-xs leading-5 text-slate-500">每一步都要写成「通过xx方法——使用户产生xx行为，购买/获得xx产品」。句式不合规的<span className="font-semibold">保留原文、只标出要改哪一步</span>，不会整条丢掉。</p>
                        {monetizationPath.length === 0 ? (
                          <p className="mt-2 text-xs leading-5 text-slate-400">这份报告没有给出变现路径，待人工补充。</p>
                        ) : (
                          <ol className="mt-3 space-y-2">
                            {monetizationPath.map((item, index) => (
                              <li key={`${item.step}-${index}`} className={`rounded-xl border px-4 py-3 shadow-sm ${item.patternOk === false ? "border-amber-200 bg-amber-50/60" : "border-slate-200 bg-white"}`}>
                                <div className="flex gap-3">
                                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-slate-950 text-[11px] font-semibold text-white">{item.step}</span>
                                  <span className="min-w-0 flex-1 text-sm leading-6 text-slate-700">{item.description}</span>
                                  <LevelTag level={item.level} label={item.levelLabel} />
                                </div>
                                {item.patternOk === false && (
                                  <p className="mt-2 flex items-start gap-1.5 pl-9 text-xs leading-5 text-amber-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{item.patternNote || "未按标准句式书写，需人工改写。"}</p>
                                )}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                      {business?.monetization?.note && <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">{business.monetization.note}</p>}
                    </div>
                  </div>

                  {/* 2、内容定位 */}
                  <div className="space-y-4">
                    <SubHeading index="2" title="内容定位" hint="核心内容定位来自 Agent；下面的选题库是 1.2 报告的原样透传，本模块不重跑分类。" />
                    <LevelFieldCard title="核心内容定位" field={content?.core} emptyHint="待人工补充：没有可透传的分类产出时，内容定位需要项目经理自己定。" />

                    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-900">选题库建立（透传 1.2 报告）</div>
                        <span className="rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700">{content?.classification?.source || "原样透传 1.2 报告"}</span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">大类 {content?.classification?.categoryCount ?? 0} 个</span>
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">小类 {content?.classification?.subcategoryCount ?? 0} 个</span>
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">选题 {content?.classification?.topicTotal ?? 0} 条</span>
                        {content?.classification?.contentStyleLabel && <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">{content.classification.contentStyleLabel}</span>}
                      </div>
                      {content?.classification?.recomputeNote && <p className="mt-3 text-xs leading-5 text-slate-500">{content.classification.recomputeNote}</p>}
                      {content?.classification?.summary && <p className="mt-2 text-sm leading-6 text-slate-700">{content.classification.summary}</p>}
                    </div>

                    {categories.length === 0 ? (
                      <EmptyHint text="这份报告没有带回内容大类（1.2 的分类产出缺失），选题库待人工补充。" />
                    ) : categories.map((category, index) => (
                      <ClassificationCategoryBlock key={category.id || `${category.name}-${index}`} category={category} index={index} />
                    ))}

                    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Hash className="h-4 w-4 text-blue-600" />高频标签</div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">{content?.frequentTagsNote || "高频标签来自 1.2 报告，原样透传，不重算。"}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {frequentTags.length === 0 ? (
                          <span className="text-xs text-slate-400">1.2 报告里没有可透传的高频标签。</span>
                        ) : frequentTags.map((item, index) => (
                          <span key={`${item.tag}-${index}`} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700">
                            <span className="font-medium">#{String(item.tag || "").replace(/^#+/, "")}</span>
                            <span className="text-slate-400">{item.count ?? 0} 条 · {item.percentage ?? 0}%</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* 3、人设定位 */}
                  <div className="space-y-4">
                    <SubHeading index="3" title="人设定位" hint="角色定位、5 个性格关键词与三类记忆锚点。关键词数量不足时如实标出差额，不自动补齐。" />
                    <LevelFieldCard title="角色定位" field={persona?.role} emptyHint="待人工补充：客户档案里的身份信息为空时，角色定位无从谈起。" />

                    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-900">性格关键词</div>
                        <span className={`rounded-full px-3 py-1.5 text-xs font-medium ${(personality?.count ?? 0) >= (personality?.expectedCount ?? 0) ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                          {personality?.count ?? 0} / {personality?.expectedCount ?? 0} 个
                        </span>
                      </div>
                      {personality?.note && <p className="mt-2 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">{personality.note}</p>}
                      <div className="mt-3 grid gap-2 lg:grid-cols-2">
                        {(personality?.keywords || []).length === 0 ? (
                          <div className="lg:col-span-2"><EmptyHint text="这份报告没有给出性格关键词，待人工补充。" /></div>
                        ) : (personality?.keywords || []).map((item, index) => (
                          <div key={`${item.keyword}-${index}`} className="rounded-xl border border-slate-200 px-4 py-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="rounded-md bg-slate-950 px-2.5 py-1 text-xs font-semibold text-white">{item.keyword}</span>
                              <LevelTag level={item.level} label={item.levelLabel} />
                            </div>
                            <p className={`mt-2 text-sm leading-6 ${item.expression ? "text-slate-700" : "text-slate-400"}`}>{item.expression || "未给出表达方式，待人工补充。"}</p>
                            {(item.basis || []).length > 0 && <p className="mt-1.5 text-xs leading-5 text-slate-400">依据：{(item.basis || []).join("；")}</p>}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-3 text-sm font-semibold text-slate-800">IP 记忆锚点</div>
                      <div className="grid gap-3 lg:grid-cols-3">
                        {memoryAnchors.map(anchor => (
                          <article key={anchor.key} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                              <span className="text-sm font-semibold text-slate-900">{anchor.label}</span>
                              <span className="text-[11px] text-slate-400">{anchor.count ?? 0} 条</span>
                            </div>
                            <p className="mt-1.5 text-xs leading-5 text-slate-500">{anchor.dimension} · 对应{anchor.fits}</p>
                            <div className="mt-3 space-y-2">
                              {(anchor.items || []).length === 0 ? (
                                <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-3.5 py-3 text-xs leading-5 text-slate-400">{anchor.note || "本类锚点暂无内容，待人工补充。"}</p>
                              ) : (anchor.items || []).map((item, index) => (
                                <GradedText key={`${anchor.key}-${index}`} text={item.text} basis={item.basis} level={item.level} levelLabel={item.levelLabel} />
                              ))}
                            </div>
                            {anchor.template && (
                              <p className="mt-3 rounded-xl bg-slate-50 px-3.5 py-2.5 text-xs leading-5 text-slate-600">
                                <span className="font-semibold text-slate-700">建议句式：</span>{anchor.template}
                              </p>
                            )}
                          </article>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                {/* 二、账号搭建 */}
                <section className="space-y-4">
                  <SectionHeader
                    icon={UserRound}
                    title={ACCOUNT_PLAN_SECTION_LABELS.accountSetup}
                    hint="账号三件套与两版账号简介（视频号在前、抖音在后）。简介严格按四行结构给候选，行内候选的优先顺序由后端随报告给出。"
                  />

                  <div className="space-y-4">
                    <SubHeading index="1" title="账号三件套" hint="名字、头像、背景图各一张卡；头像与背景图必须写清具体场景，否则客户拿到手没法执行。" />
                    <div className="grid gap-3 lg:grid-cols-3">
                      {trio.map(item => (
                        <article key={item.key} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                          <div className="flex items-start justify-between gap-3">
                            <div className="text-sm font-semibold text-slate-900">{item.label}</div>
                            <LevelTag level={item.level} label={item.levelLabel} />
                          </div>
                          <p className="mt-1.5 text-xs leading-5 text-slate-500">{item.rule}</p>
                          {String(item.text || "").trim() ? (
                            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">{item.text}</p>
                          ) : (
                            <p className="mt-3 rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-3.5 py-3 text-xs leading-5 text-slate-400">待人工补充：这一项没有可用依据。</p>
                          )}
                          {(item.basis || []).length > 0 && <p className="mt-2 text-xs leading-5 text-slate-400">依据：{(item.basis || []).join("；")}</p>}
                        </article>
                      ))}
                    </div>
                    <p className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
                      <span className="font-semibold">关于照片：</span>{setup?.photoNote || "输入里没有客户照片，头像只能给拍摄与着装建议。"}
                    </p>
                  </div>

                  <div className="space-y-4">
                    <SubHeading index="2" title="账号简介" hint={setup?.bio?.structureNote || "严格按四行结构输出，每行给出多个候选供项目经理挑选。"} />
                    {bioPlatforms.length === 0 ? (
                      <EmptyHint text="这份报告没有带回账号简介，待人工补充。" />
                    ) : bioPlatforms.map(platform => (
                      <div key={platform.key} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-slate-900">{platform.label}</div>
                          <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">{platform.candidateCount ?? 0} 条候选</span>
                        </div>
                        <div className="mt-4 space-y-3">
                          {(platform.rows || []).map(row => (
                            // 四行是固定结构：没有候选也要照样列出来，缺哪一行让人一眼看见（不能隐藏）。
                            <div key={row.key || row.row} className={`rounded-xl border px-4 py-3.5 ${row.candidateCount > 0 ? "border-slate-200" : "border-dashed border-slate-200 bg-slate-50/60"}`}>
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-slate-950 text-[11px] font-semibold text-white">{row.row}</span>
                                <span className="text-sm font-semibold text-slate-800">{row.label}</span>
                                {row.candidateCount === 0 && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">待人工补充</span>}
                              </div>
                              <p className="mt-1.5 text-xs leading-5 text-slate-500">{row.rule}</p>
                              {(row.priority || []).length > 0 && (
                                <p className="mt-1.5 text-[11px] leading-4 text-slate-400">优先顺序：{(row.priority || []).join(" → ")}</p>
                              )}
                              <div className="mt-2.5 space-y-2">
                                {(row.candidates || []).length === 0 ? (
                                  <p className="text-xs leading-5 text-slate-400">{row.note || "本行暂无候选，待人工补充。"}</p>
                                ) : (row.candidates || []).map((candidate, index) => (
                                  <GradedText key={`${row.key}-${index}`} text={candidate.text} basis={candidate.basis} level={candidate.level} levelLabel={candidate.levelLabel} />
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {/* 三、视频选题库 */}
                <section className="space-y-4">
                  <SectionHeader
                    icon={Layers3}
                    title={ACCOUNT_PLAN_SECTION_LABELS.topicLibrary}
                    hint={topicLibrary?.classificationTopicNote || "「选题库建立」的正式产出是 1.2 报告的分类选题库，这里只是透传，不重跑分类。"}
                  />
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-blue-50 px-3 py-1.5 font-medium text-blue-700">共 {topicLibrary?.topicTotal ?? 0} 条</span>
                    <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">1.2 分类选题库 {topicLibrary?.classificationTopicTotal ?? 0} 条</span>
                  </div>
                  {topicLibrary?.summary && <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">{topicLibrary.summary}</p>}

                  {/* 方法一：对标账号 */}
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><ClipboardCheck className="h-4 w-4 text-blue-600" />{benchmarkMethod?.label || "方法一：对标账号"}</div>
                      <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">{benchmarkMethod?.topicCount ?? 0} 条</span>
                    </div>
                    {benchmarkMethod?.note && <p className="mt-2 text-xs leading-5 text-slate-500">{benchmarkMethod.note}</p>}
                    {benchmarkMethod?.duplicateCount ? <p className="mt-1.5 text-xs leading-5 text-slate-400">已按标题去重 {benchmarkMethod.duplicateCount} 条重复项。</p> : null}

                    {/* 同赛道对标账号：客户档案里登记了就照实列出来（后端标 evidence），
                        一条都没有才是人工补充位。Agent 自己提议的账号后端一律丢弃，这里只如实转述。 */}
                    {sameTrack && (sameTrackItems.length > 0 ? (
                      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-xs font-semibold text-slate-700">同赛道对标账号（来自客户档案登记）</span>
                          <LevelTag level={sameTrack.level} label={sameTrack.levelLabel} />
                          <span className="text-xs text-slate-400">{sameTrack.count} 个</span>
                        </div>
                        <ul className="mt-2 space-y-1.5">
                          {sameTrackItems.map((item, index) => (
                            <li key={`${item.title || "account"}-${index}`} className="flex min-w-0 items-start gap-1.5 text-xs leading-5">
                              <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                              {item.url ? (
                                <a href={item.url} target="_blank" rel="noreferrer" title={item.title || item.url} className="min-w-0 truncate text-blue-600 hover:underline">{item.title || item.url}</a>
                              ) : (
                                <span className="min-w-0 truncate text-slate-700" title={item.title}>{item.title}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                        <p className="mt-1.5 text-xs leading-5 text-slate-500">{sameTrack.note}</p>
                        {sameTrack.discardedCount > 0 && (
                          <p className="mt-1.5 text-xs leading-5 text-amber-700">本次丢掉了 {sameTrack.discardedCount} 条无法核对的账号建议，未写入报告。</p>
                        )}
                      </div>
                    ) : (
                      <div className="mt-3 rounded-xl border border-dashed border-amber-300 bg-amber-50 px-4 py-3.5">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-xs font-semibold text-amber-800">同赛道对标账号（人工补充位）</span>
                          <LevelTag level={sameTrack.level} label={sameTrack.levelLabel} />
                        </div>
                        <p className="mt-1.5 text-xs leading-5 text-amber-700">{sameTrack.note}</p>
                        {sameTrack.discardedCount > 0 && (
                          <p className="mt-1.5 text-xs leading-5 text-amber-700">本次丢掉了 {sameTrack.discardedCount} 条无法核对的账号建议，未写入报告。</p>
                        )}
                      </div>
                    ))}
                    <div className="mt-3">
                      <TopicEntryList topics={benchmarkMethod?.topics || []} emptyText="方法一暂时没有选题，待人工补充。" />
                    </div>
                  </div>

                  {/* 方法二：客户提问整理 */}
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><HelpCircle className="h-4 w-4 text-blue-600" />{questionMethod?.label || "方法二：客户提问整理"}</div>
                      <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">{questionMethod?.topicCount ?? 0} 条</span>
                    </div>
                    {questionMethod?.note && <p className="mt-2 text-xs leading-5 text-slate-500">{questionMethod.note}</p>}
                    {questionMethod?.duplicateCount ? <p className="mt-1.5 text-xs leading-5 text-slate-400">已按标题去重 {questionMethod.duplicateCount} 条重复项。</p> : null}
                    <div className="mt-3">
                      <TopicEntryList topics={questionMethod?.topics || []} emptyText="方法二暂时没有选题，待人工补充。" />
                    </div>
                  </div>

                  {/* 方法三：蹭热点 —— 时效性提示必须显示 */}
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Flame className="h-4 w-4 text-blue-600" />{trendMethod?.label || "方法三：蹭热点"}</div>
                      <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">{trendMethod?.topicCount ?? 0} 条</span>
                    </div>
                    {trendMethod?.note && <p className="mt-2 text-xs leading-5 text-slate-500">{trendMethod.note}</p>}
                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
                      <span className="font-semibold">时效性提示：</span>
                      {trendDisclaimer || "这份报告没有带回热点时效性提示，使用前请人工核实。"}
                    </div>
                    <div className="mt-4 space-y-4">
                      {(trendMethod?.groups || []).length === 0 ? (
                        <EmptyHint text="这份报告没有给出热点分组，待人工补充。" />
                      ) : (trendMethod?.groups || []).map(group => (
                        <div key={group.key} className="rounded-xl border border-slate-200 px-4 py-3.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-slate-800">{group.label}</span>
                            <span className="text-xs text-slate-400">{group.count ?? 0} 条</span>
                          </div>
                          {(group.items || []).length === 0 ? (
                            <p className="mt-2 text-xs leading-5 text-slate-400">{group.note || "本组暂无内容，待人工补充。"}</p>
                          ) : (
                            <div className="mt-2.5 space-y-2">
                              {(group.items || []).map((item, index) => (
                                <GradedText
                                  key={`${item.topic}-${index}`}
                                  text={item.topic}
                                  basis={item.basis}
                                  level={item.level}
                                  levelLabel={item.levelLabel}
                                  extra={(item.titles || []).length > 0 ? (
                                    <ul className="mt-2 space-y-1.5">
                                      {(item.titles || []).map((title, titleIndex) => (
                                        <li key={`${item.topic}-title-${titleIndex}`} className="flex gap-2 text-xs leading-5 text-slate-600">
                                          <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-300" />标题示例：{title}
                                        </li>
                                      ))}
                                    </ul>
                                  ) : null}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 规格外的方法：后端将来新增方法时照样列出来，不静默丢 */}
                  {otherMethods.map(method => (
                    <div key={method.key} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-900">{method.label || method.key}</div>
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600">{method.topicCount ?? 0} 条</span>
                      </div>
                      {method.note && <p className="mt-2 text-xs leading-5 text-slate-500">{method.note}</p>}
                      <div className="mt-3">
                        <TopicEntryList topics={method.topics || []} emptyText="这一组暂时没有选题，待人工补充。" />
                      </div>
                    </div>
                  ))}
                </section>

                {/* 四、短视频内容框架（第二批：旧报告没有这一节，整节不渲染） */}
                {framework && (
                  <section className="space-y-4">
                    <SectionHeader
                      icon={Clapperboard}
                      title={ACCOUNT_PLAN_SECTION_LABELS.framework}
                      hint={framework.note || "开头 3 秒钩子与结尾钩子各给出 4 种不同类型，供拍摄时直接照用。"}
                    />
                    <HookGroupCard index="1" group={framework.openingHooks} />
                    <HookGroupCard index="2" group={framework.endingHooks} />
                    {framework.summary && <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">{framework.summary}</p>}
                    {/* 1.2 的两块参照收进可展开条目：核对「类型是不是照着对标账号选的」时才看 */}
                    {framework.benchmarkReference && (
                      <StageDisclosure label="1.2 报告里的开头 / 结尾分析（对照用）" meta={framework.benchmarkReference.note ? "原样带出" : ""}>
                        <div className="space-y-3 px-1 py-1">
                          {([[framework.benchmarkReference.threeSeconds, "开头 3 秒分析"], [framework.benchmarkReference.endingHooks, "结尾钩子分析"]] as const).map(([block, label]) => (
                            <div key={label} className="rounded-xl bg-slate-50 px-4 py-3">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-xs font-semibold text-slate-700">{label}</span>
                                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${block?.available ? "bg-emerald-50 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                                  {block?.available ? `样本 ${block?.itemCount ?? 0} 条` : "1.2 报告里没有这一块"}
                                </span>
                              </div>
                              {(block?.topTypes || []).length > 0 && (
                                <p className="mt-1.5 text-xs leading-5 text-slate-600">
                                  最常用：{(block?.topTypes || []).map(item => `${item.typeLabel}（${item.count} 条 · ${item.percentage}%）`).join("、")}
                                </p>
                              )}
                              {block?.analysisReason && <p className="mt-1.5 text-xs leading-5 text-slate-500">{block.analysisReason}</p>}
                              {block?.note && <p className="mt-1.5 text-xs leading-5 text-amber-700">{block.note}</p>}
                            </div>
                          ))}
                        </div>
                      </StageDisclosure>
                    )}
                  </section>
                )}

                {/* 五、拍摄与剪辑建议（第二批） */}
                {production && (
                  <section className="space-y-4">
                    <SectionHeader
                      icon={Video}
                      title={ACCOUNT_PLAN_SECTION_LABELS.production}
                      hint={production.levelCapNote || "本节各项最高只能是「Agent 推断」。"}
                    />
                    {/* ⚠️ 「是建议、不是观测」必须显眼：这是本节的诚实性底线 */}
                    <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-xs leading-5 text-amber-800">
                      <span className="font-semibold">请注意：</span>{production.note}
                    </p>
                    <ProductionGroupCard index="1" group={production.shooting} />
                    <ProductionGroupCard index="2" group={production.editing} />
                    {production.summary && <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">{production.summary}</p>}
                  </section>
                )}

                {/* 六、起号与运营（第二批） */}
                {operations && (
                  <section className="space-y-4">
                    <SectionHeader
                      icon={Rocket}
                      title={ACCOUNT_PLAN_SECTION_LABELS.operations}
                      hint={operations.note || "平台与矩阵策略、起号策略、数据复盘重点、内容配比。"}
                    />

                    {/* 1、平台与矩阵策略 */}
                    <div className="space-y-4">
                      <SubHeading index="1" title="平台与矩阵策略" hint={platform?.note || "主阵地 / 辅阵地结合平台特点、IP 赛道、目标用户与内容定位给出。"} />
                      <div className="grid gap-3 lg:grid-cols-3">
                        <LevelFieldCard title="主阵地" field={platform?.primary} emptyHint="待人工补充：没有给出主阵地，需结合 IP 赛道与目标用户确认。" />
                        <LevelFieldCard title="辅阵地" field={platform?.secondary} emptyHint="待人工补充：没有给出辅阵地。" />
                        <LevelFieldCard title="匹配分析" field={platform?.matchAnalysis} emptyHint="待人工补充：没有给出平台与赛道的匹配分析。" />
                      </div>

                      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                        <div className="text-sm font-semibold text-slate-900">发布时间与频率</div>
                        <p className="mt-1 text-xs leading-5 text-slate-500">固定的发布时间段与发布频率节奏；右上角的等级说明这条建议有没有输入依据。</p>
                        <div className="mt-3 grid gap-3 lg:grid-cols-2">
                          <LevelFieldCard title="发布时间段" field={platform?.publish?.window} emptyHint="待人工补充：没有给出发布时间段。" />
                          <LevelFieldCard title="发布频率" field={platform?.publish?.frequency} emptyHint="待人工补充：没有给出发布频率。" />
                        </div>
                        {platform?.publish?.rhythmNote && <p className="mt-3 text-xs leading-5 text-slate-500">节奏说明：{platform.publish.rhythmNote}</p>}
                        {/* 1.2 的实测发布节奏：等级**沿用 1.2 自己的判定**，前端照抄 */}
                        {publishingBenchmark && (
                          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-xs font-semibold text-slate-700">1.2 报告里的实测发布节奏</span>
                              <LevelTag level={publishingBenchmark.level} label={publishingBenchmark.levelLabel} />
                              <span className="text-xs text-slate-400">样本 {publishingBenchmark.videoCount ?? 0} 条 · 有日期 {publishingBenchmark.datedCount ?? 0} 条</span>
                            </div>
                            {publishingBenchmark.available ? (
                              <p className="mt-1.5 text-xs leading-5 text-slate-600">
                                跨度 {publishingBenchmark.spanDays ?? 0} 天 · 约 {publishingBenchmark.perWeek ?? 0} 条/周
                                {(publishingBenchmark.weekdayDistribution || []).filter(item => item.count > 0).length > 0
                                  && ` · 分布：${(publishingBenchmark.weekdayDistribution || []).filter(item => item.count > 0).map(item => `${item.weekday} ${item.count} 条`).join("、")}`}
                                {publishingBenchmark.hasTimeOfDay ? "" : "（样本只带日期、不带时刻，具体时段待人工补充）"}
                              </p>
                            ) : (
                              <p className="mt-1.5 text-xs leading-5 text-amber-700">{publishingBenchmark.missingNote}</p>
                            )}
                            {publishingBenchmark.note && <p className="mt-1.5 text-xs leading-5 text-slate-500">{publishingBenchmark.note}</p>}
                            {publishingBenchmark.analysis && <p className="mt-1.5 text-xs leading-5 text-slate-600">节奏分析：{publishingBenchmark.analysis}</p>}
                            <p className="mt-1.5 text-xs leading-5 text-slate-400">{publishingBenchmark.sourceNote}</p>
                          </div>
                        )}
                      </div>

                      {/* 两类引流话术：目的 + 引流导向 + 可直接用的话术 */}
                      <div className="grid gap-3 lg:grid-cols-2">
                        {(platform?.trafficScripts?.types || []).map(item => (
                          <article key={item.key} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                                {item.key === "follow" ? <UserPlus className="h-4 w-4 text-blue-600" /> : <MessageCircle className="h-4 w-4 text-blue-600" />}
                                {item.label || item.key}
                              </div>
                              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{item.scriptCount ?? 0} 条</span>
                            </div>
                            {item.rule && <p className="mt-1.5 text-xs leading-5 text-slate-500">{item.rule}</p>}
                            {item.purpose && <p className="mt-2 text-xs leading-5 text-slate-600"><span className="font-semibold text-slate-700">目的：</span>{item.purpose}</p>}
                            {item.direction && <p className="mt-1 text-xs leading-5 text-slate-600"><span className="font-semibold text-slate-700">引流导向：</span>{item.direction}</p>}
                            <div className="mt-3 space-y-2">
                              {(item.scripts || []).length === 0 ? (
                                <p className="text-xs leading-5 text-slate-400">{item.note || "这一类暂无可直接使用的话术，待人工补充。"}</p>
                              ) : (item.scripts || []).map((script, index) => (
                                <GradedText key={`${item.key}-${index}`} text={script.text} basis={script.basis} level={script.level} levelLabel={script.levelLabel} />
                              ))}
                            </div>
                          </article>
                        ))}
                      </div>
                      {platform?.trafficScripts?.benchmark && (
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3.5 text-xs leading-5 text-slate-500">
                          <span className="font-semibold text-slate-600">1.2 报告里的引流话术（等级沿用 1.2 自己的判定）：</span>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <span>简介：{platform.trafficScripts.benchmark.bio?.text || "1.2 报告里这一项没有内容"}</span>
                            <LevelTag level={platform.trafficScripts.benchmark.bio?.level} label={platform.trafficScripts.benchmark.bio?.levelLabel} />
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <span>评论区：{platform.trafficScripts.benchmark.comments?.text || "1.2 报告里这一项没有内容"}</span>
                            <LevelTag level={platform.trafficScripts.benchmark.comments?.level} label={platform.trafficScripts.benchmark.comments?.levelLabel} />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* 2、起号策略（通用模板，固定四步） */}
                    {operations.launchPlan && (
                      <div className="space-y-3">
                        <SubHeading index="2" title="起号策略" hint="固定四步模板，模型改不了也加不了条目。" />
                        <TemplateTableCard
                          label={operations.launchPlan.label || "起号策略"}
                          note={operations.launchPlan.note}
                          source={operations.launchPlan.source}
                          headers={["步骤", "具体操作"]}
                          rows={(operations.launchPlan.steps || []).map(step => [`${step.step}. ${step.name || ""}`, step.action || ""])}
                        />
                      </div>
                    )}

                    {/* 3、数据复盘重点（通用模板，固定四维） */}
                    {operations.reviewPlan && (
                      <div className="space-y-3">
                        <SubHeading index="3" title="数据复盘重点" hint="固定四维模板，模型改不了也加不了条目。" />
                        <TemplateTableCard
                          label={operations.reviewPlan.label || "数据复盘重点"}
                          note={operations.reviewPlan.note}
                          source={operations.reviewPlan.source}
                          headers={["复盘维度", "关注什么"]}
                          rows={(operations.reviewPlan.dimensions || []).map(item => [item.label || item.key || "", item.focus || ""])}
                        />
                      </div>
                    )}

                    {/* 4、内容配比（占比由后端按大类重算，每个时期合计恰好 100） */}
                    <div className="space-y-3">
                      <SubHeading index="4" title="内容配比" hint={contentMix?.recomputeNote || "占比由后端按大类重算，每个时期合计恰好 100。"} />
                      {contentMix?.note && <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">{contentMix.note}</p>}
                      {(contentMix?.unmatchedCount ?? 0) > 0 && <p className="text-xs leading-5 text-amber-700">{contentMix?.unmatchedNote}</p>}
                      <div className="grid gap-3 lg:grid-cols-3">
                        {(contentMix?.periods || []).map(period => <ContentMixPeriodCard key={period.key} period={period} />)}
                      </div>
                    </div>

                    {operations.summary && <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">{operations.summary}</p>}
                  </section>
                )}

                {/* 保存 / 复制 / 导出。三个按钮都要 in-flight 守卫，否则双击会存出重复记录（§6.4㉑）。 */}
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><CheckCircle2 className="h-4 w-4 text-blue-600" />保存账号定位</div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">保存当前结果，供账号搭建与选题执行读取。导出文档会逐项带上证据等级，别人拿到时才知道哪些是推断。</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={copyReport} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900">{copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}{copied ? "已复制" : "复制 Markdown"}</button>
                      <button type="button" onClick={exportReport} disabled={!report || exporting} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-50">{exporting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : exported ? <Check className="h-4 w-4 text-emerald-600" /> : <FileText className="h-4 w-4" />}{exporting ? "导出中…" : exported ? "已导出" : "导出 Word"}</button>
                      <button type="button" onClick={saveReport} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-50">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{saving ? "保存中…" : "保存报告"}</button>
                    </div>
                  </div>
                  {message && <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-3.5 py-3 text-xs text-emerald-700"><CheckCircle2 className="h-4 w-4" />{message}</div>}
                </section>
              </>
            )
          }
        />
      </div>
    </>
  );

  if (embedded) return <>{stageBody}</>;

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-900">
      <div className="mx-auto max-w-[1500px] px-5 py-6 sm:px-8 lg:px-10 lg:py-9">{stageBody}</div>
    </main>
  );
}
