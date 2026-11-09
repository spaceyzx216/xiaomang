import test from "node:test";
import { Readable } from "node:stream";
import assert from "node:assert/strict";

import {
  buildWorkflowCompatiblePayload,
  getBenchmarkTopicsFromBody,
  getShareLinksFromBody,
  normalizeEndingHook,
  parseJsonAgentOutput,
  validateWorkflowCompatiblePayload,
} from "../api/_lib/contentAgent/adapter.js";
import { runContentAgentWorkflow } from "../api/_lib/contentAgent/index.js";
import { getContentAgentConfig, shouldUseContentAgent } from "../api/_lib/contentAgent/config.js";
import { fetchJson } from "../api/_lib/contentAgent/http.js";
import { DRAMA_BENCHMARK_ANALYSIS_PROMPT, GOLD_THREE_SECONDS_PROMPT, SPOKEN_BENCHMARK_ANALYSIS_PROMPT } from "../api/_lib/contentAgent/prompts.js";
import { buildCreativeFallback, buildFfmpegAudioExtractArgs, buildTikHubVideoAttempts, clearResolveCacheForTests, clearTranscriptCacheForTests, guardStreamErrors, recognizeDoubaoFileAudio, transcribeVideo, decryptWeChatChannelsMediaBuffer, describeVideoUrlForDiagnostics, isDirectMp4Url, recognizeDoubaoAudio, resolveTikHubVideo, resolveWeChatChannelsTopicVideo, runCreativeAgents, shouldStreamVideoInputForFfmpeg } from "../api/_lib/contentAgent/providers.js";
import { generateKeystream } from "../api/_lib/contentAgent/vendor/wechatKeystream.mjs";
import { buildFinalDraftMarkdown, normalizeBenchmarkVideos, normalizePublishWarehouse, publishWarehouseCells } from "../api/_lib/exportFormatters.js";
import { BITABLE_FIELDS, finalDraftToBitableRecords, markdownToFeishuBlocks, parseFeishuBitableUrl } from "../api/_lib/feishuClient.js";
import { isWithinRecentDays, normalizePlatform, normalizeWeChatChannelsTopic } from "../api/_lib/platformAdapters.js";

test("extracts newline separated share links from workflow-style input", () => {
  const body = {
    _input: {
      share_links: " https://example.com/a \n\nhttps://example.com/b\r\n",
    },
  };

  assert.deepEqual(getShareLinksFromBody(body), [
    "https://example.com/a",
    "https://example.com/b",
  ]);
});

test("extracts benchmark topics from workflow-style input", () => {
  const topic = { platform: "wechat_channels", title: "视频号选题" };
  assert.deepEqual(getBenchmarkTopicsFromBody({ parameters: { benchmark_topics: [topic, null, "bad"] } }), [topic]);
  assert.deepEqual(getBenchmarkTopicsFromBody({ benchmarkTopics: [topic] }), [topic]);
});

test("normalizes wechat channels aliases", () => {
  assert.equal(normalizePlatform("wechat_channels"), "wechat_channels");
  assert.equal(normalizePlatform("视频号"), "wechat_channels");
  assert.equal(normalizePlatform("douyin"), "douyin");
  assert.equal(normalizePlatform("tiktok"), "tiktok");
  assert.equal(normalizePlatform("TikTok"), "tiktok");
  assert.equal(normalizePlatform("抖音国际版"), "tiktok");
  assert.equal(normalizePlatform(""), "douyin");
  assert.equal(normalizePlatform("unknown"), "douyin");
});

