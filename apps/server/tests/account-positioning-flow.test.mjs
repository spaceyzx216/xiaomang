// 账号定位流水线：端到端单点测试
//
// 这条流水线是一整条链路，不是互相独立的板块。上一阶段的输出就是下一阶段的输入，
// 任何一层把脏数据「洗白」成看起来合法的样本，后面所有阶段都会当成真实作品继续用：
//
//   TikHub 抓取
//     → src/app/benchmarkAnalysis.ts : normalizeBenchmarkVideosFromBatch（前端 60 条窗口 + 归一化）
//     → POST /api/agent/benchmark-analysis
//     → api/_lib/benchmarkAnalysis.js : normalizeBenchmarkAnalysis（后端归一化 / 重算占比）
//     → POST /api/benchmark-reports（落库 benchmark_reports）
//     → GET  /api/benchmark-reports（项目经理挑选一份已保存的分类报告）
//     → POST /api/agent/gold-three-seconds
//     → api/_lib/goldThreeSeconds.js : buildGoldThreeSecondsInput → normalizeGoldThreeSeconds
//     → POST /api/gold-three-second-reports（落库 gold_three_second_reports）
//
// 因此下面每条断言都刻意跨越至少一个阶段边界，而不是只测单个函数自己。
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeBenchmarkVideosFromBatch } from "../../web/src/app/benchmarkAnalysis.ts";
import { normalizeBenchmarkAnalysis } from "../api/_lib/benchmarkAnalysis.js";
import {
  buildGoldThreeSecondsInput,
  normalizeGoldThreeSeconds,
} from "../api/_lib/goldThreeSeconds.js";

// 后端 normalizeBenchmarkVideos 认得的形状（前端 normalizeBenchmarkVideosFromBatch 的产出）。
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

// 抖音批量接口真实返回的作品形状。
const aweme = (index, overrides = {}) => ({
  aweme_id: `a${index}`,
  desc: `标题${index}`,
  create_time: 1_760_000_000 - index,
  statistics: { digg_count: 1000 - index, comment_count: 10, share_count: 5, collect_count: 3 },
  author: { nickname: "作者" },
  ...overrides,
});

// 上游偶尔会夹带空壳：没有 id、没有文案、没有统计。
const junkShell = { aweme_id: "", desc: "", statistics: {} };

const classification = (agentOutput, overrides = {}) => normalizeBenchmarkAnalysis({
  contentStyle: "spoken",
  platform: "douyin",
  accountUrl: "https://www.douyin.com/user/test",
  accountName: "测试账号",
  videos: [
    asFrontendSends(),
    asFrontendSends({ id: "v2", title: "标题二", link: "https://www.douyin.com/video/2", stats: { likes: 900, comments: 2, shares: 3, bookmarks: 4 } }),
    asFrontendSends({ id: "v3", title: "标题三", link: "https://www.douyin.com/video/3", stats: { likes: 600, comments: 2, shares: 3, bookmarks: 4 } }),
  ],
  agentOutput,
  analysisSource: "agent",
  ...overrides,
});

// ---------------------------------------------------------------------------
// 阶段 0：抓取结果进入 60 条窗口（前端）
// ---------------------------------------------------------------------------

test("a junk item from upstream must not consume one of the sixty slots", () => {
  // 前端先 slice(0, 60) 再 map，没有先剔除空壳。空壳占掉一个名额，
  // 第 60 条真实作品被挤出窗口，于是「最新 60 条」实际只拿到了 59 条真实作品。
  const real = Array.from({ length: 60 }, (_, index) => aweme(index));
  const videos = normalizeBenchmarkVideosFromBatch(
    { videosResponse: { data: [junkShell, ...real] }, authorName: "作者" },
    "douyin",
  );

  assert.equal(videos.length, 60);
  // 60 条真实作品必须一条不少，且不能被占位标题顶替。
  assert.deepEqual(videos.map(video => video.id), real.map((_, index) => `a${index}`));
});

test("the frontend must not fabricate a playable video out of an empty upstream item", () => {
  // 空壳会被兜底成「未命名视频 1」，并且 link 用 id 拼出一个语法完全合法的抖音链接。
  // 这条假作品此后无法被下游任何一层识别：后端 .filter(title || link) 永远为真，
  // 它会进入 DeepSeek 分类、计入 analyzedCount，甚至可能参与点赞 Top20 取样。
  const videos = normalizeBenchmarkVideosFromBatch(
    { videosResponse: { data: [junkShell] }, authorName: "作者" },
    "douyin",
  );

  assert.deepEqual(videos, []);
});

// ---------------------------------------------------------------------------
// 阶段 1 → 阶段 2 接缝：分类报告交给黄金三秒
// ---------------------------------------------------------------------------

test("the review bucket is a human queue, not a content category for the gold agent", () => {
  // buildReviewCategory 会把大类覆盖不到的样本收进「待人工复核」大类。它是人工待办队列，
  // 不是真实内容主题。如果它进入黄金三秒的 categories，模型会被要求为它编一套三秒配比，
  // 归一化也会把它当成内容大类原样输出（见 pipeline-contract 的同类断言）。
  const report = classification({ categories: [{ name: "风险防御", videoIds: ["v1"] }] });
  assert.equal(report.categories.some(category => category.name === "待人工复核"), true);

  const input = buildGoldThreeSecondsInput(report);
  assert.equal(input.categories.some(category => category.name === "待人工复核"), false);
  // 但落到复核队列的样本本身必须保留，并且仍然标明「待人工复核」。
  assert.equal(input.videos.every(video => video.videoId), true);
  assert.equal(input.videos.some(video => video.categoryName === "待人工复核"), true);
});

