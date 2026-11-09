import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, RotateCcw, SlidersHorizontal } from "lucide-react";

/**
 * 账号定位各阶段共用的外壳。
 *
 * 这些阶段是「先配置、再出结果」的顺序流程，输入和结果不会同时有用：
 *
 *   - 没有结果时：配置面板本身就是空态。页面是单列居中的，右栏根本不存在，
 *     所以不会出现一个悬在旁边、只能写着「等待生成」的占位框。
 *   - 有结果时：配置面板收成一行摘要（保留「修改输入」入口），报告占满整个宽度。
 *
 * 因此布局由 hasResult 驱动，而不是固定的「左栏输入 + 右栏输出」双栏。
 * 之前 360px 侧栏在两种状态下都是错的：无结果时它把空白框衬得更突兀，
 * 有结果时它又全程占着横向空间。
 */
// 配置面板的居中列宽。太窄会在宽屏上被两侧留白淹没，太宽又会让表单的输入行拉得过长。
const SETUP_COLUMN = "mx-auto w-full max-w-5xl";

export type StageShellProps = {
  hasResult: boolean;
  /** 分析进行中：在没有结果时补一段报告骨架，让用户看到产出形状。 */
  loading?: boolean;
  /** 有结果时摘要条里的内容，用 StageChip 或纯文本。 */
  summary: ReactNode;
  /** 配置面板。没有结果时它就是页面主体。 */
  setup: ReactNode;
  /** 结果内容。 */
  result?: ReactNode;
  /** 错误信息。由外壳统一渲染，保证在「有结果且已收起配置」时也看得见。 */
  error?: string;
  /** 「修改输入」按钮文案。 */
  editLabel?: string;
};

export function StageShell({
  hasResult,
  loading = false,
  summary,
  setup,
  result,
  error,
  editLabel = "修改输入",
}: StageShellProps) {
  const [editing, setEditing] = useState(false);
  const hadResult = useRef(hasResult);

  // 新一轮分析出结果后自动收起配置面板，避免停留在「修改输入」状态。
  useEffect(() => {
    if (hasResult && !hadResult.current) setEditing(false);
    hadResult.current = hasResult;
  }, [hasResult]);

  const errorBanner = error ? (
    <div className="whitespace-pre-wrap rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs leading-5 text-red-600">{error}</div>
  ) : null;

  if (!hasResult) {
    return (
      <div className={`${SETUP_COLUMN} space-y-5`}>
        {setup}
        {errorBanner}
        {loading && <StageSkeleton />}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {editing ? (
        <div className={`${SETUP_COLUMN} space-y-3`}>
          {setup}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-white hover:text-slate-800"
            >
              <RotateCcw className="h-3.5 w-3.5" />收起输入设置
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-400">
            <SlidersHorizontal className="h-3.5 w-3.5" />本次输入
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{summary}</div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-blue-300 hover:text-blue-700"
          >
            {editLabel}
          </button>
        </div>
      )}
      {errorBanner}
      {result}
    </div>
  );
}

/** 摘要条 / 报告里的小标签。整站只用一个强调色（蓝），其余走中性。 */
export function StageChip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${tone === "accent" ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"}`}>
      {children}
    </span>
  );
}

/**
 * 历史报告不用第三张卡堆在侧栏——它是「续用」，不是并列功能区。
 * 收成一行可展开的条目，占位从几百像素降到一行。
 */
export function StageDisclosure({
  label,
  meta,
  defaultOpen = false,
  children,
}: {
  label: string;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(previous => !previous)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition hover:bg-slate-50"
      >
        <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <ChevronDown className={`h-4 w-4 text-slate-400 transition ${open ? "rotate-180" : ""}`} />
          {label}
        </span>
        {meta ? <span className="shrink-0 text-xs text-slate-400">{meta}</span> : null}
      </button>
      {open && <div className="border-t border-slate-100 p-3">{children}</div>}
    </section>
  );
}

/** 报告形状的骨架屏，替代「分析进行中…」旁边的一片空白。 */
export function StageSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="正在生成分析报告">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="space-y-4 bg-slate-950 px-5 py-6 sm:px-7">
          <div className="h-3 w-40 animate-pulse rounded-full bg-white/20" />
          <div className="h-6 w-56 animate-pulse rounded-lg bg-white/20" />
          <div className="grid grid-cols-3 gap-3 pt-1">
            {[0, 1, 2].map(index => <div key={index} className="h-16 animate-pulse rounded-xl bg-white/10" />)}
          </div>
        </div>
        <div className="space-y-3 px-5 py-5 sm:px-7">
          <div className="h-3 w-full animate-pulse rounded-full bg-slate-100" />
          <div className="h-3 w-4/5 animate-pulse rounded-full bg-slate-100" />
        </div>
      </div>
      {[0, 1].map(index => (
        <div key={index} className="space-y-3 rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
          <div className="h-4 w-1/3 animate-pulse rounded-full bg-slate-100" />
          <div className="h-3 w-full animate-pulse rounded-full bg-slate-100" />
          <div className="h-3 w-2/3 animate-pulse rounded-full bg-slate-100" />
        </div>
      ))}
    </div>
  );
}
