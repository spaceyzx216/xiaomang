import test from "node:test";
import assert from "node:assert/strict";

import {
  ENGAGEMENT_METRIC_CATALOG,
  PLAY_BUCKETS,
  REVIEW_STRUCTURES,
  STRUCTURE_METRIC_PRIORITY,
  buildStructureDirections,
  classifyPlayBucket,
  computeDerivedMetrics,
  describeWeights,
  formatThreshold,
  judgeVideoMetrics,
  metricRulesForPlatform,
  metricsForPlatform,
  normalizeMetrics,
  normalizeReviewPlatform,
  toNumber,
  suggestColumnMapping,
  toPercent,
  toRate,
} from "../api/_lib/reviewMetrics.js";

/**
 * 复盘分析（模块 4）的指标口径与阈值判定。
 *
 * 这一份是**用户给的规则表**的唯一实现。测试的写法刻意分成两类：
 *   1. 口径测试：把用户原话里的每个数字钉住（>5% 优秀、<25% 要调 3s 和标题…）；
 *   2. 边界测试：**恰好等于阈值时**归属哪一档 —— 用户的表用的是严格不等号，
 *      这一条最容易在实现里被写成 `>=` 而悄悄改变口径。
 */

// ── 归一化：同一列在 Excel 里可能是小数、百分数、带 % 的字符串 ─────────────

test("toRate 认三种写法：0.32 / 32 / \"32%\" 都是同一个 32%", () => {
  // 🔴 这是最重要的一条：Excel 里百分比列的写法取决于单元格格式，
  //    认不出来就会把「完播率 32%」读成 0.32%，整份报告全错却不报错。
  for (const value of [0.32, 32, "32%", "0.32", " 32 % "]) {
    assert.equal(toRate(value), 0.32, `输入 ${JSON.stringify(value)} 应归一化为 0.32`);
  }
});

test("toRate 对取不到的值返回 null，不返回 0", () => {
  // 「没给」与「给了 0」必须区分开（本项目踩过 asNumber(undefined)===0 的坑）。
  for (const value of [undefined, null, "", "  ", "abc", "--"]) {
    assert.equal(toRate(value), null, `输入 ${JSON.stringify(value)} 应为 null`);
  }
  assert.equal(toRate(0), 0);
});

test("toRate 不夹取越界值：>100% 原样返回，交给判定层标可疑", () => {
  assert.equal(toRate(150), 1.5);
  assert.equal(toRate("150%"), 1.5);
});

test("toNumber 认千分位与「万 / w」", () => {
  assert.equal(toNumber("1,234"), 1234);
  assert.equal(toNumber("1.2万"), 12000);
  assert.equal(toNumber("3.4w"), 34000);
  assert.equal(toNumber(0), 0);
  assert.equal(toNumber(""), null);
  assert.equal(toNumber("abc"), null);
});

test("toPercent 保留一位小数", () => {
  assert.equal(toPercent(0.3167), 31.7);
  assert.equal(toPercent(0.5), 50);
  assert.equal(toPercent(null), null);
});

// ── 平台差异 ──────────────────────────────────────────────────────────────

test("平台指标集不同：抖音有 2s跳出率/5s完播率/收藏，视频号是 3秒以上播放率/红心", () => {
  const douyin = metricsForPlatform("douyin").map(item => item.key);
  const wechat = metricsForPlatform("wechat_channels").map(item => item.key);

  assert.ok(douyin.includes("bounce2sRate"));
  assert.ok(douyin.includes("completion5sRate"));
  assert.ok(douyin.includes("bookmarks"));
  assert.ok(!douyin.includes("play3sRate"));
  assert.ok(!douyin.includes("recommends"));

  assert.ok(wechat.includes("play3sRate"));
  assert.ok(wechat.includes("recommends"));
  assert.ok(!wechat.includes("bounce2sRate"));
  assert.ok(!wechat.includes("completion5sRate"));
  assert.ok(!wechat.includes("bookmarks"));
});

test("normalizeReviewPlatform 把常见写法都收敛到两个平台", () => {
  for (const value of ["wechat_channels", "wechat", "channels", "视频号", "WX"]) {
    assert.equal(normalizeReviewPlatform(value), "wechat_channels");
  }
  for (const value of ["douyin", "抖音", "", undefined, "tiktok"]) {
    assert.equal(normalizeReviewPlatform(value), "douyin");
  }
});

