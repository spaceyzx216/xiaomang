import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_VIDEO_CONCURRENCY,
  mapWithConcurrency,
  mergeTopicContent,
  summarizeTopicAnalysis,
} from "../../web/src/app/topicAnalysisPipeline.ts";
import { transcribableVideos } from "../../web/src/app/topicContentRules.ts";

/**
 * 「今日选题」逐条并行流水线的契约测试（2026-09-24，用户方案一）。
 *
 * 这里钉的都是**静默出错**那类不变量 —— 并行代码出错往往不抛异常，只会
 * 「少跑几条」「失败被算成成功」「进度永远停在 N-1」，界面上看着一切正常。
 */

/** 可控延迟，用来验证并发确实重叠。 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("并发有界：同时进行的任务数不超过 limit（不能一次性全发出去打满后端）", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);

  await mapWithConcurrency(items, 3, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay(5);
    inFlight -= 1;
    return true;
  });

  assert.equal(peak, 3, `峰值并发应为 3，实际 ${peak}`);
});

test("结果按输入顺序返回，不是完成顺序（否则进度看起来会乱跳）", async () => {
  const items = [0, 1, 2, 3, 4];
  const results = await mapWithConcurrency(items, 3, async item => {
    // 越靠前的越慢：完成顺序与输入顺序相反
    await delay((items.length - item) * 4);
    return `r${item}`;
  });
  assert.deepEqual(results, ["r0", "r1", "r2", "r3", "r4"]);
});

test("单条失败不带走整批：那一条记 null，其余照常完成", async () => {
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async item => {
    if (item === 2) throw new Error("这条坏了");
    return item * 10;
  });
  assert.deepEqual(results, [10, null, 30, 40], "坏的那条必须是 null，其他条不能被牵连");
});

test("空输入与 limit 越界都不炸", async () => {
  assert.deepEqual(await mapWithConcurrency([], 3, async () => 1), []);
  // limit 大于条数 / 为 0 / 为负数：都退化成至少 1，不会死循环也不会不动
  assert.deepEqual(await mapWithConcurrency([1, 2], 99, async n => n), [1, 2]);
  assert.deepEqual(await mapWithConcurrency([1, 2], 0, async n => n), [1, 2]);
  assert.deepEqual(await mapWithConcurrency([1, 2], -5, async n => n), [1, 2]);
});

test("mergeTopicContent 返回新对象且不改入参（React 靠引用变化重渲染）", () => {
  const before = {};
  const after = mergeTopicContent(before, "v1", { script: "脚本", scriptSource: "transcript", categoryId: "c1", categoryName: "大类A" });
  assert.notEqual(after, before, "必须返回新对象");
  assert.equal(Object.keys(before).length, 0, "不能改入参");
  assert.equal(after.v1.script, "脚本");
  assert.equal(after.v1.categoryName, "大类A");

  // 缺字段时给安全的默认值，而不是 undefined（前端直接渲染这些字段）
  const sparse = mergeTopicContent({}, "v2", {});
  assert.equal(sparse.v2.script, "");
  assert.equal(sparse.v2.scriptSource, "caption");
  assert.equal(sparse.v2.categoryId, "");
  assert.equal(sparse.v2.confidence, "low");

  // 空 videoId 必须原样返回，不能造出一个 "" 的键
  assert.equal(mergeTopicContent(after, "", { script: "x" }), after);
});

test("进度汇总：处理数只数已完成的，失败的单独算，不混进成功", () => {
  const content = {
    a: { script: "s", scriptSource: "transcript", categoryId: "c1", categoryName: "A", subcategoryName: "", confidence: "high", basis: "" },
    b: { script: "s", scriptSource: "caption", categoryId: "review", categoryName: "待人工复核", subcategoryName: "", confidence: "low", basis: "" },
    c: { script: "s", scriptSource: "transcript", categoryId: "c2", categoryName: "B", subcategoryName: "", confidence: "high", basis: "" },
  };
  const summary = summarizeTopicAnalysis(["done", "done", "failed", "transcribing"], content, 4);

  assert.equal(summary.processed, 3, "done + failed 才算已处理");
  assert.equal(summary.failed, 1);
  // scriptCount 只数真转写：caption 那条不算
  assert.equal(summary.scriptCount, 2);
  // taggedCount 只数命中库内大类且不是"待人工复核"
  assert.equal(summary.taggedCount, 2);
  assert.match(summary.message, /正在提取脚本 1 条/, "要说出当前还有几条在提脚本");
});

test("进度汇总：打标签阶段优先显示打标签，且总量为 0 时不崩", () => {
  const tagging = summarizeTopicAnalysis(["tagging", "tagging"], {}, 2);
  assert.match(tagging.message, /正在打标签 2 条/);
  assert.equal(tagging.processed, 0);

  const empty = summarizeTopicAnalysis([], {}, 0);
  assert.equal(empty.processed, 0);
  assert.equal(empty.failed, 0);
  assert.match(empty.message, /正在收尾/);
});

test("transcribableVideos 不再要求标题 —— 无描述发布也要能被分析", () => {
  const topics = [
    { id: "v1", title: "有标题", link: "https://x/1", stats: { likes: 200 } },
    { id: "v2", title: "", link: "https://x/2", stats: { likes: 200 } },     // 无描述发布
    { id: "v3", title: "没链接", link: "", stats: { likes: 200 } },          // 提不了脚本
    { id: "", title: "没 id", link: "https://x/4", stats: { likes: 200 } },  // 无法对齐
  ];
  const videos = transcribableVideos(topics);
  assert.deepEqual(videos.map(v => v.id), ["v1", "v2"], "缺 title 不能把条目静默丢掉");
});

test("MAX_VIDEO_CONCURRENCY 是个有界的小数 —— 调大之前先想清楚后端压力", () => {
  assert.ok(Number.isInteger(MAX_VIDEO_CONCURRENCY));
  assert.ok(MAX_VIDEO_CONCURRENCY >= 1 && MAX_VIDEO_CONCURRENCY <= 8, "超过 8 会把 TikHub/ASR/DeepSeek 一起打满");
});

// ── 二创复用「选题页已提取的脚本」（2026-09-28）──────────────────────────
// 选题页近 7 天已经把脚本提好了；二创再解析+转写一遍是纯重复劳动
// （TikHub 3~7s + 整条转写 10~45s 每条）。这里钉住解析入口的契约。

test("getExtractedScriptsFromBody：接受 benchmark_videos 数组形状，按链接对齐", async () => {
  const { getExtractedScriptsFromBody } = await import("../api/_lib/contentAgent/adapter.js");
  const map = getExtractedScriptsFromBody({
    parameters: {
      share_links: "https://v.douyin.com/aaa\nhttps://v.douyin.com/bbb",
      benchmark_videos: [
        { link: "https://v.douyin.com/aaa", title: "标题A", script: "脚本A" },
        { link: "https://v.douyin.com/bbb", title: "标题B", script: "" },   // 空脚本不算
        { link: "", title: "无链接", script: "脚本C" },                      // 无链接不算
      ],
    },
  });
  assert.equal(map.size, 1, "只有真的带脚本的条目才进表");
  assert.deepEqual(map.get("https://v.douyin.com/aaa"), { script: "脚本A", title: "标题A" });
  assert.equal(map.has("https://v.douyin.com/bbb"), false, "空脚本不能被当成已有脚本");
});

test("getExtractedScriptsFromBody：也接受 { 链接: 脚本 } 映射形状", async () => {
  const { getExtractedScriptsFromBody } = await import("../api/_lib/contentAgent/adapter.js");
  const map = getExtractedScriptsFromBody({ parameters: { scripts: { "https://x/1": "脚本1" } } });
  assert.equal(map.get("https://x/1")?.script, "脚本1");
});

test("getExtractedScriptsFromBody：没带就是空表（老入口/纯手贴链接照旧自己转写）", async () => {
  const { getExtractedScriptsFromBody } = await import("../api/_lib/contentAgent/adapter.js");
  assert.equal(getExtractedScriptsFromBody({}).size, 0);
  assert.equal(getExtractedScriptsFromBody({ parameters: {} }).size, 0);
  assert.equal(getExtractedScriptsFromBody({ parameters: { benchmark_videos: "不是数组" } }).size, 0);
});

test("getExtractedScriptsFromBody：同一链接重复出现时以第一条为准（顺序稳定）", async () => {
  const { getExtractedScriptsFromBody } = await import("../api/_lib/contentAgent/adapter.js");
  const map = getExtractedScriptsFromBody({
    parameters: {
      benchmark_videos: [
        { link: "https://x/dup", script: "第一个", title: "T1" },
        { link: "https://x/dup", script: "第二个", title: "T2" },
      ],
    },
  });
  assert.equal(map.get("https://x/dup").script, "第一个");
});

// ── 重建后复用上次分析结果（2026-09-28）────────────────────────────────
// 选题页 →「开始二创」→ 返回，路由会让组件卸载重建。不持久化的话每返回一次就整批
// 重跑：转写有后端缓存兜着（快），但**打标签要重跑 DeepSeek**，是真实的钱。
// 前端没有渲染测试基建，所以判断逻辑抽成纯函数在这里钉住。

test("scope 指纹：客户 / 窗口 / 视频集合任一变化都要变（否则会复用错批次）", async () => {
  const { buildTopicAnalysisScopeKey } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  const base = buildTopicAnalysisScopeKey("cust-1", 7, ["a", "b"]);
  assert.equal(base, buildTopicAnalysisScopeKey("cust-1", 7, ["a", "b"]), "同样的输入必须稳定");
  assert.notEqual(base, buildTopicAnalysisScopeKey("cust-2", 7, ["a", "b"]), "换客户 → 词典换了");
  assert.notEqual(base, buildTopicAnalysisScopeKey("cust-1", 15, ["a", "b"]), "换窗口 → 视频集合换了");
  assert.notEqual(base, buildTopicAnalysisScopeKey("cust-1", 7, ["a", "b", "c"]), "抓到新视频 → 还没分析过");
  assert.notEqual(base, buildTopicAnalysisScopeKey("cust-1", 7, ["b", "a"]), "顺序变了也算不同批次（宁可可重跑，不复用错批次）");
});

test("canReuseTopicAnalysis：指纹一致且有内容 → 复用", async () => {
  const { canReuseTopicAnalysis } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  assert.equal(canReuseTopicAnalysis({ currentKey: "k1", savedKey: "k1", contentCount: 6 }), true);
});

test("canReuseTopicAnalysis：换任务/换窗口/新视频 → 必须重新分析", async () => {
  const { canReuseTopicAnalysis } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  assert.equal(canReuseTopicAnalysis({ currentKey: "k2", savedKey: "k1", contentCount: 6 }), false);
  assert.equal(canReuseTopicAnalysis({ currentKey: "k1", savedKey: "", contentCount: 6 }), false, "首次进入没有历史指纹");
  assert.equal(canReuseTopicAnalysis({ currentKey: "", savedKey: "", contentCount: 6 }), false, "指纹算不出来就不能复用");
});

test("canReuseTopicAnalysis：上次是空结果 → 重新跑（不要把没分析出东西当成已完成）", async () => {
  const { canReuseTopicAnalysis } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  assert.equal(canReuseTopicAnalysis({ currentKey: "k1", savedKey: "k1", contentCount: 0 }), false);
  // 边界：缺失字段不能抛异常，按"不复用"处理（宁可多跑一次，也不要拿空结果糊弄）
  assert.equal(canReuseTopicAnalysis({ currentKey: "k1", savedKey: "k1" }), false);
  assert.equal(canReuseTopicAnalysis({}), false);
  assert.equal(canReuseTopicAnalysis(null), false);
});

// ── 视频号选题：选题页提取 + 二创复用（2026-09-28）──────────────────────
// 视频号的媒体在 CDN 上且被 Isaac64 加密，**没有分享链接**，必须靠 mediaUrl +
// decodeKey 在本地解密后转写。原来选题页一律要求 `link`，于是视频号在第一步就被
// 静默丢掉 —— 表现是"选题页永远分析不了视频号"，且不报错。

const wechatTopic = (overrides = {}) => ({
  id: "wechat_channels:abc123",
  title: "视频号选题",
  link: "",
  platform: "wechat_channels",
  stats: { likes: 500 },
  source: { platform: "wechat_channels", mediaUrl: "https://finder.video.qq.com/x/v.mp4", decodeKey: "deadbeef" },
  rawData: { media: { url: "https://finder.video.qq.com/x/v.mp4", decode_key: "deadbeef" } },
  ...overrides,
});

test("视频号选题要能进入转写列表（凭 mediaUrl + decodeKey，不是 link）", async () => {
  const { transcribableVideos } = await import("../../web/src/app/topicContentRules.ts");
  const listed = transcribableVideos([wechatTopic()]);
  assert.equal(listed.length, 1, "视频号不能被 link 过滤掉 —— 它本来就没有分享链接");
  assert.equal(listed[0].platform, "wechat_channels");
  assert.equal(listed[0].mediaUrl, "https://finder.video.qq.com/x/v.mp4", "媒体直链必须带下去");
  assert.equal(listed[0].decodeKey, "deadbeef", "解密密钥必须带下去，否则本地解密无从下手");

  // 缺任一必备字段就不能转写（如实排除，不硬送）
  assert.equal(transcribableVideos([wechatTopic({ source: {}, rawData: {} })]).length, 0, "缺媒体字段应排除");
  assert.equal(
    transcribableVideos([wechatTopic({ source: { platform: "wechat_channels", mediaUrl: "https://x/v.mp4" }, rawData: {} })]).length,
    0,
    "缺 decodeKey 应排除（有直链也解不开）",
  );
});

test("后端必须认视频号平台 —— 不能在归一化时被压成 douyin", async () => {
  const { normalizeTopicRefreshVideos } = await import("../api/_lib/benchmarkTopicRefresh.js");
  const kept = normalizeTopicRefreshVideos([
    { id: "wechat_channels:abc123", title: "T", platform: "wechat_channels", link: "", stats: { likes: 500 }, mediaUrl: "https://x/v.mp4", decodeKey: "k" },
    { id: "d1", title: "T", platform: "douyin", link: "https://www.douyin.com/video/1", stats: { likes: 500 } },
  ], { minLikes: 100 });
  assert.deepEqual(kept.map(v => v.platform).sort(), ["douyin", "wechat_channels"]);
  // 🔴 回归防线：本地曾有一份 `=== "tiktok" ? "tiktok" : "douyin"` 的 normalizePlatform，
  //    把视频号压成 douyin，然后被"抖音必须有 link"的规则丢掉 —— 静默丢数据。
  const wechat = kept.find(v => v.id === "wechat_channels:abc123");
  assert.ok(wechat, "视频号不能被压成 douyin 后被过滤掉");
  assert.equal(wechat.mediaUrl, "https://x/v.mp4");
  assert.equal(wechat.decodeKey, "k");
});

test("转写目标按平台分流：视频号走本地解密，不能去解析 TikHub", async () => {
  const { selectTranscriptTargets, resolveTargetVideo } = await import("../api/_lib/goldThreeSecondTranscripts.js");
  const targets = selectTranscriptTargets({
    videos: [
      { id: "wechat_channels:abc123", title: "视频号", platform: "wechat_channels", link: "", mediaUrl: "https://x/v.mp4", decodeKey: "k", stats: { likes: 500 } },
      { id: "d1", title: "抖音", platform: "douyin", link: "https://www.douyin.com/video/1", stats: { likes: 500 } },
    ],
  }, 60);
  assert.equal(targets.length, 2, "两类都要进目标");
  const wechat = targets.find(t => t.platform === "wechat_channels");
  assert.equal(wechat.mediaUrl, "https://x/v.mp4");
  assert.equal(wechat.decodeKey, "k");

  // 视频号解析**不发任何网络请求**（纯本地构造），所以这里不需要 stub fetch 就能过
  const video = resolveTargetVideo(wechat, {});
  assert.equal(video.platform, "wechat_channels");
  assert.equal(video.videoUrl, "https://x/v.mp4");
  assert.equal(video.decodeKey, "k");
});

test("二创复用脚本：视频号的键必须与后端 topicWorkflowKey 同口径", async () => {
  const { getExtractedScriptsFromBody } = await import("../api/_lib/contentAgent/adapter.js");
  // 前端发的键（ContentPage 用 getTopicWorkflowKey 算）与后端 index.js 的 topicWorkflowKey
  // 必须是同一个字符串 —— 差一个字符复用就静默失效，退回现场解密+转写。
  const topic = wechatTopic();
  const frontendKey = (() => {
    const source = topic.source || {};
    const rawData = topic.rawData || {};
    const id = source.objectId || rawData.id || rawData.object_id || rawData.objectId
      || topic.id || source.objectNonceId || rawData.object_nonce_id || rawData.objectNonceId
      || topic.title || "topic";
    return `wechat_channels:${String(id).replace(/^wechat_channels:/, "")}`;
  })();
  const map = getExtractedScriptsFromBody({
    parameters: { benchmark_videos: [{ link: frontendKey, title: topic.title, script: "视频号已提取脚本" }] },
  });
  assert.equal(map.get(frontendKey)?.script, "视频号已提取脚本");
  // 归一化后应当去掉重复前缀（topic.id 自带 wechat_channels:）
  assert.ok(!frontendKey.includes("wechat_channels:wechat_channels:"), `键被重复加前缀了: ${frontendKey}`);
});

// ── 「谁先跑完谁先显示」（2026-09-28 用户实测反馈）──────────────────────
// 症状：选题列表要等**全部**处理完才显示，而不是像抖音那样一条好了就出一条。
// 根因不在网络，在**上报时机**：`mapWithConcurrency` 的结果是**按输入顺序**收集的，
// 早先的写法是 `await` 它之后再循环合并标签 —— 那个循环要等最慢的一条。
// 下面两条把"完成即上报"这个契约钉住。

test("★ 完成顺序 ≠ 输入顺序：先跑完的必须先被上报（不能等最慢的）", async () => {
  const items = ["慢", "快", "中"];
  const delays = [40, 5, 15];
  const order = [];

  await mapWithConcurrency(items, 3, async (label, index) => {
    await delay(delays[index]);
    // worker 自己上报 —— 这正是修复后的写法
    order.push(label);
  });

  assert.deepEqual(order, ["快", "中", "慢"],
    "上报顺序必须按**完成**顺序；若按输入顺序返回，就说明又退回了「等全部跑完」");
});

test("★ 反面对照：先收集再统一合并 = 标签要等最慢的一条（说明为什么不能那样写）", async () => {
  const delays = [40, 5, 15];
  const collectedAt = [];

  // 旧写法：await 结果 → 再按输入顺序合并
  const results = await mapWithConcurrency(delays, 3, async (ms, index) => {
    await delay(ms);
    return index;
  });
  for (const r of results) collectedAt.push(r);

  // 结果按输入顺序（0,1,2）而不是完成顺序（1,2,0）—— 这就是「都跑完才显示」的来源
  assert.deepEqual(results, [0, 1, 2], "mapWithConcurrency 按输入顺序返回（这正是它的契约）");
  assert.notDeepEqual(collectedAt, [1, 2, 0],
    "若这里相等，说明 mapWithConcurrency 改成了完成顺序，上面那条测试的意义要重新评估");
});

test("完成即上报：单条失败不影响其他条继续上报", async () => {
  const seen = [];
  await mapWithConcurrency([1, 2, 3, 4], 2, async item => {
    await delay(5);
    if (item === 2) throw new Error("这条坏了");
    seen.push(item);
  });
  assert.deepEqual(seen.sort(), [1, 3, 4], "坏的那条不该带走其他条的上报");
});

// ── 方案二：攒批打标签（2026-09-28）─────────────────────────────────────
// 原来每条视频单独调一次打标签（一次 DeepSeek），60 条 = 60 次串行等待。
// 现在攒够一批再一次发出去，用一次模型调用换多条。
//
// 🔴 最容易出的错是 **flush**：最后不足一批的条目若不被交出去，症状是
//    「大部分出来了，尾巴几条永远转圈」——极难定位，所以单独钉。

test("攒批：凑满一批立刻交出去，不等全部到齐", async () => {
  const { createBatcher } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  const batches = [];
  const batcher = createBatcher(4, batch => batches.push([...batch]));

  for (let i = 1; i <= 4; i++) batcher.add(i);
  assert.deepEqual(batches, [[1, 2, 3, 4]], "第 4 条一到就该发，不必等更多");
  assert.equal(batcher.pending(), 0);
});

test("★ flush 必须交掉尾巴：否则最后不足一批的条目永远不被打标签", async () => {
  const { createBatcher } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  const batches = [];
  const batcher = createBatcher(4, batch => batches.push([...batch]));

  for (let i = 1; i <= 6; i++) batcher.add(i);
  assert.deepEqual(batches, [[1, 2, 3, 4]], "前 4 条成一批");
  assert.equal(batcher.pending(), 2, "剩下 2 条还没交出去");

  batcher.flush();
  assert.deepEqual(batches, [[1, 2, 3, 4], [5, 6]], "flush 后尾巴必须成一批");
  assert.equal(batcher.pending(), 0);

  // 再 flush 一次不该产生空批次
  batcher.flush();
  assert.equal(batches.length, 2, "空 flush 不能产出空批次");
});

test("攒批：恰好整除时 flush 不产生多余空批次", async () => {
  const { createBatcher } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  const batches = [];
  const batcher = createBatcher(2, batch => batches.push([...batch]));
  for (const x of ["a", "b", "c", "d"]) batcher.add(x);
  batcher.flush();
  assert.deepEqual(batches, [["a", "b"], ["c", "d"]]);
});

test("攒批：size 非法值退化成 1（每条自成一批），不能吞掉条目", async () => {
  const { createBatcher } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  for (const size of [0, -3, NaN, 1.7]) {
    const batches = [];
    const batcher = createBatcher(size, batch => batches.push([...batch]));
    batcher.add("x"); batcher.add("y"); batcher.flush();
    const flat = batches.flat();
    assert.deepEqual(flat, ["x", "y"], `size=${size} 时条目被吞了`);
  }
});

test("批次大小是个有界的小数 —— 太大容易触到模型上限/超时", async () => {
  const { TOPIC_TAG_BATCH_SIZE } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  assert.ok(Number.isInteger(TOPIC_TAG_BATCH_SIZE));
  assert.ok(TOPIC_TAG_BATCH_SIZE >= 1 && TOPIC_TAG_BATCH_SIZE <= 10, "超过 10 条一次打标签风险过高");
});

// ── 分析运行的取消策略（2026-09-28 用户实测的"卡死"事故）──────────────────
// 现场：选题列表已列出 6 条视频号选题，但界面永久停在「正在读取本账号的选题库…」，
//       不报错、不推进；同时**服务端日志显示 DeepSeek 打标签正在正常调用**。
// 根因：React effect 的依赖数组里放了它自己会写的 state（topicAnalysisScope /
//       topicContent）→ effect 启动后立刻改依赖 → cleanup 执行 cancelled = true →
//       正在跑的分析被永久取消，所有 onProgress/onContent 被挡掉、结果被丢。
//
// 修复原则：**effect 的唯一依赖是"范围指纹"字符串**；其余值走 ref。
//       取消只在"这批视频真的换了"时发生。

test("★ 取消策略：只有范围指纹变了才允许取消（其余变化一律不得取消）", async () => {
  const { shouldCancelAnalysisRun } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  const key = "cust|7|a,b,c";

  // 这些都不该取消 —— 它们恰恰是"effect 自己会改的 state"，进依赖就是自我取消
  assert.equal(shouldCancelAnalysisRun(key, key), false, "同一批范围重跑不得取消");
  assert.equal(shouldCancelAnalysisRun("", key), false, "还没有范围时不得取消");

  // 换任务 / 换时间窗口 / 抓到新视频 → 必须取消旧的那次
  assert.equal(shouldCancelAnalysisRun(key, "cust|7|a,b,c,d"), true, "抓到新视频必须取消旧的");
  assert.equal(shouldCancelAnalysisRun(key, "cust|15|a,b,c"), true, "换时间窗口必须取消旧的");
  assert.equal(shouldCancelAnalysisRun(key, "other|7|a,b,c"), true, "换客户必须取消旧的");
});

test("★ decideTopicAnalysisAction：三种动作的判定", async () => {
  const { decideTopicAnalysisAction } = await import("../../web/src/app/topicAnalysisPipeline.ts");
  const key = "cust|7|a,b";
  const base = { scopeKey: key, analyzedKey: "", savedScopeKey: "", contentCount: 0 };

  assert.equal(decideTopicAnalysisAction({ ...base, scopeKey: "" }), "skip", "没有可分析选题 → 什么都不做");
  assert.equal(decideTopicAnalysisAction({ ...base, analyzedKey: key }), "skip", "本批已登记 → 不重复跑");
  assert.equal(decideTopicAnalysisAction(base), "run", "全新一批 → 跑");

  // 上次已分析完（指纹一致 + 有落地内容）→ 复用，不重新花钱
  assert.equal(
    decideTopicAnalysisAction({ ...base, savedScopeKey: key, contentCount: 3 }),
    "reuse",
    "同一批已分析过 → 复用（从二创页返回时走这条）",
  );
  // 指纹一致但内容为空 → 不能复用（上次可能什么都没分析出来，必须重跑）
  assert.equal(
    decideTopicAnalysisAction({ ...base, savedScopeKey: key, contentCount: 0 }),
    "run",
    "上次是空结果 → 重跑，别把没结果当成已完成",
  );
});

test("★ 回归防线：effect 的依赖数组里不得出现它自己会写的 state", async () => {
  // 这条是**源码级**断言：直接盯住 App.tsx 的那个 effect。
  // 上一版就是因为在依赖里放了 `topicAnalysisScope` / `topicContent` 而自我取消，
  // 表现为"界面永久停在第一句文案、后端却在正常跑"——最难查的一类。
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../../web/src/app/App.tsx", import.meta.url), "utf8");

  // 取出这个 effect 的依赖数组：`}, [...])` 紧跟在 `return () => { cancelled = true; };` 之后
  const match = source.match(/return \(\) => \{ cancelled = true; \};\s*\n\s*(?:\/\/[^\n]*\n\s*)*\}, \[([^\]]*)\]/);
  assert.ok(match, "没找到分析 effect 的依赖数组（源码结构变了？请同步更新这条测试）");
  const deps = match[1].split(",").map(s => s.trim()).filter(Boolean);
  assert.deepEqual(deps, ["topicAnalysisScopeKey"], `依赖数组只应有范围指纹，实际是 [${deps.join(", ")}]`);

  // 逐条点名：这几个都是 effect 自己会 setState 的东西，进了依赖必自我取消
  for (const forbidden of ["topicContent", "topicAnalysisScope", "qualifiedTopics", "minLikes", "topicDays", "qualifiedTopics"]) {
    assert.ok(
      !deps.includes(forbidden),
      `依赖里不能有 ${forbidden}：它会被这个 effect 自己改写（或每次渲染都是新引用），会导致"启动即自我取消"`,
    );
  }
});
