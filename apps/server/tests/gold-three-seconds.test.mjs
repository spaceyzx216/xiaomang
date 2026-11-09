import test from "node:test";
import assert from "node:assert/strict";

import {
  GOLD_THREE_SECOND_DIMENSIONS,
  GOLD_THREE_SECOND_TYPES,
  buildGoldThreeSecondsInput,
  buildHeuristicGoldThreeSeconds,
  normalizeGoldThreeSeconds,
  selectGoldThreeSecondVideos,
} from "../api/_lib/goldThreeSeconds.js";

const classificationReport = {
  reportType: "benchmark_classification",
  contentStyle: "spoken",
  account: { name: "测试账号", url: "https://www.douyin.com/user/test", platform: "douyin", platformLabel: "抖音" },
  summary: "围绕企业用工风险提供实用建议",
  categories: [
    { name: "风险防御", coreFunction: "降低风险", keywords: ["赔偿"], topics: [{ id: "a" }, { id: "b" }] },
    { name: "方法建议", coreFunction: "提供方法", keywords: ["步骤"], topics: [{ id: "c" }] },
  ],
  videos: [
    { id: "a", title: "第一个", link: "https://example.com/a", sourceText: "员工拒签真的没有风险吗？", publishDate: "2026/09/10", stats: { likes: 300, comments: 2, shares: 3, bookmarks: 4 } },
    { id: "b", title: "第二个", link: "https://example.com/b", sourceText: "老板注意，这种情况可能要赔偿。", publishDate: "2026/09/11", stats: { likes: 900, comments: 2, shares: 3, bookmarks: 4 } },
    { id: "c", title: "第三个", link: "https://example.com/c", sourceText: "3步教你完成合规检查。", publishDate: "2026/09/12", stats: { likes: 600, comments: 2, shares: 3, bookmarks: 4 } },
  ],
};

test("selects the top twenty samples by likes with publish date as tie breaker", () => {
  const selected = selectGoldThreeSecondVideos(classificationReport.videos);
  assert.deepEqual(selected.map(video => video.id), ["b", "c", "a"]);
  const input = buildGoldThreeSecondsInput(classificationReport);
  assert.deepEqual(input.videos.map(video => video.videoId), ["b", "c", "a"]);
  assert.equal(input.videos[0].categoryName, "风险防御");
});

test("normalizes gold three second output to valid input ids and recomputes distributions", () => {
  const report = normalizeGoldThreeSeconds({
    classificationReport,
    agentOutput: {
      accountSummary: "以风险提醒和方法型开场快速建立注意力",
      items: [
        { videoId: "b", openingText: "老板注意", type: "恐惧", confidence: "high", evidence: "直接提示损失后果" },
        { videoId: "c", openingText: "3步教你", type: "求知欲", confidence: "medium", evidence: "承诺具体方法" },
        { videoId: "unknown", openingText: "不应被接受", type: "欲望" },
      ],
      topTypes: [{ type: "恐惧", reason: "风险类内容的开场更常见" }],
      categoryReasons: [{
        categoryName: "风险防御",
        reasons: [
          { type: "恐惧", reason: "损失后果明确" },
          // 该大类样本里没出现过「反差」，这条要被丢掉，不能凭空出现在配比里
          { type: "反差", reason: "打破常识" },
        ],
      }],
    },
  });

  assert.equal(report.reportType, "gold_three_seconds");
  assert.equal(report.analyzedCount, 3);
  assert.equal(report.items.find(item => item.videoId === "a").type, "review");
  assert.equal(report.topTypes[0].type, "fear");
  assert.equal(report.topTypes[0].percentage, 33.3);

  const riskCategory = report.categoryBreakdown.find(item => item.categoryName === "风险防御");
  assert.equal(riskCategory.count, 2);           // b（有判断）+ a（待人工复核）
  assert.equal(riskCategory.reviewCount, 1);
  // 配比按该大类下真实出现过的类型统计 —— 只有「恐惧」一条有有效判断
  assert.deepEqual(riskCategory.dimensions.map(item => [item.type, item.ratio, item.count]), [["fear", 100, 1]]);
  assert.equal(riskCategory.dimensions[0].reason, "损失后果明确");
  // 分类报告里的核心功能 / 关键词要带过来，方便对照「这个大类是干什么的」
  assert.equal(riskCategory.coreFunction, "降低风险");
  assert.deepEqual(riskCategory.keywords, ["赔偿"]);
});