test("builds TikTok-specific TikHub video resolve endpoints", () => {
  const config = { tikhubRegion: "CN" };
  const link = "https://vm.tiktok.com/Z123abc/";

  const tiktokAttempts = buildTikHubVideoAttempts(link, "tiktok", config);
  assert.equal(tiktokAttempts.length > 0, true);
  // TikTok 必须走 /tiktok/ 端点，不能混入 /douyin/ 或 /hybrid/
  for (const attempt of tiktokAttempts) {
    assert.match(attempt.path, /\/api\/v1\/tiktok\//, `TikTok 端点应含 /tiktok/，实际：${attempt.path}`);
    assert.equal(attempt.params.share_url, link);
  }
  // 应至少有一个 preferVideo:true 的直链端点
  assert.equal(tiktokAttempts.some(a => a.preferVideo), true);

  // 抖音（默认）端点保持原样：含 hybrid 或 douyin
  const douyinAttempts = buildTikHubVideoAttempts("https://v.douyin.com/abc/", "douyin", config);
  assert.equal(douyinAttempts.some(a => /\/hybrid\//.test(a.path) || /\/douyin\//.test(a.path)), true);
  assert.equal(douyinAttempts.some(a => /\/tiktok\//.test(a.path)), false, "抖音端点不应含 /tiktok/");
});

test("preserves multiple TikHub CDN video candidates for failover", async () => {
  // 解析结果现在是跨用例共享的进程内缓存；不清理会让本用例命中别的用例造的数据。
  clearResolveCacheForTests();
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    data: {
      aweme_id: "7658162275022277895",
      desc: "候选视频",
      cover: "https://example.com/cover.jpg",
      video: {
        play_addr: {
          url_list: [
            "https://v16m.tiktokcdn-us.com/a/video/tos/alisg/demo?mime_type=video_mp4",
            "https://v19.tiktokcdn-us.com/b/video/tos/alisg/demo?mime_type=video_mp4",
          ],
        },
      },
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  try {
    const video = await resolveTikHubVideo(
      "https://www.tiktok.com/@demo/video/7658162275022277895",
      {
        tikhubApiToken: "test-token",
        tikhubBaseUrl: "https://api.tikhub.dev",
        requestTimeoutMs: 1000,
        apiRetryAttempts: 0,
        apiRetryBaseDelayMs: 1,
      },
      {
        platform: "tiktok",
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      },
    );

    assert.equal(video.videoUrl, "https://v16m.tiktokcdn-us.com/a/video/tos/alisg/demo?mime_type=video_mp4");
    assert.deepEqual(video.videoUrls, [
      "https://v16m.tiktokcdn-us.com/a/video/tos/alisg/demo?mime_type=video_mp4",
      "https://v19.tiktokcdn-us.com/b/video/tos/alisg/demo?mime_type=video_mp4",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

// ── TikHub 解析缓存（2026-09-24）────────────────────────────────────────────
// 2.2 黄金三秒与 2.3 结尾钩子跑同一批视频的同一个 link，解析是纯重复劳动。
// 这里钉住四条不变量，都是**静默出错**那类：错了不会抛异常，只会白烧额度、
// 或者更糟 —— 把一次失败记成「这条视频解析不出来」。

/** 造一个 TikHub 成功响应，并记录 fetch 被调了几次。 */
const stubTikHubFetch = payloadFactory => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: payloadFactory() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    calls: () => calls,
    restore: () => { global.fetch = originalFetch; },
  };
};

const TIKHUB_TEST_CONFIG = {
  tikhubApiToken: "test-token",
  tikhubBaseUrl: "https://api.tikhub.dev",
  requestTimeoutMs: 1000,
  apiRetryAttempts: 0,
  apiRetryBaseDelayMs: 1,
};

const tikHubVideoPayload = cover => ({
  aweme_id: "7658162275022277895",
  desc: "候选视频",
  cover,
  video: { play_addr: { url_list: ["https://v16m.tiktokcdn-us.com/a/video.mp4"] } },
});

test("同一条链接第二次解析命中缓存，不再打 TikHub（2.3 复用 2.2 的关键）", async () => {
  clearResolveCacheForTests();
  const stub = stubTikHubFetch(() => tikHubVideoPayload("https://example.com/cover.jpg"));
  try {
    const link = "https://www.tiktok.com/@demo/video/7658162275022277895";
    const first = await resolveTikHubVideo(link, { ...TIKHUB_TEST_CONFIG, resolveCacheTtlMs: 60_000 }, { platform: "tiktok" });
    const second = await resolveTikHubVideo(link, { ...TIKHUB_TEST_CONFIG, resolveCacheTtlMs: 60_000 }, { platform: "tiktok" });

    assert.equal(stub.calls(), 1, "第二次必须走缓存，不能再打一次 TikHub");
    assert.equal(first.videoUrl, second.videoUrl, "复用到的直链必须一致");
    assert.equal(second.cached, true, "命中缓存要如实标出来，便于日志辨认");
    assert.equal(second.musicUrl ?? "", first.musicUrl ?? "", "musicUrl 也要一起复用（tikhub-music 快路径靠它）");
  } finally {
    stub.restore();
    clearResolveCacheForTests();
  }
});

test("平台不同不能串用缓存：同一条链接在 douyin / tiktok 下各解析一次", async () => {
  clearResolveCacheForTests();
  const stub = stubTikHubFetch(() => tikHubVideoPayload("https://example.com/cover.jpg"));
  try {
    const link = "https://www.tiktok.com/@demo/video/7658162275022277895";
    await resolveTikHubVideo(link, { ...TIKHUB_TEST_CONFIG, resolveCacheTtlMs: 60_000 }, { platform: "tiktok" });
    await resolveTikHubVideo(link, { ...TIKHUB_TEST_CONFIG, resolveCacheTtlMs: 60_000 }, { platform: "douyin" });
    assert.equal(stub.calls(), 2, "键里带了 platform，两个平台必须各解析一次");
  } finally {
    stub.restore();
    clearResolveCacheForTests();
  }
});

test("解析失败不进缓存 —— 一次网络抖动不能被记住 30 分钟", async () => {
  clearResolveCacheForTests();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    // 所有端点都失败 → 解析不出 videoUrl → 抛 VIDEO_URL_MISSING
    return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } });
  };
  try {
    const link = "https://www.tiktok.com/@demo/video/7658162275022277895";
    const config = { ...TIKHUB_TEST_CONFIG, resolveCacheTtlMs: 60_000 };
    await assert.rejects(() => resolveTikHubVideo(link, config, { platform: "tiktok" }), /Unable to resolve playable video URL/);
    const afterFirst = calls;
    await assert.rejects(() => resolveTikHubVideo(link, config, { platform: "tiktok" }), /Unable to resolve playable video URL/);
    assert.ok(calls > afterFirst, "失败后必须真的重试，说明失败没被缓存下来");
  } finally {
    global.fetch = originalFetch;
    clearResolveCacheForTests();
  }
});

test("并发请求同一条链接只打一次 TikHub —— 存 Promise 才挡得住预取窗口的并发", async () => {
  clearResolveCacheForTests();
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    // 刻意留一点延迟，让两个调用真的重叠（否则串行执行测不出并发收敛）
    await new Promise(resolve => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ data: tikHubVideoPayload("https://example.com/cover.jpg") }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const link = "https://www.tiktok.com/@demo/video/7658162275022277895";
    const config = { ...TIKHUB_TEST_CONFIG, resolveCacheTtlMs: 60_000 };
    const [a, b] = await Promise.all([
      resolveTikHubVideo(link, config, { platform: "tiktok" }),
      resolveTikHubVideo(link, config, { platform: "tiktok" }),
    ]);
    assert.equal(calls, 1, "并发必须收敛成一次真实解析");
    assert.equal(a.videoUrl, b.videoUrl);
  } finally {
    global.fetch = originalFetch;
    clearResolveCacheForTests();
  }
});

test("TTL 设为 0 关闭缓存（可回退到旧行为）", async () => {
  clearResolveCacheForTests();
  const stub = stubTikHubFetch(() => tikHubVideoPayload("https://example.com/cover.jpg"));
  try {
    const link = "https://www.tiktok.com/@demo/video/7658162275022277895";
    const config = { ...TIKHUB_TEST_CONFIG, resolveCacheTtlMs: 0 };
    await resolveTikHubVideo(link, config, { platform: "tiktok" });
    await resolveTikHubVideo(link, config, { platform: "tiktok" });
    assert.equal(stub.calls(), 2, "TTL=0 时必须每次都真解析");
  } finally {
    stub.restore();
    clearResolveCacheForTests();
  }
});

test("resolves WeChat Channels topic metadata for content generation", () => {
  const video = resolveWeChatChannelsTopicVideo({
    id: "wechat_channels:14941130915890399732",
    platform: "wechat_channels",
    title: "测试视频号标题",
    source: {
      platform: "wechat_channels",
      objectId: "14941130915890399732",
      mediaUrl: "https://example.com/encrypted.mp4",
      decodeKey: "1859544503",
      coverUrl: "https://example.com/cover.jpg",
    },
    rawData: {
      media: {
        duration: 40,
      },
    },
  });

  assert.equal(video.platform, "wechat_channels");
  assert.equal(video.shareLink, "wechat_channels:14941130915890399732");
  assert.equal(video.videoUrl, "https://example.com/encrypted.mp4");
  assert.equal(video.decodeKey, "1859544503");
  assert.equal(video.title, "测试视频号标题");
  assert.equal(video.cover, "https://example.com/cover.jpg");
});

test("decrypts WeChat Channels Isaac64-encrypted media buffers", async () => {
  // 视频号加密机制：Isaac64 PRNG 以 decodeKey 为 seed 生成 131072 字节密钥流（reverse 后），
  // 仅与文件前 131072 字节 XOR，其余明文。这里用真实密钥流构造加密样本，验证解密还原。
  const decodeKey = "1859544503";
  const keystream = await generateKeystream(decodeKey);
  assert.equal(keystream.length, 131072, "keystream 必须为 131072 字节");

  // 构造一个合法 mp4 明文：[boxSize=32][ftyp][brand]
  const plain = Buffer.alloc(200000, 0);
  plain.writeUInt32BE(32, 0);
  plain.write("ftyp", 4, "latin1");
  plain.write("isom", 8, "latin1");
  for (let i = 12; i < plain.length; i += 1) plain[i] = (i * 7 + 3) & 0xff;

  // 用 keystream 加密前 131072 字节（模拟视频号加密）
  const encrypted = Buffer.from(plain);
  for (let i = 0; i < 131072; i += 1) encrypted[i] ^= keystream[i];
  assert.notEqual(encrypted.toString("latin1", 4, 8), "ftyp", "加密后头部不应是 ftyp");

  // 解密
  const decrypted = await decryptWeChatChannelsMediaBuffer(encrypted, decodeKey);
  assert.equal(decrypted.strategy, "isaac64");
  assert.equal(decrypted.buffer.toString("latin1", 4, 8), "ftyp", "解密后应还原 ftyp 签名");
  assert.equal(decrypted.buffer.equals(plain), true, "解密后整段数据应与明文一致（含明文部分原样保留）");

  // 已是明文的 buffer 应直接返回 plain 策略
  const alreadyPlain = await decryptWeChatChannelsMediaBuffer(plain, decodeKey);
  assert.equal(alreadyPlain.strategy, "plain");
  assert.equal(alreadyPlain.buffer.equals(plain), true);
});

test("normalizes WeChat Channels videos without losing large ids", () => {
  const topic = normalizeWeChatChannelsTopic(
    {
      id: "14941130915890399732",
      object_nonce_id: "18446744073709551615",
      username: "v2_example@finder",
      nickname: "人民日报",
      title: [{ shortTitle: "测试视频号标题" }],
      like_count: "1200",
      comment_count: "34",
      forward_count: "56",
      fav_count: "78",
      create_time: "1783070000",
      media: {
        full_url: "https://example.com/encrypted.mp4",
        decode_key: "123456",
        cover_url: "https://example.com/cover",
        cover_url_token: "?token=abc",
        duration: 40,
      },
    },
    { inputName: "人民日报" },
  );

  assert.equal(topic.platform, "wechat_channels");
  assert.equal(topic.title, "测试视频号标题");
  assert.equal(topic.link, "");
  assert.equal(topic.coverUrl, "https://example.com/cover?token=abc");
  assert.equal(topic.durationSeconds, 40);
  assert.equal(topic.id, "wechat_channels:14941130915890399732");
  assert.equal(topic.source.objectId, "14941130915890399732");
  assert.equal(topic.source.objectNonceId, "18446744073709551615");
  assert.equal(topic.source.finderUsername, "v2_example@finder");
  assert.equal(topic.source.mediaUrl, "https://example.com/encrypted.mp4");
  assert.equal(topic.source.decodeKey, "123456");
  assert.deepEqual(topic.stats, {
    comments: 34,
    likes: 1200,
    shares: 56,
    bookmarks: 78,
  });
});

test("checks WeChat Channels publish time against a seven day window", () => {
  const now = Date.parse("2026-07-03T12:00:00Z");
  assert.equal(isWithinRecentDays(Date.parse("2026-06-27T12:00:00Z") / 1000, 7, now), true);
  assert.equal(isWithinRecentDays(Date.parse("2026-06-25T11:59:59Z") / 1000, 7, now), false);
  assert.equal(isWithinRecentDays(Date.parse("2026-07-04T00:00:00Z") / 1000, 7, now), false);
});

test("routes the main content workflow to the agent", () => {
  assert.equal(shouldUseContentAgent({ workflow_id: "7618854964156563519" }), true);
  assert.equal(shouldUseContentAgent({ workflow_id: "translation-workflow" }), false);
});

test("keeps spoken and drama benchmark classification instructions separate", () => {
  assert.notEqual(SPOKEN_BENCHMARK_ANALYSIS_PROMPT, DRAMA_BENCHMARK_ANALYSIS_PROMPT);
  assert.match(SPOKEN_BENCHMARK_ANALYSIS_PROMPT, /标题中重复出现的关键词/);
  assert.match(SPOKEN_BENCHMARK_ANALYSIS_PROMPT, /sourceText 中多次出现的词语或语句/);
  assert.match(DRAMA_BENCHMARK_ANALYSIS_PROMPT, /剧情中能被输入证据确认的不同场景/);
  assert.match(DRAMA_BENCHMARK_ANALYSIS_PROMPT, /主角的身份/);
  assert.match(DRAMA_BENCHMARK_ANALYSIS_PROMPT, /人物数量/);
});

test("defines the eight gold three second types and review boundary", () => {
  // 按「8 个都在、废弃的不在」断言，而不是钉死排列顺序 ——
  // 维度清单由 goldThreeSeconds.js 的定义生成，顺序跟随那份定义。
  for (const name of ["好奇心", "恐惧", "愤怒", "反差", "痛点", "兴趣", "求知欲", "欲望"]) {
    assert.match(GOLD_THREE_SECONDS_PROMPT, new RegExp(name), `提示词里缺少维度「${name}」`);
  }
  // 「需求」只在 2026-09-17 存在过一天，用户已确认要「反差」不要它
  assert.doesNotMatch(GOLD_THREE_SECONDS_PROMPT, /需求/);
  // 2026-09-17：不再挑「点赞优先的前 20 条」，改成覆盖分类报告的全部样本（最多 60 条）——
  // 只取 20 条时每个大类剩不下几条，按大类的配比没有统计意义。
  assert.match(GOLD_THREE_SECONDS_PROMPT, /全部\*\*样本视频（最多 60 条）/);
  assert.doesNotMatch(GOLD_THREE_SECONDS_PROMPT, /前 20 条|按点赞数优先选出/);
  assert.match(GOLD_THREE_SECONDS_PROMPT, /待人工复核/);
});

test("configures TikHub media provider, ffmpeg fallback, and Doubao video fallback", () => {
  const original = {
    TRANSCRIPT_PROVIDERS: process.env.TRANSCRIPT_PROVIDERS,
    AGENT_CREATIVE_RETRY_ATTEMPTS: process.env.AGENT_CREATIVE_RETRY_ATTEMPTS,
    AGENT_CREATIVE_RETRY_BASE_DELAY_MS: process.env.AGENT_CREATIVE_RETRY_BASE_DELAY_MS,
    DOUBAO_RESOURCE_ID: process.env.DOUBAO_RESOURCE_ID,
    DOUBAO_ASR_ENDPOINT: process.env.DOUBAO_ASR_ENDPOINT,
    DOUBAO_VIDEO_ENDPOINT: process.env.DOUBAO_VIDEO_ENDPOINT,
    DOUBAO_VIDEO_API_KEY: process.env.DOUBAO_VIDEO_API_KEY,
    TIKHUB_TRANSCRIPT_PROVIDER_ENABLED: process.env.TIKHUB_TRANSCRIPT_PROVIDER_ENABLED,
    TIKHUB_MUSIC_PROVIDER_ENABLED: process.env.TIKHUB_MUSIC_PROVIDER_ENABLED,
    FFMPEG_FAST_PROBE_SIZE: process.env.FFMPEG_FAST_PROBE_SIZE,
    FFMPEG_FAST_ANALYZE_DURATION: process.env.FFMPEG_FAST_ANALYZE_DURATION,
    ASR_AUDIO_FORMAT: process.env.ASR_AUDIO_FORMAT,
    ASR_WAV_MAX_BYTES: process.env.ASR_WAV_MAX_BYTES,
    TIKHUB_MEDIA_URL_MAX_ATTEMPTS: process.env.TIKHUB_MEDIA_URL_MAX_ATTEMPTS,
    TIKTOK_MEDIA_PROXY_URL: process.env.TIKTOK_MEDIA_PROXY_URL,
    MEDIA_USE_ENV_PROXY: process.env.MEDIA_USE_ENV_PROXY,
  };

  try {
    process.env.TRANSCRIPT_PROVIDERS = "legacy-provider,ffmpeg,doubao-video";
    delete process.env.TIKHUB_TRANSCRIPT_PROVIDER_ENABLED;
    delete process.env.TIKHUB_MUSIC_PROVIDER_ENABLED;
    process.env.FFMPEG_FAST_PROBE_SIZE = "2M";
    process.env.FFMPEG_FAST_ANALYZE_DURATION = "750k";
    process.env.ASR_AUDIO_FORMAT = "auto";
    process.env.ASR_WAV_MAX_BYTES = "12345678";
    process.env.TIKHUB_MEDIA_URL_MAX_ATTEMPTS = "4";
    process.env.TIKTOK_MEDIA_PROXY_URL = "http://127.0.0.1:7890";
    process.env.MEDIA_USE_ENV_PROXY = "false";
    process.env.AGENT_CREATIVE_RETRY_ATTEMPTS = "3";
    process.env.AGENT_CREATIVE_RETRY_BASE_DELAY_MS = "1500";
    delete process.env.DOUBAO_RESOURCE_ID;
    delete process.env.DOUBAO_ASR_ENDPOINT;
    process.env.DOUBAO_VIDEO_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
    process.env.DOUBAO_VIDEO_API_KEY = "test-key";

    const config = getContentAgentConfig();
    // TIKHUB_TRANSCRIPT_PROVIDER_ENABLED + TIKHUB_MUSIC_PROVIDER_ENABLED 默认均为 true：
    // tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video
    assert.deepEqual(config.transcriptProviders, ["tikhub-music", "tikhub-ffmpeg", "ffmpeg", "doubao-video"]);
    assert.equal(config.ffmpegFastProbeSize, "2M");
    assert.equal(config.ffmpegFastAnalyzeDuration, "750k");
    assert.equal(config.asrAudioFormat, "auto");
    assert.equal(config.asrWavMaxBytes, 12345678);
    assert.equal(config.tikhubMediaUrlMaxAttempts, 4);
    assert.equal(config.mediaProxyUrl, "http://127.0.0.1:7890");
    assert.equal(config.mediaUseEnvProxy, false);
    assert.equal(config.creativeAgentRetryAttempts, 3);
    assert.equal(config.creativeAgentRetryBaseDelayMs, 1500);
    assert.equal(config.doubaoResourceId, "volc.bigasr.auc_turbo");
    assert.match(config.doubaoAsrEndpoint, /\/recognize\/flash$/);
    assert.equal(config.doubaoVideoEndpoint, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
    assert.equal(config.doubaoVideoApiKey, "test-key");
  } finally {
    Object.entries(original).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
});

test("repairs user prompt style output fragment into JSON object", () => {
  const parsed = parseJsonAgentOutput('"output":{"extracted":"开场原文","created":["二创1","二创2"]}');

  assert.deepEqual(parsed, {
    extracted: "开场原文",
    created: ["二创1", "二创2"],
  });
});

test("keeps ending hook empty when original has no call to action", () => {
  assert.deepEqual(
    normalizeEndingHook({
      extracted_result: "无",
      rcs: ["这条不应该透出"],
    }),
    {
      extracted_result: "无",
      rcs: [],
    },
  );
});

test("builds a workflow-compatible payload that the existing frontend can parse", () => {
  const payload = buildWorkflowCompatiblePayload([
    {
      shareLink: "https://www.douyin.com/video/example",
      video: {
        cover: "https://example.com/cover.webp",
        title: "原视频标题",
        videoUrl: "https://example.com/video.mp4",
      },
      transcript: {
        text: "原始口播内容",
      },
      creative: {
        openingHook: {
          extracted: "原始开场",
          created: ["二创开场"],
        },
        endingHook: {
          extracted_result: "无",
          rcs: [],
        },
        titleText: "1. 《爆款标题》\n类型：数字型",
        scriptText: "二创后的完整文案",
      },
    },
  ]);

  validateWorkflowCompatiblePayload(payload, 1);

  const codeListField = JSON.parse(payload.Code_list[0].fields[0]);
  assert.equal(codeListField.content, "二创后的完整文案");
  assert.match(codeListField.title, /爆款标题/);

  const codeList1Field = JSON.parse(payload.Code_list1[0].records[0].fields);
  assert.equal(codeList1Field.标题, "原视频标题");
  assert.equal(codeList1Field.内容, "原始口播内容");
  assert.deepEqual(codeList1Field.开头钩子.created, ["二创开场"]);
  assert.deepEqual(codeList1Field.结尾钩子, { extracted_result: "无", rcs: [] });
  assert.deepEqual(JSON.parse(codeList1Field.链接), {
    cover: "https://example.com/cover.webp",
    title: "原视频标题",
    video: "https://example.com/video.mp4",
  });
});

test("classifies TikHub Douyin play URLs as non-direct mp4 inputs", () => {
  const info = describeVideoUrlForDiagnostics(
    "https://www.douyin.com/aweme/v1/play/?video_id=v0300fg10000demo&line=0&file_id=demo&sign=demo&is_play_url=1",
  );

  assert.equal(info.kind, "douyin-aweme-play-api");
  assert.equal(info.host, "www.douyin.com");
  assert.equal(info.path, "/aweme/v1/play/");
  assert.equal(info.isDirectMp4, false);
  assert.equal(isDirectMp4Url("https://www.douyin.com/aweme/v1/play/?video_id=v0300fg10000demo"), false);
});

test("classifies static mp4 URLs as direct video inputs", () => {
  const info = describeVideoUrlForDiagnostics("https://cdn.example.com/video/demo.mp4?sign=abc");

  assert.equal(info.kind, "direct-mp4");
  assert.equal(info.isDirectMp4, true);
  assert.equal(isDirectMp4Url("https://cdn.example.com/video/demo.mp4?sign=abc"), true);
});

test("streams TikTok CDN media into ffmpeg instead of handing ffmpeg the URL", () => {
  const tiktokCdnUrl = "https://v16m.tiktokcdn-us.com/abc/video/tos/alisg/demo?mime_type=video_mp4";
  const info = describeVideoUrlForDiagnostics(tiktokCdnUrl);

  assert.equal(info.kind, "cdn-direct-video");
  assert.equal(info.isDirectMp4, false);
  assert.equal(shouldStreamVideoInputForFfmpeg(tiktokCdnUrl), true);
  assert.equal(shouldStreamVideoInputForFfmpeg("https://cdn.example.com/video/demo.mp4?sign=abc"), false);
});

test("does not classify TikTok HEIC avatar images as streamable video", () => {
  const avatarUrl = "https://p16-common-sign.tiktokcdn-us.com/tos-alisg-avt-0068/demo~tplv-tiktokx-cropcenter-q:720:720:q70.heic?x-expires=1&x-signature=demo";
  const info = describeVideoUrlForDiagnostics(avatarUrl);

  assert.equal(info.kind, "http-url");
  assert.equal(info.isDirectMp4, false);
  assert.equal(shouldStreamVideoInputForFfmpeg(avatarUrl), false);
});

test("builds fast and conservative ffmpeg audio extraction args", () => {
  const fastArgs = buildFfmpegAudioExtractArgs({
    input: "pipe:0",
    fastProbe: true,
    audioFormat: "mp3",
    config: {
      ffmpegFastProbeSize: "2M",
      ffmpegFastAnalyzeDuration: "750k",
    },
  });
  assert.deepEqual(fastArgs.slice(0, 8), [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-probesize",
    "2M",
    "-analyzeduration",
    "750k",
  ]);
  assert.equal(fastArgs.includes("pipe:0"), true);
  assert.equal(fastArgs.at(-1), "pipe:1");

  const conservativeArgs = buildFfmpegAudioExtractArgs({ input: "pipe:0", fastProbe: false });
  assert.equal(conservativeArgs.includes("-probesize"), false);
  assert.equal(conservativeArgs.includes("-analyzeduration"), false);

  const wavArgs = buildFfmpegAudioExtractArgs({ input: "pipe:0", fastProbe: true, audioFormat: "wav" });
  assert.equal(wavArgs.includes("-b:a"), false);
  assert.deepEqual(wavArgs.slice(-5), ["-c:a", "pcm_s16le", "-f", "wav", "pipe:1"]);
});

test("Doubao flash ASR rejects missing base64 audio before network calls", async () => {
  await assert.rejects(
    () => recognizeDoubaoAudio(
      {},
      {},
      {
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      },
    ),
    error => error?.code === "ASR_INPUT_MISSING",
  );
});

test("fetchJson retries retryable HTTP statuses and returns the successful response", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "busy" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const { data, response } = await fetchJson("https://example.com/retry", {
      retries: 1,
      retryBaseDelayMs: 1,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(data, { ok: true });
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchJson retries an Undici terminated socket error using its cause", async () => {
  const originalFetch = global.fetch;
  const originalRandom = Math.random;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      const socketError = Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" });
      throw Object.assign(new TypeError("terminated"), { cause: socketError });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  Math.random = () => 0;

  try {
    const { data } = await fetchJson("https://example.com/retry-terminated", {
      retries: 1,
      retryBaseDelayMs: 0,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.deepEqual(data, { ok: true });
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
    Math.random = originalRandom;
  }
});

test("fetchJson omits query parameters from errors and logs", async () => {
  const originalFetch = global.fetch;
  const errors = [];
  global.fetch = async () => new Response(JSON.stringify({ error: "payment required" }), {
    status: 402,
    headers: { "Content-Type": "application/json" },
  });

  try {
    await assert.rejects(
      fetchJson("https://example.com/videos?max_cursor=secret-cursor", {
        retries: 2,
        logger: {
          info() {},
          warn() {},
          error(_event, fields) { errors.push(fields); },
        },
      }),
      error => error?.status === 402 &&
        error.message === "HTTP 402 from https://example.com/videos" &&
        !error.message.includes("secret-cursor"),
    );
    assert.equal(errors.some(fields => JSON.stringify(fields).includes("secret-cursor")), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("creative agents fall back independently when DeepSeek requests fail", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "upstream busy" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const creative = await runCreativeAgents(
      {
        title: "原视频标题",
        shareLink: "https://www.douyin.com/video/demo",
      },
      {
        text: "辞退员工被仲裁赔钱，只能说明你老板干的有问题。今天把话挑明，只要你把这套方法吃透。",
      },
      {
        deepseekApiKey: "test-key",
        deepseekBaseUrl: "https://api.deepseek.com",
        deepseekModel: "deepseek-chat",
        deepseekTemperature: 0.7,
        deepseekMaxTokens: 2048,
        useDeepseekJsonMode: true,
        requestTimeoutMs: 1000,
        apiRetryAttempts: 0,
        apiRetryBaseDelayMs: 1,
        creativeAgentRetryAttempts: 0,
        creativeAgentRetryBaseDelayMs: 1,
      },
      {
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      },
    );

    assert.equal(calls, 4);
    assert.equal(creative.warnings.length, 4);
    assert.equal(creative.openingHook.extracted, "辞退员工被仲裁赔钱，只能说明你老板干的有问题。");
    assert.equal(creative.endingHook.extracted_result, "无");
    assert.deepEqual(creative.endingHook.rcs, []);
    assert.match(creative.titleText, /原视频标题/);
    assert.match(creative.titleText, /原始标题保底/);
    assert.match(creative.scriptText, /辞退员工被仲裁赔钱/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("creative agents retry only their own failed node and keep successful outputs", async () => {
  const originalFetch = global.fetch;
  const callsByBody = new Map();
  global.fetch = async (_url, options = {}) => {
    const body = JSON.parse(String(options.body || "{}"));
    const system = body.messages?.[0]?.content || "";
    // 标题有两个提示词：旧的自由创作口径（「短视频爆款标题生成助手」）与
    // 2.3 标题的按配比二创口径（「短视频爆款标题二创专家」）。两个都要认，
    // 否则按配比那条会被误判成 ending，本测试就测不到标题节点的重试了。
    //
    // JSON 修复器也要**单独认出来**：`runJsonAgent` 在归一化失败时会追发一次
    // 修复请求，它同样走 global.fetch；不单独归类就会落到末尾兜底的 ending，
    // 把 ending 的调用数平白加一（断言 ending === 1 会假失败）。
    const agent = system.includes("短视频爆款标题")
      ? "title"
      : system.includes("改写爆款抖音短视频文案助手")
        ? "script"
        : system.includes("短视频开场文案")
          ? "opening"
          : system.includes("严格 JSON 修复器")
            ? "jsonRepair"
            : "ending";
    const count = (callsByBody.get(agent) || 0) + 1;
    callsByBody.set(agent, count);

    if (agent === "title" && count === 1) {
      return new Response(JSON.stringify({ error: "temporary overload" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const content = {
      opening: JSON.stringify({ output: { extracted: "原开头", created: ["二创开头"] } }),
      ending: JSON.stringify({ output: { extracted_result: "无", rcs: [] } }),
      title: "1. 《重试后成功标题》\n类型：数字型",
      script: "重试不影响其他 Agent 的二创文案",
      // 标题节点已改成 JSON 结构化输出；模型偶尔回非 JSON，修复器按标题的输出
      // 契约返回，让重试路径能走完（本测试关心的是「只重试自己那一个节点」）。
      jsonRepair: JSON.stringify({
        originalType: "unknown",
        reason: "",
        items: [{ index: 1, type: "knowledge", content: "重试后成功标题" }],
      }),
    }[agent];

    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const creative = await runCreativeAgents(
      {
        title: "原视频标题",
        shareLink: "https://www.douyin.com/video/demo",
      },
      {
        text: "原视频转写文案",
      },
      {
        deepseekApiKey: "test-key",
        deepseekBaseUrl: "https://api.deepseek.com",
        deepseekModel: "deepseek-chat",
        deepseekTemperature: 0.7,
        deepseekMaxTokens: 2048,
        useDeepseekJsonMode: true,
        requestTimeoutMs: 1000,
        apiRetryAttempts: 0,
        apiRetryBaseDelayMs: 1,
        creativeAgentRetryAttempts: 1,
        creativeAgentRetryBaseDelayMs: 1,
      },
      {
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      },
    );

    assert.equal(callsByBody.get("title"), 2);
    assert.equal(callsByBody.get("opening"), 1);
    assert.equal(callsByBody.get("ending"), 1);
    assert.equal(callsByBody.get("script"), 1);
    assert.equal(creative.warnings.length, 0);
    assert.deepEqual(creative.openingHook, { extracted: "原开头", created: ["二创开头"] });
    assert.match(creative.titleText, /重试后成功标题/);
    assert.match(creative.scriptText, /重试不影响其他 Agent/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("creative fallback remains compatible with workflow payload validation", () => {
  const payload = buildWorkflowCompatiblePayload([
    {
      shareLink: "https://www.douyin.com/video/demo",
      video: {
        cover: "https://example.com/cover.webp",
        title: "原视频标题",
        videoUrl: "https://example.com/video.mp4",
      },
      transcript: {
        text: "原视频转写内容第一句。后续内容继续展开。",
      },
      creative: buildCreativeFallback(
        { title: "原视频标题", shareLink: "https://www.douyin.com/video/demo" },
        { text: "原视频转写内容第一句。后续内容继续展开。" },
        new Error("DeepSeek returned empty content"),
      ),
    },
  ]);

  validateWorkflowCompatiblePayload(payload, 1);
  const codeListField = JSON.parse(payload.Code_list[0].fields[0]);
  assert.match(codeListField.title, /原视频标题/);
  assert.match(codeListField.content, /原视频转写内容第一句/);
});

test("export formatter includes benchmark video metrics", () => {
  const benchmarkVideos = normalizeBenchmarkVideos([
    {
      title: "对标视频标题",
      link: "https://www.douyin.com/video/demo",
      authorName: "示例作者",
      rawData: {
        video: {
          cover: {
            url_list: ["https://example.com/cover.webp"],
          },
          duration: 61800,
        },
      },
      stats: {
        likes: 12345,
        comments: 67,
        shares: 8,
        bookmarks: 90,
      },
    },
  ]);

  const markdown = buildFinalDraftMarkdown({
    titleDraft: "生成标题",
    hookDraft: "三秒留存",
    scriptDraft: "二创文案",
    benchmarkVideos,
  });

  assert.match(markdown, /对标选题视频/);
  assert.match(markdown, /https:\/\/www\.douyin\.com\/video\/demo/);
  assert.match(markdown, /https:\/\/example\.com\/cover\.webp/);
  assert.match(markdown, /时长：1:02/);
  assert.match(markdown, /点赞 1\.2万 \/ 评论 67 \/ 转发 8 \/ 收藏 90/);
});

test("converts final draft markdown into Feishu docx blocks", () => {
  const blocks = markdownToFeishuBlocks("# 最终文案\n\n## 标题\n生成标题\n\n普通正文");

  assert.equal(blocks[0].block_type, 3);
  assert.equal(blocks[0].heading1.elements[0].text_run.content, "最终文案");
  assert.equal(blocks[1].block_type, 4);
  assert.equal(blocks[1].heading2.elements[0].text_run.content, "标题");
  assert.equal(blocks[2].block_type, 2);
  assert.equal(blocks[2].text.elements[0].text_run.content, "生成标题");
});

test("maps final draft and benchmark video into Feishu Bitable records", () => {
  const records = finalDraftToBitableRecords({
    titleDraft: "生成标题",
    hookDraft: "三秒留存",
    scriptDraft: "二创文案",
    rewriteDraft: "风格转写",
    translationDraft: "中英转写",
    benchmarkVideos: [
      {
        title: "对标视频标题",
        link: "https://www.douyin.com/video/demo",
        coverUrl: "https://example.com/cover.webp",
        durationSeconds: 62,
        authorName: "示例作者",
        publishDate: "2026-07-01",
        stats: {
          likes: 123,
          comments: 45,
          shares: 6,
          bookmarks: 7,
        },
        hotTopics: ["用工合规", "劳动仲裁"],
      },
    ],
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].fields["对标视频标题"], "对标视频标题");
  assert.deepEqual(records[0].fields["视频链接"], {
    text: "对标视频标题",
    link: "https://www.douyin.com/video/demo",
  });
  assert.equal(records[0].fields["作者"], "示例作者");
  assert.equal(records[0].fields["点赞数"], 123);
  assert.equal(records[0].fields["评论数"], 45);
  assert.equal(records[0].fields["转发数"], 6);
  assert.equal(records[0].fields["收藏数（红心）"], 7);
  assert.equal(records[0].fields["生成标题"], "生成标题");
  assert.equal(records[0].fields["生成3秒"], "三秒留存");
  assert.equal(records[0].fields["原二创文案"], "二创文案");
  // 用户 2026-09-24 明确不要的列，一个都不该再写。
  for (const gone of ["视频封面", "视频时长", "发布时间", "热词", "风格转写结果", "中英翻译结果", "导出时间"]) {
    assert.equal(gone in records[0].fields, false, `不该再写「${gone}」这一列`);
  }
});

test("多维表格的列就是用户给的那 14 列（名字与顺序都钉住）", () => {
  // 用户 2026-09-24 给的清单，顺序即口径 —— 别自己重排、别悄悄加回删掉的列。
  assert.deepEqual(BITABLE_FIELDS.map(field => field.field_name), [
    "对标视频标题",
    "视频链接",
    "作者",
    "点赞数",
    "评论数",
    "转发数",
    "收藏数（红心）",
    "原文案",
    "原二创文案",
    "生成标题",
    "生成3秒",
    "生成结尾钩子",
    "发布仓（发布文案＋发布标签）",
    "封面",
  ]);
  assert.equal(BITABLE_FIELDS.some(field => field.field_name === "视频链接" && field.type === 15), true);
  assert.equal(BITABLE_FIELDS.some(field => field.field_name === "点赞数" && field.type === 2), true);
});

test("parses Feishu Bitable app token and table id from shared URLs", () => {
  assert.deepEqual(
    parseFeishuBitableUrl("https://example.feishu.cn/base/appAbCdEf123456?table=tbl987654321&view=vew123"),
    {
      appToken: "appAbCdEf123456",
      tableId: "tbl987654321",
      viewId: "vew123",
    },
  );
  assert.deepEqual(parseFeishuBitableUrl("appTokenOnly987654321"), {
    appToken: "appTokenOnly987654321",
    tableId: "",
    viewId: "",
  });
});

test("content agent workflow returns SSE Error event for invalid input", async () => {
  const chunks = [];
  const headers = {};
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      headers[key] = value;
      return this;
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end(chunk = "") {
      if (chunk) chunks.push(String(chunk));
      this.ended = true;
    },
  };

  await runContentAgentWorkflow({}, res, {
    body: { parameters: { share_links: "" } },
    config: {
      maxLinksPerRun: 5,
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  const streamText = chunks.join("");
  assert.equal(headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.match(streamText, /event: Progress/);
  assert.match(streamText, /event: Error/);
  assert.match(streamText, /SHARE_LINKS_EMPTY/);
  assert.equal(res.ended, true);
});

// ── 发布仓三块产出并入最终草稿与导出（HANDOFF §0.3，用户选「成品并入最终编辑页」）

test("发布仓产出：封面只认 http 外链，dataUrl 不落进导出形状", () => {
  const inline = normalizePublishWarehouse({
    cover: { dataUrl: "data:image/png;base64," + "A".repeat(200), title: "封面 1" },
    copy: "金句一句",
    tags: "#劳动法",
  });
  assert.equal(inline.coverUrl, "");
  assert.equal(inline.coverInline, true, "只有内嵌图时必须标出来，不能静默当成没有封面");

  const linked = normalizePublishWarehouse({
    cover: { url: "https://cdn.example.com/c.png", dataUrl: "data:image/png;base64,AAAA", title: "封面 2" },
  });
  assert.equal(linked.coverUrl, "https://cdn.example.com/c.png");
  assert.equal(linked.coverInline, false, "有外链时不该标成内嵌");
});

test("发布仓产出：各段长度封顶，避免一张 base64 撑爆草稿", () => {
  const item = normalizePublishWarehouse({
    copy: "x".repeat(9000),
    tags: "y".repeat(3000),
    cover: { prompt: "p".repeat(5000) },
  });
  assert.equal(item.copy.length, 4000);
  assert.equal(item.tags.length, 1000);
  assert.equal(item.coverPrompt.length, 1200);
});

test("发布仓产出：只有内嵌封面时如实说明「无外链、写不进飞书」", () => {
  const cells = publishWarehouseCells({ cover: { dataUrl: "data:image/png;base64,AAAA" } });
  assert.match(cells.cover, /内嵌图片/);
  assert.match(cells.cover, /无法写入飞书/);
});

test("最终文案 markdown：带发布仓产出时追加三段，不带时保持原样", () => {
  const withPublish = buildFinalDraftMarkdown({
    titleDraft: "生成标题",
    publishWarehouse: {
      coverUrl: "https://cdn.example.com/c.png",
      coverTitle: "封面 1",
      copy: "不签合同，赔得更多",
      tags: "#劳动法 #用工风险",
    },
  });
  assert.match(withPublish, /## 发布封面/);
  assert.match(withPublish, /https:\/\/cdn\.example\.com\/c\.png/);
  assert.match(withPublish, /## 发布文案/);
  assert.match(withPublish, /不签合同，赔得更多/);
  assert.match(withPublish, /## 发布标签/);
  assert.match(withPublish, /#劳动法 #用工风险/);

  // 从内容生成页直接来最终编辑页（没经过发布仓）的草稿，导出的文档必须和以前完全一致。
  const withoutPublish = buildFinalDraftMarkdown({ titleDraft: "生成标题" });
  assert.doesNotMatch(withoutPublish, /发布封面/);
  assert.doesNotMatch(withoutPublish, /发布文案/);
});

test("多维表格：发布仓合并成一列、封面一格、原文案与结尾钩子各就各位", () => {
  const [record] = finalDraftToBitableRecords({
    titleDraft: "生成标题",
    hookDraft: "3 秒文案",
    endingHookDraft: "结尾钩子文案",
    scriptDraft: "二创文案内容",
    benchmarkVideos: [{ title: "对标视频标题", script: "这条视频的原文案" }],
    publishWarehouse: {
      coverUrl: "https://cdn.example.com/c.png",
      coverTitle: "封面 1",
      copy: "发布文案内容",
      tags: "#劳动法",
    },
  });
  // 发布文案＋发布标签合成**一列**（用户口径），中间空一行
  assert.equal(record.fields["发布仓（发布文案＋发布标签）"], "发布文案内容\n#劳动法");
  assert.match(record.fields["封面"], /https:\/\/cdn\.example\.com\/c\.png/);
  // 原文案取**这条对标视频**的原文，不是标题
  assert.equal(record.fields["原文案"], "这条视频的原文案");
  assert.equal(record.fields["原二创文案"], "二创文案内容");
  assert.equal(record.fields["生成3秒"], "3 秒文案");
  assert.equal(record.fields["生成结尾钩子"], "结尾钩子文案");

  // 没经过发布仓、也没有原文/钩子时：这些列必须是**空串**，不能是 undefined
  // （否则飞书那边会当成缺字段）。
  const [bare] = finalDraftToBitableRecords({ titleDraft: "只有标题", benchmarkVideos: [{ title: "对标视频标题" }] });
  for (const name of ["原文案", "原二创文案", "生成3秒", "生成结尾钩子", "发布仓（发布文案＋发布标签）", "封面"]) {
    assert.equal(bare.fields[name], "", `「${name}」空值要写空串`);
  }
});

// ── 豆包录音文件识别 2.0（异步 submit + 轮询 query，2026-09-28）──────────────
// 这条通道与 flash 同步接口是两条独立链路，最容易出的错都很安静：
// 把 task_id 当成响应里的字段（实际就是自己传的 X-Api-Request-Id）、
// 把"处理中"当成失败、或者超时后不肯回退把整批挂死。

/** 造一个按顺序应答的 fetch 桩，记录每次请求的 URL 与请求头。 */
const stubSequenceFetch = handlers => {
  const originalFetch = global.fetch;
  const calls = [];
  let index = 0;
  global.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    calls.push({ url: String(url), headers, body: init.body ? JSON.parse(String(init.body)) : null });
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return handler({ url: String(url), headers, body: init.body ? JSON.parse(String(init.body)) : null });
  };
  return { calls, restore: () => { global.fetch = originalFetch; } };
};

const doubaoTextResponse = (code, text) => new Response(
  JSON.stringify(text === undefined ? {} : { audio_info: { duration: 1234 }, result: { text } }),
  { status: 200, headers: { "Content-Type": "application/json", "X-Api-Status-Code": code, "X-Api-Message": code === "20000001" ? "[Processing in progress]" : "OK", "X-Tt-Logid": "logid-1" } },
);

const FILE_ASR_CONFIG = {
  ...TIKHUB_TEST_CONFIG,
  doubaoApiKey: "test-asr-key",
  doubaoFileAsrResourceId: "volc.seedasr.auc",
  doubaoFileAsrSubmitUrl: "https://openspeech.example/submit",
  doubaoFileAsrQueryUrl: "https://openspeech.example/query",
  doubaoFileAsrPollIntervalMs: 200,
  doubaoFileAsrBudgetMs: 5000,
  apiRetryAttempts: 0,
  requestTimeoutMs: 1000,
};

test("录音文件识别：task_id 就是自己传的 X-Api-Request-Id，submit 与每次 query 必须同一个", async () => {
  const stub = stubSequenceFetch([
    () => doubaoTextResponse("20000000"),   // submit 成功（响应体是 {}，没有 task_id）
    () => doubaoTextResponse("20000001"),   // 处理中
    () => doubaoTextResponse("20000000", "识别出来的文案"),  // 成功
  ]);
  try {
    const result = await recognizeDoubaoFileAudio(
      { audioUrl: "https://cdn.example/a.mp3", audioFormat: "mp3" },
      FILE_ASR_CONFIG,
      { logger: { info(){}, warn(){}, error(){} } },
    );
    assert.equal(result.text, "识别出来的文案");
    assert.equal(stub.calls.length, 3, "应为 submit + 2 次 query");
    const ids = stub.calls.map(c => c.headers["X-Api-Request-Id"]);
    assert.ok(ids[0], "submit 必须带 X-Api-Request-Id");
    assert.equal(new Set(ids).size, 1, "3 次请求必须是同一个 UUID —— 它就是 task_id，换了就查不到结果");
    assert.equal(result.taskId, ids[0], "返回的 taskId 要能让调用方追溯");
    // 资源 ID 必须是 2.0
    assert.equal(stub.calls[0].headers["X-Api-Resource-Id"], "volc.seedasr.auc");
    // 只传 URL，不传 base64
    assert.equal(stub.calls[0].body.audio.url, "https://cdn.example/a.mp3");
    assert.equal(stub.calls[0].body.audio.data, undefined, "新接口不接受 base64");
  } finally { stub.restore(); }
});

test("录音文件识别：submit 失败必须立刻抛，不能白轮询", async () => {
  const stub = stubSequenceFetch([() => doubaoTextResponse("45000001")]);
  try {
    await assert.rejects(
      () => recognizeDoubaoFileAudio({ audioUrl: "https://cdn.example/a.mp3" }, FILE_ASR_CONFIG, { logger: { info(){}, warn(){}, error(){} } }),
      error => error.code === "DOUBAO_ASR_FAILED" && /submit/.test(String(error.details?.phase)),
    );
    assert.equal(stub.calls.length, 1, "submit 失败后不该再发 query");
  } finally { stub.restore(); }
});

test("录音文件识别：超预算必须抛 TIMEOUT 让 provider 链回退，绝不无限等", async () => {
  // submit 成功，此后永远「处理中」—— 模拟官方说的"高峰期可能延迟"。
  const stub = stubSequenceFetch([
    () => doubaoTextResponse("20000000"),   // submit
    () => doubaoTextResponse("20000001"),   // 之后一律处理中
  ]);
  try {
    const startedAt = Date.now();
    await assert.rejects(
      () => recognizeDoubaoFileAudio(
        { audioUrl: "https://cdn.example/a.mp3" },
        { ...FILE_ASR_CONFIG, doubaoFileAsrBudgetMs: 900, doubaoFileAsrPollIntervalMs: 200 },
        { logger: { info(){}, warn(){}, error(){} } },
      ),
      error => error.code === "DOUBAO_ASR_TIMEOUT",
    );
    assert.ok(Date.now() - startedAt < 5000, "必须在预算附近收手，不能挂死");
    assert.ok(stub.calls.length > 1, "应当真的轮询过几次才超时");
  } finally { stub.restore(); }
});

test("录音文件识别：query 报错要带出上游状态码，不要吞成泛化失败", async () => {
  const stub = stubSequenceFetch([
    () => doubaoTextResponse("20000000"),
    () => doubaoTextResponse("45000002"),   // 空音频
  ]);
  try {
    await assert.rejects(
      () => recognizeDoubaoFileAudio({ audioUrl: "https://cdn.example/a.mp3" }, FILE_ASR_CONFIG, { logger: { info(){}, warn(){}, error(){} } }),
      error => error.code === "DOUBAO_ASR_FAILED" && error.details?.code === "45000002",
    );
  } finally { stub.restore(); }
});

test("录音文件识别：缺少 audioUrl 直接拒绝（这条通道只接受 URL，不接受 base64）", async () => {
  await assert.rejects(
    () => recognizeDoubaoFileAudio({ audioDataBase64: "AAAA" }, FILE_ASR_CONFIG, { logger: { info(){}, warn(){}, error(){} } }),
    error => error.code === "ASR_INPUT_MISSING",
  );
});

// ── 录音文件识别的两源重试（2026-09-28）──────────────────────────────────
// 实测同一条抖音视频的 music(mp3) 与 video 直链里是**同一段音频**，互为等价来源。
// 一个源为空/损坏时换另一个源重试成本接近零，远低于下整条视频用 ffmpeg 重抽。
// 这里钉住"换源"这件事真的发生，以及全失败时不要把原因丢掉。

test("录音文件识别：第一源失败会自动换第二源（换源重试，不是降级）", async () => {
  // 源1 → submit 报错（空音频 45000002）；源2 → submit + query 成功。
  // ⚠️ 用 URL 定位调用，不用下标：submit 自身也可能重试，下标会错位。
  const stub = stubSequenceFetch([
    ({ body }) => (String(body?.audio?.url || "").includes("music")
      ? doubaoTextResponse("45000002")
      : doubaoTextResponse("20000000")),
    () => doubaoTextResponse("20000000", "第二个音源识别出的文案"),
  ]);
  try {
    const result = await recognizeDoubaoFileAudio({
      audioSources: [
        { url: "https://cdn.example/music.mp3", format: "mp3", kind: "music" },
        { url: "https://cdn.example/video.mp4", format: "m4a", kind: "video" },
      ],
    }, { ...FILE_ASR_CONFIG, apiRetryAttempts: 0 }, { logger: { info(){}, warn(){}, error(){} } });

    assert.equal(result.text, "第二个音源识别出的文案");
    assert.equal(result.sourceKind, "video", "必须如实标出最终用的是哪个音源");

    const submitters = stub.calls.filter(call => call.body?.audio?.url);
    assert.equal(submitters.length, 2, "两个音源各 submit 一次（第一源失败后换源）");
    assert.equal(submitters[0].body.audio.url, "https://cdn.example/music.mp3");
    // 第二个音源按 m4a 报（官方白名单内），而不是未文档化的 mp4
    assert.equal(submitters[1].body.audio.url, "https://cdn.example/video.mp4");
    assert.equal(submitters[1].body.audio.format, "m4a");
  } finally { stub.restore(); }
});

test("录音文件识别：所有音源都失败时，每个音源的原因都要带出来", async () => {
  const stub = stubSequenceFetch([() => doubaoTextResponse("45000002")]);
  try {
    await assert.rejects(
      () => recognizeDoubaoFileAudio({
        audioSources: [
          { url: "https://cdn.example/a.mp3", format: "mp3", kind: "music" },
          { url: "https://cdn.example/b.mp4", format: "m4a", kind: "video" },
        ],
      }, FILE_ASR_CONFIG, { logger: { info(){}, warn(){}, error(){} } }),
      error => {
        // 只报最后一个源的话，排查时分不清"两个源都空"还是"第一个源文件坏了"
        assert.equal(error.details?.failures?.length, 2, "两个源的失败原因都要在 details 里");
        assert.deepEqual(error.details.failures.map(f => f.kind), ["music", "video"]);
        return error.code === "DOUBAO_ASR_FAILED";
      },
    );
  } finally { stub.restore(); }
});

test("录音文件识别：单源调用保持兼容（只给 audioUrl 时就是一次普通调用）", async () => {
  const stub = stubSequenceFetch([
    () => doubaoTextResponse("20000000"),
    () => doubaoTextResponse("20000000", "单源结果"),
  ]);
  try {
    const result = await recognizeDoubaoFileAudio(
      { audioUrl: "https://cdn.example/a.mp3", audioFormat: "mp3" },
      FILE_ASR_CONFIG,
      { logger: { info(){}, warn(){}, error(){} } },
    );
    assert.equal(result.text, "单源结果");
    assert.equal(stub.calls.length, 2, "单源只需 submit + 1 次 query");
  } finally { stub.restore(); }
});

// ── 流断开不得打死进程（2026-09-28 用户实测的真实事故）─────────────────────
// 事故现场：媒体流在对端断流时抛 unhandled 'error'，**整个 Node 进程退出**，
// 前端只看到 `socket hang up` 与长时间无结果（终端是 `Failed running 'src/index.js'`，
// 堆栈为 undici `Fetch.onAborted` / `UND_ERR_SOCKET: other side closed`）。
//
// 根因（读代码定位，不是推测）：`Readable.fromWeb(response.body)` 在
// `prepareVideoInput` / `extractAudioFromFetchedMedia` 里建好之后，消费侧的
// `inputStream.on("error", ...)` 要等 ffmpeg 启动才挂上。**这段窗口里断流就没人接**，
// 于是 'error' 变成 unhandled → 进程退出。
//
// 🔴 这一节测的是**修复机制本身**：Node 里"一个 ERR 的流只要有 error 监听就不会
//    打死进程"。这不是废话断言 —— 去掉 `guardStreamErrors`（变异测试）后，
//    下面第一条会直接让**测试进程崩溃**，而不是断言失败。

/** 造一个「已建好、随后出错」的流，等价于 CDN 中途断流。 */
const erroringStream = () => {
  const stream = new Readable({
    read() {
      queueMicrotask(() => {
        stream.destroy(Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }));
      });
    },
  });
  return stream;
};

test("★ 有 error 监听的流不会打死进程（修复的机制本身）", async () => {
  const seen = [];
  const stream = erroringStream();
  stream.on("error", error => seen.push(error?.code || error?.message));
  // 消费掉数据侧，模拟 pipe 到下游
  stream.resume();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(seen, ["UND_ERR_SOCKET"], "错误必须被监听到（而不是抛给进程）");
});

test("★★ 还原事故现场：流建好后完全没人碰它，也不能打死进程", async () => {
  // 这条最贴近真实事故：`prepareVideoInput` 返回流之后，ffmpeg 还没起来挂监听，
  // 此时对端断流。**只要没有 error 监听，Node 就会把它当 unhandled 'error' 抛出。**
  // 没有兜底时，这条测试会让整个测试进程退出（不是断言失败）——变异测试已验证。
  const { guardStreamErrors } = await import("../api/_lib/contentAgent/providers.js");
  const stream = guardStreamErrors(erroringStream(), { logger: { info(){}, warn(){}, error(){} }, label: "test:untouched" });
  // ⚠️ 刻意不 resume、不 pipe、不挂任何监听、不 await 它 —— 纯"放着"。
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(true, "进程还活着 = 兜底生效");
});

test("★ guardStreamErrors 让「无人接管的错误流」不再打死进程", async () => {
  const { guardStreamErrors } = await import("../api/_lib/contentAgent/providers.js");
  const warnings = [];
  const logger = { info(){}, warn: (event) => warnings.push(event), error(){} };

  const stream = guardStreamErrors(erroringStream(), { logger, label: "test:media" });
  stream.resume();
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.deepEqual(warnings, ["stream.error_guarded"], "兜底要留一条日志，便于定位断流");
  assert.ok(true, "跑完这段而进程没退，就是核心断言");
});

test("guardStreamErrors 对 null / 非流对象要安全（不能因为它把调用方搞崩）", async () => {
  const { guardStreamErrors } = await import("../api/_lib/contentAgent/providers.js");
  assert.equal(guardStreamErrors(null), null);
  assert.equal(guardStreamErrors(undefined), undefined);
  const notStream = { foo: 1 };
  assert.equal(guardStreamErrors(notStream), notStream, "没有 .on 的原样返回");
});

test("guardStreamErrors 不吞错误：消费侧直接挂的监听照样能感知失败", async () => {
  const logger = { info(){}, warn(){}, error(){} };
  const consumed = [];

  // ⚠️ 实测澄清了一件事：Node 的 `pipe()` **不会**把源流的 error 转发给下游
  //    （出错时它只调 `dest.end()`，不 emit error）。所以失败感知靠的是消费侧
  //    在**同一个流**上直接挂的监听 —— `extractAudioFromStream` 里的
  //    `inputStream.on("error", ...)` 正是这么做的（然后 kill ffmpeg 并 reject）。
  //    兜底监听因此**不会**把失败变成"静默成功"：两个监听都会收到。
  const source = guardStreamErrors(erroringStream(), { logger, label: "test:consume" });
  source.on("error", error => consumed.push(error?.code || error?.message));
  source.resume();
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.deepEqual(consumed, ["UND_ERR_SOCKET"], "消费侧必须照样收到错误，不能被兜底吞掉");
});
