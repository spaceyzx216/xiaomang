import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  ArrowLeft,
  BarChart3,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Copy,
  ExternalLink,
  FileText,
  Link2,
  LoaderCircle,
  Tags,
  Target,
  Trash2,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import {
  formatNumber,
  parseAccountLinks,
  type BenchmarkContentStyle,
  type BenchmarkPlatform,
  type BenchmarkReport,
  type SavedBenchmarkReport,
  type SavedBenchmarkReportSummary,
} from "./benchmarkAnalysis";
import { runAccountClassification } from "./benchmarkRun";
import { BenchmarkSetupForm } from "./BenchmarkSetupForm";
import {
  benchmarkProfileToDocxBlocks,
  formatBenchmarkProfileDocxFileName,
  formatBenchmarkProfileMarkdown,
  profileLevelLabelOf,
  profileLevelToneOf,
  sortFansPortraitDimensions,
  type BasisField,
  type BenchmarkProfileReport,
  type ProfileCategory,
  type ProfileFansPortrait,
  type ProfileHookBlock,
  type SavedBenchmarkProfileReportSummary,
} from "./benchmarkProfile";
import { buildDocxBlob, downloadDocx } from "./docx";
import { endingTypeLabelOf, UNKNOWN_ENDING_TYPE_TONE, type EndingHookType } from "./endingHooks";
import { typeLabelOf, UNKNOWN_TYPE_TONE, type GoldThreeSecondType } from "./goldThreeSeconds";
import { useAuth } from "./auth";
import {
  analyzeBenchmarkProfile,
  deleteBenchmarkProfileReport,
  deleteBenchmarkReport,
  fetchFansPortrait,
  fetchProfileComments,
  formatReportTime,
  getBenchmarkProfileReport,
  getBenchmarkReport,
  listBenchmarkProfileReports,
  listBenchmarkReports,
  saveBenchmarkProfileReport,
  transcribeProfileSamples,
} from "./reportApi";
import { StageChip, StageDisclosure, StageShell } from "./StageShell";
import { useStageDraft } from "./stageDraft";

/**
 * 三秒维度配色。与 2.2 的表同构，读取一律带 `|| UNKNOWN_TYPE_TONE` 兜底 ——
 * 数据库里可能留着旧 key 的报告，直接查表拿到 undefined，配色 class 拼成 "undefined"
 * 就是渲染异常（§6.4⑲）。
 */
const goldTypeTone: Record<GoldThreeSecondType, string> = {
  curiosity: "border-violet-200 bg-violet-50 text-violet-700",
  fear: "border-rose-200 bg-rose-50 text-rose-700",
  anger: "border-orange-200 bg-orange-50 text-orange-700",
  contrast: "border-cyan-200 bg-cyan-50 text-cyan-700",
  pain: "border-amber-200 bg-amber-50 text-amber-700",
  interest: "border-emerald-200 bg-emerald-50 text-emerald-700",
  knowledge: "border-blue-200 bg-blue-50 text-blue-700",
  desire: "border-pink-200 bg-pink-50 text-pink-700",
  review: "border-slate-200 bg-slate-100 text-slate-600",
};

/** 结尾类型配色，同样带兜底。 */
const endingTypeTone: Record<EndingHookType, string> = {
  interaction: "border-sky-200 bg-sky-50 text-sky-700",
  conversion: "border-emerald-200 bg-emerald-50 text-emerald-700",
  twist: "border-violet-200 bg-violet-50 text-violet-700",
  punchline: "border-amber-200 bg-amber-50 text-amber-700",
  resonance_ip: "border-rose-200 bg-rose-50 text-rose-700",
  review: "border-slate-200 bg-slate-100 text-slate-600",
};

const styleLabel = (style: BenchmarkContentStyle) => (style === "drama" ? "演绎类" : "口播类");

/**
 * 1.2 的输入有两条路：
 *   - fresh：表单里填一个账号，本模块先跑一次分类分析（结果只在内存里，不落库），再走后续步骤；
 *   - history：复用一份已保存的分类报告，不重新抓取作品。
 */
type BenchmarkProfileSourceMode = "fresh" | "history";

/** 1.2 的样本口径：点赞最高的前 20 条，与后端 `selectProfileVideos` 一致。 */
const PROFILE_SAMPLE_LIMIT = 20;

// 20 条 ÷ 每批 30 条 ≈ 1 轮。给足余量（服务端预算用尽时会提前返回、那一批只推进几条），
// 到顶说明服务端一直没推进，别再无限循环。
const MAX_BATCH_ROUNDS = 40;

/**
 * 并列时的次级排序键。
 *
 * 后端 `selectStageVideos` 的排序是「点赞降序 → 发布时间降序 → 原顺序」，前端要抓评论的
 * 那 20 条必须按同一口径取，否则点赞并列时会挑到与报告样本不同的一批视频 —— 抓回来的
 * 评论用不上，报告里该有评论的样本反倒是空的。
 */
