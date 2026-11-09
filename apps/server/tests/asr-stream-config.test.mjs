// ASR 默认链回归测试。
//
// 2026-10-18 两次迁移：
//   ① 首位：录音文件识别 2.0（doubao-file → volc.seedasr.auc）→ 流式识别 2.0
//      （doubao-stream → volc.seedasr.sauc.duration，20h 免费额度）；
//   ② 链尾兜底：极速版 flash（tikhub-music / tikhub-ffmpeg / ffmpeg）→
//      「豆包录音文件识别模型 2.0」（doubao-file → volc.seedasr.auc，URL 异步）。
// 这里把「无 env 时的默认链 / 默认资源 id」钉住，避免以后又静默漂移：
// 这类漂移上次直接导致了账单扣费（见 docs/ASR-MODEL-USAGE.md）。

import test from "node:test";
import assert from "node:assert/strict";

import { getContentAgentConfig } from "../api/_lib/contentAgent/config.js";

const ASR_ENV_KEYS = [
  "TRANSCRIPT_PROVIDERS",
  "GOLD_TRANSCRIPT_PROVIDERS",
  "TIKHUB_TRANSCRIPT_PROVIDER_ENABLED",
  "TIKHUB_MUSIC_PROVIDER_ENABLED",
  "DOUBAO_STREAM_ASR_URL",
  "DOUBAO_STREAM_ASR_RESOURCE_ID",
  "DOUBAO_STREAM_ASR_BUDGET_MS",
  "DOUBAO_STREAM_ASR_CHUNK_BYTES",
  "DOUBAO_FILE_ASR_RESOURCE_ID",
  "DOUBAO_RESOURCE_ID",
];

// 极速版 flash 的三个 provider —— 默认链里出现任意一个都算回退到 1.0 计费通道。
const FLASH_PROVIDERS = ["tikhub-music", "tikhub-ffmpeg", "ffmpeg"];

const withCleanAsrEnv = (fn) => {
  const saved = new Map(ASR_ENV_KEYS.map(key => [key, process.env[key]]));
  try {
    for (const key of ASR_ENV_KEYS) delete process.env[key];
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("无 env 时：默认链 = 流式 2.0 → 录音文件识别 2.0 → 视频理解，且不含极速版 flash", () => {
  withCleanAsrEnv(() => {
    const config = getContentAgentConfig();

    // 全局链：基础默认 [doubao-stream, doubao-file, doubao-video]；无 ffmpeg 所以不会触发
    // TikHub 自动 unshift；doubao-stream 显式在链首时保持链首。
    assert.deepEqual(config.transcriptProviders, [
      "doubao-stream",
      "doubao-file",
      "doubao-video",
    ]);
    // gold 链不吃自动 unshift，按配置原样使用
    assert.deepEqual(config.goldTranscriptProviders, [
      "doubao-stream",
      "doubao-video",
      "doubao-file",
    ]);
    // 默认链里不能出现任何极速版 flash provider（它们内部调 volc.bigasr.auc_turbo）。
    for (const provider of FLASH_PROVIDERS) {
      assert.equal(config.transcriptProviders.includes(provider), false, `全局链不应含 flash provider: ${provider}`);
      assert.equal(config.goldTranscriptProviders.includes(provider), false, `gold 链不应含 flash provider: ${provider}`);
    }
  });
});

test("默认资源 id：流式 2.0 小时版 + 录音文件识别 2.0（兜底）", () => {
  withCleanAsrEnv(() => {
    const config = getContentAgentConfig();
    assert.equal(config.doubaoStreamAsrUrl, "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async");
    assert.equal(config.doubaoStreamAsrResourceId, "volc.seedasr.sauc.duration");
    assert.equal(config.doubaoStreamAsrBudgetMs, 120000);
    assert.equal(config.doubaoStreamAsrChunkBytes, 6400);
    // doubao-file 现在作为 2.0 兜底仍在默认链里，资源 id 必须是 volc.seedasr.auc
    assert.equal(config.doubaoFileAsrResourceId, "volc.seedasr.auc");
  });
});

test("显式 env 可覆盖链与资源 id；回滚到极速版时 flash provider 仍可用", () => {
  withCleanAsrEnv(() => {
    // 正常配置（与 .env.example 一致）
    process.env.TRANSCRIPT_PROVIDERS = "doubao-stream,doubao-file,doubao-video";
    process.env.GOLD_TRANSCRIPT_PROVIDERS = "doubao-stream,doubao-video,doubao-file";
    process.env.DOUBAO_STREAM_ASR_RESOURCE_ID = "volc.seedasr.sauc.concurrent";
    process.env.DOUBAO_STREAM_ASR_BUDGET_MS = "90000";
    process.env.DOUBAO_STREAM_ASR_CHUNK_BYTES = "12800";

    const config = getContentAgentConfig();
    assert.deepEqual(config.transcriptProviders, ["doubao-stream", "doubao-file", "doubao-video"]);
    assert.equal(config.goldTranscriptProviders[0], "doubao-stream");
    assert.equal(config.doubaoStreamAsrResourceId, "volc.seedasr.sauc.concurrent");
    assert.equal(config.doubaoStreamAsrBudgetMs, 90000);
    assert.equal(config.doubaoStreamAsrChunkBytes, 12800);

    // 回滚：显式把极速版 flash 段放回链里（含 ffmpeg 时 TikHub 两个会被自动 unshift 到链首，
    // doubao-stream 作为 preferred prefix 仍保持链首）。
    process.env.TRANSCRIPT_PROVIDERS = "doubao-stream,ffmpeg,doubao-video";
    process.env.GOLD_TRANSCRIPT_PROVIDERS = "doubao-stream,doubao-video,tikhub-music,tikhub-ffmpeg,ffmpeg";
    const rollbackConfig = getContentAgentConfig();
    assert.deepEqual(rollbackConfig.transcriptProviders, [
      "doubao-stream",
      "tikhub-music",
      "tikhub-ffmpeg",
      "ffmpeg",
      "doubao-video",
    ]);
    assert.deepEqual(rollbackConfig.goldTranscriptProviders, [
      "doubao-stream",
      "doubao-video",
      "tikhub-music",
      "tikhub-ffmpeg",
      "ffmpeg",
    ]);

    // 录音文件识别 2.0 的资源 id 默认值仍在
    assert.equal(rollbackConfig.doubaoFileAsrResourceId, "volc.seedasr.auc");
  });
});
