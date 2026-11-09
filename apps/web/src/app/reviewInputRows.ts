import type { WeeklyRow } from './weeklyReviewApi';
import type { ReviewInputOptions } from './reviewInputApi';
export const createReviewRow = (id: string, publishedAt = ''): WeeklyRow => ({ id, publishedAt, title: '', link: '', script: '', metrics: {}, structureTags: {} });
const key = (value: string) => value.toLowerCase().replace(/[\s_（）()]/g, '');
export const suggestReviewInputMapping = (headers: string[], suggested: Record<string, string>, options: ReviewInputOptions) => {
  const mapping = { ...suggested };
  headers.forEach(header => { const field = options.videoFields.find(f => f.aliases.some(a => key(a) === key(header))); if (field) mapping[header] = `__${field.key}`; });
  return mapping;
};
export const rowsFromReviewMapping = (records: Record<string, string>[], mapping: Record<string, string>): WeeklyRow[] => records.map((record, i) => {
  const values = Object.fromEntries(Object.entries(mapping).filter(([, role]) => role).map(([header, role]) => [role, record[header] ?? '']));
  return { id: values.__id || values.__link || `mapped-row-${i + 1}`, title: values.__title || '', publishedAt: values.__publishedAt || '', link: values.__link || '', script: values.__script || '',
    metrics: Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith('__'))),
    structureTags: Object.fromEntries(['categoryName', 'subcategoryName', 'goldThreeSecondsType', 'titleType', 'endingHookType'].map(k => [k, values[`__${k}`] || ''])) };
});
export const validateReviewFormRows = (rows: WeeklyRow[], mode: 'single' | 'weekly', maxRows = 120) => {
  if (!rows.length || rows.length > maxRows || (mode === 'single' && rows.length !== 1)) throw new Error(`请填写 ${mode === 'single' ? '一条' : `1～${maxRows} 条`}视频数据`);
  const ids = new Set<string>();
  rows.forEach((row, i) => {
    if (!row.id.trim() || ids.has(row.id.trim())) throw new Error(`第 ${i + 1} 条视频标识缺失或重复，请检查导入数据`);
    ids.add(row.id.trim());
    if (String(row.metrics.plays ?? '').trim() === '') throw new Error(`请填写第 ${i + 1} 条视频的播放量，缺失数据不要填成 0`);
    if (mode === 'weekly' && !row.publishedAt.trim()) throw new Error(`请填写第 ${i + 1} 条视频的发布时间`);
  });
};
