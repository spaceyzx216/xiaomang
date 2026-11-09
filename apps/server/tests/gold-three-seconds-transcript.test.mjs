// 黄金三秒「真实口播转写」链路的回归测试。
//
// 背景（2026-09-17）：在此之前，展示的「开场 3 秒文案」其实是**平台发布文案**（往往只是
// 标题加话题标签），不是视频里真正说的话。实测同一条视频：
//
//   发布文案："再这么下去，就没人敢创业了！ #老板用工 #劳动仲裁 #用工风险"
//   真实转写："再这么下去就没人敢创业了。现在民营企业说好听点叫中国经济的根……"
//
// 现在会先跑 ASR/视频理解把真实口播取回来。这些测试锁住三件事：
//   1. 有转写时，开场文案必须来自转写，并且要在报告里标明来源；
//   2. **模型自称引用了转写不算数** —— 要真能在转写原文里找到那句话，否则退回 caption；
//   3. 没有转写时，沿用原来的规则（发布文案兜底、置信度压到 low）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildGoldThreeSecondsInput,
  normalizeGoldThreeSeconds,
} from "../api/_lib/goldThreeSeconds.js";
import { createResolvePrefetch, resolveTranscriptScope, selectTranscriptTargets } from "../api/_lib/goldThreeSecondTranscripts.js";
import { TRANSCRIPT_SCOPE_HEAD, TRANSCRIPT_SCOPE_SCRIPT, TRANSCRIPT_SCOPE_TAIL } from "../api/_lib/transcriptStore.js";

// ── 2026-09-21 回归：scope 被静默收敛成 head ─────────────────────────────────
//
// 事故经过（用户实测）：2.4「提取完整脚本」转写其实**全部成功**（batch 里每条 status 都是 ok），
// 但结果被写进了 `scope: "head"` —— 因为 `transcribeTargets` 里写的是
// `scope === TAIL ? TAIL : HEAD`，只认 head/tail，把 `script` 吞掉了。连锁反应：
//   ① 完整脚本混进「开场三秒」缓存 → 2.2 会拿整篇口播当开场文案（实测 head 里混进过 540 字）；
//   ② `getTranscriptProgress({scope:"script"})` 永远查不到 → 前端以为一条都没成功，
//      反复重跑 20 轮（每轮重新下载 + ASR），又慢又重复烧钱，最后报「没在预期轮数内完成」。
//
// 这条断言看着琐碎，但它是整个事故的**唯一根因**，值得钉死。
test("转写 scope 三态原样保留：script 绝不能被收敛成 head", () => {
  assert.equal(resolveTranscriptScope(TRANSCRIPT_SCOPE_HEAD), "head");
  assert.equal(resolveTranscriptScope(TRANSCRIPT_SCOPE_TAIL), "tail");
  assert.equal(
    resolveTranscriptScope(TRANSCRIPT_SCOPE_SCRIPT),
    "script",
    "script 被收敛掉的话，完整脚本会写进开场三秒缓存，且进度永远查不到",
  );
});

test("scope 缺失或非法时才回退 head（不把未知值透传给数据库）", () => {
  assert.equal(resolveTranscriptScope(undefined), "head");
  assert.equal(resolveTranscriptScope(""), "head");
  assert.equal(resolveTranscriptScope("   "), "head");
  assert.equal(resolveTranscriptScope("bogus"), "head");
  // 大小写与空格要能容忍：调用方从 HTTP body 里拿到的字符串不保证干净
  assert.equal(resolveTranscriptScope(" script "), "script");
  assert.equal(resolveTranscriptScope("TAIL"), "tail");
});

const VIDEO = (id, likes) => ({
  id,
  title: `${id} 的标题`,
  link: `https://www.douyin.com/video/${id}`,
  authorName: "对标账号",
  publishDate: "2025/01/01",
  sourceText: `${id} 的发布文案 #标签 #话题`,
  platform: "douyin",
  stats: { likes, comments: 10, shares: 5, bookmarks: 20 },
});

const report = {
  reportType: "benchmark_classification",
  fetchMode: "latest",
  contentStyle: "spoken",
  account: { name: "演示账号", url: "https://www.douyin.com/user/demo", platform: "douyin", platformLabel: "抖音" },
  summary: "账号概括",
  categories: [{ id: "c1", name: "行业避坑", keywords: ["坑"], coreFunction: "作用", topics: [], subcategories: [] }],
  videos: [VIDEO("v1", 300), VIDEO("v2", 200), VIDEO("v3", 100)],
};