test("heuristic fallback keeps a reviewable low-confidence result", () => {
  const output = buildHeuristicGoldThreeSeconds(classificationReport);
  assert.equal(output.items.length, 3);
  assert.equal(output.items[0].confidence, "low");
  assert.equal(output.items.some(item => item.type === "fear"), true);
});

// 2026-09-17：维度「反差」曾被临时换成「需求」，用户随后确认**要反差、不要需求**，已换回。
// 这几条锁住最终结论。
test("黄金三秒是这 8 个维度，包含「反差」而不是「需求」", () => {
  assert.deepEqual(
    GOLD_THREE_SECOND_DIMENSIONS.map(item => item.type),
    ["curiosity", "fear", "anger", "contrast", "pain", "interest", "knowledge", "desire"],
  );
  assert.equal(GOLD_THREE_SECOND_TYPES.length, 8);
  assert.equal(GOLD_THREE_SECOND_TYPES.includes("needs"), false);
  // 每个维度都要有判定口径、例句和典型强度 —— 这些会同时喂给模型和前端展示
  for (const dimension of GOLD_THREE_SECOND_DIMENSIONS) {
    assert.ok(dimension.definition, `${dimension.type} 缺少 definition`);
    assert.ok(dimension.example, `${dimension.type} 缺少 example`);
    assert.ok(dimension.strength, `${dimension.type} 缺少 strength`);
  }
});

test("短暂存在过的「需求」key 仍能映射，不会静默掉进待人工复核", () => {
  const report = normalizeGoldThreeSeconds({
    classificationReport,
    agentOutput: { items: [{ videoId: "b", openingText: "30 岁必学的收纳技巧", type: "需求" }] },
  });
  assert.equal(report.items.find(item => item.videoId === "b").type, "contrast");
});

test("类型分布把 8 个维度全部列出（没命中的计 0）", () => {
  const report = normalizeGoldThreeSeconds({
    classificationReport,
    agentOutput: { items: [{ videoId: "b", openingText: "老板注意", type: "恐惧" }] },
  });
  const byType = new Map(report.typeDistribution.map(item => [item.type, item.count]));

  // 8 个维度一个都不能少，否则界面上只会看到「碰巧命中过的那几个」
  for (const type of GOLD_THREE_SECOND_TYPES) {
    assert.equal(byType.has(type), true, `分布里缺少维度 ${type}`);
  }
  assert.equal(byType.get("fear"), 1);
  assert.equal(byType.get("contrast"), 0);
  // 「最常用的 3 种」不能把计 0 的维度算进去
  assert.equal(report.topTypes.every(item => item.count > 0), true);
  // 维度口径随报告返回，前端直接渲染，不另外维护一份
  assert.equal(report.dimensions.length, 8);
  assert.equal(report.dimensions[0].label !== undefined, true);
});

// ---------------------------------------------------------------------------
// 按大类的三秒配比（2026-09-17 用户反馈「逻辑不太对」后的修正）
//
// 旧逻辑让模型自己编每个大类的配比，模型不给时还会把全局 top3 原样塞进每一个大类 ——
// 结果所有大类的类型和原因一模一样。现在配比一律由后端按每条样本的 type 统计。
// ---------------------------------------------------------------------------

const twoCategoryFixture = () => ({
  reportType: "benchmark_classification",
  contentStyle: "spoken",
  account: { name: "测试账号", url: "", platform: "douyin", platformLabel: "抖音" },
  summary: "",
  categories: [
    { name: "风险防御", coreFunction: "降低风险", keywords: ["赔偿"], topics: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] },
    { name: "方法建议", coreFunction: "提供方法", keywords: ["步骤"], topics: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
  ],
  videos: [
    { id: "r1", title: "r1", link: "https://e/r1", sourceText: "", publishDate: "", stats: { likes: 900 } },
    { id: "r2", title: "r2", link: "https://e/r2", sourceText: "", publishDate: "", stats: { likes: 800 } },
    { id: "r3", title: "r3", link: "https://e/r3", sourceText: "", publishDate: "", stats: { likes: 700 } },
    { id: "m1", title: "m1", link: "https://e/m1", sourceText: "", publishDate: "", stats: { likes: 600 } },
    { id: "m2", title: "m2", link: "https://e/m2", sourceText: "", publishDate: "", stats: { likes: 500 } },
    { id: "m3", title: "m3", link: "https://e/m3", sourceText: "", publishDate: "", stats: { likes: 400 } },
  ],
});

