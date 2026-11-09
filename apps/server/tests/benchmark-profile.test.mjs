// 模块 1「对标账号分析」(1.2)：证据分级与后端重算的边界测试。
//
// 1.2 与模块 3 的子步骤性质不同：它是**上层综合模块**（复用 2.1 分类 + 自己跑前 20 条
// 三秒/结尾）。这里锁住的是它最容易出错、也最不能出错的三类规则：
//
//   1. 只接受输入里已有的 videoId；配比由后端按条数重算，模型给的百分比一概不采信；
//   2. **证据必须分级，不许编造**：模型自称「输入证据」但引文在输入里找不到时降级；
//      用户画像的人口属性永远不能是 evidence（HANDOFF §5 禁止编造用户画像）；
//   3. 变现产品的价格若在输入里找不到数字就清空 —— 不许出现编造的定价。
import test from "node:test";
import assert from "node:assert/strict";

import {
  PROFILE_EVIDENCE_LEVELS,
  PROFILE_SAMPLE_LIMIT,
  buildBenchmarkProfileInput,
  buildHeuristicBenchmarkProfile,
  extractFrequentTags,
  normalizeBenchmarkProfile,
  selectProfileVideos,
  summarizePublishing,
} from "../api/_lib/benchmarkProfile.js";
import { normalizeBenchmarkAnalysis } from "../api/_lib/benchmarkAnalysis.js";

const VIDEO = (id, likes, overrides = {}) => ({
  id,
  title: `标题${id}`,
  link: `https://www.douyin.com/video/${id}`,
  authorName: "夏律师",
  publishDate: "2026/09/10",
  sourceText: `文案${id}`,
  platform: "douyin",
  stats: { likes, comments: 10, shares: 1, bookmarks: 2 },
  ...overrides,
});

const REPORT = (videos, overrides = {}) => ({
  version: "1.0",
  reportType: "benchmark_classification",
  contentStyle: "spoken",
  contentStyleLabel: "口播类选题",
  account: {
    name: "夏律讲劳动用工",
    url: "https://www.douyin.com/user/abc",
    platform: "douyin",
    platformLabel: "抖音",
    signature: "18年劳动法律师，帮企业省下上千万赔偿，只讲老板用得上的用工知识",
    followerCount: 120000,
  },
  analyzedCount: videos.length,
  sampleWindow: "最新作品（最多 60 条）",
  summary: "账号整体围绕老板用工风险展开。",
  categories: [{
    id: "category-1",
    name: "用工风险",
    count: videos.length,
    percentage: 100,
    coreFunction: "帮老板提前识别用工合规风险",
    keywords: ["仲裁", "赔偿", "劳动合同"],
    subcategories: [],
    topics: videos.map(video => ({ id: video.id, title: video.title })),
  }],
  videos,
  analysisSource: "agent",
  warnings: [],
  analyzedAt: "2026-09-17T00:00:00.000Z",
  ...overrides,
});

// ── 样本窗口 ────────────────────────────────────────────────────────────────

test("1.2 只取点赞最高的前 20 条，低互动样本不进分析", () => {
  const videos = Array.from({ length: 25 }, (_, index) => VIDEO(`v${index}`, (index + 1) * 100));
  const selected = selectProfileVideos(videos);
  assert.equal(selected.length, PROFILE_SAMPLE_LIMIT);
  // 点赞最高的 v24 必须在，最低的 v0 必须不在。
  assert.equal(selected[0].id, "v24");
  assert.ok(!selected.some(video => video.id === "v0"));
});

test("1.2 的样本数上限就是 20，传入更大的 limit 也不会放大", () => {
  const videos = Array.from({ length: 60 }, (_, index) => VIDEO(`v${index}`, index + 1));
  assert.equal(selectProfileVideos(videos, 60).length, PROFILE_SAMPLE_LIMIT);
});

// ── 高频标签 / 发布频率：后端实算 ─────────────────────────────────────────────

