// 模块 2「账号定位」(1.3)：证据分级、空档案与后端重算的边界测试。
//
// 1.3 与 1.2 的关键差别（也是这里锁住的东西）：
//
//   1. 它的第一手依据是**外部客户的 IP 访谈档案 + 项目经理写在客户名册里的补充说明**，
//      而实测 5 个客户里只有 1 个有档案、那一个的用户画像 8 项还有 7 项是空的。
//      所以「客户方一手输入里找不到依据 ⇏ 输入证据」这条上限必须有测试守住，
//      否则很容易退化成编造年龄/性别/收入；反过来，名册里写了的补充说明**可以**支撑
//      evidence（引用项目经理自己写的原话不是编造），这一条也必须守住；
//   2. 「选题库建立」是**透传 1.2 的分类产出**，条数与占比一律后端重算 ——
//      1.2 报告里写的 count/percentage 与模型自报的数字都不采信；
//   3. 「蹭热点」没有联网能力，热点是模型知识推断，**永远不能标 evidence**，
//      且必须带时效性提示；「同赛道对标账号」取**客户档案登记的**那串链接（方法一(a)），
//      客户没登记时落 manual，Agent 自己提议的账号则一律丢弃。
//
// 第二批（四、五、六）**扩展的是同一份报告**（3 节 → 6 节），所以后面那几组测试重点守住：
//
//   4. 四 的钩子类型只能来自权威定义（8 种 / 5 种），认不出的与重复的一律丢弃并计数；
//   5. 五 **没有输入数据**：9 项最高只能 inference，并带「是建议不是观测」的说明；
//   6. 六 的起号四步 / 复盘四维是**固定模板**（模型改不了），并带 template 标记；
//      内容配比由后端按 1.2 的真实大类重算，每个时期合计恰好 100；
//   7. 一份缺 threeSeconds / endingHooks 的旧 1.2 报告不会让流程崩，只会如实降级成通用口径；
//   8. 前端两个导出（Markdown / Word）都必须带上这三节 —— 第一批的教训就是导出静默漏了新数据。
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_PLAN_BATCH,
  ACCOUNT_PLAN_REPORT_TYPE,
  ACCOUNT_PLAN_SECTIONS,
  CONTENT_MIX_INTENTS,
  CONTENT_MIX_PERIODS,
  ENDING_HOOK_COUNT,
  HOT_TOPIC_DISCLAIMER,
  LANGUAGE_ANCHOR_TEMPLATE,
  LAUNCH_STEPS,
  OPENING_HOOK_COUNT,
  PERSONALITY_KEYWORD_COUNT,
  PRODUCTION_EDITING_ITEMS,
  PRODUCTION_SHOOTING_ITEMS,
  REVIEW_DIMENSIONS,
  TEMPLATE_SOURCE_NOTE,
  buildAccountPlanInput,
  buildClassificationPassthrough,
  buildHeuristicAccountPlan,
  checkMonetizationStep,
  normalizeAccountPlan,
} from "../api/_lib/accountPlan.js";
import { GOLD_THREE_SECOND_DIMENSIONS } from "../api/_lib/goldThreeSeconds.js";
import { ENDING_HOOK_TYPES } from "../api/_lib/endingHooks.js";
import { IP_PROFILE_INTERVIEW_LIMIT, normalizeIpProfile } from "../api/_lib/ipProfileStore.js";

/** 一个「档案填得比较全」的客户：身份/产品/部分用户画像有值，性别年龄收入为空。 */
const CUSTOMER = (overrides = {}) => ({
  id: "customer-1",
  name: "夏律",
  occupation: "劳动法律师",
  ipProfile: {
    status: "confirmed",
    identity: {
      name: "夏律",
      occupation: "劳动法律师",
      yearsExperience: "18年",
      keyCases: "服务过 200 家企业",
    },
    product: {
      businessModel: "企业用工咨询",
      productType: "年度法律顾问",
      priceRange: "年度顾问 299 元起",
      coreAdvantages: "18年只做劳动法",
    },
    userProfile: {
      occupationIndustry: "中小企业老板",
      painPoints: "怕员工仲裁赔偿",
      goalsNeeds: "少赔钱、少打官司",
    },
    interview: { rawNotes: "我做劳动法 18 年，主要服务中小企业老板。", source: "interview" },
  },
  ...overrides,
});

/** 4/5 客户的样子：**没有档案**。所有字段都必须如实落空。 */
const EMPTY_CUSTOMER = () => ({ id: "customer-2", name: "新客户", occupation: "" });

/** 1.2 的报告。count/percentage 故意写错（999/99），用来验证后端会重算。 */
const BENCHMARK = (overrides = {}) => ({
  version: "1.0",
  reportType: "benchmark_profile",
  account: { name: "夏律讲劳动用工", url: "https://www.douyin.com/user/abc", signature: "18年劳动法律师" },
  contentStyle: "spoken",
  contentStyleLabel: "口播类选题",
  businessPositioning: {
    persona: { text: "18年劳动法律师", basis: ["18年劳动法律师"], level: "evidence" },
    corePain: { text: "分享用工风险", basis: [], level: "inference" },
  },
  userProfile: {
    demographics: [{ key: "gender", label: "性别", text: "男性居多", basis: [], level: "inference" }],
    pains: { text: "老板怕赔钱", basis: [], level: "inference" },
    goals: { text: "", basis: [], level: "manual" },
  },
  contentPositioning: {
    classification: {
      source: "复用模块 3 的 2.1 分类分析产出",
      contentStyle: "spoken",
      contentStyleLabel: "口播类选题",
      analyzedCount: 4,
      sampleWindow: "最新作品（最多 60 条）",
      summary: "围绕老板用工风险展开",
      categories: [
        {
          id: "category-1",
          name: "用工风险",
          count: 999,
          percentage: 99,
          coreFunction: "帮老板提前识别用工合规风险",
          keywords: ["仲裁", "赔偿", "劳动合同"],
          subcategories: [{
            id: "sub-1",
            name: "劳动仲裁",
            description: "仲裁流程与应对",
            topics: [{ id: "v1", title: "被员工仲裁了怎么办" }, { id: "v2", title: "赔偿标准怎么算" }],
          }],
          topics: [{ id: "v1", title: "被员工仲裁了怎么办" }, { id: "v2", title: "赔偿标准怎么算" }],
        },
        {
          id: "category-2",
          name: "员工手册",
          count: 1,
          percentage: 1,
          coreFunction: "规章制度落地",
          keywords: ["员工手册"],
          subcategories: [],
          // 旧形状：topics 里是完整对象（§6.2⑨）。link / stats 要能透传。
          topics: [{ id: "v3", title: "员工手册怎么写", link: "https://www.douyin.com/video/3", stats: { likes: 1200, comments: 30 } }],
        },
      ],
    },
  },
  frequentTags: [{ tag: "劳动仲裁", count: 3, percentage: 75 }],
  operationStrategy: {
    trafficScripts: {
      bio: { text: "私信领取用工自查表", basis: ["私信领取用工自查表"], level: "evidence" },
      comments: { text: "", basis: [], level: "manual" },
    },
    monetization: {
      products: [{ tier: "核心产品", product: "年度法律顾问", price: "299 元", positioning: "长期陪伴", role: "主要利润" }],
      path: [{ step: 1, description: "通过自查表——使用户产生私信领取行为，获得引流产品" }],
    },
  },
  analyzedAt: "2026-09-18T00:00:00.000Z",
  ...overrides,
});

