import { useEffect, useState } from "react";
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
  FileText,
  Link2,
  LoaderCircle,
  MessageSquareText,
  Sparkles,
  Trash2,
} from "lucide-react";
import { apiUrl, fetchWithRetry } from "./api";
import {
  type BenchmarkContentStyle,
  type BenchmarkReport,
  type SavedBenchmarkReport,
  type SavedBenchmarkReportSummary,
} from "./benchmarkAnalysis";
import {
  endingTypeLabelOf,
  formatEndingHooksMarkdown,
  UNKNOWN_ENDING_TYPE_TONE,
  type EndingCategoryBreakdown,
  type EndingHookReport,
  type EndingHookType,
  type SavedEndingHookReportSummary,
} from "./endingHooks";
import { useAuth } from "./auth";
import {
  deleteEndingHookReport,
  deleteBenchmarkReport,
  formatReportTime,
  getBenchmarkReport,
  getEndingHookReport,
  listBenchmarkReports,
  listEndingHookReports,
  parseApiError,
  saveEndingHookReport,
  transcribeEndingSamples,
} from "./reportApi";
import { StageChip, StageDisclosure, StageShell } from "./StageShell";
import { useStageDraft } from "./stageDraft";

const typeTone: Record<EndingHookType, string> = {
  interaction: "border-sky-200 bg-sky-50 text-sky-700",
  conversion: "border-emerald-200 bg-emerald-50 text-emerald-700",
  twist: "border-violet-200 bg-violet-50 text-violet-700",
  punchline: "border-amber-200 bg-amber-50 text-amber-700",
  resonance_ip: "border-rose-200 bg-rose-50 text-rose-700",
  review: "border-slate-200 bg-slate-100 text-slate-600",
};

const styleLabel = (style: BenchmarkContentStyle) => (style === "drama" ? "演绎类" : "口播类");

function TypeTag({ type, className = "" }: { type: EndingHookType; className?: string }) {
  // 未知类型（例如库里还留着旧 key 的报告）必须走兜底：直接查表会拿到 undefined，
  // 轻则标签空白，重则配色 class 拼成 "undefined"，那就是渲染异常。
  const tone = typeTone[type] || UNKNOWN_ENDING_TYPE_TONE;
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${tone} ${className}`}>{endingTypeLabelOf(type)}</span>;
}

/**
 * 结尾文案来源徽章。与 2.2 的开场来源徽章同构。
 *
 * 「结尾文案」有两条来源：视频**结尾片段**的真实转写（可信），或从发布文案推断 ——
 * 后者往往只是标题加话题标签，跟真实结尾没关系。不标出来用户会当成同一回事。
 */
function EndingSourceTag({ source, provider }: { source?: "transcript" | "caption"; provider?: string }) {
  if (source === "transcript") {
    return (
      <span title={provider ? `转写方案：${provider}` : "来自视频结尾片段的真实转写"} className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
        真实转写
      </span>
    );
  }
  if (source === "caption") {
    return (
      <span title="该视频没有做结尾转写，结尾文案只能从发布文案推断" className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        发布文案推断
      </span>
    );
  }
  return null;
}

/** 5 个结尾类型的分布，含判定口径。口径从报告的 types 字段读，前端不另存一份。 */
function TypeDistribution({ report }: { report: EndingHookReport }) {
  const definitions = new Map((report.types || []).map(item => [item.type, item]));
  const rows = (report.typeDistribution || []).filter(item => item.type !== "review");
  const reviewStat = (report.typeDistribution || []).find(item => item.type === "review");
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><BarChart3 className="h-5 w-5 text-blue-600" />5 个结尾类型分布</div>
      <p className="mt-1 text-xs leading-5 text-slate-500">每种类型都列出判定口径和本次样本里的占比；没命中的计 0，方便确认到底有哪几类在参与分析。</p>
      <div className="mt-4 space-y-3">
        {rows.map(item => {
          const definition = definitions.get(item.type);
          return (
            <div key={item.type}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <TypeTag type={item.type} />
                <span className="text-sm font-semibold text-slate-800">{item.count} 条</span>
                <span className="text-xs text-slate-400">{item.percentage}%</span>
                {definition?.strength && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">典型强度 {definition.strength}</span>}
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(item.percentage > 0 ? 3 : 0, item.percentage))}%` }} />
              </div>
              {definition && <p className="mt-1.5 text-xs leading-5 text-slate-500">{definition.definition}。例：{definition.example}</p>}
            </div>
          );
        })}
      </div>
      {reviewStat?.count ? <p className="mt-3 text-xs leading-5 text-amber-700">另有 {reviewStat.count} 条判为「待人工复核」，不计入上面 5 个类型。</p> : null}
    </section>
  );
}

