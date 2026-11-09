/** 4.2: observed statistics and editable prescriptions are separate. No model decides numbers. */
import { buildVideoAnalysisReport } from './videoAnalysis.js';
import { isReviewPlatform, metricsForPlatform, PLAY_BUCKETS } from './reviewMetrics.js';
import { GOLD_THREE_SECOND_TYPE_LABELS } from './goldThreeSeconds.js';
import { ENDING_HOOK_TYPE_LABELS } from './endingHooks.js';
import { apportionRatios } from './categoryTypeBreakdown.js';
import { planCreativeSlotCounts } from './topicCreativeAdaptation.js';

export const WEEKLY_REPORT_TYPE = 'weekly_account_analysis';
export const MAX_WEEKLY_ROWS = 120;
export const WEEKLY_STRUCTURE_FIELDS = [
  { key: 'goldThreeSeconds', field: 'goldThreeSecondsType', label: '黄金三秒', labels: GOLD_THREE_SECOND_TYPE_LABELS, verdict: 'goldThreeSeconds' },
  { key: 'title', field: 'titleType', label: '标题', labels: GOLD_THREE_SECOND_TYPE_LABELS, verdict: 'title' },
  { key: 'endingHooks', field: 'endingHookType', label: '结尾钩子', labels: ENDING_HOOK_TYPE_LABELS, verdict: 'endingHook' },
];
const text = (v, max = 120) => String(v ?? '').trim().slice(0, max);
export const weeklyError = message => Object.assign(new Error(message), { status: 400 });
const finite = v => typeof v === 'number' && Number.isFinite(v);
const usable = v => finite(v) && v >= 0;
const rate = v => usable(v) && v <= 1;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2 : null; };
const clamp = v => Math.max(0.5, Math.min(2, v));

/** Excel serial dates and local China calendar dates; never depend on the host timezone. */
export const reviewDay = value => {
  const v = text(value, 100);
  if (/^\d+(?:\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n < 20000 || n > 100000) return '';
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
  }
  const m = v.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:$|[ T])/);
  if (!m) return '';
  const day = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day) return '';
  // An ISO timestamp with an explicit offset represents an instant, not a local date.
  if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(v)) {
    const instant = Date.parse(v);
    return Number.isFinite(instant) ? new Date(instant + 8 * 3600000).toISOString().slice(0, 10) : '';
  }
  return day;
};

export const normalizeWeeklyInput = body => {
  if (!isReviewPlatform(body?.platform)) throw weeklyError('请选择抖音或视频号');
  const start = reviewDay(body?.period?.start);
  const end = reviewDay(body?.period?.end);
  if (!start || !end || Date.parse(end) - Date.parse(start) !== 6 * 86400000) throw weeklyError('请选择连续七天的复盘周期');
  const accountName = text(body.accountName);
  if (!accountName) throw weeklyError('请填写本次复盘的账号名称，并只上传这一个账号的数据');
  const nextWeekCount = Number(body.nextWeekCount ?? 10);
  if (!Number.isInteger(nextWeekCount) || nextWeekCount < 1 || nextWeekCount > 100) throw weeklyError('下周计划条数应为 1～100 的整数');
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > MAX_WEEKLY_ROWS) throw weeklyError(`请上传 1～${MAX_WEEKLY_ROWS} 条视频数据`);
  const ids = new Set();
  const rows = body.rows.map((row, index) => {
    if (!row || typeof row !== 'object') throw weeklyError(`第 ${index + 1} 行格式无效`);
    const id = text(row.id || `row-${index + 1}`);
    if (ids.has(id)) throw weeklyError(`视频标识重复：${id}，请先去重`);
    ids.add(id);
    const publishedAt = reviewDay(row.publishedAt);
    if (!publishedAt) throw weeklyError(`第 ${index + 1} 行的发布时间缺失或无效，请确认日期列映射`);
    const raw = row.metrics && typeof row.metrics === 'object' ? row.metrics : {};
    const metrics = Object.fromEntries(metricsForPlatform(body.platform).map(m => [m.key, typeof raw[m.key] === 'number' ? raw[m.key] : text(raw[m.key], 60)]));
    const structureTags = Object.fromEntries(['categoryName', 'subcategoryName', 'goldThreeSecondsType', 'titleType', 'endingHookType', 'source'].map(k => [k, text(row.structureTags?.[k])]));
    return { id, publishedAt, title: text(row.title, 300), link: text(row.link, 500), script: text(row.script, 2000), metrics, structureTags };
  });
  return { platform: body.platform, accountName, period: { start, end }, nextWeekCount, rows };
};

