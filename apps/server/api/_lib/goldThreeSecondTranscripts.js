import { resolveTikHubVideo, resolveWeChatChannelsTopicVideo, transcribeVideo } from "./contentAgent/providers.js";
import { selectGoldThreeSecondVideos } from "./goldThreeSeconds.js";
import { TRANSCRIPT_SCOPE_HEAD, TRANSCRIPT_SCOPE_SCRIPT, TRANSCRIPT_SCOPE_TAIL } from "./transcriptStore.js";

/**
 * 模块 3 的真实口播转写编排 —— **2.2 和 2.3 共用这一份**。
 *
 *   scope = "head" → 取**开头**几秒（2.2 黄金三秒，开场 3 秒）
 *   scope = "tail" → 取**结尾**几秒（2.3 结尾钩子，用 ffmpeg 的 `-sseof`）
 *
 * 两种 scope 必须分开存（见 transcriptStore.js 的 scope 说明）：同一个视频的开头片段
 * 和结尾片段是两回事，混在一起会静默把结尾文案当成开场文案。
 *
 * 复用员工二创工作流里那套已经验证过的能力（`providers.js` 的 `resolveTikHubVideo` +
 * `transcribeVideo`）。方案链由 `TRANSCRIPT_PROVIDERS` / `GOLD_TRANSCRIPT_PROVIDERS` 决定。
 *
 * 实测**完整**转写一条约 89 秒（55 秒的视频：解析视频 4.7s + 转写 84.2s），所以这里
 * 刻意做成**前端驱动分批**：一批只跑几条，每批带时间预算，预算用尽就把剩下的留给下一批。
 * 绝不在一次请求里硬撑到函数被平台杀掉 —— 那样这一批的转写结果会全部丢失。
 *
 * 2026-09-17：本步骤改成覆盖全部 60 条，完整转写 60 条不现实。但只要开场/结尾几秒的话
 * 没必要转整条 —— 现在默认只取 `goldTranscriptClipSeconds` 秒，提取和 ASR 都随之变快。
 * 抽不到人声时回退完整转写，具体见 worker 里的注释。
 */

const asText = value => String(value ?? "").trim();

/**
 * 选出要转写的视频。
 *
 * 刻意复用 `selectGoldThreeSecondVideos` —— 保证「转写的样本」和「分析的样本」
 * 是同一批（点赞降序 → 发布时间降序 → 前 N 条）。没有链接的样本没法转写，直接排除。
 */
export const selectTranscriptTargets = (classificationReport, limit) => (
  selectGoldThreeSecondVideos(classificationReport?.videos, limit)
    .map(video => {
      const rawPlatform = asText(video?.platform).toLowerCase();
      const platform = rawPlatform === "tiktok"
        ? "tiktok"
        : rawPlatform === "wechat_channels" ? "wechat_channels" : "douyin";
      return {
        videoId: asText(video?.id),
        link: asText(video?.link),
        title: asText(video?.title),
        platform,
        // 视频号：媒体直链 + 解密密钥。它没有分享链接，必须走本地解密那条路。
        mediaUrl: asText(video?.mediaUrl),
        decodeKey: asText(video?.decodeKey),
      };
    })
    // 可转写性按平台判定（与 benchmarkTopicRefresh 的过滤同一口径）：
    // 抖音/TikTok 要 link；视频号要 mediaUrl + decodeKey。
    // 原来一律要求 link，于是**视频号选题一条都进不来**。
    .filter(item => item.videoId && (
      item.platform === "wechat_channels"
        ? Boolean(item.mediaUrl && item.decodeKey)
        : Boolean(item.link)
    ))
);

/**
 * 解析一条待转写的条目 → `videoMeta`。
 *
 * 两条路差别很大，**不能混用**：
 *   · 抖音 / TikTok：`resolveTikHubVideo` 拿分享链接去 TikHub 换 CDN 直链；
 *   · 视频号：**没有分享链接**，媒体在 CDN 上且被 Isaac64 加密，必须带上
 *     `mediaUrl` + `decodeKey`，由 `transcribeVideo` 里的 `prepareVideoInput`
 *     在本地解密成流再喂 ffmpeg。
 *
 * 🔴 把视频号错走成 `resolveTikHubVideo` 的话，会拿一个空链接去请求 TikHub，
 *    报出来的是"链接不合法"之类，完全看不出真正的原因是平台没分流。
 */
export const resolveTargetVideo = (target, config, options = {}) => {
  const logger = options.logger;
  if (asText(target?.platform) === "wechat_channels") {
    return resolveWeChatChannelsTopicVideo({
      id: target.videoId,
      title: target.title,
      source: { platform: "wechat_channels", mediaUrl: target.mediaUrl, decodeKey: target.decodeKey },
      rawData: { media: { url: target.mediaUrl, decode_key: target.decodeKey } },
    });
  }
  return resolveTikHubVideo(target.link, config, { logger, platform: target.platform });
};