// ── 阈值：把用户原话里的每个数字钉住 ────────────────────────────────────

/**
 * 判定入口：给**原始指标**，取出某一个指标的判定结果。
 *
 * 🔴 注意互动率与平均播放率是**派生量**，由后端公式实算 —— 想测互动率必须给
 *    「四项互动 + 播放量」，直接塞一个 `interactionRate` 会被实算结果覆盖。
 *    这是有意的设计（派生量不许被外部覆盖），下面有一条测试专门钉它。
 */
const judgeRaw = (platform, raw, metricKey) => {
  const { judgments } = judgeVideoMetrics({ platform, metrics: raw });
  const found = judgments.find(item => item.metric === metricKey);
  assert.ok(found, `${platform} 应有 ${metricKey} 这条规则`);
  return found;
};

/** 构造一个「互动率恰好等于 rate」的原始指标组。 */
const withInteraction = (rate, platform = "douyin") => ({
  plays: 1000,
  likes: rate * 1000,
  comments: 0,
  shares: 0,
  ...(platform === "wechat_channels" ? { recommends: 0 } : { bookmarks: 0 }),
});

test("抖音互动率：>5% 优秀 / <3% 需要优化 / 中间是未定义的「正常」", () => {
  assert.equal(judgeRaw("douyin", withInteraction(0.06), "interactionRate").level, "good");
  assert.equal(judgeRaw("douyin", withInteraction(0.02), "interactionRate").level, "bad");
  // 用户只给了两条线，中间档**不替用户编标准**。
  assert.equal(judgeRaw("douyin", withInteraction(0.04), "interactionRate").level, "watch");
});

test("互动率按各平台自己的四项算：抖音含收藏、视频号含红心", () => {
  // 抖音：只给收藏、不给红心 → 计入分子
  assert.equal(judgeRaw("douyin", { plays: 1000, likes: 0, comments: 0, shares: 0, bookmarks: 60, recommends: 999 }, "interactionRate").value, 0.06);
  // 视频号：红心计入、收藏不计入
  assert.equal(judgeRaw("wechat_channels", { plays: 1000, likes: 0, comments: 0, shares: 0, recommends: 60, bookmarks: 999 }, "interactionRate").value, 0.06);
});

test("互动率偏低要同时调整「选题内容」与「结尾钩子类型」（用户口径）", () => {
  for (const platform of ["douyin", "wechat_channels"]) {
    const item = judgeRaw(platform, withInteraction(0.02, platform), "interactionRate");
    assert.deepEqual(item.affects, ["topicType", "endingHook"], `${platform} 的互动率应同时影响选题与结尾钩子`);
    assert.equal(item.conclusion, "优化调整选题内容、结尾钩子类型，增加互动");
  }
});

test("派生量不允许被入参覆盖：直接传 interactionRate 无效，以后端实算为准", () => {
  const item = judgeRaw("douyin", { plays: 1000, likes: 10, comments: 0, shares: 0, bookmarks: 0, interactionRate: 0.99 }, "interactionRate");
  assert.equal(item.value, 0.01);
  assert.equal(item.level, "bad");
});

test("抖音 5s完播率：>50% 优秀 / <25% 要「调整 3s 和标题」", () => {
  const good = judgeRaw("douyin", { completion5sRate: 0.6 }, "completion5sRate");
  assert.equal(good.level, "good");
  assert.equal(good.conclusion, "3s 和标题类型优秀");

  const bad = judgeRaw("douyin", { completion5sRate: 0.2 }, "completion5sRate");
  assert.equal(bad.level, "bad");
  assert.equal(bad.conclusion, "调整 3s 和标题");
  assert.deepEqual(bad.affects, ["goldThreeSeconds", "title"]);
});

test("抖音 2s跳出率是「越小越好」：<20% 优秀 / >50% 要优化 —— 方向不能写反", () => {
  assert.equal(judgeRaw("douyin", { bounce2sRate: 0.15 }, "bounce2sRate").level, "good");
  assert.equal(judgeRaw("douyin", { bounce2sRate: 0.6 }, "bounce2sRate").level, "bad");
  assert.equal(judgeRaw("douyin", { bounce2sRate: 0.35 }, "bounce2sRate").level, "watch");
});

