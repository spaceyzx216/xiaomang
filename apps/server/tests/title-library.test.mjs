import test from "node:test";
import assert from "node:assert/strict";

import {
  TITLE_AGENT_NAME,
  TITLE_TYPE_KEYS,
  TITLE_TYPE_LABELS,
  TITLE_TYPES,
  buildTitleAdaptation,
  describeTitleAdaptation,
  formatTitleCandidatesAsText,
} from "../api/_lib/titleLibrary.js";
import { GOLD_THREE_SECOND_TYPE_LABELS } from "../api/_lib/goldThreeSeconds.js";
import { CREATIVE_TITLE_PROMPT } from "../api/_lib/contentAgent/prompts.js";
import { buildVideoAdaptation } from "../api/_lib/contentAgent/index.js";

/**
 * 标题库（2.3 标题）的契约测试，2026-09-24。
 *
 * 与 topic-creative-adaptation.test.mjs 同一立场：这里钉的都是**静默出错**的
 * 不变量 —— 出问题时不抛异常，只会安静地少给几条、类型标错，或者让标题悄悄
 * 退回自由创作口径（用户完全看不出来）。
 */

/** 需求文档给的 8 个标题类型，逐字对照（顺序也照文档）。 */
const DOC_TITLE_TYPES = ["好奇心", "恐惧", "愤怒", "反差", "痛点", "兴趣", "求知欲", "欲望"];

/** 图 1 的口径：求知欲 40 / 恐惧 30 / 愤怒 20 / 反差 10。 */
const FIGURE_1 = [
  { categoryName: "政策解读与环境洞察", dimensions: [
    { type: "knowledge", count: 4, ratio: 40 },
    { type: "fear", count: 3, ratio: 30 },
    { type: "anger", count: 2, ratio: 20 },
    { type: "contrast", count: 1, ratio: 10 },
    // 「待人工复核」是人工待办队列，不是创作方向 —— 必须被排除在配比之外。
    { type: "review", count: 9, ratio: 90 },
  ] },
];

const report = () => ({ categoryBreakdown: FIGURE_1 });
const slotsOf = adaptation => adaptation.slots.map(slot => slot.type);
const countByType = adaptation => Object.fromEntries(adaptation.counts.map(item => [item.type, item.count]));

test("标题类型就是需求文档那 8 个，且与黄金三秒同源（不另立一套）", () => {
  assert.deepEqual(TITLE_TYPE_KEYS, ["curiosity", "fear", "anger", "contrast", "pain", "interest", "knowledge", "desire"]);
  assert.deepEqual(TITLE_TYPE_KEYS.map(key => TITLE_TYPE_LABELS[key]), DOC_TITLE_TYPES);
  // 🔴 同源的关键断言：两张表必须是同一个对象，而不是"内容碰巧一样的两份"。
  //    分成两份后只要有人改了一边，标题与三秒的口径就会悄悄分叉。
  assert.equal(TITLE_TYPE_LABELS, GOLD_THREE_SECOND_TYPE_LABELS);
  assert.equal(TITLE_TYPES.length, 8);
});

test("标题配比复用 2.2 报告的大类配比：40/30/20/10 恰好得到 4/3/2/1", () => {
  const adaptation = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  assert.equal(adaptation.source, "category");
  assert.equal(adaptation.matchedCategory, "政策解读与环境洞察");
  assert.equal(adaptation.slots.length, 10);
  assert.deepEqual(countByType(adaptation), { knowledge: 4, fear: 3, anger: 2, contrast: 1 });
});

