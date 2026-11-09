import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_TAG_ANGLES,
  ACCOUNT_TAG_CANDIDATES_PER_ANGLE,
  COVER_ANALYSIS_ANGLES,
  COVER_BACKGROUND_CANDIDATE_COUNT,
  PUBLISH_COPY_KINDS,
  TOPIC_TAG_QUOTA,
  buildPublishBundle,
  normalizeAccountTags,
  normalizeCoverPlan,
  normalizePublishCopy,
  normalizeTopicTags,
} from "../api/_lib/publishWarehouse.js";
import { PUBLISH_COVER_PROMPT, PUBLISH_COPY_PROMPT, PUBLISH_TAGS_PROMPT } from "../api/_lib/contentAgent/prompts.js";

/**
 * 发布仓归一化层的契约测试（3.1 封面 / 3.2 发布文案 / 3.3 发布标签）。
 *
 * 钉的都是「静默出错」那类：少给一个候选、把复用内容当成 AI 生成、
 * 缺额被套话补齐 —— 都不会抛异常，只会让用户拿到错的发布素材。
 */

test("3.2：四类发布文案齐全，且标题/3s 如实标成「复用」而不是 agent 生成", () => {
  const normalized = normalizePublishCopy(
    { punchline: ["金句甲", "金句乙"], interaction: ["互动甲"] },
    { title: ["原选题标题"], threeSeconds: ["原 3 秒开场"] },
  );

  assert.deepEqual(
    normalized.items.map(item => [item.kind, item.label]),
    [["punchline", "金句"], ["title", "标题"], ["threeSeconds", "3s"], ["interaction", "互动"]],
  );
  const byKind = Object.fromEntries(normalized.items.map(item => [item.kind, item]));
  // ★ 来源必须分得清：用户要能看出哪几句是 AI 写的、哪几句是复用已确认内容。
  assert.equal(byKind.punchline.source, "agent");
  assert.equal(byKind.interaction.source, "agent");
  assert.equal(byKind.title.source, "reuse");
  assert.equal(byKind.threeSeconds.source, "reuse");
  assert.deepEqual(byKind.title.options, ["原选题标题"]);
});

test("3.2：某一类一个字都没生成出来时，如实列进 missing（不静默少一块）", () => {
  const normalized = normalizePublishCopy({ punchline: ["只有金句"] }, { title: [], threeSeconds: [] });
  assert.deepEqual(normalized.missing, ["标题", "3s", "互动"]);
  // 有内容的类不进 missing。
  assert.equal(normalized.missing.includes("金句"), false);
});

test("3.2：每类最多 4 句，且去重（模型爱把同一句换个说法重复给）", () => {
  const normalized = normalizePublishCopy(
    { punchline: ["一", "一", "二", "三", "四", "五", "六"] },
    { title: ["A", "B", "C", "D", "E"] },
  );
  const byKind = Object.fromEntries(normalized.items.map(item => [item.kind, item]));
  assert.deepEqual(byKind.punchline.options, ["一", "二", "三", "四"], "去重后截到 4 句");
  assert.deepEqual(byKind.title.options, ["A", "B", "C", "D"], "复用来的也截到 4");
});

test("3.3 账号标签：三个角度各 2 候选，角度清单来自唯一定义", () => {
  const normalized = normalizeAccountTags({
    track: ["劳动法", "用工合规", "多余候选"],
    painPoint: ["怕赔钱", "不懂新规"],
    positioning: ["用工风险"],
    referenceTags: ["劳动仲裁", "劳动仲裁"],
  });

  assert.deepEqual(normalized.angles.map(a => a.key), ACCOUNT_TAG_ANGLES.map(a => a.key));
  assert.deepEqual(normalized.angles.map(a => a.label), ["细分赛道", "用户核心痛点", "内容核心定位"]);
  // 截到每角度 2 个（文档：各生成 2 个，人工确认 1 个）。
  assert.deepEqual(normalized.angles[0].candidates, ["劳动法", "用工合规"]);
  assert.equal(normalized.angles[0].candidates.length, ACCOUNT_TAG_CANDIDATES_PER_ANGLE);
  assert.deepEqual(normalized.angles[1].candidates, ["怕赔钱", "不懂新规"]);
  assert.deepEqual(normalized.referenceTags, ["劳动仲裁"], "参考标签去重");
});

test("3.3 选题标签：严格按小类x2 + 脚本核心内容x2 + 目标用户x1 落位", () => {
  const normalized = normalizeTopicTags({
    subcategory: ["超龄用工", "工伤认定", "第三个"],
    coreContent: ["超龄员工工伤保险怎么买", "113万赔偿案例"],
    audience: ["中小企业主", "多余的"],
  });

  assert.deepEqual(
    normalized.groups.map(group => [group.key, group.quota, group.tags.length]),
    [
      ["subcategory", TOPIC_TAG_QUOTA.subcategory, 2],
      ["coreContent", TOPIC_TAG_QUOTA.coreContent, 2],
      ["audience", TOPIC_TAG_QUOTA.audience, 1],
    ],
  );
  // 配额被真的执行了（超出的第 3 个 / 第 2 个不要）。
  assert.deepEqual(normalized.groups[0].tags, ["超龄用工", "工伤认定"]);
  assert.deepEqual(normalized.groups[2].tags, ["中小企业主"]);
  assert.deepEqual(normalized.missing, []);
});

test("3.3 选题标签：凑不够配额时如实报缺额，绝不用套话补齐", () => {
  const normalized = normalizeTopicTags({ subcategory: ["超龄用工"], coreContent: [], audience: ["中小企业主"] });
  // 顺序按文档口径：小类 → 脚本核心内容 → 目标用户。
  assert.deepEqual(normalized.missing, ["小类 1/2", "脚本核心内容 0/2"]);
  // 缺就是缺：不许凭空补一个「用工风险」上去。
  assert.equal(normalized.tags.length, 2);
});

