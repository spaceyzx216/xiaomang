import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHeuristicBenchmarkAnalysis,
  normalizeBenchmarkAnalysis,
  normalizeBenchmarkVideos,
} from "../api/_lib/benchmarkAnalysis.js";

const videos = [
  { id: "a", title: "员工手册没写这句，老板要赔10万", sourceText: "入职 员工手册 制度", stats: { likes: 100 } },
  { id: "b", title: "员工拒调岗还要赔偿", sourceText: "调岗 仲裁 赔偿", stats: { likes: 200 } },
  { id: "c", title: "2026最新官方通报", sourceText: "新规 政策 通知", stats: { likes: 300 } },
];

test("normalizes benchmark videos without trusting malformed metrics", () => {
  const normalized = normalizeBenchmarkVideos([
    { videoId: "1", title: "测试", sourceText: "文案", stats: { likes: "1200" } },
    { id: "2", title: "负数", stats: { likes: -1 } },
  ], { platform: "tiktok" });

  assert.equal(normalized[0].id, "1");
  assert.equal(normalized[0].stats.likes, 1200);
  assert.equal(normalized[0].platform, "tiktok");
  assert.equal(normalized[1].stats.likes, 0);
});

test("recomputes category percentages and keeps unassigned videos reviewable", () => {
  const report = normalizeBenchmarkAnalysis({
    contentStyle: "spoken",
    platform: "douyin",
    accountName: "测试账号",
    videos,
    agentOutput: {
      accountSummary: "账号以劳动用工知识为主",
      categories: [
        {
          name: "风险防御与合规建设",
          coreFunction: "通过制度建设降低风险",
          keywords: ["制度"],
          subcategories: [{ name: "入职合规", videoIds: ["a"] }],
        },
      ],
    },
  });

  assert.equal(report.analyzedCount, 3);
  assert.equal(report.reportType, "benchmark_classification");
  assert.equal(report.fetchMode, "latest");
  assert.equal(report.sampleWindow, "最新作品（最多 60 条）");
  assert.equal(report.categories[0].count, 1);
  assert.equal(report.categories[0].percentage, 33.3);
  assert.equal(report.categories.at(-1).name, "待人工复核");
  assert.equal(report.categories.at(-1).count, 2);
  assert.deepEqual(report.categories.at(-1).topics.map(item => item.id), ["b", "c"]);
});

test("heuristic fallback follows the selected content style", () => {
  const output = buildHeuristicBenchmarkAnalysis({ contentStyle: "drama", videos: [
    { id: "d", title: "冲突反转后真相揭开", sourceText: "人物冲突 误会 反转" },
  ] });
  assert.equal(output.categories[0].name, "冲突与反转类");
  assert.equal(output.categories[0].topics[0].id, "d");
});
