import { json, readBody } from "../_lib/common.js";
import { requireManager } from "../_lib/auth.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { runBenchmarkProfileAgent } from "../_lib/contentAgent/providers.js";
import {
  PROFILE_SAMPLE_LIMIT,
  buildHeuristicBenchmarkProfile,
  normalizeBenchmarkProfile,
} from "../_lib/benchmarkProfile.js";
import { selectTranscriptTargets, transcribeTargets } from "../_lib/goldThreeSecondTranscripts.js";
import { getTranscriptProgress, getTranscripts, saveTranscript, TRANSCRIPT_SCOPE_HEAD, TRANSCRIPT_SCOPE_TAIL } from "../_lib/transcriptStore.js";
import { getComments } from "../_lib/commentStore.js";
import { getFansPortrait } from "../_lib/fansPortraitStore.js";

export const config = {
  maxDuration: 300,
};

/**
 * 模块 1「对标账号分析」(1.2) 的 Agent，分两个阶段，由前端驱动。
 * 与 `/api/agent/ending-hooks` 同构，但有两处**本质差别**：
 *
 *   ① 样本只取**点赞最高的前 20 条**（PROFILE_SAMPLE_LIMIT），不是全部 60 条 ——
 *      1.2 要的是「最常用 3 种类型 + 原因」，看头部样本即可。
 *   ② 需要**两个方向**的转写：开头（scope=head，判断三秒）与结尾（scope=tail，判断结尾钩子）。
 *      所以 transcribe 阶段要带 `scope` 参数，前端先跑 head 再跑 tail。
 *
 * 评论不走这里：评论抓取是数据获取（`/api/tikhub/comments`），由前端直接驱动并落缓存，
 * analyze 阶段只从缓存里读 —— 与 `/api/tikhub/batch` 和分类 Agent 的分工一致。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  const manager = await requireManager(req, res);
  if (!manager) return;

  const body = readBody(req);
  const classificationReport = body?.classificationReport || body?.report;
  const phase = String(body?.phase || "analyze").trim().toLowerCase();
  // scope 决定这次转写取开头还是结尾片段。默认 head（与 2.2 一致）。
  const scope = String(body?.scope || "").trim().toLowerCase() === TRANSCRIPT_SCOPE_TAIL
    ? TRANSCRIPT_SCOPE_TAIL
    : TRANSCRIPT_SCOPE_HEAD;
  // 分类结果是「复用已保存的报告」还是「本次现跑的」——报告里要如实写明，不能一律写「复用」。
  const classificationSource = String(body?.classificationSource || "").trim().toLowerCase() === "fresh"
    ? "fresh"
    : "reused";
  const logger = createRequestLogger("api.agent.benchmark-profile", req.headers?.["x-request-id"]);

  if (!classificationReport || typeof classificationReport !== "object") {
    return json(res, 400, { success: false, error: "缺少分类分析报告" });
  }

  try {
    const agentConfig = getContentAgentConfig();
    // 只针对前 20 条做转写 —— 与三秒/结尾分析的样本完全同一批。
    const targets = selectTranscriptTargets(classificationReport, PROFILE_SAMPLE_LIMIT);
    const videoIds = targets.map(target => target.videoId);

    if (phase === "transcribe") {
      if (!agentConfig.goldTranscriptEnabled) {
        return json(res, 200, { success: true, progress: { total: targets.length, ok: 0, failed: 0, attempted: 0, finished: true, disabled: true } });
      }
      const before = await getTranscriptProgress({ ownerId: manager.id, videoIds, scope });
      if (before.pendingIds.length === 0) {
        return json(res, 200, { success: true, progress: { ...before, finished: true } });
      }

      const batchIds = new Set(before.pendingIds.slice(0, agentConfig.goldTranscriptBatchSize));
      const batch = targets.filter(target => batchIds.has(target.videoId));
      const results = await transcribeTargets({
        targets: batch,
        config: agentConfig,
        logger,
        budgetMs: agentConfig.goldTranscriptBudgetMs,
        concurrency: agentConfig.goldTranscriptConcurrency,
        resolveConcurrency: agentConfig.goldTranscriptResolveConcurrency,
        clipSeconds: agentConfig.goldTranscriptClipSeconds,
        scope,
        // 每完成一条立刻落库：整批跑完才写的话，函数被平台杀掉这一批就全白做（§6.3⑯）。
        onResult: async result => {
          await saveTranscript({ ownerId: manager.id, ...result });
        },
      });

      const after = await getTranscriptProgress({ ownerId: manager.id, videoIds, scope });
      logger.info("route.transcribe.done", {
        interface: "/api/agent/benchmark-profile",
        scope,
        total: after.total,
        attempted: after.attempted,
        ok: after.ok,
        failed: after.failed,
      });
      return json(res, 200, {
        success: true,
        progress: {
          total: after.total,
          ok: after.ok,
          failed: after.failed,
          attempted: after.attempted,
          finished: after.pendingIds.length === 0,
          remaining: after.pendingIds.length,
          scope,
          batch: results.map(result => ({ videoId: result.videoId, status: result.status, provider: result.provider || "", durationMs: result.durationMs })),
        },
      });
    }

    // phase === "analyze"
    // 开头与结尾两份转写都要：三秒看开头，结尾钩子看结尾（§6.6㉚ 的 scope 必须显式传）。
    const [headTranscripts, tailTranscripts, commentsByVideo] = await Promise.all([
      agentConfig.goldTranscriptEnabled
        ? getTranscripts({ ownerId: manager.id, videoIds, scope: TRANSCRIPT_SCOPE_HEAD })
        : new Map(),
      agentConfig.goldTranscriptEnabled
        ? getTranscripts({ ownerId: manager.id, videoIds, scope: TRANSCRIPT_SCOPE_TAIL })
        : new Map(),
      getComments({ ownerId: manager.id, videoIds }),
    ]);

    // 真实粉丝画像**只从缓存读**，不在这里发新的付费请求：拉取是独立的数据获取步骤
    // （`/api/tikhub/fans-portrait`，由前端驱动）。这里没有就照旧走推断。
    // sec_user_id 来自分类报告 —— 旧报告没有这个字段，那时 fansPortrait 为 null。
    const warnings: Array<Record<string, unknown>> = [];
    let fansPortrait = null;
    const secUserId = String(classificationReport?.account?.secUserId || "").trim();
    if (secUserId) {
      try {
        fansPortrait = await getFansPortrait({ ownerId: manager.id, secUserId });
      } catch (error: any) {
        // 画像读不到不该让整份报告失败 —— 用户画像退回推断即可。
        warnings.push({ code: "FANS_PORTRAIT_READ_FAILED", error: error instanceof Error ? error.message : "粉丝画像读取失败" });
      }
    }

    let agentOutput;
    let analysisSource = "agent";
    try {
      agentOutput = await runBenchmarkProfileAgent(
        { classificationReport, headTranscripts, tailTranscripts, commentsByVideo, fansPortrait },
        agentConfig,
        { logger },
      );
    } catch (error: any) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "BENCHMARK_PROFILE_AGENT_FAILED",
        error: error instanceof Error ? error.message : "对标账号分析 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicBenchmarkProfile(classificationReport);
    }

    const report = normalizeBenchmarkProfile({
      classificationReport,
      agentOutput,
      analysisSource,
      warnings,
      headTranscripts,
      tailTranscripts,
      commentsByVideo,
      fansPortrait,
      classificationSource,
    });
    logger.info("route.request.done", {
      interface: "/api/agent/benchmark-profile",
      analysisSource,
      profileSampleCount: report.dataCoverage.profileSampleCount,
      headTranscriptCount: report.dataCoverage.headTranscriptCount,
      tailTranscriptCount: report.dataCoverage.tailTranscriptCount,
      videosWithComments: report.dataCoverage.videosWithComments,
      frequentTagCount: report.frequentTags.length,
      portraitDimensionCount: report.userProfile?.fansPortrait?.dimensions?.length || 0,
    });
    return json(res, 200, { success: true, report });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Benchmark profile analysis failed";
    logger.error("route.request.error", {
      interface: "/api/agent/benchmark-profile",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
