import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { runVideoAnalysis } from "../_lib/reviewAgentRunner.js";

export const config = {
  maxDuration: 300,
};

/**
 * 模块 4「复盘分析」4.1 —— 单条视频数据分析。
 *
 * 输入是**客户自己发布的视频**（不是选题库里的对标视频）：
 * 数据由人工从平台后台导出成 Excel 后上传，文案随数据一起给。
 * 所以这条链路**不抓取、不转写**，一次调用就能出报告。
 *
 * 🔴 鉴权用 `requireAuth` 而不是 `requireManager`：
 *    用户 2026-09-30 拍板「经理端新模块 4 + 员工端只读/单条分析」，
 *    员工要能做单条视频分析。客户归属由 `customerId` 决定（与选题库同一把尺）。
 *
 * ⚠️ 这里**不落库**：用户先看结果、必要时改，再走 `/api/video-analysis-reports` 保存。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  const user = await requireAuth(req, res);
  if (!user) return;

  const body = readBody(req);
  const customerId = String(body?.customerId || "").trim();
  const logger = createRequestLogger("api.agent.video-analysis", req.headers?.["x-request-id"]);

  if (!customerId) {
    return json(res, 400, { success: false, error: "请先选择客户（复盘要用该客户的选题库做结构标签）" });
  }

  try {
    const { report } = await runVideoAnalysis({ customerId, body, logger, config: getContentAgentConfig() });

    logger.info("route.request.done", {
      interface: "/api/agent/video-analysis",
      platform: report.platform,
      analysisSource: report.analysisSource,
      optimizeCount: report.structures.filter((item: any) => item.verdict === "optimize").length,
      warningCount: report.warnings.length,
    });
    return json(res, 200, { success: true, report });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "视频复盘分析失败";
    logger.error("route.request.error", {
      interface: "/api/agent/video-analysis",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
