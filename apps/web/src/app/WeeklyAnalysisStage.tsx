import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Button } from './components/ui/button';
import { listReviewCustomers, type ReviewPlatform } from './reviewApi';
import { getTopicCategoryDictionary, type TopicTagDictionaryEntry } from './topicLibrary';
import { analyzeWeeklyReview, confirmReviewMemory, deactivateReviewMemory, deleteWeeklyReview, getWeeklyReview, listReviewMemories, listWeeklyReviews, previewReviewPlan, saveWeeklyReview,
  type ReviewMemory, type WeeklyRow, type WeeklyPlan, type WeeklyReport, type WeeklyShare, type WeeklyStats, type WeeklySummary } from './weeklyReviewApi';
import { getReviewInputOptions, type ReviewInputOptions } from './reviewInputApi';
import { createReviewRow, validateReviewFormRows } from './reviewInputRows';
import { ReviewVideoFields } from './ReviewVideoFields';
import { ReviewWorkbookImport } from './ReviewWorkbookImport';

const fieldClass = 'h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm focus:border-blue-500 outline-none';
const number = (v: number | null | undefined) => v == null ? '—' : Number(v.toFixed(1)).toLocaleString('zh-CN');
const percent = (v: number | null | undefined) => v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const time = (v: string) => new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const defaultStart = () => new Date(Date.now() + 8 * 3600000 - 7 * 86400000).toISOString().slice(0, 10);
const endOfWeek = (start: string) => { const date = Date.parse(start); return Number.isFinite(date) ? new Date(date + 6 * 86400000).toISOString().slice(0, 10) : ''; };

function StatsTable({ rows }: { rows: Array<WeeklyStats & { name: string }> }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr>{['类型 / 日期', '样本', '平均播放', '互动率', '完播率', '>1000 条数'].map(t => <th key={t} className="px-3 py-2 font-medium">{t}</th>)}</tr></thead>
    <tbody className="divide-y divide-slate-100">{rows.map((r, i) => <tr key={`${r.name}-${i}`}><td className="px-3 py-2 font-medium">{r.name}</td><td className="px-3 py-2">{r.sampleCount}</td><td className="px-3 py-2">{number(r.meanPlays)}</td><td className="px-3 py-2">{percent(r.interactionRate.value)} <span className="text-slate-400">({r.interactionRate.sampleCount}条)</span></td><td className="px-3 py-2">{percent(r.completionRate.value)}</td><td className="px-3 py-2">{r.aboveBaseCount}</td></tr>)}</tbody></table></div>;
}
const byPlays = <T extends WeeklyStats>(rows: T[]): T[] => [...rows].sort((a, b) => (b.meanPlays ?? -1) - (a.meanPlays ?? -1));