test("每个大类各算各的配比，不会所有大类共用同一套全局 top3", () => {
  const report = normalizeGoldThreeSeconds({
    classificationReport: twoCategoryFixture(),
    agentOutput: {
      items: [
        { videoId: "r1", type: "恐惧" }, { videoId: "r2", type: "恐惧" }, { videoId: "r3", type: "恐惧" },
        { videoId: "m1", type: "求知欲" }, { videoId: "m2", type: "求知欲" }, { videoId: "m3", type: "求知欲" },
      ],
    },
  });

  const risk = report.categoryBreakdown.find(item => item.categoryName === "风险防御");
  const method = report.categoryBreakdown.find(item => item.categoryName === "方法建议");

  assert.deepEqual(risk.dimensions.map(item => [item.type, item.ratio, item.count]), [["fear", 100, 3]]);
  assert.deepEqual(method.dimensions.map(item => [item.type, item.ratio, item.count]), [["knowledge", 100, 3]]);
  // 关键：两个大类的维度不同 —— 旧逻辑在这里会给出完全一样的结果
  assert.notDeepEqual(risk.dimensions.map(item => item.type), method.dimensions.map(item => item.type));
});

test("大类配比由后端按条数统计，模型自己填的百分比一概不采信", () => {
  const report = normalizeGoldThreeSeconds({
    classificationReport: twoCategoryFixture(),
    agentOutput: {
      items: [
        { videoId: "r1", type: "恐惧" }, { videoId: "r2", type: "恐惧" }, { videoId: "r3", type: "求知欲" },
      ],
      // 模型试图自己编配比 —— 新逻辑里这个字段根本不该被读
      categoryRecommendations: [{ categoryName: "风险防御", recommendations: [{ type: "欲望", ratio: 100, reason: "编的" }] }],
    },
  });

  const risk = report.categoryBreakdown.find(item => item.categoryName === "风险防御");
  // 2 条恐惧 + 1 条求知欲 → 按最大余额法 67 / 33
  assert.deepEqual(risk.dimensions.map(item => [item.type, item.ratio, item.count]), [["fear", 67, 2], ["knowledge", 33, 1]]);
  assert.equal(risk.dimensions.reduce((sum, item) => sum + item.ratio, 0), 100);
  assert.equal(risk.dimensions.some(item => item.type === "desire"), false);
});

test("模型没给原因时如实留空，不编一句套话糊过去", () => {
  const report = normalizeGoldThreeSeconds({
    classificationReport: twoCategoryFixture(),
    agentOutput: { items: [{ videoId: "r1", type: "恐惧" }] },
  });
  const risk = report.categoryBreakdown.find(item => item.categoryName === "风险防御");
  assert.equal(risk.dimensions[0].reason, "");
});

test("配比结构带上分类报告的核心功能/关键词，以及大类占比", () => {
  const report = normalizeGoldThreeSeconds({
    classificationReport: twoCategoryFixture(),
    agentOutput: { items: [{ videoId: "r1", type: "恐惧" }, { videoId: "m1", type: "求知欲" }] },
  });

  const risk = report.categoryBreakdown.find(item => item.categoryName === "风险防御");
  assert.equal(risk.coreFunction, "降低风险");
  assert.deepEqual(risk.keywords, ["赔偿"]);
  // 该大类下 3 条样本：1 条有类型判断，另外 2 条模型没返回 → 待人工复核
  assert.equal(risk.count, 3);
  assert.equal(risk.reviewCount, 2);
  assert.equal(risk.percentage, 50); // 6 条样本里该大类占 3 条
  // 分类报告里的大类都要出现，即使本次高互动样本没抽到它
  assert.equal(report.categoryBreakdown.length, 2);
});
