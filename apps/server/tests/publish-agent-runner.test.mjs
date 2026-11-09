import test from "node:test";
import assert from "node:assert/strict";

import {
  PUBLISH_PHASES,
  normalizePublishTopic,
  pickAccountPlanFields,
} from "../api/_lib/publishAgentRunner.js";
import {
  buildCoverRefinePrompt,
  buildPublishCopyInput,
  buildPublishCoverInput,
  buildPublishTagsInput,
} from "../api/_lib/contentAgent/publishAgents.js";
import { normalizePublishCopy, normalizeTopicTags } from "../api/_lib/publishWarehouse.js";

/**
 * 发布仓 Agent 编排层的契约测试。
 *
 * ⚠️ 全程**不调模型**（这里只测输入组装、phase 校验、归一化衔接）。
 *    真正调 DeepSeek 的那几个 runner 属于「必须真实验收」的范围（HANDOFF §0.3-H）。
 */

test("phase 清单与两套后端路由保持一致（含出图那个花钱的 phase）", () => {
  assert.deepEqual(PUBLISH_PHASES, [
    "cover-plan",
    // 封面基底第一步：拆解用户上传的对标封面图（视觉模型，不出图）。
    "cover-base-analysis",
    // 账号级：只按账号规划/人设定位出 IP 形象照的提示词（topic 传空，不被选题影响）。
    "cover-portrait-plan",
    // 标题样式的自然语言微调（用户聊天框里说怎么改，纯文本调用）。
    "cover-style-refine",
    // 纯计算（不调模型）：按基底标题样式给每个候选标题算字号与行数。
    "cover-title-metrics",
    "cover-image",
    // 对话式改图：以当前封面为参考图重新出图（迭代，必须带上一版）。
    "cover-refine-image",
    "publish-copy",
    "account-tags",
    "topic-tags",
  ]);
});

test("选题入参归一化：只留 Agent 用得到的字段，长文本截断", () => {
  const topic = normalizePublishTopic({
    topicId: "t1",
    title: "  超龄员工工伤保险  ",
    script: "x".repeat(20_000),
    categoryName: "政策解读与环境洞察",
    availableSubcategories: ["超龄用工", "", "工伤", ...Array(60).fill("凑数")],
    // 这些字段不该被带进 Agent 输入（无用且有泄漏风险）。
    rawData: { secret: "不该出现" },
    link: "https://www.douyin.com/video/1",
  });

  assert.equal(topic.topicId, "t1");
  assert.equal(topic.title, "超龄员工工伤保险");
  assert.equal(topic.script.length, 8000, "脚本截断到 8000 字");
  assert.equal(topic.availableSubcategories.length, 40, "小类清单截断");
  assert.deepEqual(topic.availableSubcategories.slice(0, 2), ["超龄用工", "工伤"]);
  assert.equal("rawData" in topic, false, "原始数据不进 Agent 输入");
  assert.equal("link" in topic, false);
});

test("封面输入带上选题 + 内容定位 + 对标封面素材；缺的部分不占位", () => {
  const input = buildPublishCoverInput({
    topic: { title: "标题", threeSeconds: "开场", script: "脚本", categoryName: "政策解读" },
    categoryContext: [{ name: "政策解读", coreFunction: "解读新规", keywords: ["超龄用工"] }],
  });
  assert.match(input, /这条选题/);
  assert.match(input, /政策解读/);
  assert.match(input, /超龄用工/);
  // 没给账号规划与对标封面时不应出现空标题块。
  assert.equal(input.includes("【账号规划】"), false);
  assert.equal(input.includes("【人工提供的对标封面素材或描述】"), false);
});

test("3.2 输入包含账号标签作为呼应，但不要求模型抄进文案", () => {
  const withTags = buildPublishCopyInput({ topic: { title: "T" }, accountTags: ["劳动法", "用工风险"] });
  assert.match(withTags, /恒定标签/);
  assert.match(withTags, /劳动法/);
  assert.match(withTags, /不要直接抄/);
  // 没标签时不该多出这一段。
  assert.equal(buildPublishCopyInput({ topic: { title: "T" } }).includes("恒定标签"), false);
});

test("3.3 两个 phase 的输入不同：account 给账号规划，topic 给这条选题与小类清单", () => {
  const account = buildPublishTagsInput({
    phase: "account",
    accountPlan: { 定位: "劳动法" },
    categoryContext: [{ name: "政策解读" }],
    referenceTags: ["劳动仲裁"],
  });
  assert.match(account, /任务 A：账号标签库/);
  assert.match(account, /劳动仲裁/);

  const topic = buildPublishTagsInput({
    phase: "topic",
    topic: { title: "超龄用工", script: "脚本正文", availableSubcategories: ["超龄用工", "工伤认定"] },
  });
  assert.match(topic, /任务 B：选题标签/);
  assert.match(topic, /脚本正文/);
  assert.match(topic, /工伤认定/);
  // topic 阶段不该混进账号标签库的要求。
  assert.equal(topic.includes("任务 A"), false);
});