/** 一份「模型按要求回答」的输出，各用例按需覆盖其中几块。 */
const AGENT_OUTPUT = (overrides = {}) => ({
  businessPositioning: {
    targetAudience: { text: "怕员工仲裁赔偿的中小企业老板", basis: ["中小企业老板"], level: "evidence" },
    audienceDimensions: [
      { key: "age", text: "35-45 岁", basis: [], level: "inference" },
      { key: "gender", text: "", basis: [], level: "manual" },
    ],
    corePain: { text: "用工合规风险", basis: ["怕员工仲裁赔偿"], level: "evidence" },
    contentDirections: [
      { name: "劳动法新规", description: "新规解读", basis: ["劳动仲裁"], level: "evidence" },
    ],
    monetization: {
      products: [{ tier: "引流产品", product: "用工自查表", price: "免费", positioning: "降低门槛", role: "引流" }],
      path: [{ step: 1, description: "通过自查表——使用户产生私信领取行为，获得引流产品" }],
    },
  },
  contentPositioning: {
    core: { text: "围绕用工风险做口播", basis: ["帮老板提前识别用工合规风险"], level: "evidence" },
  },
  personaPositioning: {
    role: { text: "我是做了 18 年劳动法的律师，为中小企业老板解决用工赔偿问题", basis: ["服务过 200 家企业"], level: "evidence" },
    personality: {
      keywords: [
        { keyword: "直接", expression: "先说结论再讲依据", basis: [], level: "inference" },
        { keyword: "较真", expression: "爱抠法条细节", basis: [], level: "inference" },
      ],
    },
    memoryAnchors: {
      visual: [{ text: "深色西装 + 律所书架背景", basis: [], level: "inference" }],
      behavior: [{ text: "讲到关键处敲一下桌面", basis: [], level: "inference" }],
      language: [{ text: "这事儿有解，关注我少赔钱", basis: [], level: "inference" }],
    },
  },
  accountSetup: {
    trio: {
      name: { text: "夏律讲用工", basis: [], level: "inference" },
      avatar: { text: "职业证件照，深色西装，纯色背景", basis: [], level: "inference" },
      background: { text: "律所会议室场景，体现专业感", basis: [], level: "inference" },
    },
    bio: {
      shipinhao: [{ row: 1, candidates: [{ text: "18年劳动法律师", basis: ["劳动法律师"], level: "evidence" }] }],
      douyin: [
        { row: 1, candidates: [{ text: "18年劳动法律师", basis: ["劳动法律师"], level: "evidence" }] },
        { row: 2, candidates: [{ text: "服务过 200 家企业", basis: ["服务过 200 家企业"], level: "evidence" }] },
        { row: 3, candidates: [{ text: "只讲老板用得上的用工知识", basis: [], level: "inference" }] },
        { row: 4, candidates: [{ text: "私信领取用工自查表", basis: ["私信领取用工自查表"], level: "evidence" }] },
      ],
    },
  },
  topicLibrary: {
    benchmarkTopics: [
      { title: "劳动仲裁的 3 个关键动作", angle: "来自小类「劳动仲裁」", basis: ["被员工仲裁了怎么办"], level: "evidence" },
      { title: "劳动仲裁的 3 个关键动作", angle: "重复项", basis: ["被员工仲裁了怎么办"], level: "evidence" },
      { title: "员工手册怎么写才有效", angle: "来自小类选题", basis: ["员工手册怎么写"], level: "evidence" },
      { title: "", angle: "空标题会被丢弃", basis: [], level: "inference" },
    ],
    questions: [
      { title: "员工主动离职要给他补偿吗？", painPoint: "怕赔钱", basis: [], level: "inference" },
    ],
    trends: [
      { category: "时事热点", topic: "社保入税", titles: ["社保入税后，老板要补多少钱？"], basis: ["劳动仲裁"], level: "evidence" },
    ],
  },
  ...overrides,
});

// ── 空档案：绝不允许编造 ─────────────────────────────────────────────────────

test("没有档案的客户：目标人群各维度全部落「待人工补充」，不编年龄/性别/收入", () => {
  const report = normalizeAccountPlan({
    customer: EMPTY_CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({ businessPositioning: { audienceDimensions: [] } }),
  });
  const dimensions = report.ipPositioning.businessPositioning.audienceDimensions;
  // 6 个固定维度永远都在，模型没给的就是待人工补充。
  assert.equal(dimensions.length, 6);
  assert.deepEqual(dimensions.map(item => item.level), ["manual", "manual", "manual", "manual", "manual", "manual"]);
  assert.equal(dimensions.every(item => item.text === ""), true);
  assert.equal(dimensions.every(item => item.profileValue === ""), true);
  assert.match(dimensions[0].note, /为空/);
  assert.equal(report.customer.hasProfile, false);
  assert.equal(report.dataCoverage.profileFilledFieldCount, 0);
  assert.ok(report.warnings.some(item => item.code === "IP_PROFILE_MISSING"));
});

test("没有档案时，简介的身份头衔行与角色定位一样被压在推断以内", () => {
  const report = normalizeAccountPlan({
    customer: EMPTY_CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      accountSetup: {
        trio: {},
        bio: {
          // 引文来自 1.2 报告（能核对上），但客户档案里没有任何身份信息 —— 不许当输入证据。
          douyin: [{ row: 1, candidates: [{ text: "18年劳动法律师", basis: ["18年劳动法律师"], level: "evidence" }] }],
        },
      },
    }),
  });
  const row1 = report.accountSetup.bio.platforms[1].rows[0];
  assert.equal(row1.candidates[0].level, "inference");
  assert.equal(report.accountSetup.trio.every(item => item.level === "manual"), true);
});

test("档案里为空的字段：模型就算标了 evidence、引文也确实在别处能核对上，也被强制降级", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      businessPositioning: {
        audienceDimensions: [
          // userProfile.age 为空 → 上限 inference（不变量②）。
          { key: "age", text: "35-45 岁", basis: ["中小企业老板"], level: "evidence" },
          // userProfile.occupationIndustry 有值 → 允许 evidence（引文核对通过）。
          { key: "occupationIndustry", text: "中小企业老板", basis: ["中小企业老板"], level: "evidence" },
        ],
      },
    }),
  });
  const byKey = new Map(report.ipPositioning.businessPositioning.audienceDimensions.map(item => [item.key, item]));
  assert.equal(byKey.get("age").level, "inference");
  assert.equal(byKey.get("age").levelLabel, "Agent 推断");
  assert.equal(byKey.get("age").profileValue, "");
  assert.equal(byKey.get("occupationIndustry").level, "evidence");
  assert.equal(byKey.get("occupationIndustry").profileValue, "中小企业老板");
});

test("模型自称「输入证据」但引文在输入里找不到时，降级为推断", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      personaPositioning: {
        role: { text: "我是某大厂前高管", basis: ["某大厂前高管"], level: "evidence" },
      },
    }),
  });
  const role = report.ipPositioning.personaPositioning.role;
  assert.equal(role.level, "inference");
  assert.equal(role.levelLabel, "Agent 推断");
  // 引文真的能在档案里核对上 → 保留 evidence。
  const ok = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      personaPositioning: { role: { text: "服务过 200 家企业", basis: ["服务过 200 家企业"], level: "evidence" } },
    }),
  }).ipPositioning.personaPositioning.role;
  assert.equal(ok.level, "evidence");
  assert.equal(ok.levelLabel, "输入证据");
});

test("没有内容的字段落「待人工补充」，不会伪装成推断", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({ businessPositioning: { corePain: { text: "", level: "evidence" } } }),
  });
  const corePain = report.ipPositioning.businessPositioning.corePain;
  assert.equal(corePain.level, "manual");
  assert.equal(corePain.text, "");
});

// ── 定价与变现路径 ───────────────────────────────────────────────────────────

test("定价在输入里找不到依据时被清空，「免费」这种没有数字的说法同样清空", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      businessPositioning: {
        monetization: {
          products: [
            // 「免费」在输入里没有原话 → 清空。
            { tier: "引流产品", product: "用工自查表", price: "免费", positioning: "降低门槛", role: "引流" },
            // 客户档案价格区间里写着「年度顾问 299 元起」→ 保留。
            { tier: "核心产品", product: "年度法律顾问", price: "299 元", positioning: "长期陪伴", role: "主要利润" },
            // 输入里根本没有 29800 → 清空，绝不给一个编出来的价。
            { tier: "利润产品", product: "定制陪跑", price: "29800 元/年", positioning: "深度服务", role: "高价值客户" },
          ],
          path: [],
        },
      },
    }),
  });
  const products = report.ipPositioning.businessPositioning.monetization.products;
  const [free, grounded, fabricated] = products;
  assert.equal(free.price, "");
  assert.match(free.priceNote, /待人工补充/);
  assert.equal(grounded.price, "299 元");
  assert.equal(grounded.priceNote, "");
  assert.equal(grounded.level, "evidence");
  assert.equal(fabricated.price, "");
  assert.match(fabricated.priceNote, /待人工补充/);
  assert.ok(report.warnings.some(item => item.code === "PRICE_NOT_GROUNDED"));
  // 输入里确实找到了定价依据（299 元）→ 不再把「定价」列为缺失输入。
  assert.equal(report.missingInputs.some(item => item.key === "product.priceRange"), false);
});

test("变现路径逐步校验句式：不合规的保留原文并标记待人工改写", () => {
  const ok = checkMonetizationStep("通过免费自查表——使用户产生私信领取行为，获得引流产品");
  assert.equal(ok.ok, true);
  assert.equal(ok.note, "");
  // 允许「第一步：」这类前缀。
  assert.equal(checkMonetizationStep("第一步：通过社群答疑——使用户产生预约行为，购买信任产品").ok, true);
  assert.equal(checkMonetizationStep("先发内容，再卖货").ok, false);
  assert.equal(checkMonetizationStep("").ok, false);

  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      businessPositioning: {
        monetization: {
          products: [],
          path: [
            { step: 1, description: "通过自查表——使用户产生私信领取行为，获得引流产品" },
            { step: 2, description: "加微信后直接推年度顾问" },
          ],
        },
      },
    }),
  });
  const path = report.ipPositioning.businessPositioning.monetization.path;
  assert.equal(path[0].patternOk, true);
  assert.equal(path[1].patternOk, false);
  assert.match(path[1].patternNote, /未按标准句式/);
  // 不合规的内容**保留**（不静默丢内容），只是标记出来让人改。
  assert.equal(path[1].description, "加微信后直接推年度顾问");
  assert.ok(report.warnings.some(item => item.code === "MONETIZATION_PATH_PATTERN"));
});

// ── 透传 1.2 的分类：条数与占比后端重算 ───────────────────────────────────────

