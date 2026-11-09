import { buildCategoryAdaptation } from './topicCreativeAdaptation.js';
import { WEEKLY_STRUCTURE_FIELDS } from './weeklyAnalysis.js';
/** Overlay each confirmed structure separately. Absent memory/types retain the benchmark baseline. */
export const applyReviewMemory = ({ adaptation = null, memory, categoryName }) => {
  const category = memory?.plan?.structures?.find(c => c.categoryName === categoryName);
  if (!category) return adaptation;
  const result = { ...(adaptation || {}), accountName: memory.accountName };
  let applied = false;
  for (const field of WEEKLY_STRUCTURE_FIELDS) {
    const dimensions = (category[field.key] || []).filter(d => d.ratio > 0).map(d => ({ type: d.type, ratio: d.ratio }));
    if (!dimensions.length) continue;
    const value = buildCategoryAdaptation({ categoryName, labels: field.labels, report: { categoryBreakdown: [{ categoryName, dimensions }] } });
    result[field.key] = { ...value, source: 'review_memory', memoryVersionId: memory.id,
      reviewExperience: { notes: memory.notes || '', summary: memory.experience?.summary || '', actions: memory.experience?.actions || [] },
      note: `已按经理确认的周度复盘配比生成 ${value.slots.length} 条${field.label}候选（${memory.period.start}～${memory.period.end}）。` };
    applied = true;
  }
  return applied ? result : adaptation;
};
