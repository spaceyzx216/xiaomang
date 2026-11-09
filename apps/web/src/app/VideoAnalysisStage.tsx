import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, Trash2 } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import {
  analyzeVideoReview,
  deleteVideoReview,
  listReviewCustomers,
  listVideoReviewsForCustomer,
  saveVideoReview,
  type ReviewPlatform,
  type SavedVideoReviewSummary,
  type VideoAnalysisReport,
} from "./reviewApi";

import { getReviewInputOptions, type ReviewInputOptions } from './reviewInputApi';
import { createReviewRow, validateReviewFormRows } from './reviewInputRows';
import { ReviewVideoFields } from './ReviewVideoFields';
import { ReviewWorkbookImport } from './ReviewWorkbookImport';
import { getTopicCategoryDictionary, type TopicTagDictionaryEntry } from './topicLibrary';
import type { WeeklyRow } from './weeklyReviewApi';

/** 4.1 supports direct forms, deterministic Excel mapping, and AI-assisted import. */

const PLATFORMS: Array<{ key: ReviewPlatform; label: string }> = [
  { key: "douyin", label: "抖音" },
  { key: "wechat_channels", label: "视频号" },
];

/** 判定等级的配色。与 `reviewMetrics.js` 的 VERDICT_LEVELS 一一对应。 */
const VERDICT_TONE: Record<string, string> = {
  good: "bg-emerald-100 text-emerald-700",
  watch: "bg-slate-100 text-slate-600",
  bad: "bg-rose-100 text-rose-700",
  missing: "bg-amber-100 text-amber-700",
  suspicious: "bg-rose-100 text-rose-700",
};

const STRUCTURE_TONE: Record<string, string> = {
  reuse: "bg-emerald-100 text-emerald-700",
  optimize: "bg-rose-100 text-rose-700",
  watch: "bg-slate-100 text-slate-600",
  missing: "bg-amber-100 text-amber-700",
};

