import { json, readBody } from "../_lib/common.js";
import { requireManager } from "../_lib/auth.js";
import {
  buildHeuristicBenchmarkAnalysis,
  normalizeBenchmarkAnalysis,
  normalizeBenchmarkVideos,
} from "../_lib/benchmarkAnalysis.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { runBenchmarkAnalysisAgent } from "../_lib/contentAgent/providers.js";

export const config = {
  maxDuration: 120,
};

const normalizeStyle = value => String(value || "").trim().toLowerCase() === "drama" ? "drama" : "spoken";
const normalizePlatform = value => String(value || "").trim().toLowerCase() === "tiktok" ? "tiktok" : "douyin";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  if (!await requireManager(req, res)) return;

  const body = readBody(req);
  const contentStyle = normalizeStyle(body?.contentStyle || body?.content_style);
  const platform = normalizePlatform(body?.platform);
  const videos = normalizeBenchmarkVideos(body?.videos, { platform });
  const logger = createRequestLogger("api.agent.benchmark-analysis", req.headers?.["x-request-id"]);

  if (videos.length === 0) {
    return json(res, 400, { success: false, error: "没有可分析的视频样本" });
  }

  try {
    const config = getContentAgentConfig();
    let agentOutput;
    let analysisSource = "agent";
    const warnings: Array<Record<string, unknown>> = [];
    try {
      agentOutput = await runBenchmarkAnalysisAgent({
        contentStyle,
        accountName: body?.accountName,
        videos,
      }, config, { logger });
    } catch (error: any) {
      // Agent 配置缺失或暂时不可用时仍给出可人工复核的初步报告，避免抓取结果丢失。
      // 报告明确标记 heuristic 来源，不把规则分类伪装成模型结论。
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "BENCHMARK_AGENT_FAILED",
        error: error instanceof Error ? error.message : "分析 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicBenchmarkAnalysis({ contentStyle, videos });
    }

    const report = normalizeBenchmarkAnalysis({
      contentStyle,
      platform,
      accountUrl: body?.accountUrl,
      accountName: body?.accountName,
      videos,
      agentOutput,
      analysisSource,
      warnings,
      fetchMode: body?.fetchMode,
      // 账号简介 / 粉丝数：1.2「对标账号分析」的商业定位要用，见 normalizeBenchmarkAnalysis。
      accountProfile: body?.accountProfile,
    });

    logger.info("route.request.done", {
      interface: "/api/agent/benchmark-analysis",
      analysisSource,
      videoCount: report.analyzedCount,
      categoryCount: report.categories.length,
    });
    return json(res, 200, { success: true, report });
  } catch (error: any) {
    const message = error instanceof Error ? error.message : "Benchmark analysis failed";
    logger.error("route.request.error", {
      interface: "/api/agent/benchmark-analysis",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
}
