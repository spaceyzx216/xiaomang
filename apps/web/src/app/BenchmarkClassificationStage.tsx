import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  ArrowLeft,
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
  Sparkles,
  Trash2,
  UsersRound,
} from "lucide-react";
import {
  formatNumber,
  parseAccountLinks,
  reportToMarkdown,
  resolveTopicVideo,
  type BenchmarkCategory,
  type BenchmarkContentStyle,
  type BenchmarkPlatform,
  type BenchmarkReport,
  type BenchmarkVideo,
  type SavedBenchmarkReport,
  type SavedBenchmarkReportSummary,
} from "./benchmarkAnalysis";
import { runAccountClassification } from "./benchmarkRun";
import { BenchmarkSetupForm } from "./BenchmarkSetupForm";
import { useAuth } from "./auth";
import {
  deleteBenchmarkReport,
  formatReportTime,
  getBenchmarkReport,
  listBenchmarkReports,
  saveBenchmarkReport,
} from "./reportApi";
import { StageChip, StageDisclosure, StageShell } from "./StageShell";
import { useStageDraft } from "./stageDraft";

type ReportView = {
  report: BenchmarkReport;
  key: string;
};

const reportKey = (report: BenchmarkReport, index: number) => `${report.account.url || report.account.name}-${index}`;

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-700">{formatNumber(value)}</span>
    </span>
  );
}

