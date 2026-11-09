import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLibraryAccount,
  buildTagDictionary,
  scopedCategoryId,
  scopedSubcategoryId,
} from "../api/_lib/topicLibraryStore.js";
import {
  buildHeuristicBenchmarkTopicRefresh,
  buildBenchmarkTopicRefreshInput,
  describeTopicRefreshVideoDrop,
  normalizeBenchmarkTopicRefresh,
  normalizeTopicRefreshVideos,
  normalizeTopicLibrary,
} from "../api/_lib/benchmarkTopicRefresh.js";

/**
 * 正式选题库 + 新视频筛选的契约测试。
 *
 * 这里钉的是**业务口径**，不是实现细节（HANDOFF §0.1）：
 * - 库来自 2.1 分类报告；多账号分类各自独立、不许同名合并；
 * - 点赞门槛是**严格大于**，缺失点赞不算达标；
 * - 打标签只接受库内真实存在的分类，自造分类落「待人工复核」；
 * - 完整脚本取不到就退回发布文案，且如实标出两种来源。
 */

/** 造一份形状与真实 2.1 报告一致的最小报告。 */
/**
 * 取账号条目里的分类树。
 *
 * 库条目现在存**三份分析**（`analyses.classification` / `goldThreeSeconds` / `endingHooks`），
 * 分类树在 `analyses.classification.categories` 下面（2026-09-21 用户要求把 2.2/2.3 也纳入库）。
 * 这里集中一处，别再让断言直接写长路径。
 */
const cats = account => account.analyses.classification.categories;

const makeReport = (overrides = {}) => ({
  reportType: "benchmark_classification",
  id: overrides.id || "report-1",
  accountName: overrides.accountName || "胥子讲老板用工风险",
  accountUrl: overrides.accountUrl || "https://www.douyin.com/user/abc",
  contentStyle: overrides.contentStyle || "spoken",
  contentStyleLabel: overrides.contentStyleLabel || "口播类",
  analyzedCount: 60,
  account: { name: overrides.accountName || "胥子讲老板用工风险", platform: "douyin" },
  categories: overrides.categories || [
    {
      id: "cat-risk",
      name: "用工风险合规",
      coreFunction: "帮老板提前规避用工与合同风险",
      keywords: ["劳动合同", "仲裁"],
      count: 24,
      percentage: 40,
      subcategories: [
        { id: "sub-contract", name: "合同协议实操", description: "签约与解除场景" },
        { id: "sub-onboard", name: "入职合规", description: "试用期与社保" },
      ],
    },
    {
      id: "cat-arbitration",
      name: "劳动仲裁案例",
      coreFunction: "用真实案例讲清赔偿口径",
      keywords: ["赔偿", "案例"],
      count: 36,
      percentage: 60,
      subcategories: [{ id: "sub-case", name: "赔偿案例", description: "仲裁结果复盘" }],
    },
  ],
});

test("库里的大类/小类 id 带账号作用域，两个账号的同名分类不会撞成同一个", () => {
  const accountA = buildLibraryAccount({ report: makeReport({ id: "report-a", accountName: "账号甲" }) });
  const accountB = buildLibraryAccount({ report: makeReport({ id: "report-b", accountName: "账号乙" }) });

  // 两份报告的分类 id 完全一样，但入库后必须区分开。
  assert.equal(cats(accountA)[0].sourceId, "cat-risk");
  assert.equal(cats(accountB)[0].sourceId, "cat-risk");
  assert.notEqual(cats(accountA)[0].id, cats(accountB)[0].id);
  assert.equal(cats(accountA)[0].id, scopedCategoryId(accountA.accountKey, "cat-risk"));
  assert.equal(
    cats(accountA)[0].subcategories[0].id,
    scopedSubcategoryId(accountA.accountKey, "cat-risk", "sub-contract"),
  );

  // 来源追溯：库条目要能指回它是从哪一份 2.1 报告来的。
  assert.equal(accountA.sourceReportId, "report-a");
  assert.equal(accountB.sourceReportId, "report-b");
});