/**
 * 解析预取窗口。
 *
 * 抽成独立函数是为了能单测，这里有一条**必须守住的不变量**：
 * 预取的结果一律先 settle 成 `{ ok, value }` / `{ ok:false, error }` 普通对象，**永不 reject**。
 *
 * 原因：预算用尽时 worker 会提前收工，此时窗口里可能还有「已经发起、但没人 await」的条目。
 * 如果存的是裸 promise，它一旦 reject 就是 unhandled rejection —— 在 Node 里默认会把
 * 整个进程带走（本地 Express 直接挂，serverless 实例也是）。窗口最多 `windowSize` 条，
 * 所以最坏情况只浪费这几条解析，不会伤到已经落库的转写结果。
 *
 * @param count       条目总数
 * @param windowSize  预取宽度；<=0 表示不预取（解析退回「用到时才做」，即老行为）
 * @param resolve     (index) => Promise<T>
 */
export const createResolvePrefetch = ({ count, windowSize, resolve }) => {
  const size = Math.max(0, Math.min(Math.floor(Number(windowSize) || 0), count));
  const pending = new Map();
  let cursor = 0;

  const settle = index =>
    Promise.resolve()
      .then(() => resolve(index))
      .then(value => ({ ok: true, value }), error => ({ ok: false, error }));

  const fill = () => {
    if (size === 0) return;
    while (cursor < count && pending.size < size) {
      const index = cursor;
      cursor += 1;
      pending.set(index, settle(index));
    }
  };

  fill();

  return {
    /** 取第 index 条：命中预取就等它，否则现场解析（与不预取时行为一致）。 */
    take: index => {
      const entry = pending.get(index);
      if (!entry) return settle(index);
      pending.delete(index);
      // 补位必须等这条**真正结束**之后再补。
      // 若在这里同步 fill()，被取走但还在飞的那条不计入 pending.size，
      // 于是实际并发会变成 windowSize + 在取件数 —— 窗口就不再是硬上限了。
      return entry.finally(() => fill());
    },
    /** 当前窗口内的条数（含已解析待取的）。实际并发不会超过 windowSize。 */
    inFlight: () => pending.size,
    /** 清空窗口，让在途结果自然结束、不再占用引用。 */
    drain: () => pending.clear(),
  };
};

/**
 * 归一化转写 scope —— **三种 scope 必须原样保留，一个都不能吞**。
 *
 * 🔴 这里踩过一个代价很大的坑（2026-09-21 实测定位）：
 * 原来写的是 `scope === TAIL ? TAIL : HEAD`，只认 head / tail —— 于是 2.4 传进来的
 * `scope: "script"` 被**静默收敛成 head**，完整脚本被当成「开场几秒」写进 head 缓存。
 * 后果是双重的：
 *   ① **2.2 黄金三秒会拿整篇脚本当开场文案**（head 缓存里混进了 454~540 字的完整口播）；
 *   ② `getTranscriptProgress({ scope: "script" })` 永远查不到这批结果 → 后端每次都答
 *      「还没转写完」→ 前端以为一条都没成功，**反复重跑 20 轮**（每轮都在重新下载+ASR，
 *      又慢又重复烧钱），最后报「脚本提取没有在预期轮数内完成」。
 * 症状极具迷惑性：转写其实**全都成功了**（batch 里每条都是 status: ok），
 * 只是记账记到了别的 scope 上。
 *
 * 抽成纯函数是为了能单测：这条不变量（script 必须活下来）值得被钉住。
 */
export const resolveTranscriptScope = (scope) => {
  // 与 transcriptStore 的 normalizeScope 保持同一口径（trim + 小写），
  // 否则「写进去的 scope」和「查进度用的 scope」会各归一化一套，又对不上。
  const text = asText(scope).toLowerCase();
  if (text === TRANSCRIPT_SCOPE_TAIL) return TRANSCRIPT_SCOPE_TAIL;
  if (text === TRANSCRIPT_SCOPE_SCRIPT) return TRANSCRIPT_SCOPE_SCRIPT;
  return TRANSCRIPT_SCOPE_HEAD;
};

/**
 * 并发转写一批视频。
 *
 * 单条失败不影响整批：这一条退回发布文案，报告照常出。
 *
 * **resolve 预取（2026-09-17）**：TikHub 解析实测 3.4~4.7s/条，而裁剪后的转写只要 ~1.7s ——
 * 解析已经成了最贵的一段。原来它是和转写串在同一个 worker 里的（`await 解析; await 转写`），
 * 于是解析的网络等待把转写通道白白空着。
 *
 * 现在解析由一个**有界的预取窗口**提前跑，转写 worker 直接取已经解析好的结果，
 * 两段就重叠起来了。刻意做成滑动窗口而不是「整批先解析完」：
 * 整批预解析在函数被平台杀掉时会连一条转写都没落库（见下面 emit 的注释），
 * 而窗口最多只多解析 `resolveConcurrency` 条，浪费有界。
 */