test("选题库直接透传 1.2 的分类产出，条数/占比按 topics 重算而不采信原值", () => {
  const classification = buildClassificationPassthrough(BENCHMARK());
  assert.equal(classification.categoryCount, 2);
  assert.equal(classification.topicTotal, 3);
  const [risk, manual] = classification.categories;
  // 1.2 报告里写着 999 条 / 99%，后端按 2 条 / 3 条重算。
  assert.equal(risk.topicCount, 2);
  assert.equal(risk.percentage, 66.7);
  assert.equal(manual.topicCount, 1);
  assert.equal(manual.percentage, 33.3);
  assert.equal(Math.round(risk.percentage + manual.percentage), 100);
  // coreFunction 与 keywords 是客户点名要保留的两项。
  assert.equal(risk.coreFunction, "帮老板提前识别用工合规风险");
  assert.deepEqual(risk.keywords, ["仲裁", "赔偿", "劳动合同"]);
  // 小类结构保留，小类条数同样重算。
  assert.equal(risk.subcategories[0].name, "劳动仲裁");
  assert.equal(risk.subcategories[0].topicCount, 2);
  // 旧形状里带 link / stats 的选题原样透传；没有的留空，**绝不补零**。
  assert.equal(manual.topics[0].link, "https://www.douyin.com/video/3");
  assert.equal(manual.topics[0].stats.likes, 1200);
  assert.equal(risk.topics[0].link, "");
  assert.equal(risk.topics[0].stats, null);
  assert.match(classification.source, /直接透传/);
  assert.match(classification.recomputeNote, /重算/);
});

test("报告里的内容定位一节如实说明这是透传、没有重跑分类", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT(),
  });
  const content = report.ipPositioning.contentPositioning;
  assert.equal(content.classification.topicTotal, 3);
  assert.match(content.classification.source, /未重跑分类/);
  assert.equal(content.frequentTags[0].tag, "劳动仲裁");
  assert.match(content.frequentTagsNote, /透传/);
  assert.equal(report.dataCoverage.benchmarkCategoryCount, 2);
  assert.equal(report.dataCoverage.benchmarkTopicTotal, 3);
});

test("三种方法的选题条数由后端按数组长度重算，空标题与重复标题都会被去掉", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT(),
  });
  const methods = report.topicLibrary.methods;
  const benchmarkMethod = methods.find(item => item.key === "benchmark");
  // 模型给了 4 条：1 条空标题被丢、1 条重复被去重 → 2 条。
  assert.equal(benchmarkMethod.topicCount, 2);
  assert.equal(benchmarkMethod.topics.length, 2);
  assert.equal(benchmarkMethod.duplicateCount, 1);
  assert.equal(report.dataCoverage.topicCount.benchmark, 2);
  assert.equal(report.dataCoverage.topicCount.total, report.topicLibrary.topicTotal);
  assert.equal(report.topicLibrary.topicTotal, 2 + 1 + 1);
});

test("方法二用目标用户的口吻提问，并带上对应的痛点", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT(),
  });
  const questions = report.topicLibrary.methods.find(item => item.key === "questions").topics;
  assert.equal(questions[0].title, "员工主动离职要给他补偿吗？");
  assert.equal(questions[0].painPoint, "怕赔钱");
});

// ── 热点与同赛道账号：不许当成事实 ───────────────────────────────────────────

test("热点条目永远不能是「输入证据」，且必须带时效性提示", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    // 模型自称 evidence，引文也确实能在输入里核对上 —— 仍然只到 inference。
    agentOutput: AGENT_OUTPUT(),
  });
  const trends = report.topicLibrary.methods.find(item => item.key === "trends");
  // 三个方向固定输出（没命中的也要列出来，用户才知道缺哪一组）。
  assert.deepEqual(trends.groups.map(group => group.key), ["current", "policy", "calendar"]);
  const hot = trends.groups[0].items[0];
  assert.equal(hot.level, "inference");
  assert.equal(hot.levelLabel, "Agent 推断");
  assert.equal(hot.timelinessNote, HOT_TOPIC_DISCLAIMER);
  assert.match(hot.timelinessNote, /时效性需人工核实/);
  assert.equal(trends.groups[1].count, 0);
  assert.match(trends.groups[1].note, /待人工补充/);
  assert.ok(report.warnings.some(item => item.code === "HOT_TOPICS_NOT_REALTIME"));
});

test("客户档案里没有登记对标账号时落「待人工补充」，模型给出的账号一律不写入报告", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      topicLibrary: {
        ...AGENT_OUTPUT().topicLibrary,
        sameTrackAccounts: [{ name: "某劳动法大号", link: "https://www.douyin.com/user/xxx" }],
      },
    }),
  });
  const sameTrack = report.topicLibrary.methods.find(item => item.key === "benchmark").sameTrackAccounts;
  assert.deepEqual(sameTrack.items, []);
  assert.equal(sameTrack.count, 0);
  assert.equal(sameTrack.level, "manual");
  assert.equal(sameTrack.levelLabel, "待人工补充");
  assert.equal(sameTrack.discardedCount, 1);
  assert.match(sameTrack.note, /人工补充/);
  assert.ok(report.missingInputs.some(item => item.key === "sameTrackAccounts"));
  assert.match(report.topicLibrary.methods[0].note, /人工补充项/);
});

// ── 账号搭建 ─────────────────────────────────────────────────────────────────

test("简介严格输出视频号/抖音两版 × 四行结构，缺的行如实标注", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT(),
  });
  const platforms = report.accountSetup.bio.platforms;
  assert.deepEqual(platforms.map(item => item.key), ["shipinhao", "douyin"]);
  for (const platform of platforms) {
    assert.deepEqual(platform.rows.map(row => row.row), [1, 2, 3, 4]);
  }
  const shipinhao = platforms[0];
  assert.equal(shipinhao.rows[0].candidateCount, 1);
  assert.equal(shipinhao.rows[1].candidates.length, 0);
  assert.match(shipinhao.rows[1].note, /待人工补充/);
  // 第四行参考 1.2 的引流话术：引文能核对上 → evidence。
  const douyin = platforms[1];
  assert.equal(douyin.rows[3].candidates[0].level, "evidence");
  assert.match(report.accountSetup.bio.structureNote, /四行结构/);
  // 头像只能给建议：输入里没有客户照片，报告要如实说明。
  assert.match(report.accountSetup.photoNote, /没有客户照片/);
});

test("记忆锚点三类固定输出，语言锚点带建议句式；性格关键词不足 5 个如实报数", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT(),
  });
  const persona = report.ipPositioning.personaPositioning;
  assert.deepEqual(persona.memoryAnchors.map(item => item.key), ["visual", "behavior", "language"]);
  assert.equal(persona.memoryAnchors[2].template, LANGUAGE_ANCHOR_TEMPLATE);
  assert.match(persona.memoryAnchors[2].template, /如果你有xxx/);
  // 模型只给了 2 个关键词：如实报 2/5，**不自动补齐**。
  assert.equal(persona.personality.count, 2);
  assert.equal(persona.personality.expectedCount, PERSONALITY_KEYWORD_COUNT);
  assert.match(persona.personality.note, /待人工补充/);
  assert.ok(report.warnings.some(item => item.code === "PERSONALITY_KEYWORD_COUNT"));
});

// ── 兜底与档案归一化 ─────────────────────────────────────────────────────────

test("规则兜底报告是诚实的：1.2 的产出照透传，其余全部待人工补充", () => {
  const report = normalizeAccountPlan({
    customer: EMPTY_CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: buildHeuristicAccountPlan(),
    analysisSource: "heuristic",
    warnings: [{ code: "ACCOUNT_PLAN_AGENT_FAILED", fallbackUsed: true }],
  });
  assert.equal(report.reportType, ACCOUNT_PLAN_REPORT_TYPE);
  assert.equal(report.analysisSource, "heuristic");
  assert.equal(report.warnings[0].code, "ACCOUNT_PLAN_AGENT_FAILED");
  // 能透传的照透传：1.2 的分类选题库与高频标签仍完整可用。
  assert.equal(report.ipPositioning.contentPositioning.classification.topicTotal, 3);
  assert.equal(report.ipPositioning.contentPositioning.frequentTags[0].tag, "劳动仲裁");
  // 不能算的全部待人工补充。
  assert.equal(report.ipPositioning.personaPositioning.role.level, "manual");
  assert.equal(report.ipPositioning.businessPositioning.targetAudience.level, "manual");
  assert.deepEqual(report.ipPositioning.businessPositioning.monetization.products, []);
  assert.equal(report.accountSetup.trio.every(item => item.level === "manual"), true);
  assert.equal(report.topicLibrary.methods.every(method => method.topicCount === 0), true);
  assert.equal(report.dataCoverage.producedSectionCount, 0);
});