test("库保留判断依据：口播大类的核心功能、关键词与样本占比都要存下来", () => {
  const account = buildLibraryAccount({ report: makeReport() });
  const category = cats(account)[0];

  assert.equal(category.coreFunction, "帮老板提前规避用工与合同风险");
  assert.deepEqual(category.keywords, ["劳动合同", "仲裁"]);
  assert.equal(category.count, 24);
  assert.equal(category.percentage, 40);
  assert.equal(category.subcategories.length, 2);
  assert.equal(account.contentStyleLabel, "口播类");
});

test("没有小类的大类整条剔除：打不出小类标签的分类不该进库", () => {
  const account = buildLibraryAccount({ report: makeReport({
    categories: [
      { id: "cat-empty", name: "空分类", subcategories: [] },
      { id: "cat-ok", name: "正常分类", subcategories: [{ id: "sub", name: "小类" }] },
    ],
  }) });

  assert.equal(cats(account).length, 1);
  assert.equal(cats(account)[0].name, "正常分类");
});

test("标签词典：多账号时 label 带账号名前缀，单账号时不加前缀", () => {
  const accountA = buildLibraryAccount({ report: makeReport({ id: "report-a", accountName: "账号甲" }) });
  const accountB = buildLibraryAccount({ report: makeReport({ id: "report-b", accountName: "账号乙" }) });

  const single = buildTagDictionary([accountA]);
  assert.equal(single[0].label, "用工风险合规");

  const multi = buildTagDictionary([accountA, accountB]);
  assert.equal(multi.length, 4, "两个账号各 2 个大类，且都保留（不合并）");
  assert.equal(multi[0].label, "账号甲 · 用工风险合规");
  assert.equal(multi[2].label, "账号乙 · 用工风险合规");
  // 子类同样带前缀，界面与 Agent 都能分辨归属。
  assert.equal(multi[0].subcategories[0].label, "账号甲 · 合同协议实操");
});

const makeVideo = (id, likes, overrides = {}) => ({
  id,
  title: `视频 ${id}`,
  link: `https://www.douyin.com/video/${id}`,
  authorName: "胥子讲老板用工风险",
  publishDate: "2026-09-18",
  sourceText: "发布文案",
  platform: "douyin",
  stats: { likes, comments: 1, shares: 1, bookmarks: 1 },
  ...overrides,
});

test("点赞门槛是大于等于：100 算达标、99 不达标", () => {
  const videos = [
    makeVideo("v-exact", 100),
    makeVideo("v-above", 101),
    makeVideo("v-below", 99),
  ];
  const kept = normalizeTopicRefreshVideos(videos, { minLikes: 100 });
  assert.deepEqual(kept.map(video => video.id), ["v-exact", "v-above"]);
});

test("点赞缺失按 0 处理：门槛 100 时被挡掉，门槛 0 时被纳入", () => {
  const videos = [
    makeVideo("v-missing", 0, { stats: {} }),
    makeVideo("v-nan", 0, { stats: { likes: "abc" } }),
    makeVideo("v-ok", 500),
  ];
  assert.deepEqual(
    normalizeTopicRefreshVideos(videos, { minLikes: 100 }).map(video => video.id),
    ["v-ok"],
  );
  // 门槛填 0 → 0 >= 0 成立，缺失/非法点赞的条目也会进来（有意行为）
  assert.deepEqual(
    normalizeTopicRefreshVideos(videos, { minLikes: 0 }).map(video => video.id),
    ["v-missing", "v-nan", "v-ok"],
  );
});

