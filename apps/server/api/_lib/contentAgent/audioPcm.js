import { spawn } from "child_process";

import { AgentError } from "./http.js";

/**
 * 视频/音频 → **16k 单声道 s16le raw PCM**，给「流式/实时语音识别 2.0」
 * （`volc.seedasr.sauc.duration`，见 asrStreamClient.js）当输入。
 *
 * 为什么要单独一层：
 *   · 老的「录音文件识别 2.0」把**音频 URL** 交给服务端自己拉，本地不需要解码；
 *     流式识别走 WebSocket，必须由我们提供 **PCM 字节流**，所以要在本地用 ffmpeg
 *     抽音频。抽 PCM 与编码参数（16k/16bit/单声道）是这条通道的全部硬约束，
 *     独立成模块后 providers.js 只关心「拿一段 PCM 去发」，不再关心 ffmpeg 细节。
 *   · head/tail 裁剪在 PCM 层做才**真的有效**：只有开头 5 秒就只解 5 秒，
 *     不会像 URL 通道那样整条视频都算用量。
 *
 * 为什么可以**整段 Buffer 化、burst 全速发送**（不是流式节拍）：
 *   Lead 已用真实 API 验证——流式识别 2.0 允许客户端把 PCM 一次性全速灌进
 *   WebSocket（不要求按 200ms 实时节拍），实测 26.8s 音频约 2.6s 就能拿到最终结果。
 *   所以这里把 ffmpeg 输出**收集成 Buffer** 再交给上层即可，不必做背压/节拍控制。
 *
 * 错误码约定（与 providers.js 的 provider 链对齐，上层只看 code 决定是否回退）：
 *   · `FFMPEG_DISABLED`      配置关掉了 ffmpeg（config.ffmpegEnabled === false）
 *   · `FFMPEG_MISSING`       ffmpeg-static 不可用且未设 FFMPEG_PATH
 *   · `PCM_TIMEOUT`          ffmpeg 超过 config.ffmpegTimeoutMs
 *   · `PCM_AUDIO_TOO_LARGE`  输出 PCM 超过 32MB
 *   · `PCM_FFMPEG_FAILED`    ffmpeg 非 0 退出 / 起不来（details 里带 stderr 尾部）
 *   · `PCM_EMPTY`            输出 <1KB（空壳音频）
 *   · `PCM_TAIL_NEEDS_SEEKABLE` 流输入不可 seek，拿不到结尾 N 秒
 *   · `PCM_INPUT_STREAM_MISSING` / `PCM_INPUT_STREAM_FAILED` 输入流缺失/中途报错
 *   · `PCM_NO_AUDIO_SOURCE` / `PCM_ALL_SOURCES_FAILED` 没有任何可直取的音源 / 全部音源失败
 */

/** 流式识别 2.0 固定 16k / 16bit / 单声道 / raw PCM。 */
export const PCM_SAMPLE_RATE = 16000;

/**
 * 每秒 PCM 字节数：16000 采样 × 2 字节（s16le）× 1 声道。
 * 32000 B/s 也用于上层估算「这段音频有多少秒」。
 */
export const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;

/** 单次抽取的 PCM 上限（16kHz 下约 17.5 分钟音频），防内存被异常视频打爆。 */
const PCM_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 最小有效 PCM 字节数。1KB = 32ms，正常裁剪 5 秒 = 160KB。
 * 低于它的输出只可能是「ffmpeg 退出码 0 但没真正读出音轨」的空壳，提前判失败。
 */
const PCM_MIN_VALID_BYTES = 1024;

/** 与 providers.js 的 ffmpegTimeoutMs 默认值保持一致（覆盖 CDN 下载 + 解码）。 */
const DEFAULT_FFMPEG_TIMEOUT_MS = 90000;

/** stderr 只留尾部，避免异常 ffmpeg 输出把日志/内存撑大。 */
const STDERR_TAIL_MAX_CHARS = 4000;

/** 秒数归一化：只接受 >0 的有限数字；0 / 负数 / NaN 一律当"不裁剪"。 */
const normalizeSeconds = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || "").trim());

/** 与 providers.js 的 loadFfmpegPath 同口径：显式 FFMPEG_PATH 优先，否则用 ffmpeg-static。 */
const loadFfmpegPath = async () => {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const imported = await import("ffmpeg-static");
  const ffmpegPath = imported.default || imported;
  if (!ffmpegPath || typeof ffmpegPath !== "string") {
    throw new AgentError("ffmpeg-static did not expose a binary path", { code: "FFMPEG_MISSING" });
  }
  return ffmpegPath;
};