test("3.1 封面：对标封面拆解四个角度齐全，缺的如实留空", () => {
  const plan = normalizeCoverPlan({
    backgroundAnalysis: { artStyle: "扁平插画", elements: "人物+文件", layout: "左文右图" },
    ipPortrait: { outfitScene: "西装办公室", expressionAction: "严肃", prompt: "整段提示词", basis: "内容定位=劳动法" },
  });

  assert.deepEqual(plan.backgroundAnalysis && Object.keys(plan.backgroundAnalysis).filter(k => COVER_ANALYSIS_ANGLES.some(a => a.key === k)),
    COVER_ANALYSIS_ANGLES.map(a => a.key));
  // 没给 visualStyle 就留空 —— 不编一个「高级感」上去。
  assert.equal(plan.backgroundAnalysis.visualStyle, "");
  assert.equal(plan.ipPortrait.outfitScene, "西装办公室");
  assert.equal(plan.ipPortrait.basis, "内容定位=劳动法");
});

test("3.1 封面：背景候选截到上限、无提示词的丢弃、关键词保留", () => {
  const plan = normalizeCoverPlan({
    backgrounds: [
      { title: "车间", keywords: ["超龄", "赔偿"], prompt: "车间背景，右侧留白", reservedAreas: ["右侧"] },
      { title: "缺提示词" },
      { title: "办公室", prompt: "办公室背景" },
      { title: "三", prompt: "p3" },
      { title: "四", prompt: "p4" },
      { title: "五", prompt: "p5" },
    ],
  });

  assert.equal(plan.backgrounds.length, COVER_BACKGROUND_CANDIDATE_COUNT, `最多 ${COVER_BACKGROUND_CANDIDATE_COUNT} 个候选`);
  // 没有提示词的条目直接丢（出不了图，留着只会让用户点了没反应）。
  assert.equal(plan.backgrounds.some(item => item.title === "缺提示词"), false);
  assert.deepEqual(plan.backgrounds[0].keywords, ["超龄", "赔偿"]);
  assert.deepEqual(plan.backgrounds[0].reservedAreas, ["右侧"]);
  assert.deepEqual(plan.backgrounds.map(item => item.id), ["bg-1", "bg-2", "bg-3", "bg-4"]);
});

test("3.1 封面：标题样式的 position 只认合法值，认不出的回落 bottom", () => {
  const ok = normalizeCoverPlan({ titleStyle: { position: "top", fontFamily: "思源黑体", color: "#fff" } });
  assert.equal(ok.titleStyle.position, "top");
  const bad = normalizeCoverPlan({ titleStyle: { position: "左上角斜着" } });
  assert.equal(bad.titleStyle.position, "bottom", "野值不能透给前端预览");
});

test("3.1 封面：空输入不崩、也不编造", () => {
  const plan = normalizeCoverPlan(null);
  assert.equal(plan.ipPortrait.prompt, "");
  assert.equal(plan.ipPortrait.outfitScene, "");
  assert.deepEqual(plan.backgrounds, []);
  assert.equal(plan.backgrounds.length, 0);
});

test("整条发布仓文本：文案 + 账号标签 + 选题标签拼成可直接粘贴的文本", () => {
  const bundle = buildPublishBundle({
    cover: { url: "https://cdn.test/cover.png" },
    publishCopy: ["金句一句", "原选题标题"],
    accountTags: ["劳动法", "怕赔钱", "用工风险"],
    topicTags: ["超龄用工", "#工伤认定"],
  });

  assert.deepEqual(bundle.tags, ["劳动法", "怕赔钱", "用工风险", "超龄用工", "#工伤认定"]);
  assert.match(bundle.text, /金句一句\n原选题标题/);
  // 标签统一带 #（已是 # 开头的不重复加）。
  assert.match(bundle.text, /#劳动法 #怕赔钱 #用工风险 #超龄用工 #工伤认定/);
  assert.equal(bundle.cover.url, "https://cdn.test/cover.png");
});

test("整条发布仓文本：没选任何东西时回空串，不产出半截脏文本", () => {
  const bundle = buildPublishBundle({});
  assert.equal(bundle.text, "");
  assert.deepEqual(bundle.tags, []);
  assert.deepEqual(bundle.copy, []);
});

test("三个提示词的清单从唯一定义派生，且各自只讲自己那份配额", () => {
  // §6.3⑫：清单只能从 publishWarehouse.js 的定义生成，别在两处各写一份。
  assert.deepEqual(PUBLISH_COPY_KINDS.filter(k => k.fromAgent).map(k => k.key), ["punchline", "interaction"]);
  for (const angle of COVER_ANALYSIS_ANGLES) assert.match(PUBLISH_COVER_PROMPT, new RegExp(angle.label));
  assert.match(PUBLISH_COVER_PROMPT, new RegExp(String(COVER_BACKGROUND_CANDIDATE_COUNT)));
  // 封面提示词必须要求「关键词在背景中有所体现」（文档明确要求）。
  assert.match(PUBLISH_COVER_PROMPT, /关键词.*必须.*体现/);
  // 文案提示词必须说明标题/3s 不用生成。
  assert.match(PUBLISH_COPY_PROMPT, /不必生成/);
  for (const angle of ACCOUNT_TAG_ANGLES) assert.match(PUBLISH_TAGS_PROMPT, new RegExp(angle.label));
  assert.match(PUBLISH_TAGS_PROMPT, new RegExp(`x${TOPIC_TAG_QUOTA.subcategory}`));
});