// ── 2026-09-21：无描述发布的作品不能被后端丢掉 ────────────────────────────────
//
// 事故经过（用户实测「提取脚本 400」）：抖音允许**无描述发布**，前端
// `isAnalysableRawVideo` 明确放行了这类作品（「有文案」不是必要条件）；
// 但后端这里卡了 `video.title`，把它们**静默丢光** —— 明明抓到了视频、也能转写，
// 却只回一句「没有满足筛选条件的可分析视频」，看不出问题在哪。
// 标题只是给打标签当上下文，缺了不影响提取脚本（界面也有「（无标题）」兜底）。
test("无描述（标题为空）的作品仍然可以进入分析与转写", () => {
  const videos = [
    makeVideo("v-no-title", 500, { title: "", sourceText: "" }),
    makeVideo("v-space-title", 500, { title: "   " }),
    makeVideo("v-ok", 500),
  ];
  const kept = normalizeTopicRefreshVideos(videos, { minLikes: 100 });
  assert.deepEqual(kept.map(video => video.id), ["v-no-title", "v-space-title", "v-ok"]);
  // 标题缺失如实归一化成空串，不编造
  assert.equal(kept[0].title, "");
  assert.equal(kept[1].title, "");
});

test("缺链接的作品仍然要丢掉（没有链接就无从解析视频、更无从转写）", () => {
  const videos = [
    makeVideo("v-no-link", 500, { link: "" }),
    makeVideo("v-ok", 500),
  ];
  const kept = normalizeTopicRefreshVideos(videos, { minLikes: 100 });
  assert.deepEqual(kept.map(video => video.id), ["v-ok"]);
});

test("候选被全部过滤时，错误信息要说清是缺链接还是没过点赞门槛", () => {
  const noLink = describeTopicRefreshVideoDrop([makeVideo("a", 500, { link: "" })], 100);
  assert.match(noLink, /缺少作品链接 1 条/);
  // ⚠️ 门槛 100 是**大于等于**口径：写 100 的话它其实达标了，所以这里用 99/3
  const lowLikes = describeTopicRefreshVideoDrop([makeVideo("b", 99), makeVideo("c", 3)], 100);
  assert.match(lowLikes, /点赞未达到 100 的 2 条/);
  // 标题为空**不该**出现在理由里 —— 它不是拦路虎（否则又会把人误导到错误的方向）
  const titleless = describeTopicRefreshVideoDrop([makeVideo("d", 0, { title: "" })], 100);
  assert.doesNotMatch(titleless, /标题/);
});

// ── 短别名协议（2026-09-21）──────────────────────────────────────────────────
//
// 背景：词典里的真实 id 带账号作用域，长约 200 字符。原来让模型**回抄这个 id**，
// 实测一次 30 条里 29 条抄错（抄错的落「待人工复核」），而且模型要把这串写进每一条输出，
// 白烧几千个输出 token。现在改成「提示词给短代号 c1/s1，后端映射回真实 id」。
test("提示词里的词典只给短代号，不再出现 200 字符的真实 id", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const input = buildBenchmarkTopicRefreshInput({
    videos: [makeVideo("v-1", 500)],
    categories,
    transcripts: new Map(),
    recentDays: 7,
    minLikes: 100,
  });

  const serialized = JSON.stringify(input.topicLibrary);
  assert.doesNotMatch(serialized, /douyin\.com\/user/, "词典里不该再出现带作用域的长 id");
  assert.deepEqual(input.topicLibrary.map(c => c.categoryCode), ["c1", "c2"]);
  // 小类代号在**各自大类内部**从 s1 重新开始 —— 与解析端同一套规则
  assert.deepEqual(input.topicLibrary[0].subcategories.map(s => s.subcategoryCode), ["s1", "s2"]);
  assert.deepEqual(input.topicLibrary[1].subcategories.map(s => s.subcategoryCode), ["s1"]);
  // 分类信号（名称/核心功能/关键词）必须照旧给全，否则模型没法判断
  assert.equal(input.topicLibrary[0].name, "用工风险合规");
  assert.deepEqual(input.topicLibrary[0].keywords, ["劳动合同", "仲裁"]);
});