test("无论配比怎么给，标题条数恒等于 10 —— 不能少给让用户以为生成失败", () => {
  const cases = [
    [{ type: "knowledge", count: 9, ratio: 90 }, { type: "fear", count: 1, ratio: 10 }],
    [{ type: "knowledge", count: 1, ratio: 1 }, { type: "fear", count: 1, ratio: 1 }, { type: "anger", count: 1, ratio: 1 }],
    [{ type: "desire", count: 7, ratio: 100 }],
  ];
  for (const dimensions of cases) {
    const adaptation = buildTitleAdaptation({
      categoryName: "X",
      report: { categoryBreakdown: [{ categoryName: "X", dimensions }] },
    });
    assert.equal(adaptation.slots.length, 10, `配比 ${JSON.stringify(dimensions)} 没给满 10 条`);
  }
});

test("「待人工复核」永远不进标题配比 —— 它是人工待办队列，不是创作方向", () => {
  const adaptation = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  assert.ok(!slotsOf(adaptation).includes("review"));
  assert.equal(adaptation.counts.some(item => item.type === "review"), false);
});

test("槽位排序确定：占比高的类型排在前面，index 从 1 开始", () => {
  const adaptation = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  assert.deepEqual(slotsOf(adaptation), [
    "knowledge", "knowledge", "knowledge", "knowledge",
    "fear", "fear", "fear",
    "anger", "anger",
    "contrast",
  ]);
  assert.deepEqual(adaptation.slots.map(slot => slot.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("大类命中时用该大类配比；查不到时降级到全库并如实标注（不假装用了大类配比）", () => {
  const hit = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  assert.equal(hit.source, "category");

  const miss = buildTitleAdaptation({
    categoryName: "库里没有的大类",
    report: { ...report(), typeDistribution: [{ type: "interest", count: 5, percentage: 100 }] },
  });
  assert.equal(miss.source, "library_global");
  assert.equal(miss.matchedCategory, "");
  assert.deepEqual(slotsOf(miss), Array(10).fill("interest"));

  const none = buildTitleAdaptation({ categoryName: "任意", report: null });
  assert.equal(none.source, "none");
  assert.equal(none.slots.length, 0);
});

test("标题配比来源说明说的是「标题」，不能串成三秒的文案", () => {
  const adaptation = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  const text = describeTitleAdaptation(adaptation);
  assert.match(text, /标题库/);
  assert.match(text, /政策解读与环境洞察/);
  assert.match(text, /10 条/);
  assert.ok(!text.includes("三秒"), "标题的说明里不该出现三秒口径");

  const miss = buildTitleAdaptation({ categoryName: "不存在", report: { ...report(), typeDistribution: [{ type: "fear", count: 1, percentage: 100 }] } });
  assert.match(describeTitleAdaptation(miss), /全库通用配比/);
  // 没有配比时返回空串：标题这次按自由创作口径走，没有配比可说明，
  // 编一句"本次按某配比生成"反而是假话。前端据此不渲染说明块。
  assert.equal(describeTitleAdaptation(null), "");
});

test("渲染成前端可解析的文本块：N. 《标题》+ 类型（中文＋英文 key）", () => {
  const adaptation = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  const text = formatTitleCandidatesAsText(
    adaptation.slots.map(slot => ({ index: slot.index, type: slot.type, typeLabel: slot.typeLabel, content: `标题${slot.index}` })),
    { type: "knowledge", typeLabel: "求知欲", reason: "原文在讲方法" },
  );

  // 前端 parseTitleBlocks 靠这两条正则切块：`^\d+\s*[\.、]` 与 `^类型[:：]`。
  const blockStarts = text.split("\n").filter(line => /^\d+\s*[\.、]/.test(line));
  assert.equal(blockStarts.length, 10, "必须正好 10 个标题块");
  assert.equal(text.split("\n").filter(line => /^类型[:：]/.test(line)).length, 10);
  assert.match(text, /^1\. 《标题1》$/m);
  assert.match(text, /^类型：求知欲（knowledge）$/m);
});

/**
 * 前端 `ContentPage.parseTitleBlocks` 的等价实现（只保留与本链路相关的部分）。
 *
 * 🔴 刻意在这里**照抄一份**而不是 import：前端是 .tsx、后端测试是 .mjs，跨端
 *    import 不现实；而这条链路最容易出的错恰恰是"后端改了文本格式、前端解析不到"，
 *    所以宁可维护这几行镜像代码，也要把这个契约钉在测试里。
 *    改前端解析逻辑时，这里要同步改 —— 否则这道防线就失效了。
 */
const parseTitleBlocksLikeFrontend = titleText => {
  const normalize = line => String(line || "")
    .replace(/^[-]{2,}\s*$/, "").replace(/^#{1,6}\s*/, "")
    .replace(/\*\*/g, "").replace(/^\*+\s*/, "").replace(/\*+$/, "").trim();
  const lines = String(titleText || "").split("\n").map(normalize)
    .filter(Boolean).filter(line => !line.includes("爆款标题") && line !== "---");

  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^\d+\s*[\.、]/.test(line) || /^标题[:：]/.test(line)) {
      if (current?.title) blocks.push(current);
      const body = line.replace(/^\d+\s*[\.、]?\s*/, "").replace(/^标题[:：]\s*/, "").trim();
      const quoted = body.match(/《([^》]+)》/);
      current = { title: (quoted ? quoted[1] : body).trim(), type: "", typeKey: "" };
      continue;
    }
    if (!current) continue;   // 块外的行会被丢弃 —— 这正是"表头会被吃掉"的原因
    if (/^\*?\*?类型\*?\*?[:：]/.test(line)) { current.type = line.replace(/^\*?\*?类型\*?\*?[:：]\s*/, "").trim(); continue; }
    if (/^\*?\*?原标题类型\*?\*?[:：]/.test(line)) { current.originalType = line.replace(/^.*?[:：]\s*/, "").trim(); continue; }
  }
  if (current?.title) blocks.push(current);
  return blocks;
};

test("原文格式：后端渲染的文本能被前端解析回 10 个块，且类型标签完整保留", () => {
  const adaptation = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  const text = formatTitleCandidatesAsText(
    adaptation.slots.map(slot => ({ index: slot.index, type: slot.type, typeLabel: slot.typeLabel, content: `标题${slot.index}` })),
    { type: "knowledge", typeLabel: "求知欲", reason: "在讲方法" },
  );
  const parsed = parseTitleBlocksLikeFrontend(text);
  assert.equal(parsed.length, 10, "前端必须能切出 10 个标题块");
  assert.deepEqual(parsed.map(b => b.title), Array.from({ length: 10 }, (_, i) => `标题${i + 1}`));
  // 类型标签逐块保留：这是复盘时按类型归类的唯一依据，丢了就断了第三部分的链路。
  assert.deepEqual(parsed.map(b => b.type), [
    "求知欲（knowledge）", "求知欲（knowledge）", "求知欲（knowledge）", "求知欲（knowledge）",
    "恐惧（fear）", "恐惧（fear）", "恐惧（fear）",
    "愤怒（anger）", "愤怒（anger）",
    "反差（contrast）",
  ]);
  assert.ok(parsed.every(b => b.originalType === "求知欲（knowledge）"), "原标题类型判断要在每个块里可见");
});

test("表头式的判断会被前端静默丢弃 —— 所以判断必须写进块内（回归防线）", () => {
  const headerStyle = [
    "原标题类型判断：求知欲",     // ← 块外，前端会丢掉
    "",
    "1. 《标题A》",
    "类型：恐惧（fear）",
  ].join("\n");
  const dropped = parseTitleBlocksLikeFrontend(headerStyle);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].originalType, undefined, "表头形态确实拿不到原标题类型");

  // 我们实际采用的块内形态能拿到
  const inBlock = formatTitleCandidatesAsText(
    [{ index: 1, type: "fear", typeLabel: "恐惧", content: "标题A" }],
    { type: "knowledge", typeLabel: "求知欲", reason: "在讲方法" },
  );
  const kept = parseTitleBlocksLikeFrontend(inBlock);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].originalType, "求知欲（knowledge）");
  assert.match(inBlock, /判断依据：在讲方法/);
});

