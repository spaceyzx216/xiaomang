import test from "node:test";
import assert from "node:assert/strict";

import {
  REVIEW_TYPE,
  VIDEO_ANALYSIS_REPORT_TYPE,
  buildHeuristicVideoAnalysisSuggestions,
  buildMetricReadout,
  buildVideoAnalysisReport,
  normalizeStructureTags,
  normalizeVideoAnalysisSuggestions,
  normalizeVideoMeta,
  summarizeVideoAnalysisReport,
} from "../api/_lib/videoAnalysis.js";

/**
 * 4.1 单条视频数据分析。
 *
 * 测试数据刻意用**真实量级**（12500 播放 / 830 赞 / 完播率 32%），
 * 而不是 1、2、3 —— 阈值全是百分比，用 0/1 当数据测不出真实行为。
 */

// 一条「各项都达优秀」的视频（用户示例里的第一行同量级）。
const GOOD_ROW = {
  plays: 12500, likes: 830, comments: 96, shares: 210, bookmarks: 340,
  completionRate: 0.32, bounce2sRate: 0.18, completion5sRate: 0.55,
  avgPlaySeconds: 42.5, durationSeconds: 118,
};

// 一条「各项都触发优化线」的视频。
const BAD_ROW = {
  plays: 860, likes: 41, comments: 7, shares: 3, bookmarks: 12,
  completionRate: 0.12, bounce2sRate: 0.58, completion5sRate: 0.21,
  avgPlaySeconds: 12, durationSeconds: 96,
};

const DICTIONARY = [
  { name: "风险防御与合规建设", subcategories: [{ name: "入职合规与制度完善" }, { name: "薪酬结构与福利设计" }] },
  { name: "危机应对与关系管理", subcategories: [{ name: "违纪处理与离职管理" }] },
];

// ── 结构标签 ──────────────────────────────────────────────────────────────

test("结构标签：3s 与标题用同一份 8 类型表（与「标题类型和三秒同源」的设计决定一致）", () => {
  const { tags } = normalizeStructureTags({
    tags: { goldThreeSecondsType: "fear", titleType: "fear", endingHookType: "twist" },
  });
  assert.equal(tags.goldThreeSecondsType, "fear");
  assert.equal(tags.goldThreeSecondsLabel, "恐惧");
  assert.equal(tags.titleType, "fear");
  assert.equal(tags.titleLabel, "恐惧");
  assert.equal(tags.endingHookType, "twist");
  assert.equal(tags.endingHookLabel, "反转");
});

test("结构标签认中文与别名，认不出的落「待人工复核」并记 warning，不猜", () => {
  const { tags, warnings } = normalizeStructureTags({ tags: { goldThreeSecondsType: "恐惧" } });
  assert.equal(tags.goldThreeSecondsType, "fear");
  assert.equal(warnings.length, 0);

  const bad = normalizeStructureTags({ tags: { goldThreeSecondsType: "玄学钩子" } });
  assert.equal(bad.tags.goldThreeSecondsType, REVIEW_TYPE);
  assert.equal(bad.tags.goldThreeSecondsLabel, "待人工复核");
  assert.match(bad.warnings[0], /玄学钩子/);
});

test("没给类型时也是「待人工复核」，不默认成某个类型", () => {
  const { tags } = normalizeStructureTags({ tags: {} });
  assert.equal(tags.goldThreeSecondsType, REVIEW_TYPE);
  assert.equal(tags.titleType, REVIEW_TYPE);
  assert.equal(tags.endingHookType, REVIEW_TYPE);
});