test("高频标签由后端从发布文案统计，同一条视频重复刷同一话题只算一次", () => {
  const videos = [
    VIDEO("a", 10, { sourceText: "仲裁怎么办 #劳动仲裁 #劳动仲裁 #老板用工" }),
    VIDEO("b", 9, { sourceText: "赔偿标准 #劳动仲裁" }),
    VIDEO("c", 8, { sourceText: "用工风险 #老板用工" }),
  ];
  const tags = extractFrequentTags(videos);
  assert.deepEqual(tags[0], { tag: "劳动仲裁", count: 2, percentage: 66.7 });
  assert.deepEqual(tags.find(item => item.tag === "老板用工"), { tag: "老板用工", count: 2, percentage: 66.7 });
});

test("发布频率由后端按发布日期实算，且不编造时段", () => {
  const videos = [
    VIDEO("a", 10, { publishDate: "2026-09-01" }),
    VIDEO("b", 9, { publishDate: "2026-09-08" }),
    VIDEO("c", 8, { publishDate: "2026-09-15" }),
  ];
  const summary = summarizePublishing(videos);
  assert.equal(summary.datedCount, 3);
  assert.equal(summary.spanDays, 15);
  assert.equal(summary.hasTimeOfDay, false);
  // 只有日期没有时刻时必须如实说明，而不是编一个发布时段。
  assert.match(summary.note, /不带时刻/);
});

test("样本没有可解析日期时，发布频率落待人工补充而不是给 0 当结论", () => {
  const summary = summarizePublishing([VIDEO("a", 10, { publishDate: "" })]);
  assert.equal(summary.datedCount, 0);
  assert.match(summary.note, /待人工补充/);
});

// ── 不信任 Agent：只认输入里的 videoId + 后端重算配比 ───────────────────────────

test("三秒/结尾只接受输入里已有的 videoId，模型编造的样本被丢弃", () => {
  const videos = [VIDEO("v1", 100), VIDEO("v2", 90)];
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {
      threeSeconds: {
        items: [
          { videoId: "v1", type: "fear", openingText: "不签合同要赔双倍" },
          { videoId: "不存在", type: "anger", openingText: "编造的" },
        ],
      },
      endingHooks: {
        items: [
          { videoId: "v2", type: "conversion", endingText: "私信我帮你看看" },
          { videoId: "nope", type: "twist", endingText: "编造的" },
        ],
      },
    },
  });
  assert.deepEqual(report.contentPositioning.threeSeconds.items.map(item => item.videoId).sort(), ["v1", "v2"]);
  assert.ok(!report.contentPositioning.threeSeconds.items.some(item => item.videoId === "不存在"));
  // 模型没返回的样本保留成「待人工复核」，不让样本凭空消失。
  assert.equal(report.contentPositioning.threeSeconds.items.find(item => item.videoId === "v2").type, "review");
});

test("三秒配比由后端按条数重算，恰好合计 100，且「待人工复核」不进最常用类型", () => {
  const videos = Array.from({ length: 4 }, (_, index) => VIDEO(`v${index}`, 100 - index));
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {
      threeSeconds: {
        items: [
          { videoId: "v0", type: "fear" },
          { videoId: "v1", type: "fear" },
          { videoId: "v2", type: "anger" },
          // v3 不给 → 落 review
        ],
        // 模型自己填的百分比必须被忽略。
        topTypes: [{ type: "fear", reason: "恐惧最直接", percentage: 99 }],
      },
    },
  });
  const block = report.contentPositioning.threeSeconds;
  const total = block.typeDistribution.reduce((sum, item) => sum + item.percentage, 0);
  assert.equal(Math.round(total), 100);
  assert.equal(block.topTypes[0].type, "fear");
  assert.equal(block.topTypes[0].count, 2);
  // 后端按条数算出来是 50%，不是模型写的 99%。
  assert.equal(block.topTypes[0].percentage, 50);
  assert.ok(!block.topTypes.some(item => item.type === "review"));
  // 8 个维度全部列出（含计 0 的），用户才能确认是哪 8 个维度在参与分析。
  assert.equal(block.typeDistribution.filter(item => item.type !== "review").length, 8);
});

test("三秒类型支持中文别名，认不出的落 review", () => {
  const videos = [VIDEO("v1", 100), VIDEO("v2", 90)];
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {
      threeSeconds: {
        items: [
          { videoId: "v1", type: "反差" },
          { videoId: "v2", type: "完全不认识的类型" },
        ],
      },
    },
  });
  const items = report.contentPositioning.threeSeconds.items;
  assert.equal(items.find(item => item.videoId === "v1").type, "contrast");
  assert.equal(items.find(item => item.videoId === "v2").type, "review");
});

