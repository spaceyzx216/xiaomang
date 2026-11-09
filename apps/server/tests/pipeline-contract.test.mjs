// 账号定位流水线：阶段间契约与边界条件单点测试
//
// 这个文件专门锁定「前端 → 分类报告 → 黄金三秒报告」两段接口之间容易断裂的契约，
// 以及 Agent 返回异常数据时的降级行为。它不重复 tests/benchmark-analysis.test.mjs
// 和 tests/gold-three-seconds.test.mjs 里已有的正常路径断言。
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHeuristicBenchmarkAnalysis,
  normalizeBenchmarkAnalysis,
  normalizeBenchmarkVideos,
} from "../api/_lib/benchmarkAnalysis.js";
import {
  buildGoldThreeSecondsInput,
  buildHeuristicGoldThreeSeconds,
  normalizeGoldThreeSeconds,
  selectGoldThreeSecondVideos,
} from "../api/_lib/goldThreeSeconds.js";

// 前端在 src/app/benchmarkAnalysis.ts:normalizeBenchmarkVideosFromBatch 里产出的形状。
// 后端 normalizeBenchmarkVideos 必须原样保留这些 id，否则分类报告里的 topics[].id
// 会和 videos[].id 对不上，黄金三秒阶段的 categoryForVideo 就会全部落到「待人工复核」。
const asFrontendSends = (overrides = {}) => ({
  id: "v1",
  title: "标题一",
  link: "https://www.douyin.com/video/1",
  authorName: "作者",
  publishDate: "2026/09/10",
  sourceText: "开场文案",
  platform: "douyin",
  stats: { likes: 300, comments: 2, shares: 3, bookmarks: 4 },
  ...overrides,
});

const threeVideos = [
  asFrontendSends(),
  asFrontendSends({ id: "v2", title: "标题二", link: "https://www.douyin.com/video/2", stats: { likes: 900, comments: 2, shares: 3, bookmarks: 4 } }),
  asFrontendSends({ id: "v3", title: "标题三", link: "https://www.douyin.com/video/3", stats: { likes: 600, comments: 2, shares: 3, bookmarks: 4 } }),
];

const classification = (agentOutput) => normalizeBenchmarkAnalysis({
  contentStyle: "spoken",
  platform: "douyin",
  accountUrl: "https://www.douyin.com/user/test",
  accountName: "测试账号",
  videos: threeVideos,
  agentOutput,
  analysisSource: "agent",
});

test("classification report keeps the exact video ids the frontend sent", () => {
  const report = classification({ categories: [{ name: "A", videoIds: ["v1", "v2", "v3"] }] });
  assert.deepEqual(report.videos.map(video => video.id), ["v1", "v2", "v3"]);
  assert.deepEqual(report.categories[0].topics.map(topic => topic.id).sort(), ["v1", "v2", "v3"]);
});

test("a video referenced by two categories is counted exactly once", () => {
  const report = classification({
    categories: [
      { name: "第一个大类", videoIds: ["v1"] },
      { name: "第二个大类", videoIds: ["v1"] },
    ],
  });
  const counts = report.categories.map(category => category.count);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), report.analyzedCount);
  assert.equal(report.categories.find(category => category.name === "第一个大类").count, 1);
  assert.equal(report.categories.find(category => category.name === "第二个大类"), undefined);
});

test("backend recomputes count and percentage instead of trusting the agent", () => {
  const report = classification({
    categories: [{ name: "A", videoIds: ["v1"], count: 9999, percentage: 9999 }],
  });
  assert.equal(report.categories[0].count, 1);
  assert.equal(report.categories[0].percentage, 33.3);
  assert.equal(report.categories[0].percentage <= 100, true);
});

test("category percentages never exceed 100 in total", () => {
  const report = classification({
    categories: [
      { name: "A", videoIds: ["v1"] },
      { name: "B", videoIds: ["v2", "v3"] },
    ],
  });
  const total = report.categories.reduce((sum, category) => sum + category.percentage, 0);
  assert.equal(total <= 100.1, true);
  assert.equal(report.analyzedCount, 3);
});

