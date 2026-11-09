import { json, readBody } from "../_lib/common.js";
import { requireManager } from "../_lib/auth.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { runAccountPlanAgent } from "../_lib/contentAgent/providers.js";
import { buildHeuristicAccountPlan, normalizeAccountPlan } from "../_lib/accountPlan.js";
import { getCustomer } from "../_lib/ipProfileStore.js";
import { getBenchmarkProfileReport } from "../_lib/benchmarkProfileStore.js";

export const config = {
  maxDuration: 300,
};

/**
 * 模块 2「账号定位」(1.3) 第一批的 Agent。**只有 `analyze` 一个阶段** ——
 * 与 1.2 不同：1.3 不抓视频、不转写、不抓评论，它的两份输入
 * （客户 IP 档案 + 1.2 的报告）都是现成的，一次调用就能出报告，
 * 所以没有 transcribe/comments 那种前端驱动的分批阶段。
 *
 * 两份输入的取法刻意不同：
 *   - **客户档案只按 id 从库里读**（`customers` 集合）—— 它是公司名册，必须有权限收口；
 *     前端也不该有机会伪造一份档案。
 *   - **1.2 报告优先用请求体里传进来的正文**：用户在 1.2 阶段刚跑出来的报告可能还没点保存，
 *     此时按 id 读库会读不到或者读到旧版本。没传正文时才回退到按 id 从库里读，
 *     并在报告里如实写明这份报告是「传进来的」还是「按 id 读的」。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  const manager = await requireManager(req, res);
  if (!manager) return;

  const body = readBody(req);
  const phase = String(body?.phase || "analyze").trim().toLowerCase();
  const customerId = String(body?.customerId || body?.id || "").trim();
  const logger = createRequestLogger("api.agent.account-plan", req.headers?.["x-request-id"]);

  if (phase !== "analyze") {
    return json(res, 400, { success: false, error: "账号定位只有 analyze 阶段（不需要转写与评论抓取）" });
  }
  if (!customerId) {
    return json(res, 400, { success: false, error: "缺少客户 id" });
  }

  try {
    const customer = await getCustomer({ id: customerId });
    if (!customer) return json(res, 404, { success: false, error: "客户不存在或已被删除" });

    // 1.2 的报告：先看请求体，再回退到库里按 id 读。
    const warnings: Array<Record<string, unknown>> = [];
    let benchmarkReport = body?.benchmarkProfileReport || body?.benchmarkReport || body?.report || null;
    let benchmarkSource = "本次请求传入的 1.2 对标账号分析报告";
    if (!benchmarkReport || typeof benchmarkReport !== "object") {
      benchmarkReport = null;
      const benchmarkReportId = String(body?.benchmarkProfileReportId || body?.benchmarkReportId || "").trim();
      if (benchmarkReportId) {
        try {
          const stored = await getBenchmarkProfileReport({ ownerId: manager.id, id: benchmarkReportId });
          if (stored?.report) {
            benchmarkReport = stored.report;
            benchmarkSource = "按 id 从 benchmark_profile_reports 读取的 1.2 报告";
          }
        } catch (error: any) {
          // 读库失败不该让整份报告失败：没有 1.2 报告时内容定位与选题库会如实落「待人工补充」。
          warnings.push({
            code: "BENCHMARK_PROFILE_READ_FAILED",
            error: error instanceof Error ? error.message : "1.2 报告读取失败",
          });
        }
      }
    }
    if (!benchmarkReport) {
      return json(res, 400, { success: false, error: "缺少 1.2 对标账号分析报告（请先完成模块 1）" });
    }
    if (!String(benchmarkReport?.reportType || "").trim()) {
      benchmarkSource = `${benchmarkSource}（未标注 reportType）`;
    }

    const agentConfig = getContentAgentConfig();
    let agentOutput;
    let analysisSource = "agent";
    try {
      agentOutput = await runAccountPlanAgent({ customer, benchmarkReport }, agentConfig, { logger });
    } catch (error: any) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "ACCOUNT_PLAN_AGENT_FAILED",
        error: error instanceof Error ? error.message : "账号定位 Agent 暂时不可用",
        fallbackUsed: true,
      });
      // 兜底报告：能透传的照透传（1.2 的选题库与高频标签），不能算的全部落「待人工补充」。
      agentOutput = buildHeuristicAccountPlan();
    }

    const report = normalizeAccountPlan({
      customer,
      benchmarkReport,
      agentOutput,
      analysisSource,
      warnings,
      benchmarkSource,
    });

    logger.info("route.request.done", {
      interface: "/api/agent/account-plan",
      analysisSource,
      batch: report.batch,
      profileFilledFieldCount: report.dataCoverage.profileFilledFieldCount,
      producedSectionCount: report.dataCoverage.producedSectionCount,
      benchmarkCategoryCount: report.dataCoverage.benchmarkCategoryCount,
      topicTotal: report.dataCoverage.topicCount.total,
    });
    return json(res, 200, { success: true, report });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Account plan analysis failed";
    logger.error("route.request.error", {
      interface: "/api/agent/account-plan",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
