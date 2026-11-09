import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyAnalysisReport, normalizeWeeklyInput, normalizeWeeklyPlan, reviewDay, weeklyBaselinePlan } from '../api/_lib/weeklyAnalysis.js';
import { applyReviewMemory } from '../api/_lib/weeklyCreativeAdaptation.js';
import { formatAdaptationForPrompt } from '../api/_lib/topicCreativeAdaptation.js';
import { weeklyDictionary, weeklyInput } from './helpers/weekly-fixture.mjs';
import { suggestWeeklyMapping, weeklyRowsFromMapping } from '../../web/src/app/weeklyWorkbookMapping.ts';
import { selectTopicsByWeeklyPlan } from '../../web/src/app/weeklyTopicSelection.ts';
const build = (input = weeklyInput(), patch = {}) => buildWeeklyAnalysisReport({ input, categoryDictionary: weeklyDictionary, ...patch });

test('周报严格分开 >1000、<1000、=1000，并保留四个流量池边界', () => {
  const report = build();
  assert.deepEqual(report.absolute, { above: ['v3', 'v4', 'v5'], below: ['v0', 'v1'], boundary: ['v2'] });
  assert.deepEqual(report.pools.map(p => p.sampleCount), [1, 2, 2, 1]);
  assert.equal(report.summary.totals.plays.value, 27900);
  assert.equal(report.daily.length, 7);
  assert.equal(report.daily[6].sampleCount, 0);
});
test('日历日期支持 Excel、中文和带时区 ISO，拒绝不存在的日期', () => {
  assert.equal(reviewDay('2026/10/1'), '2026-10-01');
  assert.equal(reviewDay('2026年10月1日'), '2026-10-01');
  assert.equal(reviewDay('2026-10-01T17:00:00Z'), '2026-10-02');
  assert.equal(reviewDay(46296), '2026-10-01');
  assert.equal(reviewDay('2026-02-30'), '');
  assert.equal(reviewDay('not a date'), '');
});
test('周期必须七天、平台必须有效、重复视频不能重复计数', () => {
  assert.throws(() => normalizeWeeklyInput(weeklyInput({ platform: 'unknown' })), /平台|抖音/);
  assert.throws(() => normalizeWeeklyInput(weeklyInput({ period: { start: '2026-10-01', end: '2026-10-08' } })), /七天/);
  const input = weeklyInput(); input.rows[1].id = input.rows[0].id;
  assert.throws(() => normalizeWeeklyInput(input), /重复/);
  assert.throws(() => normalizeWeeklyInput(weeklyInput({ rows: Array.from({ length: 121 }, (_, i) => ({ ...weeklyInput().rows[0], id: String(i) })) })), /120/);
});
test('周期外与缺播放量有明确排除原因，不吞行、不按零计', () => {
  const input = weeklyInput(); input.rows[0].publishedAt = '2026-09-30'; input.rows[1].metrics.plays = '';
  const r = build(input);
  assert.equal(r.summary.sampleCount, 4); assert.equal(r.excluded.length, 2);
  assert.match(r.excluded[0].reason, /周期/); assert.match(r.excluded[1].reason, /播放量/);
});
test('互动率按有效播放量加权，缺失指标和越界比率不参与平均', () => {
  const input = weeklyInput(); input.rows[0].metrics.likes = ''; input.rows[1].metrics.completionRate = '150%';
  const r = build(input);
  assert.equal(r.summary.interactionRate.sampleCount, 5);
  assert.ok(Math.abs(r.summary.interactionRate.value - 0.09) < 1e-8);
  assert.equal(r.summary.completionRate.sampleCount, 5);
  assert.ok(Math.abs(r.summary.completionRate.value - 0.32) < 1e-8);
  assert.equal(r.summary.totals.likes.missingCount, 1);
});
test('缺标签保留待复核视频，但不参与选题与文案类型配比', () => {
  const input = weeklyInput(); input.rows[0].structureTags = { categoryName: '不存在', goldThreeSecondsType: 'review' };
  const r = build(input);
  assert.equal(r.videos.length, 6); assert.equal(r.plan.topics.reduce((s, c) => s + c.sampleCount, 0), 5);
  assert.ok(r.plan.structures.every(c => c.goldThreeSeconds.every(s => s.type !== 'review')));
});
test('大类、小类与结构配比合计100，条数恰好下周计划且零份额不获配', () => {
  const r = build(); const plan = normalizeWeeklyPlan(r.plan, r.plan, 10);
  assert.equal(plan.topics.reduce((s, c) => s + c.ratio, 0), 100);
  assert.equal(plan.topics.reduce((s, c) => s + c.count, 0), 10);
  for (const c of plan.topics) { assert.equal(c.subcategories.reduce((s, v) => s + v.count, 0), c.count); assert.equal(c.subcategories.reduce((s, v) => s + v.ratio, 0), 100); }
  for (const c of plan.structures) for (const key of ['goldThreeSeconds', 'title', 'endingHooks']) { assert.equal(c[key].reduce((s, v) => s + v.ratio, 0), 100); assert.equal(c[key].reduce((s, v) => s + v.count, 0), 10); assert.ok(c[key].filter(s => s.ratio === 0).every(s => s.count === 0)); }
});
test('编辑器用权重也能归一化，拒绝负数、陌生键、重复键及丢失分类', () => {
  const r = build(); const draft = structuredClone(r.plan); draft.topics.forEach(t => { t.ratio = 30; });
  assert.deepEqual(normalizeWeeklyPlan(draft, r.plan).topics.map(t => t.ratio), [50, 50]);
  const bad = structuredClone(r.plan); bad.topics[0].ratio = -1;
  assert.throws(() => normalizeWeeklyPlan(bad, r.plan), /0～100/);
  bad.topics[0].ratio = 1; bad.topics[0].name = '伪造分类'; assert.throws(() => normalizeWeeklyPlan(bad, r.plan), /缺失/);
  bad.topics = []; assert.throws(() => normalizeWeeklyPlan(bad, r.plan), /不一致/);
});
test('选题库基准与已确认配比按结构独立优先，不改写原始报告', () => {
  const library = { accounts: [{ goldThreeSeconds: { categoryBreakdown: [{ categoryName: '风险防御', dimensions: [{ type: 'fear', ratio: 60 }, { type: 'pain', ratio: 40 }] }] } }] };
  const original = structuredClone(library);
  const baseline = weeklyBaselinePlan({ plan: { topics: [], structures: [{ categoryName: '风险防御', title: [{ type: 'curiosity', ratio: 100 }] }] } }, library, weeklyDictionary);
  assert.equal(baseline.structures[0].goldThreeSeconds[0].ratio, 60); assert.equal(baseline.structures[0].title[0].type, 'curiosity');
  assert.deepEqual(library, original);
});
test('复盘记忆标题与三秒独立，槽位使用确认比例而非历史样本数', () => {
  const memory = { id: 'version1', accountName: '账号', period: { start: '2026-10-01', end: '2026-10-07' }, plan: { structures: [{ categoryName: '风险防御', goldThreeSeconds: [{ type: 'fear', count: 1, ratio: 80 }, { type: 'pain', count: 9, ratio: 20 }], title: [{ type: 'curiosity', ratio: 100 }], endingHooks: [] }] } };
  const fallback = { endingHooks: { slots: [1] } };
  const merged = applyReviewMemory({ adaptation: fallback, memory, categoryName: '风险防御' });
  assert.equal(merged.goldThreeSeconds.slots.filter(s => s.type === 'fear').length, 8);
  assert.ok(merged.title.slots.every(s => s.type === 'curiosity')); assert.equal(merged.endingHooks, fallback.endingHooks);
  assert.equal(merged.title.source, 'review_memory'); assert.equal(applyReviewMemory({ adaptation: fallback, memory, categoryName: '未知' }), fallback);
  memory.notes = '用真实劳动争议场景呈现痛点'; memory.experience = { summary: '恐惧开场表现更好', actions: ['标题保持具体'] };
  const experienced = applyReviewMemory({ adaptation: fallback, memory, categoryName: '风险防御' });
  assert.match(formatAdaptationForPrompt(experienced.title), /真实劳动争议场景/);
  assert.match(formatAdaptationForPrompt(experienced.goldThreeSeconds), /标题保持具体/);
  assert.equal(fallback.endingHooks.reviewExperience, undefined);
});
test('人工为未采样结构指定配比后仍换算十条候选', () => {
  const input = weeklyInput(); input.rows.forEach(r => { r.structureTags.titleType = 'review'; });
  const r = build(input); const draft = structuredClone(r.plan);
  assert.ok(draft.structures[0].title.every(v => v.ratio === 0));
  draft.structures[0].title[0].ratio = 100;
  assert.equal(normalizeWeeklyPlan(draft, r.plan).structures[0].title.reduce((s, v) => s + v.count, 0), 10);
});
test('前一周变化按均播量与百分点计算，没有前一周数据就留空', () => {
  const previous = build(); const input = weeklyInput(); input.rows.forEach(r => { r.metrics.plays *= 2; });
  const r = build(input, { previousReport: previous });
  assert.equal(r.comparison.meanPlaysChange, 1); assert.equal(build().comparison, null);
});
test('Excel 指标与元数据映射分别读取，结构列不能混进数值指标', () => {
  const headers = ['发布日期', '标题', '播放量', '3s类型', '大类'];
  const mapping = suggestWeeklyMapping(headers, { 播放量: 'plays' });
  const rows = weeklyRowsFromMapping([{ 发布日期: '2026-10-01', 标题: '示例', 播放量: '12500', '3s类型': '恐惧', 大类: '风险防御' }], mapping);
  assert.equal(rows[0].publishedAt, '2026-10-01'); assert.deepEqual(rows[0].metrics, { plays: '12500' }); assert.equal(rows[0].structureTags.goldThreeSecondsType, '恐惧');
});
test('选题勾选尊重大小类配额，不用其他类补缺口，也不选择待复核', () => {
  const plan = { topics: [{ name: 'A', count: 3, subcategories: [{ name: 'a1', count: 1 }, { name: 'a2', count: 2 }] }] };
  const topics = [
    { id: '1', stats: { likes: 100 }, content: { categoryName: 'A', subcategoryName: 'a1' } },
    { id: '2', stats: { likes: 200 }, content: { categoryName: 'A', subcategoryName: 'a1' } },
    { id: '3', stats: { likes: 999 }, content: { categoryName: 'A', subcategoryName: 'a2', categoryId: 'review' } },
    { id: '4', stats: { likes: 800 }, content: { categoryName: 'B', subcategoryName: 'b1' } },
  ];
  const result = selectTopicsByWeeklyPlan(topics, plan);
  assert.deepEqual(result.ids, ['2']); assert.deepEqual(result.shortages, ['A / a2 缺 2 条']);
});
