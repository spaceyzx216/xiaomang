import type { WeeklyRow } from './weeklyReviewApi';
export const WEEKLY_COLUMN_ROLES = [
  { key: '__date', label: '发布时间', aliases: ['发布时间', '发布日期', '发布日', '日期', '时间', 'publishedAt', 'publish_time'] },
  { key: '__id', label: '视频 ID（可选）', aliases: ['视频id', '作品id', 'videoid', 'id'] },
  { key: '__title', label: '视频标题', aliases: ['标题', '视频标题', '作品标题', 'title'] },
  { key: '__link', label: '视频链接（可选）', aliases: ['链接', '视频链接', '作品链接', 'link'] },
  { key: '__script', label: '视频文案', aliases: ['文案', '口播文案', '脚本', '视频文案', 'script'] },
  { key: '__categoryName', label: '选题大类', aliases: ['大类', '选题大类', '选题类型大类', 'categoryName'] },
  { key: '__subcategoryName', label: '选题小类', aliases: ['小类', '选题小类', '选题类型小类', 'subcategoryName'] },
  { key: '__goldThreeSecondsType', label: '三秒类型标签', aliases: ['三秒类型', '3s类型', '3秒类型', '三秒类型标签', 'goldThreeSecondsType'] },
  { key: '__titleType', label: '标题类型标签', aliases: ['标题类型', '标题类型标签', 'titleType'] },
  { key: '__endingHookType', label: '结尾钩子类型标签', aliases: ['结尾类型', '结尾钩子类型', '结尾钩子', 'endingHookType'] },
];
const key = (v: string) => v.toLowerCase().replace(/[\s_（）()]/g, '');
export const suggestWeeklyMapping = (headers: string[], suggested: Record<string, string>) => {
  const mapping = { ...suggested };
  for (const header of headers) { const match = WEEKLY_COLUMN_ROLES.find(r => r.aliases.some(a => key(a) === key(header))); if (match) mapping[header] = match.key; }
  return mapping;
};
export const weeklyRowsFromMapping = (records: Record<string, string>[], mapping: Record<string, string>): WeeklyRow[] => records.map((record, index) => {
  const fields: Record<string, string> = {};
  const metrics: Record<string, string> = {};
  for (const [header, role] of Object.entries(mapping)) { if (!role) continue; if (role.startsWith('__')) fields[role.slice(2)] = record[header] || ''; else metrics[role] = record[header] || ''; }
  return { id: fields.id || fields.link || `row-${index + 1}`, title: fields.title || '', link: fields.link || '', publishedAt: fields.date || '', script: fields.script || '', metrics,
    structureTags: Object.fromEntries(['categoryName', 'subcategoryName', 'goldThreeSecondsType', 'titleType', 'endingHookType'].map(k => [k, fields[k] || ''])) };
});