// ── 证据分级：不许编造 ───────────────────────────────────────────────────────

test("模型自称「输入证据」但引文在输入里找不到时，降级为 Agent 推断", () => {
  const videos = [VIDEO("v1", 100, { sourceText: "员工主动离职要签什么协议" })];
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {
      businessPositioning: {
        persona: { text: "18 年劳动法律师", basis: ["18年劳动法律师"], level: "evidence" },
        corePain: { text: "编造的定位", basis: ["这句话根本不在输入里"], level: "evidence" },
      },
    },
  });
  // 引文真的在简介里 → 保留 evidence。
  assert.equal(report.businessPositioning.persona.level, "evidence");
  assert.equal(report.businessPositioning.persona.levelLabel, "输入证据");
  // 引文核对不上 → 降级。
  assert.equal(report.businessPositioning.corePain.level, "inference");
  assert.equal(report.businessPositioning.corePain.levelLabel, "Agent 推断");
});

test("用户画像的人口属性永远不能是「输入证据」，最高只到 Agent 推断", () => {
  const videos = [VIDEO("v1", 100)];
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {
      userProfile: {
        demographics: [
          // 即使模型声称有证据、引文也确实能在简介里找到，也不许标 evidence ——
          // 评论区拿不到可靠的性别/年龄分布（HANDOFF §5）。
          { key: "gender", label: "性别", text: "男性为主", basis: ["18年劳动法律师"], level: "evidence" },
          { key: "age", label: "年龄", text: "35-45 岁", level: "evidence" },
        ],
      },
    },
  });
  const byKey = new Map(report.userProfile.demographics.map(item => [item.key, item]));
  assert.equal(byKey.get("gender").level, "inference");
  assert.equal(byKey.get("age").level, "inference");
  // 5 个固定字段永远都在，模型没给的是「待人工补充」。
  assert.equal(report.userProfile.demographics.length, 5);
  assert.equal(byKey.get("income").level, "manual");
  assert.equal(byKey.get("income").levelLabel, "待人工补充");
});

test("没有内容的字段落「待人工补充」，不会伪装成推断", () => {
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: { businessPositioning: { persona: { text: "", level: "evidence" } } },
  });
  assert.equal(report.businessPositioning.persona.level, "manual");
  assert.equal(report.businessPositioning.persona.text, "");
});

test("变现产品定价在输入里找不到依据时被清空，找得到的才保留", () => {
  const videos = [VIDEO("v1", 100, { sourceText: "年度法律顾问 299 元起，咨询请私信 #劳动仲裁" })];
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {
      operationStrategy: {
        monetization: {
          products: [
            { tier: "引流产品", product: "免费自查表", price: "免费", positioning: "降低试错成本" },
            { tier: "核心产品", product: "年度法律顾问", price: "299 元", positioning: "长期陪伴" },
            { tier: "利润产品", product: "定制陪跑", price: "29800 元/年", positioning: "深度服务" },
          ],
        },
      },
    },
  });
  const [free, grounded, fabricated] = report.operationStrategy.monetization.products;
  // 「免费」在输入里没有原话 → 同样清空。没有数字的说法一样是定价主张。
  assert.equal(free.price, "");
  assert.match(free.priceNote, /待人工补充/);
  // 输入里真的写了 299 元 → 保留。
  assert.equal(grounded.price, "299 元");
  assert.equal(grounded.priceNote, "");
  assert.equal(grounded.level, "evidence");
  // 29800 在输入里根本不存在 → 清空，绝不给一个编出来的价。
  assert.equal(fabricated.price, "");
  assert.match(fabricated.priceNote, /待人工补充/);
});

test("用户画像说明了证据基础：没有评论时如实说明人口属性待人工补充", () => {
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: {},
  });
  assert.equal(report.userProfile.dataSources.hasComments, false);
  assert.equal(report.userProfile.dataSources.platformPortraitAvailable, false);
  assert.match(report.userProfile.dataSources.note, /待人工补充/);
});

