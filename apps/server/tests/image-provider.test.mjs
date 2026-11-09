import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_REFERENCE_IMAGES,
  editImage,
  generateImage,
  getImageConfig,
  isImageGenerationConfigured,
  normalizeImageResponse,
} from "../api/_lib/contentAgent/imageProvider.js";

/**
 * 出图 provider 的契约测试。
 *
 * 🔴 全程**不发出真实请求**（stub 掉 global.fetch）—— 出图是按张计费的，
 * 单测绝不能真的调网关。这里钉的是「请求长什么样 / 返回怎么解析 / 不可用时怎么降级」。
 */

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const withStubbedFetch = async (handler, run) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
};

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

const config = { baseUrl: "https://example.test", apiKey: "test-key", model: "gpt-image-2.5-sunburst", timeoutMs: 5000 };

test("没配密钥时如实报「未配置」而不是发请求 —— 调用方据此降级", async () => {
  assert.equal(isImageGenerationConfigured({}), false);
  assert.equal(isImageGenerationConfigured({ XXCAPI_API_KEY: "k" }), true);
  assert.equal(getImageConfig({}).model, "gpt-image-2.5-sunburst", "默认模型");
  assert.equal(getImageConfig({ XXCAPI_BASE_URL: "https://x.test/" }).baseUrl, "https://x.test/");

  await withStubbedFetch(
    () => { throw new Error("不该发请求"); },
    async (calls) => {
      await assert.rejects(
        () => generateImage("一只猫", { config: { ...config, apiKey: "" } }),
        error => error.code === "IMAGE_NOT_CONFIGURED" && error.status === 501,
      );
      assert.equal(calls.length, 0, "没配密钥就一个请求都不该发");
    },
  );
});

test("文生图：打到 /v1/images/generations，带 Bearer 与规范化后的参数", async () => {
  await withStubbedFetch(
    () => jsonResponse({ data: [{ url: "https://cdn.test/a.png" }] }),
    async (calls) => {
      const result = await generateImage("超龄用工新规封面", {
        config,
        size: "1024x1536",
        quality: "xhigh",
        aspectRatio: "3:4",
        background: "opaque",
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://example.test/v1/images/generations");
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");

      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.model, "gpt-image-2.5-sunburst");
      assert.equal(body.prompt, "超龄用工新规封面");
      assert.equal(body.size, "1024x1536");
      assert.equal(body.quality, "xhigh");
      assert.equal(body.aspectRatio, "3:4");
      assert.equal(body.response_format, "url");
      // 网关明确要求不要传 provider（会与模型变体冲突）。
      assert.equal("provider" in body, false);
      assert.equal(result.images[0].url, "https://cdn.test/a.png");
    },
  );
});

test("非法参数被收敛到安全默认值，不会把野值透给网关", async () => {
  await withStubbedFetch(
    () => jsonResponse({ data: [{ url: "https://cdn.test/a.png" }] }),
    async (calls) => {
      await generateImage("x", {
        config,
        size: "巨大",
        quality: "ultra",
        background: "彩虹",
        aspectRatio: "随便",
        count: 99,
      });
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.size, "2K");
      assert.equal(body.quality, "high");
      assert.equal(body.background, "opaque");
      assert.equal(body.aspectRatio, "3:4");
      assert.equal(body.n, 4, "张数夹到上限 4");
    },
  );
});

test("认 url 与 b64_json 两种返回 —— 网关配置不同返回不同", () => {
  assert.deepEqual(
    normalizeImageResponse({ data: [{ url: "https://cdn.test/a.png" }] }),
    [{ url: "https://cdn.test/a.png", dataUrl: "" }],
  );
  const fromB64 = normalizeImageResponse({ data: [{ b64_json: PNG_1PX }] });
  assert.equal(fromB64[0].url, "");
  assert.match(fromB64[0].dataUrl, /^data:image\/png;base64,/);
  // 顶层 url 的兜底形状
  assert.deepEqual(normalizeImageResponse({ url: "https://cdn.test/b.png" }), [{ url: "https://cdn.test/b.png", dataUrl: "" }]);
  // 垃圾输入回空数组（由调用方判定成失败，不能假装成功）
  assert.deepEqual(normalizeImageResponse(null), []);
  assert.deepEqual(normalizeImageResponse({ data: [{}] }), []);
});

test("返回里没有图片时报「没有返回任何图片」—— 不能静默回空让上层以为成功", async () => {
  await withStubbedFetch(
    () => jsonResponse({ data: [] }),
    async () => {
      await assert.rejects(() => generateImage("x", { config }), error => error.code === "IMAGE_EMPTY_RESULT");
    },
  );
});

test("网关返回非 2xx 时把状态码与报错片段带回来（截断，避免日志被撑爆）", async () => {
  await withStubbedFetch(
    () => new Response("x".repeat(5000), { status: 429 }),
    async () => {
      await assert.rejects(
        () => generateImage("x", { config }),
        error => error.code === "IMAGE_HTTP_ERROR"
          && error.details.status === 429
          && error.details.body.length === 500,
      );
    },
  );
});