const publishTimeOf = (value?: string) => {
  const text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** 点赞最高的前 20 条（只带 videoId 与平台：评论接口按 aweme_id 取，不需要链接）。 */
const topProfileVideos = (classificationReport: BenchmarkReport) =>
  (classificationReport?.videos || [])
    .map((video, index) => ({ video, index }))
    .sort((left, right) => {
      const likesDiff = (right.video?.stats?.likes || 0) - (left.video?.stats?.likes || 0);
      if (likesDiff !== 0) return likesDiff;
      return publishTimeOf(right.video?.publishDate) - publishTimeOf(left.video?.publishDate) || left.index - right.index;
    })
    .slice(0, PROFILE_SAMPLE_LIMIT)
    .map(item => ({ videoId: item.video.id, platform: item.video.platform }));

/**
 * 1.2 报告里的小类选题**只剩标题**（正文不重复存 60 条视频，与 2.1 的体积优化同理）。
 * 后端将来若把选题改成 `{ title, link }` 的对象，这两个取值函数也能直接吃下去，
 * 不至于把对象渲染成 `[object Object]`。
 */
const topicTitleOf = (topic: unknown) =>
  typeof topic === "string" ? topic : String((topic as { title?: string } | null)?.title || "");
const topicLinkOf = (topic: unknown) =>
  typeof topic === "string" ? "" : String((topic as { link?: string } | null)?.link || "");

/** 标签优先用报告自带的（后端改类型只需改一处），兜底走客户端的旧 key 映射（§6.4⑲）。 */
function GoldTypeTag({ type, label }: { type: string; label?: string }) {
  const tone = goldTypeTone[type as GoldThreeSecondType] || UNKNOWN_TYPE_TONE;
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>{label || typeLabelOf(type)}</span>;
}

function EndingTypeTag({ type, label }: { type: string; label?: string }) {
  const tone = endingTypeTone[type as EndingHookType] || UNKNOWN_ENDING_TYPE_TONE;
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${tone}`}>{label || endingTypeLabelOf(type)}</span>;
}

/**
 * 文案来源徽章。与 2.2/2.3 同构。
 *
 * 「发布文案推断」的样本没做成转写，文案往往只是标题加话题标签，跟真实口播没关系。
 * 不标出来用户会当成同一回事。
 */
function SampleSourceTag({ source }: { source?: "transcript" | "caption" }) {
  if (source === "transcript") {
    return (
      <span title="来自视频片段的真实转写（ASR / 视频理解）" className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
        真实转写
      </span>
    );
  }
  if (source === "caption") {
    return (
      <span title="该视频没做成转写，文案只能从发布文案推断" className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        发布文案推断
      </span>
    );
  }
  return null;
}

/**
 * 证据分级徽章 —— 1.2 的每个叙述字段都必须带上它。
 *
 * 「输入证据」「Agent 推断」「待人工补充」三者对项目经理的含义完全不同，尤其是人口属性
 * 与变现产品定价：它们天生缺少数据源，不标出来就会被当成调研结论。
 * 配色与标签都走 `benchmarkProfile.ts` 里那两个带兜底的函数，前端不另存一份。
 */
function LevelTag({ level, label }: { level?: string; label?: string }) {
  const safeLevel = level || "manual";
  const tone = profileLevelToneOf(safeLevel);
  return <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>{label || profileLevelLabelOf(safeLevel)}</span>;
}

/** 一段带证据分级的叙述：有 `basis` 就把引文列在下面，`text` 为空就明确写「待人工补充」。 */
function BasisCard({ title, field, emptyHint }: { title: string; field?: BasisField | null; emptyHint?: string }) {
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

/** 宽表统一走横向滚动：列多，窄屏挤成一团还不如让用户横着看。 */
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

/** 三秒 / 结尾样本的公共字段：两种 item 结构一致，只有文案字段名不同。 */
type ProfileSampleItem = {
  videoId: string;
  categoryName: string;
  title: string;
  link: string;
  type: string;
  typeLabel: string;
  evidence: string;
  stats: { likes: number; comments: number; shares: number; bookmarks: number };
};

/** 类型口径（含判定说明），后端随报告返回，前端不另存一份。 */
type HookTypeDefinition = { type: string; label?: string; definition?: string; example?: string; strength?: string };

/**
 * 三秒分析 / 结尾分析（1.2 与 2.2/2.3 的两点本质差别都在这里）：
 *
 *   ① 样本是**点赞最高的前 20 条**，不是全部 60 条；
 *   ② 「原因」按 **4 个角度**成段给出，而不是按内容大类拆配比。
 *
 * 渲染顺序：最常用 3 种类型 → 4 个分析角度 → 样本明细 → 完整类型分布（含计 0 的类型）。
 * 配比一律由后端按条数统计，模型只给原因；原因缺失就如实写「待人工补充」。
 */
function HookAnalysisBlock<TItem extends ProfileSampleItem>({
  title,
  kind,
  block,
  definitions,
  definitionsTitle,
  definitionsHint,
  textOf,
  emptyText,
}: {
  title: string;
  kind: "threeSeconds" | "endingHooks";
  block?: ProfileHookBlock<TItem> | null;
  definitions?: HookTypeDefinition[];
  definitionsTitle: string;
  definitionsHint: string;
  /** 取该样本的 3 秒 / 结尾文案与来源。 */
  textOf: (item: TItem) => { text: string; source?: "transcript" | "caption" };
  emptyText: string;
}) {
  const renderTypeTag = (type: string, label?: string) => (kind === "threeSeconds"
    ? <GoldTypeTag type={type} label={label} />
    : <EndingTypeTag type={type} label={label} />);

  const topTypes = block?.topTypes || [];
  const items = block?.items || [];
  const itemCount = block?.itemCount ?? items.length;
  const coverage = block?.transcriptCoverage;
  // 4 个分析角度固定四段；后端没给的那段如实显示「待人工补充」，不编一句套话糊过去。
  const reasonAngles = block?.reasonAngles || [];

  const stats = new Map((block?.typeDistribution || []).map(item => [item.type, item]));
  const dimensionList = (definitions || []).filter(item => item.type !== "review");
  // 旧报告没有 dimensions / types 字段，退回按分布里实际出现过的类型列。
  const rows = dimensionList.length > 0
    ? dimensionList.map(item => ({
      type: item.type,
      label: item.label,
      hint: [item.definition, item.example ? `例：${item.example}` : "", item.strength ? `典型强度 ${item.strength}` : ""].filter(Boolean).join("　"),
      count: stats.get(item.type)?.count || 0,
      percentage: stats.get(item.type)?.percentage || 0,
    }))
    : (block?.typeDistribution || []).filter(item => item.type !== "review").map(item => ({
      type: item.type,
      label: item.typeLabel,
      hint: "",
      count: item.count,
      percentage: item.percentage,
    }));
  const reviewStat = stats.get("review");

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-base font-semibold text-slate-900"><ClipboardCheck className="h-4 w-4 text-blue-600" />{title}</div>
        {coverage && (
          <span className={`rounded-full px-3 py-1.5 text-xs font-medium ${coverage.fromCaption > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
            文案来源：真实转写 {coverage.fromTranscript} 条 / 发布文案推断 {coverage.fromCaption} 条
          </span>
        )}
      </div>
      {block?.analysisReason && (
        <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500"><span className="font-semibold text-slate-600">分析依据：</span>{block.analysisReason}</div>
      )}

      {/* (a) 最常用的 3 种类型 */}
      <div>
        <div className="text-sm font-semibold text-slate-800">最常用的 3 种类型</div>
        <p className="mt-1 text-xs leading-5 text-slate-500">统计基于 {itemCount} 条样本的逐条类型判断；百分比由后端按条数重新计算，模型只提供原因。</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          {topTypes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400 lg:col-span-3">{emptyText}</div>
          ) : topTypes.map(item => (
            <article key={item.type} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">{renderTypeTag(item.type, item.typeLabel)}<span className="text-2xl font-semibold text-slate-950">{item.percentage}%</span></div>
              <div className="mt-2 text-xs text-slate-400">{item.count} / {itemCount} 条样本</div>
              <p className={`mt-2 text-sm leading-6 ${item.reason ? "text-slate-600" : "text-slate-400"}`}>{item.reason || "Agent 未给出该类型的原因，待人工补充。"}</p>
            </article>
          ))}
        </div>
      </div>

      {/* (b) 4 个分析角度。口径与 2.2/2.3 刻意相反：那两步禁止从定位/画像角度解释，1.2 要求必须给全。 */}
      <div>
        <div className="text-sm font-semibold text-slate-800">4 个分析角度</div>
        <p className="mt-1 text-xs leading-5 text-slate-500">这类内容为什么用这种开头 / 收尾，分别从账号定位、内容定位、人设定位、用户痛点四个角度看。</p>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {reasonAngles.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400 lg:col-span-2">这份报告没有返回分析角度，待人工补充。</div>
          ) : reasonAngles.map(angle => (
            <article key={angle.key || angle.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] text-slate-400"><span className="h-px w-4 bg-slate-300" />{angle.label}</div>
              <p className={`mt-2 text-sm leading-6 ${angle.text ? "text-slate-700" : "text-slate-400"}`}>{angle.text || "待人工补充：Agent 未给出这个角度的解释。"}</p>
            </article>
          ))}
        </div>
      </div>

      {/* (c) 样本明细：标题 + 该样本文案 + 类型徽章 + 来源徽章。 */}
      <div>
        <div className="text-sm font-semibold text-slate-800">样本明细（{items.length} 条）</div>
        <p className="mt-1 text-xs leading-5 text-slate-500">逐条列出这一批样本的文案、类型与来源。标「发布文案推断」的样本没做成转写，可信度低于真实转写。</p>
        <div className="mt-3 space-y-2">
          {items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400">没有可展示的样本明细。</div>
          ) : items.map(item => {
            const detail = textOf(item);
            return (
              <div key={item.videoId || item.title} className="rounded-xl border border-slate-200 bg-white px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  {item.link ? (
                    <a href={item.link} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-start gap-1 break-words text-sm font-semibold leading-5 text-slate-900 hover:text-blue-700">
                      {item.title || item.link}<ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
                    </a>
                  ) : (
                    <span className="text-sm font-semibold leading-5 text-slate-900">{item.title || "未命名样本"}</span>
                  )}
                  {renderTypeTag(item.type, item.typeLabel)}
                  <SampleSourceTag source={detail.source} />
                  {item.categoryName && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{item.categoryName}</span>}
                </div>
                <p className={`mt-2 whitespace-pre-wrap text-sm leading-6 ${detail.text ? "text-slate-700" : "text-slate-400"}`}>{detail.text || "未取到文案，待人工补充。"}</p>
                {item.evidence && <p className="mt-1.5 text-xs leading-5 text-slate-400">判断依据：{item.evidence}</p>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 完整类型分布（含计 0 的类型）：只看「最常用的 3 种」会让人以为只有这几种在参与分析。 */}
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><BarChart3 className="h-4 w-4 text-blue-600" />{definitionsTitle}</div>
        <p className="mt-1 text-xs leading-5 text-slate-500">{definitionsHint}</p>
        <div className="mt-3 space-y-2">
          {rows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400">没有可展示的类型分布。</div>
          ) : rows.map(row => (
            <div key={row.type} className={`rounded-xl border px-4 py-3 ${row.count > 0 ? "border-slate-200 bg-white" : "border-dashed border-slate-200 bg-slate-50/60"}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {renderTypeTag(row.type, row.label)}
                {row.hint && <span className="text-xs leading-5 text-slate-500">{row.hint}</span>}
                <span className={`ml-auto shrink-0 text-xs font-semibold ${row.count > 0 ? "text-slate-700" : "text-slate-400"}`}>{row.count} 条 · {row.percentage}%</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(row.count > 0 ? 3 : 0, row.percentage))}%` }} />
              </div>
            </div>
          ))}
        </div>
        {reviewStat?.count ? <p className="mt-3 text-xs leading-5 text-amber-700">另有 {reviewStat.count} 条判为「待人工复核」，不计入上面的分布。</p> : null}
      </div>
    </section>
  );
}