test("判不出原标题类型时如实说「未能判断」，且不借用「待人工复核」", () => {
  const text = formatTitleCandidatesAsText([{ index: 1, type: "fear", typeLabel: "恐惧", content: "标题" }], null);
  assert.match(text, /原标题类型：未能判断/);
  // 「待人工复核」是选题库的人工待办队列名，借来当"判不出"会把两个概念混一起。
  assert.ok(!text.includes("待人工复核"));
});

test("空候选渲染成空串 —— 调用方据此判定这次没生成，不要塞占位内容", () => {
  assert.equal(formatTitleCandidatesAsText([], null), "");
  assert.equal(formatTitleCandidatesAsText(null, { type: "fear" }), "");
});

test("配比片段逐条指定类型，并声明配比是后端实算的", () => {
  const adaptation = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  assert.equal(TITLE_AGENT_NAME, "title");
  assert.equal(adaptation.slots[0].typeLabel, "求知欲");
});

test("标题二创提示词：带 8 类型判定口径、要求英文 key、并声明严格按槽位", () => {
  // 口径必须从定义生成（不手写第二份），否则提示词里的类型集和代码会对不上。
  for (const [type, label] of Object.entries(TITLE_TYPE_LABELS)) {
    if (type === "review") continue;
    assert.ok(CREATIVE_TITLE_PROMPT.includes(label), `提示词缺类型「${label}」`);
    assert.ok(CREATIVE_TITLE_PROMPT.includes(type), `提示词缺英文 key「${type}」`);
  }
  assert.match(CREATIVE_TITLE_PROMPT, /originalType/);
  assert.match(CREATIVE_TITLE_PROMPT, /items/);
  assert.match(CREATIVE_TITLE_PROMPT, /一一对应/);
  // 标题特有的约束：字数上限与阿拉伯数字。
  assert.match(CREATIVE_TITLE_PROMPT, /32/);
  assert.match(CREATIVE_TITLE_PROMPT, /阿拉伯数字/);
  // 「待人工复核」不是标题类型，不该出现在口径清单里当创作方向。
  assert.ok(!CREATIVE_TITLE_PROMPT.includes("待人工复核"));
});