function TopicRow({
  topic,
  selected,
  onToggle,
}: {
  topic: BenchmarkVideo;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`rounded-xl border px-3.5 py-3 transition ${selected ? "border-blue-200 bg-blue-50/70" : "border-slate-200 bg-white hover:border-slate-300"}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`标记重点样本：${topic.title}`}
          className="mt-1.5 h-4 w-4 rounded border-slate-300 text-blue-600 accent-blue-600"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
            <a className="inline-flex max-w-full items-start gap-1 break-words text-sm font-semibold leading-5 text-slate-900 hover:text-blue-700" href={topic.link || undefined} target={topic.link ? "_blank" : undefined} rel={topic.link ? "noreferrer" : undefined}>
              {topic.title}
              {topic.link && <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />}
            </a>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                <span>{topic.authorName || "未知作者"}</span>
                <span>{topic.publishDate || "未知日期"}</span>
                {topic.link && (
                  <a className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700" href={topic.link} target="_blank" rel="noreferrer">
                    打开视频 <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 sm:justify-end">
              <Metric label="赞" value={topic.stats.likes} />
              <Metric label="评" value={topic.stats.comments} />
              <Metric label="转" value={topic.stats.shares} />
              <Metric label="藏" value={topic.stats.bookmarks} />
            </div>
          </div>
          <details className="mt-2 text-xs text-slate-500">
            <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-600">查看发布文案 / 视频描述</summary>
            <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-2.5 leading-5 text-slate-600">{topic.sourceText || "未返回发布文案"}</p>
          </details>
        </div>
      </div>
    </div>
  );
}

function CategoryBlock({
  category,
  index,
  expanded,
  selectedIds,
  onToggleExpand,
  onToggleTopic,
  videos,
}: {
  category: BenchmarkCategory;
  index: number;
  expanded: boolean;
  selectedIds: Set<string>;
  onToggleExpand: () => void;
  onToggleTopic: (id: string) => void;
  /** 选题在大类/小类下只存引用，展示时要回查这份完整视频列表。 */
  videos: BenchmarkVideo[];
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button type="button" onClick={onToggleExpand} className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-slate-50 sm:px-6">
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
              <div className="text-xs font-semibold tracking-wide text-slate-400">核心作用</div>
              <p className="mt-2 text-sm leading-6 text-slate-700">{category.coreFunction}</p>
              <div className="mt-5 text-xs font-semibold tracking-wide text-slate-400">判断关键词 / 语句</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {category.keywords.length > 0 ? category.keywords.map(keyword => (
                  <span key={keyword} className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600">{keyword}</span>
                )) : <span className="text-xs text-slate-400">待人工补充</span>}
              </div>
            </div>
            <div className="space-y-4">
              {category.subcategories.map(subcategory => (
                <div key={subcategory.id} className="border-l-2 border-blue-200 pl-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[10px] font-semibold tracking-[0.16em] text-blue-500">小类</span>
                    <h4 className="text-sm font-semibold text-slate-800">{subcategory.name}</h4>
                    <span className="text-xs text-slate-400">{subcategory.topics.length} 条</span>
                  </div>
                  {subcategory.description && <p className="mt-1 text-xs leading-5 text-slate-500">{subcategory.description}</p>}
                  <div className="mt-3 border-t border-dashed border-slate-200 pt-3">
                    <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] text-slate-400"><span className="h-px w-4 bg-slate-300" />具体选题（标题＋链接）</div>
                    <div className="space-y-2">
                    {subcategory.topics.map(entry => {
                      const topic = resolveTopicVideo(entry, videos);
                      return <TopicRow key={topic.id} topic={topic} selected={selectedIds.has(topic.id)} onToggle={() => onToggleTopic(topic.id)} />;
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

export type BenchmarkClassificationStageProps = {
  // 作为「账号定位」流水线的一步嵌入时不渲染页面级外壳（返回按钮、大标题、登录信息）。
  embedded?: boolean;
  // 保存成功后把刚保存的报告交给下一阶段，避免用户再手动挑一次。
  // 保存成功后把「落库条目 + 完整正文」直接交给下一阶段。
  // 带上正文是为了让第二步直接用内存里的这份，不必再回数据库取一次。
  onSavedReport?: (item: SavedBenchmarkReport) => void;
};

export function BenchmarkClassificationStage({ embedded = false, onSavedReport }: BenchmarkClassificationStageProps) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  // 这几项走草稿（sessionStorage）：从第二步退回第一步时，输入和分析结果都还在。
  // loading / error / 保存中 这些瞬时状态留在普通 useState 里，不要跨阶段留着。
  const [contentStyle, setContentStyle] = useStageDraft<BenchmarkContentStyle>("classification.contentStyle", "spoken");
  const [platform, setPlatform] = useStageDraft<BenchmarkPlatform>("classification.platform", "douyin");
  const [linksText, setLinksText] = useStageDraft("classification.linksText", "");
  const [reports, setReports] = useStageDraft<ReportView[]>("classification.reports", []);
  const [activeReportIndex, setActiveReportIndex] = useStageDraft("classification.activeReportIndex", 0);
  const [selectedByReport, setSelectedByReport] = useStageDraft<Record<string, string[]>>("classification.selectedByReport", {});
  const [expandedCategories, setExpandedCategories] = useStageDraft<Record<string, string[]>>("classification.expandedCategories", {});
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [savedHistory, setSavedHistory] = useState<SavedBenchmarkReportSummary[]>([]);
  const [savedMessage, setSavedMessage] = useState("");
  const [copied, setCopied] = useState(false);
  // 保存 / 删除进行中：按钮必须禁用，否则双击会提交两次（列表里就会出现两条一模一样的记录）。
  const [saving, setSaving] = useState(false);
  const [busyHistoryId, setBusyHistoryId] = useState("");

  const activeReport = reports[activeReportIndex];
  const activeReportKey = activeReport ? reportKey(activeReport.report, activeReportIndex) : "";
  const selectedIds = useMemo(() => new Set(selectedByReport[activeReportKey] || []), [activeReportKey, selectedByReport]);
  const expandedIds = expandedCategories[activeReportKey] || activeReport?.report.categories.map(category => category.id) || [];

  useEffect(() => {
    let active = true;
    listBenchmarkReports()
      .then(items => {
        if (active) setSavedHistory(items);
      })
      .catch(() => {
        // 历史报告读取失败不应阻断当前新报告生成。
      });
    return () => { active = false; };
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const handleAnalyze = async () => {
    const links = parseAccountLinks(linksText);
    if (links.length === 0) {
      setError("请至少输入一个对标账号主页链接");
      return;
    }
    if (links.length > 3) {
      setError("一次最多分析 3 个对标账号，请拆分处理");
      return;
    }

    setLoading(true);
    setError("");
    setSavedMessage("");
    setReports([]);
    setSelectedByReport({});
    setExpandedCategories({});
    setActiveReportIndex(0);

    const nextReports: ReportView[] = [];
    const failures: string[] = [];
    for (let index = 0; index < links.length; index += 1) {
      const accountUrl = links[index];
      try {
        // 抓取 + 分类走共用 helper（1.2 分析新账号时用的是同一份）。
        const { report } = await runAccountClassification({
          accountUrl,
          platform,
          contentStyle,
          fetchProgressMessage: `正在抓取第 ${index + 1}/${links.length} 个账号的最新 60 条作品…`,
          onProgress: setProgress,
        });
        const view = { report, key: `${accountUrl}-${Date.now()}-${index}` };
        nextReports.push(view);
        setReports([...nextReports]);
        const nextKey = reportKey(report, nextReports.length - 1);
        setSelectedByReport(previous => ({ ...previous, [nextKey]: [] }));
        setExpandedCategories(previous => ({ ...previous, [nextKey]: report.categories.map(category => category.id) }));
      } catch (requestError) {
        failures.push(`${accountUrl}：${requestError instanceof Error ? requestError.message : "分析失败"}`);
      }
    }

    setReports(nextReports);
    setActiveReportIndex(0);
    setLoading(false);
    setProgress("");
    if (failures.length > 0) setError(failures.join("\n"));
  };

  const toggleTopic = (id: string) => {
    if (!activeReport) return;
    setSelectedByReport(previous => {
      const current = new Set(previous[activeReportKey] || []);
      if (current.has(id)) current.delete(id); else current.add(id);
      return { ...previous, [activeReportKey]: Array.from(current) };
    });
  };

  const toggleCategory = (id: string) => {
    if (!activeReport) return;
    setExpandedCategories(previous => {
      const current = new Set(previous[activeReportKey] || []);
      if (current.has(id)) current.delete(id); else current.add(id);
      return { ...previous, [activeReportKey]: Array.from(current) };
    });
  };

  const selectAll = () => {
    if (!activeReport) return;
    setSelectedByReport(previous => ({ ...previous, [activeReportKey]: activeReport.report.videos.map(video => video.id) }));
  };

  const clearAll = () => {
    if (!activeReport) return;
    setSelectedByReport(previous => ({ ...previous, [activeReportKey]: [] }));
  };

  // 保存成功时返回后端落库后的报告条目，失败返回 null，供阶段交接使用。
  // saving 守卫在函数内部判断，调用方（两个按钮）只需把它接到 disabled 上。
  const saveActiveReport = async () => {
    if (!activeReport || saving) return null;
    setSaving(true);
    setSavedMessage("");
    try {
      const item = await saveBenchmarkReport(activeReport.report, Array.from(selectedIds));
      setSavedHistory(previous => [item, ...previous.filter(existing => existing.id !== item.id)].slice(0, 12));
      setSavedMessage(`已保存分类分析报告，并标记 ${selectedIds.size} 条重点样本。`);
      return item;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "保存报告失败");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveAndOpenGoldThreeSeconds = async () => {
    const saved = await saveActiveReport();
    if (!saved || !activeReport) return;
    // 顺手把正文带上：下一步用这份内存数据，不再绕数据库。
    const handoff: SavedBenchmarkReport = { ...saved, report: activeReport.report };
    if (onSavedReport) onSavedReport(handoff);
    else navigate("/manager/gold-three-seconds");
  };

  const copyActiveReport = async () => {
    if (!activeReport) return;
    try {
      await navigator.clipboard.writeText(reportToMarkdown(activeReport.report, selectedIds));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("当前浏览器不允许访问剪贴板，请手动复制报告内容");
    }
  };

  // 列表里没有正文（单份约 148 KB），点开某一份时才按 id 取回来。
  const loadHistoryReport = async (item: SavedBenchmarkReportSummary) => {
    if (busyHistoryId) return;
    setBusyHistoryId(item.id);
    setError("");
    try {
      const full = await getBenchmarkReport(item.id);
      if (!full?.report) throw new Error("这份报告不存在或已被删除");
      const view = { report: full.report, key: `history-${full.id}` };
      setReports([view]);
      setActiveReportIndex(0);
      setSelectedByReport({ [reportKey(full.report, 0)]: full.selectedVideoIds });
      setExpandedCategories({ [reportKey(full.report, 0)]: full.report.categories.map(category => category.id) });
      setSavedMessage("已载入历史分类报告，可调整重点样本后再次保存为新版本。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "载入历史报告失败");
    } finally {
      setBusyHistoryId("");
    }
  };

  const removeHistoryReport = async (item: SavedBenchmarkReportSummary) => {
    if (busyHistoryId) return;
    setBusyHistoryId(item.id);
    setError("");
    try {
      await deleteBenchmarkReport(item.id);
      setSavedHistory(previous => previous.filter(existing => existing.id !== item.id));
      setSavedMessage("已删除该历史报告。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除失败");
    } finally {
      setBusyHistoryId("");
    }
  };

  // 「分析设置」这张卡与 1.2 共用（BenchmarkSetupForm）：表单字段、校验口径、样式都只有一份。
  const setupPanel = (
    <BenchmarkSetupForm
      contentStyle={contentStyle}
      platform={platform}
      linksText={linksText}
      onContentStyleChange={setContentStyle}
      onPlatformChange={setPlatform}
      onLinksTextChange={setLinksText}
      onSubmit={handleAnalyze}
      loading={loading}
      submitLabel="开始分析最新 60 条"
      progress={progress}
    />
  );

  // 已保存报告是「续用历史」，不是并列功能区，从侧栏第三张卡收成一行可展开条目。
  // 列表项必须能区分开：显示到秒 + 重点样本数，并给出删除入口。
  const historyDisclosure = savedHistory.length > 0 ? (
    <StageDisclosure label="已保存的分类报告" meta={`${savedHistory.length} 份`}>
      <div className="space-y-2">
        {savedHistory.map(item => {
          const busy = busyHistoryId === item.id;
          return (
            <div key={item.id} className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 transition ${busy ? "border-blue-200 bg-blue-50/40" : "border-slate-200 hover:border-blue-300 hover:bg-blue-50/50"}`}>
              <button type="button" disabled={Boolean(busyHistoryId)} onClick={() => loadHistoryReport(item)} className="min-w-0 flex-1 text-left disabled:cursor-not-allowed">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-slate-800">{item.accountName || "未识别账号"}</span>
                  <span className="shrink-0 text-xs text-slate-500">{item.selectedCount} 条重点样本</span>
                </div>
                <div className="mt-1 text-xs text-slate-400">{item.contentStyle === "drama" ? "演绎类" : "口播类"} · {item.platform === "tiktok" ? "TikTok" : "抖音"} · {formatReportTime(item.createdAt)}</div>
              </button>
              <button
                type="button"
                disabled={Boolean(busyHistoryId)}
                onClick={() => removeHistoryReport(item)}
                aria-label={`删除 ${item.accountName || "该"} 的报告`}
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

  const summaryChips = activeReport ? (
    <>
      <StageChip>{activeReport.report.account.platformLabel}</StageChip>
      <StageChip>{activeReport.report.contentStyleLabel}</StageChip>
      <StageChip tone="accent">{reports.length} 个账号</StageChip>
      <StageChip>{activeReport.report.analyzedCount} 条样本</StageChip>
      {selectedIds.size > 0 && <StageChip>{selectedIds.size} 条重点样本</StageChip>}
    </>
  ) : null;

  const stageBody = (
    <>
      {!embedded && (
        <header className="flex flex-col gap-5 border-b border-slate-200/80 pb-7 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <button type="button" onClick={() => navigate("/manager")} className="mb-5 inline-flex items-center gap-2 text-sm font-medium text-slate-500 transition hover:text-slate-900"><ArrowLeft className="h-4 w-4" />返回项目经理工作台</button>
            <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600"><span className="h-2 w-2 rounded-full bg-blue-600" /> BENCHMARK INTELLIGENCE</div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">对标账号分类分析报告</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">抓取对标账号最新 60 条作品，按口播 / 演绎的不同逻辑拆分主题大类、小类，并保留每个小类对应的标题与链接。本步骤产出分类分析报告，是「选题库构建」的第一环。</p>
          </div>
          <div className="flex items-center gap-3 self-start sm:self-auto">
            <div className="hidden text-right sm:block"><div className="text-sm font-medium text-slate-800">{user?.name || user?.email || "项目经理"}</div><div className="mt-1 text-xs text-slate-400">项目经理账号</div></div>
            <button type="button" onClick={handleLogout} className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-500 transition hover:border-slate-300 hover:text-slate-900">退出登录</button>
          </div>
        </header>
      )}

        <div className={embedded ? "" : "mt-7"}>
        <StageShell
          hasResult={reports.length > 0}
          loading={loading}
          error={error}
          summary={summaryChips}
          setup={stageSetup}
          result={
            <>
            {reports.length > 1 && (
              <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
                {reports.map((item, index) => <button key={item.key} type="button" onClick={() => setActiveReportIndex(index)} className={`rounded-xl px-3.5 py-2 text-sm transition ${index === activeReportIndex ? "bg-slate-950 font-semibold text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"}`}>{item.report.account.name || `账号 ${index + 1}`}</button>)}
              </div>
            )}

            {activeReport && (
              <>
                <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <div className="bg-slate-950 px-5 py-5 text-white sm:px-7 sm:py-6">
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300"><span>{activeReport.report.account.platformLabel}</span><span className="text-slate-600">/</span><span>{activeReport.report.contentStyleLabel}</span><span className={`rounded-full px-2 py-0.5 ${activeReport.report.analysisSource === "agent" ? "bg-emerald-400/15 text-emerald-300" : "bg-amber-400/15 text-amber-300"}`}>{activeReport.report.analysisSource === "agent" ? "Agent 分析" : "规则初步分析"}</span></div>
                        <h2 className="mt-3 break-words text-2xl font-semibold tracking-tight">{activeReport.report.account.name || "未识别对标账号"}</h2>
                        {activeReport.report.account.url && <a href={activeReport.report.account.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex max-w-full items-center gap-1.5 truncate text-xs text-slate-400 hover:text-white"><Link2 className="h-3.5 w-3.5 shrink-0" />{activeReport.report.account.url}</a>}
                      </div>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        <div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{activeReport.report.analyzedCount}</div><div className="mt-1 text-xs text-slate-400">已分析作品</div></div>
                        <div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{activeReport.report.categories.length}</div><div className="mt-1 text-xs text-slate-400">主题大类</div></div>
                        <div className="rounded-xl bg-white/10 px-4 py-3"><div className="text-2xl font-semibold">{selectedIds.size}</div><div className="mt-1 text-xs text-slate-400">重点样本</div></div>
                      </div>
                    </div>
                  </div>
                  <div className="px-5 py-5 sm:px-7">
                    <div className="flex items-start gap-3"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" /><div><div className="text-xs font-semibold tracking-wide text-slate-400">账号整体概括</div><p className="mt-1.5 text-sm leading-6 text-slate-700">{activeReport.report.summary}</p></div></div>
                    <div className="mt-4 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-blue-50 px-3 py-1.5 font-medium text-blue-700">样本范围：{activeReport.report.sampleWindow || "最新作品（最多 60 条）"}</span><span className="rounded-full bg-slate-100 px-3 py-1.5 text-slate-600">当前样本 {activeReport.report.analyzedCount} 条</span></div>
                    <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-500"><span className="font-semibold text-slate-600">分类方法：</span>{activeReport.report.methodology}</div>
                    {activeReport.report.warnings.length > 0 && <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">分析 Agent 曾发生异常，已生成可人工复核的初步报告；请重点检查“待人工复核”分类。</div>}
                  </div>
                </section>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div><div className="flex items-center gap-2 text-lg font-semibold text-slate-900"><ClipboardCheck className="h-5 w-5 text-blue-600" />内容分类树</div><p className="mt-1 text-xs text-slate-500">账号 → 内容主题大类 → 内容主题小类 → 具体标题与链接。占比按本次样本重新计算；勾选仅用于标记后续研究的重点样本。</p></div>
                  <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={selectAll} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-blue-300 hover:text-blue-700">标记全部重点</button><button type="button" onClick={clearAll} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-blue-300 hover:text-blue-700">清空标记</button></div>
                </div>

                <div className="space-y-4">
                  {activeReport.report.categories.map((category, index) => <CategoryBlock key={category.id} category={category} index={index} expanded={expandedIds.includes(category.id)} selectedIds={selectedIds} onToggleExpand={() => toggleCategory(category.id)} onToggleTopic={toggleTopic} videos={activeReport.report.videos} />)}
                </div>

                <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><UsersRound className="h-4 w-4 text-blue-600" />确认分类分析报告</div><p className="mt-1 text-xs leading-5 text-slate-500">保存当前账号、样本范围、分类层级和重点样本标记，供后续黄金三秒、结尾钩子步骤与对标账号分析使用。</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={copyActiveReport} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900">{copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}{copied ? "已复制" : "复制报告"}</button><button type="button" onClick={saveAndOpenGoldThreeSeconds} disabled={saving} className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-2.5 text-sm font-semibold text-blue-700 transition hover:border-blue-300 hover:bg-blue-100 disabled:pointer-events-none disabled:opacity-50">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{saving ? "保存中…" : "保存并进入黄金三秒分析"}</button><button type="button" onClick={saveActiveReport} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-50">{saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}{saving ? "保存中…" : "保存分类分析报告"}</button></div></div>
                  {savedMessage && <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 px-3.5 py-3 text-xs text-emerald-700"><CheckCircle2 className="h-4 w-4" />{savedMessage}</div>}
                </section>
              </>
            )}
            </>
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