/**
 * 选题分析里的一个大类块 —— 与 2.1 / 2.2 / 2.3 的「大类块」同一套呈现：
 * 序号徽章 + 大类标签 + 占比进度条，展开后左边核心功能 / 判断关键词，右边小类与选题列表。
 *
 * 这里是 2.1 产出的**原样透传**（本模块没有重跑分类），所以标题上方会标出来源。
 */
function ClassifiedCategoryBlock({ category, index, linkOf }: { category: ProfileCategory; index: number; linkOf: (title: string) => string }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={() => setExpanded(previous => !previous)} className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-slate-50 sm:px-6">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-950 text-xs font-semibold text-white">{String(index + 1).padStart(2, "0")}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="rounded-md bg-blue-50 px-2 py-1 text-[10px] font-semibold tracking-wide text-blue-700">大类</span>
            <span className="text-base font-semibold text-slate-900">{category.name}</span>
            <span className="text-xs font-medium text-blue-600">{category.count} 条 · {category.percentage}%</span>
          </span>
          <span className="mt-2 block h-1.5 max-w-md overflow-hidden rounded-full bg-slate-100">
            <span className="block h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(2, category.percentage))}%` }} />
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
              {(category.subcategories || []).length === 0 ? (
                <p className="text-xs leading-5 text-slate-400">这个大类下没有小类明细。</p>
              ) : category.subcategories.map(subcategory => (
                <div key={subcategory.name} className="border-l-2 border-blue-200 pl-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[10px] font-semibold tracking-[0.16em] text-blue-500">小类</span>
                    <h4 className="text-sm font-semibold text-slate-800">{subcategory.name}</h4>
                    <span className="text-xs text-slate-400">{(subcategory.topics || []).length} 条</span>
                  </div>
                  <div className="mt-3 border-t border-dashed border-slate-200 pt-3">
                    <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] text-slate-400"><span className="h-px w-4 bg-slate-300" />具体选题</div>
                    <div className="space-y-2">
                      {(subcategory.topics || []).map((topic, topicIndex) => {
                        const title = topicTitleOf(topic);
                        // 报告只保留了选题标题；链接要回原分类报告的视频表里按标题查（查不到就退化成纯文字）。
                        const link = topicLinkOf(topic) || linkOf(title);
                        return (
                          <div key={`${title}-${topicIndex}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                            {link ? (
                              <a href={link} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-start gap-1 break-words text-sm leading-5 text-slate-800 hover:text-blue-700">
                                {title || link}<ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
                              </a>
                            ) : (
                              <span className="text-sm leading-5 text-slate-800">{title || "未命名选题"}</span>
                            )}
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

/** 粉丝画像卡片里每个维度最多画几根条：省份这类维度二三十项，全画出来卡片就没法看了。 */
const PORTRAIT_UI_ITEMS = 6;

/**
 * 拿不到粉丝画像时的说明文案。**按后端给的 reason 分别给话**：
 * 「旧报告没记账号 ID」和「上游没有这个账号的数据」对项目经理是两件事 ——
 * 前者重跑一次分类分析就能拿到，后者重跑也没用。
 * 查表一律带兜底（§6.4⑲）：后端将来加 reason 时落到那句通用文案，不会渲染成 undefined。
 */
const FANS_PORTRAIT_REASONS: Record<string, string> = {
  missing_sec_user_id: "这份分类报告没有记录账号 ID（旧报告），无法获取粉丝画像。请重新跑一次分类分析。",
  no_dimensions: "上游没有返回该账号的粉丝画像数据，人口属性仍为推断。",
};
const FANS_PORTRAIT_UNKNOWN_REASON = "粉丝画像暂时获取失败，人口属性仍为推断。";
const fansPortraitReasonText = (reason: string) => FANS_PORTRAIT_REASONS[String(reason || "")] || FANS_PORTRAIT_UNKNOWN_REASON;

/**
 * 粉丝画像（真实数据）—— 用户画像里**唯一的一手证据**。
 *
 * 逐维画占比条而不是堆一段文字：项目经理要的是「哪个年龄段占多少」，条形比句子快。
 * 维度顺序走 `sortFansPortraitDimensions`（性别 → 年龄 → … → 城市），与 Markdown 导出同一口径。
 *
 * `available` 为 false 时**不隐藏这一节**，改成一句 amber 说明「为什么这里只有推断」；
 * 整个字段缺失（旧报告）时什么都不渲染，人口属性表自己的「待人工补充」徽章已经说明了问题。
 */
function FansPortraitBlock({ portrait }: { portrait?: ProfileFansPortrait | null }) {
  if (!portrait) return null;

  if (!portrait.available) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3.5 text-xs leading-5 text-amber-700">
        <span className="font-semibold">粉丝画像（真实数据）未获取</span>：{fansPortraitReasonText(portrait.reason)}
      </div>
    );
  }

  const dimensions = sortFansPortraitDimensions(portrait.dimensions);
  const failed = portrait.failed || [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><BarChart3 className="h-4 w-4 text-blue-600" />粉丝画像（真实数据）</div>
        <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700">抖音热榜 · 抓取于 {formatReportTime(portrait.fetchedAt) || "未知时间"}{portrait.fromCache ? "（缓存）" : ""}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-500">这是上游返回的真实粉丝分布，不是模型推断；性别 / 年龄 / 收入 / 消费习惯据此标为「输入证据」。手机价格与手机品牌是收入与消费能力的代理指标，职业 / 行业没有对应维度，仍是推断。</p>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {dimensions.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400 lg:col-span-2">这次没有取到任何维度，人口属性仍为推断。</div>
        ) : dimensions.map((dimension, index) => {
          const all = dimension.items || [];
          const items = all.slice(0, PORTRAIT_UI_ITEMS);
          const hidden = all.length - items.length;
          return (
            <article key={dimension.key || `portrait-dimension-${index}`} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold text-slate-800">{dimension.label || dimension.key || "未命名维度"}</span>
                {dimension.specLabel ? <span className="text-[11px] text-slate-400">支撑「{dimension.specLabel}」</span> : null}
              </div>
              <div className="mt-3 space-y-2">
                {items.map(item => (
                  <div key={item.name} className="flex items-center gap-3">
                    <span title={item.name} className="w-28 shrink-0 truncate text-xs text-slate-600">{item.name}</span>
                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <span className="block h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(item.percentage > 0 ? 3 : 0, item.percentage || 0))}%` }} />
                    </span>
                    <span className="w-12 shrink-0 text-right text-xs text-slate-500">{item.percentage || 0}%</span>
                  </div>
                ))}
              </div>
              {hidden > 0 && <p className="mt-2 text-[11px] leading-5 text-slate-400">另有 {hidden} 项未列出。</p>}
              {dimension.dominant?.name
                ? <p className="mt-2 text-xs leading-5 text-slate-600">结论：占比最高的是 <span className="font-medium text-slate-800">{dimension.dominant.name}</span>（{dimension.dominant.percentage || 0}%）。</p>
                : null}
            </article>
          );
        })}
      </div>

      {/* 失败的维度如实列出来：只展示成功的部分会让人以为画像「只有这几维」。 */}
      {failed.length > 0 && (
        <p className="mt-3 text-xs leading-5 text-slate-400">未取到的维度：{failed.map(item => item.label || `option ${item.option}`).join("、")}。这几个维度缺失，不影响上面已取到的分布。</p>
      )}
    </section>
  );
}