const weighted = (videos, pick) => {
  const valid = videos.filter(v => v.metrics.plays > 0 && rate(pick(v)));
  const plays = valid.reduce((s, v) => s + v.metrics.plays, 0);
  return { value: plays ? valid.reduce((s, v) => s + pick(v) * v.metrics.plays, 0) / plays : null, sampleCount: valid.length };
};
export const summarizeWeeklyVideos = (videos, platform) => {
  const counts = metricsForPlatform(platform).filter(m => m.kind !== 'rate' && !['avgPlaySeconds', 'durationSeconds'].includes(m.key));
  const totals = Object.fromEntries(counts.map(m => {
    const values = videos.map(v => v.metrics[m.key]).filter(usable);
    return [m.key, { value: values.length ? values.reduce((s, v) => s + v, 0) : null, sampleCount: values.length, missingCount: videos.length - values.length }];
  }));
  return {
    sampleCount: videos.length, totals,
    meanPlays: mean(videos.map(v => v.metrics.plays).filter(usable)),
    medianPlays: median(videos.map(v => v.metrics.plays).filter(usable)),
    interactionRate: weighted(videos, v => v.derived.interactionRate),
    completionRate: weighted(videos, v => v.metrics.completionRate),
    avgPlayRate: weighted(videos, v => v.derived.avgPlayRate),
    aboveBaseCount: videos.filter(v => v.metrics.plays > 1000).length,
    optimizeCount: videos.filter(v => v.structures.some(s => s.verdict === 'optimize')).length,
  };
};
const groups = (videos, pick, platform) => {
  const map = new Map();
  for (const video of videos) { const key = pick(video) || '待人工复核'; if (!map.has(key)) map.set(key, []); map.get(key).push(video); }
  return [...map].map(([name, list]) => ({ name, ...summarizeWeeklyVideos(list, platform), videoIds: list.map(v => v.id) }));
};
const ratios = entries => apportionRatios(entries.map(e => ({ ...e, ratio: Number(e.ratio) || 0 })));
const allocate = (entries, count) => {
  const allocated = new Map(planCreativeSlotCounts(entries.map(e => ({ type: e.name || e.type, ratio: e.ratio })), count).map(e => [e.type, e.count]));
  return entries.map(e => ({ ...e, count: allocated.get(e.name || e.type) || 0 }));
};
export const weeklyBaselinePlan = (memory, library, dictionary = []) => {
  const baseline = { topics: memory?.plan?.topics || [], structures: [] };
  for (const name of new Set(dictionary.map(c => c.name))) {
    const confirmed = memory?.plan?.structures?.find(c => c.categoryName === name);
    const category = { categoryName: name };
    for (const field of WEEKLY_STRUCTURE_FIELDS) {
      const historical = (library?.accounts || []).map(account => (field.key === 'endingHooks' ? account.endingHooks : account.goldThreeSeconds)?.categoryBreakdown?.find(c => c.categoryName === name)?.dimensions).find(d => d?.length);
      category[field.key] = confirmed?.[field.key]?.some(d => d.ratio > 0) ? confirmed[field.key] : (historical || []).filter(d => field.labels[d.type] && d.type !== 'review').map(d => ({ type: d.type, ratio: d.ratio }));
    }
    baseline.structures.push(category);
  }
  return baseline;
};

/** Shrink small samples toward the baseline; an observation is never a causal claim. */
const prescribe = (entries, baseline, score, count) => {
  const base = new Map((baseline || []).map(e => [e.name || e.type, e.ratio]));
  const starting = entries.map(e => ({ ...e, ratio: base.has(e.name || e.type) ? base.get(e.name || e.type) : e.sampleCount }));
  if (!starting.some(e => e.ratio > 0)) return starting.map(e => ({ ...e, baselineRatio: 0, observedRatio: 0, ratio: 0, count: 0 }));
  const original = ratios(starting);
  const observed = new Map(ratios(entries.map(e => ({ ...e, ratio: e.sampleCount }))).map(e => [e.name || e.type, e.ratio]));
  return allocate(ratios(original.map(e => ({ ...e, baselineRatio: e.ratio, observedRatio: observed.get(e.name || e.type) || 0,
    ratio: e.ratio * (1 + e.sampleCount / (e.sampleCount + 3) * (score(e) - 1)),
    confidence: e.sampleCount >= 3 ? 'observed' : 'small_sample',
  }))), count);
};

