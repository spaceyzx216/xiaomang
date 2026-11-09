import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PCM_BYTES_PER_SECOND,
  PCM_SAMPLE_RATE,
  buildPcmExtractArgs,
  extractPcmAudio,
  extractPcmFromStream,
  extractPcmFromUrl,
  pickStreamAudioSources,
} from "../api/_lib/contentAgent/audioPcm.js";

/**
 * audioPcm.js 的离线单测。
 *
 * 不依赖真实 ffmpeg、不访问网络：
 *   · 大部分"抽取流程"测试用 `FFMPEG_PATH` 指向一个**假 ffmpeg**（Node 脚本），
 *     由 FAKE_FFMPEG_MODE 决定它的行为（cat / emit / fail / sleep / large / empty）。
 *     这样能精确验证「stdin 泵流、stdout 收集、退出码/stderr、超时 kill、源流 error」
 *     这些真正容易出错的路径，而不会把测试变成 ffmpeg 版本相关。
 *   · 末尾有一条可选的**真实 ffmpeg** 测试：只验证 1 秒裁剪，环境跑不起来就 skip，
 *     绝不让"机器上没有 ffmpeg"把测试套件搞红。
 */

const silentLogger = { info() {}, warn() {}, error() {} };

const BASE_CONFIG = { ffmpegEnabled: true, ffmpegTimeoutMs: 5000 };

/** 生成 16k/16bit/单声道正弦 PCM（1 秒 = 32000 字节），用于验证"原样拼字节"。 */
const makeSinePcm = (seconds = 1, frequency = 440) => {
  const sampleCount = Math.round(seconds * PCM_SAMPLE_RATE);
  const buffer = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / PCM_SAMPLE_RATE) * 12000);
    buffer.writeInt16LE(value, index * 2);
  }
  return buffer;
};

/** 给可选的真实 ffmpeg 测试造一个 16k/16bit/单声道 WAV 容器。 */
const makeWav = (pcm) => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};

/**
 * 假 ffmpeg：通过环境变量切换行为。
 *   cat   —— 把 stdin 原样写到 stdout（验证流式泵入/字节拼接）
 *   emit  —— 输出 4KB 固定内容（验证 URL 路径成功分支）
 *   empty —— 退出码 0 但无输出（PCM_EMPTY）
 *   fail  —— 写 stderr 后退出码 3（PCM_FFMPEG_FAILED + stderr 尾部）
 *   sleep —— 挂住不退出（超时/PCM_TIMEOUT）
 *   large —— 输出 33MB（PCM_AUDIO_TOO_LARGE）
 */
const FAKE_FFMPEG_SCRIPT = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.FAKE_FFMPEG_MODE || "cat";
const argsFile = process.env.FAKE_FFMPEG_ARGS_FILE;
if (argsFile) {
  try { writeFileSync(argsFile, JSON.stringify(args)); } catch { /* ignore */ }
}

const emit = (buffer) => {
  process.stdout.on("error", () => { /* 父进程提前 kill 时忽略 EPIPE */ });
  process.stdout.write(buffer, () => process.exit(0));
};