test("normalizeIpProfile：字段一律是去空白的字符串，访谈原文超长时截断并如实标记", () => {
  const profile = normalizeIpProfile({
    status: "confirmed",
    identity: { name: "  夏律  ", age: 35 },
    interview: { rawNotes: "字".repeat(IP_PROFILE_INTERVIEW_LIMIT + 500) },
  });
  assert.equal(profile.identity.name, "夏律");
  // 数字型的年龄也要变成字符串，且不适用「数字归零」那套规则。
  assert.equal(profile.identity.age, "35");
  assert.equal(profile.identity.mbti, "");
  assert.equal(typeof profile.product.priceRange, "string");
  assert.equal(profile.interview.rawNotes.length, IP_PROFILE_INTERVIEW_LIMIT);
  assert.equal(profile.interview.rawNotesLength, IP_PROFILE_INTERVIEW_LIMIT + 500);
  assert.equal(profile.interview.rawNotesTruncated, true);

  // 完全没有档案时也返回一份全空档案，下游不必到处判 null。
  const empty = normalizeIpProfile(undefined);
  assert.equal(empty.interview.rawNotes, "");
  assert.equal(empty.interview.rawNotesTruncated, false);
  assert.equal(empty.identity.name, "");
});

test("组装给模型的输入会如实列出空字段，并把 1.2 的 level 一起带上", () => {
  const input = buildAccountPlanInput({ customer: CUSTOMER(), benchmarkReport: BENCHMARK() });
  assert.ok(input.customer.filledFields.includes("identity.occupation"));
  assert.ok(input.customer.emptyFields.includes("userProfile.age"));
  assert.ok(input.customer.emptyFields.includes("product.priceRange") === false);
  assert.equal(input.customer.ipProfile["一、身份信息"]["职业"], "劳动法律师");
  assert.equal(input.customer.ipProfile["三、用户画像"]["年龄"], "");
  // 1.2 报告里标 manual 的字段要带上「不要当成结论」的说明。
  assert.equal(input.benchmark.userProfile.goals.level, "manual");
  assert.match(input.benchmark.userProfile.goals.note, /待人工补充/);
  assert.equal(input.benchmark.classification.categories[0].topicCount, 2);
  // 档案缺失时如实给空值，不编内容。
  const empty = buildAccountPlanInput({ customer: EMPTY_CUSTOMER(), benchmarkReport: BENCHMARK() });
  assert.equal(empty.customer.hasProfile, false);
  assert.equal(empty.customer.filledFields.length, 0);
  assert.equal(empty.customer.ipProfile["三、用户画像"]["性别"], "");
});

test("客户名册的补充说明是一手输入：引用项目经理自己写的原话可以升成「输入证据」", () => {
  // 4/5 的客户就是这个样子：没有 ipProfile，但名册里填了账号定位描述与内容需求。
  const customer = {
    ...EMPTY_CUSTOMER(),
    ipPositioning: "以劳动法律师视角，帮助企业管理者识别用工风险并落地合规动作",
    contentNeeds: "抖音创作 · 企业劳动用工风险避坑与合规实务",
    notes: "客户希望三个月内起号，目标人群是 30-45 岁的企业 HR 负责人",
  };
  const input = buildAccountPlanInput({ customer, benchmarkReport: BENCHMARK() });
  assert.equal(input.customer.context.ipPositioning, "以劳动法律师视角，帮助企业管理者识别用工风险并落地合规动作");
  // 补充说明不再是「仅作背景参考」：它是一手输入，但也不能拿来编数字。
  assert.match(input.customer.context.note, /一手输入/);
  assert.match(input.customer.context.note, /不许据它编造/);

  const report = normalizeAccountPlan({
    customer,
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      businessPositioning: {
        // 引文逐字来自名册补充说明 → 可以标 evidence（这正是本次放宽的那条上限）。
        audienceDimensions: [
          { key: "age", text: "30-45 岁", basis: ["目标人群是 30-45 岁的企业 HR 负责人"], level: "evidence" },
          // 引文在输入里根本没有 → 照旧降级。
          { key: "incomeLevel", text: "年收入 50 万以上", basis: ["年收入 50 万以上"], level: "evidence" },
          // 没有任何引文 → 待人工补充。
          { key: "gender", text: "", basis: [], level: "evidence" },
        ],
      },
      personaPositioning: {
        role: { text: "帮助企业管理者识别用工风险", basis: ["帮助企业管理者识别用工风险"], level: "evidence" },
      },
    }),
  });
  const byKey = new Map(report.ipPositioning.businessPositioning.audienceDimensions.map(item => [item.key, item]));
  assert.equal(byKey.get("age").level, "evidence");
  assert.equal(byKey.get("age").levelLabel, "输入证据");
  assert.equal(byKey.get("age").profileValue, "");
  // 档案为空但名册有说明：note 要如实说清「靠名册补充说明支撑」，不能再说「最多是推断」。
  assert.match(byKey.get("age").note, /名册的补充说明/);
  assert.equal(byKey.get("incomeLevel").level, "inference");
  assert.equal(byKey.get("gender").level, "manual");
  assert.equal(report.ipPositioning.personaPositioning.role.level, "evidence");
  // 原始诉求原样带进报告，项目经理能对照客户当初要的是什么。
  assert.equal(report.customer.ipPositioning, customer.ipPositioning);
  assert.equal(report.customer.contentNeeds, customer.contentNeeds);
});

test("名册里连补充说明都没有时，空档案的结论仍然最多是推断（不许拿对标账号冒充客户的事实）", () => {
  const report = normalizeAccountPlan({
    customer: EMPTY_CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      personaPositioning: {
        // 引文确实在输入里（1.2 报告的对标账号简介），但客户方一手输入一个字都没有：
        // 「18年劳动法律师」是**那个对标账号**的身份，不是这个客户的 —— 不许当输入证据。
        role: { text: "做了 18 年的劳动法律师", basis: ["18年劳动法律师"], level: "evidence" },
      },
    }),
  });
  assert.equal(report.ipPositioning.personaPositioning.role.level, "inference");
  assert.equal(report.ipPositioning.personaPositioning.role.levelLabel, "Agent 推断");
  // 维度说明也要如实讲清是「档案为空且名册也没有」，而不是含糊的「最多是推断」。
  const age = report.ipPositioning.businessPositioning.audienceDimensions.find(item => item.key === "age");
  assert.match(age.note, /客户名册里也没有补充说明/);
});

test("客户档案登记了对标账号时，方法一(a) 直接填充并标「输入证据」；Agent 提议的账号仍被丢弃", () => {
  const customer = {
    ...CUSTOMER(),
    // 实测库里就是一串手工粘贴的文本：换行 / 逗号 / 分号 / 空格混用，还带着编号。
    benchmarkAccounts: "https://www.douyin.com/user/aaa\n2. https://www.douyin.com/user/bbb，https://www.douyin.com/user/ccc;某法务号",
  };
  const report = normalizeAccountPlan({
    customer,
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      topicLibrary: {
        ...AGENT_OUTPUT().topicLibrary,
        sameTrackAccounts: [{ name: "某劳动法大号", link: "https://www.douyin.com/user/zzz" }],
      },
    }),
  });
  const sameTrack = report.topicLibrary.methods.find(item => item.key === "benchmark").sameTrackAccounts;
  // 四种分隔符都拆开了，手工编号被去掉，不是链接的那一项原样保留（不猜域名、不补链接）。
  assert.deepEqual(sameTrack.items.map(item => item.title), [
    "https://www.douyin.com/user/aaa",
    "https://www.douyin.com/user/bbb",
    "https://www.douyin.com/user/ccc",
    "某法务号",
  ]);
  assert.equal(sameTrack.items[3].url, "");
  assert.equal(sameTrack.count, 4);
  assert.equal(sameTrack.level, "evidence");
  assert.equal(sameTrack.levelLabel, "输入证据");
  assert.deepEqual(sameTrack.basis, [customer.benchmarkAccounts.replace(/\s+/g, " ")]);
  assert.match(sameTrack.note, /来自客户档案登记的对标账号/);
  // 模型自己提议的账号照旧一条都不采纳。
  assert.equal(sameTrack.discardedCount, 1);
  // 有登记就不再是缺失输入，方法说明也不再自称「人工补充项」。
  assert.equal(report.missingInputs.some(item => item.key === "sameTrackAccounts"), false);
  assert.match(report.topicLibrary.methods[0].note, /取自客户档案登记（4 个/);
  assert.ok(report.warnings.some(item => item.code === "SAME_TRACK_ACCOUNTS_MANUAL"));
});

// ── 第二批（四、五、六） ─────────────────────────────────────────────────────
//
// 这一批**扩展的是同一份报告**：章节从 3 节变 6 节，存储 / 接口 / 前端步骤都不新增。
// 所以下面既测新功能，也测「旧报告（第一批）仍然照旧」这条底线。

/**
 * 1.2 报告 + 第二批要参考的两块（3 秒分析 / 结尾钩子分析）与发布节奏。
 *
 * 不复用 `BENCHMARK()` 直接改（那会把第一批的用例一起搅进来），而是在它上面叠一层，
 * 保证第一批的断言看到的仍是原来那份报告。
 */