/**
 * 构造 ffmpeg 抽 PCM 的参数。
 *
 * 参数顺序有讲究（与 providers.js 的 buildFfmpegAudioExtractArgs 一致）：
 *   · `-sseof` 是**输入选项**，必须在 `-i` 之前，且要求输入可 seek（本地文件/URL）；
 *   · `-t` 是**输出选项**，放在 `-i` 之后才生效；ffmpeg 拿到够用的输出就会停止读输入，
 *     所以「只转开头 5 秒」能顺带省掉下载/解码整条视频的时间；
 *   · tail 与 clip 互斥（tail 优先）：两者同时给时只输出 `-sseof`，不再加 `-t`。
 *
 * fastProbe 只在「已知输入头部难探测、且只想快速拿开头」时由调用方开启（如 5 秒裁剪），
 * 对完整转写不要开：探测窗口太小可能漏掉音轨，反而把正常视频判成空音频。
 */
export const buildPcmExtractArgs = ({
  input = "pipe:0",
  clipSeconds = 0,
  tailSeconds = 0,
  fastProbe = false,
  config = {},
} = {}) => {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];

  if (fastProbe) {
    args.push(
      "-probesize",
      String(config.ffmpegFastProbeSize || "4194304"),
      "-analyzeduration",
      String(config.ffmpegFastAnalyzeDuration || "3000000"),
    );
  }

  const tail = normalizeSeconds(tailSeconds);
  if (tail > 0) {
    args.push("-sseof", `-${tail}`);
  }

  args.push("-i", input);

  const clip = normalizeSeconds(clipSeconds);
  // tail 已经按 EOF 定位到结尾 N 秒，再叠 `-t` 没有意义；互斥语义与 goldThreeSecondTranscripts 一致。
  if (tail === 0 && clip > 0) {
    args.push("-t", String(clip));
  }

  args.push(
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(PCM_SAMPLE_RATE),
    "-acodec",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1",
  );
  return args;
};

/**
 * 挑出可直接交给 ffmpeg 的 http(s) 音源：music 优先（纯音频、体积小、下载快），
 * 再是视频直链（与 music 相同则去重）。
 *
 * 视频号必须返回空数组：它的媒体在 CDN 上被 Isaac64 加密，远程/直接抽只会得到
 * 乱码 PCM；视频号走 prepared.stream（本地解密流）那条路。
 */
export const pickStreamAudioSources = (videoMeta = {}) => {
  const meta = videoMeta || {};
  const platform = String(meta.platform || meta?.source?.platform || "").trim().toLowerCase();
  if (platform === "wechat_channels" || meta.decodeKey) {
    return [];
  }

  const sources = [];
  const music = String(meta.musicUrl || "").trim();
  if (isHttpUrl(music)) {
    sources.push({ url: music, kind: "music" });
  }
  const video = String(meta.videoUrl || "").trim();
  if (isHttpUrl(video) && video !== music) {
    sources.push({ url: video, kind: "video" });
  }
  return sources;
};

/**
 * 抽 PCM 的公共执行体：spawn ffmpeg → 收集 stdout → 校验 → 返回 Buffer。
 *
 * 关键点（都是 providers.js 那边实测过的坑）：
 *   ① **stdin 的 EPIPE / ERR_STREAM_DESTROYED 不是错误**：ffmpeg 提前退出（裁剪到点、
 *      或已经失败）时我们还在往它的 stdin 写，这属于正常后果；不吞掉就是未捕获异常。
 *   ② **输入流必须先挂 'error' 监听再 pipe**：视频号的下载/解密流随时可能断，
 *      没有监听的话 `error` 会变成进程级 uncaught（Express/serverless 实例直接没）。
 *   ③ **子进程收尾后必须 stopInput**：unpipe + destroy 上游流，否则下载还在白跑，
 *      并且 pipe 会继续往已关闭的 stdin 写（就是 ① 的来源）。
 */