const TRANSCRIPT = "再这么下去就没人敢创业了。现在民营企业说好听点叫中国经济的根，但说难听点就是案板上的一块肉。";
const transcripts = new Map([
  ["v1", { videoId: "v1", status: "ok", text: TRANSCRIPT, provider: "tikhub-ffmpeg+doubao-asr:wav" }],
  ["v2", { videoId: "v2", status: "ok", text: "大家好，今天我们聊聊用工风险里最容易被忽略的一条。", provider: "doubao-video" }],
]);

test("转写只挂在真正有转写的那几条样本上", () => {
  const input = buildGoldThreeSecondsInput(report, { transcripts });
  const byId = new Map(input.videos.map(video => [video.videoId, video]));

  assert.equal(byId.get("v1").transcript, TRANSCRIPT);
  assert.equal(byId.get("v1").transcriptProvider, "tikhub-ffmpeg+doubao-asr:wav");
  assert.equal(byId.get("v2").transcriptProvider, "doubao-video");
  // 没有转写的样本不带这个字段，模型据此知道只能靠发布文案
  assert.equal(byId.get("v3").transcript, undefined);
  assert.equal(byId.get("v3").transcriptProvider, undefined);
});

test("模型忠实引用了转写 → 标记 transcript，并沿用模型自评的置信度", () => {
  const result = normalizeGoldThreeSeconds({
    classificationReport: report,
    transcripts,
    agentOutput: {
      items: [
        { videoId: "v1", openingText: "再这么下去就没人敢创业了。", type: "恐惧", confidence: "high", evidence: "转写原文开头" },
      ],
    },
  });
  const item = result.items.find(entry => entry.videoId === "v1");

  assert.equal(item.openingSource, "transcript");
  assert.equal(item.confidence, "high");
  assert.equal(item.openingText, "再这么下去就没人敢创业了。");
  assert.equal(item.transcriptProvider, "tikhub-ffmpeg+doubao-asr:wav");
});

test("模型复述转写时标点不同也算引用（比对先去掉空白和标点）", () => {
  const result = normalizeGoldThreeSeconds({
    classificationReport: report,
    transcripts,
    agentOutput: {
      items: [{ videoId: "v1", openingText: "再这么下去，就没人敢创业了", type: "恐惧", confidence: "high" }],
    },
  });
  assert.equal(result.items.find(entry => entry.videoId === "v1").openingSource, "transcript");
});

test("模型自称高置信、但文案根本不在转写里 → 退回 caption，不采信它的 high", () => {
  const result = normalizeGoldThreeSeconds({
    classificationReport: report,
    transcripts,
    agentOutput: {
      items: [
        // 这句话来自发布文案的标签堆砌，转写里根本没有
        { videoId: "v1", openingText: "v1 的发布文案 #标签 #话题", type: "好奇心", confidence: "high" },
      ],
    },
  });
  const item = result.items.find(entry => entry.videoId === "v1");

  assert.equal(item.openingSource, "caption", "不能因为模型说自己引用了转写就标记为真实转写");
  assert.notEqual(item.confidence, "high");
});

test("有转写但模型没给文案 → 用转写首句兜底，标 transcript / medium（不是 low）", () => {
  const result = normalizeGoldThreeSeconds({
    classificationReport: report,
    transcripts,
    agentOutput: { items: [{ videoId: "v2", type: "兴趣", evidence: "" }] },
  });
  const item = result.items.find(entry => entry.videoId === "v2");

  assert.equal(item.openingSource, "transcript");
  assert.equal(item.openingText, "大家好，今天我们聊聊用工风险里最容易被忽略的一条。");
  // 转写首句就是真实开场，比发布文案可靠，不该压到 low
  assert.equal(item.confidence, "medium");
});

test("没有转写的样本沿用原规则：发布文案兜底 + 强制 low", () => {
  const result = normalizeGoldThreeSeconds({
    classificationReport: report,
    transcripts,
    agentOutput: { items: [{ videoId: "v3", type: "痛点", evidence: "" }] },
  });
  const item = result.items.find(entry => entry.videoId === "v3");

  assert.equal(item.openingSource, "caption");
  assert.equal(item.openingText, "v3 的发布文案 #标签 #话题");
  assert.equal(item.confidence, "low");
});

test("完全不传 transcripts 时行为与改动前一致（向后兼容）", () => {
  const result = normalizeGoldThreeSeconds({
    classificationReport: report,
    agentOutput: { items: [{ videoId: "v1", openingText: "模型给的开场", type: "恐惧", confidence: "high" }] },
  });
  const item = result.items.find(entry => entry.videoId === "v1");

  assert.equal(item.openingSource, "caption");
  assert.equal(item.confidence, "high");
  assert.equal(item.openingText, "模型给的开场");
});

