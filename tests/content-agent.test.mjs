import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkflowCompatiblePayload,
  getShareLinksFromBody,
  normalizeEndingHook,
  parseJsonAgentOutput,
  validateWorkflowCompatiblePayload,
} from "../api/_lib/contentAgent/adapter.js";
import { runContentAgentWorkflow } from "../api/_lib/contentAgent/index.js";
import { getContentAgentConfig, shouldUseContentAgent } from "../api/_lib/contentAgent/config.js";
import { fetchJson } from "../api/_lib/contentAgent/http.js";
import { buildCreativeFallback, describeVideoUrlForDiagnostics, isDirectMp4Url, recognizeDoubaoAudio, runCreativeAgents } from "../api/_lib/contentAgent/providers.js";
import { buildFinalDraftMarkdown, normalizeBenchmarkVideos } from "../api/_lib/exportFormatters.js";
import { BITABLE_FIELDS, finalDraftToBitableRecords, markdownToFeishuBlocks, parseFeishuBitableUrl } from "../api/_lib/feishuClient.js";

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

test("routes the main content workflow to the agent", () => {
  assert.equal(shouldUseContentAgent({ workflow_id: "7618854964156563519" }), true);
  assert.equal(shouldUseContentAgent({ workflow_id: "translation-workflow" }), false);
});

test("configures ffmpeg primary provider and Doubao video fallback", () => {
  const original = {
    TRANSCRIPT_PROVIDERS: process.env.TRANSCRIPT_PROVIDERS,
    AGENT_CREATIVE_RETRY_ATTEMPTS: process.env.AGENT_CREATIVE_RETRY_ATTEMPTS,
    AGENT_CREATIVE_RETRY_BASE_DELAY_MS: process.env.AGENT_CREATIVE_RETRY_BASE_DELAY_MS,
    DOUBAO_RESOURCE_ID: process.env.DOUBAO_RESOURCE_ID,
    DOUBAO_ASR_ENDPOINT: process.env.DOUBAO_ASR_ENDPOINT,
    DOUBAO_VIDEO_ENDPOINT: process.env.DOUBAO_VIDEO_ENDPOINT,
    DOUBAO_VIDEO_API_KEY: process.env.DOUBAO_VIDEO_API_KEY,
  };

  try {
    process.env.TRANSCRIPT_PROVIDERS = "legacy-provider,ffmpeg,doubao-video";
    process.env.AGENT_CREATIVE_RETRY_ATTEMPTS = "3";
    process.env.AGENT_CREATIVE_RETRY_BASE_DELAY_MS = "1500";
    delete process.env.DOUBAO_RESOURCE_ID;
    delete process.env.DOUBAO_ASR_ENDPOINT;
    process.env.DOUBAO_VIDEO_ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/chat/completions";
    process.env.DOUBAO_VIDEO_API_KEY = "test-key";

    const config = getContentAgentConfig();
    assert.deepEqual(config.transcriptProviders, ["ffmpeg", "doubao-video"]);
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
    const agent = system.includes("短视频爆款标题生成助手")
      ? "title"
      : system.includes("改写爆款抖音短视频文案助手")
        ? "script"
        : system.includes("短视频开场文案")
          ? "opening"
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
  assert.equal(records[0].fields["选题标题"], "对标视频标题");
  assert.deepEqual(records[0].fields["视频链接"], {
    text: "对标视频标题",
    link: "https://www.douyin.com/video/demo",
  });
  assert.deepEqual(records[0].fields["视频封面"], {
    text: "查看封面",
    link: "https://example.com/cover.webp",
  });
  assert.equal(records[0].fields["视频时长"], 62);
  assert.equal(records[0].fields["作者"], "示例作者");
  assert.equal(records[0].fields["点赞数"], 123);
  assert.equal(records[0].fields["评论数"], 45);
  assert.equal(records[0].fields["转发数"], 6);
  assert.equal(records[0].fields["收藏数"], 7);
  assert.equal(records[0].fields["热词"], "用工合规、劳动仲裁");
  assert.equal(records[0].fields["生成标题"], "生成标题");
  assert.equal(records[0].fields["三秒留存"], "三秒留存");
  assert.equal(records[0].fields["二创文案"], "二创文案");
  assert.equal(records[0].fields["风格转写结果"], "风格转写");
  assert.equal(records[0].fields["中英翻译结果"], "中英转写");
  assert.equal(typeof records[0].fields["导出时间"], "number");
});

test("defines Feishu Bitable schema with a text index field", () => {
  assert.deepEqual(BITABLE_FIELDS[0], { field_name: "选题标题", type: 1 });
  assert.equal(BITABLE_FIELDS.some(field => field.field_name === "视频链接" && field.type === 15), true);
  assert.equal(BITABLE_FIELDS.some(field => field.field_name === "视频封面" && field.type === 15), true);
  assert.equal(BITABLE_FIELDS.some(field => field.field_name === "视频时长" && field.type === 2), true);
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
