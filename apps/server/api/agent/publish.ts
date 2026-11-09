import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { PUBLISH_PHASES, runPublishPhase } from "../_lib/publishAgentRunner.js";

/**
 * 发布仓的 Agent（2026-09-21 第七轮，见 HANDOFF §0.3；封面基底 2026-09-23 增补）。
 *
 * `POST /api/agent/publish`，由 `phase` 分流：
 *   - `cover-plan`          3.1 封面方案（提示词 + 对标封面拆解 + 样式模板 + 背景候选）—— 不花钱
 *   - `cover-base-analysis` 3.1 封面基底第一步：拆解**用户上传的对标封面图**（视觉模型，不出图）
 *   - `cover-image`         3.1 **出图**（唯一花钱的步骤，用户确认提示词后才触发）
 *   - `publish-copy`        3.2 金句 + 互动（标题 / 3s 由前端复用，不走模型）
 *   - `account-tags`        3.3 账号标签库（三角度各 2 候选）
 *   - `topic-tags`          3.3 选题标签（小类x2 + 核心内容x2 + 目标用户x1）
 *
 * 鉴权：`requireAuth`（登录即可）。发布仓在**员工端**，与
 * `/api/agent/benchmark-topic-refresh` 同一条口径（§0.1「脚本/标签分析对所有登录用户开放」）。
 * 未登录仍然 401。
 */

export const config = { maxDuration: 300 };

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = readBody(req);
  const phase = String(body?.phase || "").toLowerCase();
  const logger = createRequestLogger("api.agent.publish", req.headers?.["x-request-id"]);

  if (!PUBLISH_PHASES.includes(phase)) {
    return json(res, 400, {
      success: false,
      error: `不支持的 phase：${phase || "(空)"}（可用：${PUBLISH_PHASES.join(" / ")}）`,
      code: "PUBLISH_PHASE_INVALID",
    });
  }

  try {
    const payload = await runPublishPhase({ phase, body, user, logger });
    return json(res, 200, { success: true, ...payload });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Publish agent failed";
    logger.error("route.request.error", { phase, error: message, code: error?.code });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