/**
 * 一个大类的结尾类型配比 —— 本步骤的主产出结构：账号 → 大类 → 类型 / 配比 / 原因。
 *
 * 呈现刻意对齐 2.1 分类分析与 2.2 黄金三秒的「大类块」：可折叠 + 序号徽章 + 「大类」标签
 * + 占比进度条；展开后左边是这个大类自己的核心功能与判断关键词，右边按类型缩进列出配比与原因。
 *
 * 配比是**后端按每条样本的 type 实际统计出来的**（每个大类合计 100），不是模型编的。
 * 模型只负责 `reason` 那句解释；它没给就如实说明，不编一句套话糊过去。
 */
function CategoryBreakdown({ category, index }: { category: EndingCategoryBreakdown; index: number }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={() => setExpanded(previous => !previous)} className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-slate-50 sm:px-6">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-slate-950 text-xs font-semibold text-white">{String(index + 1).padStart(2, "0")}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="rounded-md bg-blue-50 px-2 py-1 text-[10px] font-semibold tracking-wide text-blue-700">大类</span>
            <span className="text-base font-semibold text-slate-900">{category.categoryName}</span>
            <span className="text-xs font-medium text-blue-600">{category.count} 条 · {category.percentage}%</span>
            {category.reviewCount > 0 && <span className="text-xs font-medium text-amber-600">另有 {category.reviewCount} 条待复核，未计入配比</span>}
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
                {category.keywords.length > 0
                  ? category.keywords.map(keyword => <span key={keyword} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">{keyword}</span>)
                  : <span className="text-xs text-slate-400">待人工补充</span>}
              </div>
            </div>

            {/* 左：结尾类型与配比；右：原因分析。 */}
            <div className="space-y-4">
              {category.dimensions.length === 0 ? (
                <p className="text-xs leading-5 text-slate-400">
                  {category.count === 0 ? "本次样本里没有该大类的作品。" : "该大类下的样本都没能形成稳定的结尾类型判断。"}
                </p>
              ) : category.dimensions.map(item => (
                <div key={`${category.categoryName}-${item.type}`} className="border-l-2 border-blue-200 pl-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[10px] font-semibold tracking-[0.16em] text-blue-500">结尾类型</span>
                    <TypeTag type={item.type} />
                    <span className="text-sm font-semibold text-slate-800">{item.ratio}%</span>
                    <span className="text-xs text-slate-400">{item.count} 条</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, Math.max(item.ratio > 0 ? 3 : 0, item.ratio))}%` }} />
                  </div>
                  <div className="mt-2 border-t border-dashed border-slate-200 pt-2">
                    <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] text-slate-400"><span className="h-px w-4 bg-slate-300" />原因分析</div>
                    <p className={`text-xs leading-5 ${item.reason ? "text-slate-600" : "text-slate-400"}`}>
                      {item.reason || "Agent 未给出该类型的原因，待人工补充。"}
                    </p>
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

export type EndingHooksStageProps = {
  // 作为「选题库构建」模块的子步骤 2.3 嵌入时不渲染页面级外壳（返回按钮、大标题、登录信息）。
  embedded?: boolean;
  // 从分类步骤（2.1）交接过来的报告（**含完整正文**）。进入本步骤自动选中，用户不必再挑一次。
  preselectedReport?: SavedBenchmarkReport | null;
  // 还没有分类报告时，回到上一步 2.1，而不是跳出当前流程。
  onGoToClassification?: () => void;
  // 保存成功时通知模块壳，用于在子步骤轨道上标记「已完成」。
  onSaved?: () => void;
};

export function EndingHooksStage({
  embedded = false,
  preselectedReport = null,
  onGoToClassification,
  onSaved,
}: EndingHooksStageProps) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  // 走草稿：切换子步骤或刷新后，选中的报告和分析结果都还在。
  const [selectedClassificationId, setSelectedClassificationId] = useStageDraft("ending.selectedClassificationId", "");
  const [report, setReport] = useStageDraft<EndingHookReport | null>("ending.report", null);

  const [classificationReports, setClassificationReports] = useState<SavedBenchmarkReportSummary[]>([]);
  const [savedReports, setSavedReports] = useState<SavedEndingHookReportSummary[]>([]);
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

  useEffect(() => {
    let active = true;
    setLoadingHistory(true);
    Promise.all([listBenchmarkReports(), listEndingHookReports()])
      .then(([classifications, endingReports]) => {
        if (!active) return;
        setClassificationReports(classifications);
        // 优先选中上一步刚交接过来的那份；否则退回最新一份。
        const preferred = preselectedReport?.id && classifications.some(item => item.id === preselectedReport.id)
          ? preselectedReport.id
          : (classifications[0]?.id || "");
        setSelectedClassificationId(preferred);
        setSavedReports(endingReports);
      })
      .catch(requestError => {
        if (active) setError(requestError instanceof Error ? requestError.message : "历史报告加载失败");
      })
      .finally(() => {
        if (active) setLoadingHistory(false);
      });
    return () => { active = false; };
  }, [preselectedReport]);

  const goToClassification = () => {
    if (onGoToClassification) onGoToClassification();
    else navigate("/manager/benchmark-analysis");
  };

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const runAnalysis = async () => {
    if (!selectedClassificationId) {
      setError("请先选择一份已保存的分类分析报告");
      return;
    }
    setLoading(true);
    setError("");
    setMessage("");
    setProgress("");
    try {
      // 刚从上一步交接过来的报告，正文就在内存里，直接用 —— 不再绕一趟数据库。
      // 只有用户从历史列表里另选了一份（列表只带元数据）才需要按 id 去取。
      const full = preselectedReport?.id === selectedClassificationId && preselectedReport.report
        ? preselectedReport
        : await getBenchmarkReport(selectedClassificationId);
      if (!full?.report) throw new Error("这份分类报告不存在或已被删除，请重新选择");

      // 第一阶段：分批提取**结尾**真实口播。
      // 服务端用 scope=tail（ffmpeg -sseof 取最后几秒），与 2.2 的开头片段分开缓存。
      await collectTranscripts(full.report);

      // 第二阶段：用结尾转写（有多少用多少）跑结尾钩子分析。
      setProgress("正在调用结尾钩子分析 Agent…");
      const response = await fetchWithRetry(apiUrl("/api/agent/ending-hooks"), {
        method: "POST",
        retries: 0,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classificationReport: full.report, phase: "analyze" }),
      });
      const data = await parseApiError(response);
      if (!data?.report) throw new Error("结尾钩子 Agent 没有返回有效报告");
      setReport(data.report as EndingHookReport);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "结尾钩子分析失败");
    } finally {
      setLoading(false);
      setProgress("");
    }
  };

  // 60 条 ÷ 每批 30 条 ≈ 2 轮。给足余量（服务端预算用尽时会提前返回、那一批只推进几条），
  // 到顶说明服务端一直没推进，别再无限循环。
  const MAX_TRANSCRIPT_ROUNDS = 40;

  const collectTranscripts = async (classificationReport: BenchmarkReport) => {
    let lastAttempted = -1;
    for (let round = 0; round < MAX_TRANSCRIPT_ROUNDS; round += 1) {
      const progressInfo = await transcribeEndingSamples(classificationReport);
      if (!progressInfo || progressInfo.disabled || progressInfo.finished) return progressInfo;
      setProgress(`正在提取结尾真实口播 ${progressInfo.attempted}/${progressInfo.total}（首次较慢，之后会走缓存）…`);
      // 一整轮下来一条都没推进（例如整批都失败）就收手，用已有的部分继续分析。
      if (progressInfo.attempted <= lastAttempted) return progressInfo;
      lastAttempted = progressInfo.attempted;
    }
    return null;
  };

  const saveReport = async () => {
    if (!report || saving) return;
    setSaving(true);
    setError("");
    try {
      const item = await saveEndingHookReport(report);
      setSavedReports(previous => [item, ...previous.filter(existing => existing.id !== item.id)].slice(0, 12));
      setMessage("结尾钩子分析报告已保存，可供后续账号分析使用。");
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
      await navigator.clipboard.writeText(formatEndingHooksMarkdown(report));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("当前浏览器不允许访问剪贴板，请手动复制报告内容");
    }
  };

  // 删除一份分类分析报告。它是 2.2/2.3 共同的输入，删掉后必须把当前选择一并清掉，
  // 否则「开始分析」会拿着一份已经不存在的报告去跑。
  const removeClassificationReport = async (item: SavedBenchmarkReportSummary) => {
    if (busyClassificationId) return;
    setBusyClassificationId(item.id);
    setError("");
    try {
      await deleteBenchmarkReport(item.id);
      setClassificationReports(previous => previous.filter(existing => existing.id !== item.id));
      if (selectedClassificationId === item.id) {
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

  const loadSavedReport = async (item: SavedEndingHookReportSummary) => {
    if (busyReportId) return;
    setBusyReportId(item.id);
    setError("");
    try {
      const full = await getEndingHookReport(item.id);
      if (!full?.report) throw new Error("这份报告不存在或已被删除");
      setReport(full.report);
      setMessage("已载入历史结尾钩子报告。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "载入历史报告失败");
    } finally {
      setBusyReportId("");
    }
  };

  const removeSavedReport = async (item: SavedEndingHookReportSummary) => {
    if (busyReportId) return;
    setBusyReportId(item.id);
    setError("");
    try {
      await deleteEndingHookReport(item.id);
      setSavedReports(previous => previous.filter(existing => existing.id !== item.id));
      setMessage("已删除该历史报告。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除失败");
    } finally {
      setBusyReportId("");
    }
  };

  // 配置面板：选择一份已保存的分类报告。它同时承担空态职责。
  const setupPanel = (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4 text-sm font-semibold text-slate-900">
        <MessageSquareText className="h-4 w-4 text-blue-600" />选择分类分析报告
      </div>
      <div className="space-y-5 px-5 py-5">
        <p className="text-xs leading-5 text-slate-500">结尾钩子分析会对所选报告的最新 60 条样本全部做分析，只转写每条作品**结尾**几秒，再按内容大类统计结尾类型配比。</p>

        {loadingHistory ? (
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-6 text-xs text-slate-500"><LoaderCircle className="h-4 w-4 animate-spin" />正在读取历史报告…</div>
        ) : classificationReports.length === 0 ? (
          <div className="rounded-xl bg-amber-50 px-4 py-3.5 text-xs leading-5 text-amber-700">还没有保存的分类分析报告。结尾钩子分析必须建立在已保存的分类报告上。</div>
        ) : (
          <div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">
            {classificationReports.map(item => {
              const busy = busyClassificationId === item.id;
              return (
                // 与 2.1 的已保存列表同一套：选中区 + 独立的删除按钮。
                // 删除按钮必须带 in-flight 守卫，否则双击会发两次 DELETE（§6.4㉑）。
                <div key={item.id} className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 transition ${busy ? "border-blue-200 bg-blue-50/40" : selectedClassificationId === item.id ? "border-blue-300 bg-blue-50/70" : "border-slate-200 hover:border-slate-300"}`}>
                  <button type="button" disabled={Boolean(busyClassificationId)} onClick={() => { setSelectedClassificationId(item.id); setReport(null); setMessage(""); }} className="min-w-0 flex-1 text-left disabled:cursor-not-allowed">
                    <div className="flex items-start justify-between gap-3">
                      <span className="truncate text-sm font-semibold text-slate-800">{item.accountName || "未识别账号"}</span>
                      {selectedClassificationId === item.id && <CheckCircle2 className="h-4 w-4 shrink-0 text-blue-600" />}
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

        {!loadingHistory && classificationReports.length === 0 ? (
          <button type="button" onClick={goToClassification} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800"><BarChart3 className="h-4 w-4" />先去完成分类分析</button>
        ) : (
          <button type="button" onClick={runAnalysis} disabled={loading || !selectedClassificationId} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-50">{loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{loading ? "分析进行中…" : "开始分析结尾钩子"}</button>
        )}
        {loading && <p className="text-center text-xs leading-5 text-slate-500">{progress || "正在判断每条样本的结尾类型…"}</p>}
      </div>
    </div>
  );

  const historyDisclosure = savedReports.length > 0 ? (
    <StageDisclosure label="已保存的结尾钩子报告" meta={`${savedReports.length} 份`}>
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
                aria-label={`删除 ${item.accountName || "该"} 的结尾钩子报告`}
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
      <StageChip>{report.account.platformLabel}</StageChip>
      <StageChip>{styleLabel(report.contentStyle)}</StageChip>
      <StageChip tone="accent">{report.analyzedCount} 条分析样本</StageChip>
      <StageChip>{report.topTypes.length} 种常用类型</StageChip>
    </>
  ) : null;

  const stageBody = (
    <>
      {!embedded && (
        <header className="flex flex-col gap-5 border-b border-slate-200/80 pb-7 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <button type="button" onClick={() => navigate("/manager")} className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-slate-500 transition hover:text-slate-900"><ArrowLeft className="h-4 w-4" />返回项目经理工作台</button>
            <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600"><span className="h-2 w-2 rounded-full bg-blue-600" /> ENDING HOOKS</div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">结尾钩子库分析</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">从已确认的对标账号分类报告中，提取每条作品结尾几秒的真实口播，按引导互动、引导转化、反转、金句、共鸣＋IP符号 5 个类型判断结尾钩子。</p>
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
            // 少了这层保护，一进入本子步骤就会抛 TypeError，整页白屏。
            report && (
              <>
                <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="bg-slate-950 px-5 py-5 text-white sm:px-7 sm:py-6"><div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2 text-xs text-slate-300"><span>{report.account.platformLabel}</span><span className="text-slate-600">/</span><span>{styleLabel(report.contentStyle)}</span><span className={`rounded-full px-2 py-0.5 ${report.analysisSource === "agent" ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"}`}>{report.analysisSource === "agent" ? "Agent 分析" : "规则初步分析"}</span></div><h2 className="mt-3 break-words text-2xl font-semibold tracking-tight">{report.account.name || "未识别对标账号"}</h2>{report.account.url && <a href={report.account.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1.5 truncate text-xs text-slate-400 hover:text-white"><Link2 className="h-3.5 w-3.5 shrink-0" />{report.account.url}</a>}</div><div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{report.analyzedCount}</div><div className="mt-1 text-xs text-slate-400">分析样本</div></div><div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{report.topTypes.length}</div><div className="mt-1 text-xs text-slate-400">常用类型</div></div><div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{(report.categoryBreakdown || []).length}</div><div className="mt-1 text-xs text-slate-400">内容大类</div></div></div></div></div>
                  <div className="px-5 py-5 sm:px-7"><div className="flex items-start gap-3"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" /><div><div className="text-xs font-semibold tracking-wide text-slate-400">结尾钩子策略概括</div><p className="mt-1.5 text-sm leading-6 text-slate-700">{report.accountSummary || "暂未生成整体概括"}</p></div></div><div className="mt-4 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-blue-50 px-3 py-1.5 font-medium text-blue-700">取样规则：{report.sampleRule}</span><span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">已分析 {report.analyzedCount} 条</span>{report.transcriptCoverage && <span className={`rounded-full px-3 py-1.5 font-medium ${report.transcriptCoverage.fromCaption > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>结尾文案：真实转写 {report.transcriptCoverage.fromTranscript} 条 / 发布文案推断 {report.transcriptCoverage.fromCaption} 条</span>}</div>{report.analysisReason && <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500"><span className="font-semibold text-slate-600">分析依据：</span>{report.analysisReason}</div>}{report.warnings.length > 0 && <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">部分样本使用了规则初步判断，请重点复核低置信度和“待人工复核”项。</div>}</div>
                </section>

                <section><div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><BarChart3 className="h-5 w-5 text-blue-600" />最常用的 3 种结尾类型</div><p className="mt-1 text-xs text-slate-500">统计基于全部样本的逐条类型判断，百分比由后端重新计算。</p><div className="mt-4 grid gap-4 lg:grid-cols-3">{report.topTypes.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400 lg:col-span-3">暂无足够的有效类型判断。</div> : report.topTypes.map(item => <article key={item.type} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between gap-3"><TypeTag type={item.type} /><span className="text-2xl font-semibold text-slate-950">{item.percentage}%</span></div><div className="mt-3 text-xs text-slate-400">{item.count} / {report.analyzedCount} 条样本</div><p className="mt-3 text-sm leading-6 text-slate-600">{item.reason}</p></article>)}</div></section>

                <TypeDistribution report={report} />

                <section><div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><ClipboardCheck className="h-5 w-5 text-blue-600" />各大类的结尾类型配比</div><p className="mt-1 text-xs text-slate-500">按上一步的内容大类分组，统计每个大类实际使用的结尾类型。配比由后端按每条样本的类型统计得出，不是模型填的。</p><div className="mt-4 space-y-3">{(report.categoryBreakdown || []).length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-400">暂无可统计的大类配比。</div> : (report.categoryBreakdown || []).map((category, index) => <CategoryBreakdown key={category.categoryName} category={category} index={index} />)}</div></section>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><CheckCircle2 className="h-4 w-4 text-blue-600" />保存结尾钩子分析</div><p className="mt-1 text-xs leading-5 text-slate-500">保存当前分析结果，供后续对标账号分析读取。</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={copyReport} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900">{copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}{copied ? "已复制" : "复制报告"}</button><button type="button" onClick={saveReport} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-50">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{saving ? "保存中…" : "保存分析报告"}</button></div></div>{message && <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-3.5 py-3 text-xs text-emerald-700"><CheckCircle2 className="h-4 w-4" />{message}</div>}</section>
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
