// 2.3 结尾钩子库分析：数据类型边界与归一化测试。
//
// 与 2.2 黄金三秒同构，但有一处**本质差别**：看的是视频**结尾**，所以
//   - 文案要取**末句**（2.2 取首句）；
//   - 结尾文案必须能在**结尾片段**的转写里核对上，否则退回 caption。
//
// 这些测试锁住四件事：
//   1. 不信任 Agent：只接受输入里已有的 videoId，条数与配比全部后端重算；
//   2. 结尾文案取末句，且「模型自称引用了转写」不算数，要真能在原文里找到；
//   3. 「待人工复核」不进配比；每个大类配比合计恰好 100；
//   4. 类型清单只有 5 个，中英文别名都能映射，认不出的落 review。
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeBenchmarkAnalysis } from "../api/_lib/benchmarkAnalysis.js";
import { buildGoldThreeSecondsInput } from "../api/_lib/goldThreeSeconds.js";
import {
  buildEndingHooksInput,
  buildHeuristicEndingHooks,
  normalizeEndingHooks,
  ENDING_HOOK_TYPES,
  ENDING_HOOK_TYPE_KEYS,
} from "../api/_lib/endingHooks.js";

const VIDEO = (id, likes, overrides = {}) => ({
  id,
  title: `标题${id}`,
  link: `https://www.douyin.com/video/${id}`,
  authorName: "作者",
  publishDate: "2026/09/10",
  sourceText: `发布文案${id}`,
  platform: "douyin",
  stats: { likes, comments: 2, shares: 3, bookmarks: 4 },
  ...overrides,
});

const classification = (videos, agentOutput) => normalizeBenchmarkAnalysis({
  contentStyle: "spoken",
  platform: "douyin",
  accountUrl: "https://www.douyin.com/user/test",
  accountName: "测试账号",
  videos,
  agentOutput,
  analysisSource: "agent",
});

const threeVideos = [VIDEO("v1", 300), VIDEO("v2", 200), VIDEO("v3", 100)];
const baseReport = (agentOutput = { categories: [{ name: "风险防御", videoIds: ["v1", "v2", "v3"] }] }) =>
  classification(threeVideos, agentOutput);

// ---------------------------------------------------------------------------
// 类型清单
// ---------------------------------------------------------------------------

test("结尾类型就是用户口径的 5 个，不多不少", () => {
  assert.deepEqual(ENDING_HOOK_TYPE_KEYS, ["interaction", "conversion", "twist", "punchline", "resonance_ip"]);
  const labels = ENDING_HOOK_TYPES.map(item => item.type && item.definition);
  assert.equal(labels.every(Boolean), true, "每个类型都必须有判定口径");
  const examples = ENDING_HOOK_TYPES.map(item => item.example);
  assert.equal(examples.every(Boolean), true, "每个类型都必须有例句");
});

// ---------------------------------------------------------------------------
// 取末句：与 2.2 取首句相反
// ---------------------------------------------------------------------------

test("没有模型文案时，结尾文案取转写的**最后一句**（不是第一句）", () => {
  const transcripts = new Map([["v1", {
    text: "大家好，今天我们聊聊用工风险。首先看第一个案例。记住，员工签字比民主程序更重要。",
    provider: "ffmpeg+doubao-asr:mp3+tail5s",
  }]]);
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    transcripts,
    agentOutput: { items: [{ videoId: "v1", type: "punchline", confidence: "medium" }] },
  });
  const item = report.items.find(entry => entry.videoId === "v1");
  assert.equal(item.endingText, "记住，员工签字比民主程序更重要。");
  assert.equal(item.endingSource, "transcript");
});

test("模型引用了转写原文 → 标 transcript 并沿用它的置信度", () => {
  const transcripts = new Map([["v1", { text: "前面讲了很多。记住，员工签字比民主程序更重要。", provider: "x" }]]);
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    transcripts,
    agentOutput: { items: [{ videoId: "v1", endingText: "记住 员工签字比民主程序更重要", type: "金句", confidence: "高" }] },
  });
  const item = report.items.find(entry => entry.videoId === "v1");
  assert.equal(item.endingSource, "transcript");
  assert.equal(item.confidence, "high", "「高」应被识别成 high");
});

test("模型自称引用了转写、但文案根本不在转写里 → 退回 caption 并压到 low", () => {
  const transcripts = new Map([["v1", { text: "前面讲了很多。记住，员工签字比民主程序更重要。", provider: "x" }]]);
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    transcripts,
    agentOutput: { items: [{ videoId: "v1", endingText: "想了解更多欢迎私信我", type: "conversion", confidence: "high" }] },
  });
  const item = report.items.find(entry => entry.videoId === "v1");
  assert.equal(item.endingSource, "caption");
  assert.equal(item.confidence, "low", "模型自称引用不算数，置信度必须压下来");
});