test("参考图编辑：走 multipart，带 image[] 与 output_format，且能下载 http 参考图", async () => {
  await withStubbedFetch(
    (url) => {
      if (url.includes("/images/edits")) return jsonResponse({ data: [{ b64_json: PNG_1PX }] });
      // 参考图下载
      return new Response(Buffer.from(PNG_1PX, "base64"), { status: 200, headers: { "Content-Type": "image/png" } });
    },
    async (calls) => {
      const result = await editImage(
        "把背景换成办公室，保留人物",
        [{ url: "https://cdn.test/ref-1.png" }, { dataUrl: `data:image/png;base64,${PNG_1PX}` }],
        { config, aspectRatio: "3:4" },
      );

      const editCall = calls.find(call => call.url.includes("/images/edits"));
      assert.ok(editCall, "必须打到 /v1/images/edits");
      assert.ok(editCall.init.body instanceof FormData, "编辑接口用 multipart 而不是 JSON");
      assert.equal(editCall.init.headers.Authorization, "Bearer test-key");
      // 不要手写 Content-Type —— 必须让 fetch 自己带 boundary。
      assert.equal("Content-Type" in editCall.init.headers, false);

      const form = editCall.init.body;
      assert.equal(form.get("model"), "gpt-image-2.5-sunburst");
      assert.equal(form.get("prompt"), "把背景换成办公室，保留人物");
      assert.equal(form.get("aspect_ratio"), "3:4");
      assert.equal(form.get("output_format"), "png");
      assert.equal(form.getAll("image[]").length, 2, "两张参考图都要带上");

      assert.match(result.images[0].dataUrl, /^data:image\/png;base64,/);
    },
  );
});

test("参考图必须有 url 或 dataUrl；一张都没有时明确报错", async () => {
  await assert.rejects(
    () => editImage("x", [], { config }),
    error => error.code === "IMAGE_NO_REFERENCE",
  );
  await assert.rejects(
    () => editImage("x", [{ name: "只有名字" }], { config }),
    error => error.code === "IMAGE_BAD_REFERENCE",
  );
  await assert.rejects(
    () => editImage("x", [{ dataUrl: "data:image/png;base64" }], { config }),
    error => error.code === "IMAGE_BAD_REFERENCE",
  );
});

test("参考图超过体积上限时提前报错，不打给网关白等", async () => {
  await withStubbedFetch(
    () => { throw new Error("不该发请求"); },
    async (calls) => {
      // 构造一张 > 8MB 的假图（全 0 的 base64 会被压缩，所以用随机字节）。
      const big = Buffer.alloc(9 * 1024 * 1024, 7).toString("base64");
      await assert.rejects(
        () => editImage("x", [{ dataUrl: `data:image/png;base64,${big}` }], { config }),
        error => error.code === "IMAGE_REFERENCE_TOO_LARGE" && error.status === 413,
      );
      assert.equal(calls.length, 0, "超限就该在本地拦下");
    },
  );
});

test("参考图张数夹到上限 —— 不让一次请求带十几张把网关打挂", async () => {
  await withStubbedFetch(
    (url) => (url.includes("/images/edits")
      ? jsonResponse({ data: [{ url: "https://cdn.test/a.png" }] })
      : new Response(Buffer.from(PNG_1PX, "base64"), { status: 200, headers: { "Content-Type": "image/png" } })),
    async (calls) => {
      const many = Array.from({ length: 10 }, (_, index) => ({ url: `https://cdn.test/ref-${index}.png` }));
      await editImage("x", many, { config });
      const editCall = calls.find(call => call.url.includes("/images/edits"));
      assert.equal(editCall.init.body.getAll("image[]").length, MAX_REFERENCE_IMAGES);
    },
  );
});

test("日志里不出现密钥与图片内容（只记长度/张数/耗时）", async () => {
  const logged = [];
  const logger = {
    info: (event, meta) => logged.push({ event, meta }),
    warn: (event, meta) => logged.push({ event, meta }),
  };
  await withStubbedFetch(
    () => jsonResponse({ data: [{ b64_json: PNG_1PX }] }),
    async () => {
      await generateImage("很长的提示词".repeat(50), { config, logger });
    },
  );
  const text = JSON.stringify(logged);
  assert.equal(text.includes("test-key"), false, "日志里绝不能出现密钥");
  assert.equal(text.includes(PNG_1PX.slice(0, 40)), false, "日志里绝不能出现图片内容");
  assert.ok(logged.some(item => item.event === "image.generate.start"));
  assert.ok(logged.some(item => item.event === "image.generate.done"));
});