test("抖音完播率：>30% 优秀 / <15% 要「调整选题类型」", () => {
  assert.equal(judgeRaw("douyin", { completionRate: 0.32 }, "completionRate").level, "good");
  assert.equal(judgeRaw("douyin", { completionRate: 0.1 }, "completionRate").level, "bad");
});

test("视频号 3秒以上播放率：<60% 要调 3s 和标题 / >70% 优秀", () => {
  assert.equal(judgeRaw("wechat_channels", { play3sRate: 0.75 }, "play3sRate").level, "good");
  assert.equal(judgeRaw("wechat_channels", { play3sRate: 0.5 }, "play3sRate").level, "bad");
  assert.equal(judgeRaw("wechat_channels", { play3sRate: 0.65 }, "play3sRate").level, "watch");
});

test("平均播放率由 平均播放时长/视频时长 实算，阈值 >30% 优秀 / <15% 要优化", () => {
  assert.equal(judgeRaw("douyin", { avgPlaySeconds: 40, durationSeconds: 100 }, "avgPlayRate").level, "good");
  assert.equal(judgeRaw("douyin", { avgPlaySeconds: 10, durationSeconds: 100 }, "avgPlayRate").level, "bad");
  assert.equal(judgeRaw("douyin", { avgPlaySeconds: 20, durationSeconds: 100 }, "avgPlayRate").level, "watch");
});

test("🔴 视频号的完播率同时影响「结尾钩子」，抖音不是 —— 两套口径不能合并", () => {
  const wechat = judgeRaw("wechat_channels", { completionRate: 0.1 }, "completionRate");
  assert.deepEqual(wechat.affects, ["topicType", "endingHook"]);
  assert.equal(wechat.conclusion, "调整选题类型、结尾钩子，内容不够有吸引");

  const douyin = judgeRaw("douyin", { completionRate: 0.1 }, "completionRate");
  assert.deepEqual(douyin.affects, ["topicType"]);
  assert.equal(douyin.conclusion, "调整选题类型，内容不够有吸引");
});

test("恰好等于阈值时归入「正常」——用户用的是严格不等号", () => {
  // 实现若写成 >= 会在这里红。这是口径最容易悄悄发生变化的地方。
  assert.equal(judgeRaw("douyin", withInteraction(0.05), "interactionRate").level, "watch");
  assert.equal(judgeRaw("douyin", withInteraction(0.03), "interactionRate").level, "watch");
  assert.equal(judgeRaw("douyin", { completion5sRate: 0.5 }, "completion5sRate").level, "watch");
  assert.equal(judgeRaw("douyin", { completion5sRate: 0.25 }, "completion5sRate").level, "watch");
  assert.equal(judgeRaw("douyin", { bounce2sRate: 0.2 }, "bounce2sRate").level, "watch");
  assert.equal(judgeRaw("douyin", { bounce2sRate: 0.5 }, "bounce2sRate").level, "watch");
});

test("数据缺失如实标「数据缺失」，不拿 0 去下结论", () => {
  const item = judgeRaw("douyin", {}, "bounce2sRate");
  assert.equal(item.level, "missing");
  assert.equal(item.value, null);
  assert.match(item.conclusion, /数据缺失/);
});

test("比率越界标「数据可疑」，不夹取、不硬判", () => {
  const item = judgeRaw("douyin", { completionRate: 1.5 }, "completionRate");
  assert.equal(item.level, "suspicious");
  assert.match(item.conclusion, /核对/);
});

// ── 派生指标实算 ─────────────────────────────────────────────────────────

test("互动率分母是播放量；抖音四项、视频号四项，各有各的组成", () => {
  const douyin = computeDerivedMetrics({
    platform: "douyin",
    metrics: { likes: 830, comments: 96, shares: 210, bookmarks: 340, recommends: 999, plays: 12500 },
  });
  // 抖音不含红心
  assert.equal(douyin.engagementTotal, 830 + 96 + 210 + 340);
  assert.equal(douyin.interactionRate, (830 + 96 + 210 + 340) / 12500);

  const wechat = computeDerivedMetrics({
    platform: "wechat_channels",
    metrics: { likes: 830, comments: 96, shares: 210, recommends: 340, bookmarks: 999, plays: 12500 },
  });
  // 视频号不含收藏
  assert.equal(wechat.engagementTotal, 830 + 96 + 210 + 340);
});