export const buildWeeklyAnalysisReport = ({ input, categoryDictionary = [], previousPlan = null, previousReport = null, suggestions = null, extraWarnings = [] }) => {
  const body = normalizeWeeklyInput(input);
  const { platform, period, nextWeekCount } = body;
  const excluded = [];
  const videos = [];
  for (const row of body.rows) {
    if (row.publishedAt < period.start || row.publishedAt > period.end) { excluded.push({ id: row.id, title: row.title, reason: '不在本周周期内' }); continue; }
    const report = buildVideoAnalysisReport({ platform, rawMetrics: row.metrics, scriptText: row.script, structureTags: row.structureTags, categoryDictionary, video: { title: row.title, link: row.link, publishedAt: row.publishedAt } });
    if (!usable(report.metrics.plays)) { excluded.push({ id: row.id, title: row.title, reason: '播放量缺失或为负数' }); continue; }
    videos.push({ id: row.id, publishedAt: row.publishedAt, title: row.title, link: row.link, ...Object.fromEntries(['metrics', 'derived', 'judgments', 'structures', 'structureTags', 'playBucket', 'warnings'].map(k => [k, report[k]])) });
  }
  if (!videos.length) throw weeklyError('本周没有可分析的视频，请核对周期、发布时间和播放量');
  const summary = summarizeWeeklyVideos(videos, platform);
  const pools = PLAY_BUCKETS.map(p => ({ key: p.key, label: p.label, hint: p.hint, ...summarizeWeeklyVideos(videos.filter(v => v.playBucket.key === p.key), platform), videoIds: videos.filter(v => v.playBucket.key === p.key).map(v => v.id) }));
  for (const video of videos) {
    const pool = pools.find(p => p.key === video.playBucket.key);
    video.relative = { playsVsAccountMedian: summary.medianPlays > 0 ? video.metrics.plays / summary.medianPlays : null,
      interactionVsPool: rate(video.derived.interactionRate) && pool.interactionRate.value > 0 ? video.derived.interactionRate / pool.interactionRate.value : null };
  }
  const dict = new Map(categoryDictionary.filter(c => c.name && !['review', '待人工复核'].includes(c.name)).map(c => [c.name, c]));
  const classified = videos.filter(v => dict.has(v.structureTags.categoryName));
  const categories = [...dict.keys()].map(name => {
    const list = classified.filter(v => v.structureTags.categoryName === name);
    return { name, ...summarizeWeeklyVideos(list, platform), subcategories: groups(list, v => v.structureTags.subcategoryName, platform),
      structures: WEEKLY_STRUCTURE_FIELDS.map(s => ({ key: s.key, label: s.label, types: groups(list, v => s.labels[v.structureTags[s.field]] || '待人工复核', platform) })) };
  });
  const performance = list => mean(list.map(v => mean([usable(v.relative.playsVsAccountMedian) ? clamp(v.relative.playsVsAccountMedian) : 1, usable(v.relative.interactionVsPool) ? clamp(v.relative.interactionVsPool) : 1]))) || 1;
  const topics = prescribe(categories, previousPlan?.topics, e => performance(classified.filter(v => v.structureTags.categoryName === e.name)), nextWeekCount).map(c => {
    const definition = dict.get(c.name);
    const list = classified.filter(v => v.structureTags.categoryName === c.name);
    const subentries = (definition.subcategories || []).filter(s => s.name && s.name !== '待人工复核').map(s => ({ name: s.name, sampleCount: list.filter(v => v.structureTags.subcategoryName === s.name).length }));
    return { name: c.name, ratio: c.ratio, count: c.count, baselineRatio: c.baselineRatio, observedRatio: c.observedRatio, sampleCount: c.sampleCount, confidence: c.confidence,
      subcategories: prescribe(subentries, previousPlan?.topics?.find(t => t.name === c.name)?.subcategories, e => performance(list.filter(v => v.structureTags.subcategoryName === e.name)), c.count).map(s => ({ ...s })) };
  });
  const structures = [...dict.keys()].map(categoryName => ({ categoryName, ...Object.fromEntries(WEEKLY_STRUCTURE_FIELDS.map(s => {
    const list = classified.filter(v => v.structureTags.categoryName === categoryName && v.structureTags[s.field] !== 'review');
    const types = Object.entries(s.labels).filter(([type]) => type !== 'review').map(([type, label]) => ({ type, label, sampleCount: list.filter(v => v.structureTags[s.field] === type).length }));
    const previous = previousPlan?.structures?.find(c => c.categoryName === categoryName)?.[s.key];
    return [s.key, prescribe(types, previous, e => {
      const relevant = list.filter(v => v.structureTags[s.field] === e.type);
      return mean(relevant.map(v => { const verdict = v.structures.find(d => d.key === s.verdict)?.verdict; return verdict === 'reuse' ? 1.25 : verdict === 'optimize' ? 0.75 : 1; })) || 1;
    }, 10)];
  })) }));
  const daily = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(Date.parse(period.start) + i * 86400000).toISOString().slice(0, 10);
    return { day, ...summarizeWeeklyVideos(videos.filter(v => v.publishedAt === day), platform) };
  });
  const delta = previousReport?.summary ? { previousPeriod: previousReport.period, previousSampleCount: previousReport.summary.sampleCount,
    meanPlaysChange: previousReport.summary.meanPlays > 0 ? summary.meanPlays / previousReport.summary.meanPlays - 1 : null,
    interactionRateChange: rate(summary.interactionRate.value) && rate(previousReport.summary.interactionRate?.value) ? summary.interactionRate.value - previousReport.summary.interactionRate.value : null } : null;
  return { reportType: WEEKLY_REPORT_TYPE, version: 1, platform, platformLabel: platform === 'douyin' ? '抖音' : '视频号', accountName: body.accountName, period, nextWeekCount,
    sourceRows: body.rows, summary, daily, pools, videos, excluded, categories,
    absolute: { above: videos.filter(v => v.metrics.plays > 1000).map(v => v.id), below: videos.filter(v => v.metrics.plays < 1000).map(v => v.id), boundary: videos.filter(v => v.metrics.plays === 1000).map(v => v.id) },
    comparison: delta, plan: { topics, structures }, suggestions: { summary: text(suggestions?.summary, 3000), actions: (Array.isArray(suggestions?.actions) ? suggestions.actions : []).map(a => text(a, 1000)).filter(Boolean).slice(0, 12) },
    methodology: '大类/小类以平均播放量及同流量池互动率相对表现加权，倍率限制在 0.5～2；三秒/标题/结尾以对应平台指标判定加权（可复用 1.25、需优化 0.75、其余 1）。相对基准配比按样本数 n/(n+3) 平滑；不足三条仅作弱证据。基准优先采用已确认记忆：没有记忆时选题使用本周标签分布，结构优先使用选题库配比，再回落到本周标签分布。未采样的类型不推断表现，配比由最大余额法归一化，人工确认后生效。',
    warnings: [...extraWarnings, ...(excluded.length ? [`已排除 ${excluded.length} 条无效或周期外视频，详见排除清单`] : []), ...(classified.length < videos.length ? [`${videos.length - classified.length} 条视频的选题大类未匹配客户选题库，不参与选题配比`] : []), ...(videos.some(v => v.playBucket.ambiguous) ? ['50 以下与 200～500 的区间未在需求中定义，按相邻档归类并标记为参考'] : []), '上传应为同一账号、同一统计时点的数据；发布时间较近的视频观察时长较短，比较仅反映相关性。'],
    analysisSource: suggestions ? 'agent' : 'heuristic', analyzedAt: new Date().toISOString() };
};

