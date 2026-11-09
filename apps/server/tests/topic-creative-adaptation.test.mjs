import test from "node:test";
import assert from "node:assert/strict";

import {
  ADAPTATION_SOURCE,
  CREATIVE_CANDIDATE_COUNT,
  buildCategoryAdaptation,
  formatAdaptationForPrompt,
  globalDimensions,
  indexBreakdownByCategory,
  planCreativeSlotCounts,
  planCreativeSlots,
} from "../api/_lib/topicCreativeAdaptation.js";
import { normalizeEndingHook, normalizeOpeningHook } from "../api/_lib/contentAgent/adapter.js";
import { getCategoryNamesFromBody } from "../api/_lib/contentAgent/index.js";
import { CREATIVE_ENDING_HOOKS_PROMPT, CREATIVE_GOLD_THREE_SECONDS_PROMPT, GOLD_THREE_SECONDS_PROMPT } from "../api/_lib/contentAgent/prompts.js";

/**
 * 「按选题库大类配比」二创适配的契约测试（2026-09-21 第六轮）。
 *
 * 这里钉住的都是**静默出错**的那类不变量 —— 出问题时不会抛异常，
 * 只会安静地少给几条、给错类型，或者把「待人工复核」当成创作方向。
 */

const LABELS = { knowledge: "求知欲", fear: "恐惧", anger: "愤怒", contrast: "反差", interaction: "引导互动", punchline: "金句", resonance_ip: "共鸣＋IP符号" };

const sumCounts = items => items.reduce((sum, item) => sum + item.count, 0);

/** 图 1 的真实口径：求知欲 40 / 恐惧 30 / 愤怒 20 / 反差 10。 */
const FIGURE_1_DIMENSIONS = [
  { type: "knowledge", count: 4, ratio: 40 },
  { type: "fear", count: 3, ratio: 30 },
  { type: "anger", count: 2, ratio: 20 },
  { type: "contrast", count: 1, ratio: 10 },
];

test("配比按最大余额法折算成条数：图 1 的 40/30/20/10 恰好得到 4/3/2/1", () => {
  const planned = planCreativeSlotCounts(FIGURE_1_DIMENSIONS);
  assert.equal(sumCounts(planned), CREATIVE_CANDIDATE_COUNT);
  assert.deepEqual(
    planned.map(item => [item.type, item.count]),
    [["knowledge", 4], ["fear", 3], ["anger", 2], ["contrast", 1]],
  );
});

test("无论配比怎么给，条数合计恒等于 10 —— 不能少给让前端以为失败", () => {
  const cases = [
    // 三类型 40/30/30（图 3 那种形状）
    [{ type: "fear", count: 4, ratio: 40 }, { type: "knowledge", count: 3, ratio: 30 }, { type: "anger", count: 3, ratio: 30 }],
    // 五类型各 20%
    ["a", "b", "c", "d", "e"].map(type => ({ type, count: 1, ratio: 20 })),
    // 除不尽的 1/3
    [{ type: "a", count: 33, ratio: 33 }, { type: "b", count: 33, ratio: 33 }, { type: "c", count: 34, ratio: 34 }],
    // 真实条数（报告里 count 与 ratio 是两套精度）
    [{ type: "knowledge", count: 12, ratio: 52.2 }, { type: "fear", count: 7, ratio: 30.4 }, { type: "anger", count: 3, ratio: 13 }, { type: "contrast", count: 1, ratio: 4.3 }],
    // 只有一个类型
    [{ type: "fear", count: 10, ratio: 100 }],
  ];
  for (const dimensions of cases) {
    const planned = planCreativeSlotCounts(dimensions);
    assert.equal(sumCounts(planned), CREATIVE_CANDIDATE_COUNT, `配比 ${JSON.stringify(dimensions)} 的条数合计必须是 10`);
  }
});

test("「待人工复核」永远不参与配比 —— 它是人工待办队列，不是创作方向", () => {
  const planned = planCreativeSlotCounts([
    { type: "review", count: 90, ratio: 90 },
    { type: "fear", count: 10, ratio: 10 },
  ]);
  assert.deepEqual(planned.map(item => item.type), ["fear"]);
  assert.equal(sumCounts(planned), CREATIVE_CANDIDATE_COUNT);
  // 只剩 review 时不能凭空造出类型，如实回空（调用方据此降级）。
  assert.deepEqual(planCreativeSlotCounts([{ type: "review", count: 5, ratio: 100 }]), []);
});