const BENCHMARK_WITH_HOOKS = () => {
  const base = BENCHMARK();
  return {
    ...base,
    contentPositioning: {
      ...base.contentPositioning,
      threeSeconds: {
        itemCount: 4,
        typeDistribution: [
          { type: "curiosity", typeLabel: "好奇心", count: 2, percentage: 50 },
          { type: "pain", typeLabel: "痛点", count: 1, percentage: 25 },
          { type: "contrast", typeLabel: "反差", count: 1, percentage: 25 },
        ],
        topTypes: [
          { type: "curiosity", typeLabel: "好奇心", count: 2, percentage: 50, reason: "提问式开头最容易留住老板" },
          { type: "pain", typeLabel: "痛点", count: 1, percentage: 25, reason: "直接点出赔偿风险" },
        ],
        // 1.2 报告里那份定义数组（三秒分析叫 dimensions、结尾钩子叫 types）。
        dimensions: GOLD_THREE_SECOND_DIMENSIONS.map(item => ({ ...item })),
        analysisReason: "开头多用提问与痛点直击。",
      },
      endingHooks: {
        itemCount: 4,
        typeDistribution: [
          { type: "interaction", typeLabel: "引导互动", count: 2, percentage: 50 },
          { type: "punchline", typeLabel: "金句", count: 2, percentage: 50 },
        ],
        topTypes: [{ type: "interaction", typeLabel: "引导互动", count: 2, percentage: 50, reason: "结尾问一句" }],
        types: ENDING_HOOK_TYPES.map(item => ({ ...item })),
        analysisReason: "结尾常以互动提问收口。",
      },
    },
    operationStrategy: {
      ...base.operationStrategy,
      publishing: {
        videoCount: 4,
        datedCount: 4,
        spanDays: 30,
        perWeek: 1,
        weekdayDistribution: [{ weekday: "周二", count: 2 }],
        hasTimeOfDay: false,
        note: "样本只带发布日期、不带时刻，具体发布时段待人工补充。",
        level: "evidence",
        levelLabel: "输入证据",
        analysis: "每周约 1 条，节奏偏慢。",
      },
    },
  };
};

/** 四 的一组「模型按要求回答」的钩子（每条都带真能在输入里核对上的引文）。 */
const OPENING_HOOKS_OUTPUT = () => [
  { type: "curiosity", text: "我敢说 90% 的老板都算错了赔偿", reason: "对标账号最常用提问开头，客户最怕的就是算错账", basis: ["怕员工仲裁赔偿"], level: "evidence" },
  { type: "需求", text: "都以为要赔 20 万，其实一分不用", reason: "老别名「需求」要能归一到反差" },
  { type: "幽默", text: "（模型发明的类型，应丢弃）" },
  { type: "pain", text: "员工说走就走，损失谁来赔？", reason: "直击用工痛点" },
  { type: "curiosity", text: "（类型重复，应丢弃）" },
  { type: "knowledge", text: "3 步算清经济补偿金", reason: "给一个能立刻用上的方法" },
  { type: "desire", text: "（第 5 条有效钩子，超出 4 条上限，应丢弃）" },
];

const ENDING_HOOKS_OUTPUT = () => [
  { type: "interaction", text: "你们公司遇到过这种情况吗？评论区告诉我", reason: "引导互动，和 1.2 的结论一致" },
  { type: "resonance_ip", text: "老板不容易，我是夏律，只讲老板用得上的用工知识", reason: "带上 IP 符号" },
  { type: "punchline", text: "员工签字，比民主程序更重要", reason: "金句便于二次传播" },
  { type: "转化", text: "遇到这种情况别自己扛，私信我帮你看一眼", reason: "中文别名要能认出来" },
  { type: "twist", text: "（第 5 条，超出上限，应丢弃）" },
  { type: "不存在的类型", text: "（认不出，应丢弃）" },
];

// ── 章节与批次：同一份报告从 3 节扩到 6 节 ────────────────────────────────────

test("第二批是同一份报告的扩展：章节 3 → 6、批次号 → 2，报告与前端标签一一对应", () => {
  assert.equal(ACCOUNT_PLAN_BATCH, 2);
  assert.deepEqual(
    ACCOUNT_PLAN_SECTIONS.map(section => section.key),
    ["ipPositioning", "accountSetup", "topicLibrary", "framework", "production", "operations"],
  );
  assert.deepEqual(
    ACCOUNT_PLAN_SECTIONS.map(section => section.label),
    ["一、IP定位", "二、账号搭建", "三、视频选题库", "四、短视频内容框架", "五、拍摄与剪辑建议", "六、起号与运营"],
  );
  assert.deepEqual(
    ACCOUNT_PLAN_SECTIONS.map(section => section.key),
    ["ipPositioning", "accountSetup", "topicLibrary", "framework", "production", "operations"],
  );

  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK_WITH_HOOKS(),
    agentOutput: AGENT_OUTPUT({
      contentFramework: { openingHooks: OPENING_HOOKS_OUTPUT(), endingHooks: ENDING_HOOKS_OUTPUT() },
      production: {
        shooting: {
          appearance: { text: "深色西装、半身固定机位", reason: "贴合律师人设" },
          wardrobe: { text: "深色西装 + 无框眼镜" },
          speechRate: { text: "偏慢，关键句停顿" },
          camera: { text: "半身固定机位 + 关键处推近" },
          scene: { text: "律所会议室背景" },
        },
        editing: {
          footage: { text: "口播为主 + 法条截图" },
          music: { text: "低频纯音乐，音量压低" },
          cover: { text: "大字标题 + 人物半身" },
          subtitle: { text: "关键词黄字加粗" },
        },
      },
      operations: {
        platformStrategy: {
          primary: { text: "抖音为主阵地", basis: ["抖音创作"], level: "inference" },
          secondary: { text: "视频号做私域承接" },
          matchAnalysis: { text: "目标用户在抖音找答案，在视频号完成私域承接" },
          publish: {
            window: { text: "工作日 12:00 与 19:30 两个固定时段（通用建议，1.2 只有日期没有时刻）" },
            frequency: { text: "每周 3 条，稳定不断更" },
          },
          trafficScripts: {
            comments: { purpose: "把沉默观众拉进评论区", direction: "主页与合集", scripts: [{ text: "你们公司是怎么规定的？" }] },
            follow: { purpose: "给出关注理由", direction: "关注与私域", scripts: [{ text: "关注我，少赔一次冤枉钱" }] },
          },
        },
        contentMix: {
          periods: [
            { key: "launch", categories: [{ category: "用工风险", intent: "重点", reason: "先用最痛的点拉停留" }, { category: "员工手册", intent: "少量" }] },
            { key: "growth", categories: [{ category: "用工风险", intent: "重点" }, { category: "员工手册", intent: "常规" }] },
            { key: "stable", categories: [{ category: "用工风险", intent: "常规" }, { category: "员工手册", intent: "重点" }] },
          ],
        },
      },
    }),
  });

  assert.equal(report.batch, 2);
  assert.deepEqual(report.sections, ["ipPositioning", "accountSetup", "topicLibrary", "framework", "production", "operations"]);
  assert.match(report.batchLabel, /六、起号与运营$/);
  // 六节都有内容 → producedSectionCount 才是 6（模板部分不参与这个判断，见后面的兜底用例）。
  assert.equal(report.dataCoverage.producedSectionCount, 6);
  assert.deepEqual(report.dataCoverage.producedSections, ["ipPositioning", "accountSetup", "topicLibrary", "framework", "production", "operations"]);
  assert.equal(report.dataCoverage.openingHookCount, OPENING_HOOK_COUNT);
  assert.equal(report.dataCoverage.endingHookCount, ENDING_HOOK_COUNT);
  assert.equal(report.dataCoverage.productionItemCount, 9);
  assert.equal(report.dataCoverage.contentMixPeriodCount, 3);
});

// ── 四、短视频内容框架 ───────────────────────────────────────────────────────