test("模型回短代号 → 精确映射回真实分类（小类在所属大类内解析）", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const report = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500), makeVideo("v-2", 500)],
    categories,
    transcripts: new Map(),
    agentOutput: {
      items: [
        { videoId: "v-1", categoryCode: "c1", subcategoryCode: "s2", confidence: "high" },
        // ⚠️ 同一个 s1 在 c2 底下指向的是**另一个**小类：代号必须在大类作用域内解析
        { videoId: "v-2", categoryCode: "c2", subcategoryCode: "s1", confidence: "high" },
      ],
    },
  });

  const first = report.items.find(item => item.video.id === "v-1");
  const second = report.items.find(item => item.video.id === "v-2");
  assert.equal(first.category.name, "用工风险合规");
  assert.equal(first.subcategory.name, "入职合规");
  assert.equal(second.category.name, "劳动仲裁案例");
  assert.equal(second.subcategory.name, "赔偿案例");
  // 落库的仍然是**真实 id**（词典里那一条），代号只是传输层的
  assert.equal(first.category.id, categories[0].id);
  assert.equal(first.subcategory.id, categories[0].subcategories[1].id);
  assert.notEqual(first.category.id, "c1");
});

test("代号越权（大类下没有的小类 / 自造代号）一律落待人工复核", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const report = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500), makeVideo("v-2", 500), makeVideo("v-3", 500)],
    categories,
    transcripts: new Map(),
    agentOutput: {
      items: [
        // c1 下面只有 s1/s2，s3 不存在
        { videoId: "v-1", categoryCode: "c1", subcategoryCode: "s3" },
        // 自造大类
        { videoId: "v-2", categoryCode: "c9", subcategoryCode: "s1" },
        // 明确要求落复核
        { videoId: "v-3", categoryCode: "review", subcategoryCode: "review" },
      ],
    },
  });
  for (const id of ["v-1", "v-2", "v-3"]) {
    const item = report.items.find(entry => entry.video.id === id);
    assert.equal(item.category.name, "待人工复核", `${id} 应该落待人工复核`);
    assert.equal(item.confidence, "low");
  }
});

test("旧格式（回真实 id / 分类名）仍然认，不会因为换协议把老输出打成复核", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const report = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500), makeVideo("v-2", 500)],
    categories,
    transcripts: new Map(),
    agentOutput: {
      items: [
        { videoId: "v-1", categoryId: categories[0].id, subcategoryId: categories[0].subcategories[0].id },
        { videoId: "v-2", categoryName: "劳动仲裁案例", subcategoryName: "赔偿案例" },
      ],
    },
  });
  assert.equal(report.items.find(i => i.video.id === "v-1").category.name, "用工风险合规");
  assert.equal(report.items.find(i => i.video.id === "v-2").subcategory.name, "赔偿案例");
});

test("多个账号有同名分类时，短代号能精确落到对的账号（按名字会歧义落复核）", () => {
  // 两份报告的大类名**完全相同**（「不合并」的后果），只有代号能区分
  const accountA = buildLibraryAccount({ report: makeReport({ id: "report-a", accountName: "账号甲" }) });
  const accountB = buildLibraryAccount({ report: makeReport({ id: "report-b", accountName: "账号乙" }) });
  const dictionary = buildTagDictionary([accountA, accountB]);
  const categories = normalizeTopicLibrary(dictionary);
  assert.equal(categories.length, 4, "两个账号各 2 个大类");

  const report = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500)],
    categories,
    transcripts: new Map(),
    agentOutput: {
      // c3 = 账号乙的第一个大类（代号按字典顺序，与账号甲的 c1/c2 区分开）
      items: [{ videoId: "v-1", categoryCode: "c3", subcategoryCode: "s1", confidence: "high" }],
    },
  });
  const item = report.items[0];
  assert.equal(item.category.id, categories[2].id, "必须精确落到账号乙那个大类");
  // 而按名字匹配是做不到的：同名的有两个 → 说不清是哪个 → 复核
  const byName = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500)],
    categories,
    transcripts: new Map(),
    agentOutput: { items: [{ videoId: "v-1", categoryName: "用工风险合规", subcategoryName: "合同协议实操" }] },
  });
  assert.equal(byName.items[0].category.name, "待人工复核", "同名歧义时按名字必须拒绝，不许猜");
});