test("every video lands somewhere so the report never silently loses samples", () => {
  const report = classification({
    categories: [
      { name: "A", videoIds: ["v1"] },
      { name: "B", videoIds: ["not-a-real-id"] },
    ],
  });
  const referenced = report.categories.flatMap(category => category.topics.map(topic => topic.id));
  assert.equal(new Set(referenced).size, report.analyzedCount);
});

test("invalid agent output degrades to a review-only report rather than an empty one", () => {
  for (const agentOutput of [null, undefined, {}, { categories: "not-an-array" }, { categories: [null] }]) {
    const report = classification(agentOutput);
    assert.equal(report.analyzedCount, 3);
    assert.equal(report.categories.length, 1);
    assert.equal(report.categories[0].name, "待人工复核");
    assert.equal(report.categories[0].count, 3);
  }
});

test("an empty agent object is still reported as an agent result, not a heuristic one", () => {
  // 这是当前实现的真实行为：{} 能通过 JSON 解析，所以不会触发 heuristic 降级，
  // 前端会显示为绿色的「Agent 分析」，但内容其实是全量待人工复核。
  // 记录此行为，避免以后误以为这种情况下已经降级。
  const report = classification({});
  assert.equal(report.analysisSource, "agent");
  assert.equal(report.categories[0].name, "待人工复核");
  assert.equal(report.warnings.length, 0);
  assert.equal(report.summary.length > 0, true);
});

test("heuristic benchmark fallback produces the same shape as the agent path", () => {
  const heuristic = buildHeuristicBenchmarkAnalysis({ contentStyle: "spoken", videos: threeVideos });
  const report = normalizeBenchmarkAnalysis({
    contentStyle: "spoken",
    platform: "douyin",
    accountName: "测试账号",
    videos: threeVideos,
    agentOutput: heuristic,
    analysisSource: "heuristic",
    warnings: [{ code: "BENCHMARK_AGENT_FAILED", fallbackUsed: true }],
  });
  assert.equal(report.analysisSource, "heuristic");
  assert.equal(report.warnings.length, 1);
  const referenced = report.categories.flatMap(category => category.topics.map(topic => topic.id));
  assert.deepEqual([...new Set(referenced)].sort(), ["v1", "v2", "v3"]);
});

test("gold stage attributes each sample to the category from the classification report", () => {
  const report = classification({
    categories: [
      { name: "风险防御", videoIds: ["v2"] },
      { name: "方法建议", videoIds: ["v3"] },
    ],
  });
  const input = buildGoldThreeSecondsInput(report);
  // 点赞数 900 > 600 > 300，所以顺序是 v2, v3, v1
  assert.deepEqual(input.videos.map(video => video.videoId), ["v2", "v3", "v1"]);
  assert.equal(input.videos[0].categoryName, "风险防御");
  assert.equal(input.videos[1].categoryName, "方法建议");
});

test("gold stage marks samples without a category instead of guessing one", () => {
  // 分类报告里大类不包含该视频时，categoryForVideo 返回「待人工复核」。
  const report = classification({ categories: [{ name: "A", videoIds: ["v1"] }] });
  const input = buildGoldThreeSecondsInput(report);
  const uncategorized = input.videos.filter(video => video.categoryName === "待人工复核");
  assert.equal(uncategorized.length, 2);
});

test("gold selection covers the whole sixty-video window", () => {
  // 2026-09-17：上限从 20 改成 60。本步骤的产出是「按大类的三秒配比」，
  // 只取 20 条时每个大类剩不下几条，配比没有统计意义。
  const many = Array.from({ length: 60 }, (_, index) => asFrontendSends({
    id: `m${index + 1}`,
    link: `https://www.douyin.com/video/${index + 1}`,
    stats: { likes: index, comments: 0, shares: 0, bookmarks: 0 },
  }));
  const selected = selectGoldThreeSecondVideos(many);
  assert.equal(selected.length, 60);
  // 仍然按点赞降序，展示顺序不变。
  assert.equal(selected[0].id, "m60");
});

test("gold selection still caps anything beyond the sixty-video window", () => {
  const many = Array.from({ length: 80 }, (_, index) => asFrontendSends({
    id: `m${index + 1}`,
    link: `https://www.douyin.com/video/${index + 1}`,
    stats: { likes: index, comments: 0, shares: 0, bookmarks: 0 },
  }));
  const selected = selectGoldThreeSecondVideos(many);
  assert.equal(selected.length, 60);
  assert.equal(selected[0].id, "m80");
  assert.equal(selected[59].id, "m21");
});

