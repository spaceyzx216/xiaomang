#!/usr/bin/env node
/**
 * 流式/实时语音识别 2.0（doubao-stream）冒烟脚本。
 *
 * 用途：部署前/后在**本机**验证「API Key + 资源 id + WSS 端点 + PCM 抽取 + 二进制协议」整条链路是否通，
 * 不依赖 TikHub / 数据库 / 前端。只读一个本地音频文件，走和线上 provider 完全相同的代码路径。
 *
 * 用法：
 *   cd apps/server
 *   node scripts/asr-stream-smoke.mjs --file /path/to/audio.wav
 *   node scripts/asr-stream-smoke.mjs --file /path/to/video.mp4 --clip 5
 *
 * 参数：
 *   --file  <path>  必填，本地音频/视频文件（ffmpeg 认得的格式都行）
 *   --clip  <sec>   可选，只转前 N 秒（模拟 2.2/2.3 的 head 裁剪；0 表示完整转写）
 *
 * 退出码：0 成功（打印最终文本与 duration/logid）；1 失败（打印 error.code/message，不打印任何密钥）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, "../.env") });

const { getContentAgentConfig } = await import("../api/_lib/contentAgent/config.js");
const { extractPcmFromUrl } = await import("../api/_lib/contentAgent/audioPcm.js");
const { recognizeDoubaoStreamAudio } = await import("../api/_lib/contentAgent/asrStreamClient.js");

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return "";
  return String(args[index + 1] || "").trim();
};

const file = readArg("--file");
const clip = Number(readArg("--clip") || 0);

if (!file || args.includes("--help") || args.includes("-h")) {
  console.log(`用法: node scripts/asr-stream-smoke.mjs --file <本地音频/视频> [--clip 秒数]

示例:
  node scripts/asr-stream-smoke.mjs --file /tmp/test.wav
  node scripts/asr-stream-smoke.mjs --file /tmp/video.mp4 --clip 5

说明: 读取 apps/server/.env；只打印非敏感字段（端点/资源 id/文本/duration/logid），不打印 API Key。`);
  process.exit(file ? 0 : 1);
}

const config = getContentAgentConfig();
console.log("[asr-stream-smoke] endpoint:", config.doubaoStreamAsrUrl);
console.log("[asr-stream-smoke] resource:", config.doubaoStreamAsrResourceId);
console.log("[asr-stream-smoke] file:", file, "clip:", clip > 0 ? `${clip}s` : "full");

try {
  const startedAt = Date.now();
  const pcm = await extractPcmFromUrl(path.resolve(file), config, { clipSeconds: clip, fastProbe: clip > 0, logger: console });
  const pcmMs = Date.now() - startedAt;
  console.log(`[asr-stream-smoke] pcm: ${pcm.length} bytes (${(pcm.length / 32000).toFixed(1)}s audio, 抽取 ${pcmMs}ms)`);

  const result = await recognizeDoubaoStreamAudio({ pcm, config, logger: console });
  console.log("[asr-stream-smoke] OK", {
    provider: result.provider,
    duration: result.duration,
    logid: result.logid,
    textLength: String(result.text || "").length,
    elapsedMs: Date.now() - startedAt,
  });
  console.log("[asr-stream-smoke] text:", String(result.text || "").slice(0, 200) || "(空)");
} catch (error) {
  console.error("[asr-stream-smoke] FAILED", {
    code: error?.code || "",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