const runPcmFfmpeg = async ({ args, config = {}, logger, inputStream = null, label = "pcm" }) => {
  if (config?.ffmpegEnabled === false) {
    throw new AgentError("ffmpeg PCM extraction is disabled", { code: "FFMPEG_DISABLED" });
  }

  const ffmpegPath = await loadFfmpegPath();
  const configuredTimeoutMs = Number(config?.ffmpegTimeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : DEFAULT_FFMPEG_TIMEOUT_MS;
  const startedAt = Date.now();
  logger?.info("pcm.extract.start", {
    interface: "ffmpeg-static",
    input: inputStream ? "stdin-stream" : "url",
    strategy: label,
    timeoutMs,
  });

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath, args);
    } catch (error) {
      reject(new AgentError("ffmpeg spawn failed", {
        code: "PCM_FFMPEG_FAILED",
        cause: error,
        details: { spawnError: error instanceof Error ? error.message : "spawn failed" },
      }));
      return;
    }

    const chunks = [];
    let totalBytes = 0;
    let stderr = "";
    let settled = false;
    let timer = null;

    const stopInput = () => {
      if (!inputStream) return;
      try { inputStream.unpipe(child.stdin); } catch { /* 解绑失败不影响结果 */ }
      try { if (!inputStream.destroyed) inputStream.destroy(); } catch { /* 销毁失败不影响结果 */ }
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stopInput();
      fn(value);
    };

    const fail = (error) => {
      logger?.warn("pcm.extract.error", {
        interface: "ffmpeg-static",
        strategy: label,
        code: error?.code,
        error: error instanceof Error ? error.message : "PCM extraction failed",
        details: error?.details,
        elapsedMs: Date.now() - startedAt,
      });
      try { child.kill("SIGKILL"); } catch { /* 进程可能已退出 */ }
      finish(reject, error);
    };

    timer = setTimeout(() => {
      fail(new AgentError(`ffmpeg PCM extraction timed out after ${timeoutMs}ms`, {
        code: "PCM_TIMEOUT",
        details: { timeoutMs },
      }));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > PCM_MAX_BYTES) {
        fail(new AgentError("ffmpeg PCM output exceeded limit", {
          code: "PCM_AUDIO_TOO_LARGE",
          details: { bytes: totalBytes, maxBytes: PCM_MAX_BYTES },
        }));
        return;
      }
      chunks.push(chunk);
    });

    // stdout 本身也可能因子进程被 kill 而报错；不挂监听就是 uncaught。
    child.stdout.on("error", (error) => {
      fail(new AgentError("ffmpeg PCM stdout failed", {
        code: "PCM_FFMPEG_FAILED",
        cause: error,
        details: { stdoutError: error instanceof Error ? error.message : "stdout failed" },
      }));
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_TAIL_MAX_CHARS) stderr = stderr.slice(-STDERR_TAIL_MAX_CHARS);
    });

    // 进程起不来（ENOENT / EACCES 等）不会走 close，只会有 error。
    child.on("error", (error) => {
      fail(new AgentError(`ffmpeg spawn failed: ${error.message}`, {
        code: "PCM_FFMPEG_FAILED",
        cause: error,
        details: { spawnError: error instanceof Error ? error.message : "spawn failed" },
      }));
    });

    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new AgentError("ffmpeg PCM extraction failed", {
          code: "PCM_FFMPEG_FAILED",
          details: { exitCode: code, stderr: stderr.trim() },
        }));
        return;
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.length < PCM_MIN_VALID_BYTES) {
        fail(new AgentError("ffmpeg produced empty PCM audio", {
          code: "PCM_EMPTY",
          details: { bytes: pcm.length, threshold: PCM_MIN_VALID_BYTES },
        }));
        return;
      }
      logger?.info("pcm.extract.end", {
        interface: "ffmpeg-static",
        strategy: label,
        bytes: pcm.length,
        elapsedMs: Date.now() - startedAt,
      });
      finish(resolve, pcm);
    });

    if (inputStream) {
      // ① EPIPE / ERR_STREAM_DESTROYED 是 ffmpeg 提前退出的正常后果，静默忽略。
      child.stdin.on("error", (error) => {
        const code = error?.code;
        if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED") {
          logger?.warn("pcm.stdin.error", {
            interface: "ffmpeg-static",
            code,
            error: error instanceof Error ? error.message : "ffmpeg stdin 写入失败",
          });
        }
      });
      // ② 必须先挂源流 error 监听再 pipe，否则断流会直接带走整个进程。
      inputStream.on("error", (error) => {
        fail(new AgentError("ffmpeg PCM input stream failed", {
          code: "PCM_INPUT_STREAM_FAILED",
          cause: error,
          details: { cause: error instanceof Error ? error.message : "input stream failed" },
        }));
      });
      inputStream.pipe(child.stdin);
    }
  });
};

/**
 * 从 URL（http(s)，也可以是 ffmpeg 认得的本地路径）抽 PCM。
 *
 * @param {string} url
 * @param {object} config 需含 ffmpegEnabled / ffmpegTimeoutMs / ffmpegFastProbeSize 等
 * @param {{clipSeconds?:number, tailSeconds?:number, fastProbe?:boolean, logger?:object}} [options]
 * @returns {Promise<Buffer>}
 */
export const extractPcmFromUrl = async (url, config = {}, { clipSeconds = 0, tailSeconds = 0, fastProbe = false, logger } = {}) => {
  const target = String(url || "").trim();
  if (!target) {
    throw new AgentError("PCM audio URL is required", { code: "PCM_NO_AUDIO_SOURCE", status: 422 });
  }
  return await runPcmFfmpeg({
    args: buildPcmExtractArgs({ input: target, clipSeconds, tailSeconds, fastProbe, config }),
    config,
    logger,
    label: "url",
  });
};