test("抓到评论时，评论计入证据基础并进入输入", () => {
  const videos = [VIDEO("v1", 100)];
  const commentsByVideo = new Map([["v1", [{ text: "求发一份自查表", likes: 12 }, { text: "我客户赔了 28 万", likes: 8 }]]]);
  const input = buildBenchmarkProfileInput(REPORT(videos), { commentsByVideo });
  assert.deepEqual(input.videos[0].comments, ["求发一份自查表", "我客户赔了 28 万"]);
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {},
    commentsByVideo,
  });
  assert.equal(report.userProfile.dataSources.hasComments, true);
  assert.equal(report.dataCoverage.commentCount, 2);
  assert.equal(report.dataCoverage.videosWithComments, 1);
});

// ── 输入组装与兜底 ───────────────────────────────────────────────────────────

test("转写存在时开场/结尾取转写，来源如实标 transcript", () => {
  const videos = [VIDEO("v1", 100, { sourceText: "这是发布文案，不是口播" })];
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {
      threeSeconds: { items: [{ videoId: "v1", type: "fear" }] },
      endingHooks: { items: [{ videoId: "v1", type: "conversion" }] },
    },
    headTranscripts: new Map([["v1", { text: "再这么下去就没人敢创业了。现在民营企业……", provider: "ffmpeg+doubao-asr:mp3" }]]),
    tailTranscripts: new Map([["v1", { text: "……我是夏律师，只讲老板用得上的用工知识", provider: "ffmpeg+doubao-asr:mp3+tail5s" }]]),
  });
  const three = report.contentPositioning.threeSeconds.items[0];
  const ending = report.contentPositioning.endingHooks.items[0];
  assert.equal(three.openingSource, "transcript");
  assert.equal(three.openingText, "再这么下去就没人敢创业了。");
  assert.equal(ending.endingSource, "transcript");
  assert.equal(ending.endingText, "……我是夏律师，只讲老板用得上的用工知识");
  assert.equal(report.dataCoverage.headTranscriptCount, 1);
  assert.equal(report.dataCoverage.tailTranscriptCount, 1);
});

test("没有转写时开场/结尾退回发布文案并标 caption", () => {
  const videos = [VIDEO("v1", 100, { sourceText: "第一句。最后一句。" })];
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {
      threeSeconds: { items: [{ videoId: "v1", type: "fear" }] },
      endingHooks: { items: [{ videoId: "v1", type: "conversion" }] },
    },
  });
  assert.equal(report.contentPositioning.threeSeconds.items[0].openingSource, "caption");
  assert.equal(report.contentPositioning.threeSeconds.items[0].openingText, "第一句。");
  assert.equal(report.contentPositioning.endingHooks.items[0].endingText, "最后一句。");
});

test("内容定位透传 2.1 的分类产出，不重跑分类", () => {
  const videos = [VIDEO("v1", 100)];
  const report = normalizeBenchmarkProfile({ classificationReport: REPORT(videos), agentOutput: {} });
  const classification = report.contentPositioning.classification;
  assert.equal(classification.categories.length, 1);
  assert.equal(classification.categories[0].name, "用工风险");
  assert.equal(classification.categories[0].keywords.includes("仲裁"), true);
  assert.match(classification.source, /复用模块 3/);
});

test("新账号现跑分类时，来源说明如实改成「本次运行中先跑了一次分类」", () => {
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: {},
    classificationSource: "fresh",
  });
  // 1.2 允许直接分析新账号 —— 那时报告里再写「复用模块 3 的产出」就是不实描述。
  assert.match(report.contentPositioning.classification.source, /本次运行中先跑了一次分类/);
  assert.doesNotMatch(report.contentPositioning.classification.source, /复用模块 3/);
});

test("来源说明默认按「复用」处理，未知取值也不会漏成空串", () => {
  const reused = normalizeBenchmarkProfile({ classificationReport: REPORT([VIDEO("v1", 100)]), agentOutput: {}, classificationSource: "reused" });
  assert.match(reused.contentPositioning.classification.source, /复用模块 3/);
  const bogus = normalizeBenchmarkProfile({ classificationReport: REPORT([VIDEO("v1", 100)]), agentOutput: {}, classificationSource: "随便什么" });
  assert.match(bogus.contentPositioning.classification.source, /复用模块 3/);
});

