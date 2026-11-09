import type { WeeklyRow } from './weeklyReviewApi';
import type { ReviewInputOptions } from './reviewInputApi';
import type { TopicTagDictionaryEntry } from './topicLibrary';
const inputClass = 'h-9 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-500';
export function ReviewVideoFields({ row, onChange, options, dictionary = [], disabled = false, prefix = '', requireDate = false }: {
  row: WeeklyRow; onChange: (value: WeeklyRow) => void; options: ReviewInputOptions | null; dictionary?: TopicTagDictionaryEntry[]; disabled?: boolean; prefix?: string; requireDate?: boolean;
}) {
  const label = (value: string) => `${prefix}${value}`;
  const change = (key: keyof WeeklyRow, value: string) => onChange({ ...row, [key]: value });
  const categories = new Map<string, Set<string>>();
  dictionary.forEach(c => { if (!categories.has(c.name)) categories.set(c.name, new Set()); c.subcategories.forEach(s => categories.get(c.name)!.add(s.name)); });
  const tags = row.structureTags;
  const tagChange = (key: string, value: string) => onChange({ ...row, structureTags: { ...tags, [key]: value, ...(key === 'categoryName' ? { subcategoryName: '' } : {}) } });
  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2">
      {([['title', '视频标题', '填写真实视频标题'], ['publishedAt', `发布时间${requireDate ? '（必填）' : '（可选）'}`, '例如 2026-10-01'], ['link', '视频链接（可选）', 'https://…']] as const).map(([key, title, placeholder]) => <label key={key} className={key === 'title' ? 'sm:col-span-2' : ''}><span className="mb-1 block text-xs text-slate-600">{title}</span><input aria-label={label(key === 'publishedAt' ? '发布时间' : title)} value={row[key]} onChange={e => change(key, e.target.value)} disabled={disabled} placeholder={placeholder} className={inputClass} /></label>)}
    </div>
    <label className="block"><span className="mb-1 block text-xs text-slate-600">视频文案</span><textarea aria-label={label('视频文案')} value={row.script} onChange={e => change('script', e.target.value)} disabled={disabled} rows={3} maxLength={requireDate ? 2000 : 12000} placeholder="粘贴开场、正文和结尾的真实文案，用于结构拆解。" className="w-full rounded-lg border border-slate-200 p-3 text-sm outline-none focus:border-blue-500" /></label>
    <p className="text-xs text-slate-500">计数填实际数值；比例可填 32% 或 0.32，时长填秒。缺失数据留空，不要填成 0。</p>
    {!options && <p className="text-xs text-slate-500">正在加载当前平台的数据字段…</p>}
    {(['engagement', 'professional'] as const).map(group => <fieldset key={group} className="min-w-0"><legend className="mb-2 text-xs font-medium text-slate-700">{group === 'engagement' ? '互动数据' : '播放与留存数据'}</legend><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{options?.metricOptions.filter(m => m.group === group).map(m => <label key={m.key} className="min-w-0"><span className="mb-1 block text-xs text-slate-600">{m.label}{m.key === 'plays' ? '（必填）' : m.optional ? '（可选）' : ''}</span><input aria-label={label(m.label)} inputMode="decimal" value={row.metrics[m.key] ?? ''} disabled={disabled} onChange={e => onChange({ ...row, metrics: { ...row.metrics, [m.key]: e.target.value } })} placeholder={m.kind === 'rate' ? '例如 32%' : m.kind === 'seconds' ? '秒' : '实际数值'} className={inputClass} /><span className="mt-1 block text-[11px] leading-4 text-slate-400">{m.meaning}</span></label>)}</div></fieldset>)}
    <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-xs font-medium text-slate-600">选题与文案结构标签（可手动指定）</summary><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-xs text-slate-600">选题大类<select aria-label={label('选题大类')} value={tags.categoryName || ''} onChange={e => tagChange('categoryName', e.target.value)} disabled={disabled} className={`${inputClass} mt-1`}><option value="">待补充 / AI 判断</option>{tags.categoryName && !categories.has(tags.categoryName) && <option>{tags.categoryName}</option>}{[...categories.keys()].map(n => <option key={n}>{n}</option>)}</select></label>
      <label className="text-xs text-slate-600">选题小类<select aria-label={label('选题小类')} value={tags.subcategoryName || ''} onChange={e => tagChange('subcategoryName', e.target.value)} disabled={disabled} className={`${inputClass} mt-1`}><option value="">待补充 / AI 判断</option>{tags.subcategoryName && !categories.get(tags.categoryName)?.has(tags.subcategoryName) && <option>{tags.subcategoryName}</option>}{[...(categories.get(tags.categoryName) || [])].map(n => <option key={n}>{n}</option>)}</select></label>
      {options?.structures.map(s => <label key={s.key} className="text-xs text-slate-600">{s.label}类型<select aria-label={label(`${s.label}类型`)} value={tags[s.field] || ''} onChange={e => tagChange(s.field, e.target.value)} disabled={disabled} className={`${inputClass} mt-1`}><option value="">待补充 / AI 判断</option>{tags[s.field] && !s.labels[tags[s.field]] && <option>{tags[s.field]}</option>}{Object.entries(s.labels).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>)}
    </div></details>
  </div>;
}