/**
 * 从 Node readable（视频号解密后的流 / 已打开的文件流）抽 PCM。
 *
 * 管道不可 seek：`-sseof`（取结尾 N 秒）在这里必然失败，所以显式抛
 * `PCM_TAIL_NEEDS_SEEKABLE` 让 provider 链回退，而不是产出一段位置错误的音频。
 */
export const extractPcmFromStream = async (inputStream, config = {}, { clipSeconds = 0, tailSeconds = 0, fastProbe = false, logger } = {}) => {
  if (!inputStream || typeof inputStream.pipe !== "function") {
    throw new AgentError("PCM extraction requires a readable input stream", {
      code: "PCM_INPUT_STREAM_MISSING",
      status: 422,
    });
  }
  if (normalizeSeconds(tailSeconds) > 0) {
    throw new AgentError("PCM tail extraction needs a seekable input, not a stream", {
      code: "PCM_TAIL_NEEDS_SEEKABLE",
    });
  }
  return await runPcmFfmpeg({
    args: buildPcmExtractArgs({ input: "pipe:0", clipSeconds, tailSeconds: 0, fastProbe: Boolean(fastProbe), config }),
    config,
    logger,
    inputStream,
    label: "stream",
  });
};

/**
 * 对外编排：`videoMeta + prepared` → 16k PCM。
 *
 * prepared 就是 providers.js `prepareVideoInput` 的返回值：
 *   · 视频号：`{ videoUrl: null, stream, localFile: false, cleanup }` —— 走解密流；
 *   · 抖音/TikTok：`{ videoUrl, cleanup, localFile: false }` —— 走 music/video 直链。
 *
 * clip 语义与 goldThreeSecondTranscripts 一致：head 用 clipSeconds、tail 用 tailSeconds，
 * 二者互斥且 **tail 优先**（tail>0 时 clipSeconds 归 0，避免同时 `-sseof` + `-t`）。
 *
 * @returns {Promise<{pcm: Buffer, bytes: number, sourceKind: string, audioFormat: "pcm"}>}
 */
export const extractPcmAudio = async (videoMeta, prepared, config = {}, { clipSeconds = 0, tailSeconds = 0, fastProbe = false, logger } = {}) => {
  const meta = videoMeta || {};
  const tail = normalizeSeconds(tailSeconds);
  const head = tail > 0 ? 0 : normalizeSeconds(clipSeconds);
  // 尾部裁剪不用 fastProbe：`-sseof` 已定位到文件尾；head 裁剪用它能把探测窗口压小、明显提速。
  const useFastProbe = tail > 0 ? false : Boolean(fastProbe);

  if (prepared?.stream) {
    const pcm = await extractPcmFromStream(prepared.stream, config, { clipSeconds: head, tailSeconds: tail, fastProbe: useFastProbe, logger });
    return { pcm, bytes: pcm.length, sourceKind: "stream", audioFormat: "pcm" };
  }

  const sources = pickStreamAudioSources(meta);
  if (sources.length === 0) {
    throw new AgentError("No direct http(s) audio source for PCM extraction", {
      code: "PCM_NO_AUDIO_SOURCE",
      status: 422,
      details: { videoTitle: String(meta.title || ""), platform: String(meta.platform || "") },
    });
  }

  const failures = [];
  let lastError = null;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    try {
      const pcm = await extractPcmFromUrl(source.url, config, {
        clipSeconds: head,
        tailSeconds: tail,
        // 完整转写/尾部不启用 fastProbe：探测窗口太小有漏音轨风险；
        // head 裁剪（2.2/2.3/1.2 只取开头几秒）启用它，减少远端探测开销。
        fastProbe: useFastProbe,
        logger,
      });
      return { pcm, bytes: pcm.length, sourceKind: source.kind, audioFormat: "pcm" };
    } catch (error) {
      lastError = error;
      failures.push({
        kind: source.kind,
        code: error?.code,
        message: error instanceof Error ? error.message : "PCM extraction failed",
      });
      logger?.warn("pcm.source.failed", {
        sourceKind: source.kind,
        attempt: index + 1,
        total: sources.length,
        code: error?.code,
        error: error instanceof Error ? error.message : "PCM extraction failed",
        willRetryNextSource: index + 1 < sources.length,
      });
      // ffmpeg 被整体关掉是配置问题，换音源也没用，直接把原始错误抛给上层。
      if (error?.code === "FFMPEG_DISABLED") throw error;
    }
  }

  const wrapper = new AgentError("PCM extraction failed for every audio source", {
    code: "PCM_ALL_SOURCES_FAILED",
    details: { failures },
  });
  // 保留最后一个源的内层 details（ffmpeg stderr / 退出码等），否则多源失败时最难查。
  if (lastError?.details) wrapper.details.lastSource = lastError.details;
  throw wrapper;
};
