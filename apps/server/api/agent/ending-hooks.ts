import { json, readBody } from "../_lib/common.js";
import { requireManager } from "../_lib/auth.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { runEndingHooksAgent } from "../_lib/contentAgent/providers.js";
import {
  buildHeuristicEndingHooks,
  buildEndingHooksInput,
  normalizeEndingHooks,
} from "../_lib/endingHooks.js";
import { selectTranscriptTargets, transcribeTargets } from "../_lib/goldThreeSecondTranscripts.js";
import { getTranscriptProgress, getTranscripts, saveTranscript, TRANSCRIPT_SCOPE_TAIL } from "../_lib/transcriptStore.js";

export const config = {
  maxDuration: 300,
};

/**
 * 2.3 结尾钩子库分析，分两个阶段，由前端驱动。与 `/api/agent/gold-three-seconds` 同构。
 *
 *   phase: "transcribe" → 转写下一批还没有真实口播的样本的**结尾片段**（每批带时间预算）
 *   phase: "analyze"    → 用已有的结尾转写跑 DeepSeek 分析，产出报告
 *
 * ⚠️ **scope 必须是 tail**：结尾钩子看的是视频收尾，而 2.2 存的是开头片段。
 * 两者在 `gold_three_second_transcripts` 里靠 `scope` 字段分开存 —— 写错 scope 会让
 * 2.3 拿开场文案去判断「结尾类型」，而且不会有任何报错（见 transcriptStore.js）。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  const manager = await requireManager(req, res);
  if (!manager) return;

  const body = readBody(req);
  const classificationReport = body?.classificationReport || body?.report;
  const phase = String(body?.phase || "analyze").trim().toLowerCase();
  const logger = createRequestLogger("api.agent.ending-hooks", req.headers?.["x-request-id"]);

  if (!classificationReport || typeof classificationReport !== "object") {
    return json(res, 400, { success: false, error: "缺少分类分析报告" });
  }

  try {
    const agentConfig = getContentAgentConfig();
    const targets = selectTranscriptTargets(classificationReport, agentConfig.goldTranscriptLimit);
    const videoIds = targets.map(target => target.videoId);

    if (phase === "transcribe") {
      if (!agentConfig.goldTranscriptEnabled) {
        return json(res, 200, { success: true, progress: { total: targets.length, ok: 0, failed: 0, attempted: 0, finished: true, disabled: true } });
      }
      const before = await getTranscriptProgress({ ownerId: manager.id, videoIds, scope: TRANSCRIPT_SCOPE_TAIL });
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
        scope: TRANSCRIPT_SCOPE_TAIL,
        // 每完成一条立刻落库：整批跑完才写的话，函数被平台杀掉这一批就全白做。
        onResult: async result => {
          await saveTranscript({ ownerId: manager.id, ...result });
        },
      });

      const after = await getTranscriptProgress({ ownerId: manager.id, videoIds, scope: TRANSCRIPT_SCOPE_TAIL });
      logger.info("route.transcribe.done", {
        interface: "/api/agent/ending-hooks",
        scope: TRANSCRIPT_SCOPE_TAIL,
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
          batch: results.map(result => ({ videoId: result.videoId, status: result.status, provider: result.provider || "", durationMs: result.durationMs })),
        },
      });
    }

    // phase === "analyze"
    const input = buildEndingHooksInput(classificationReport, { limit: agentConfig.goldTranscriptLimit });
    if (input.videos.length === 0) {
      return json(res, 400, { success: false, error: "分类报告中没有可分析的视频样本" });
    }
    const transcripts = agentConfig.goldTranscriptEnabled
      ? await getTranscripts({ ownerId: manager.id, videoIds, scope: TRANSCRIPT_SCOPE_TAIL })
      : new Map();

    let agentOutput;
    let analysisSource = "agent";
    const warnings: Array<Record<string, unknown>> = [];
    try {
      agentOutput = await runEndingHooksAgent({ classificationReport, transcripts }, agentConfig, { logger });
    } catch (error: any) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "ENDING_HOOKS_AGENT_FAILED",
        error: error instanceof Error ? error.message : "结尾钩子 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicEndingHooks(classificationReport);
    }

    const report = normalizeEndingHooks({ classificationReport, agentOutput, analysisSource, warnings, transcripts });
    logger.info("route.request.done", {
      interface: "/api/agent/ending-hooks",
      analysisSource,
      videoCount: report.analyzedCount,
      topTypeCount: report.topTypes.length,
      transcriptCount: transcripts.size,
    });
    return json(res, 200, { success: true, report });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Ending hooks analysis failed";
    logger.error("route.request.error", {
      interface: "/api/agent/ending-hooks",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