test("任一互动项缺失时互动率给 null，不用「缺项当 0」算出一个偏低的假值", () => {
  const result = computeDerivedMetrics({
    platform: "douyin",
    metrics: { likes: 830, comments: 96, shares: 210, plays: 12500 },
  });
  assert.equal(result.engagementTotal, null);
  assert.equal(result.interactionRate, null);
});

test("平均播放率 = 平均播放时长 / 视频时长；分母为 0 给 null 而不是 Infinity", () => {
  assert.equal(
    computeDerivedMetrics({ platform: "douyin", metrics: { avgPlaySeconds: 42.5, durationSeconds: 118 } }).avgPlayRate,
    42.5 / 118,
  );
  assert.equal(
    computeDerivedMetrics({ platform: "douyin", metrics: { avgPlaySeconds: 42.5, durationSeconds: 0 } }).avgPlayRate,
    null,
  );
});

test("normalizeMetrics 把缺失与可疑如实报出来", () => {
  const result = normalizeMetrics({
    platform: "douyin",
    raw: { likes: 830, comments: "96", shares: null, bookmarks: 340, plays: "1.25万", durationSeconds: 118, avgPlaySeconds: 42.5, completionRate: "32%", bounce2sRate: 0.18, completion5sRate: "150%" },
  });
  assert.equal(result.metrics.plays, 12500);
  assert.equal(result.metrics.completionRate, 0.32);
  assert.equal(result.metrics.completion5sRate, 1.5);
  assert.deepEqual(result.missing, ["shares"]);
  assert.deepEqual(result.suspicious, ["completion5sRate"]);
  // 「关注」不参与任何判定公式，缺失它只影响权重展示 —— 单列出来，不混进 missing 制造噪声。
  assert.deepEqual(result.optionalMissing, ["follows"]);
});

// ── 逐结构的优化方向 ──────────────────────────────────────────────────────

test("四大结构的指标优先级照录用户口径", () => {
  assert.deepEqual(STRUCTURE_METRIC_PRIORITY.douyin.topicType, ["completionRate", "avgPlayRate", "interactionRate"]);
  assert.deepEqual(STRUCTURE_METRIC_PRIORITY.douyin.goldThreeSeconds, ["bounce2sRate", "completion5sRate"]);
  // 标题与 3s 用同一组指标 —— 与「标题类型就是三秒那 8 个类型」的设计决定一致。
  assert.deepEqual(STRUCTURE_METRIC_PRIORITY.douyin.title, STRUCTURE_METRIC_PRIORITY.douyin.goldThreeSeconds);
  assert.deepEqual(STRUCTURE_METRIC_PRIORITY.douyin.endingHook, ["completionRate", "interactionRate"]);
  assert.deepEqual(STRUCTURE_METRIC_PRIORITY.wechat_channels.goldThreeSeconds, ["play3sRate"]);
});

test("有任一指标触发优化线 ⇒ 该结构判「需要优化」，并写明是哪个指标触发的", () => {
  // 5s完播率 20%（bad），2s跳出率 15%（good）→ 3s 与标题都应是「需要优化」
  const { judgments } = judgeVideoMetrics({
    platform: "douyin",
    metrics: { likes: 100, comments: 10, shares: 10, bookmarks: 10, plays: 1000, completion5sRate: 0.2, bounce2sRate: 0.15, completionRate: 0.32, avgPlaySeconds: 40, durationSeconds: 100 },
  });
  const directions = buildStructureDirections({ platform: "douyin", judgments });
  const gold = directions.find(item => item.key === "goldThreeSeconds");
  const title = directions.find(item => item.key === "title");
  const topic = directions.find(item => item.key === "topicType");

  assert.equal(gold.verdict, "optimize");
  assert.equal(gold.verdictLabel, "需要优化");
  assert.match(gold.reasons[0], /5s 完播率/);
  assert.equal(title.verdict, "optimize");
  // 完播率 32%、平均播放率 40% 都达优秀 → 选题类型可复用
  assert.equal(topic.verdict, "reuse");
});

