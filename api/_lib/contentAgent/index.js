import { buildWorkflowCompatiblePayload, getShareLinksFromBody, validateWorkflowCompatiblePayload } from "./adapter.js";
import { getContentAgentConfig, shouldUseContentAgent } from "./config.js";
import { AgentError, sendSseEvent, setSseHeaders } from "./http.js";
import { createRequestLogger, safeLink } from "./logger.js";
import { buildCreativeFallback, resolveTikHubVideo, runCreativeAgents, transcribeVideo } from "./providers.js";

export { shouldUseContentAgent } from "./config.js";

export const runContentAgent = async (shareLinks, options = {}) => {
  const config = options.config || getContentAgentConfig();
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const logger = options.logger;

  if (!Array.isArray(shareLinks) || shareLinks.length === 0) {
    throw new AgentError("share_links is required", { code: "SHARE_LINKS_EMPTY", status: 400 });
  }
  if (shareLinks.length > config.maxLinksPerRun) {
    throw new AgentError(`Too many links in one run, max is ${config.maxLinksPerRun}`, {
      code: "TOO_MANY_LINKS",
      status: 400,
    });
  }

  const results = [];
  for (let index = 0; index < shareLinks.length; index += 1) {
    const shareLink = shareLinks[index];
    const progressBase = { index, total: shareLinks.length, shareLink };
    const itemStartedAt = Date.now();
    logger?.info("agent.item.start", {
      index: index + 1,
      total: shareLinks.length,
      shareLink: safeLink(shareLink),
    });

    onProgress({
      ...progressBase,
      step: "resolve-video",
      message: `正在解析第 ${index + 1}/${shareLinks.length} 条对标视频链接`,
    });
    const video = await resolveTikHubVideo(shareLink, config, { logger });
    onProgress({
      ...progressBase,
      step: "video-resolved",
      title: video.title,
      message: `已获取视频信息：${video.title || "未识别标题"}`,
    });

    onProgress({
      ...progressBase,
      step: "transcribe-video",
      title: video.title,
      providers: config.transcriptProviders,
      message: `开始提取音频并转写口播，执行方案：${config.transcriptProviders.join(" -> ")}`,
    });
    const transcript = await transcribeVideo(video, config, {
      logger,
      onProgress: progress => onProgress({ ...progressBase, ...progress }),
    });
    onProgress({
      ...progressBase,
      step: "transcript-ready",
      provider: transcript.provider,
      message: `口播转写完成，命中方案：${transcript.provider}`,
    });

    onProgress({
      ...progressBase,
      step: "creative-agents",
      provider: transcript.provider,
      message: "开始并行调用 4 个 DeepSeek 创作 Agent：开头钩子、结尾钩子、标题、二创文案",
    });
    let creative;
    try {
      creative = await runCreativeAgents(video, transcript, config, {
        logger,
        onProgress: progress => onProgress({ ...progressBase, ...progress }),
      });
    } catch (error) {
      logger?.error("creative.agents.unhandled_error", {
        code: error?.code || "CREATIVE_AGENTS_FAILED",
        status: error?.status,
        error: error instanceof Error ? error.message : "Creative agents failed",
      });
      onProgress({
        ...progressBase,
        step: "creative-agents-fallback",
        level: "warn",
        code: error?.code,
        message: "创作 Agent 发生未捕获错误，已使用兼容保底结果继续输出",
      });
      creative = buildCreativeFallback(video, transcript, error);
    }
    onProgress({
      ...progressBase,
      step: "creative-agents-ready",
      fallbackCount: Array.isArray(creative.warnings) ? creative.warnings.length : 0,
      message: Array.isArray(creative.warnings) && creative.warnings.length > 0
        ? `4 个创作 Agent 已完成，其中 ${creative.warnings.length} 个使用保底结果，正在整理为前端兼容结构`
        : "4 个创作 Agent 已完成，正在整理为前端兼容结构",
    });

    results.push({ shareLink, video, transcript, creative });
    logger?.info("agent.item.end", {
      index: index + 1,
      total: shareLinks.length,
      durationMs: Date.now() - itemStartedAt,
      transcriptProvider: transcript.provider,
      title: video.title,
    });
    onProgress({
      ...progressBase,
      step: "completed",
      message: `第 ${index + 1}/${shareLinks.length} 条视频处理完成`,
    });
  }

  const payload = buildWorkflowCompatiblePayload(results);
  onProgress({
    step: "payload-ready",
    total: shareLinks.length,
    message: "全部结果已生成，正在输出工作流兼容 payload",
  });
  const validated = validateWorkflowCompatiblePayload(payload, shareLinks.length);
  logger?.info("agent.payload.ready", {
    resultCount: shareLinks.length,
  });
  return validated;
};

export const runContentAgentWorkflow = async (_req, res, options = {}) => {
  const config = options.config || getContentAgentConfig();
  const body = options.body || {};
  const shareLinks = getShareLinksFromBody(body);
  const logger = options.logger || createRequestLogger("content-agent");
  logger.info("workflow.agent.start", {
    workflowId: body?.workflow_id,
    linkCount: shareLinks.length,
    provider: config.provider,
    transcriptProviders: Array.isArray(config.transcriptProviders) ? config.transcriptProviders.join(",") : "",
    doubaoResourceId: config.doubaoResourceId,
    tikhubConfigured: Boolean(config.tikhubApiToken),
    deepseekConfigured: Boolean(config.deepseekApiKey),
    doubaoAsrConfigured: Boolean(config.doubaoApiKey || (config.doubaoAppKey && config.doubaoAccessKey)),
    doubaoVideoConfigured: Boolean(config.doubaoVideoEndpoint && config.doubaoVideoApiKey),
  });

  setSseHeaders(res, 200);

  try {
    sendSseEvent(res, "Progress", {
      message: "content-agent-started",
      total: shareLinks.length,
      step: "content-agent-started",
    });

    const payload = await runContentAgent(shareLinks, {
      config,
      logger,
      onProgress: progress => sendSseEvent(res, "Progress", progress),
    });

    sendSseEvent(res, "Message", {
      content: JSON.stringify(payload),
    });
    sendSseEvent(res, "Done", {});
    logger.info("workflow.agent.done", {
      linkCount: shareLinks.length,
    });
    res.end();
  } catch (error) {
    const status = error?.status || 500;
    const message = error instanceof Error ? error.message : "Content agent failed";
    sendSseEvent(res, "Error", {
      error_message: message,
      code: error?.code || "CONTENT_AGENT_FAILED",
      status,
      details: error?.details,
    });
    logger.error("workflow.agent.error", {
      status,
      code: error?.code || "CONTENT_AGENT_FAILED",
      error: message,
    });
    res.end();
  }
};

export const canHandleContentAgentWorkflow = shouldUseContentAgent;