test("样本口径如实写明只有日期粒度、且标签窗口不是自然三个月", () => {
  const report = normalizeBenchmarkProfile({ classificationReport: REPORT([VIDEO("v1", 100)]), agentOutput: {} });
  assert.equal(report.sampleWindow.profileSampleLimit, 20);
  assert.match(report.sampleWindow.tagWindowNote, /非自然三个月/);
});

test("规则兜底报告不会编造内容：能算的照算，不能算的落待人工补充", () => {
  const videos = [
    VIDEO("v1", 100, { sourceText: "仲裁 #劳动仲裁" }),
    VIDEO("v2", 90, { sourceText: "赔偿 #劳动仲裁" }),
  ];
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: buildHeuristicBenchmarkProfile(),
    analysisSource: "heuristic",
  });
  assert.equal(report.analysisSource, "heuristic");
  // 标签仍然由后端实算出来。
  assert.equal(report.frequentTags[0].tag, "劳动仲裁");
  assert.equal(report.frequentTags[0].count, 2);
  // 商业定位与用户画像没有依据 → 全部待人工补充。
  assert.equal(report.businessPositioning.persona.level, "manual");
  assert.equal(report.userProfile.pains.level, "manual");
  assert.equal(report.operationStrategy.monetization.products.length, 0);
  // 样本仍然全部保留（落 review），不让报告变空。
  assert.equal(report.contentPositioning.threeSeconds.itemCount, 2);
});

// ── 真实粉丝画像（抖音热榜）───────────────────────────────────────────────────
// 这是用户画像里唯一的一手证据来源。它把「人口属性不许标 evidence」这条硬上限
// 变成**有条件放开**：有真实分布 → evidence（basis 就是分布原文）；没有 → 仍旧推断。
// 两个方向都要锁住，否则很容易退化成「一律 evidence」（编造）或「一律 inference」（浪费数据）。

const PORTRAIT = {
  ok: true,
  reason: "",
  secUserId: "sec-abc",
  fetchedAt: "2026-09-18T02:00:00.000Z",
  fromCache: true,
  failed: [],
  dimensions: [
    {
      option: 2, key: "gender", label: "性别分布", specField: "gender", specLabel: "性别",
      items: [{ name: "男性", percentage: 78.3 }, { name: "女性", percentage: 21.7 }],
      dominant: { name: "男性", percentage: 78.3 }, tgi: [],
    },
    {
      option: 3, key: "age", label: "年龄分布", specField: "age", specLabel: "年龄",
      items: [{ name: "41-50 岁", percentage: 38.5 }, { name: "31-40 岁", percentage: 26.9 }],
      dominant: { name: "41-50 岁", percentage: 38.5 }, tgi: [],
    },
    {
      option: 1, key: "mobilePrice", label: "手机价格分布", specField: "income", specLabel: "收入水平",
      items: [{ name: "1000~1999", percentage: 36.3 }],
      dominant: { name: "1000~1999", percentage: 36.3 }, tgi: [],
    },
    {
      option: 7, key: "mobileBrand", label: "手机品牌分布", specField: "consumption", specLabel: "消费习惯",
      items: [{ name: "华为", percentage: 25.1 }],
      dominant: { name: "华为", percentage: 25.1 }, tgi: [],
    },
  ],
};

test("有真实粉丝画像时，人口属性升为「输入证据」并采用真实分布", () => {
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: {
      userProfile: {
        // 模型也给了人口属性，但真实数据优先 —— 不许模型覆盖掉一手数据。
        demographics: [{ key: "gender", label: "性别", text: "以男性为主", level: "inference" }],
      },
    },
    fansPortrait: PORTRAIT,
  });
  const byKey = new Map(report.userProfile.demographics.map(item => [item.key, item]));

  const gender = byKey.get("gender");
  assert.equal(gender.level, "evidence");
  assert.equal(gender.levelLabel, "输入证据");
  assert.equal(gender.source, "fans_portrait");
  assert.match(gender.text, /男性/);
  assert.match(gender.text, /78\.3%/);
  // basis 必须是可回查的分布原文。
  assert.match(gender.basis.join(" "), /性别分布/);

  assert.equal(byKey.get("age").level, "evidence");
  assert.equal(byKey.get("income").level, "evidence");
  assert.equal(byKey.get("consumption").level, "evidence");
});