test("全部指标达优秀 ⇒ 判「可模仿复用」", () => {
  const { judgments } = judgeVideoMetrics({
    platform: "douyin",
    metrics: { likes: 100, comments: 10, shares: 10, bookmarks: 10, plays: 1000, completion5sRate: 0.6, bounce2sRate: 0.1, completionRate: 0.4, avgPlaySeconds: 50, durationSeconds: 100 },
  });
  const directions = buildStructureDirections({ platform: "douyin", judgments });
  assert.deepEqual(directions.map(item => item.verdict), ["reuse", "reuse", "reuse", "reuse"]);
});

test("该结构的指标全缺失 ⇒ 判「数据缺失」并列出缺了哪些，不判成「需要优化」", () => {
  const { judgments } = judgeVideoMetrics({
    platform: "douyin",
    metrics: { likes: 100, comments: 10, shares: 10, bookmarks: 10, plays: 1000 },
  });
  const directions = buildStructureDirections({ platform: "douyin", judgments });
  const gold = directions.find(item => item.key === "goldThreeSeconds");
  assert.equal(gold.verdict, "missing");
  assert.deepEqual(gold.missingMetrics, ["2s 跳出率", "5s 完播率"]);
});

test("REVIEW_STRUCTURES 是四大结构，key 与优先级表一一对应", () => {
  assert.deepEqual(REVIEW_STRUCTURES.map(item => item.key), ["topicType", "goldThreeSeconds", "title", "endingHook"]);
  for (const structure of REVIEW_STRUCTURES) {
    for (const platform of ["douyin", "wechat_channels"]) {
      assert.ok(STRUCTURE_METRIC_PRIORITY[platform][structure.key], `${platform}.${structure.key} 缺优先级定义`);
    }
  }
});

// ── 流量池分层（4.2 用，表在 4.1 就钉住） ──────────────────────────────

test("播放量分层：50-200 异常 / 500-1000 基础 / 1000-1w 潜力 / >1w 爆款", () => {
  assert.equal(classifyPlayBucket(120).key, "abnormal");
  assert.equal(classifyPlayBucket(800).key, "base");
  assert.equal(classifyPlayBucket(5000).key, "potential");
  assert.equal(classifyPlayBucket(50000).key, "hit");
  assert.equal(classifyPlayBucket(null).key, "unknown");
});

test("分层边界：用户未定义的区间（<50 与 200~500）如实标 ambiguous，不假装被定义过", () => {
  // 用户给的四段是 50-200 / 500-1000 / 1000-1w / >1w，段与段之间有空档。
  assert.equal(classifyPlayBucket(30).ambiguous, true);
  assert.equal(classifyPlayBucket(120).ambiguous, false);
  assert.equal(classifyPlayBucket(300).ambiguous, true);
  assert.equal(classifyPlayBucket(800).ambiguous, false);
  assert.equal(classifyPlayBucket(5000).ambiguous, false);
  assert.equal(PLAY_BUCKETS.length, 4);
});

// ── 权重的展示口径 ────────────────────────────────────────────────────────

test("权重序按用户原话：抖音 关注>收藏=转发>评论=点赞；视频号 关注>转发>评论=红心>点赞", () => {
  const douyin = describeWeights("douyin").engagement;
  assert.deepEqual(douyin[0].items, ["关注"]);
  assert.deepEqual(douyin[1].items, ["收藏", "转发"]);
  assert.deepEqual(douyin[2].items, ["评论", "点赞"]);

  const wechat = describeWeights("wechat_channels").engagement;
  assert.deepEqual(wechat[0].items, ["关注"]);
  assert.deepEqual(wechat[1].items, ["转发"]);
  assert.deepEqual(wechat[2].items, ["评论", "红心（推荐）"]);
  assert.deepEqual(wechat[3].items, ["点赞"]);
});

test("指标目录里每个指标都带「含义」——用户要求把数据背后的意义备注出来", () => {
  for (const metric of ENGAGEMENT_METRIC_CATALOG) {
    assert.ok(metric.label, `${metric.key} 缺 label`);
    assert.ok(metric.meaning, `${metric.key} 缺 meaning`);
    assert.ok(Array.isArray(metric.aliases) && metric.aliases.length > 0, `${metric.key} 缺 aliases`);
  }
  const likes = ENGAGEMENT_METRIC_CATALOG.find(item => item.key === "likes");
  assert.equal(likes.meaning, "内容使用户产生共鸣 / 情绪");
});