test("the gold sample rule must describe the fetch mode that was actually used", () => {
  // 走时间窗口抓取（fetchMode: "recent"）时，分类报告的 sampleWindow 是「时间窗口作品」，
  // 但黄金三秒报告的 sampleRule 是写死的「最新 60 条」，会把取样口径报错。
  const report = classification({ categories: [{ name: "大类", videoIds: ["v1", "v2", "v3"] }] }, { fetchMode: "recent" });
  assert.equal(report.fetchMode, "recent");

  const normalized = normalizeGoldThreeSeconds({ classificationReport: report, agentOutput: {} });
  assert.equal(normalized.sampleRule.includes("最新 60 条"), false);
});

// ---------------------------------------------------------------------------
// 阶段 2：黄金三秒归一化
// ---------------------------------------------------------------------------

test("category ratios always add up to exactly 100", () => {
  // 配比由后端按条数统计。三项等权时应当是 33/33/34 这类分布，任何一项都不能吞掉余数
  // （曾经末位用「100 减去其余项原始 ratio」，与已归一化的其余项混算，实测 33+33+98 = 164）。
  const report = classification({ categories: [{ name: "大类A", videoIds: ["v1", "v2", "v3"] }] });
  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: {
      items: [
        { videoId: "v1", type: "fear", openingText: "开场", confidence: "high" },
        { videoId: "v2", type: "pain", openingText: "开场", confidence: "high" },
        { videoId: "v3", type: "desire", openingText: "开场", confidence: "high" },
      ],
    },
  });

  const dimensions = normalized.categoryBreakdown[0].dimensions;
  assert.equal(dimensions.length, 3);
  assert.equal(dimensions.reduce((total, item) => total + item.ratio, 0), 100);
  for (const item of dimensions) {
    assert.equal(Math.abs(item.ratio - 100 / 3) <= 1, true, `${item.type} 配比 ${item.ratio}% 偏离等权过多`);
  }
});

// ---------------------------------------------------------------------------
// 守卫：链路本身必须成立的行为
// ---------------------------------------------------------------------------

test("the classification report survives persistence before becoming gold input", () => {
  // 分类报告经 JSON / MongoDB 往返后，黄金三秒阶段读到的样本与分类阶段完全一致。
  // 这条守住「前端落库 → 再读回来 → 送进三秒 Agent」这段真实链路不丢字段。
  const report = classification({ categories: [{ name: "大类", videoIds: ["v1", "v2", "v3"] }] });
  const roundTripped = JSON.parse(JSON.stringify(report));
  assert.deepEqual(buildGoldThreeSecondsInput(roundTripped), buildGoldThreeSecondsInput(report));
});

test("the gold report only ever contains videos from the sixty-video sample", () => {
  // 模型可能对超出样本范围的作品也给出判断（这里给了 70 条），
  // 但三秒步骤只允许接收样本窗口内的 60 条。
  const videos = Array.from({ length: 70 }, (_, index) => asFrontendSends({
    id: `v${index}`,
    title: `标题${index}`,
    link: `https://www.douyin.com/video/${index}`,
    stats: { likes: index * 10, comments: 0, shares: 0, bookmarks: 0 },
  }));
  const report = normalizeBenchmarkAnalysis({
    contentStyle: "spoken",
    platform: "douyin",
    accountUrl: "https://www.douyin.com/user/test",
    accountName: "测试账号",
    videos,
    agentOutput: { categories: [{ name: "大类", videoIds: videos.map(video => video.id) }] },
    analysisSource: "agent",
  });

  const normalized = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: { items: videos.map(video => ({ videoId: video.id, type: "fear", openingText: "开场", confidence: "high" })) },
  });

  const sampleIds = buildGoldThreeSecondsInput(report).videos.map(video => video.videoId);
  assert.equal(sampleIds.length, 60);
  assert.equal(normalized.items.length, 60);
  assert.deepEqual(new Set(normalized.items.map(item => item.videoId)), new Set(sampleIds));
});

test("an upstream junk item must not shrink the sixty videos that reach the gold stage", () => {
  // 全链路：上游夹带 1 条空壳时，60 条真实作品必须一条不少地流到黄金三秒阶段的样本池里。
  // 2026-09-17 起样本窗口内**全部**进入分析（不再只取前 20 条），所以这里应当拿到 60 条。
  const real = Array.from({ length: 60 }, (_, index) => aweme(index));
  const videos = normalizeBenchmarkVideosFromBatch(
    { videosResponse: { data: [junkShell, ...real] }, authorName: "作者" },
    "douyin",
  );
  const report = normalizeBenchmarkAnalysis({
    contentStyle: "spoken",
    platform: "douyin",
    accountUrl: "https://www.douyin.com/user/test",
    accountName: "测试账号",
    videos,
    agentOutput: { categories: [{ name: "大类", videoIds: videos.map(video => video.id) }] },
    analysisSource: "agent",
  });

  const realIds = new Set(real.map((_, index) => `a${index}`));
  assert.equal(report.videos.filter(video => realIds.has(video.id)).length, 60);
  assert.equal(buildGoldThreeSecondsInput(report).videos.length, 60);
  assert.equal(buildGoldThreeSecondsInput(report).videos.every(video => realIds.has(video.videoId)), true);
});
