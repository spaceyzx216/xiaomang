import type { WeeklyPlan } from './weeklyReviewApi';
/** Respect confirmed quotas; never silently fill a missing category with unrelated topics. */
export const selectTopicsByWeeklyPlan = (topics: Array<{ id: string; stats?: { likes?: number }; content?: { categoryName: string; subcategoryName: string; categoryId?: string } }>, plan: WeeklyPlan) => {
  const selected = new Set<string>();
  const shortages: string[] = [];
  for (const category of plan.topics) {
    if (category.count <= 0) continue;
    const candidates = topics.filter(t => t.content?.categoryName === category.name && t.content.categoryId !== 'review')
      .sort((a, b) => (b.stats?.likes || 0) - (a.stats?.likes || 0) || a.id.localeCompare(b.id));
    if (category.subcategories.length) {
      for (const sub of category.subcategories) {
        const pool = candidates.filter(t => t.content?.subcategoryName === sub.name && !selected.has(t.id));
        pool.slice(0, sub.count).forEach(t => selected.add(t.id));
        if (pool.length < sub.count) shortages.push(`${category.name} / ${sub.name} 缺 ${sub.count - pool.length} 条`);
      }
    } else {
      candidates.filter(t => !selected.has(t.id)).slice(0, category.count).forEach(t => selected.add(t.id));
      if (candidates.length < category.count) shortages.push(`${category.name} 缺 ${category.count - candidates.length} 条`);
    }
  }
  return { ids: [...selected], shortages };
};