test("四 的钩子：4 种类型两两不同，认不出的类型与重复类型一律丢弃并计数", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK_WITH_HOOKS(),
    agentOutput: AGENT_OUTPUT({
      contentFramework: { openingHooks: OPENING_HOOKS_OUTPUT(), endingHooks: ENDING_HOOKS_OUTPUT() },
    }),
  });

  const opening = report.contentFramework.openingHooks;
  assert.equal(opening.count, OPENING_HOOK_COUNT);
  assert.equal(opening.requiredCount, OPENING_HOOK_COUNT);
  // 「需求」是旧别名 → 归一到反差；「幽默」认不出 → 丢弃；重复的好奇心 → 丢弃；第 5 条 → 超出上限丢弃。
  assert.deepEqual(opening.hooks.map(hook => hook.type), ["curiosity", "contrast", "pain", "knowledge"]);
  assert.equal(new Set(opening.hooks.map(hook => hook.type)).size, OPENING_HOOK_COUNT);
  assert.deepEqual(opening.discarded, { unknownType: 1, duplicateType: 1, emptyText: 0, overflow: 1 });
  assert.equal(opening.discardedCount, 3);
  assert.ok(opening.discardedTypes.includes("幽默"));
  assert.match(opening.discardedNote, /丢弃/);
  // 类型清单来自权威定义（8 种），不是模型给的。
  assert.deepEqual(opening.types.map(item => item.type), GOLD_THREE_SECOND_DIMENSIONS.map(item => item.type));
  assert.equal(opening.hooks[0].typeLabel, "好奇心");
  assert.match(opening.hooks[0].definition, /制造疑问/);
  // 1.2 里该账号真正常用的类型要标出来，补充类型也要说清。
  assert.equal(opening.hooks[0].benchmarkUsed, true);
  assert.equal(opening.hooks[3].benchmarkUsed, false);
  assert.match(opening.hooks[3].typeNote, /补充类型/);
  assert.equal(opening.benchmarkAvailable, true);
  // 4 条里有 2 条（好奇心 / 痛点）命中了对标账号的常用类型。
  assert.equal(opening.benchmarkMatchedCount, 2);
  assert.match(opening.typeNote, /对标账号最常用的开头 3 秒钩子类型是：好奇心、痛点/);
  // 钩子的等级用与其它字段同一套规则：引文能核对上 → 输入证据；编不出依据 → 推断。
  assert.equal(opening.hooks[0].level, "evidence");
  assert.equal(opening.hooks[2].level, "inference");

  const ending = report.contentFramework.endingHooks;
  assert.equal(ending.count, ENDING_HOOK_COUNT);
  // 结尾类型只能来自 5 种权威定义：「转化」是别名、能认；「不存在的类型」与超限的第 5 条丢弃。
  assert.deepEqual(ending.hooks.map(hook => hook.type), ["interaction", "resonance_ip", "punchline", "conversion"]);
  assert.deepEqual(ending.types.map(item => item.type), ENDING_HOOK_TYPES.map(item => item.type));
  assert.equal(ending.discardedCount, 2);
  assert.deepEqual(ending.discarded, { unknownType: 1, duplicateType: 0, emptyText: 0, overflow: 1 });
  assert.match(report.contentFramework.note, /创作建议/);
  assert.ok(report.warnings.some(item => item.code === "HOOK_TYPES_DISCARDED"));
});

test("四 的钩子条数不足时不自动补齐，如实记录差额（不拿套话凑数）", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK_WITH_HOOKS(),
    agentOutput: AGENT_OUTPUT({
      contentFramework: {
        openingHooks: [{ type: "pain", text: "厨房油污擦不干净？" }],
        endingHooks: [{ type: "interaction", text: "评论区告诉我" }],
      },
    }),
  });
  assert.equal(report.contentFramework.openingHooks.count, 1);
  assert.equal(report.contentFramework.endingHooks.count, 1);
  assert.match(report.contentFramework.openingHooks.note, /规格要求 4 种不同类型/);
  assert.match(report.contentFramework.endingHooks.note, /差额待人工补充/);
  assert.ok(report.warnings.some(item => item.code === "HOOK_TYPE_COUNT"));
});

// ── 五、拍摄与剪辑建议：没有输入数据，只能是建议 ─────────────────────────────

test("五 的 9 项全部压在 inference 以内，并带「是建议不是观测」的说明", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK_WITH_HOOKS(),
    agentOutput: AGENT_OUTPUT({
      production: {
        shooting: {
          // 引文确实能在客户档案里核对上，模型也自称 evidence —— 仍然只能到 inference。
          appearance: { text: "深色西装、半身固定机位", basis: ["18年只做劳动法"], level: "evidence" },
          wardrobe: { text: "深色西装 + 无框眼镜", basis: [], level: "evidence" },
          speechRate: { text: "偏慢，关键句停顿" },
          // camera / scene 不给 → 待人工补充
        },
        editing: { footage: { text: "口播为主 + 法条截图" }, music: { text: "" } },
      },
    }),
  });

  const production = report.production;
  assert.equal(production.shooting.items.length, PRODUCTION_SHOOTING_ITEMS.length);
  assert.equal(production.editing.items.length, PRODUCTION_EDITING_ITEMS.length);
  assert.deepEqual(production.shooting.items.map(item => item.label), ["人物形象", "穿着", "语速", "镜头", "场景"]);
  assert.deepEqual(production.editing.items.map(item => item.label), ["素材类型", "音乐", "封面", "字幕"]);
  // 有内容的最高 inference，没内容的落 manual —— **永远不出现 evidence**。
  assert.equal(production.shooting.items[0].level, "inference");
  assert.equal(production.shooting.items[0].levelLabel, "Agent 推断");
  assert.equal(production.shooting.items[1].level, "inference");
  assert.equal(production.shooting.items[3].level, "manual");
  assert.equal(production.editing.items[1].level, "manual");
  assert.equal([...production.shooting.items, ...production.editing.items].some(item => item.level === "evidence"), false);
  assert.equal(production.shooting.levelCap, "inference");
  assert.equal(production.editing.levelCap, "inference");
  // 说明必须写清楚这是建议、不是对该账号实际拍摄方式的观测。
  assert.match(production.note, /建议/);
  assert.match(production.note, /不是对该账号实际拍摄方式的观测/);
  assert.match(production.levelCapNote, /强制为「Agent 推断」/);
  assert.ok(report.warnings.some(item => item.code === "PRODUCTION_ADVICE_NOT_OBSERVED"));
  // 缺失的项不自动补一套通用话术。
  assert.match(production.shooting.note, /待人工补充/);
});

// ── 六、起号与运营 ───────────────────────────────────────────────────────────

test("六 的起号四步与数据复盘四维是带 template 标记的固定模板，模型改不了也加不了", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK_WITH_HOOKS(),
    agentOutput: AGENT_OUTPUT({
      operations: {
        // 模型试图改写模板（甚至想加自己的步骤）—— 一律不采信。
        launchPlan: { steps: [{ step: 1, name: "买粉", action: "直接投流" }] },
        reviewPlan: { dimensions: [{ label: "玄学", focus: "看运气" }] },
        platformStrategy: { primary: { text: "抖音为主阵地" } },
      },
    }),
  });

  const operations = report.operations;
  assert.equal(operations.launchPlan.template, true);
  assert.equal(operations.reviewPlan.template, true);
  assert.equal(operations.launchPlan.source, TEMPLATE_SOURCE_NOTE);
  assert.match(operations.launchPlan.note, /通用/);
  assert.match(operations.launchPlan.note, /不是针对该客户的推断/);
  assert.match(operations.reviewPlan.note, /通用/);
  // 四步 / 四维是固定文本（逐字），条数与顺序都由后端写死。
  assert.deepEqual(operations.launchPlan.steps, LAUNCH_STEPS);
  assert.deepEqual(operations.reviewPlan.dimensions, REVIEW_DIMENSIONS);
  assert.equal(operations.launchPlan.stepCount, 4);
  assert.equal(operations.reviewPlan.dimensionCount, 4);
  assert.deepEqual(operations.launchPlan.steps.map(step => step.name), ["养号+基建工作", "储备素材", "日更测试", "复制爆款"]);
  assert.match(operations.launchPlan.steps[0].action, /实名认证/);
  assert.match(operations.launchPlan.steps[1].action, /3-5 条/);
  assert.match(operations.launchPlan.steps[2].action, /每天发 1 条/);
  assert.match(operations.launchPlan.steps[3].action, /同选题结构复制/);
  assert.match(operations.reviewPlan.dimensions[0].focus, /哪一秒开始下滑严重/);
  assert.match(operations.reviewPlan.dimensions[1].focus, /有争议\/共鸣/);
  assert.match(operations.reviewPlan.dimensions[2].focus, /立刻复制同类/);
  assert.match(operations.reviewPlan.dimensions[3].focus, /换标题格式/);
});