test("gold selection keeps a usable floor when the limit is out of range", () => {
  assert.equal(selectGoldThreeSecondVideos(threeVideos, 0).length, 3);
  assert.equal(selectGoldThreeSecondVideos(threeVideos, -1).length, 1);
  assert.equal(selectGoldThreeSecondVideos(threeVideos, Number.NaN).length, 3);
  assert.equal(selectGoldThreeSecondVideos(threeVideos, 1000).length, 3);
});

test("gold normalization accepts both English keys and Chinese labels", () => {
  const report = classification({ categories: [{ name: "A", videoIds: ["v1"] }] });
  const english = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: { items: [{ videoId: "v2", type: "fear", confidence: "high" }] },
  });
  const chinese = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: { items: [{ videoId: "v2", type: "恐惧", confidence: "high" }] },
  });
  assert.equal(english.items.find(item => item.videoId === "v2").type, "fear");
  assert.equal(chinese.items.find(item => item.videoId === "v2").type, "fear");
  assert.equal(chinese.items.find(item => item.videoId === "v2").typeLabel, "恐惧");
});

test("gold normalization sends unknown types and unknown ids to human review", () => {
  const report = classification({ categories: [{ name: "A", videoIds: ["v1"] }] });
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: {
      items: [
        { videoId: "v2", type: "完全无法识别的类型" },
        { videoId: "不存在", type: "fear" },
      ],
    },
  });
  assert.equal(normalized.items.find(item => item.videoId === "v2").type, "review");
  assert.equal(normalized.items.some(item => item.videoId === "不存在"), false);
  assert.equal(normalized.analyzedCount, 3);
});

test("gold normalization recomputes distribution and never trusts agent percentages", () => {
  const report = classification({ categories: [{ name: "A", videoIds: ["v1"] }] });
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: {
      items: [
        { videoId: "v1", type: "fear", percentage: 99 },
        { videoId: "v2", type: "fear", percentage: 99 },
        { videoId: "v3", type: "pain", percentage: 99 },
      ],
    },
  });
  assert.equal(normalized.typeDistribution.find(entry => entry.type === "fear").count, 2);
  assert.equal(normalized.typeDistribution.find(entry => entry.type === "fear").percentage, 66.7);
  const totalPercentage = normalized.typeDistribution.reduce((sum, entry) => sum + entry.percentage, 0);
  assert.equal(totalPercentage <= 100.1, true);
});

test("gold category recommendation ratios are clamped into a sane 0-100 range", () => {
  const report = classification({ categories: [{ name: "风险防御", videoIds: ["v1"] }] });
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: {
      items: [{ videoId: "v1", type: "fear" }],
      categoryRecommendations: [{
        categoryName: "风险防御",
        recommendations: [
          { type: "fear", ratio: 9999, reason: "越界" },
          { type: "pain", ratio: -50, reason: "负值" },
        ],
      }],
    },
  });
  const dimensions = normalized.categoryBreakdown[0].dimensions;
  for (const item of dimensions) {
    assert.equal(item.ratio >= 0 && item.ratio <= 100, true);
  }
  assert.equal(dimensions.reduce((total, item) => total + item.ratio, 0), 100);
  // 模型编的「pain」在该大类样本里根本没出现，不能进配比
  assert.equal(dimensions.some(item => item.type === "pain"), false);
});

test("gold category breakdown follows the categories of the source report", () => {
  const report = classification({
    categories: [
      { name: "风险防御", videoIds: ["v1"] },
      { name: "方法建议", videoIds: ["v2"] },
    ],
  });
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: {
      items: [{ videoId: "v1", type: "fear" }],
      categoryReasons: [{ categoryName: "Agent 自己编的大类", reasons: [{ type: "fear", reason: "编的" }] }],
    },
  });
  assert.deepEqual(
    normalized.categoryBreakdown.map(item => item.categoryName),
    ["风险防御", "方法建议"],
  );
  assert.equal(normalized.categoryBreakdown.some(item => item.categoryName === "Agent 自己编的大类"), false);
});