/** Validate the editor against server-owned keys. Zero ratios stay visible and count as zero. */
export const normalizeWeeklyPlan = (draft, template, count = 10) => {
  const normalize = (rows, allowed, key, slots) => {
    if (!Array.isArray(rows) || rows.length !== allowed.length) throw weeklyError('配比项目与报告不一致，请重新读取报告');
    const seen = new Set();
    const values = allowed.map(a => {
      const matches = rows.filter(r => r?.[key] === a[key]);
      if (matches.length !== 1 || seen.has(a[key])) throw weeklyError('配比项目重复或缺失');
      seen.add(a[key]);
      const value = Number(matches[0].ratio);
      if (!Number.isFinite(value) || value < 0 || value > 100) throw weeklyError('配比应为 0～100 的数字');
      return { ...a, ratio: value };
    });
    if (!values.length) return [];
    if (!values.some(v => v.ratio > 0)) {
      if (allowed.some(v => v.ratio > 0) || slots > 0) throw weeklyError('有计划条数的配比合计必须大于 0，请为未采样小类指定配比');
      return values.map(v => ({ ...v, ratio: 0, count: 0 }));
    }
    return allocate(ratios(values), slots);
  };
  const topics = normalize(draft?.topics, template.topics, 'name', count).map(c => ({ ...c,
    subcategories: normalize(draft.topics.find(t => t.name === c.name)?.subcategories, c.subcategories, 'name', c.count) }));
  if (!Array.isArray(draft?.structures) || draft.structures.length !== template.structures.length) throw weeklyError('文案结构配比项目不完整');
  const structures = template.structures.map(c => {
    const matches = draft.structures.filter(s => s.categoryName === c.categoryName);
    if (matches.length !== 1) throw weeklyError('文案结构大类重复或缺失');
    return { categoryName: c.categoryName, ...Object.fromEntries(WEEKLY_STRUCTURE_FIELDS.map(s => [s.key, normalize(matches[0][s.key], c[s.key], 'type', matches[0][s.key]?.some(v => Number(v.ratio) > 0) ? 10 : 0)])) };
  });
  if (!topics.length) throw weeklyError('客户没有可用选题库，请先完成 2.4 建库再确认配比');
  return { topics, structures };
};