test("选题库校验：库里没有的大类/小类保留原值但记 warning —— 用户选的不能被静默改掉", () => {
  const ok = normalizeStructureTags({
    tags: { categoryName: "风险防御与合规建设", subcategoryName: "入职合规与制度完善" },
    categoryDictionary: DICTIONARY,
  });
  assert.equal(ok.warnings.length, 0);
  assert.equal(ok.tags.subcategoryName, "入职合规与制度完善");

  const unknownCategory = normalizeStructureTags({
    tags: { categoryName: "不存在的大类" }, categoryDictionary: DICTIONARY,
  });
  assert.equal(unknownCategory.tags.categoryName, "不存在的大类");
  assert.match(unknownCategory.warnings[0], /不在当前客户的选题库里/);

  const wrongSub = normalizeStructureTags({
    tags: { categoryName: "风险防御与合规建设", subcategoryName: "违纪处理与离职管理" },
    categoryDictionary: DICTIONARY,
  });
  assert.equal(wrongSub.tags.subcategoryName, "违纪处理与离职管理");
  assert.match(wrongSub.warnings[0], /不属于大类/);
});

test("不传选题库词典时不做校验、也不报 warning", () => {
  const { warnings } = normalizeStructureTags({ tags: { categoryName: "随便一个大类" } });
  assert.deepEqual(warnings, []);
});

// ── 指标读数表 ────────────────────────────────────────────────────────────

test("指标读数表带「含义」与权重位次 —— 用户要求把数据背后的意义显示出来", () => {
  const readout = buildMetricReadout({ platform: "douyin", metrics: { likes: 1, plays: 2 }, derived: {} });
  const likes = readout.engagement.find(item => item.key === "likes");
  assert.equal(likes.meaning, "内容使用户产生共鸣 / 情绪");
  assert.equal(likes.weightRank, 3); // 关注 > 收藏=转发 > 评论=点赞
  const follows = readout.engagement.find(item => item.key === "follows");
  assert.equal(follows.optional, true);
  assert.equal(follows.weightRank, 1);
});

test("指标读数表按平台给不同的指标集：抖音没有红心，视频号没有收藏", () => {
  const douyin = buildMetricReadout({ platform: "douyin" }).engagement.map(item => item.key);
  assert.ok(douyin.includes("bookmarks"));
  assert.ok(!douyin.includes("recommends"));

  const wechat = buildMetricReadout({ platform: "wechat_channels" }).engagement.map(item => item.key);
  assert.ok(wechat.includes("recommends"));
  assert.ok(!wechat.includes("bookmarks"));
});

// ── 端到端组装 ────────────────────────────────────────────────────────────

test("全优视频：四大结构全部判「可模仿复用」，各项指标落 good", () => {
  const report = buildVideoAnalysisReport({
    platform: "douyin", rawMetrics: GOOD_ROW,
    scriptText: "员工主动离职到底能不能要赔偿？",
    structureTags: { categoryName: "风险防御与合规建设", subcategoryName: "入职合规与制度完善", goldThreeSecondsType: "fear", titleType: "fear", endingHookType: "interaction" },
    categoryDictionary: DICTIONARY,
    agentOutput: { summary: "整体表现优秀", structures: [{ key: "topicType", why: "完播率与平均播放率都高于优秀线", how: "继续沿用该小类" }] },
  });

  assert.equal(report.reportType, VIDEO_ANALYSIS_REPORT_TYPE);
  assert.equal(report.platformLabel, "抖音");
  assert.deepEqual(report.structures.map(item => item.verdict), ["reuse", "reuse", "reuse", "reuse"]);
  assert.equal(report.analysisSource, "agent");
  assert.deepEqual(report.warnings, []);

  // 互动率 (830+96+210+340)/12500 = 11.8%
  assert.equal(report.derived.interactionRatePercent, 11.8);
  assert.equal(report.metrics.plays, 12500);
});

test("全差视频：四大结构全部判「需要优化」，并写明是哪个指标触发的", () => {
  const report = buildVideoAnalysisReport({ platform: "douyin", rawMetrics: BAD_ROW });
  assert.deepEqual(report.structures.map(item => item.verdict), ["optimize", "optimize", "optimize", "optimize"]);
  const gold = report.structures.find(item => item.key === "goldThreeSeconds");
  assert.ok(gold.reasons.some(text => /2s 跳出率/.test(text)));
  // 播放量 860 → 基础流量池
  assert.equal(report.playBucket.key, "base");
});