test("gold stage does not turn the review bucket into a content strategy category", () => {
  // 分类阶段在有大类覆盖不到的视频时会自动追加一个「待人工复核」大类
  // （benchmarkAnalysis.js:buildReviewCategory）。它不是真实内容主题，只是人工待办队列，
  // 因此不应出现在三秒阶段的「各大类的三秒维度配比」里。
  const report = classification({ categories: [{ name: "风险防御", videoIds: ["v1"] }] });
  assert.equal(report.categories.some(category => category.name === "待人工复核"), true);

  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: { items: report.videos.map(video => ({ videoId: video.id, type: "fear" })) },
  });

  assert.equal(normalized.categoryBreakdown.some(item => item.categoryName === "待人工复核"), false);
});

test("gold normalization maps Chinese confidence labels from the model", () => {
  // 提示词是中文的，模型很自然地会回「高 / 中 / 低」，但后端只认 high/medium/low，
  // 未识别时一律落到默认值，导致「低」被静默升级成「中」。
  const report = classification({ categories: [{ name: "A", videoIds: ["v1"] }] });
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: {
      items: [
        { videoId: "v1", type: "fear", confidence: "低", openingText: "开场" },
        { videoId: "v2", type: "fear", confidence: "高", openingText: "开场" },
      ],
    },
  });
  assert.equal(normalized.items.find(item => item.videoId === "v1").confidence, "low");
  assert.equal(normalized.items.find(item => item.videoId === "v2").confidence, "high");
});

test("gold normalization defaults a missing confidence to low, not medium", () => {
  // 提示词要求：证据不足时 confidence 必须是 low。模型漏填 confidence 属于证据不足，
  // 不应该给出比 heuristic 降级路径更高的默认置信度。
  const report = classification({ categories: [{ name: "A", videoIds: ["v1"] }] });
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: { items: [{ videoId: "v1", type: "fear", evidence: "模型没说置信度" }] },
  });
  assert.equal(normalized.items[0].confidence, "low");
});

test("gold normalization lowers confidence when the opening text had to be substituted", () => {
  // 后端在 openingText 缺失时会用 sourceText 的第一句兜底，但这只是发布文案，
  // 不是真实开场。沿用模型给的 high 置信度会让用户误以为开场已被确认。
  const report = classification({ categories: [{ name: "A", videoIds: ["v1"] }] });
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: { items: [{ videoId: "v1", type: "fear", confidence: "high" }] },
  });
  assert.equal(normalized.items[0].confidence, "low");
});

test("gold heuristic fallback stays low confidence and marks every sample", () => {
  const report = classification({ categories: [{ name: "A", videoIds: ["v1", "v2", "v3"] }] });
  const heuristic = buildHeuristicGoldThreeSeconds(report);
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: heuristic,
    analysisSource: "heuristic",
    warnings: [{ code: "GOLD_THREE_SECONDS_AGENT_FAILED", fallbackUsed: true }],
  });
  assert.equal(normalized.analysisSource, "heuristic");
  assert.equal(normalized.warnings.length, 1);
  assert.equal(normalized.items.length, 3);
  for (const item of normalized.items) {
    assert.equal(item.confidence, "low");
  }
  assert.equal(normalized.items.every(item => item.type !== "review"), true);
});

test("a classification report without videos cannot produce a gold report", () => {
  const input = buildGoldThreeSecondsInput({ reportType: "benchmark_classification", videos: [] });
  assert.equal(input.videos.length, 0);
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: { reportType: "benchmark_classification", videos: [] },
    agentOutput: { items: [{ videoId: "ghost", type: "fear" }] },
  });
  assert.equal(normalized.analyzedCount, 0);
  assert.equal(normalized.items.length, 0);
});

test("gold report carries the account and content style through for the next stage", () => {
  const report = classification({ categories: [{ name: "A", videoIds: ["v1"] }] });
  const normalized = normalizeGoldThreeSeconds({ classificationReport: report, agentOutput: {} });
  assert.equal(normalized.account.name, "测试账号");
  assert.equal(normalized.account.url, "https://www.douyin.com/user/test");
  assert.equal(normalized.contentStyle, "spoken");
  assert.equal(normalized.reportType, "gold_three_seconds");
  assert.equal(normalized.classificationReportType, "benchmark_classification");
});