test("打标签只接受库内真实存在的大类/小类，自造分类落「待人工复核」", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const video = makeVideo("v-1", 500);
  const report = normalizeBenchmarkTopicRefresh({
    videos: [video],
    categories,
    transcripts: new Map(),
    agentOutput: {
      items: [
        { videoId: "v-1", categoryId: "不存在的分类", subcategoryId: "也不存在", confidence: "high" },
      ],
    },
    recentDays: 7,
    minLikes: 100,
  });

  const item = report.items[0];
  assert.equal(item.category.id, "review");
  assert.equal(item.category.name, "待人工复核");
  assert.equal(item.subcategory.name, "待人工复核");
  // 自造分类必须把置信度压到 low，不能沿用模型自称的 high。
  assert.equal(item.confidence, "low");
});

test("命库内真实分类时保留模型给的置信度与依据", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const report = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500)],
    categories,
    // 有真实转写，模型的置信度才会被保留（无转写时统一压到 low，见后面的用例）。
    transcripts: new Map([["v-1", { text: "真实口播脚本" }]]),
    agentOutput: {
      items: [{
        videoId: "v-1",
        categoryId: "cat-risk",
        subcategoryId: "sub-onboard",
        confidence: "high",
        basis: "讲的是试用期合规",
      }],
    },
  });

  const item = report.items[0];
  assert.equal(item.category.name, "用工风险合规");
  assert.equal(item.subcategory.name, "入职合规");
  assert.equal(item.confidence, "high");
  assert.equal(item.basis, "讲的是试用期合规");
});

test("完整脚本优先用转写，取不到才退回发布文案，并如实标出来源", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const videos = [makeVideo("v-with", 500), makeVideo("v-without", 500)];
  const report = normalizeBenchmarkTopicRefresh({
    videos,
    categories,
    transcripts: new Map([["v-with", { text: "这是真实口播的完整脚本" }]]),
    agentOutput: { items: [] },
  });

  const withTranscript = report.items.find(item => item.video.id === "v-with");
  const withoutTranscript = report.items.find(item => item.video.id === "v-without");

  assert.equal(withTranscript.scriptSource, "transcript");
  assert.equal(withTranscript.script, "这是真实口播的完整脚本");
  assert.equal(withoutTranscript.scriptSource, "caption");
  // 拿不到转写时退回发布文案 —— 但绝不把它冒充成完整脚本。
  assert.equal(withoutTranscript.script, "发布文案");
  assert.equal(report.transcriptCount, 1);
  assert.equal(report.captionFallbackCount, 1);
});

test("发给 Agent 的输入带库词典与转写，且视频已按点赞门槛过滤", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const input = buildBenchmarkTopicRefreshInput({
    videos: [makeVideo("v-ok", 500), makeVideo("v-low", 10)],
    categories,
    transcripts: new Map([["v-ok", { text: "完整脚本" }]]),
    recentDays: 7,
    minLikes: 100,
  });

  assert.equal(input.recentDays, 7);
  assert.equal(input.minLikes, 100);
  assert.deepEqual(input.videos.map(video => video.videoId), ["v-ok"]);
  assert.equal(input.videos[0].transcript, "完整脚本");
  assert.equal(input.topicLibrary.length, 2);
  // 词典里必须带判断依据，模型才能按核心功能归类。
  assert.equal(input.topicLibrary[0].coreFunction, "帮老板提前规避用工与合同风险");
});

test("Agent 失败时的兜底只用库内分类名/关键词命中，不发明新标签", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const matched = buildHeuristicBenchmarkTopicRefresh({
    videos: [makeVideo("v-hit", 500, { title: "劳动合同怎么签", sourceText: "入职合规" })],
    categories,
    transcripts: new Map(),
  });

  assert.equal(matched.analysisSource, "heuristic");
  assert.equal(matched.warnings[0].code, "BENCHMARK_TOPIC_REFRESH_AGENT_FAILED");
  assert.equal(matched.items[0].category.name, "用工风险合规");
  assert.equal(matched.items[0].subcategory.name, "入职合规");
  // 兜底命中的置信度必须低 —— 关键词命中不等于模型判断。
  assert.equal(matched.items[0].confidence, "low");
});

