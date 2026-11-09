import { json, readBody } from "../_lib/common.js";
import { requireManager } from "../_lib/auth.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { fetchFansPortrait } from "../_lib/douyinFansPortrait.js";
import { getFansPortrait, saveFansPortrait } from "../_lib/fansPortraitStore.js";

export const config = {
  maxDuration: 60,
};

/**
 * 抖音「热榜」粉丝画像 —— 模块 1 用户画像的真实数据源。
 * 本地 Express 版见 server/index.js 的 `/api/tikhub/fans-portrait`（刻意保持同构）。
 *
 * ⚠️ 这是**付费**调用，而且**一次调用只能拿一个维度**（实测：传多个 option 会 HTTP 422），
 * 所以一次请求会并发打 8 个上游 GET。三条防线：
 *   ① 只允许项目经理调用（requireManager）；
 *   ② 账号级缓存（`fansPortraitStore`）—— 同一个账号 7 天内只付一次钱；
 *   ③ 单维度失败不影响其余维度（`fetchFansPortrait` 内部消化），画像少一维仍可用。
 *
 * 数据来源选择见 `douyinFansPortrait.js` 顶部：星图接口数据更细但**只对入驻星图的
 * 达人有效**（实测普通对标账号返回 exist=false），热榜这条只要求 sec_uid，实测可用。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  const manager = await requireManager(req, res);
  if (!manager) return;

  const logger = createRequestLogger("api.tikhub.fans-portrait", req.headers?.["x-request-id"]);
  const secUserId = String(readBody(req)?.secUserId || "").trim();

  // 旧分类报告没有 sec_user_id（2026-09-18 才打通）。如实说明原因，
  // 让前端能提示「请重新跑一次分类分析」，而不是静默少一块内容。
  if (!secUserId) {
    return json(res, 200, {
      success: true,
      portrait: { ok: false, reason: "missing_sec_user_id", secUserId: "", dimensions: [], failed: [], fetchedAt: "" },
    });
  }

  try {
    const cached = await getFansPortrait({ ownerId: manager.id, secUserId });
    if (cached) {
      logger.info("route.request.cached", { interface: "/api/tikhub/fans-portrait", dimensionCount: cached.dimensions.length });
      return json(res, 200, { success: true, portrait: cached });
    }

    const agentConfig = getContentAgentConfig();
    const portrait = await fetchFansPortrait({ secUserId, config: agentConfig, logger });
    // 失败不写缓存（见 fansPortraitStore 的说明）：重抓只要 8 次廉价 GET，
    // 把一次上游抖动缓存 7 天会让用户七天都看不到画像。
    const saved = portrait.ok ? await saveFansPortrait({ ownerId: manager.id, portrait }) : null;

    logger.info("route.request.done", {
      interface: "/api/tikhub/fans-portrait",
      ok: portrait.ok,
      reason: portrait.reason || "",
      dimensionCount: portrait.dimensions.length,
      failedCount: portrait.failed.length,
    });
    return json(res, 200, { success: true, portrait: saved || { ...portrait, fromCache: false } });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "粉丝画像获取失败";
    logger.error("route.request.error", {
      interface: "/api/tikhub/fans-portrait",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