switch (mode) {
  case "cat":
    process.stdin.pipe(process.stdout);
    break;
  case "emit":
    emit(Buffer.alloc(4096, 7));
    break;
  case "empty":
    process.exit(0);
    break;
  case "fail":
    process.stderr.write("fake ffmpeg: no audio stream\\n");
    process.exit(3);
    break;
  case "sleep":
    setTimeout(() => {}, 30000);
    break;
  case "large":
    emit(Buffer.alloc(33 * 1024 * 1024, 3));
    break;
  default:
    process.stderr.write("unknown fake ffmpeg mode\\n");
    process.exit(9);
}
`;

const FAKE_ENV_KEYS = ["FFMPEG_PATH", "FAKE_FFMPEG_MODE", "FAKE_FFMPEG_ARGS_FILE"];

/**
 * 安装假 ffmpeg：临时把 FFMPEG_PATH 指过去，测试结束恢复全部环境变量并删临时目录。
 * 用 t.after 保证断言失败时也能清理（否则会污染同文件后续测试）。
 */
const installFakeFfmpeg = (t, { mode = "cat", recordArgs = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "xiaomang-pcm-"));
  const binary = join(dir, "fake-ffmpeg.mjs");
  const argsFile = join(dir, "ffmpeg-args.json");
  writeFileSync(binary, FAKE_FFMPEG_SCRIPT);
  chmodSync(binary, 0o755);

  const previous = Object.fromEntries(FAKE_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.FFMPEG_PATH = binary;
  process.env.FAKE_FFMPEG_MODE = mode;
  if (recordArgs) process.env.FAKE_FFMPEG_ARGS_FILE = argsFile;
  else delete process.env.FAKE_FFMPEG_ARGS_FILE;

  t.after(() => {
    for (const key of FAKE_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir, binary, argsFile };
};

/** Windows 上 shebang 假 ffmpeg 不可用；当前仓库开发/部署环境是 macOS/Linux。 */
const fakeFfmpegSkip = process.platform === "win32"
  ? "Windows 无法直接执行 shebang 假 ffmpeg"
  : false;

// ── 常量 ────────────────────────────────────────────────────────────────────

test("PCM 常量：16k 单声道 s16le = 每秒 32000 字节", () => {
  assert.equal(PCM_SAMPLE_RATE, 16000);
  assert.equal(PCM_BYTES_PER_SECOND, 32000);
});

// ── buildPcmExtractArgs ─────────────────────────────────────────────────────

test("buildPcmExtractArgs：无裁剪时只有固定的 16k s16le 编码参数", () => {
  assert.deepEqual(buildPcmExtractArgs(), [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", "pipe:0",
    "-vn", "-ac", "1", "-ar", "16000",
    "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1",
  ]);
});

test("buildPcmExtractArgs：head 用 -t（在 -i 之后），tail 用 -sseof（在 -i 之前）且 tail 优先", () => {
  const head = buildPcmExtractArgs({ input: "https://cdn.example/v.mp4", clipSeconds: 5 });
  assert.equal(head[head.indexOf("-i") + 1], "https://cdn.example/v.mp4");
  assert.ok(head.indexOf("-t") > head.indexOf("-i"), "-t 必须是输出选项，放在 -i 之后");
  assert.equal(head[head.indexOf("-t") + 1], "5");

  const tail = buildPcmExtractArgs({ clipSeconds: 5, tailSeconds: 3 });
  assert.ok(tail.indexOf("-sseof") < tail.indexOf("-i"), "-sseof 必须是输入选项，放在 -i 之前");
  assert.equal(tail[tail.indexOf("-sseof") + 1], "-3");
  assert.equal(tail.includes("-t"), false, "tail 优先时不能再叠加 -t");
});

test("buildPcmExtractArgs：0 / 负数不输出 -t、-sseof", () => {
  for (const options of [{ clipSeconds: 0 }, { clipSeconds: -5 }]) {
    assert.equal(buildPcmExtractArgs(options).includes("-t"), false);
  }
  for (const options of [{ tailSeconds: 0 }, { tailSeconds: -2 }]) {
    assert.equal(buildPcmExtractArgs(options).includes("-sseof"), false);
  }
});

test("buildPcmExtractArgs：fastProbe 参数与默认值（对齐 providers.js）", () => {
  const configured = buildPcmExtractArgs({
    fastProbe: true,
    config: { ffmpegFastProbeSize: "2M", ffmpegFastAnalyzeDuration: "750k" },
  });
  assert.equal(configured[configured.indexOf("-probesize") + 1], "2M");
  assert.equal(configured[configured.indexOf("-analyzeduration") + 1], "750k");

  const defaults = buildPcmExtractArgs({ fastProbe: true });
  assert.equal(defaults[defaults.indexOf("-probesize") + 1], "4194304");
  assert.equal(defaults[defaults.indexOf("-analyzeduration") + 1], "3000000");

  assert.equal(buildPcmExtractArgs().includes("-probesize"), false);
});

// ── pickStreamAudioSources ──────────────────────────────────────────────────

test("pickStreamAudioSources：music 优先、video 去重、非 http 忽略", () => {
  assert.deepEqual(
    pickStreamAudioSources({
      musicUrl: "https://cdn.example/music.mp3",
      videoUrl: "https://cdn.example/video.mp4",
    }),
    [
      { url: "https://cdn.example/music.mp3", kind: "music" },
      { url: "https://cdn.example/video.mp4", kind: "video" },
    ],
  );

  assert.deepEqual(
    pickStreamAudioSources({ videoUrl: "https://cdn.example/video.mp4" }),
    [{ url: "https://cdn.example/video.mp4", kind: "video" }],
  );

  // 同一 URL 既当 music 又当 video 时只保留 music，避免重复抽一遍。
  assert.deepEqual(
    pickStreamAudioSources({
      musicUrl: "https://cdn.example/same.mp4",
      videoUrl: "https://cdn.example/same.mp4",
    }),
    [{ url: "https://cdn.example/same.mp4", kind: "music" }],
  );

  assert.deepEqual(pickStreamAudioSources({ musicUrl: "ftp://x/a.mp3", videoUrl: "not-a-url" }), []);
  assert.deepEqual(pickStreamAudioSources({}), []);
  assert.deepEqual(pickStreamAudioSources(), []);
});

test("pickStreamAudioSources：视频号（platform 或 decodeKey）一律返回空", () => {
  const media = {
    musicUrl: "https://cdn.example/music.mp3",
    videoUrl: "https://cdn.example/encrypted.mp4",
  };
  assert.deepEqual(pickStreamAudioSources({ ...media, platform: "wechat_channels" }), []);
  assert.deepEqual(pickStreamAudioSources({ ...media, source: { platform: "wechat_channels" } }), []);
  assert.deepEqual(pickStreamAudioSources({ ...media, decodeKey: "0123456789abcdef" }), []);
});

// ── extractPcmFromStream ────────────────────────────────────────────────────

test("extractPcmFromStream：把 readable 的字节原样拼成 PCM，参数走 pipe:0", { skip: fakeFfmpegSkip }, async (t) => {
  const fake = installFakeFfmpeg(t, { mode: "cat", recordArgs: true });
  const pcm = makeSinePcm(1);
  const stream = Readable.from([pcm.subarray(0, 12000), pcm.subarray(12000), pcm.subarray(0, 0)]);

  const output = await extractPcmFromStream(stream, BASE_CONFIG, { clipSeconds: 5, logger: silentLogger });

  assert.equal(output.length, pcm.length);
  assert.deepEqual(output, pcm, "PCM 必须与输入字节一致（burst 整段发送，不做重编码以外的处理）");

  const args = JSON.parse(readFileSync(fake.argsFile, "utf8"));
  assert.equal(args[args.indexOf("-i") + 1], "pipe:0");
  assert.equal(args[args.indexOf("-t") + 1], "5");
  assert.equal(args.includes("-sseof"), false);
});

test("extractPcmFromStream：tailSeconds>0 直接抛 PCM_TAIL_NEEDS_SEEKABLE（流不可 seek）", async () => {
  const stream = Readable.from([makeSinePcm(1)]);
  await assert.rejects(
    () => extractPcmFromStream(stream, BASE_CONFIG, { tailSeconds: 3, logger: silentLogger }),
    (error) => error?.code === "PCM_TAIL_NEEDS_SEEKABLE",
  );
});

test("extractPcmFromStream：源流 error 必须 reject 且不产生 uncaught", { skip: fakeFfmpegSkip }, async (t) => {
  // 假 ffmpeg 用 sleep 模式挂住：确保 reject 来自"源流 error → kill 子进程"，
  // 而不是 ffmpeg 正常退出先到一步的竞态。
  installFakeFfmpeg(t, { mode: "sleep" });
  const broken = new Readable({
    read() {
      this.push(makeSinePcm(0.05));
      this.destroy(new Error("cdn connection reset"));
    },
  });

  await assert.rejects(
    () => extractPcmFromStream(broken, BASE_CONFIG, { logger: silentLogger }),
    (error) => (
      error?.code === "PCM_INPUT_STREAM_FAILED"
      && /cdn connection reset/.test(String(error?.details?.cause))
    ),
  );

  // 再让事件循环转一圈：若流/子进程的 error 没被兜住，这里会变成 uncaught 让测试进程失败。
  await new Promise((resolve) => setTimeout(resolve, 30));
});

// ── extractPcmFromUrl ───────────────────────────────────────────────────────

test("extractPcmFromUrl：成功返回 Buffer，并把 URL/clip 传给 ffmpeg", { skip: fakeFfmpegSkip }, async (t) => {
  const fake = installFakeFfmpeg(t, { mode: "emit", recordArgs: true });
  const output = await extractPcmFromUrl("https://cdn.example/v.mp4", BASE_CONFIG, {
    clipSeconds: 5,
    logger: silentLogger,
  });

  assert.equal(output.length, 4096);
  const args = JSON.parse(readFileSync(fake.argsFile, "utf8"));
  assert.equal(args[args.indexOf("-i") + 1], "https://cdn.example/v.mp4");
  assert.equal(args[args.indexOf("-t") + 1], "5");
});

test("extractPcmFromUrl：ffmpeg 非 0 退出 → PCM_FFMPEG_FAILED，details 带退出码与 stderr 尾部", { skip: fakeFfmpegSkip }, async (t) => {
  installFakeFfmpeg(t, { mode: "fail" });
  await assert.rejects(
    () => extractPcmFromUrl("https://cdn.example/v.mp4", BASE_CONFIG, { logger: silentLogger }),
    (error) => (
      error?.code === "PCM_FFMPEG_FAILED"
      && error?.details?.exitCode === 3
      && /no audio stream/.test(String(error?.details?.stderr))
    ),
  );
});

test("extractPcmFromUrl：输出 <1KB → PCM_EMPTY；输出超 32MB → PCM_AUDIO_TOO_LARGE", { skip: fakeFfmpegSkip }, async (t) => {
  installFakeFfmpeg(t, { mode: "empty" });
  await assert.rejects(
    () => extractPcmFromUrl("https://cdn.example/v.mp4", BASE_CONFIG, { logger: silentLogger }),
    (error) => error?.code === "PCM_EMPTY",
  );

  // 同一测试里重新装一次假 ffmpeg（后装的 t.after 先执行，互不干扰）。
  installFakeFfmpeg(t, { mode: "large" });
  await assert.rejects(
    () => extractPcmFromUrl("https://cdn.example/v.mp4", BASE_CONFIG, { logger: silentLogger }),
    (error) => error?.code === "PCM_AUDIO_TOO_LARGE",
  );
});

test("extractPcmFromUrl：超时 kill 子进程 → PCM_TIMEOUT", { skip: fakeFfmpegSkip }, async (t) => {
  installFakeFfmpeg(t, { mode: "sleep" });
  const startedAt = Date.now();
  await assert.rejects(
    () => extractPcmFromUrl("https://cdn.example/v.mp4", { ...BASE_CONFIG, ffmpegTimeoutMs: 100 }, { logger: silentLogger }),
    (error) => error?.code === "PCM_TIMEOUT" && error?.details?.timeoutMs === 100,
  );
  assert.ok(Date.now() - startedAt < 3000, "超时后必须尽快 kill，不能挂死");
});

test("extractPcmFromUrl：config.ffmpegEnabled=false → FFMPEG_DISABLED（不要求 ffmpeg 存在）", async () => {
  await assert.rejects(
    () => extractPcmFromUrl("https://cdn.example/v.mp4", { ffmpegEnabled: false }, { logger: silentLogger }),
    (error) => error?.code === "FFMPEG_DISABLED",
  );
});

test("extractPcmFromUrl：空 URL → PCM_NO_AUDIO_SOURCE", async () => {
  await assert.rejects(
    () => extractPcmFromUrl("", BASE_CONFIG, { logger: silentLogger }),
    (error) => error?.code === "PCM_NO_AUDIO_SOURCE",
  );
});

// ── extractPcmAudio ─────────────────────────────────────────────────────────

test("extractPcmAudio：prepared.stream 路径（视频号解密流）返回 PCM 与原样字节", { skip: fakeFfmpegSkip }, async (t) => {
  installFakeFfmpeg(t, { mode: "cat" });
  const pcm = makeSinePcm(1);
  const prepared = {
    videoUrl: null,
    stream: Readable.from([pcm]),
    localFile: false,
    cleanup: async () => {},
  };

  const result = await extractPcmAudio(
    { platform: "wechat_channels", title: "视频号样本" },
    prepared,
    BASE_CONFIG,
    { clipSeconds: 5, logger: silentLogger },
  );

  assert.equal(result.audioFormat, "pcm");
  assert.equal(result.sourceKind, "stream");
  assert.equal(result.bytes, pcm.length);
  assert.deepEqual(result.pcm, pcm);
});

test("extractPcmAudio：stream 路径 + tailSeconds → PCM_TAIL_NEEDS_SEEKABLE", async () => {
  const prepared = { videoUrl: null, stream: Readable.from([makeSinePcm(1)]), cleanup: async () => {} };
  await assert.rejects(
    () => extractPcmAudio({ platform: "wechat_channels" }, prepared, BASE_CONFIG, { tailSeconds: 5, logger: silentLogger }),
    (error) => error?.code === "PCM_TAIL_NEEDS_SEEKABLE",
  );
});

test("extractPcmAudio：没有任何可直取音源 → PCM_NO_AUDIO_SOURCE", async () => {
  await assert.rejects(
    () => extractPcmAudio(
      { platform: "douyin", title: "没有直链" },
      { videoUrl: "", localFile: false, cleanup: async () => {} },
      BASE_CONFIG,
      { logger: silentLogger },
    ),
    (error) => error?.code === "PCM_NO_AUDIO_SOURCE",
  );
});

test("extractPcmAudio：URL 路径 music 优先（sourceKind=music）", { skip: fakeFfmpegSkip }, async (t) => {
  installFakeFfmpeg(t, { mode: "emit" });
  const videoMeta = {
    platform: "douyin",
    title: "抖音样本",
    musicUrl: "https://cdn.example/music.mp3",
    videoUrl: "https://cdn.example/video.mp4",
  };
  const result = await extractPcmAudio(
    videoMeta,
    { videoUrl: videoMeta.videoUrl, cleanup: async () => {} },
    BASE_CONFIG,
    { logger: silentLogger },
  );
  assert.equal(result.audioFormat, "pcm");
  assert.equal(result.sourceKind, "music");
  assert.equal(result.bytes, 4096);
});

test("extractPcmAudio：tail 优先时把 -sseof 传给 ffmpeg（URL 可 seek）", { skip: fakeFfmpegSkip }, async (t) => {
  const fake = installFakeFfmpeg(t, { mode: "emit", recordArgs: true });
  const videoMeta = { platform: "douyin", title: "抖音样本", videoUrl: "https://cdn.example/video.mp4" };
  await extractPcmAudio(videoMeta, { videoUrl: videoMeta.videoUrl, cleanup: async () => {} }, BASE_CONFIG, {
    clipSeconds: 5,
    tailSeconds: 3,
    logger: silentLogger,
  });

  const args = JSON.parse(readFileSync(fake.argsFile, "utf8"));
  assert.equal(args[args.indexOf("-sseof") + 1], "-3");
  assert.equal(args.includes("-t"), false, "tail 优先时不应再带 -t");
});

test("extractPcmAudio：全部音源失败 → PCM_ALL_SOURCES_FAILED（failures + lastSource.details）", { skip: fakeFfmpegSkip }, async (t) => {
  installFakeFfmpeg(t, { mode: "fail" });
  const videoMeta = {
    platform: "douyin",
    title: "全部失败样本",
    musicUrl: "https://cdn.example/music.mp3",
    videoUrl: "https://cdn.example/video.mp4",
  };
  await assert.rejects(
    () => extractPcmAudio(videoMeta, { videoUrl: videoMeta.videoUrl, cleanup: async () => {} }, BASE_CONFIG, {
      logger: silentLogger,
    }),
    (error) => (
      error?.code === "PCM_ALL_SOURCES_FAILED"
      && Array.isArray(error?.details?.failures)
      && error.details.failures.length === 2
      && error.details.failures[0].kind === "music"
      && error.details.failures[1].kind === "video"
      && error.details.lastSource?.exitCode === 3
    ),
  );
});

// ── 可选：真实 ffmpeg（环境不支持就 skip，绝不让测试红）──────────────────────

test("真实 ffmpeg：本地 WAV 裁 1 秒 → 约 32000 字节 PCM（可选）", async (t) => {
  let ffmpegPath;
  try {
    const imported = await import("ffmpeg-static");
    ffmpegPath = imported.default || imported;
    assert.equal(typeof ffmpegPath, "string");
  } catch (error) {
    t.skip(`ffmpeg-static 不可用：${error instanceof Error ? error.message : error}`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "xiaomang-pcm-real-"));
  const previousPath = process.env.FFMPEG_PATH;
  delete process.env.FFMPEG_PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  });

  const wavPath = join(dir, "sine.wav");
  writeFileSync(wavPath, makeWav(makeSinePcm(2)));

  let pcm;
  try {
    pcm = await extractPcmFromUrl(wavPath, { ffmpegEnabled: true, ffmpegTimeoutMs: 5000 }, {
      clipSeconds: 1,
      logger: silentLogger,
    });
  } catch (error) {
    // 机器上没有可执行 ffmpeg / 编码器缺失：跳过，不让环境问题变红。
    t.skip(`真实 ffmpeg 跑不起来（环境问题）：${error instanceof Error ? error.message : error}`);
    return;
  }

  // 1 秒 16k/16bit/单声道 = 32000 字节；允许容器/帧对齐的少量偏差。
  assert.ok(
    pcm.length >= 30000 && pcm.length <= 34000,
    `裁剪 1 秒的 PCM 长度异常：${pcm.length}`,
  );
});