test("兜底匹配不上的视频落「待人工复核」，不会凭空编一个分类", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const report = buildHeuristicBenchmarkTopicRefresh({
    videos: [makeVideo("v-nomatch", 500, { title: "完全无关的标题", sourceText: "无关文案" })],
    categories,
    transcripts: new Map(),
  });

  assert.equal(report.items[0].category.name, "待人工复核");
  assert.equal(report.items[0].subcategory.name, "待人工复核");
});

// ─────────────────────────────────────────────────────────────────────────────
// 以下为本轮 code review 后补的回归测试：每一条都对应一个**已修掉的真实缺陷**。
// 这些测试在修复前都是红的 —— 别把它们改回去。
// ─────────────────────────────────────────────────────────────────────────────

test("★ 业务下界仍然生效：负数被夹到 0，报告回显的是夹过的值", () => {
  // 🔴 2026-09-28 口径变更（用户拍板）：点赞门槛改为**可自定义**，业务下界从 100 放开到 0。
  //    这条测试原本钉的是「不传/传 0/传负数 都仍是严格大于 100」—— 那是旧口径下
  //    「防调用方绕过业务下界」的保护。下界放开后，**保护本身要保留、只换下界**：
  //    负数依然是非法输入（"至少 -50 个赞"没有意义），必须被夹取，不能原样生效。
  const videos = [makeVideo("v-1", 1), makeVideo("v-100", 100), makeVideo("v-101", 101)];

  // 不传门槛 → 用默认 100（不是 0），1 个赞的不会被放进来
  assert.deepEqual(normalizeTopicRefreshVideos(videos).map(v => v.id), ["v-100", "v-101"]);
  // 显式传 0 → 门槛就是 0，全部纳入（新口径允许，不是漏洞）
  assert.deepEqual(normalizeTopicRefreshVideos(videos, { minLikes: 0 }).map(v => v.id), ["v-1", "v-100", "v-101"]);
  // 负数 → 夹回下界 0（非法输入不能被当成"负门槛"生效）
  assert.deepEqual(normalizeTopicRefreshVideos(videos, { minLikes: -50 }).map(v => v.id), ["v-1", "v-100", "v-101"]);
  // 报告里回显的门槛必须是夹过的值，不能把 -50 原样回显出去
  assert.equal(buildBenchmarkTopicRefreshInput({ videos, categories: [], transcripts: new Map(), minLikes: -50 }).minLikes, 0);
});

test("★ 多账号同名分类时，模型只回分类名不得静默绑到第一个账号", () => {
  // 两个账号各有一个叫「风险防御」的大类，小类名也不同。
  const categories = normalizeTopicLibrary([
    { id: "report-a::cx", name: "风险防御", subcategories: [{ id: "report-a::cx::s1", name: "甲子类" }] },
    { id: "report-b::cx", name: "风险防御", subcategories: [{ id: "report-b::cx::s1", name: "乙子类" }] },
  ]);

  const byName = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500)],
    categories,
    transcripts: new Map(),
    // 只回名字 —— 提示词只授权 id，这是越权输入。
    agentOutput: { items: [{ videoId: "v-1", categoryName: "风险防御", subcategoryName: "甲子类", confidence: "high" }] },
  });
  assert.equal(byName.items[0].category.name, "待人工复核", "同名歧义时不许猜账号");
  assert.equal(byName.items[0].confidence, "low");

  // 回 id 时正常命中（id 带账号作用域，是唯一权威）。
  const byId = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500)],
    categories,
    transcripts: new Map([["v-1", { text: "真实口播脚本" }]]),
    agentOutput: { items: [{ videoId: "v-1", categoryId: "report-b::cx", subcategoryId: "report-b::cx::s1", confidence: "high" }] },
  });
  assert.equal(byId.items[0].category.id, "report-b::cx");
  assert.equal(byId.items[0].subcategory.name, "乙子类");
  assert.equal(byId.items[0].confidence, "high");
});