export function VideoAnalysisStage({ embedded = false, onSaved }: { embedded?: boolean; onSaved?: () => void }) {
  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([]);
  const [customerId, setCustomerId] = useState('');
  const [platform, setPlatform] = useState<ReviewPlatform>('douyin');
  const [source, setSource] = useState<'manual' | 'excel'>('manual');
  const [row, setRow] = useState(() => createReviewRow('single-video'));
  const [options, setOptions] = useState<ReviewInputOptions | null>(null);
  const [dictionary, setDictionary] = useState<TopicTagDictionaryEntry[]>([]);
  const [report, setReport] = useState<VideoAnalysisReport | null>(null);
  const [history, setHistory] = useState<SavedVideoReviewSummary[]>([]);
  const [busy, setBusy] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const locked = useRef(false);
  useEffect(() => {
    let cancelled = false;
    listReviewCustomers().then(items => { if (!cancelled) setCustomers(items); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false; setOptions(null);
    getReviewInputOptions(platform).then(o => { if (!cancelled) setOptions(o); }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [platform]);
  useEffect(() => {
    let cancelled = false; setReport(null); setHistory([]); setDictionary([]);
    if (customerId) Promise.all([listVideoReviewsForCustomer(customerId), getTopicCategoryDictionary(customerId)]).then(([h, d]) => {
      if (!cancelled) { setHistory(h); setDictionary(d?.tagDictionary || []); }
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [customerId]);
  const run = async (label: string, action: () => Promise<void>) => {
    if (locked.current || importing) return; locked.current = true; setBusy(label); setError(''); setMessage('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); }
    finally { locked.current = false; setBusy(''); }
  };
  const updateRow = (value: WeeklyRow) => { setRow(value); setReport(null); setMessage(''); };
  const runAnalysis = () => void run('正在分析…', async () => {
    if (!customerId) throw new Error('请先选择客户');
    validateReviewFormRows([row], 'single');
    const result = await analyzeVideoReview({ customerId, platform, metrics: row.metrics, script: row.script,
      video: { title: row.title, link: row.link, publishedAt: row.publishedAt }, structureTags: row.structureTags });
    setReport(result);
    setMessage(result.analysisSource === 'agent' ? '分析完成。请核对判定与建议，确认无误后保存。' : '分析完成。AI 建议暂不可用，数据判定仍可使用，建议文字待人工补充。');
  });
  const save = () => void run('保存报告…', async () => {
    if (!report || !customerId) return;
    const saved = await saveVideoReview({ customerId, customerName: customers.find(c => c.id === customerId)?.name || '', report });
    setHistory(await listVideoReviewsForCustomer(customerId)); setMessage(`已保存（${saved.videoTitle || '未命名视频'}）。`); onSaved?.();
  });
  const removeHistory = (id: string) => void run('删除报告…', async () => { await deleteVideoReview(id); setHistory(await listVideoReviewsForCustomer(customerId)); setMessage('已删除。'); });
  const disabled = Boolean(busy || importing);
  const body = <div className="space-y-5">
    {error && <div role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}
    {message && <div role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-700">{message}</div>}
    <Card><CardHeader><CardTitle className="text-base">第一步　选择客户与数据填写方式</CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="text-xs leading-6 text-slate-500">分析自己账号已发布的视频，可直接填写平台后台数据，也可上传 Excel 导入。AI 识别后仍需核对；.xls 请另存为 .xlsx。</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-600">客户<select aria-label="单条复盘客户" value={customerId} disabled={disabled} onChange={e => { setCustomerId(e.target.value); updateRow(createReviewRow('single-video')); setError(''); }} className="mt-2 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm"><option value="">请选择客户</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="text-xs text-slate-600">平台<select aria-label="单条复盘平台" value={platform} disabled={disabled} onChange={e => { setPlatform(e.target.value as ReviewPlatform); updateRow({ ...row, metrics: {} }); setError(''); }} className="mt-2 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm">{PLATFORMS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
      </div>
      <div className="flex flex-wrap gap-2"><Button variant={source === 'manual' ? 'default' : 'outline'} disabled={disabled} onClick={() => setSource('manual')}>直接填写</Button><Button variant={source === 'excel' ? 'default' : 'outline'} disabled={disabled} onClick={() => setSource('excel')}>Excel 导入</Button></div>
      <div hidden={source !== 'excel'}><ReviewWorkbookImport key={`${customerId}:${platform}`} platform={platform} mode="single" options={options} disabled={Boolean(busy)} onBusyChange={setImporting} onImport={rows => updateRow(rows[0])} /></div>
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">第二步　填写并核对视频数据</CardTitle></CardHeader><CardContent className="space-y-4">
      <ReviewVideoFields row={row} onChange={updateRow} options={options} dictionary={dictionary} disabled={disabled} />
      <div className="flex flex-wrap items-center gap-3"><Button onClick={runAnalysis} disabled={disabled || !options || !customerId}>{busy || '开始分析'}</Button><span className="text-xs text-slate-400">数据判定按平台标准值计算，AI 结合真实文案解释和提出建议。</span></div>
    </CardContent></Card>
    {report && <ReviewReportView report={report} onSave={save} saving={disabled} />}
    {history.length > 0 && <Card><CardHeader><CardTitle className="text-base">这个客户的复盘记录</CardTitle></CardHeader><CardContent><ul className="divide-y divide-slate-100">{history.map(item => <li key={item.id} className="flex items-center gap-3 py-3"><div className="min-w-0 flex-1"><p className="truncate text-sm">{item.videoTitle || '未命名视频'}</p><p className="mt-1 text-xs text-slate-400">{item.platformLabel} · {item.categoryName} · {String(item.createdAt).slice(0, 10)}{item.optimizeCount > 0 ? ` · ${item.optimizeCount} 项待优化` : ''}</p></div><button disabled={disabled} onClick={() => removeHistory(item.id)} aria-label="删除这条复盘" className="rounded-lg p-2 text-slate-400 hover:text-rose-600"><Trash2 className="h-4 w-4" /></button></li>)}</ul></CardContent></Card>}
  </div>;
  if (embedded) return body;
  return <main className="min-h-screen bg-[#f5f7fb] px-5 py-6 text-slate-900 sm:px-8 lg:px-10"><div className="mx-auto max-w-[1200px]"><h1 className="text-xl font-semibold">复盘分析 · 视频数据分析</h1><p className="mt-1 text-sm text-slate-500">填写或导入一条视频的真实数据与文案，得到分析报告与优化建议。</p><div className="mt-6">{body}</div></div></main>;
}

/** 报告视图：判定表 + 四大结构 + 建议。抽出来是为了让主流程读起来还是「三步」。 */
function ReviewReportView({ report, onSave, saving }: { report: VideoAnalysisReport; onSave: () => void; saving: boolean }) {
  return (
    <div className="space-y-5">
      {report.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
          <div className="mb-1 flex items-center gap-2 font-medium"><AlertTriangle className="h-3.5 w-3.5" />需要你知道的 {report.warnings.length} 件事</div>
          <ul className="ml-5 list-disc space-y-0.5">
            {report.warnings.map((text, index) => <li key={index}>{text}</li>)}
          </ul>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            数据分析报告
            <Badge variant="secondary">{report.platformLabel}</Badge>
            {report.playBucket?.label && <Badge variant="secondary">{report.playBucket.label}</Badge>}
            <Badge variant={report.analysisSource === "agent" ? "default" : "secondary"}>
              {report.analysisSource === "agent" ? "AI 已参与" : "规则兜底（建议待人工补充）"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 指标读数：把「这个数字代表什么」直接标在旁边（用户要求） */}
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { title: "直观数据", items: report.metricReadout.engagement },
              { title: "专业数据", items: report.metricReadout.professional },
            ].map(group => (
              <div key={group.title} className="rounded-xl border border-slate-200 p-4">
                <div className="mb-2 text-xs font-semibold text-slate-500">{group.title}</div>
                <ul className="space-y-1.5">
                  {group.items.map(item => (
                    <li key={item.key} className="flex items-baseline gap-2 text-xs">
                      <span className="w-24 shrink-0 text-slate-500">
                        {item.label}
                        {item.weightRank ? <span className="ml-1 text-[10px] text-slate-400">权重{item.weightRank}</span> : null}
                      </span>
                      <span className="w-16 shrink-0 font-semibold text-slate-900">{item.display}</span>
                      <span className="min-w-0 flex-1 text-[11px] leading-4 text-slate-400">{item.meaning}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* 判定：哪个高于/低于标准值 */}
          <div className="overflow-hidden rounded-xl border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">指标</th>
                  <th className="px-3 py-2 text-left font-medium">实测</th>
                  <th className="px-3 py-2 text-left font-medium">标准</th>
                  <th className="px-3 py-2 text-left font-medium">判定</th>
                  <th className="px-3 py-2 text-left font-medium">说明</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.judgments.map(item => {
                  const rule = report.rules.find(entry => entry.metric === item.metric);
                  return (
                    <tr key={item.metric}>
                      <td className="px-3 py-2 font-medium text-slate-800">{item.label}</td>
                      <td className="px-3 py-2 text-slate-700">
                        {item.value === null ? "—" : (item.metric.endsWith("Rate") || item.metric === "interactionRate" || item.metric === "avgPlayRate"
                          ? `${Math.round(item.value * 1000) / 10}%`
                          : `${Math.round(item.value * 10) / 10}`)}
                      </td>
                      <td className="px-3 py-2 text-slate-400">{rule?.threshold || "—"}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT_TONE[item.level] || "bg-slate-100 text-slate-600"}`}>{item.levelLabel}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{item.conclusion}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">优化建议方案</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {report.suggestions.summary && (
            <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs leading-6 text-slate-700">{report.suggestions.summary}</p>
          )}
          {!report.suggestions.summary && report.analysisSource === "heuristic" && (
            <p className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
              AI 这次没能给出建议文字。下面只保留<strong>能从数据直接核对的部分</strong>（判定结论与依据），
              建议文字需要人工补充 —— 我们没有用套话凑数。
            </p>
          )}

          <div className="space-y-3">
            {report.suggestions.items.map(item => (
              <div key={item.key} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-900">{item.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STRUCTURE_TONE[item.verdict] || "bg-slate-100 text-slate-600"}`}>{item.verdictLabel}</span>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-slate-400">{item.hint}</p>

                {item.reasons.length > 0 && (
                  <ul className="mt-2 ml-4 list-disc space-y-0.5 text-[11px] leading-5 text-slate-500">
                    {item.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
                  </ul>
                )}

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-[11px] font-medium text-slate-500">为什么</div>
                    <div className="mt-0.5 text-xs leading-5 text-slate-700">{item.why || <span className="text-slate-400">待人工补充</span>}</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <div className="text-[11px] font-medium text-slate-500">怎么调</div>
                    <div className="mt-0.5 text-xs leading-5 text-slate-700">{item.how || <span className="text-slate-400">待人工补充</span>}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">这条视频的结构标签</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="text-[11px] text-slate-400">
            来源：{report.structureTags.source === "agent" ? "Agent 从文案判断（人工填过的项以人工为准）" : "人工指定"}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { label: "选题大类", value: report.structureTags.categoryName, reason: "" },
              { label: "选题小类", value: report.structureTags.subcategoryName, reason: "" },
              { label: "黄金 3 秒", value: report.structureTags.goldThreeSecondsLabel, reason: report.structureTags.goldThreeSecondsReason },
              { label: "标题", value: report.structureTags.titleLabel, reason: report.structureTags.titleReason },
              { label: "结尾钩子", value: report.structureTags.endingHookLabel, reason: report.structureTags.endingHookReason },
            ].map(row => (
              <div key={row.label} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="text-[11px] text-slate-500">{row.label}</div>
                <div className="mt-0.5 font-medium text-slate-800">{row.value || <span className="text-slate-400">待人工补充</span>}</div>
                {row.reason && <div className="mt-0.5 text-[11px] leading-4 text-slate-400">{row.reason}</div>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={saving}>
          {saving ? <LoaderCircle className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
          {saving ? "保存中…" : "保存这份复盘"}
        </Button>
        <span className="text-[11px] text-slate-400">保存后可以在下面的记录里回看，也会成为下一轮配比调整的依据。</span>
      </div>
    </div>
  );
}