test("normalizeBenchmarkVideos survives a non-array payload", () => {
  assert.deepEqual(normalizeBenchmarkVideos(null), []);
  assert.deepEqual(normalizeBenchmarkVideos("not-an-array"), []);
  assert.deepEqual(normalizeBenchmarkVideos({ videos: [] }), []);
});

test("a video repeated across subcategories of one category is counted once", () => {
  // 当前实现按小类累加 topics，没有按 video id 去重，导致同一个视频重复计数、
  // 大类占比超过 100%（实测 count=3 / percentage=150%），与提示词里
  // 「每一条视频必须且只能归入一个小类」的约定相矛盾。
  const report = classification({
    categories: [{
      name: "大类",
      subcategories: [
        { name: "小类一", videoIds: ["v1"] },
        { name: "小类二", videoIds: ["v1", "v2"] },
      ],
    }],
  });
  const category = report.categories.find(item => item.name === "大类");
  const topicIds = category.topics.map(topic => topic.id);
  assert.equal(new Set(topicIds).size, topicIds.length);
  assert.equal(category.count, 2);
  assert.equal(category.percentage <= 100, true);
});

test("model-supplied keywords are length bounded before being stored", () => {
  // keywords 只做了 slice(0, 12) 的条数限制，单条长度没有走 cleanText，
  // 模型返回的超长关键词会原样进入报告并持久化到 MongoDB。
  const report = classification({
    categories: [{ name: "大类", videoIds: ["v1"], keywords: ["超长关键词".repeat(1000)] }],
  });
  assert.equal(report.categories[0].keywords[0].length <= 40, true);
});

test("a duplicated subcategory reference cannot inflate a category or the response", () => {
  // 同一个 video id 在小类里被重复引用时，当前实现按引用次数累加，
  // 一条视频的输入配上 5000 条重复引用会返回 count=5000 / percentage=500000% 和 2.17 MiB 的响应。
  const report = normalizeBenchmarkAnalysis({
    contentStyle: "spoken",
    platform: "douyin",
    accountName: "测试账号",
    videos: [asFrontendSends({ id: "v1" })],
    agentOutput: {
      categories: [{
        name: "大类",
        subcategories: Array.from({ length: 5000 }, (_, index) => ({ name: `小类${index}`, videoIds: ["v1"] })),
      }],
    },
  });
  const category = report.categories.find(item => item.name === "大类");
  assert.equal(category.count, 1);
  assert.equal(category.percentage <= 100, true);
});

test("a populated reference list is used when another candidate array is empty", () => {
  // collectReferences 取的是第一个「是数组」的键，而不是第一个「非空」的键。
  // 模型返回 videoIds: [] 同时把内容放在 topics 里时，整个大类会被丢弃，
  // 该类的视频全部掉进「待人工复核」。
  const report = normalizeBenchmarkAnalysis({
    contentStyle: "spoken",
    platform: "douyin",
    accountName: "测试账号",
    videos: threeVideos,
    agentOutput: {
      categories: [{ name: "风险防御", videoIds: [], topics: [{ videoId: "v1" }] }],
    },
  });
  const category = report.categories.find(item => item.name === "风险防御");
  assert.equal(Boolean(category), true);
  assert.equal(category.count, 1);
});

test("placeholder entries never become analysed videos", () => {
  // 空对象的 title 会被兜底成「未命名视频 N」，使 .filter(title || link) 永远为真，
  // 于是一批垃圾输入会被当成 60 条作品送去调用 DeepSeek 并计入 analyzedCount。
  assert.deepEqual(normalizeBenchmarkVideos([null, 42, "junk", {}, { title: "   ", link: "" }]), []);
});

test("a junk entry does not push a real video out of the sixty item window", () => {
  const realVideos = Array.from({ length: 60 }, (_, index) => asFrontendSends({
    id: `r${index}`,
    title: `标题${index}`,
    link: `https://www.douyin.com/video/${index}`,
  }));
  const normalized = normalizeBenchmarkVideos([{ id: "junk", title: "   ", link: "" }, ...realVideos]);
  assert.equal(normalized.length, 60);
});