test("★ 名称唯一时仍可按名命中（不过度收紧）", () => {
  const categories = normalizeTopicLibrary([
    { id: "c1", name: "用工风险合规", subcategories: [{ id: "s1", name: "合同协议实操" }] },
    { id: "c2", name: "劳动仲裁案例", subcategories: [{ id: "s2", name: "赔偿案例" }] },
  ]);
  const report = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500)],
    categories,
    // 给一份转写：否则会被「无转写 → 置信度压到 low」那条规则影响，混淆本用例的意图。
    transcripts: new Map([["v-1", { text: "真实口播脚本" }]]),
    agentOutput: { items: [{ videoId: "v-1", categoryName: "劳动仲裁案例", subcategoryName: "赔偿案例", confidence: "medium" }] },
  });
  assert.equal(report.items[0].category.name, "劳动仲裁案例");
  assert.equal(report.items[0].subcategory.name, "赔偿案例");
  assert.equal(report.items[0].confidence, "medium");
});

test("★ 没有真实转写时置信度不得继承模型的 high", () => {
  const categories = normalizeTopicLibrary(makeReport().categories);
  const report = normalizeBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500)],
    categories,
    transcripts: new Map(), // 没有转写 → scriptSource 是 caption
    agentOutput: { items: [{ videoId: "v-1", categoryId: "cat-risk", subcategoryId: "sub-onboard", confidence: "high" }] },
  });
  const item = report.items[0];
  assert.equal(item.scriptSource, "caption");
  assert.equal(item.confidence, "low", "只有发布文案时不许声称高置信度");
  // 界面会同时显示「发布文案推断」和置信度，两者不能自相矛盾。
  assert.match(item.basis, /待人工复核|依据不足/);
});

test("★ 无 id、无链接的报告重复入库必须得到同一个 accountKey（与它在库里的位置无关）", () => {
  const anonymous = {
    reportType: "benchmark_classification",
    accountName: "无链接账号",
    account: { name: "无链接账号", platform: "douyin" },
    categories: makeReport().categories,
  };
  const first = buildLibraryAccount({ report: anonymous });
  // 关键：换个位置（模拟库里已有 2 个账号时再存一次）必须还是同一个 key，
  // 否则去重落空、同一账号被追加成两份。
  const later = buildLibraryAccount({ report: anonymous });
  assert.equal(first.accountKey, later.accountKey);
  assert.ok(!/^account-\d/.test(first.accountKey), "key 里不许掺入位置下标");
});

test("★ 占比保留一位小数，不退化成整数", () => {
  const account = buildLibraryAccount({ report: makeReport({
    categories: [{
      id: "cat-x", name: "小占比", coreFunction: "x", keywords: [],
      count: 5, percentage: 8.3,
      subcategories: [{ id: "sub-x", name: "子类", description: "" }],
    }],
  }) });
  assert.equal(cats(account)[0].percentage, 8.3);
});

test("★ 库条目不再带恒空的 selectedVideoIds（它只存在于已保存报告的包装层）", () => {
  const account = buildLibraryAccount({ report: makeReport() });
  assert.equal("selectedVideoIds" in account, false);
});

test("★ 多账号同名分类的标签词典仍能区分归属（id 不撞、label 带前缀）", () => {
  const a = buildLibraryAccount({ report: makeReport({ id: "ra", accountName: "同名账号" }) });
  const b = buildLibraryAccount({ report: makeReport({ id: "rb", accountName: "同名账号" }) });
  const dict = buildTagDictionary([a, b]);
  assert.notEqual(dict[0].id, dict[1].id);
  assert.notEqual(cats(a)[0].subcategories[0].id, cats(b)[0].subcategories[0].id);
  // 所有大类和子类的 id 在整本词典里必须唯一。
  const allIds = dict.flatMap(entry => [entry.id, ...entry.subcategories.map(sub => sub.id)]);
  assert.equal(new Set(allIds).size, allIds.length, "词典 id 必须全局唯一");
});