test("★ 上游非 2xx 时：原因必须进**错误消息**（否则 403 无从判断）", async () => {
  // 2026-09-24 实测：出图返回 403，日志里只有「出图接口返回 403」——
  // 网关其实回了原因（余额不足 / 没有该模型权限 / 端点未开通），全被丢掉了，
  // 于是既不知道该找谁、也不知道该改什么。路由只记录 error.message，
  // 所以能照做的信息必须拼进 message，不能只塞在 details 里。
  await withStubbedFetch(
    () => jsonResponse({ error: { message: "余额不足，请充值" } }, 403),
    async () => {
      await assert.rejects(
        () => generateImage("一只猫", { config }),
        error => {
          assert.equal(error.code, "IMAGE_HTTP_ERROR");
          assert.equal(error.status, 403, "HTTP 码要挂到 error.status（两个后端按它取响应码）");
          assert.match(error.message, /403/, "消息里要带状态码");
          assert.match(error.message, /余额不足/, "上游原话必须进消息，否则无从判断原因");
          assert.ok(String(error.details?.body || "").includes("余额不足"), "details 里保留原始返回体");
          return true;
        },
      );
    },
  );
});

test("上游 2xx 但什么都没回时：如实说「上游没有给出原因」，不编一个", async () => {
  await withStubbedFetch(
    () => new Response("", { status: 500 }),
    async () => {
      await assert.rejects(
        () => generateImage("一只猫", { config }),
        error => {
          assert.match(error.message, /上游没有给出原因/);
          return true;
        },
      );
    },
  );
});

test("★ 网络层失败要翻译成中文原因（「fetch failed」什么都没说）", async () => {
  // 2026-09-24 实测：出图日志只有 error="fetch failed"（2ms 就失败，请求根本没发出去）。
  // 真正的原因在 error.cause（ENOTFOUND / ECONNREFUSED / …）里，不翻译就只能靠猜，
  // 而这两种原因的处置完全不同：域名解析失败多半是代理/DNS 没放行，连接被拒是代理没开。
  await withStubbedFetch(
    () => {
      const error = new Error("fetch failed");
      error.cause = Object.assign(new Error("getaddrinfo ENOTFOUND xxcapi.com"), { code: "ENOTFOUND" });
      throw error;
    },
    async () => {
      await assert.rejects(
        () => generateImage("一只猫", { config }),
        error => {
          assert.equal(error.code, "IMAGE_NETWORK_ERROR", "网络失败要有独立的 code，别混进 IMAGE_HTTP_ERROR");
          assert.match(error.message, /域名解析失败/, "要给出中文原因");
          assert.match(error.message, /ENOTFOUND/, "也要带上原始 code");
          return true;
        },
      );
    },
  );
});

test("★ 配了出图代理时，请求必须带上 dispatcher（裸 fetch 在只能走代理的网络里必挂）", async () => {
  // 出图以前用裸 fetch，而媒体抓取早就支持代理 —— 于是同一台机器上
  // 「抓视频能过、出图 fetch failed」。这条钉住「配置了就要真的用上」。
  await withStubbedFetch(
    () => jsonResponse({ data: [{ b64_json: PNG_1PX }] }),
    async calls => {
      await generateImage("一只猫", { config: { ...config, proxyUrl: "http://127.0.0.1:7890" } });
      assert.ok(calls.length > 0, "要发出请求");
      assert.ok(calls[0].init.dispatcher, "配了 proxyUrl 就必须带 dispatcher");
    },
  );
});

test("★ DNS 解析失败要重试（请求没到网关，重试不花钱）", async () => {
  // 本机实测：出图域名时而解析不了时而正常（代理/VPN 的 DNS 抖动）。
  // 这类失败**请求根本没发出去**，所以重试不会重复计费，而往往一两秒后就通了。
  let attempts = 0;
  await withStubbedFetch(
    () => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("fetch failed");
        error.cause = Object.assign(new Error("getaddrinfo ENOTFOUND xxcapi.com"), { code: "ENOTFOUND" });
        throw error;
      }
      return jsonResponse({ data: [{ b64_json: PNG_1PX }] });
    },
    async () => {
      const result = await generateImage("一只猫", { config });
      assert.equal(attempts, 3, "前两次 DNS 失败后应当再试，第三次成功");
      assert.equal(result.images.length, 1);
    },
  );
});

test("★★ 上游 5xx/超时**绝不重试**（上游可能已经在出图，重试等于重复扣费）", async () => {
  let attempts = 0;
  await withStubbedFetch(
    () => { attempts += 1; return jsonResponse({ error: { message: "上游炸了" } }, 500); },
    async () => {
      await assert.rejects(() => generateImage("一只猫", { config }), error => error.code === "IMAGE_HTTP_ERROR");
      assert.equal(attempts, 1, "5xx 只该打一次 —— 重试可能重复扣费");
    },
  );
});

test("连接被拒（ECONNREFUSED）也算「没到网关」，要重试", async () => {
  let attempts = 0;
  await withStubbedFetch(
    () => {
      attempts += 1;
      if (attempts < 2) {
        const error = new Error("fetch failed");
        error.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        throw error;
      }
      return jsonResponse({ data: [{ b64_json: PNG_1PX }] });
    },
    async () => {
      await generateImage("一只猫", { config });
      assert.equal(attempts, 2);
    },
  );
});