test("阈值文案照用户口径渲染，方向不同文案不同", () => {
  const up = metricRulesForPlatform("douyin").find(item => item.metric === "completion5sRate");
  assert.equal(formatThreshold(up), "优秀 > 50%，优化 < 25%");
  const down = metricRulesForPlatform("douyin").find(item => item.metric === "bounce2sRate");
  assert.equal(formatThreshold(down), "优秀 < 20%，优化 > 50%");
});

// ── Excel 表头 → 指标 key 的自动识别（上传后由用户确认） ────────────────

test("表头识别：中文标准表头全部认出来", () => {
  const { mapping, unmatched, missingMetrics } = suggestColumnMapping({
    headers: ["视频标题", "发布时间", "播放量", "点赞", "评论", "转发", "收藏", "完播率", "2s跳出率", "5s完播率", "平均播放时长", "视频时长"],
    platform: "douyin",
  });
  assert.equal(mapping["播放量"], "plays");
  assert.equal(mapping["点赞"], "likes");
  assert.equal(mapping["收藏"], "bookmarks");
  assert.equal(mapping["2s跳出率"], "bounce2sRate");
  assert.equal(mapping["平均播放时长"], "avgPlaySeconds");
  assert.equal(mapping["视频时长"], "durationSeconds");
  // 标题/发布时间不是指标列 —— 它们另有用途，不该被算成「没识别出的指标」
  assert.deepEqual(unmatched, ["视频标题", "发布时间"]);
  // 标准表头把必需指标全盖住了 → 没有缺失（「关注」是可选项，不算缺）
  assert.deepEqual(missingMetrics, []);
});

test("表头识别：别名、英文列名、带括注与全角括号都能认", () => {
  assert.equal(suggestColumnMapping({ headers: ["播放量(次)"] }).mapping["播放量(次)"], "plays");
  assert.equal(suggestColumnMapping({ headers: ["播放量（次）"] }).mapping["播放量（次）"], "plays");
  assert.equal(suggestColumnMapping({ headers: ["视频播放量"] }).mapping["视频播放量"], "plays");
  assert.equal(suggestColumnMapping({ headers: ["digg_count"] }).mapping["digg_count"], "likes");
  assert.equal(suggestColumnMapping({ headers: ["完播率"] }).mapping["完播率"], "completionRate");
});

test("🔴 视频号与抖音识别出的指标集不同：2s跳出率在视频号里不该被认领", () => {
  const headers = ["播放量", "点赞", "评论", "转发", "红心", "完播率", "3秒以上播放率", "2s跳出率"];
  const douyin = suggestColumnMapping({ headers, platform: "douyin" });
  const wechat = suggestColumnMapping({ headers, platform: "wechat_channels" });

  assert.equal(wechat.mapping["红心"], "recommends");
  assert.equal(wechat.mapping["3秒以上播放率"], "play3sRate");
  // 抖音不认「红心」与「3秒以上播放率」，它们会落到 unmatched
  assert.equal(douyin.mapping["红心"], undefined);
  assert.equal(douyin.mapping["3秒以上播放率"], undefined);
  assert.ok(douyin.unmatched.includes("红心"));
});

test("表头识别宁缺毋滥：认不出的留空，交给用户指认", () => {
  const { mapping, unmatched, missingMetrics } = suggestColumnMapping({ headers: ["A列", "B列", "C列"] });
  assert.deepEqual(mapping, {});
  assert.deepEqual(unmatched, ["A列", "B列", "C列"]);
  // 一个指标都没认出来 → 所有必需指标都进 missingMetrics
  assert.ok(missingMetrics.includes("plays"));
  assert.ok(missingMetrics.includes("completionRate"));
  assert.equal(missingMetrics.includes("follows"), false, "「关注」是可选，不算缺");
});

test("同一指标不会被两列抢：先出现的列拿走", () => {
  const { mapping } = suggestColumnMapping({ headers: ["点赞", "点赞数"] });
  assert.equal(mapping["点赞"], "likes");
  assert.equal(mapping["点赞数"], undefined);
});

test("空表头/空数组不炸", () => {
  assert.deepEqual(suggestColumnMapping({ headers: [] }).mapping, {});
  assert.deepEqual(suggestColumnMapping({}).unmatched, []);
  assert.deepEqual(suggestColumnMapping({ headers: ["", "  "] }).unmatched, []);
});