test("★ 兜底路径同样不猜同名分类", () => {
  const categories = normalizeTopicLibrary([
    { id: "report-a::cx", name: "风险防御", coreFunction: "", keywords: ["仲裁"], subcategories: [{ id: "report-a::cx::s1", name: "甲子类" }] },
    { id: "report-b::cx", name: "风险防御", coreFunction: "", keywords: ["仲裁"], subcategories: [{ id: "report-b::cx::s1", name: "乙子类" }] },
  ]);
  const report = buildHeuristicBenchmarkTopicRefresh({
    videos: [makeVideo("v-1", 500, { title: "仲裁怎么办", sourceText: "仲裁" })],
    categories,
    transcripts: new Map(),
  });
  // 两个账号都有同一关键词 → 命中不唯一 → 待人工复核，而不是绑到账号 A。
  assert.equal(report.items[0].category.name, "待人工复核");
});

// ─────────────────────────────────────────────────────────────────────────────
// 正式选题库要纳入「三份分析」（2026-09-21 用户要求）：
// 2.1 分类 + 2.2 黄金三秒 + 2.3 结尾钩子。
// ─────────────────────────────────────────────────────────────────────────────

test("★ 库条目存三份分析；只给分类报告时，2.2/2.3 如实标 missing", () => {
  const account = buildLibraryAccount({ report: makeReport() });
  assert.deepEqual(Object.keys(account.analyses).sort(), ["classification", "endingHooks", "goldThreeSeconds"]);
  assert.equal(account.analyses.classification.status, "included");
  assert.equal(account.analyses.classification.categories.length, 2);
  // 没跑过 2.2/2.3 就标 missing —— 不拿别的报告顶替，也不假装有。
  assert.equal(account.analyses.goldThreeSeconds.status, "missing");
  assert.equal(account.analyses.endingHooks.status, "missing");
  assert.equal(account.analyses.goldThreeSeconds.report, null);
});

test("★ 传入 2.2/2.3 报告时进库，并记下来源报告 id 与分析时间", () => {
  const account = buildLibraryAccount({
    report: makeReport(),
    goldThreeSeconds: { id: "g1", report: { reportType: "gold_three_seconds", analyzedAt: "2026-09-20T01:00:00.000Z" } },
    endingHooks: { id: "e1", report: { reportType: "ending_hooks", analyzedAt: "2026-09-21T02:00:00.000Z" } },
  });
  assert.equal(account.analyses.goldThreeSeconds.status, "included");
  assert.equal(account.analyses.goldThreeSeconds.reportId, "g1");
  assert.equal(account.analyses.goldThreeSeconds.analyzedAt, "2026-09-20T01:00:00.000Z");
  assert.equal(account.analyses.endingHooks.status, "included");
  assert.equal(account.analyses.endingHooks.reportId, "e1");
  // 三份分析的正文都要留着，不能只留状态。
  assert.equal(account.analyses.goldThreeSeconds.report.reportType, "gold_three_seconds");
  assert.equal(account.analyses.endingHooks.report.reportType, "ending_hooks");
});

test("★ 标签词典仍然只取分类树（2.2/2.3 不参与打标签的词典）", () => {
  const account = buildLibraryAccount({
    report: makeReport(),
    goldThreeSeconds: { id: "g1", report: { reportType: "gold_three_seconds" } },
    endingHooks: { id: "e1", report: { reportType: "ending_hooks" } },
  });
  const dict = buildTagDictionary([account]);
  // makeReport 有 2 个大类，各带小类 → 词典 2 条，且都来自 classification。
  assert.equal(dict.length, 2);
  assert.equal(dict[0].name, "用工风险合规");
});

test("★ 旧库文档（只有顶层 categories、没有 analyses）仍能读出分类树", () => {
  // 序列化层要能兜住 2026-09-21 之前入库的形状，否则老库会「分类全没了」。
  const legacy = {
    accountKey: "report-old", accountName: "老库账号", contentStyle: "spoken",
    categories: [{ id: "report-old::c1", name: "旧大类", coreFunction: "f", keywords: [], count: 3, percentage: 100, subcategories: [{ id: "report-old::c1::s1", name: "旧小类" }] }],
  };
  const dict = buildTagDictionary([legacy]);
  assert.equal(dict.length, 1);
  assert.equal(dict[0].name, "旧大类");
  assert.equal(dict[0].subcategories[0].name, "旧小类");
});