test("槽位展开是确定的有序计划：占比高的类型排前面，index 从 1 开始", () => {
  const slots = planCreativeSlots(FIGURE_1_DIMENSIONS);
  assert.equal(slots.length, CREATIVE_CANDIDATE_COUNT);
  assert.deepEqual(slots.map(slot => slot.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(
    slots.map(slot => slot.type),
    ["knowledge", "knowledge", "knowledge", "knowledge", "fear", "fear", "fear", "anger", "anger", "contrast"],
  );
});

test("槽位计划对输入顺序不敏感 —— 上游排序变了不能让用户看到的类型分配跟着抖动", () => {
  const shuffled = [FIGURE_1_DIMENSIONS[2], FIGURE_1_DIMENSIONS[0], FIGURE_1_DIMENSIONS[3], FIGURE_1_DIMENSIONS[1]];
  assert.deepEqual(planCreativeSlotCounts(shuffled), planCreativeSlotCounts(FIGURE_1_DIMENSIONS));
});

test("大类命中时用该大类的配比，并如实标注来源", () => {
  const report = { categoryBreakdown: [{ categoryName: "政策解读与环境洞察", dimensions: FIGURE_1_DIMENSIONS }] };
  const adaptation = buildCategoryAdaptation({ categoryName: "政策解读与环境洞察", report, labels: LABELS });

  assert.equal(adaptation.source, ADAPTATION_SOURCE.category);
  assert.equal(adaptation.matchedCategory, "政策解读与环境洞察");
  assert.equal(adaptation.slots.length, CREATIVE_CANDIDATE_COUNT);
  // 每条槽位都必须带上中文标签（前端与提示词都靠它，不能只有英文 key）。
  assert.ok(adaptation.slots.every(slot => slot.typeLabel && slot.typeLabel !== slot.type));
  assert.deepEqual(adaptation.counts.map(item => [item.typeLabel, item.count]), [["求知欲", 4], ["恐惧", 3], ["愤怒", 2], ["反差", 1]]);
});

test("查不到该大类时降级到全库配比，并明确标注是降级口径（不假装用了大类配比）", () => {
  const report = {
    categoryBreakdown: [{ categoryName: "政策解读与环境洞察", dimensions: FIGURE_1_DIMENSIONS }],
    typeDistribution: [
      { type: "knowledge", count: 10, percentage: 50 },
      { type: "fear", count: 10, percentage: 50 },
      // 待复核必须在全局兜底里也被剔掉。
      { type: "review", count: 8, percentage: 40 },
    ],
  };
  const adaptation = buildCategoryAdaptation({ categoryName: "库里没有的大类", report, labels: LABELS });

  assert.equal(adaptation.source, ADAPTATION_SOURCE.libraryGlobal);
  assert.equal(adaptation.matchedCategory, "");
  assert.equal(adaptation.slots.length, CREATIVE_CANDIDATE_COUNT);
  assert.ok(!adaptation.counts.some(item => item.type === "review"));
  assert.match(adaptation.note, /没有大类|降级|通用配比/);
});

test("没有选题库时如实回 none 且不产出槽位 —— 调用方据此退回原来的自由二创", () => {
  const adaptation = buildCategoryAdaptation({ categoryName: "任意大类", report: null, labels: LABELS });
  assert.equal(adaptation.source, ADAPTATION_SOURCE.none);
  assert.deepEqual(adaptation.slots, []);
  assert.deepEqual(adaptation.counts, []);
  // 空计划必须渲染成空串，否则提示词里会多一段没有内容的「配比要求」。
  assert.equal(formatAdaptationForPrompt(adaptation), "");
});

test("indexBreakdownByCategory 只看报告正文的 categoryBreakdown，不认顶层分类树", () => {
  // 顶层 categories 只是序列化兼容别名，里面**没有**配比 —— 拿它当来源会得到空计划。
  const report = {
    categories: [{ name: "政策解读与环境洞察", subcategories: [{ name: "超龄用工" }] }],
    categoryBreakdown: [{ categoryName: "政策解读与环境洞察", dimensions: FIGURE_1_DIMENSIONS }],
  };
  const index = indexBreakdownByCategory(report);
  assert.equal(index.size, 1);
  assert.equal(index.get("政策解读与环境洞察").length, 4);

  const empty = indexBreakdownByCategory({ categories: report.categories });
  assert.equal(empty.size, 0);
  assert.deepEqual(globalDimensions({}), []);
});

test("提示词里的配比片段逐条指定类型，并声明配比是后端实算的", () => {
  const report = { categoryBreakdown: [{ categoryName: "政策解读与环境洞察", dimensions: FIGURE_1_DIMENSIONS }] };
  const text = formatAdaptationForPrompt(buildCategoryAdaptation({ categoryName: "政策解读与环境洞察", report, labels: LABELS }));

  assert.match(text, /政策解读与环境洞察/);
  assert.match(text, /后端实算/);
  // 逐条指定：模型自己分配时实测会把 10 条全写成占比最高那一种。
  for (let index = 1; index <= CREATIVE_CANDIDATE_COUNT; index += 1) {
    assert.match(text, new RegExp(`第 ${index} 条 → `), `缺少第 ${index} 条的指定`);
  }
  assert.match(text, /第 1 条 → 求知欲（knowledge）/);
  assert.match(text, /第 10 条 → 反差（contrast）/);
});

test("提示词维度清单从唯一定义派生，且两位 agent 各自只讲自己那套类型", () => {
  // §6.3⑫：维度清单只能从 GOLD_THREE_SECOND_DIMENSIONS / ENDING_HOOK_TYPES 生成。
  assert.match(CREATIVE_GOLD_THREE_SECONDS_PROMPT, /8 个三秒维度的判定口径/);
  assert.match(CREATIVE_GOLD_THREE_SECONDS_PROMPT, /求知欲/);
  assert.match(CREATIVE_GOLD_THREE_SECONDS_PROMPT, /反差/);
  // 三秒 agent 不该混进结尾钩子的类型。
  assert.doesNotMatch(CREATIVE_GOLD_THREE_SECONDS_PROMPT, /共鸣＋IP符号/);

  assert.match(CREATIVE_ENDING_HOOKS_PROMPT, /5 个结尾钩子类型的判定口径/);
  assert.match(CREATIVE_ENDING_HOOKS_PROMPT, /引导互动/);
  assert.match(CREATIVE_ENDING_HOOKS_PROMPT, /共鸣＋IP符号/);
  assert.doesNotMatch(CREATIVE_ENDING_HOOKS_PROMPT, /反差 ——/);

  // 两个新提示词都必须要求「逐条按指定类型」，并且都要求诚实判断原文案类型。
  for (const prompt of [CREATIVE_GOLD_THREE_SECONDS_PROMPT, CREATIVE_ENDING_HOOKS_PROMPT]) {
    assert.match(prompt, /严格按这个顺序和类型/);
    assert.match(prompt, /originalType/);
    assert.match(prompt, /不编造事实/);
  }
  // 新的三秒提示词是**新增**的，不能把原来那个（分析用）改掉。
  assert.match(GOLD_THREE_SECONDS_PROMPT, /黄金三秒/);
});

test("归一化保留带类型的候选与原文案类型判断，且旧形状不冒出多余字段", () => {
  const adapted = normalizeOpeningHook({
    extracted: "原文开头",
    created: [],
    candidates: [{ index: 1, type: "fear", typeLabel: "恐惧", content: "新开场一" }, { index: 2, type: "anger", typeLabel: "愤怒", content: "新开场二" }],
    originalType: { type: "knowledge", typeLabel: "求知欲", reason: "原开场在讲干货" },
  });
  assert.equal(adapted.candidates.length, 2);
  assert.deepEqual(adapted.candidates[0], { index: 1, type: "fear", typeLabel: "恐惧", content: "新开场一" });
  assert.equal(adapted.originalType.type, "knowledge");

  // 没有 type 的候选必须被丢掉：前端会把 content 直接渲染成按钮，空壳等于一个点不动的按钮。
  const filtered = normalizeOpeningHook({ candidates: [{ index: 1, content: "缺类型" }, { index: 2, type: "fear", content: "" }, { index: 4, type: "fear", content: "好的" }] });
  assert.deepEqual(filtered.candidates.map(item => item.content), ["好的"]);

  // 旧路径（没有配比）不产出这两个字段，前端形状保持原样。
  const legacy = normalizeOpeningHook({ extracted: "x", created: ["a"] });
  assert.equal("candidates" in legacy, false);
  assert.equal("originalType" in legacy, false);

  const ending = normalizeEndingHook({
    extracted_result: "无",
    rcs: [],
    candidates: [{ index: 1, type: "punchline", typeLabel: "金句", content: "金句一条" }],
    originalType: { type: "resonance_ip", typeLabel: "共鸣＋IP符号", reason: "结尾有口头禅" },
  });
  assert.equal(ending.candidates.length, 1);
  assert.equal(ending.originalType.type, "resonance_ip");
});

test("请求体解析：只接受「链接 → 非空大类名」，兼容三种写法", () => {
  const expected = [["https://a.com/1", "政策解读与环境洞察"]];
  assert.deepEqual([...getCategoryNamesFromBody({ content_adaptation: { "https://a.com/1": "政策解读与环境洞察", "https://a.com/2": "" } })], expected);
  assert.deepEqual([...getCategoryNamesFromBody({ contentAdaptation: { "https://a.com/1": "政策解读与环境洞察" } })], expected);
  assert.deepEqual([...getCategoryNamesFromBody({ parameters: { content_adaptation: { "https://a.com/1": "政策解读与环境洞察" } } })], expected);
  // 空 / 形状不对时回空表，让调用方走降级而不是抛错。
  assert.equal(getCategoryNamesFromBody({}).size, 0);
  assert.equal(getCategoryNamesFromBody({ content_adaptation: "不是对象" }).size, 0);
  assert.equal(getCategoryNamesFromBody({ content_adaptation: { "  ": "  " } }).size, 0);
});