// ---------------------------------------------------------------------------
// 不信任 Agent
// ---------------------------------------------------------------------------

test("只接受输入里已有的 videoId，未知/重复的一律丢弃", () => {
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    agentOutput: {
      items: [
        { videoId: "v1", type: "金句" },
        { videoId: "v1", type: "反转" },
        { videoId: "NOT_IN_INPUT", type: "金句" },
      ],
    },
  });
  assert.equal(report.items.some(item => item.videoId === "NOT_IN_INPUT"), false);
  assert.equal(report.items.filter(item => item.videoId === "v1").length, 1);
});

test("模型漏掉的样本仍进报告，标待人工复核", () => {
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    agentOutput: { items: [{ videoId: "v1", type: "金句" }] },
  });
  assert.equal(report.items.length, 3);
  const missing = report.items.filter(item => item.videoId !== "v1");
  assert.equal(missing.every(item => item.type === "review"), true);
});

test("认不出的类型落到待人工复核，不猜", () => {
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    agentOutput: { items: [{ videoId: "v1", type: "某种没见过的类型" }] },
  });
  assert.equal(report.items.find(item => item.videoId === "v1").type, "review");
});

test("中英文别名都能映射到规范类型", () => {
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    agentOutput: {
      items: [
        { videoId: "v1", type: "引导互动" },
        { videoId: "v2", type: "conversion" },
        { videoId: "v3", type: "口头禅" },
      ],
    },
  });
  const byId = new Map(report.items.map(item => [item.videoId, item.type]));
  assert.equal(byId.get("v1"), "interaction");
  assert.equal(byId.get("v2"), "conversion");
  assert.equal(byId.get("v3"), "resonance_ip", "「口头禅」应归到共鸣＋IP符号");
});

// ---------------------------------------------------------------------------
// 配比：全部由后端统计
// ---------------------------------------------------------------------------

test("每个大类的配比合计恰好 100，且不采信模型填的百分比", () => {
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    agentOutput: {
      items: [
        { videoId: "v1", type: "金句", percentage: 90 },
        { videoId: "v2", type: "反转", percentage: 90 },
        { videoId: "v3", type: "引导互动", percentage: 90 },
      ],
    },
  });
  const category = report.categoryBreakdown[0];
  assert.equal(category.dimensions.reduce((sum, item) => sum + item.ratio, 0), 100);
  assert.equal(category.dimensions.every(item => item.ratio === 33 || item.ratio === 34), true, "应等权分配，而不是 90");
});

test("待人工复核不进配比，但条数如实标出来", () => {
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    agentOutput: {
      items: [
        { videoId: "v1", type: "金句" },
        { videoId: "v2", type: "无法判断的写法" },
        { videoId: "v3", type: "金句" },
      ],
    },
  });
  const category = report.categoryBreakdown[0];
  assert.equal(category.dimensions.length, 1);
  assert.equal(category.dimensions[0].ratio, 100, "只剩一个有效类型时它独占 100");
  assert.equal(category.reviewCount, 1);
  assert.equal(category.dimensions.some(item => item.type === "review"), false);
});

test("模型没给原因时如实留空，不编一句套话", () => {
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    agentOutput: {
      items: [{ videoId: "v1", type: "金句" }, { videoId: "v2", type: "反转" }, { videoId: "v3", type: "引导互动" }],
      categoryReasons: [{ categoryName: "风险防御", reasons: [{ type: "金句", reason: "合规内容靠一句结论收口" }] }],
    },
  });
  const dimensions = report.categoryBreakdown[0].dimensions;
  assert.equal(dimensions.find(item => item.type === "punchline").reason, "合规内容靠一句结论收口");
  assert.equal(dimensions.find(item => item.type === "twist").reason, "");
  assert.equal(dimensions.find(item => item.type === "interaction").reason, "");
});

test("大类配比带上分类报告的核心功能与判断关键词", () => {
  const report = normalizeEndingHooks({
    classificationReport: baseReport({ categories: [{ name: "风险防御", coreFunction: "从源头预防法律风险", keywords: ["员工手册", "民主程序"], videoIds: ["v1", "v2", "v3"] }] }),
    agentOutput: { items: [{ videoId: "v1", type: "金句" }] },
  });
  const category = report.categoryBreakdown[0];
  assert.equal(category.coreFunction, "从源头预防法律风险");
  assert.deepEqual(category.keywords, ["员工手册", "民主程序"]);
});

// ---------------------------------------------------------------------------
// 契约：与 2.2 吃同一批样本
// ---------------------------------------------------------------------------