export const transcribeTargets = async ({
  targets = [],
  config,
  logger,
  budgetMs = 0,
  concurrency = 1,
  resolveConcurrency = 0,
  clipSeconds = 0,
  scope = TRANSCRIPT_SCOPE_HEAD,
  onResult,
} = {}) => {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) return [];

  // scope 决定裁剪方向：head 取开头（`-t N`），tail 取结尾（`-sseof -N`），script 不裁剪。
  const normalizedScope = resolveTranscriptScope(scope);
  const seconds = Number(clipSeconds) > 0 ? Number(clipSeconds) : 0;
  // 裁剪方向只有 head / tail 两种；script（完整脚本）与 head 一样不做尾部定位。
  const clipOptions = normalizedScope === TRANSCRIPT_SCOPE_TAIL
    ? { tailSeconds: seconds, clipSeconds: 0 }
    : { clipSeconds: seconds, tailSeconds: 0 };

  const results = [];
  const startedAt = Date.now();
  let cursor = 0;

  // 每完成一条就立刻交出去落库。否则整批跑完才写，函数一旦被平台杀掉这一批全白做。
  const emit = async result => {
    const payload = { ...result, scope: normalizedScope };
    results.push(payload);
    try {
      await onResult?.(payload);
    } catch (error) {
      logger?.warn("gold.transcript.persist_failed", {
        videoId: result.videoId,
        error: error instanceof Error ? error.message : "转写结果落库失败",
      });
    }
  };

  // ── TikHub 解析预取窗口 ────────────────────────────────────────────────
  // 窗口大小 = resolveConcurrency（0 表示不预取，退回「解析和转写串行」的老行为）。
  // 解析预取窗口。实现见 createResolvePrefetch —— 抽成独立函数是为了能单测，
  // 那里有一条关键不变量：**预取 promise 永不 reject**。
  const prefetch = createResolvePrefetch({
    count: list.length,
    windowSize: Number(resolveConcurrency) || 0,
    resolve: index => resolveTargetVideo(list[index], config, { logger }),
  });

  const worker = async () => {
    while (cursor < list.length) {
      // 预算守卫，和 Agent 重试用的是同一个模式：宁可少转几条留给下一批，
      // 也不要拖到 serverless 函数被强杀 —— 那样这一批全白做。
      if (budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
        logger?.warn("gold.transcript.budget_exhausted", {
          attempted: results.length,
          remaining: list.length - results.length,
          elapsedMs: Date.now() - startedAt,
          budgetMs,
        });
        return;
      }
      const index = cursor;
      const target = list[index];
      cursor += 1;
      const videoStartedAt = Date.now();
      try {
        // 用预取窗口里已经解析好的结果；没预取（resolveConcurrency=0）就现场解析。
        const resolved = await prefetch.take(index);
        if (!resolved.ok) throw resolved.error;
        const video = resolved.value;
        // 只取开头/结尾几秒就够判断（完整转写实测约 89 秒/条，而分析要覆盖全部 60 条）。
        // 方向由 scope 决定：head → `-t N`；tail → `-sseof -N`（要求 URL 可 seek）。
        const providers = Array.isArray(config?.goldTranscriptProviders) && config.goldTranscriptProviders.length > 0
          ? config.goldTranscriptProviders
          : undefined;
        let transcript = await transcribeVideo(video, config, { logger, ...clipOptions, providers });
        let text = asText(transcript?.text);
        // 裁剪出来的那几秒可能是纯音乐、静音或环境音（开头没人声、结尾只剩音乐），
        // 这时转写会返回空。不能就这么把这条样本判失败：回退成完整转写再试一次，
        // 宁可慢也不要丢样本。完整转写之后由各业务自己的归一化去取首句/末句。
        if (!text && seconds > 0) {
          logger?.info("gold.transcript.clip_empty_retry_full", {
            videoId: target.videoId,
            scope: normalizedScope,
            clipSeconds: seconds,
          });
          transcript = await transcribeVideo(video, config, { logger, clipSeconds: 0, tailSeconds: 0, providers });
          text = asText(transcript?.text);
        }
        if (!text) throw new Error("转写返回了空文本");
        await emit({
          videoId: target.videoId,
          status: "ok",
          text,
          provider: asText(transcript?.provider),
          durationMs: Date.now() - videoStartedAt,
        });
        logger?.info("gold.transcript.ok", {
          videoId: target.videoId,
          provider: transcript?.provider,
          textLength: text.length,
          durationMs: Date.now() - videoStartedAt,
        });
      } catch (error) {
        await emit({
          videoId: target.videoId,
          status: "failed",
          error: error instanceof Error ? error.message : "转写失败",
          durationMs: Date.now() - videoStartedAt,
        });
        logger?.warn("gold.transcript.failed", {
          videoId: target.videoId,
          code: error?.code,
          error: error instanceof Error ? error.message : "转写失败",
        });
      }
    }
  };

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
};
