import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_LIKES_CEILING,
  TOPIC_MIN_LIKES,
  parseMinLikes,
  TRANSCRIPT_MAX_DAYS,
  attachContent,
  filterByLikes,
  shouldExtractTranscripts,
  transcribableVideos,
} from "../../web/src/app/topicContentRules.ts";

/**
 * 「今日选题」的点赞门槛、脚本提取范围、以及「脚本要跟着勾选走到二创」的契约。
 *
 * 用户口径（2026-09-28 修订）：
 *   · 列表只保留**`likes >= 门槛`**（填 100 时 100 算达标）—— **门槛可由用户自定义**，
 *     默认 100。原来口径是严格大于（100 不达标），2026-09-28 按用户要求改成大于等于；
 *     同时后端业务下界从 100 放开到 0（否则填 50 会被静默夹成 100）；
 *   · **近 7 天**才语音提取完整脚本，15 天及以上只筛点赞 + 打标签；
 *   · 脚本要能在下一步二创直接复用，不必再提取。
 */

const topic = (id, likes) => ({ id, title: `标题 ${id}`, stats: { likes } });

const content = extra => ({
  script: "真实口播脚本", scriptSource: "transcript",
  categoryName: "风险防御", subcategoryName: "合同实操", categoryId: "c1", confidence: "high", basis: "",
  ...extra,
});

test("点赞门槛是大于等于：100 算达标、99 不达标", () => {
  assert.equal(TOPIC_MIN_LIKES, 100);
  assert.deepEqual(
    filterByLikes([topic("a", 100), topic("b", 101), topic("c", 99)]).map(t => t.id),
    ["a", "b"],
  );
});

test("门槛可自定义：填 0 时缺失/非法点赞（归一化成 0）也会被纳入", () => {
  // 🔴 这条是"门槛填 0"的**有意行为**，不是漏判：0 >= 0 成立。
  //    低赞/新号的内容本来就没赞，用户主动填 0 就是想看它们。
  //    非法值 "abc" 也归一化成 0（与后端 asNumber 同口径）—— 否则 `NaN >= 0` 是 false，
  //    会出现"前端挡住、后端放行"的两套结果。
  assert.deepEqual(
    filterByLikes([{ id: "a", stats: {} }, { id: "b", stats: { likes: "abc" } }, topic("c", 0), topic("d", 500)], 0).map(t => t.id),
    ["a", "b", "c", "d"],
  );
  // 填 1 时它们才被挡掉
  assert.deepEqual(
    filterByLikes([{ id: "a", stats: {} }, topic("c", 0), topic("d", 500)], 1).map(t => t.id),
    ["d"],
  );
});

test("未传门槛时用默认值 100（不是 0）", () => {
  assert.deepEqual(filterByLikes([topic("a", 100), topic("b", 99)]).map(t => t.id), ["a"]);
});

test("只有近 7 天（含）才提取完整脚本", () => {
  assert.equal(TRANSCRIPT_MAX_DAYS, 7);
  for (const d of [1, 3, 7]) assert.equal(shouldExtractTranscripts(d), true, `${d} 天应提取`);
  for (const d of [8, 15, 30, 90, 365]) assert.equal(shouldExtractTranscripts(d), false, `${d} 天不应提取`);
});

test("★ 脚本与标签挂到 topic 上，才能跟着勾选进 sessionStorage 交给二创", () => {
  const topics = [topic("a", 500), topic("b", 600)];
  const attached = attachContent(topics, { a: content({}) });

  assert.equal(attached[0].content.script, "真实口播脚本");
  assert.equal(attached[0].content.categoryName, "风险防御");
  // 没有分析结果的条目保持原样，不硬塞空 content。
  assert.equal("content" in attached[1], false);
  // 原对象不能被改（React state 里还有别的引用）。
  assert.equal("content" in topics[0], false);
});

test("★ 序列化再反序列化后脚本与标签仍在（二创不用重新提取）", () => {
  const attached = attachContent([topic("a", 500)], { a: content({}) });
  const roundTripped = JSON.parse(JSON.stringify(attached));
  assert.equal(roundTripped[0].content.script, "真实口播脚本");
  assert.equal(roundTripped[0].content.subcategoryName, "合同实操");
});

test("转写只送有 id + 链接的条目 —— 缺标题不能把条目丢掉", () => {
  // ⚠️ 2026-09-24 改口径：这里原来还要求 `title`，但**后端从不要求**。
  // `normalizeTopicRefreshVideos` 明确放行「无描述发布」（抖音允许），
  // 前端过滤比后端严 → 条目在到达后端之前就被静默丢掉，症状是「少分析了几条
  // 却看不出原因」。标题只是给打标签当上下文，界面早有「（无标题）」兜底。
  const videos = transcribableVideos([
    { id: "a", title: "有链接", link: "https://d/1", stats: { likes: 500 } },
    { id: "b", title: "没链接", link: "", stats: { likes: 500 } },
    { id: "c", title: "", link: "https://d/3", stats: { likes: 500 } },
    { id: "", title: "没 id", link: "https://d/4", stats: { likes: 500 } },
  ]);
  assert.deepEqual(videos.map(v => v.id), ["a", "c"]);
  assert.equal(videos[0].stats.likes, 500);
});

// ── 自定义点赞门槛的解析（2026-09-28）──────────────────────────────────
// 🔴 核心纪律：**不做静默夹取**。后端原来是 Math.max(下界, 传入值)，
//    前端填 50 会被悄悄夹成 100 —— 界面显示 50、实际按 100 过滤，且不报错。
//    "显示与实际不一致"比直接报错难查得多，所以越界一律报错。

test("parseMinLikes：合法值直接采纳（含 0）", () => {
  assert.deepEqual(parseMinLikes("0"), { ok: true, value: 0, error: "" });
  assert.deepEqual(parseMinLikes("50"), { ok: true, value: 50, error: "" });
  assert.deepEqual(parseMinLikes(500), { ok: true, value: 500, error: "" });
  // 输入框清空是常见操作 → 回落到默认值，不是当成 0
  assert.equal(parseMinLikes("").ok, true);
  assert.equal(parseMinLikes("").value, TOPIC_MIN_LIKES);
  assert.equal(parseMinLikes("   ").ok, true);
});

test("parseMinLikes：非法输入明确报错，绝不静默夹取", () => {
  for (const bad of ["abc", "1.5", "-1", "1e3", "１００"]) {
    const result = parseMinLikes(bad);
    assert.equal(result.ok, false, `「${bad}」应当被拒`);
    assert.ok(result.error, "必须给出可读的错误说明");
  }
  // 上界只是防手滑（填天文数字等于把列表清空）
  assert.equal(parseMinLikes(String(MIN_LIKES_CEILING + 1)).ok, false);
  assert.equal(parseMinLikes(String(MIN_LIKES_CEILING)).ok, true);
});

test("parseMinLikes：0 是合法门槛，不能被当成「没填」而回落默认值", () => {
  // 这条是本次改动的核心：0 与「空」必须区分开
  const zero = parseMinLikes("0");
  assert.equal(zero.ok, true);
  assert.equal(zero.value, 0, "填 0 就该是 0（不限点赞），不能变成默认 100");
  assert.notEqual(zero.value, TOPIC_MIN_LIKES);
});