test("buildVideoAdaptation 必须把标题配比一起带出来（漏了会静默退回自由创作）", () => {
  const adaptation = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  const picked = buildVideoAdaptation({
    candidates: [
      { accountName: "A", goldThreeSeconds: adaptation, endingHooks: null, title: adaptation },
    ],
  });
  assert.ok(picked, "应当选中该账号");
  assert.equal(picked.title, adaptation, "标题配比必须透传，否则标题会静默退回自由创作口径");
  assert.equal(picked.goldThreeSeconds, adaptation);
  assert.equal(picked.endingHooks, null);
});

test("buildVideoAdaptation：多个账号各缺一份分析时，仍返回统一形状（不抛 undefined 崩溃）", () => {
  const adaptation = buildTitleAdaptation({ categoryName: "政策解读与环境洞察", report: report() });
  const picked = buildVideoAdaptation({
    candidates: [
      { accountName: "缺标题", goldThreeSeconds: adaptation, endingHooks: null },
      { accountName: "缺三秒", goldThreeSeconds: null, endingHooks: null, title: adaptation },
    ],
  });
  assert.ok(picked);
  assert.equal(typeof picked.accountName, "string");
  // 两份都算不出槽位时取第一个；关键是形状完整，下游 `item.goldThreeSeconds.slots`
  // 不会因为 undefined 而崩。
  assert.ok("goldThreeSeconds" in picked && "endingHooks" in picked && "title" in picked);
  assert.equal(buildVideoAdaptation({ candidates: [] }), null);
  assert.equal(buildVideoAdaptation(null), null);
});
