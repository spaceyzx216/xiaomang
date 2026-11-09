import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { runBenchmarkTopicRefreshAgent } from "../_lib/contentAgent/providers.js";
import {
  buildBenchmarkTopicRefreshInput,
  buildHeuristicBenchmarkTopicRefresh,
  describeTopicRefreshVideoDrop,
  normalizeBenchmarkTopicRefresh,
  normalizeTopicLibrary,
  normalizeTopicRefreshVideos,
} from "../_lib/benchmarkTopicRefresh.js";
import { transcribeTargets } from "../_lib/goldThreeSecondTranscripts.js";
import {
  appendTopicRefreshItems,
  dictionaryFingerprint,
} from "../_lib/topicRefreshSessionStore.js";
import {
  getTranscriptProgress,
  getTranscripts,
  saveTranscript,
  TRANSCRIPT_SCOPE_SCRIPT,
} from "../_lib/transcriptStore.js";

export const config = { maxDuration: 300 };

const asText = (value: unknown) => String(value ?? "").trim();

// ⚠️ 这里**不能**只挑 id/link/title/platform：视频号没有 link，靠 mediaUrl + decodeKey
//    在本地解密后转写。漏了这两个字段，视频号到 transcribeTargets 里就会报
//    「缺少媒体地址」，而真正的原因是字段在这一层被丢掉了。
//    （Express 版 src/index.js 的对应位置必须同步改 —— §6.2⑤ 两套后端同构。）
const targetsFromVideos = (videos: unknown, minLikes: unknown) => normalizeTopicRefreshVideos(videos, { minLikes })
  .map(video => ({
    videoId: video.id,
    link: video.link,
    title: video.title,
    platform: video.platform,
    mediaUrl: (video as any).mediaUrl,
    decodeKey: (video as any).decodeKey,
  }));

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  // 2026-09-21 用户要求：脚本提取与标签判定**不再只给项目经理**，员工端「今日选题」
  // 也要用。所以只要登录即可（员工 / 项目经理都可以）。
  // ⚠️ 转写缓存按 `ownerId` 隔离，这里必须传**当前用户**的 id：
  //    员工用员工自己的缓存，不会读到/污染项目经理的转写。
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = readBody(req);
  const phase = asText(body?.phase || "analyze").toLowerCase();
  const recentDays = Number(body?.recentDays || 7);
  const minLikes = Number(body?.minLikes ?? 100);
  const videos = normalizeTopicRefreshVideos(body?.videos, { minLikes });
  const categories = normalizeTopicLibrary(body?.categories || body?.topicLibrary);
  const logger = createRequestLogger("api.agent.benchmark-topic-refresh", req.headers?.["x-request-id"]);

  if (videos.length === 0) {
    return json(res, 400, {
      success: false,
      error: `没有满足筛选条件的可分析视频。${describeTopicRefreshVideoDrop(body?.videos, minLikes)}`,
    });
  }
  // ⚠️ 分类词典**只有打标签那一步用得到**，转写不需要。
  // 原来这条校验卡在两个 phase 前面：转写请求也会因为「词典为空」被 400 掉 ——
  // 白白挡掉「先提脚本、再读库」的顺序（用户 2026-09-21 拍板的新顺序），
  // 而且报的错跟转写毫无关系，极难定位。所以下沉到 analyze。
  if (phase !== "transcribe" && categories.length === 0) {
    return json(res, 400, { success: false, error: "当前账号没有可用的选题库分类" });
  }

  try {
    const config = getContentAgentConfig();
    const targets = targetsFromVideos(videos, minLikes);
    const videoIds = targets.map(target => target.videoId);

    if (phase === "transcribe") {
      if (!config.goldTranscriptEnabled) {
        return json(res, 200, { success: true, progress: { total: videoIds.length, ok: 0, failed: 0, attempted: 0, finished: true, disabled: true } });
      }
      const before = await getTranscriptProgress({ ownerId: user.id, videoIds, scope: TRANSCRIPT_SCOPE_SCRIPT });
      if (before.pendingIds.length === 0) return json(res, 200, { success: true, progress: { ...before, finished: true } });

      const batchIds = new Set(before.pendingIds.slice(0, config.goldTranscriptBatchSize));
      const batch = targets.filter(target => batchIds.has(target.videoId));
      const results = await transcribeTargets({
        targets: batch,
        config,
        logger,
        budgetMs: config.goldTranscriptBudgetMs,
        concurrency: config.goldTranscriptConcurrency,
        resolveConcurrency: config.goldTranscriptResolveConcurrency,
        // 完整脚本：不传 clipSeconds，避免只拿到开头几秒。
        clipSeconds: 0,
        scope: TRANSCRIPT_SCOPE_SCRIPT,
        onResult: async result => saveTranscript({ ownerId: user.id, ...result }),
      });
      const after = await getTranscriptProgress({ ownerId: user.id, videoIds, scope: TRANSCRIPT_SCOPE_SCRIPT });
      return json(res, 200, {
        success: true,
        progress: {
          total: after.total,
          ok: after.ok,
          failed: after.failed,
          attempted: after.attempted,
          finished: after.pendingIds.length === 0,
          remaining: after.pendingIds.length,
          scope: TRANSCRIPT_SCOPE_SCRIPT,
          // 把逐条的失败原因也回出去：只给 ok/failed 计数时，出问题只能靠翻服务端日志。
          batch: results.map(result => ({
            videoId: result.videoId,
            status: result.status,
            provider: result.provider || "",
            durationMs: result.durationMs,
            ...(result.status === "failed" ? { error: asText((result as any).error).slice(0, 200) } : {}),
          })),
        },
      });
    }

    const transcripts = config.goldTranscriptEnabled
      ? await getTranscripts({ ownerId: user.id, videoIds, scope: TRANSCRIPT_SCOPE_SCRIPT })
      : new Map();
    let agentOutput;
    let analysisSource = "agent";
    const warnings: Array<Record<string, unknown>> = [];
    try {
      agentOutput = await runBenchmarkTopicRefreshAgent({
        videos,
        categories,
        transcripts,
        recentDays,
        minLikes,
      }, config, { logger });
    } catch (error: any) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "BENCHMARK_TOPIC_REFRESH_AGENT_FAILED",
        error: error instanceof Error ? error.message : "近更新选题标签 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicBenchmarkTopicRefresh({ videos, categories, transcripts, recentDays, minLikes });
    }

    const report = normalizeBenchmarkTopicRefresh({
      videos,
      categories,
      transcripts,
      agentOutput,
      recentDays,
      minLikes,
    });
    report.analysisSource = analysisSource;
    report.warnings = warnings;
    report.input = buildBenchmarkTopicRefreshInput({ videos, categories, transcripts, recentDays, minLikes });
    // 把这一批的判完条目落进「处理进度」会话（B2）：用户刷新/离开再回来能直接续上，
    // 而不是把已经花掉的转写与模型调用丢掉。没传 customerId（或还没建会话）时静默跳过 ——
    // 没有候选列表的标签是孤儿数据，存了也读不出意义。
    const customerId = asText(body?.customerId);
    if (customerId) {
      try {
        await appendTopicRefreshItems({
          ownerId: user.id,
          customerId,
          items: report.items,
          dictionaryHash: dictionaryFingerprint(categories),
        });
      } catch (error: any) {
        // 落进度失败不该让用户拿不到结果：报告照常返回，只记一条日志。
        logger.warn("topic.refresh.session_save_failed", {
          customerId,
          error: error instanceof Error ? error.message : "进度落库失败",
        });
      }
    }
    return json(res, 200, { success: true, report });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Benchmark topic refresh failed";
    logger.error("route.request.error", { error: message, code: error?.code });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