test("六 的内容配比：模型只给意图，占比由后端按 1.2 的大类重算，每个时期合计恰好 100", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      operations: {
        contentMix: {
          periods: [
            {
              key: "launch",
              categories: [
                // 模型自填 90% —— 一概不采信，后端按 3:2 的意图权重重算成 60/40。
                { category: "用工风险", intent: "重点", reason: "起号期先用最痛的点拉停留", basis: ["怕员工仲裁赔偿"], level: "evidence", percentage: 90 },
                { category: "员工手册", intent: "少量" },
                // 1.2 报告里没有这个大类 → 丢弃并计数。
                { category: "行业八卦", intent: "重点", reason: "编出来的大类" },
              ],
            },
            { key: "growth", categories: [{ category: "员工手册", intent: "重点", reason: "成长期补制度建设" }] },
            { key: "stable", categories: [{ category: "用工风险", intent: "说不上来", reason: "意图认不出 → 按常规并标注" }] },
          ],
        },
      },
    }),
  });

  const mix = report.operations.contentMix;
  assert.equal(mix.categoryCount, 2);
  assert.deepEqual(mix.categories, ["用工风险", "员工手册"]);
  assert.deepEqual(mix.periods.map(period => period.key), CONTENT_MIX_PERIODS.map(period => period.key));
  assert.deepEqual(mix.periods.map(period => period.label), ["起号期", "增长期", "稳定期（内容成型）"]);
  for (const period of mix.periods) {
    // 每个时期都只出现 1.2 里真实存在的大类，且合计恰好 100。
    assert.deepEqual(period.rows.map(row => row.category), ["用工风险", "员工手册"]);
    assert.equal(period.rows.reduce((sum, row) => sum + row.percentage, 0), 100);
    assert.equal(period.total, 100);
    assert.equal(period.level, "inference");
  }
  const launch = mix.periods[0];
  // 「重点」(3) : 「少量」(1) = 75 : 25 —— 模型自填的 90% 完全不参与计算。
  assert.deepEqual(launch.rows.map(row => row.percentage), [75, 25]);
  assert.deepEqual(launch.rows.map(row => row.weight), [CONTENT_MIX_INTENTS[0].weight, CONTENT_MIX_INTENTS[2].weight]);
  assert.equal(launch.rows[0].intentLabel, CONTENT_MIX_INTENTS[0].label);
  assert.equal(launch.rows[0].reason, "起号期先用最痛的点拉停留");
  assert.equal(launch.rows[0].level, "evidence");
  assert.equal(launch.discardedCount, 1);
  assert.deepEqual(launch.discardedCategories, ["行业八卦"]);
  assert.equal(mix.unmatchedCount, 1);
  assert.match(mix.unmatchedNote, /不在 1.2 报告的内容大类里/);
  assert.match(mix.recomputeNote, /恰好 100/);
  // 模型给了意图的行照抄意图；漏给的行按「常规」参与分配，并在那一行如实标注。
  assert.equal(launch.rows[1].intentLabel, "少量");
  assert.equal(launch.rows[1].intentNote, "");
  // 增长期：员工手册「重点」(3) : 用工风险漏给 →「常规」(2) = 60 : 40。
  assert.deepEqual(mix.periods[1].rows.map(row => row.percentage), [40, 60]);
  assert.equal(mix.periods[1].rows[0].intentLabel, "常规");
  assert.match(mix.periods[1].rows[0].intentNote, /没有给出这一大类的配比意图/);
  // 认不出的意图同样落「常规」，并写明模型给的是什么。
  assert.equal(mix.periods[2].rows[0].intentLabel, "常规");
  assert.match(mix.periods[2].rows[0].intentNote, /不在/);
  assert.match(mix.periods[2].rows[0].intentNote, /说不上来/);
  // 两个大类都落「常规」时对半分（4:4 → 50/50），合计仍然是 100。
  assert.deepEqual(mix.periods[2].rows.map(row => row.percentage), [50, 50]);
  assert.ok(report.warnings.some(item => item.code === "CONTENT_MIX_CATEGORY_MISMATCH"));
});

test("六 引用 1.2 operationStrategy 的字段沿用其原有等级：不升级也不降级", () => {
  const base = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK_WITH_HOOKS(),
    agentOutput: AGENT_OUTPUT({ operations: { platformStrategy: { primary: { text: "抖音为主阵地" } } } }),
  });
  const publish = base.operations.platformStrategy.publish.benchmark;
  // 1.2 判定 evidence（有发布日期）→ 照抄 evidence。
  assert.equal(publish.level, "evidence");
  assert.equal(publish.levelLabel, "输入证据");
  assert.equal(publish.available, true);
  assert.equal(publish.perWeek, 1);
  const scripts = base.operations.platformStrategy.trafficScripts.benchmark;
  assert.equal(scripts.bio.level, "evidence");
  // 1.2 里这一项是空的、标着 manual → 在 1.3 里同样是 manual，不被升成推断。
  assert.equal(scripts.comments.level, "manual");
  assert.equal(scripts.comments.levelLabel, "待人工补充");
  assert.match(scripts.note, /沿用 1.2 报告自己的判定/);

  // 1.2 自己标 inference 的发布节奏同样照抄 —— 不为了「好看」升成 evidence。
  const downgraded = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK({
      operationStrategy: {
        ...BENCHMARK().operationStrategy,
        publishing: { videoCount: 4, datedCount: 4, spanDays: 30, perWeek: 1, level: "inference", analysis: "节奏偏慢" },
      },
    }),
    agentOutput: AGENT_OUTPUT({ operations: {} }),
  });
  assert.equal(downgraded.operations.platformStrategy.publish.benchmark.level, "inference");
  // 旧报告没有 publishing（也没有 level）时按 1.2 的同一条规则补，并如实说明缺数据。
  const legacy = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({ operations: {} }),
  });
  assert.equal(legacy.operations.platformStrategy.publish.benchmark.available, false);
  assert.equal(legacy.operations.platformStrategy.publish.benchmark.level, "manual");
  assert.match(legacy.operations.platformStrategy.publish.benchmark.missingNote, /1.2 报告里没有发布节奏数据/);
});

// ── 旧 1.2 报告：缺第二批要用的两块时不崩，且如实降级 ────────────────────────

test("1.2 报告缺 threeSeconds / endingHooks 时不崩，四 如实降级成通用口径", () => {
  // 送进模型的输入要如实说明「1.2 没有这一块」，而不是当成「对标账号没用过」。
  const input = buildAccountPlanInput({ customer: CUSTOMER(), benchmarkReport: BENCHMARK() });
  assert.equal(input.benchmark.threeSeconds.available, false);
  assert.equal(input.benchmark.endingHooks.available, false);
  assert.deepEqual(input.benchmark.threeSeconds.topTypes, []);
  assert.match(input.benchmark.threeSeconds.note, /1.2 报告里没有「开头 3 秒分析」/);
  // 类型清单仍然完整（来自后端权威定义），模型照旧只能从里面选。
  assert.deepEqual(input.benchmark.threeSeconds.allowedTypes.map(item => item.type), GOLD_THREE_SECOND_DIMENSIONS.map(item => item.type));
  assert.deepEqual(input.benchmark.endingHooks.allowedTypes.map(item => item.type), ENDING_HOOK_TYPES.map(item => item.type));

  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      contentFramework: {
        openingHooks: OPENING_HOOKS_OUTPUT(),
        endingHooks: ENDING_HOOKS_OUTPUT(),
      },
      production: { shooting: { appearance: { text: "深色西装" } }, editing: {} },
    }),
  });
  const opening = report.contentFramework.openingHooks;
  // 钩子照常产出（它们是模型写的，不依赖 1.2 的这两块），但参考信息如实为空。
  assert.equal(opening.count, OPENING_HOOK_COUNT);
  assert.equal(opening.benchmarkAvailable, false);
  assert.deepEqual(opening.benchmarkTopTypes, []);
  assert.equal(opening.benchmarkMatchedCount, 0);
  assert.equal(opening.hooks.every(hook => hook.benchmarkUsed === false), true);
  assert.match(opening.typeNote, /1.2 报告里没有/);
  assert.equal(report.contentFramework.benchmarkReference.threeSeconds.available, false);
  assert.match(report.contentFramework.benchmarkReference.threeSeconds.note, /需人工核对/);
  // 缺失输入里要能看见「1.2 缺了这两块」。
  const missing = report.missingInputs.find(item => item.key === "benchmarkHookAnalysis");
  assert.ok(missing);
  assert.match(missing.label, /开头 3 秒分析/);
  assert.match(missing.label, /结尾钩子分析/);
  // 五 的 9 项照旧输出，等级口径不受影响。
  assert.equal(report.production.shooting.items[0].level, "inference");
  assert.equal(report.production.editing.items.every(item => item.level === "manual"), true);
});

test("送进模型的输入带上了 3 秒分析 / 结尾钩子分析与发布节奏（含类型定义）", () => {
  const input = buildAccountPlanInput({ customer: CUSTOMER(), benchmarkReport: BENCHMARK_WITH_HOOKS() });
  assert.equal(input.benchmark.threeSeconds.available, true);
  assert.equal(input.benchmark.threeSeconds.itemCount, 4);
  assert.deepEqual(input.benchmark.threeSeconds.topTypes.map(item => item.type), ["curiosity", "pain"]);
  assert.equal(input.benchmark.threeSeconds.typeDistribution.length, 3);
  assert.equal(input.benchmark.threeSeconds.allowedTypes.length, GOLD_THREE_SECOND_DIMENSIONS.length);
  assert.equal(input.benchmark.threeSeconds.reportDefinitions.length, GOLD_THREE_SECOND_DIMENSIONS.length);
  assert.match(input.benchmark.threeSeconds.analysisReason, /提问与痛点/);
  assert.equal(input.benchmark.endingHooks.available, true);
  assert.deepEqual(input.benchmark.endingHooks.topTypes.map(item => item.type), ["interaction"]);
  assert.equal(input.benchmark.endingHooks.reportDefinitions.length, ENDING_HOOK_TYPES.length);
  // 发布节奏（六 的发布建议要参考它）连等级一起给。
  assert.equal(input.benchmark.operationStrategy.publishing.level, "evidence");
  assert.equal(input.benchmark.operationStrategy.publishing.hasTimeOfDay, false);
  assert.equal(input.benchmark.operationStrategy.publishing.perWeek, 1);
  // 认不出的类型不写进参考统计里（不许拿它去核对）。
  const dirty = buildAccountPlanInput({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK({
      contentPositioning: {
        ...BENCHMARK().contentPositioning,
        threeSeconds: {
          itemCount: 2,
          typeDistribution: [{ type: "幽默", count: 1, percentage: 50 }, { type: "pain", count: 1, percentage: 50 }],
          topTypes: [{ type: "幽默", count: 1, percentage: 50 }, { type: "pain", count: 1, percentage: 50 }],
        },
      },
    }),
  });
  assert.deepEqual(dirty.benchmark.threeSeconds.topTypes.map(item => item.type), ["pain"]);
  assert.deepEqual(dirty.benchmark.threeSeconds.typeDistribution.map(item => item.type), ["pain"]);
});

