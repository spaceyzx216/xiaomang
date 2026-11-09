import { json, readBody } from "../_lib/common.js";
import { requireManager } from "../_lib/auth.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { runGoldThreeSecondsAgent } from "../_lib/contentAgent/providers.js";
import {
  buildHeuristicGoldThreeSeconds,
  buildGoldThreeSecondsInput,
  normalizeGoldThreeSeconds,
} from "../_lib/goldThreeSeconds.js";
import { selectTranscriptTargets, transcribeTargets } from "../_lib/goldThreeSecondTranscripts.js";
import { getTranscriptProgress, getTranscripts, saveTranscript, TRANSCRIPT_SCOPE_HEAD } from "../_lib/transcriptStore.js";

export const config = {
  // 转写一批实测约 90~150 秒，加 DeepSeek 分析。120 秒不够，按项目里其它重端点取 300。
  maxDuration: 300,
};

/**
 * 黄金三秒分析，分两个阶段，由前端驱动：
 *
 *   phase: "transcribe" → 转写下一批还没有真实口播的样本（每批带时间预算）
 *   phase: "analyze"    → 用已有的转写跑 DeepSeek 分析，产出报告
 *
 * 为什么要分批：实测单条转写约 89 秒（55 秒的视频），20 条就是半小时，任何 serverless
 * 请求都装不下。分批之后每个请求都在 maxDuration 内，且转写结果按视频落库，
 * **同一个视频只付一次转写成本**，重跑和追加样本都是秒开。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  const manager = await requireManager(req, res);
  if (!manager) return;

  const body = readBody(req);
  const classificationReport = body?.classificationReport || body?.report;
  const phase = String(body?.phase || "analyze").trim().toLowerCase();
  const logger = createRequestLogger("api.agent.gold-three-seconds", req.headers?.["x-request-id"]);

  if (!classificationReport || typeof classificationReport !== "object") {
    return json(res, 400, { success: false, error: "缺少分类分析报告" });
  }

  try {
    const config = getContentAgentConfig();
    const targets = selectTranscriptTargets(classificationReport, config.goldTranscriptLimit);
    const videoIds = targets.map(target => target.videoId);

    if (phase === "transcribe") {
      if (!config.goldTranscriptEnabled) {
        return json(res, 200, { success: true, progress: { total: targets.length, ok: 0, failed: 0, attempted: 0, finished: true, disabled: true } });
      }
      // 2.2 只认**开头**转写；结尾转写是 2.3 的，scope 不同、绝不能互相读（见 transcriptStore.js）。
      const before = await getTranscriptProgress({ ownerId: manager.id, videoIds, scope: TRANSCRIPT_SCOPE_HEAD });
      if (before.pendingIds.length === 0) {
        return json(res, 200, { success: true, progress: { ...before, finished: true } });
      }

      const batchIds = new Set(before.pendingIds.slice(0, config.goldTranscriptBatchSize));
      const batch = targets.filter(target => batchIds.has(target.videoId));
      const results = await transcribeTargets({
        targets: batch,
        config,
        logger,
        budgetMs: config.goldTranscriptBudgetMs,
        concurrency: config.goldTranscriptConcurrency,
        // TikHub 解析比裁剪后的转写还慢，用更宽的通道提前跑（见 goldThreeSecondTranscripts.js）。
        resolveConcurrency: config.goldTranscriptResolveConcurrency,
        clipSeconds: config.goldTranscriptClipSeconds,
        scope: TRANSCRIPT_SCOPE_HEAD,
        // 每完成一条立刻落库：整批跑完才写的话，函数被平台杀掉这一批就全白做。
        onResult: async result => {
          await saveTranscript({ ownerId: manager.id, ...result });
        },
      });

      const after = await getTranscriptProgress({ ownerId: manager.id, videoIds, scope: TRANSCRIPT_SCOPE_HEAD });
      logger.info("route.transcribe.done", {
        interface: "/api/agent/gold-three-seconds",
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
          // 这批没跑完（预算用尽）时告诉前端还剩多少，前端据此继续驱动下一批。
          remaining: after.pendingIds.length,
          batch: results.map(result => ({ videoId: result.videoId, status: result.status, provider: result.provider || "", durationMs: result.durationMs })),
        },
      });
    }

    // phase === "analyze"
    const input = buildGoldThreeSecondsInput(classificationReport, { limit: config.goldTranscriptLimit });
    if (input.videos.length === 0) {
      return json(res, 400, { success: false, error: "分类报告中没有可分析的视频样本" });
    }
    const transcripts = config.goldTranscriptEnabled
      ? await getTranscripts({ ownerId: manager.id, videoIds, scope: TRANSCRIPT_SCOPE_HEAD })
      : new Map();

    let agentOutput;
    let analysisSource = "agent";
    const warnings: Array<Record<string, unknown>> = [];
    try {
      agentOutput = await runGoldThreeSecondsAgent({ classificationReport, transcripts }, config, { logger });
    } catch (error: any) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "GOLD_THREE_SECONDS_AGENT_FAILED",
        error: error instanceof Error ? error.message : "黄金三秒 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicGoldThreeSeconds(classificationReport);
    }

    const report = normalizeGoldThreeSeconds({ classificationReport, agentOutput, analysisSource, warnings, transcripts });
    logger.info("route.request.done", {
      interface: "/api/agent/gold-three-seconds",
      analysisSource,
      videoCount: report.analyzedCount,
      topTypeCount: report.topTypes.length,
      transcriptCount: transcripts.size,
    });
    return json(res, 200, { success: true, report });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Gold three seconds analysis failed";
    logger.error("route.request.error", {
      interface: "/api/agent/gold-three-seconds",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
