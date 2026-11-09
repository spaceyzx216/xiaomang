import { json, readBody } from "../_lib/common.js";
import { requireManager } from "../_lib/auth.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { fetchCommentsBatch, normalizeCommentTargets } from "../_lib/videoComments.js";
import { getCommentProgress, saveComments } from "../_lib/commentStore.js";

export const config = {
  maxDuration: 300,
};

/**
 * 对标视频「高赞评论」抓取。与 `/api/agent/ending-hooks` 的 transcribe 阶段同构：
 * 前端驱动分批，每批只处理**还没抓过**的视频，带时间预算，每完成一条立刻落库。
 * 本地 Express 版见 server/index.js 的 `/api/tikhub/comments`（刻意保持同构）。
 *
 * ⚠️ 这是**付费**上游调用（TikHub 按次计费），三条防线：
 *   ① 只允许项目经理调用（requireManager）；
 *   ② 抓过的视频永久缓存，失败也缓存失败标记（commentStore）—— 一个视频只付一次钱；
 *   ③ 失败也算「已尝试」（attempted = ok + failed），否则前端会对着同一个坏视频
 *      无限重试、无限扣费（这个坑在转写链路上已经踩过一次，见 transcriptStore.js）。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  const manager = await requireManager(req, res);
  if (!manager) return;

  const logger = createRequestLogger("api.tikhub.comments", req.headers?.["x-request-id"]);
  const body = readBody(req);
  const targets = normalizeCommentTargets(body);
  if (targets.length === 0) {
    logger.warn("route.validation.error", { error: "videos must be a non-empty array" });
    return json(res, 400, { success: false, error: "videos 必须是非空数组" });
  }

  try {
    const agentConfig = getContentAgentConfig();
    // 缺 token 是配置故障，不是「这个视频抓不到」：这里直接失败，
    // 绝不能让它逐条落库成 failed —— 那会把整份样本的评论永久钉死成失败缓存。
    if (!agentConfig.tikhubApiToken) {
      logger.error("route.config.error", { error: "Missing TIKHUB_API_TOKEN" });
      return json(res, 500, { success: false, error: "Missing TIKHUB_API_TOKEN" });
    }

    const videoIds = targets.map(target => target.videoId);
    const before = await getCommentProgress({ ownerId: manager.id, videoIds });
    logger.info("route.request.start", {
      interface: "/api/tikhub/comments",
      videoCount: videoIds.length,
      pendingCount: before.pendingIds.length,
    });

    if (before.pendingIds.length === 0) {
      return json(res, 200, {
        success: true,
        progress: {
          total: before.total,
          ok: before.ok,
          failed: before.failed,
          attempted: before.attempted,
          finished: true,
          remaining: 0,
          batch: [],
        },
      });
    }

    // 只取下一批还没缓存的。batch 用 targets 过滤而不是直接拿 pendingIds：
    // 目标里带着 platform，且顺序以调用方给的为准（视频号顺序稳定，进度才好复核）。
    const batchIds = new Set(before.pendingIds.slice(0, agentConfig.benchmarkCommentBatchSize));
    const batch = targets.filter(target => batchIds.has(target.videoId));
    const results = await fetchCommentsBatch({
      targets: batch,
      config: agentConfig,
      logger,
      budgetMs: agentConfig.benchmarkCommentBudgetMs,
      concurrency: agentConfig.benchmarkCommentConcurrency,
      // 每完成一条立刻落库：整批跑完才写的话，函数被平台杀掉这一批的钱就白花了。
      onResult: async result => {
        await saveComments({ ownerId: manager.id, ...result });
      },
    });

    const after = await getCommentProgress({ ownerId: manager.id, videoIds });
    logger.info("route.request.done", {
      interface: "/api/tikhub/comments",
      total: after.total,
      ok: after.ok,
      failed: after.failed,
      attempted: after.attempted,
      remaining: after.pendingIds.length,
    });
    return json(res, 200, {
      success: true,
      progress: {
        total: after.total,
        ok: after.ok,
        failed: after.failed,
        attempted: after.attempted,
        // 全部尝试过（含失败）才算 finished —— 与前端的分批循环约定一致。
        finished: after.pendingIds.length === 0,
        remaining: after.pendingIds.length,
        batch: results.map(result => ({ videoId: result.videoId, status: result.status, provider: result.provider || "", durationMs: result.durationMs })),
      },
    });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "评论抓取失败";
    logger.error("route.request.error", {
      interface: "/api/tikhub/comments",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