test("★ 3.2 的「复用」是硬约束：标题与 3s 来自入参，模型缺哪类都不会让四类缺一块", () => {
  // 模型只回了金句 —— 四类仍然齐（标题/3s 由复用补上，互动如实为空）。
  const normalized = normalizePublishCopy(
    { punchline: ["金句一"] },
    { title: ["已确认的标题"], threeSeconds: ["已确认的 3 秒"] },
  );
  assert.equal(normalized.items.length, 4);
  const byKind = Object.fromEntries(normalized.items.map(item => [item.kind, item]));
  assert.deepEqual(byKind.title.options, ["已确认的标题"]);
  assert.equal(byKind.title.source, "reuse");
  assert.deepEqual(byKind.threeSeconds.options, ["已确认的 3 秒"]);
  // 互动没生成出来要如实说，不能假装有。
  assert.deepEqual(byKind.interaction.options, []);
  assert.ok(normalized.missing.includes("互动"));
});

test("★ 3.3 选题标签的配额由后端执行，模型多给也不会超", () => {
  const normalized = normalizeTopicTags({
    subcategory: ["小1", "小2", "小3", "小4"],
    coreContent: ["核心1", "核心2", "核心3"],
    audience: ["人群1", "人群2"],
  });
  assert.equal(normalized.tags.length, 5, "2 + 2 + 1 = 5");
  assert.deepEqual(normalized.groups.map(g => g.tags.length), [2, 2, 1]);
});

// ── 3.3 账号标签：账号规划（1.3）的字段提取 ─────────────────────────────────
//
// 用户 2026-09-21 拍板「3.3 账号标签文档直接开放权限」，所以三个角度改用 1.3 报告
// 作为**主来源**。这里钉住两件事：
//   ① 取的是**真实字段路径**（1.3 报告顶层就是各节正文，`sections` 只是键名数组）；
//   ② 认不出结构时退回整份摘要，而不是回 null 让 Agent 以为「没有账号规划」。

test("★ 账号规划字段提取走真实路径：顶层 ipPositioning / contentPositioning / personaPositioning", () => {
  const report = {
    version: "1.0",
    reportType: "account_plan",
    // ⚠️ 这一项是**键名数组**，不是正文。照它取会永远取到空 —— 单测专门钉住这一点。
    sections: ["ipPositioning", "accountSetup", "topicLibrary", "contentFramework", "production", "operations"],
    customer: { occupation: "劳动法律师", ipPositioning: "老板用工风险", contentNeeds: "讲清新规" },
    ipPositioning: {
      businessPositioning: { targetAudience: { text: "中小企业主" }, corePain: { text: "怕赔钱" } },
      contentPositioning: { core: { text: "政策解读与环境洞察" }, frequentTags: ["劳动法", "用工合规"] },
      personaPositioning: { role: { text: "严谨专业的劳动法律师" } },
    },
    topicLibrary: { topicTotal: 12 },
    // 与标签无关的章节，不该被带进 Agent 输入。
    accountSetup: { trio: { huge: "x".repeat(5000) } },
    production: { shooting: { items: ["无关"] } },
  };

  const picked = pickAccountPlanFields(report);
  assert.ok(picked, "必须取到内容");
  assert.match(picked.商业定位, /中小企业主/);
  assert.match(picked.商业定位, /怕赔钱/, "用户核心痛点来自 businessPositioning.corePain");
  assert.match(picked.内容定位, /政策解读与环境洞察/);
  assert.equal(picked.高频标签, JSON.stringify(["劳动法", "用工合规"]));
  assert.match(picked.人设定位, /劳动法律师/);
  assert.match(picked.客户诉求, /老板用工风险/);
  // ★ 与标签无关的大章节不该被带进来（省 token、少干扰）。
  assert.equal(JSON.stringify(picked).includes("无关"), false, "拍摄剪辑等无关章节不进 Agent 输入");
});

test("★ 账号规划的 sections 只是键名数组：照它取会得到空（回归钉子）", () => {
  const onlySections = { sections: ["ipPositioning", "topicLibrary"] };
  const picked = pickAccountPlanFields(onlySections);
  // 取不到具体字段时**退回整份摘要**（而不是回 null 假装没有账号规划）。
  assert.ok(picked, "认不出结构也要给一点上下文，不能回 null");
  assert.ok(Object.keys(picked).length > 0);
});

test("账号规划为空/形状不对时不崩，如实回 null", () => {
  assert.equal(pickAccountPlanFields(null), null);
  assert.equal(pickAccountPlanFields(undefined), null);
  assert.equal(pickAccountPlanFields("字符串"), null);
});

test("★ 对话改图的提示词：规则 + 上文 + 本次要求都要在内（否则模型会推倒重来）", () => {
  const prompt = buildCoverRefinePrompt({
    instruction: "标题再大一点",
    history: ["换成金色标题"],
    title: "企业用工风险三条红线",
    titleStyle: { color: "#ffd400", position: "top" },
  });
  assert.match(prompt, /只改用户明确提到的那部分/, "必须写明「只改提到的部分」");
  assert.match(prompt, /不要推倒重来/, "相对说法要基于上一版继续改");
  assert.match(prompt, /换成金色标题/, "要带上之前的调整记录");
  assert.match(prompt, /标题再大一点/, "要带上本次要求");
  assert.match(prompt, /企业用工风险三条红线/, "要带上标题作为「不要乱改」的锚点");
  assert.match(prompt, /#ffd400/, "要带上标题样式");
});

test("对话改图：没有上文时不留占位（不写「之前的调整记录」这种空块）", () => {
  const prompt = buildCoverRefinePrompt({ instruction: "背景换成蓝色" });
  assert.doesNotMatch(prompt, /之前的调整记录/);
  assert.match(prompt, /背景换成蓝色/);
});
