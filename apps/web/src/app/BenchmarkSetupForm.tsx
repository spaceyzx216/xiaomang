import type { ReactNode } from "react";
import {
  BarChart3,
  CheckCircle2,
  Clapperboard,
  LoaderCircle,
  MessageSquareText,
  Target,
} from "lucide-react";
import type { BenchmarkContentStyle, BenchmarkPlatform } from "./benchmarkAnalysis";

/** 内容形式两个选项：口播与演绎的判断依据不同，是分类 Agent 的必填输入。 */
const STYLE_OPTIONS: Array<{
  value: BenchmarkContentStyle;
  label: string;
  description: string;
  icon: typeof MessageSquareText;
}> = [
  {
    value: "spoken",
    label: "口播类选题",
    description: "按标题关键词与文案重复词句分析主题功能",
    icon: MessageSquareText,
  },
  {
    value: "drama",
    label: "演绎类选题",
    description: "按场景、人物身份与剧情关系拆分内容类型",
    icon: Clapperboard,
  },
];

export type BenchmarkSetupFormProps = {
  contentStyle: BenchmarkContentStyle;
  platform: BenchmarkPlatform;
  linksText: string;
  onContentStyleChange: (value: BenchmarkContentStyle) => void;
  onPlatformChange: (value: BenchmarkPlatform) => void;
  onLinksTextChange: (value: string) => void;
  onSubmit: () => void;
  loading: boolean;
  submitLabel: string;
  /** 链接输入框下方的账号数量说明；1.2 用它声明「每次只能分析一个账号」，不传按 2.1 的口径写「一次最多分析 3 个」。 */
  linksHint?: string;
  /** 提交按钮上方的额外提示（例如当前将复用哪份报告）。 */
  notice?: ReactNode;
  /** 提交按钮是否禁用（1.2 在未填账号也没选历史报告时用）。 */
  submitDisabled?: boolean;
  /** 分析进行中的进度文案，显示在提交按钮下方。 */
  progress?: string;
};

/**
 * 「分析设置」表单 —— 2.1 分类分析与 1.2 对标账号分析共用同一张卡。
 *
 * 只负责呈现：值、校验、请求与进度都在各自的阶段里。
 * 「分析设置」和「输入对标账号」原本是两张并列的卡，但它们是同一次决策，所以合并成一张。
 */
export function BenchmarkSetupForm({
  contentStyle,
  platform,
  linksText,
  onContentStyleChange,
  onPlatformChange,
  onLinksTextChange,
  onSubmit,
  loading,
  submitLabel,
  linksHint,
  notice,
  submitDisabled = false,
  progress = "",
}: BenchmarkSetupFormProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4 text-sm font-semibold text-slate-900">
        <Target className="h-4 w-4 text-blue-600" />分析设置
      </div>
      <div className="space-y-5 px-5 py-5">
        <div>
          <div className="text-xs font-semibold tracking-wide text-slate-500">内容形式</div>
          <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
            {STYLE_OPTIONS.map(option => {
              const Icon = option.icon;
              const selected = contentStyle === option.value;
              return (
                <button key={option.value} type="button" onClick={() => onContentStyleChange(option.value)} aria-pressed={selected} className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition ${selected ? "border-blue-300 bg-blue-50/70" : "border-slate-200 bg-white hover:border-slate-300"}`}>
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${selected ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"}`}><Icon className="h-4 w-4" /></span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">{option.label}{selected && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-blue-600" />}</span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">{option.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs font-semibold tracking-wide text-slate-500" htmlFor="benchmark-links">对标账号主页链接</label>
            <span className="flex items-center gap-2">
              <label className="text-xs text-slate-400" htmlFor="benchmark-platform">数据平台</label>
              <select id="benchmark-platform" value={platform} onChange={event => onPlatformChange(event.target.value as BenchmarkPlatform)} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100">
                <option value="douyin">抖音</option>
                <option value="tiktok">TikTok</option>
              </select>
            </span>
          </div>
          <textarea id="benchmark-links" value={linksText} onChange={event => onLinksTextChange(event.target.value)} rows={4} placeholder={platform === "tiktok" ? "https://www.tiktok.com/@username" : "https://www.douyin.com/user/..."} className="mt-2.5 w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm leading-6 text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100" />
          <p className="mt-2 text-xs leading-5 text-slate-400">每行一个账号主页链接，{linksHint || "一次最多分析 3 个。"}按平台发布时间顺序抓取最新 60 条作品，不附加日期筛选。</p>
        </div>

        <details className="rounded-xl bg-slate-50 px-4 py-3">
          <summary className="cursor-pointer select-none text-xs font-medium text-slate-600">分类方法说明</summary>
          <p className="mt-2 text-xs leading-5 text-slate-500">口播按标题关键词与文案重复词句分析；演绎按场景、主角身份与人物数量分析。平台未返回完整脚本时会保留人工复核。</p>
        </details>

        {notice}

        <button type="button" onClick={onSubmit} disabled={loading || submitDisabled} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50">
          {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
          {loading ? "分析进行中…" : submitLabel}
        </button>
        {loading && progress && <p className="text-center text-xs leading-5 text-slate-500">{progress}</p>}
      </div>
    </div>
  );
}
