// 流式识别 2.0「同一份 PCM 重试一次」回归测试（2026-10-18 A 方案）。
//
// 背景：视频号的解密流是一次性的（prepareVideoInput 只能消费一次），WS 失败后不能重新抽音频。
// 因此 provider 层在 PCM 抽好之后、WS 失败时用同一个 Buffer 重试一次；本文件把
// recognizeImpl 注入成假函数，只测重试策略（不联网、不耗额度）。

import test from "node:test";
import assert from "node:assert/strict";

import { recognizeDoubaoStreamAudioWithRetry } from "../api/_lib/contentAgent/providers.js";

const pcm = Buffer.alloc(12800, 7);
const baseConfig = { doubaoStreamAsrBudgetMs: 120000 };

const retryableError = (message = "ws boom", code = "DOUBAO_STREAM_ASR_FAILED") => {
  const error = new Error(message);
  error.code = code;
  return error;
};

test("第一次 WS 失败 → 用同一份 PCM 重试一次并成功", async () => {
  const calls = [];
  const recognizeImpl = async ({ pcm: attemptPcm, config }) => {
    calls.push({ bytes: attemptPcm.length, firstByte: attemptPcm[0], budget: config.doubaoStreamAsrBudgetMs });
    if (calls.length === 1) throw retryableError("first attempt failed");
    return { text: "重试成功", utterances: [], logid: "logid-retry", duration: 5000, provider: "doubao-stream-asr" };
  };

  const result = await recognizeDoubaoStreamAudioWithRetry({
    pcm,
    config: baseConfig,
    recognizeImpl,
    retryBudgetMs: 5000,
    retryDelayMs: 0,
  });

  assert.equal(result.text, "重试成功");
  assert.equal(result.logid, "logid-retry");
  assert.equal(calls.length, 2, "应恰好尝试 2 次");
  // 两次都必须是同一份 PCM（视频号流无法二次消费，重试不能重新抽音频）
  assert.equal(calls[0].bytes, pcm.length);
  assert.equal(calls[1].bytes, pcm.length);
  assert.equal(calls[1].firstByte, pcm[0]);
  // 第一次用原预算；第二次用更短的 retryBudgetMs，避免 120+120 顶穿端点预算
  assert.equal(calls[0].budget, 120000);
  assert.equal(calls[1].budget, 5000);
});

test("重试预算不会超过第一次的预算", async () => {
  const calls = [];
  await recognizeDoubaoStreamAudioWithRetry({
    pcm,
    config: { doubaoStreamAsrBudgetMs: 3000 },
    recognizeImpl: async ({ config }) => {
      calls.push(config.doubaoStreamAsrBudgetMs);
      if (calls.length === 1) throw retryableError();
      return { text: "ok", utterances: [], logid: "", duration: 1, provider: "doubao-stream-asr" };
    },
    retryBudgetMs: 60000,
    retryDelayMs: 0,
  });
  assert.deepEqual(calls, [3000, 3000], "retryBudget 取 min(60000, 第一次预算)");
});

test("不可重试错误（缺凭据）只尝试一次", async () => {
  let calls = 0;
  const error = retryableError("missing credentials", "DOUBAO_STREAM_CREDENTIALS_MISSING");
  await assert.rejects(
    recognizeDoubaoStreamAudioWithRetry({
      pcm,
      config: baseConfig,
      recognizeImpl: async () => {
        calls += 1;
        throw error;
      },
      retryDelayMs: 0,
    }),
    /missing credentials/,
  );
  assert.equal(calls, 1);
});

test("空文本（DOUBAO_STREAM_ASR_EMPTY）不重试，避免重复计费", async () => {
  let calls = 0;
  await assert.rejects(
    recognizeDoubaoStreamAudioWithRetry({
      pcm,
      config: baseConfig,
      recognizeImpl: async () => {
        calls += 1;
        throw retryableError("empty transcript", "DOUBAO_STREAM_ASR_EMPTY");
      },
      retryDelayMs: 0,
    }),
    /empty transcript/,
  );
  assert.equal(calls, 1);
});

test("两次都失败：抛第二次错误，且总尝试次数不超过 2", async () => {
  let calls = 0;
  await assert.rejects(
    recognizeDoubaoStreamAudioWithRetry({
      pcm,
      config: baseConfig,
      recognizeImpl: async () => {
        calls += 1;
        throw retryableError(`attempt ${calls} failed`);
      },
      retryDelayMs: 0,
    }),
    /attempt 2 failed/,
  );
  assert.equal(calls, 2);
});

test("maxAttempts=1 时完全不重试", async () => {
  let calls = 0;
  await assert.rejects(
    recognizeDoubaoStreamAudioWithRetry({
      pcm,
      config: baseConfig,
      maxAttempts: 1,
      recognizeImpl: async () => {
        calls += 1;
        throw retryableError();
      },
      retryDelayMs: 0,
    }),
    /ws boom/,
  );
  assert.equal(calls, 1);
});