test("报告带上转写覆盖率，供前端告知可信度基础", () => {
  const result = normalizeGoldThreeSeconds({
    classificationReport: report,
    transcripts,
    agentOutput: {
      items: [
        { videoId: "v1", openingText: "再这么下去就没人敢创业了。", type: "恐惧", confidence: "high" },
        { videoId: "v3", type: "痛点" },
      ],
    },
  });

  assert.equal(result.transcriptCoverage.total, 3);
  assert.equal(result.transcriptCoverage.fromTranscript, 2); // v1 引用了转写，v2 走转写兜底
  assert.equal(result.transcriptCoverage.fromCaption, 1);    // v3 没有转写
});

test("转写目标与三秒分析取的是同一批样本（点赞降序、只保留有链接的）", () => {
  const targets = selectTranscriptTargets(report, 20);
  assert.deepEqual(targets.map(item => item.videoId), ["v1", "v2", "v3"]);
  assert.equal(targets[0].platform, "douyin");

  const withBrokenLink = {
    ...report,
    videos: [...report.videos, { ...VIDEO("v4", 999), link: "" }],
  };
  // 没链接就没法转写，直接排除
  assert.deepEqual(selectTranscriptTargets(withBrokenLink, 20).map(item => item.videoId), ["v1", "v2", "v3"]);
});

// ---------------------------------------------------------------------------
// 解析预取窗口（2026-09-17）
//
// TikHub 解析实测 3.4~4.7s/条，比裁剪后的转写(~1.7s)还慢，所以让它提前、更宽地跑，
// 转写 worker 直接取现成结果。这里锁住三件事：宽度有界、失败不炸、不预取时行为不变。
// ---------------------------------------------------------------------------

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("预取宽度不超过 windowSize", async () => {
  let inFlight = 0;
  let peak = 0;
  const prefetch = createResolvePrefetch({
    count: 20,
    windowSize: 4,
    resolve: async index => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      return index;
    },
  });
  await tick();
  assert.equal(peak <= 4, true, `并发峰值 ${peak} 超过 windowSize=4`);
  assert.equal(prefetch.inFlight() <= 4, true);

  for (let i = 0; i < 20; i += 1) {
    const result = await prefetch.take(i);
    assert.equal(result.ok, true);
    assert.equal(result.value, i);
  }
  assert.equal(peak <= 4, true, `消费过程中并发峰值 ${peak} 超过 windowSize=4`);
});

test("解析失败的条目返回 {ok:false}，且预取了但没被取走的失败项不会变成 unhandled rejection", async () => {
  const rejections = [];
  const onRejection = reason => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const prefetch = createResolvePrefetch({
      count: 6,
      windowSize: 6,
      resolve: async index => {
        await tick();
        // 偶数下标记为失败；这些条目**故意一个都不 take** —— 模拟「预算用尽，worker 提前收工」
        if (index % 2 === 0) throw new Error(`解析失败 ${index}`);
        return `video-${index}`;
      },
    });

    // 消费掉奇数下标，偶数下标全部留在窗口里自生自灭
    for (const index of [1, 3, 5]) {
      const result = await prefetch.take(index);
      assert.equal(result.ok, true);
      assert.equal(result.value, `video-${index}`);
    }
    // take 一个失败的：必须是 {ok:false} 而不是抛出
    const failed = await prefetch.take(0);
    assert.equal(failed.ok, false);
    assert.match(failed.error.message, /解析失败 0/);

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(rejections, [], "预取的失败项产生了 unhandled rejection");
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("windowSize=0 时不预取：解析推迟到 take 才发生", async () => {
  const started = [];
  const prefetch = createResolvePrefetch({
    count: 3,
    windowSize: 0,
    resolve: async index => {
      started.push(index);
      return index * 10;
    },
  });
  await tick();
  assert.deepEqual(started, [], "windowSize=0 却提前发起了解析");
  assert.equal(prefetch.inFlight(), 0);

  const first = await prefetch.take(0);
  assert.deepEqual(started, [0]);
  assert.equal(first.value, 0);
});

test("take 已经预取过的下标不会重复解析", async () => {
  const calls = [];
  const prefetch = createResolvePrefetch({
    count: 3,
    windowSize: 3,
    resolve: async index => {
      calls.push(index);
      return index;
    },
  });
  await tick();
  assert.deepEqual(calls.sort(), [0, 1, 2], "窗口没有一次性填满");
  await prefetch.take(1);
  await tick();
  assert.equal(calls.filter(index => index === 1).length, 1, "下标 1 被解析了两次");
});
