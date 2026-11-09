import { useEffect, useRef, useState } from 'react';
import { Button } from './components/ui/button';
import { parseReviewWorkbook, type ParsedWorkbook, type ReviewPlatform } from './reviewApi';
import { recognizeReviewWorkbook, type RecognizedWorkbook, type ReviewInputOptions } from './reviewInputApi';
import { rowsFromReviewMapping, suggestReviewInputMapping } from './reviewInputRows';
import type { WeeklyRow } from './weeklyReviewApi';
export function ReviewWorkbookImport({ platform, mode, options, disabled, onImport, onBusyChange }: {
  platform: ReviewPlatform; mode: 'single' | 'weekly'; options: ReviewInputOptions | null; disabled?: boolean; onImport: (rows: WeeklyRow[]) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [recognized, setRecognized] = useState<RecognizedWorkbook | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const file = useRef<File | null>(null); const mounted = useRef(true); const locked = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (title: string, action: () => Promise<void>) => {
    if (locked.current) return; locked.current = true; setBusy(title); setError(''); setMessage(''); onBusyChange(true);
    try { await action(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '导入失败'); }
    finally { locked.current = false; if (mounted.current) { setBusy(''); onBusyChange(false); } }
  };
  const load = (selected: File | null, sheetName?: string) => { if (!selected) return; void run('读取 Excel…', async () => {
    const parsed = await parseReviewWorkbook(selected, { platform, sheetName }); if (!mounted.current) return;
    file.current = selected; setWorkbook(parsed); setMapping(options ? suggestReviewInputMapping(parsed.headers, parsed.suggestedMapping, options) : parsed.suggestedMapping); setRecognized(null); setIndex(0);
  }); };
  const duplicate = Object.values(mapping).filter(Boolean).some((v, i, all) => all.indexOf(v) !== i);
  const importRows = (rows: WeeklyRow[]) => {
    if (!rows.length) throw new Error('未找到视频数据，请重新选择工作表');
    if (mode === 'weekly' && rows.length > (options?.maxRows || 120)) throw new Error('单次最多 120 条视频，请拆分文件');
    onImport(mode === 'single' ? [rows[index] || rows[0]] : rows);
    setMessage(`已填入${mode === 'single' ? '一条' : `${rows.length} 条`}视频数据，请在下方表单核对和补充。`);
  };
  const isDisabled = Boolean(disabled || busy);
  return <div className="space-y-3">
    <p className="text-xs leading-6 text-slate-500">支持 .xlsx / .xlsm；.xls 请先另存为 .xlsx。可按列映射导入，也可让 AI 识别表头、字段和表格方向。导入会替换当前表单数据。</p>
    <input aria-label={mode === 'single' ? '上传单条 Excel' : '上传周度 Excel'} type="file" accept=".xlsx,.xlsm" disabled={isDisabled || !options} onChange={e => { load(e.target.files?.[0] || null); e.target.value = ''; }} className="block w-full rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm" />
    {workbook && <><div className="flex flex-wrap items-center gap-3 text-xs"><span>{workbook.fileName}</span><select aria-label="选择数据工作表" value={workbook.sheetName} disabled={isDisabled} onChange={e => load(file.current, e.target.value)} className="rounded-lg border p-2">{workbook.sheetNames.map(s => <option key={s}>{s}</option>)}</select><Button variant="outline" disabled={isDisabled || !file.current} onClick={() => void run('AI 正在识别表格…', async () => {
      const result = await recognizeReviewWorkbook(file.current!, platform, mode, workbook.sheetName); if (!mounted.current) return;
      setRecognized(result); setIndex(0); onImport(mode === 'single' ? [result.rows[0]] : result.rows); setMessage('AI 识别结果已填入下方表单，请逐条核对后再分析。');
    })}>AI 识别并填入表单</Button></div>
      {recognized && <div className="rounded-lg bg-blue-50 p-3 text-xs leading-6 text-blue-800"><p>已识别 {recognized.rows.length} 条视频 · 每条视频一{recognized.orientation === 'rows' ? '行' : '列'}</p>{recognized.warnings.map((w, i) => <p key={i}>{w}</p>)}<details><summary className="cursor-pointer">查看识别的字段来源</summary>{recognized.fields.map(f => <p key={f.key}>{f.label} ← {f.sourceLabel || '无表头'}（原表第 {f.index} {recognized.orientation === 'rows' ? '列' : '行'}）</p>)}</details></div>}
      {mode === 'single' && (recognized?.rows.length || workbook.records.length) > 1 && <label className="block text-xs text-slate-600">选择要导入的视频<select aria-label="选择导入视频" value={index} disabled={isDisabled} onChange={e => { const i = Number(e.target.value); setIndex(i); if (recognized) onImport([recognized.rows[i]]); }} className="ml-2 max-w-full rounded-lg border p-2">{(recognized?.rows || workbook.records).map((r, i) => <option value={i} key={i}>第 {i + 1} 条 · {String(r.title || Object.values(r)[0] || '')}</option>)}</select></label>}
      <details className="rounded-lg border p-3"><summary className="cursor-pointer text-xs font-medium">手动确认列映射并导入</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead className="bg-slate-50"><tr><th className="p-2">Excel 列</th><th className="p-2">样例</th><th className="p-2">对应字段</th></tr></thead><tbody>{workbook.headers.map((h, i) => <tr key={`${h}-${i}`}><td className="p-2">{h}</td><td className="max-w-48 truncate p-2">{workbook.records[index]?.[h]}</td><td className="p-2"><select aria-label={`${h}对应列`} value={mapping[h] || ''} disabled={isDisabled} onChange={e => { setMapping(m => ({ ...m, [h]: e.target.value })); setRecognized(null); }} className="h-8 w-full min-w-40 rounded-lg border"><option value="">不使用</option><optgroup label="视频信息与标签">{options?.videoFields.map(f => <option key={f.key} value={`__${f.key}`}>{f.label}</option>)}</optgroup><optgroup label="平台数据">{workbook.metricOptions.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</optgroup></select></td></tr>)}</tbody></table></div>
        {duplicate && <p className="mt-2 text-xs text-rose-700">同一用途只能映射一列，请修正重复映射。</p>}{workbook.truncated && <p className="mt-2 text-xs text-amber-700">文件超过 500 行，已截断。请拆分文件后重新上传。</p>}
        <Button variant="outline" className="mt-3" disabled={isDisabled || duplicate || workbook.truncated} onClick={() => { try { setError(''); importRows(rowsFromReviewMapping(workbook.records, mapping)); } catch (e) { setError(e instanceof Error ? e.message : '导入失败'); } }}>按列映射导入表单</Button>
      </details></>}
    {busy && <p role="status" className="text-xs text-slate-500">{busy}</p>}{error && <p role="alert" className="text-xs text-rose-700">{error}</p>}{message && <p role="status" className="text-xs text-emerald-700">{message}</p>}
  </div>;
}