test("Excel 里同一列写成 0.32 / 32 / \"32%\" 得到同一份结论", () => {
  const build = completionRate => buildVideoAnalysisReport({
    platform: "douyin",
    rawMetrics: { ...GOOD_ROW, completionRate },
  });
  const a = build(0.32);
  const b = build(32);
  const c = build("32%");
  for (const report of [a, b, c]) {
    const completion = report.judgments.find(item => item.metric === "completionRate");
    assert.equal(completion.level, "good");
  }
});

test("缺失与越界指标如实进 warnings，不静默当成 0", () => {
  const report = buildVideoAnalysisReport({
    platform: "douyin",
    // 完播率写成 150 —— 归一化后是 150%（>100%，不可能），必须标可疑而不是夹成 100%
    rawMetrics: { plays: 1000, likes: 50, comments: 5, shares: 5, bookmarks: 5, completionRate: 150 },
  });
  assert.ok(report.warnings.some(text => /2s 跳出率.*没有取到数值/.test(text)));
  assert.ok(report.warnings.some(text => /完播率.*超出合理范围/.test(text)));
  const completion = report.judgments.find(item => item.metric === "completionRate");
  assert.equal(completion.level, "suspicious");
  assert.equal(completion.value, 1.5);
});

test("🔴 百分比列的口径约定：1.5 读作 1.5%，32 读作 32%（同一条规则）", () => {
  // Excel 的百分比列写法取决于单元格格式，同一列可能是 0.32 / 32 / "32%"。
  // 归一化规则是「>1 就当百分数除以 100」，所以：
  //   · 用户想填 1.5% → 写 1.5 或 "1.5%" 都对；
  //   · 用户想填 150% → 得写 150（写成 1.5 会被读成 1.5%）。
  // 这条约定写在这里，避免下一个会话把它当成 bug「修」掉。
  const asFraction = raw => buildVideoAnalysisReport({ platform: "douyin", rawMetrics: { completionRate: raw } })
    .judgments.find(item => item.metric === "completionRate").value;
  assert.equal(asFraction(1.5), 0.015);
  assert.equal(asFraction("1.5%"), 0.015);
  assert.equal(asFraction(32), 0.32);
  assert.equal(asFraction(150), 1.5);
});

test("「关注」缺失不产生 warning（它不参与判定），只在报告里单列 optionalMissing", () => {
  const report = buildVideoAnalysisReport({ platform: "douyin", rawMetrics: BAD_ROW });
  assert.deepEqual(report.optionalMissing, ["follows"]);
  assert.equal(report.warnings.some(text => /关注/.test(text)), false);

  const withFollows = buildVideoAnalysisReport({ platform: "douyin", rawMetrics: { ...BAD_ROW, follows: 120 } });
  assert.deepEqual(withFollows.optionalMissing, []);
});

test("视频号报告的指标集与抖音不同：用 3 秒以上播放率判 3s 与标题", () => {
  const report = buildVideoAnalysisReport({
    platform: "wechat_channels",
    rawMetrics: { plays: 5000, likes: 300, comments: 40, shares: 80, recommends: 200, completionRate: 0.32, play3sRate: 0.5, avgPlaySeconds: 30, durationSeconds: 100 },
  });
  assert.equal(report.platformLabel, "视频号");
  assert.equal(report.judgments.some(item => item.metric === "bounce2sRate"), false);
  assert.equal(report.judgments.some(item => item.metric === "play3sRate"), true);
  const gold = report.structures.find(item => item.key === "goldThreeSeconds");
  assert.equal(gold.verdict, "optimize");
});

// ── 优化建议：模型只写文字，结论以后端为准 ────────────────────────────────