test("取样窗口与 2.2 完全一致：同一份报告喂进去，两边拿到的样本和顺序都一样", () => {
  // 分类报告本身就是「最新 60 条」窗口（前端在抓取后截好的），所以这里给 60 条。
  const many = Array.from({ length: 60 }, (_, index) => VIDEO(`m${index}`, index));
  const report = classification(many, { categories: [{ name: "大类", videoIds: many.map(video => video.id) }] });

  const endingInput = buildEndingHooksInput(report);
  const goldInput = buildGoldThreeSecondsInput(report);

  assert.equal(endingInput.videos.length, 60, "全部样本都要进分析，不能只取前 N 条");
  assert.equal(endingInput.videos[0].videoId, "m59", "点赞最高的排最前");
  // 这条是真正的「共用口径」断言：两个子步骤的大类配比要能互相印证，样本必须先一致。
  assert.deepEqual(endingInput.videos.map(video => video.videoId), goldInput.videos.map(video => video.videoId));
  assert.deepEqual(endingInput.categories, goldInput.categories);
});

test("转写覆盖率如实反映结尾文案的来源", () => {
  const transcripts = new Map([["v1", { text: "结尾。", provider: "x" }]]);
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    transcripts,
    agentOutput: { items: [{ videoId: "v1", type: "金句" }, { videoId: "v2", type: "反转" }] },
  });
  assert.equal(report.transcriptCoverage.fromTranscript, 1);
  assert.equal(report.transcriptCoverage.fromCaption, 2, "v2 与 v3 都没有转写");
  assert.equal(report.transcriptCoverage.total, 3);
});

test("报告带上 5 个类型的判定口径，供前端直接渲染", () => {
  const report = normalizeEndingHooks({ classificationReport: baseReport(), agentOutput: {} });
  assert.equal(report.types.length, 5);
  assert.equal(report.types.every(item => item.definition && item.example), true);
});

test("规则兜底产出与 Agent 路径同形状的报告", () => {
  const report = normalizeEndingHooks({
    classificationReport: baseReport(),
    agentOutput: buildHeuristicEndingHooks(baseReport()),
    analysisSource: "heuristic",
  });
  assert.equal(report.reportType, "ending_hooks");
  assert.equal(report.items.length, 3);
  assert.equal(report.categoryBreakdown.length, 1);
  assert.equal(report.analysisSource, "heuristic");
});

// ---------------------------------------------------------------------------
// 提示词口径：锁定「配比 = 观测事实」这个已确认的语义
//
// 2026-09-17 用户拿导图确认过：**配比是该账号实际用出来的（统计观测），
// 不是模型建议的「应该怎么配」**。原因那一列解释的是「这类内容为什么用这种方式收尾」。
//
// 这个语义被误解过两次（措辞都像「筛选适配类型并配比」），所以用测试钉死：
// 后端统计的规则在 categoryTypeBreakdown，模型只给原因；提示词里也必须体现
// 「原因以大类为单位」+「不许编账号定位」。
// ---------------------------------------------------------------------------

test("结尾钩子提示词：5 个类型齐全、口径以大类为单位、禁止账号定位视角", async () => {
  const { ENDING_HOOKS_PROMPT } = await import("../api/_lib/contentAgent/prompts.js");
  for (const label of ["引导互动", "引导转化", "反转", "金句", "共鸣＋IP符号"]) {
    assert.match(ENDING_HOOKS_PROMPT, new RegExp(label), `提示词里缺少类型「${label}」`);
  }
  // 原因必须落在该大类自己的核心功能 / 判断关键词上
  assert.match(ENDING_HOOKS_PROMPT, /coreFunction/);
  assert.match(ENDING_HOOKS_PROMPT, /keywords/);
  // 用户明确要求解释「对用户的核心吸引力」
  assert.match(ENDING_HOOKS_PROMPT, /对用户的核心吸引力/);
  // 账号定位/人设定位/用户画像是模块 1.2 的活，不许在这里编
  assert.match(ENDING_HOOKS_PROMPT, /不要从账号定位/);
  // 结尾文案必须来自**结尾**片段的转写，不能拿开头或发布文案顶替
  assert.match(ENDING_HOOKS_PROMPT, /必须取自 transcript 的结尾原文/);
  assert.doesNotMatch(ENDING_HOOKS_PROMPT, /开场 3 秒/);
});

test("结尾钩子提示词：配比由后端统计，模型只给原因（不许自己填百分比）", async () => {
  const { ENDING_HOOKS_PROMPT } = await import("../api/_lib/contentAgent/prompts.js");
  assert.match(ENDING_HOOKS_PROMPT, /不要自己填百分比/);
  assert.match(ENDING_HOOKS_PROMPT, /后端会按你给每条样本的 type/);
  // 账号级汇总不能替代按大类的解释（§6.3⑬「所有大类一模一样」的复发口子）
  assert.match(ENDING_HOOKS_PROMPT, /不能替代第 4 条按大类的解释/);
});