export type BenchmarkProfileStageProps = {
  // 作为「账号定位」模块的 1.2 步骤嵌入时不渲染页面级外壳（返回按钮、大标题、登录信息）。
  embedded?: boolean;
  // 从分类步骤（2.1）交接过来的报告（**含完整正文**）。进入本步骤自动选中，用户不必再挑一次；
  // 而且因为正文已经在内存里，运行分析时不需要再回数据库取一遍。
  preselectedReport?: SavedBenchmarkReport | null;
  // 保存成功时通知模块壳，用于在步骤轨道上标记「已完成」。
  onSaved?: () => void;
};

export function BenchmarkProfileStage({ embedded = false, preselectedReport = null, onSaved }: BenchmarkProfileStageProps) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  // 这几项走草稿：切换步骤或刷新后，选中的分类报告、表单输入和分析结果都还在。
  // loading / progress / error / saving / copied / exporting / exported / busy* 这些瞬时状态留在普通 useState 里。
  const [selectedClassificationId, setSelectedClassificationId] = useStageDraft("benchmarkProfile.selectedClassificationId", "");
  const [report, setReport] = useStageDraft<BenchmarkProfileReport | null>("benchmarkProfile.report", null);
  // 输入走哪条路（新账号 / 复用历史报告）：用户一动表单或点列表就切，与 2.1 存表单状态同一套草稿。
  const [sourceMode, setSourceMode] = useStageDraft<BenchmarkProfileSourceMode>("benchmarkProfile.sourceMode", "fresh");
  const [contentStyle, setContentStyle] = useStageDraft<BenchmarkContentStyle>("benchmarkProfile.contentStyle", "spoken");
  const [platform, setPlatform] = useStageDraft<BenchmarkPlatform>("benchmarkProfile.platform", "douyin");
  const [linksText, setLinksText] = useStageDraft("benchmarkProfile.linksText", "");

  const [classificationReports, setClassificationReports] = useState<SavedBenchmarkReportSummary[]>([]);
  const [savedReports, setSavedReports] = useState<SavedBenchmarkProfileReportSummary[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyReportId, setBusyReportId] = useState("");
  // 删除「分类分析报告」时的 in-flight 守卫，与 busyReportId 分开（两个列表互不影响）。
  const [busyClassificationId, setBusyClassificationId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(false);

  /**
   * 运行代号：每开始一轮分析 +1。
   *
   * 1.2 的五步是前端驱动的长流程（转写 → 转写 → 抓评论 → 拉粉丝画像 → 分析），中途用户完全可能换一份
   * 分类报告、载入一份历史报告，或者切到别的步骤把本组件卸载。**每一步前后都要核对代号**，
   * 否则上一轮的结果会在新一轮开始之后写回 state，把新结果盖掉（2.2 只用 `active` 挡住了
   * 历史加载，这里必须挡整条流水线）。
   */
  const runIdRef = useRef(0);
  const mountedRef = useRef(true);

  // 分类报告里的选题只剩标题，链接要回原报告的视频表里查。索引放 ref：它只是渲染用的
  // 查询表，不值得为它多一次重渲染，也不该跨会话留在草稿里。
  const videoLinkRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 卸载即作废在途的那一轮：回调里核对代号时会直接停手。
      runIdRef.current += 1;
    };
  }, []);

  const indexVideoLinks = (classificationReport?: BenchmarkReport | null) => {
    const index = new Map<string, string>();
    for (const video of classificationReport?.videos || []) {
      const title = String(video?.title || "").trim();
      if (title && video?.link && !index.has(title)) index.set(title, video.link);
    }
    videoLinkRef.current = index;
  };

  // 1.2 的输入来自 2.1，两边顺序相反：这个 effect 只负责「尽量先建好链接索引」，
  // 真正跑分析时会用当次那份分类报告重建一次。
  useEffect(() => {
    if (preselectedReport?.report) indexVideoLinks(preselectedReport.report);
  }, [preselectedReport]);

  // 列表只返回元数据（单份分类报告正文约 148 KB），所以这里拉得非常轻。
  useEffect(() => {
    let active = true;
    setLoadingHistory(true);
    Promise.all([listBenchmarkReports(), listBenchmarkProfileReports()])
      .then(([classifications, profileReports]) => {
        if (!active) return;
        setClassificationReports(classifications);
        // 优先使用上一阶段刚交接过来的报告；否则退回最新一份。
        const handedOffId = preselectedReport?.id && classifications.some(item => item.id === preselectedReport.id)
          ? preselectedReport.id
          : "";
        setSelectedClassificationId(handedOffId || classifications[0]?.id || "");
        // 带着上一阶段刚保存的报告进来时直接走「复用」：用户刚存完，不该再挑一次。
        if (handedOffId) setSourceMode("history");
        setSavedReports(profileReports);
      })
      .catch(requestError => {
        if (active) setError(requestError instanceof Error ? requestError.message : "历史报告加载失败");
      })
      .finally(() => {
        if (active) setLoadingHistory(false);
      });
    return () => { active = false; };
  }, [preselectedReport]);

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
   * 分批驱动的通用循环 —— 1.2 的前三步都靠它推。
   *
   * 与 2.2/2.3 的 `collectTranscripts` 是同一条逻辑，这里抽成一份给三步复用：
   *   - 返回 null / `disabled` / `finished` 立刻收手；
   *   - `attempted` 一整轮没涨（整批都失败）也收手，但**不算失败** —— 用已经拿到的部分继续
   *     跑下一步。一条评论都抓不到就让整份报告作废，对项目经理没有任何好处；
   *   - 到 MAX_BATCH_ROUNDS 还没跑完，同样按「有多少用多少」处理。
   *
   * 每一批前后都核对运行代号：组件已卸载或这一轮已被取代，就立刻停手，不再发请求。
   */
  const driveBatches = async (
    runId: number,
    drive: () => Promise<{ attempted: number; total: number; finished: boolean; disabled?: boolean } | null>,
    describe: (batch: { attempted: number; total: number }) => string,
  ) => {
    let lastAttempted = -1;
    for (let round = 0; round < MAX_BATCH_ROUNDS; round += 1) {
      if (!runIsCurrent(runId)) return;
      const batch = await drive();
      if (!runIsCurrent(runId)) return;
      if (!batch || batch.disabled || batch.finished) return;
      setProgress(describe(batch));
      if (batch.attempted <= lastAttempted) return;
      lastAttempted = batch.attempted;
    }
  };

  /**
   * 本轮输入走哪条路：**最后一次交互说了算** —— 填链接切「新账号」，点列表切「复用」。
   * 复用这条路必须真有一份选中的报告，没有就落回新账号（否则按钮按下去不知道该跑什么）。
   * 提示条、列表高亮、提交三处共用这一个口径，避免出现「提示说复用、实际去抓新账号」。
   */
  const freshInput = sourceMode === "fresh" || !selectedClassificationId;

  const runAnalysis = async () => {
    // 1.2 一次只处理一个账号（与 2.1 的「最多 3 个」口径不同，别把这里的限制抄过去）。
    const links = parseAccountLinks(linksText);
    if (freshInput) {
      if (links.length === 0) {
        setError("请输入对标账号主页链接");
        return;
      }
      if (links.length > 1) {
        setError("对标账号分析每次只能分析一个账号，请只保留一个链接");
        return;
      }
    }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setLoading(true);
    setError("");
    setMessage("");
    setProgress("");
    try {
      // 后面五步只认这一份分类报告，两条路都收敛到它。
      let classificationReport: BenchmarkReport;
      if (freshInput) {
        // 新账号：先跑一次 2.1 的分类分析。**这一份不落库** —— 它只是本次分析的输入，
        // 用户没要求保存，就不该在「已保存的分类报告」列表里凭空多出一条。
        const classified = await runAccountClassification({
          accountUrl: links[0],
          platform,
          contentStyle,
          fetchProgressMessage: "正在抓取并分类该账号（对标账号分析的输入）…",
          onProgress: message => {
            if (runIsCurrent(runId)) setProgress(message);
          },
        });
        if (!runIsCurrent(runId)) return;
        classificationReport = classified.report;
        // 分类已经过去，转写批次返回前不能让上一条「正在运行分析 Agent…」继续挂在界面上。
        setProgress(`该账号已分类（${classified.videoCount} 条作品），继续提取三秒 / 结尾样本…`);
      } else {
        // 刚从上一步交接过来的报告，正文就在内存里，直接用 —— 不再绕一趟数据库。
        // 只有用户从历史列表里另选了一份（列表只带元数据）才需要按 id 去取。
        const full = preselectedReport?.id === selectedClassificationId && preselectedReport.report
          ? preselectedReport
          : await getBenchmarkReport(selectedClassificationId);
        if (!runIsCurrent(runId)) return;
        if (!full?.report) throw new Error("这份分类报告不存在或已被删除，请重新选择");
        classificationReport = full.report;
      }
      indexVideoLinks(classificationReport);

      // 第一步：提取**开头**片段，用于判断三秒。
      await driveBatches(
        runId,
        () => transcribeProfileSamples(classificationReport, "head"),
        batch => `正在提取开头口播 ${batch.attempted}/${batch.total}（首次较慢，之后会走缓存）…`,
      );
      if (!runIsCurrent(runId)) return;

      // 第二步：提取**结尾**片段，用于判断结尾钩子。与开头分开缓存（scope=head/tail，§6.6㉚）。
      await driveBatches(
        runId,
        () => transcribeProfileSamples(classificationReport, "tail"),
        batch => `正在提取结尾口播 ${batch.attempted}/${batch.total}（首次较慢，之后会走缓存）…`,
      );
      if (!runIsCurrent(runId)) return;

      // 第三步：抓高赞评论。只传点赞最高的前 20 条的 videoId 与平台（后端也是这个窗口）。
      await driveBatches(
        runId,
        () => fetchProfileComments(topProfileVideos(classificationReport)),
        batch => `正在抓取高赞评论 ${batch.attempted}/${batch.total}…`,
      );
      if (!runIsCurrent(runId)) return;

      // 第四步：拉**真实**粉丝画像（抖音热榜）。只调一次 —— 上游一次只能取一个维度，
      // 后端在这一次请求里并发打 8 个 GET 并按账号缓存，前端绝不循环放大付费调用。
      // 失败**不终止**这一轮：分析端点自己会从缓存读画像，读不到就让人口属性退回推断。
      const secUserId = String(classificationReport.account?.secUserId || "").trim();
      let portraitDimensionCount = 0;
      if (secUserId) {
        setProgress("正在获取粉丝画像…");
        try {
          const portrait = await fetchFansPortrait(secUserId);
          if (!runIsCurrent(runId)) return;
          portraitDimensionCount = (portrait?.dimensions || []).length;
          setProgress(portraitDimensionCount > 0
            ? `粉丝画像已获取（${portraitDimensionCount} 个维度）`
            : "没有取到粉丝画像，人口属性仍按推断处理…");
        } catch {
          // 画像失败不改报告本身的成败：它只是让「输入证据」少了几个字段。
          if (!runIsCurrent(runId)) return;
          setProgress("粉丝画像获取失败，人口属性仍按推断处理…");
        }
      }
      if (!runIsCurrent(runId)) return;

      // 第五步：一次性出报告。五步之间不做「失败即整体终止」—— 前面几步各自有多少用多少。
      // 画像结果不往分析端点传（它自己从缓存读），但把维度数带进进度文案：
      // 否则「粉丝画像已获取」会被这句话瞬间覆盖，用户根本看不到。
      setProgress(portraitDimensionCount > 0
        ? `粉丝画像已获取（${portraitDimensionCount} 个维度），正在调用对标账号分析 Agent…`
        : "正在调用对标账号分析 Agent…");
      // 如实告诉后端这份分类结果是「复用已保存的」还是「本次现跑的」：
      // 新账号这条路径先跑了一次分类（不落库），报告里的来源说明必须跟着变，
      // 否则会写成「复用模块 3 的 2.1 产出」——那是不实描述。
      const nextReport = await analyzeBenchmarkProfile(classificationReport, freshInput ? "fresh" : "reused");
      if (!runIsCurrent(runId)) return;
      setReport(nextReport);
    } catch (requestError) {
      if (runIsCurrent(runId)) setError(requestError instanceof Error ? requestError.message : "对标账号分析失败");
    } finally {
      if (runIsCurrent(runId)) {
        setLoading(false);
        setProgress("");
      }
    }
  };

  const saveReport = async () => {
    if (!report || saving) return;
    setSaving(true);
    setError("");
    try {
      const item = await saveBenchmarkProfileReport(report);
      setSavedReports(previous => [item, ...previous.filter(existing => existing.id !== item.id)].slice(0, 12));
      setMessage("对标账号分析报告已保存，可供后续账号规划使用。");
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
      await navigator.clipboard.writeText(formatBenchmarkProfileMarkdown(report));
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
        downloadDocx(buildDocxBlob(benchmarkProfileToDocxBlocks(report)), formatBenchmarkProfileDocxFileName(report));
        setExported(true);
        window.setTimeout(() => setExported(false), 1800);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : "导出 Word 失败");
      } finally {
        setExporting(false);
      }
    }, 0);
  };

  // 删除一份分类分析报告。它是 1.2 的输入，删掉后必须把当前选择与在途的那一轮一并清掉，
  // 否则「开始分析」会拿着一份已经不存在的报告去跑、或者把基于它的结果写回来。
  const removeClassificationReport = async (item: SavedBenchmarkReportSummary) => {
    if (busyClassificationId) return;
    setBusyClassificationId(item.id);
    setError("");
    try {
      await deleteBenchmarkReport(item.id);
      setClassificationReports(previous => previous.filter(existing => existing.id !== item.id));
      if (selectedClassificationId === item.id) {
        supersedeRun();
        setSelectedClassificationId("");
        setReport(null);
      }
      setMessage("已删除该分类分析报告。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除分类报告失败");
    } finally {
      setBusyClassificationId("");
    }
  };

  const loadSavedReport = async (item: SavedBenchmarkProfileReportSummary) => {
    if (busyReportId) return;
    setBusyReportId(item.id);
    setError("");
    try {
      const full = await getBenchmarkProfileReport(item.id);
      if (!full?.report) throw new Error("这份报告不存在或已被删除");
      // 载入历史报告同样要作废在途的那一轮，否则等它跑完就把刚载入的这份盖掉了。
      supersedeRun();
      setReport(full.report);
      setMessage("已载入历史对标账号分析报告。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "载入历史报告失败");
    } finally {
      setBusyReportId("");
    }
  };

  const removeSavedReport = async (item: SavedBenchmarkProfileReportSummary) => {
    if (busyReportId) return;
    setBusyReportId(item.id);
    setError("");
    try {
      await deleteBenchmarkProfileReport(item.id);
      setSavedReports(previous => previous.filter(existing => existing.id !== item.id));
      setMessage("已删除该历史报告。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除失败");
    } finally {
      setBusyReportId("");
    }
  };

  // 当前选中那份的元数据（列表只有元数据，正文要按 id 取），提示条里要说清复用哪一份。
  const selectedClassification = classificationReports.find(item => item.id === selectedClassificationId) || null;

  /**
   * 提交按钮上方的提示条：**这一轮到底会跑什么**在按下按钮前就要说清楚。
   * 复用一份已保存报告不需要重新抓取；新账号则会在本次运行里先分类一次，且不落库。
   */
  const setupNotice = freshInput ? (
    <p className="rounded-xl bg-slate-50 px-3.5 py-3 text-xs leading-5 text-slate-500">
      本次会先抓取并分类该账号（分类结果只用于本次分析，不保存成分类报告），再取点赞最高的前 {PROFILE_SAMPLE_LIMIT} 条样本提取开头口播、结尾口播与高赞评论，
      最后拉一次该账号的真实粉丝画像（抖音热榜），结合账号简介输出商业定位、用户画像、内容定位、高频标签与运营策略。转写、评论与画像都按账号落库，重跑几乎走缓存。
    </p>
  ) : selectedClassification ? (
    <p className="rounded-xl bg-slate-50 px-3.5 py-3 text-xs leading-5 text-slate-500">
      当前将复用已保存的分类报告《{selectedClassification.accountName || "未识别账号"}》（{styleLabel(selectedClassification.contentStyle)} · {selectedClassification.analyzedCount} 条样本），不会重新抓取作品。
    </p>
  ) : (
    // 列表没读回来（或那份已被删）时不假装知道要复用哪一份，如实让人重新选。
    <p className="rounded-xl bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-700">
      还没有读到要复用的分类报告：在下面选一份，或者直接在上面填写账号主页链接分析新账号。
    </p>
  );

  // 主输入：一次分析一个账号。「分析设置」这张卡与 2.1 共用（BenchmarkSetupForm）。
  const setupPanel = (
    <BenchmarkSetupForm
      contentStyle={contentStyle}
      platform={platform}
      linksText={linksText}
      // 一动手填链接就切到「新账号」：草稿里存的模式不能压过用户刚敲进去的账号。
      onLinksTextChange={value => { setSourceMode("fresh"); setLinksText(value); }}
      onContentStyleChange={setContentStyle}
      onPlatformChange={setPlatform}
      onSubmit={runAnalysis}
      loading={loading}
      submitLabel="开始分析对标账号"
      linksHint="对标账号分析每次只处理一个账号；需要多个时请分别分析。"
      notice={setupNotice}
      submitDisabled={!linksText.trim() && !selectedClassificationId}
      progress={progress || (freshInput ? "正在抓取并分类该账号（对标账号分析的输入）…" : "正在挑选点赞最高的样本…")}
    />
  );

  // 已保存的分类报告是**另一条输入路径**（复用），不是并列功能区：从主卡里拆出来收成一行可展开条目。
  const reusableDisclosure = (
    <StageDisclosure label="或选择已保存的分类报告" meta={classificationReports.length > 0 ? `${classificationReports.length} 份` : undefined}>
      <div className="space-y-3">
        <p className="px-1 text-xs leading-5 text-slate-500">已经分类过的账号不必重新抓取：点一份就复用它，本模块不会保存新的分类报告。</p>

        {loadingHistory ? (
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-6 text-xs text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />正在读取历史报告…</div>
        ) : classificationReports.length === 0 ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-amber-50 px-4 py-3.5 text-xs leading-5 text-amber-700">还没有保存过分类报告。新账号可以直接在上面分析；想让后续步骤复用这次分类产出时，再去完成分类分析并保存。</div>
            <button type="button" onClick={() => navigate("/manager/benchmark-analysis")} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"><BarChart3 className="h-4 w-4" />先去完成分类分析</button>
          </div>
        ) : (
          <div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
            {classificationReports.map(item => {
              const busy = busyClassificationId === item.id;
              // 只有「复用」这条路才把某一份标成已选中：新账号模式下这一列不代表本轮输入。
              const selected = !freshInput && selectedClassificationId === item.id;
              return (
                // 与 2.1 / 2.2 / 2.3 的已保存列表同一套：选中区 + 独立的删除按钮。
                // 删除按钮必须带 in-flight 守卫，否则双击会发两次 DELETE（§6.4㉑）。
                <div key={item.id} className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 transition ${busy ? "border-blue-200 bg-blue-50/40" : selected ? "border-blue-300 bg-blue-50/70" : "border-slate-200 hover:border-slate-300"}`}>
                  <button type="button" disabled={Boolean(busyClassificationId)} onClick={() => { supersedeRun(); setSourceMode("history"); setSelectedClassificationId(item.id); setReport(null); setMessage(""); }} className="min-w-0 flex-1 text-left disabled:cursor-not-allowed">
                    <div className="flex items-start justify-between gap-3">
                      <span className="truncate text-sm font-semibold text-slate-800">{item.accountName || "未识别账号"}</span>
                      {selected && <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-600" />}
                    </div>
                    <div className="mt-1 text-xs text-slate-400">{styleLabel(item.contentStyle)} · {item.analyzedCount} 条样本 · {item.selectedCount} 条重点 · {formatReportTime(item.createdAt)}</div>
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busyClassificationId)}
                    onClick={() => removeClassificationReport(item)}
                    aria-label={`删除 ${item.accountName || "该"} 的分类报告`}
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
    </StageDisclosure>
  );

  // 历史列表显示到秒，否则同一天保存多份时根本分不清哪份是哪份（§6.4㉒）。
  const historyDisclosure = savedReports.length > 0 ? (
    <StageDisclosure label="已保存的对标账号分析报告" meta={`${savedReports.length} 份`}>
      <div className="space-y-2">
        {savedReports.map(item => {
          const busy = busyReportId === item.id;
          return (
            <div key={item.id} className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 transition ${busy ? "border-blue-200 bg-blue-50/40" : "border-slate-200 hover:border-blue-300 hover:bg-blue-50/50"}`}>
              <button type="button" disabled={Boolean(busyReportId)} onClick={() => loadSavedReport(item)} className="min-w-0 flex-1 text-left disabled:cursor-not-allowed">
                <div className="truncate text-sm font-medium text-slate-800">{item.accountName || "未识别账号"}</div>
                <div className="mt-1 text-xs text-slate-400">{styleLabel(item.contentStyle)} · {item.analyzedCount} 条 · {formatReportTime(item.createdAt)}</div>
              </button>
              <button
                type="button"
                disabled={Boolean(busyReportId)}
                onClick={() => removeSavedReport(item)}
                aria-label={`删除 ${item.accountName || "该"} 的对标账号分析报告`}
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

  const stageSetup = <>{setupPanel}{reusableDisclosure}{historyDisclosure}</>;

  const summaryChips = report ? (
    <>
      <StageChip>{report.account.platformLabel}</StageChip>
      <StageChip>{report.contentStyleLabel || styleLabel(report.contentStyle)}</StageChip>
      <StageChip tone="accent">{report.sampleWindow?.profileSampleCount || 0} 条样本</StageChip>
      <StageChip>{(report.frequentTags || []).length} 个高频标签</StageChip>
    </>
  ) : null;

  // 空转时不该崩：老报告可能没有 dataCoverage / sampleWindow / userProfile 这些字段。
  const coverage = report?.dataCoverage;
  const sampleWindow = report?.sampleWindow;
  /**
   * Agent 降级时把**真实错误**带出来。
   *
   * 以前这里只有一句固定文案（「Agent 未返回有效报告」），出问题时界面看不出原因，
   * 只能翻 DevTools 的 Network 响应或数据库里的 warnings 字段 —— 2026-09-18 排查
   * 「分析 500」时就是卡在这里（HANDOFF §4.3.1）。
   * 后端本来就把错误码与消息写进了 report.warnings，没有理由不显示。
   */
  const fallbackWarning = (report?.warnings || []).find(item => item?.error || item?.code);
  const fallbackWarningText = fallbackWarning
    ? `${fallbackWarning.code ? `[${fallbackWarning.code}] ` : ""}${fallbackWarning.error || ""}`.trim()
    : "";
  const signature = String(report?.account?.signature || "").trim();
  const classification = report?.contentPositioning?.classification;
  const categories = classification?.categories || [];
  const demographics = report?.userProfile?.demographics || [];
  const behaviors = report?.userProfile?.behaviors || [];
  const frequentTags = report?.frequentTags || [];
  const publishing = report?.operationStrategy?.publishing;
  const trafficScripts = report?.operationStrategy?.trafficScripts;
  const monetization = report?.operationStrategy?.monetization;
  // 报告只带选题标题，链接按标题回查当次那份分类报告的视频表（查不到就退化成纯文字）。
  const linkOf = (title: string) => (title ? videoLinkRef.current.get(title) || "" : "");

  const stageBody = (
    <>
      {!embedded && (
        <header className="flex flex-col gap-5 border-b border-slate-200/80 pb-7 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <button type="button" onClick={() => navigate("/manager")} className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-slate-500 transition hover:text-slate-900"><ArrowLeft className="h-4 w-4" />返回项目经理工作台</button>
            <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600"><span className="h-2 w-2 rounded-full bg-blue-600" /> BENCHMARK PROFILE</div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">对标账号分析</h1>
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
            // 这里的判空不能删。result 的 JSX 是在本组件渲染时就被求值的，
            // StageShell 内部的 hasResult 判断拦不住它。report 初始为 null，
            // 少了这层保护，一进入本步骤就会抛 TypeError，整页白屏（§6.4⑱）。
            report && (
              <>
                {/* 报告头：账号 / 口径 / 来源 / 简介 / 数据覆盖 */}
                <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="bg-slate-950 px-5 py-5 text-white sm:px-7 sm:py-6">
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                          <span>{report.account.platformLabel}</span>
                          <span className="text-slate-600">/</span>
                          <span>{report.contentStyleLabel || styleLabel(report.contentStyle)}</span>
                          {report.account.followerCount > 0 && <><span className="text-slate-600">/</span><span>粉丝 {formatNumber(report.account.followerCount)}</span></>}
                          <span className={`rounded-full px-2 py-0.5 ${report.analysisSource === "agent" ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"}`}>{report.analysisSource === "agent" ? "Agent 分析" : "规则兜底"}</span>
                        </div>
                        <h2 className="mt-3 break-words text-2xl font-semibold tracking-tight">{report.account.name || "未识别对标账号"}</h2>
                        {report.account.url && <a href={report.account.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1.5 truncate text-xs text-slate-400 hover:text-white"><Link2 className="h-3.5 w-3.5 shrink-0" />{report.account.url}</a>}
                      </div>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{sampleWindow?.classificationSampleCount || 0}</div><div className="mt-1 text-xs text-slate-400">分类样本</div></div>
                        <div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{sampleWindow?.profileSampleCount || 0}</div><div className="mt-1 text-xs text-slate-400">三秒 / 结尾样本</div></div>
                        <div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{frequentTags.length}</div><div className="mt-1 text-xs text-slate-400">高频标签</div></div>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-4 px-5 py-5 sm:px-7">
                    <div className="flex items-start gap-3">
                      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold tracking-wide text-slate-400">账号简介（商业定位的直接依据）</div>
                        {signature
                          ? <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-slate-700">{signature}</p>
                          : <p className="mt-1.5 rounded-xl bg-amber-50 px-3.5 py-2.5 text-xs leading-5 text-amber-700">未取到账号简介，商业定位待人工补充。</p>}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-blue-50 px-3 py-1.5 font-medium text-blue-700">分类样本：{sampleWindow?.classificationSampleCount || 0} 条（{sampleWindow?.classificationSampleRule || "口径未记录"}）</span>
                      <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">三秒 / 结尾样本：{sampleWindow?.profileSampleRule || `点赞最高的前 ${sampleWindow?.profileSampleLimit || PROFILE_SAMPLE_LIMIT} 条`}</span>
                      <span className={`rounded-full px-3 py-1.5 font-medium ${report.analysisSource === "agent" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>分析来源：{report.analysisSource === "agent" ? "Agent 分析" : "规则兜底"}</span>
                    </div>
                    {/* 数据覆盖：让项目经理一眼看出这一节的证据基础到底有多少条。 */}
                    <div className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">
                      <span className="font-semibold text-slate-600">数据覆盖：</span>
                      有开头转写 {coverage?.headTranscriptCount || 0} 条 / 结尾转写 {coverage?.tailTranscriptCount || 0} 条 / 抓到评论 {coverage?.commentCount || 0} 条（覆盖 {coverage?.videosWithComments || 0} 条样本，共 {coverage?.profileSampleCount || sampleWindow?.profileSampleCount || 0} 条样本）。
                    </div>
                    {report.analysisSource !== "agent" && (
                      <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
                        <div>本次是「规则兜底」结果（Agent 未返回有效报告）：只给出可从输入核对的部分，商业定位、用户画像与变现产品务必人工复核后再用。</div>
                        {fallbackWarningText && (
                          <div className="mt-1.5 break-words font-mono text-[11px] leading-4 text-amber-600">Agent 返回的错误：{fallbackWarningText}</div>
                        )}
                      </div>
                    )}
                  </div>
                </section>

                {/* 一、商业定位 */}
                <section>
                  <div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Target className="h-5 w-5 text-blue-600" />一、商业定位</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">依据账号简介与作品文案拆解；每张卡片右上角的徽章标明这段话的证据等级，推断与待补充项需要项目经理确认。</p>
                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <BasisCard title="人设定位" field={report.businessPositioning?.persona} emptyHint="待人工补充：账号简介缺失或没有可用依据，人设定位需要项目经理自己补。" />
                    <BasisCard title="核心痛点" field={report.businessPositioning?.corePain} emptyHint="待人工补充：核心痛点没有可直接引用的输入，需要项目经理自己补。" />
                  </div>
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="text-xs font-semibold tracking-wide text-slate-400">整体概括</div>
                    {report.businessPositioning?.summary
                      ? <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{report.businessPositioning.summary}</p>
                      : <p className="mt-2 text-xs leading-5 text-slate-400">待人工补充：Agent 未给出整体概括。</p>}
                  </div>
                </section>

                {/* 二、用户画像 */}
                <section>
                  <div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><UsersRound className="h-5 w-5 text-blue-600" />二、用户画像</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">人口属性优先用抖音热榜的真实粉丝画像分布；拿不到时按证据等级标出：标「Agent 推断」的是推断，不是调研结论。</p>
                  <div className="mt-4 space-y-4">
                    {demographics.length > 0 ? (
                      <TableShell head={["维度", "内容", "证据等级"]} minWidth="min-w-[620px]">
                        {demographics.map(item => (
                          <tr key={item.key || item.label} className="align-top">
                            <td className="px-4 py-3 text-sm font-medium text-slate-700">{item.label}</td>
                            <td className="px-4 py-3 text-sm leading-6 text-slate-600">{item.text || <span className="text-slate-400">待人工补充</span>}</td>
                            <td className="px-4 py-3"><LevelTag level={item.level} label={item.levelLabel} /></td>
                          </tr>
                        ))}
                      </TableShell>
                    ) : (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400">这份报告没有返回人口属性，待人工补充。</div>
                    )}

                    {/* 人口属性那一列的证据从哪来：拿不到真实画像也要说明原因，不静默少一块。 */}
                    <FansPortraitBlock portrait={report.userProfile?.fansPortrait} />

                    <div className="grid gap-4 lg:grid-cols-2">
                      <BasisCard title="用户痛点" field={report.userProfile?.pains} />
                      <BasisCard title="目标 / 需求" field={report.userProfile?.goals} />
                    </div>

                    {behaviors.length > 0 && (
                      <TableShell head={["用户行为", "原因", "举例", "证据等级"]} minWidth="min-w-[860px]">
                        {behaviors.map((item, index) => (
                          <tr key={`${item.behavior}-${index}`} className="align-top">
                            <td className="px-4 py-3 text-sm font-medium text-slate-700">{item.behavior || "-"}</td>
                            <td className="px-4 py-3 text-sm leading-6 text-slate-600">{item.reason || <span className="text-slate-400">待人工补充</span>}</td>
                            <td className="px-4 py-3 text-sm leading-6 text-slate-600">{item.example || <span className="text-slate-400">待人工补充</span>}</td>
                            <td className="px-4 py-3"><LevelTag level={item.level} label={item.levelLabel} /></td>
                          </tr>
                        ))}
                      </TableShell>
                    )}

                    {report.userProfile?.dataSources?.note && (
                      <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">{report.userProfile.dataSources.note}</p>
                    )}
                  </div>
                </section>

                {/* 三、内容定位：选题分析（2.1 透传）+ 三秒分析 + 结尾分析 */}
                <section className="space-y-4">
                  <div>
                    <div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><ClipboardCheck className="h-5 w-5 text-blue-600" />三、内容定位</div>
                    <p className="mt-1 text-xs leading-5 text-slate-500">选题分类沿用分类分析（2.1）的产出：已保存过的账号直接复用，新账号在本次运行里先分类一次；三秒与结尾分析只取点赞最高的前 {sampleWindow?.profileSampleLimit || PROFILE_SAMPLE_LIMIT} 条样本，逐条给出文案、类型与来源。</p>
                  </div>

                  <div className="space-y-3">
                    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-slate-900">选题分析（内容大类 / 小类 / 具体选题）</div>
                        <span className="rounded-full bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700">{classification?.source || "复用 2.1 分类分析产出"}</span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-500">大类 / 小类 / 选题与占比原样来自分类分析，本模块不再做二次归类。报告只保留选题标题，标题能对上原分类报告的视频时可点击打开。</p>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">分类样本 {classification?.analyzedCount || 0} 条</span>
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">{classification?.sampleWindow || "取样窗口未记录"}</span>
                        <span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">{styleLabel(classification?.contentStyle || report.contentStyle)}</span>
                      </div>
                      {classification?.summary && <p className="mt-3 text-sm leading-6 text-slate-700">{classification.summary}</p>}
                    </div>
                    {categories.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400">这份报告没有带回内容大类，待人工补充。</div>
                    ) : categories.map((category, index) => (
                      <ClassifiedCategoryBlock key={`${category.name}-${index}`} category={category} index={index} linkOf={linkOf} />
                    ))}
                  </div>

                  <HookAnalysisBlock
                    title="三秒分析（开头片段）"
                    kind="threeSeconds"
                    block={report.contentPositioning?.threeSeconds}
                    definitions={report.contentPositioning?.threeSeconds?.dimensions}
                    definitionsTitle="8 个三秒维度分布"
                    definitionsHint="每条样本只归入一个维度；计 0 条表示这 20 条样本里没有出现。判定口径取自后端随报告返回的 dimensions。"
                    textOf={item => ({ text: item.openingText, source: item.openingSource })}
                    emptyText="暂无足够的有效三秒类型判断。"
                  />

                  <HookAnalysisBlock
                    title="结尾分析（结尾片段）"
                    kind="endingHooks"
                    block={report.contentPositioning?.endingHooks}
                    definitions={report.contentPositioning?.endingHooks?.types}
                    definitionsTitle="5 个结尾类型分布"
                    definitionsHint="每条样本只归入一个类型；计 0 条表示这 20 条样本里没有出现。判定口径取自后端随报告返回的 types。"
                    textOf={item => ({ text: item.endingText, source: item.endingSource })}
                    emptyText="暂无足够的有效结尾类型判断。"
                  />
                </section>

                {/* 高频标签 */}
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                  <div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><Tags className="h-5 w-5 text-blue-600" />高频标签</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{sampleWindow?.tagWindowNote || "标签窗口口径未记录。"}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {frequentTags.length === 0 ? (
                      <span className="text-xs text-slate-400">发布文案里没有解析到话题标签。</span>
                    ) : frequentTags.map((item, index) => (
                      <span key={`${item.tag}-${index}`} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700">
                        <span className="font-medium">#{String(item.tag || "").replace(/^#+/, "")}</span>
                        <span className="text-slate-400">{item.count} 条 · {item.percentage}%</span>
                      </span>
                    ))}
                  </div>
                </section>

                {/* 四、运营策略 */}
                <section className="space-y-4">
                  <div>
                    <div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><TrendingUp className="h-5 w-5 text-blue-600" />四、运营策略</div>
                    <p className="mt-1 text-xs leading-5 text-slate-500">发布频率与高频标签一样由后端按样本实算；引流话术、变现产品与路径来自 Agent，逐项标出证据等级。</p>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="text-sm font-semibold text-slate-900">发布频率</div>
                      <LevelTag level={publishing?.level} label={publishing?.levelLabel} />
                    </div>
                    {publishing ? (
                      <>
                        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <div className="rounded-xl bg-slate-50 px-4 py-3"><div className="text-xl font-semibold text-slate-900">{publishing.videoCount || 0}</div><div className="mt-1 text-xs text-slate-400">样本条数</div></div>
                          <div className="rounded-xl bg-slate-50 px-4 py-3"><div className="text-xl font-semibold text-slate-900">{publishing.spanDays || 0}</div><div className="mt-1 text-xs text-slate-400">跨度天数</div></div>
                          <div className="rounded-xl bg-slate-50 px-4 py-3"><div className="text-xl font-semibold text-slate-900">{publishing.perWeek || 0}</div><div className="mt-1 text-xs text-slate-400">条 / 周</div></div>
                          <div className="rounded-xl bg-slate-50 px-4 py-3"><div className="text-xl font-semibold text-slate-900">{publishing.datedCount || 0}</div><div className="mt-1 text-xs text-slate-400">带发布日期</div></div>
                        </div>
                        <p className="mt-3 text-xs leading-5 text-slate-500">
                          样本区间：{publishing.earliest || "未知"} ~ {publishing.latest || "未知"}{publishing.hasTimeOfDay ? "" : "（只到日期粒度，样本不带时刻）"}
                        </p>
                        {(publishing.weekdayDistribution || []).length > 0 && (
                          <div className="mt-4 space-y-2">
                            <div className="text-xs font-semibold tracking-wide text-slate-400">星期分布</div>
                            {publishing.weekdayDistribution.map(item => {
                              const width = publishing.videoCount > 0 ? Math.round((item.count / publishing.videoCount) * 100) : 0;
                              return (
                                <div key={item.weekday} className="flex items-center gap-3">
                                  <span className="w-10 shrink-0 text-xs text-slate-500">{item.weekday}</span>
                                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                                    <span className="block h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(item.count > 0 ? 3 : 0, width))}%` }} />
                                  </span>
                                  <span className="w-12 shrink-0 text-right text-xs text-slate-400">{item.count} 条</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">{publishing.note || "发布节奏说明待人工补充。"}</p>
                        {publishing.analysis
                          ? <p className="mt-3 text-sm leading-6 text-slate-700">{publishing.analysis}</p>
                          : <p className="mt-3 text-xs leading-5 text-slate-400">节奏分析待人工补充：Agent 未给出这段解释。</p>}
                      </>
                    ) : (
                      <p className="mt-3 text-xs leading-5 text-slate-400">这份报告没有发布频率数据，待人工补充。</p>
                    )}
                  </div>

                  <div>
                    <div className="text-sm font-semibold text-slate-900">引流话术</div>
                    <p className="mt-1 text-xs leading-5 text-slate-500">简介是账号唯一的自述入口，评论区是真实的用户语言；两者分开给，便于核对话术是否对得上。</p>
                    <div className="mt-3 grid gap-4 lg:grid-cols-2">
                      <BasisCard title="账号简介引流话术" field={trafficScripts?.bio} />
                      <BasisCard title="评论区引流话术" field={trafficScripts?.comments} emptyHint="待人工补充：没有抓到评论（或评论里没有可引用的话术），需要项目经理自己补。" />
                    </div>
                  </div>

                  <div>
                    <div className="text-sm font-semibold text-slate-900">变现产品</div>
                    <p className="mt-1 text-xs leading-5 text-slate-500">分层列出引流 / 信任 / 核心 / 利润产品。定价没有输入依据时一律显示「待人工补充」，不拿编造的价位冒充调研结论。</p>
                    <div className="mt-3">
                      {(monetization?.products || []).length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400">这份报告没有识别出变现产品，待人工补充。</div>
                      ) : (
                        <TableShell head={["层级", "产品", "定价", "定位", "在变现路径中的作用", "证据等级"]} minWidth="min-w-[980px]">
                          {(monetization?.products || []).map((item, index) => (
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
                  </div>

                  <div>
                    <div className="text-sm font-semibold text-slate-900">变现路径</div>
                    {(monetization?.path || []).length === 0 ? (
                      <p className="mt-2 text-xs leading-5 text-slate-400">这份报告没有给出变现路径，待人工补充。</p>
                    ) : (
                      <ol className="mt-3 space-y-2">
                        {(monetization?.path || []).map(item => (
                          <li key={`${item.step}-${item.description}`} className="flex gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-slate-950 text-[11px] font-semibold text-white">{item.step}</span>
                            <span className="text-sm leading-6 text-slate-700">{item.description}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {monetization?.note && <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500">{monetization.note}</p>}
                  </div>
                </section>

                {/* 保存 / 复制。两个按钮都要 in-flight 守卫，否则双击会存出重复记录（§6.4㉑）。 */}
                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><CheckCircle2 className="h-4 w-4 text-blue-600" />保存对标账号分析</div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">保存当前分析结果，供模块 2「账号规划」读取。</p>
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