// ── 规则兜底：模板照常输出，其余落 manual ────────────────────────────────────

test("规则兜底：四/五 落 manual、六 的模板部分照常输出、配比落 manual", () => {
  const report = normalizeAccountPlan({
    customer: EMPTY_CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: buildHeuristicAccountPlan(),
    analysisSource: "heuristic",
    warnings: [{ code: "ACCOUNT_PLAN_AGENT_FAILED", fallbackUsed: true }],
  });

  // 六 的模板部分是固定文本，不依赖模型 —— Agent 挂了也照常输出。
  assert.deepEqual(report.operations.launchPlan.steps, LAUNCH_STEPS);
  assert.deepEqual(report.operations.reviewPlan.dimensions, REVIEW_DIMENSIONS);
  assert.equal(report.operations.launchPlan.template, true);
  assert.equal(report.operations.reviewPlan.template, true);
  // 四 的钩子与五 的 9 项都是模型产物：兜底时全部待人工补充。
  assert.equal(report.contentFramework.openingHooks.count, 0);
  assert.equal(report.contentFramework.endingHooks.count, 0);
  assert.match(report.contentFramework.openingHooks.note, /待人工补充/);
  assert.equal(report.production.shooting.items.every(item => item.level === "manual"), true);
  assert.equal(report.production.editing.items.length, PRODUCTION_EDITING_ITEMS.length);
  assert.equal(report.production.editing.items.every(item => item.level === "manual"), true);
  // 六 的平台矩阵与内容配比同样是模型产物 → manual，且**不填默认配比**。
  assert.equal(report.operations.platformStrategy.primary.level, "manual");
  assert.equal(report.operations.platformStrategy.trafficScripts.types.every(item => item.scriptCount === 0), true);
  assert.equal(report.operations.contentMix.periods.length, CONTENT_MIX_PERIODS.length);
  assert.equal(report.operations.contentMix.periods.every(period => period.rows.length === 0 && period.level === "manual"), true);
  assert.equal(report.operations.contentMix.periods.every(period => period.total === 0), true);
  assert.match(report.operations.contentMix.periods[0].note, /待人工补充/);
  // 模板不参与「本章节有没有内容」的统计：一份空报告不能自称六节齐全。
  assert.equal(report.dataCoverage.producedSections.includes("operations"), false);
  assert.equal(report.dataCoverage.producedSections.includes("framework"), false);
  assert.equal(report.dataCoverage.producedSectionCount, 0);
  assert.equal(report.batch, 2);
});

// ── 前端两个导出必须带上新的三节（第一批的教训）──────────────────────────────

/**
 * `src/app/accountPlan.ts` 的 import 没有写扩展名（Vite 负责解析），Node 直接 import 不了，
 * 所以这里先用项目自带的 esbuild 把它打成一份 ESM 再 import —— 与验证流程里
 * `./node_modules/.bin/esbuild` 用的是同一个工具，不额外引入依赖。
 */
const loadFrontendExports = async () => {
  const esbuild = await import("esbuild");
  const bundled = await esbuild.build({
    entryPoints: ["../web/src/app/accountPlan.ts"],
    bundle: true,
    format: "esm",
    write: false,
    platform: "neutral",
    logLevel: "silent",
  });
  const code = bundled.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
};

test("Markdown 与 Word 导出都必须带上四/五/六（并保留模板标记与「建议不是观测」说明）", async () => {
  const { formatAccountPlanMarkdown, accountPlanToDocxBlocks } = await loadFrontendExports();
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK_WITH_HOOKS(),
    agentOutput: AGENT_OUTPUT({
      contentFramework: { openingHooks: OPENING_HOOKS_OUTPUT(), endingHooks: ENDING_HOOKS_OUTPUT() },
      production: { shooting: { appearance: { text: "深色西装、半身固定机位" } }, editing: { music: { text: "低频纯音乐" } } },
      operations: {
        platformStrategy: { primary: { text: "抖音为主阵地" }, trafficScripts: { comments: { purpose: "拉评论", direction: "主页", scripts: [{ text: "你们公司怎么规定的？" }] } } },
        contentMix: { periods: [{ key: "launch", categories: [{ category: "用工风险", intent: "重点", reason: "先拉停留" }, { category: "员工手册", intent: "少量" }] }] },
      },
    }),
  });

  const markdown = formatAccountPlanMarkdown(report);
  for (const heading of ["## 四、短视频内容框架", "## 五、拍摄与剪辑建议", "## 六、起号与运营"]) {
    assert.ok(markdown.includes(heading), `Markdown 缺少 ${heading}`);
  }
  assert.match(markdown, /不是对该账号实际拍摄方式的观测/);
  assert.match(markdown, /通用模板/);
  assert.match(markdown, /我敢说 90% 的老板都算错了赔偿/);
  assert.match(markdown, /合计 100%/);
  assert.match(markdown, /\| 步骤 \| 具体操作 \|/);
  assert.match(markdown, /\| 复盘维度 \| 关注什么 \|/);
  assert.match(markdown, /\| 内容大类 \| 比重意图 \| 占比 \| 理由 \| 证据等级 \|/);

  const blocks = accountPlanToDocxBlocks(report);
  const headings = blocks.filter(block => block.type === "heading").map(block => block.text);
  for (const heading of ["四、短视频内容框架", "五、拍摄与剪辑建议", "六、起号与运营"]) {
    assert.ok(headings.includes(heading), `Word 缺少 ${heading}`);
  }
  assert.ok(headings.some(text => String(text).includes("通用模板，非针对该客户的推断")));
  const tableHeaders = blocks.filter(block => block.type === "table").map(block => block.headers.join("|"));
  assert.ok(tableHeaders.includes("步骤|具体操作"));
  assert.ok(tableHeaders.includes("复盘维度|关注什么"));
  assert.ok(tableHeaders.includes("内容大类|比重意图|占比|理由|证据等级"));
  const texts = blocks.map(block => String(block.text || "")).join("\n");
  assert.match(texts, /不是对该账号实际拍摄方式的观测/);
});

test("第一批的旧报告（没有四/五/六）两个导出都不崩，也不出现空的第四节", async () => {
  const { formatAccountPlanMarkdown, accountPlanToDocxBlocks } = await loadFrontendExports();
  const legacy = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT(),
  });
  // 故意把第二批的三节删掉，模拟第一批存下来的报告。
  const batchOne = { ...legacy, batch: 1, sections: ["ipPositioning", "accountSetup", "topicLibrary"] };
  delete batchOne.contentFramework;
  delete batchOne.production;
  delete batchOne.operations;

  const markdown = formatAccountPlanMarkdown(batchOne);
  assert.ok(markdown.includes("## 一、IP定位"));
  assert.ok(markdown.includes("## 三、视频选题库"));
  assert.equal(markdown.includes("## 四、短视频内容框架"), false);
  assert.equal(markdown.includes("## 五、拍摄与剪辑建议"), false);
  assert.equal(markdown.includes("## 六、起号与运营"), false);

  const blocks = accountPlanToDocxBlocks(batchOne);
  const headings = blocks.filter(block => block.type === "heading").map(block => block.text);
  assert.ok(headings.includes("一、IP定位"));
  assert.equal(headings.includes("四、短视频内容框架"), false);
  assert.equal(headings.includes("六、起号与运营"), false);
});

test("六 的内容配比：模型给的大类一个都对不上时，该时期不填默认配比，落 manual", () => {
  const report = normalizeAccountPlan({
    customer: CUSTOMER(),
    benchmarkReport: BENCHMARK(),
    agentOutput: AGENT_OUTPUT({
      operations: {
        contentMix: {
          periods: [
            // 三个大类全是模型自己发明的 —— 一个都不能进配比。
            { key: "launch", categories: [{ category: "行业干货", intent: "重点" }, { category: "老板思维", intent: "常规" }] },
            { key: "growth", categories: [{ category: "用工风险", intent: "重点" }, { category: "员工手册", intent: "常规" }] },
          ],
        },
      },
    }),
  });
  const mix = report.operations.contentMix;
  const launch = mix.periods[0];
  assert.deepEqual(launch.rows, []);
  assert.equal(launch.total, 0);
  assert.equal(launch.level, "manual");
  assert.equal(launch.levelLabel, "待人工补充");
  assert.equal(launch.discardedCount, 2);
  assert.deepEqual(launch.discardedCategories, ["行业干货", "老板思维"]);
  assert.match(launch.note, /都不在 1.2 报告的内容大类里/);
  // 有对上大类的时期照常重算，合计 100。
  assert.equal(mix.periods[1].total, 100);
  assert.equal(mix.unmatchedCount, 2);
  assert.ok(report.warnings.some(item => item.code === "CONTENT_MIX_CATEGORY_MISMATCH"));
  // 这个时期没有内容 → 「六」仍然因为有别的客户化内容而算「有内容」。
  assert.equal(report.dataCoverage.contentMixPeriodCount, 1);
});