test("职业/行业没有对应画像维度，仍然不许标「输入证据」", () => {
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: {
      userProfile: {
        demographics: [{ key: "occupation", label: "职业/行业", text: "中小企业老板", basis: ["老板"], level: "evidence" }],
      },
    },
    fansPortrait: PORTRAIT,
  });
  const occupation = report.userProfile.demographics.find(item => item.key === "occupation");
  // 热榜画像里没有职业维度 —— 上游没给就不许当证据。
  assert.equal(occupation.level, "inference");
  assert.equal(occupation.source, "agent");
});

test("没有粉丝画像时，人口属性维持原来的推断上限（不因新功能被放松）", () => {
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: {
      userProfile: {
        demographics: [{ key: "gender", label: "性别", text: "以男性为主", basis: ["老板"], level: "evidence" }],
      },
    },
  });
  const gender = report.userProfile.demographics.find(item => item.key === "gender");
  assert.equal(gender.level, "inference");
  assert.equal(report.userProfile.fansPortrait.available, false);
  assert.equal(report.userProfile.dataSources.hasPortraitData, false);
});

test("报告带出粉丝画像区块与真实的数据来源说明", () => {
  const videos = [VIDEO("v1", 100)];
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT(videos),
    agentOutput: {},
    commentsByVideo: new Map([["v1", [{ text: "求发一份自查表" }]]]),
    fansPortrait: PORTRAIT,
  });
  assert.equal(report.userProfile.fansPortrait.available, true);
  assert.equal(report.userProfile.fansPortrait.dimensions.length, 4);
  assert.equal(report.userProfile.fansPortrait.fromCache, true);
  assert.equal(report.userProfile.dataSources.hasPortraitData, true);
  assert.equal(report.userProfile.dataSources.portraitDimensionCount, 4);
  // 说明文案要讲清楚「人口属性来自真实分布」，不能还是旧的「尚未接入」。
  assert.match(report.userProfile.dataSources.note, /真实粉丝画像分布/);
  assert.doesNotMatch(report.userProfile.dataSources.note, /尚未接入/);
});

test("画像分布进入证据索引：模型引用分布数字时能被核对上", () => {
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: {
      businessPositioning: {
        // 引文直接来自画像分布 —— 应当通过核对，保留 evidence。
        persona: { text: "面向男性老板", basis: ["男性(78.3%)"], level: "evidence" },
      },
    },
    fansPortrait: PORTRAIT,
  });
  assert.equal(report.businessPositioning.persona.level, "evidence");
});

test("画像只覆盖部分维度时，未覆盖的字段不受影响", () => {
  const partial = { ...PORTRAIT, dimensions: PORTRAIT.dimensions.filter(item => item.key === "gender") };
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: { userProfile: { demographics: [{ key: "age", label: "年龄", text: "35-45 岁", level: "inference" }] } },
    fansPortrait: partial,
  });
  const byKey = new Map(report.userProfile.demographics.map(item => [item.key, item]));
  assert.equal(byKey.get("gender").level, "evidence");
  assert.equal(byKey.get("age").level, "inference");
  assert.equal(byKey.get("income").level, "manual");
});

test("部分维度抓取失败时，报告要如实带出失败清单", () => {
  const withFailure = {
    ...PORTRAIT,
    failed: [{ option: 5, label: "地域分布（城市）", error: "上游抖动" }],
  };
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: {},
    fansPortrait: withFailure,
  });
  // 只给成功的维度、不报失败，用户会以为画像本来就只有这几项。
  assert.equal(report.userProfile.fansPortrait.failed.length, 1);
  assert.equal(report.userProfile.fansPortrait.failed[0].label, "地域分布（城市）");
});