test("🔴 模型把结论说反时以后端为准，并留 warning（防误导用户）", () => {
  const report = buildVideoAnalysisReport({
    platform: "douyin", rawMetrics: BAD_ROW,
    agentOutput: {
      summary: "整体不错",
      structures: [{ key: "topicType", verdict: "reuse", why: "模型认为很好", how: "继续" }],
    },
  });
  const topic = report.suggestions.items.find(item => item.key === "topicType");
  // 后端实算是 optimize（完播率 12%、平均播放率 12.5% 都触发了优化线）
  assert.equal(topic.verdict, "optimize");
  assert.equal(topic.verdictLabel, "需要优化");
  assert.ok(report.warnings.some(text => /模型把「选题类型（小类）」判为.*不一致.*已以后端为准/.test(text)));
});

test("模型没给文字就留空字符串，前端显示「待人工补充」—— 不许编通用话术凑数", () => {
  const { suggestions } = normalizeVideoAnalysisSuggestions({
    agentOutput: { structures: [{ key: "title" }] },
    structures: [{ key: "title", label: "标题", verdict: "optimize", verdictLabel: "需要优化", reasons: ["2s 跳出率触发优化线"] }],
  });
  const title = suggestions.items.find(item => item.key === "title");
  assert.equal(title.why, "");
  assert.equal(title.how, "");
  // 判定依据是后端实算的，一定有
  assert.deepEqual(title.reasons, ["2s 跳出率触发优化线"]);
});

test("模型返回不认识的结构 key 时丢弃并记 warning", () => {
  const { warnings } = normalizeVideoAnalysisSuggestions({
    agentOutput: { structures: [{ key: "封面", why: "x" }] },
    structures: [{ key: "title", label: "标题", verdict: "good", verdictLabel: "优秀", reasons: [] }],
  });
  assert.ok(warnings.some(text => /不认识的结构「封面」/.test(text)));
});

test("没有模型输出时走规则兜底：只给得出从数据能核对的结论，文字留空", () => {
  const report = buildVideoAnalysisReport({ platform: "douyin", rawMetrics: BAD_ROW });
  assert.equal(report.analysisSource, "heuristic");
  assert.equal(report.suggestions.summary, "");
  for (const item of report.suggestions.items) {
    assert.equal(item.why, "");
    assert.equal(item.how, "");
    assert.ok(item.verdictLabel);
  }
  assert.equal(report.structures.find(item => item.key === "topicType").verdict, "optimize");
});

test("规则兜底单独调用时结构顺序固定为四大结构", () => {
  const { items } = buildHeuristicVideoAnalysisSuggestions({ structures: [] });
  assert.deepEqual(items.map(item => item.key), ["topicType", "goldThreeSeconds", "title", "endingHook"]);
  assert.ok(items.every(item => item.verdict === "missing"));
});

// ── 视频元信息与摘要 ──────────────────────────────────────────────────────

test("视频链接只认 http(s)，其它一律留空（不把 javascript: 之类带进报告）", () => {
  assert.equal(normalizeVideoMeta({ link: "https://v.douyin.com/abc" }).link, "https://v.douyin.com/abc");
  assert.equal(normalizeVideoMeta({ link: "javascript:alert(1)" }).link, "");
  assert.equal(normalizeVideoMeta({ link: "  " }).link, "");
});

test("摘要只给元数据：不含文案正文、不含指标明细", () => {
  const report = buildVideoAnalysisReport({
    platform: "douyin", rawMetrics: GOOD_ROW,
    scriptText: "这是一段很长的文案正文，不该出现在列表里",
    structureTags: { categoryName: "风险防御与合规建设", subcategoryName: "入职合规与制度完善" },
    video: { title: "员工主动离职能不能要赔偿？", link: "https://v.douyin.com/abc" },
  });
  const summary = summarizeVideoAnalysisReport(report);
  assert.equal(summary.videoTitle, "员工主动离职能不能要赔偿？");
  assert.equal(summary.categoryName, "风险防御与合规建设");
  assert.equal(summary.optimizeCount, 0);
  assert.equal(JSON.stringify(summary).includes("这是一段很长的文案正文"), false);
  assert.equal("script" in summary, false);
});