export function WeeklyReportView({ report }: { report: WeeklyReport }) {
  return <div className="space-y-5">
    <Card><CardHeader><CardTitle className="text-base">数据分析周报 · {report.accountName}</CardTitle><p className="text-xs text-slate-500">{report.platformLabel} · {report.period.start}～{report.period.end} · {report.summary.sampleCount} 条视频</p></CardHeader><CardContent className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[['播放总量', number(report.summary.totals.plays?.value)], ['平均播放', number(report.summary.meanPlays)], ['互动率', percent(report.summary.interactionRate.value)], ['高于基础池', `${report.summary.aboveBaseCount} 条`]].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 p-4"><div className="text-xs text-slate-500">{label}</div><div className="mt-2 text-xl font-semibold">{value}</div></div>)}</div>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-600">{Object.entries(report.summary.totals).filter(([key]) => key !== 'plays').map(([key, value]) => <span key={key}>{({ likes: '点赞', comments: '评论', shares: '转发', bookmarks: '收藏', recommends: '红心', follows: '关注' } as Record<string, string>)[key] || key} {number(value.value)}{value.missingCount > 0 ? `（${value.missingCount}条缺失）` : ''}</span>)}</div>
      {report.comparison ? <p className="text-xs text-slate-600">与前一周 {report.comparison.previousPeriod.start}～{report.comparison.previousPeriod.end}（{report.comparison.previousSampleCount} 条）相比：平均播放变化 {percent(report.comparison.meanPlaysChange)}，互动率变化 {report.comparison.interactionRateChange == null ? '—' : `${(report.comparison.interactionRateChange * 100).toFixed(1)} 个百分点`}。</p> : <p className="text-xs text-slate-500">没有同一账号前一周的已保存周报，暂不计算周环比。</p>}
      <StatsTable rows={report.daily.map(r => ({ ...r, name: r.day }))} />
      <p className="text-xs text-slate-500">互动率、完播率按有效视频播放量加权；缺失和可疑数据不作为零参与比较。</p>
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">流量池分层</CardTitle></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{report.pools.map(pool => <div key={pool.key} className="rounded-xl border border-slate-200 p-4"><div className="font-medium text-sm">{pool.label}</div><div className="mt-2 text-2xl font-semibold">{pool.sampleCount}<span className="ml-1 text-xs font-normal text-slate-500">条</span></div><p className="mt-2 text-xs leading-5 text-slate-500">{pool.hint}</p></div>)}</div></CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">绝对数据 · 逐条结构拆解</CardTitle></CardHeader><CardContent className="space-y-4">{(['above', 'below', 'boundary'] as const).map(group => <section key={group}><h3 className="mb-2 text-sm font-medium">{group === 'above' ? '播放量 >1000' : group === 'below' ? '播放量 <1000' : '播放量 =1000（边界）'} · {report.absolute[group].length} 条</h3>
      {report.videos.filter(v => report.absolute[group].includes(v.id)).map(video => <details key={video.id} className="mb-2 rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer text-xs leading-6"><strong>{video.title || video.id}</strong> · {number(video.metrics.plays)} 播放 · {video.structureTags.categoryName || '待人工复核'} / {video.structureTags.subcategoryName || '未标小类'} · {video.playBucket.label}{video.playBucket.ambiguous ? '（参考归档）' : ''}</summary>
        <div className="mt-3 space-y-3 text-xs leading-6"><div className="text-slate-500">{video.publishedAt} · 互动率 {percent(video.derived.interactionRate)} · 相对本周播放中位数 {number(video.relative.playsVsAccountMedian)} 倍</div>
          {video.structures.map(s => <div key={s.key}><strong>{s.label}：{s.verdictLabel}</strong><span className="ml-2 text-slate-500">{s.key === 'goldThreeSeconds' ? video.structureTags.goldThreeSecondsLabel : s.key === 'title' ? video.structureTags.titleLabel : s.key === 'endingHook' ? video.structureTags.endingHookLabel : video.structureTags.subcategoryName}</span><p className="text-slate-600">{s.reasons.join('；') || '数据不足，待人工补充'}</p></div>)}
          <div className="flex flex-wrap gap-3 text-slate-600">{video.judgments.map(j => <span key={j.metric}>{j.label}：{percent(j.value)} · {j.levelLabel}</span>)}</div>
          {report.sourceRows.find(r => r.id === video.id)?.script && <details className="rounded-lg bg-slate-50 p-2"><summary className="cursor-pointer">查看原始文案</summary><p className="mt-2 whitespace-pre-wrap">{report.sourceRows.find(r => r.id === video.id)?.script}</p></details>}
          {video.warnings.length > 0 && <p className="text-amber-700">{video.warnings.join('；')}</p>}
        </div></details>)}</section>)}</CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">相对数据 · 大类、小类与文案结构</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-xs text-slate-500">按平均播放量降序比较，并对照互动率、完播率与样本量；播放高不等于每一项结构都优秀。</p><StatsTable rows={byPlays(report.categories)} />
      {report.categories.map(category => <details key={category.name} className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-medium">{category.name} · {category.sampleCount} 条</summary><div className="mt-4 space-y-4"><div><div className="mb-2 text-xs font-medium">选题小类</div><StatsTable rows={byPlays(category.subcategories)} /></div>{category.structures.map(s => <div key={s.key}><div className="mb-2 text-xs font-medium">{s.label}类型反馈</div><StatsTable rows={byPlays(s.types)} /></div>)}</div></details>)}
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">优化建议方案</CardTitle></CardHeader><CardContent className="space-y-3 text-sm leading-7"><p className="whitespace-pre-wrap">{report.suggestions.summary || 'AI 解释待人工补充。上方数据判定和下方配比建议仍可使用。'}</p>{report.suggestions.actions.map((action, i) => <p key={i}>{i + 1}. {action}</p>)}<details className="text-xs text-slate-500"><summary className="cursor-pointer">查看配比计算口径</summary><p className="mt-2 leading-6">{report.methodology}</p></details>
      {report.warnings.map((warning, i) => <p key={i} className="text-xs text-amber-700">{warning}</p>)}{report.excluded.length > 0 && <details className="text-xs text-slate-500"><summary>已排除 {report.excluded.length} 条</summary>{report.excluded.map(v => <p key={v.id}>{v.title || v.id}：{v.reason}</p>)}</details>}
    </CardContent></Card>
  </div>;
}

function SharesEditor({ shares, onChange, disabled }: { shares: WeeklyShare[]; onChange: (index: number, value: number) => void; disabled: boolean }) {
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-slate-500"><tr>{['类型', '样本', '基准', '本周占比', '下周配比', '计划条数'].map(t => <th key={t} className="py-2 pr-3 font-medium">{t}</th>)}</tr></thead><tbody>{shares.map((share, i) => <tr key={share.name || share.type}><td className="py-2 pr-3">{share.name || share.label || share.type}</td><td className="pr-3">{share.sampleCount}{share.sampleCount < 3 ? '（弱证据）' : ''}</td><td className="pr-3">{share.baselineRatio}%</td><td className="pr-3">{share.observedRatio}%</td><td className="pr-3"><input aria-label={`${share.name || share.label}下周配比`} type="number" min={0} max={100} value={share.ratio} onChange={e => onChange(i, Number(e.target.value))} disabled={disabled} className="h-8 w-20 rounded-lg border border-slate-200 px-2" /> %</td><td>{share.count}</td></tr>)}</tbody></table><p className="mt-1 text-xs text-slate-500">配比合计 {number(shares.reduce((sum, s) => sum + s.ratio, 0))}% · 修改后点击「换算并预览」，再确认生效。</p></div>;
}

export function WeeklyAnalysisStage({ embedded = false, onSaved }: { embedded?: boolean; onSaved?: () => void }) {
  const [customers, setCustomers] = useState<Array<{ id: string; name: string }>>([]);
  const [customerId, setCustomerId] = useState('');
  const [platform, setPlatform] = useState<ReviewPlatform>('douyin');
  const [accountName, setAccountName] = useState('');
  const [start, setStart] = useState(defaultStart);
  const [nextCount, setNextCount] = useState(10);
  const [fillTags, setFillTags] = useState(true);
  const [options, setOptions] = useState<ReviewInputOptions | null>(null);
  const [dictionary, setDictionary] = useState<TopicTagDictionaryEntry[]>([]);
  const [source, setSource] = useState<'manual' | 'excel'>('manual');
  const [rows, setRows] = useState<WeeklyRow[]>(() => [createReviewRow('manual-1')]);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [savedId, setSavedId] = useState('');
  const [plan, setPlan] = useState<WeeklyPlan | null>(null);
  const [previewed, setPreviewed] = useState(false);
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState<WeeklySummary[]>([]);
  const [memories, setMemories] = useState<ReviewMemory[]>([]);
  const [active, setActive] = useState<ReviewMemory | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const busyRef = useRef(false);
  const epoch = useRef(0);
  const confirmation = useRef('');
  const refresh = async () => { const [h, m] = await Promise.all([listWeeklyReviews(customerId, platform), listReviewMemories(customerId, platform)]); setHistory(h); setMemories(m.items); setActive(m.active); };
  useEffect(() => { let cancelled = false; listReviewCustomers().then(c => { if (!cancelled) setCustomers(c); }).catch(e => { if (!cancelled) setError(e.message); }); return () => { cancelled = true; }; }, []);
  useEffect(() => { let cancelled = false; setOptions(null); getReviewInputOptions(platform).then(o => { if (!cancelled) setOptions(o); }).catch(e => { if (!cancelled) setError(e.message); }); return () => { cancelled = true; }; }, [platform]);
  useEffect(() => {
    const token = ++epoch.current; setReport(null); setSavedId(''); setPlan(null); setPreviewed(false); setRows([createReviewRow('manual-1')]); setHistory([]); setMemories([]); setActive(null); setDictionary([]); setError(''); setMessage('');
    if (customerId) Promise.all([getTopicCategoryDictionary(customerId), listWeeklyReviews(customerId, platform), listReviewMemories(customerId, platform)]).then(([d, h, m]) => { if (token === epoch.current) { setDictionary(d?.tagDictionary || []); setHistory(h); setMemories(m.items); setActive(m.active); } }).catch(e => { if (token === epoch.current) setError(e.message); });
    return () => { epoch.current++; };
  }, [customerId, platform]);
  const run = async (label: string, action: () => Promise<void>) => { if (busyRef.current || importing) return; busyRef.current = true; setBusy(label); setError(''); setMessage(''); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败'); } finally { busyRef.current = false; setBusy(''); } };
  const invalidate = () => { setReport(null); setSavedId(''); setPlan(null); setPreviewed(false); };
  const updateRows = (values: WeeklyRow[]) => { setRows(values); invalidate(); setMessage(''); };
  const showReport = (r: WeeklyReport, id = '') => { setReport(r); setSavedId(id); setPlan(structuredClone(r.plan)); setPreviewed(false); setNotes(''); confirmation.current = ''; };
  const editPlan = (change: (value: WeeklyPlan) => void) => { if (!plan) return; const next = structuredClone(plan); change(next); setPlan(next); setPreviewed(false); confirmation.current = ''; };
  const analyze = () => void run('正在生成周报…', async () => {
    if (!customerId || !accountName.trim()) throw new Error('请先选择客户并填写账号名称');
    validateReviewFormRows(rows, 'weekly', options?.maxRows);
    const result = await analyzeWeeklyReview({ customerId, platform, accountName, period: { start, end: endOfWeek(start) }, nextWeekCount: nextCount, rows, fillTags });
    setRows(result.sourceRows);
    showReport(result);
    setMessage('周报已生成。请核对标签、数据与建议；标签有误时修改上传预览后重新分析。');
  });
  const save = () => void run('保存周报…', async () => { if (!report) return; const saved = await saveWeeklyReview(customerId, report); const draft = plan; const draftNotes = notes; showReport(saved.report, saved.id); if (draft) setPlan(draft); setNotes(draftNotes); await refresh(); setMessage('已保存周报。配比尚未生效。'); onSaved?.(); });
  const preview = () => void run('换算配比…', async () => { if (!plan || !savedId) return; setPlan(await previewReviewPlan(savedId, plan)); setPreviewed(true); setMessage('配比已换算为 100%，计划条数已更新。请核对后确认生效。'); });
  const confirm = () => void run('确认生效…', async () => { if (!plan || !savedId || !previewed) return; if (!confirmation.current) confirmation.current = crypto.randomUUID(); const result = await confirmReviewMemory(savedId, plan, notes, confirmation.current); setPlan(result.version.plan); await refresh(); setMessage(result.active?.id === result.version.id ? '新记忆已生效：该客户在当前平台的选题筛选和文本结构二创会优先使用此版本。' : '版本已保存，当前已有更新版本生效，请核对历史。'); });
  const disabled = Boolean(busy || importing);
  return <div className="space-y-5">{!embedded && <h1 className="text-2xl font-semibold">周度账号分析</h1>}
    {error && <div role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}</div>}{message && <div role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-700">{message}</div>}
    <Card><CardHeader><CardTitle className="text-base">第一步　设置账号与数据填写方式</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-xs leading-6 text-slate-500">直接填写一周账号视频数据，或从 Excel 导入后核对。每次只分析一个账号；请统一数据统计时点。单次最多 {options?.maxRows || 120} 条。</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="text-xs text-slate-600">客户<select aria-label="周报客户" className={`${fieldClass} mt-2`} value={customerId} disabled={disabled} onChange={e => setCustomerId(e.target.value)}><option value="">请选择客户</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="text-xs text-slate-600">平台<select aria-label="周报平台" className={`${fieldClass} mt-2`} value={platform} disabled={disabled} onChange={e => setPlatform(e.target.value as ReviewPlatform)}><option value="douyin">抖音</option><option value="wechat_channels">视频号</option></select></label>
        <label className="text-xs text-slate-600">账号名称<input className={`${fieldClass} mt-2`} value={accountName} disabled={disabled} onChange={e => { setAccountName(e.target.value); invalidate(); }} /></label>
        <label className="text-xs text-slate-600">下周计划条数<input type="number" min={1} max={100} className={`${fieldClass} mt-2`} value={nextCount} disabled={disabled} onChange={e => { setNextCount(Number(e.target.value)); invalidate(); }} /></label></div>
      <div className="flex flex-wrap items-center gap-3"><label className="text-xs text-slate-600">周期起始日<input type="date" value={start} disabled={disabled} onChange={e => { setStart(e.target.value); invalidate(); }} className={`${fieldClass} mt-2`} /></label><span className="text-xs text-slate-500">至 {endOfWeek(start)}（连续七天）</span></div>
      <div className="flex flex-wrap gap-2"><Button variant={source === 'manual' ? 'default' : 'outline'} disabled={disabled} onClick={() => setSource('manual')}>直接填写</Button><Button variant={source === 'excel' ? 'default' : 'outline'} disabled={disabled} onClick={() => setSource('excel')}>Excel 导入</Button></div>
      <div hidden={source !== 'excel'}><ReviewWorkbookImport key={`${customerId}:${platform}`} platform={platform} mode="weekly" options={options} disabled={Boolean(busy)} onBusyChange={setImporting} onImport={updateRows} /></div>
      {customerId && dictionary.length === 0 && <p className="text-xs text-amber-700">该客户尚无可用选题库。可以分析数据，确认选题配比前请先完成 2.4 建库。</p>}
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">第二步　填写并核对一周视频数据</CardTitle></CardHeader><CardContent className="space-y-4">
      <p className="text-xs leading-6 text-slate-500">每条视频独立填写发布时间、播放量和其它分析指标。Excel 或 AI 导入的数据也可在这里修改；缺失指标保持为空。</p>
      {rows.map((row, index) => <details key={row.id + ':' + index} open={rows.length === 1 ? true : undefined} className="rounded-xl border border-slate-200 p-4">
        <summary className="cursor-pointer text-sm font-medium">视频 {index + 1} · {row.title || '未填写标题'} · {row.metrics.plays !== undefined && row.metrics.plays !== '' ? `${row.metrics.plays} 播放` : '待填播放量'}</summary>
        <div className="mt-4 space-y-3"><ReviewVideoFields row={row} prefix={`视频${index + 1}`} requireDate options={options} dictionary={dictionary} disabled={disabled} onChange={value => updateRows(rows.map((r, i) => i === index ? value : r))} />
        <Button variant="outline" disabled={disabled} onClick={() => updateRows(rows.filter((_, i) => i !== index))}>删除视频 {index + 1}</Button></div>
      </details>)}
      <Button variant="outline" disabled={disabled || rows.length >= (options?.maxRows || 120)} onClick={() => updateRows([...rows, createReviewRow(crypto.randomUUID(), start)])}>添加视频</Button><span className="ml-3 text-xs text-slate-500">已填写 {rows.length} / {options?.maxRows || 120} 条</span>
      <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={fillTags} disabled={disabled} onChange={e => { setFillTags(e.target.checked); invalidate(); }} />根据已提供的文案补齐缺失标签（调用 AI，保留已有人工标签）</label>
      <Button onClick={analyze} disabled={disabled || !options || !customerId || !rows.length}>{busy || '生成数据分析周报'}</Button>
    </CardContent></Card>
    {report && <><WeeklyReportView report={report} /><Card><CardHeader><CardTitle className="text-base">第三步　下周配比与新记忆</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-xs leading-6 text-slate-500">确认后，这个客户在「{report.platformLabel}」的选题筛选和二创优先使用此版本。此范围每次仅有一个生效版本；同平台的多个自有账号请分别绑定客户。原始选题库统计会保留。</p>
      {plan && <><SharesEditor shares={plan.topics} disabled={disabled} onChange={(i, value) => editPlan(p => { p.topics[i].ratio = value; })} />{plan.topics.map((topic, ci) => <details key={topic.name} className="rounded-xl border p-3"><summary className="cursor-pointer text-sm">{topic.name} · 小类计划</summary><SharesEditor shares={topic.subcategories} disabled={disabled} onChange={(i, value) => editPlan(p => { p.topics[ci].subcategories[i].ratio = value; })} /></details>)}{plan.structures.map((category, ci) => <details key={category.categoryName} className="rounded-xl border p-3"><summary className="cursor-pointer text-sm">{category.categoryName} · 文案结构配比</summary><div className="mt-3 space-y-4">{options?.structures.map(s => <div key={s.key}><h4 className="text-xs font-medium">{s.label}</h4><SharesEditor shares={category[s.key]} disabled={disabled} onChange={(i, value) => editPlan(p => { p.structures[ci][s.key][i].ratio = value; })} /></div>)}</div></details>)}</>}
      <textarea aria-label="人工确认经验" rows={3} maxLength={2000} className="w-full rounded-xl border border-slate-200 p-3 text-sm" placeholder="补充人工确认的经验与下周执行说明（可选）" value={notes} disabled={disabled} onChange={e => { setNotes(e.target.value); confirmation.current = ''; }} />
      <div className="flex flex-wrap gap-3"><Button onClick={save} disabled={disabled}>保存周报</Button><Button variant="outline" onClick={preview} disabled={disabled || !savedId}>换算并预览</Button><Button onClick={confirm} disabled={disabled || !savedId || !previewed || !plan?.topics.length}>确认配比并生成新记忆</Button><Button variant="outline" onClick={() => { const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `周报-${report.accountName}-${report.period.start}.json`; a.click(); URL.revokeObjectURL(url); }}>导出周报</Button></div>
    </CardContent></Card></>}
    {(history.length > 0 || memories.length > 0) && <Card><CardHeader><CardTitle className="text-base">周报与记忆历史</CardTitle></CardHeader><CardContent className="space-y-4">{active && <div className="rounded-xl bg-blue-50 p-3 text-xs text-blue-800">当前生效：{active.accountName} · {active.period.start}～{active.period.end} · {time(active.createdAt)}<Button size="sm" variant="outline" className="ml-3" disabled={disabled} onClick={() => void run('停用记忆…', async () => { await deactivateReviewMemory(active); await refresh(); setMessage('记忆已停用，选题筛选与二创回退到选题库原始配比。'); })}>停用当前记忆</Button></div>}
      {history.map(h => <div key={h.id} className="flex flex-wrap items-center gap-3 border-b border-slate-100 py-3"><div className="flex-1 text-sm">{h.accountName} · {h.period.start}～{h.period.end}<div className="mt-1 text-xs text-slate-400">{h.sampleCount} 条 · {time(h.createdAt)}</div></div><Button size="sm" variant="outline" disabled={disabled} onClick={() => void run('读取周报…', async () => { const item = await getWeeklyReview(h.id); showReport(item.report, item.id); setMessage('已读取历史周报。'); })}>查看</Button><Button size="sm" variant="outline" disabled={disabled} onClick={() => void run('删除周报…', async () => { await deleteWeeklyReview(h.id); if (savedId === h.id) invalidate(); await refresh(); setMessage('周报已删除，已确认的记忆版本仍保留。'); })}>删除</Button></div>)}
      {memories.map(m => <details key={m.id} className="rounded-xl border p-3 text-xs"><summary className="cursor-pointer">{m.id === active?.id ? '生效中' : '历史版本'} · {m.accountName} · {m.period.start} · {time(m.createdAt)}</summary><p className="my-2">{m.notes || '未填写额外经验'}</p><div className="space-y-2">{m.plan.topics.map(t => <p key={t.name}>{t.name} {t.ratio}% · {t.count} 条：{t.subcategories.map(s => `${s.name} ${s.count}条`).join('；')}</p>)}</div></details>)}
    </CardContent></Card>}
  </div>;
}