test("没有 failed 字段时归一化成空数组，界面不必再判 undefined", () => {
  const report = normalizeBenchmarkProfile({
    classificationReport: REPORT([VIDEO("v1", 100)]),
    agentOutput: {},
    fansPortrait: PORTRAIT,
  });
  assert.deepEqual(report.userProfile.fansPortrait.failed, []);
});
// 简介是「商业定位」的唯一直接依据。它由分类阶段从 TikHub 抓取结果里提出来存进
// report.account.signature —— 这条链路 2026-09-18 才打通，所以要锁住两端。

// ── 账号简介（signature）链路 ─────────────────────────────────────────────────
// 简介是「商业定位」的唯一直接依据。它由分类阶段从 TikHub 抓取结果里提出来存进
// report.account.signature —— 这条链路 2026-09-18 才打通，所以要锁住两端。

test("分类阶段把 accountProfile 落进 report.account，并清洗长度与数值", () => {
  const report = normalizeBenchmarkAnalysis({
    contentStyle: "spoken",
    platform: "douyin",
    accountUrl: "https://www.douyin.com/user/abc",
    accountName: "夏律讲劳动用工",
    videos: [VIDEO("v1", 100)],
    agentOutput: { categories: [] },
    accountProfile: { signature: "  18年劳动法律师，只讲老板用得上的用工知识  ", followerCount: "120000", secUserId: "  MS4wLjABAAAAxyz  " },
  });
  assert.equal(report.account.signature, "18年劳动法律师，只讲老板用得上的用工知识");
  assert.equal(report.account.followerCount, 120000);
  // sec_user_id 是 1.2 拉真实粉丝画像的钥匙，必须一路带到报告里并去掉空白。
  assert.equal(report.account.secUserId, "MS4wLjABAAAAxyz");
});

test("没传 accountProfile 时 signature 是空串，不会兜一句假简介", () => {
  const report = normalizeBenchmarkAnalysis({
    contentStyle: "spoken",
    platform: "douyin",
    videos: [VIDEO("v1", 100)],
    agentOutput: { categories: [] },
  });
  assert.equal(report.account.signature, "");
  assert.equal(report.account.followerCount, 0);
});

test("旧分类报告没有简介时，1.2 的商业定位落「待人工补充」而不是编一个", () => {
  const videos = [VIDEO("v1", 100)];
  const legacy = REPORT(videos, { account: { ...REPORT(videos).account, signature: undefined } });
  const report = normalizeBenchmarkProfile({
    classificationReport: legacy,
    agentOutput: {
      // 模型违反要求硬编了一个简介 —— 没有 basis 时必须被降级，不能当证据。
      businessPositioning: { persona: { text: "某律所主任", level: "evidence" } },
    },
  });
  assert.equal(report.account.signature, "");
  assert.equal(report.businessPositioning.persona.level, "inference");
  // 输入组装里也要如实反映「没有简介」。
  assert.equal(buildBenchmarkProfileInput(legacy).account.signature, "");
});

// ── 证据助手只有一份实现（与 1.3 共用 evidence.js）──────────────────────────────

test("证据分级与取证助手由 evidence.js 统一实现：1.2 与 1.3 用的是同一个对象", async () => {
  const evidence = await import("../api/_lib/evidence.js");
  // 标签表是**同一个对象引用**，不是又抄了一份内容相同的常量。
  assert.equal(PROFILE_EVIDENCE_LEVELS, evidence.PROFILE_EVIDENCE_LEVELS);
  assert.deepEqual(PROFILE_EVIDENCE_LEVELS, { evidence: "输入证据", inference: "Agent 推断", manual: "待人工补充" });
  // 合并两份实现时唯一的语义分歧点：占比要保留小数，条数才取整。
  assert.equal(evidence.asNumber("33.3"), 33.3);
  assert.equal(evidence.asNumber(-1), 0);
  assert.equal(evidence.asCount("33.3"), 33);
  // 引文核对与价格核对的口径也在这里，两个模块共用同一套。
  assert.equal(evidence.joinEvidenceParts([" 甲，乙 ", "", null, "丙"]), "甲乙丙");
  assert.equal(evidence.normalizePrice("免费", "私信领取用工自查表").price, "");
  assert.equal(evidence.normalizePrice("免费", "引流产品：免费自查表").price, "免费");
  assert.equal(evidence.normalizePrice("299 元", "年度顾问 299 元起").price, "299 元");
});
