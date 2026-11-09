import { getContentAgentConfig } from './contentAgent/config.js';
import { runJsonAgent } from './contentAgent/providers.js';
import { buildCategoryDictionaryText } from './contentAgent/reviewAgents.js';
import { getTopicCategoryDictionaryForEmployee, getTopicLibraryCreativeAdaptation } from './topicLibraryStore.js';
import { buildWeeklyAnalysisReport, normalizeWeeklyInput, weeklyBaselinePlan, WEEKLY_STRUCTURE_FIELDS } from './weeklyAnalysis.js';
import { getActiveReviewMemory, getPreviousWeeklyReport, requireWeeklyCustomer } from './weeklyAnalysisStore.js';

export const runWeeklyAnalysis = async ({ ownerId, customerId, body, config = getContentAgentConfig(), logger, agent = runJsonAgent }) => {
  const input = normalizeWeeklyInput(body);
  await requireWeeklyCustomer(customerId);
  const [dictionary, memory, previousReport, library] = await Promise.all([
    getTopicCategoryDictionaryForEmployee({ customerId }), getActiveReviewMemory({ customerId, platform: input.platform }),
    getPreviousWeeklyReport({ ownerId, customerId, input }),
    getTopicLibraryCreativeAdaptation({ customerId }),
  ]);
  const categoryDictionary = dictionary?.tagDictionary || [];
  const previousPlan = weeklyBaselinePlan(memory, library, categoryDictionary);
  const warnings = [];
  // At most two batches at a time. Only rows in the requested week with text and missing tags incur model calls.
  const pending = body.fillTags === false ? [] : input.rows.filter(r => r.publishedAt >= input.period.start && r.publishedAt <= input.period.end && (r.script || r.title)
    && ['categoryName', 'subcategoryName', 'goldThreeSecondsType', 'titleType', 'endingHookType'].some(k => !r.structureTags[k] || r.structureTags[k] === 'review'));
  const batches = [];
  for (let i = 0; i < pending.length; i += 12) batches.push(pending.slice(i, i + 12));
  let cursor = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      try {
        const output = await agent({ system: `给视频文案补结构标签，只使用词典和给定类型。不能编造文案。缺乏证据用空字符串或 review。返回 {items:[{id,categoryName,subcategoryName,goldThreeSecondsType,titleType,endingHookType}]}。\n词典：${buildCategoryDictionaryText(categoryDictionary)}\n类型：${JSON.stringify(WEEKLY_STRUCTURE_FIELDS.map(s => ({ field: s.field, labels: s.labels })))}`,
          user: JSON.stringify(batch.map(r => ({ id: r.id, title: r.title, script: r.script, existingTags: r.structureTags }))), interfaceName: 'deepseek:weekly-structure-tags', normalizer: raw => raw }, config, { logger });
        for (const row of batch) {
          const matches = Array.isArray(output?.items) ? output.items.filter(i => String(i.id) === row.id) : [];
          if (matches.length !== 1) continue;
          for (const k of ['categoryName', 'subcategoryName', 'goldThreeSecondsType', 'titleType', 'endingHookType']) {
            if (!row.structureTags[k] || row.structureTags[k] === 'review') { row.structureTags[k] = String(matches[0][k] || '').slice(0, 120); row.structureTags.source = 'agent'; }
          }
        }
      } catch { warnings.push(`${batch.length} 条视频的 AI 标签未补齐，请在预览中人工核对`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
  const base = buildWeeklyAnalysisReport({ input, categoryDictionary, previousPlan, previousReport, extraWarnings: warnings });
  let suggestions = null;
  try {
    const output = await agent({
      system: '你是周度账号复盘分析师。数字、判定、配比以后端输入为准，不改写、不自报新比例。解释播放量高于/低于1000的视频及每个大类、小类、三秒、标题、结尾的反馈，提出下周可执行的优化建议。对有文案的视频，结合真实开场、标题、结尾摘出具体写法作为复用或优化依据。只引用输入里存在的文案、指标和标签。不将相关性称为因果，不给无样本类型下结论；没有文案证据时明确仅依据数据。返回 {summary:string,actions:string[]}，actions最多12条。',
      user: JSON.stringify({ platform: base.platformLabel, period: base.period, summary: base.summary, comparison: base.comparison, daily: base.daily,
        categories: base.categories, plan: base.plan, videos: base.videos.map(v => ({ id: v.id, title: v.title, script: base.sourceRows.find(r => r.id === v.id)?.script || '', metrics: v.metrics, tags: v.structureTags, judgments: v.judgments, structures: v.structures })) }),
      interfaceName: 'deepseek:weekly-account-review', normalizer: raw => raw,
    }, config, { logger });
    if (output && (String(output.summary || '').trim() || output.actions?.length)) suggestions = output;
    else warnings.push('AI 没有返回可用建议，解释文字待人工补充');
  } catch { warnings.push('AI 建议未生成，数据分析与配比建议仍可使用，解释文字待人工补充'); }
  return buildWeeklyAnalysisReport({ input, categoryDictionary, previousPlan, previousReport, suggestions, extraWarnings: warnings });
};
