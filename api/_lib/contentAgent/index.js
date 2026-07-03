import { buildWorkflowCompatiblePayload, getBenchmarkTopicsFromBody, getShareLinksFromBody, validateWorkflowCompatiblePayload } from "./adapter.js";
import { getContentAgentConfig, shouldUseContentAgent } from "./config.js";
import { AgentError, sendSseEvent, setSseHeaders } from "./http.js";
import { createRequestLogger, safeLink } from "./logger.js";
import { buildCreativeFallback, resolveTikHubVideo, resolveWeChatChannelsTopicVideo, runCreativeAgents, transcribeVideo } from "./providers.js";

export { shouldUseContentAgent } from "./config.js";

const topicWorkflowKey = (topic = {}) => {
  const source = topic?.source || {};
  const rawData = topic?.rawData || {};
  const id =
    source.objectId ||
    rawData.id ||
    rawData.object_id ||
    rawData.objectId ||
    topic.id ||
    source.objectNonceId ||
    rawData.object_nonce_id ||
    rawData.objectNonceId ||
    topic.title ||
    "";
  return `wechat_channels:${String(id || "topic").replace(/^wechat_channels:/, "")}`;
};

const buildContentAgentInputs = ({ shareLinks = [], benchmarkTopics = [] } = {}) => [
  ...shareLinks.map(link => ({
    platform: "douyin",
    shareLink: link,
  })),
  ...benchmarkTopics
    .filter(topic => topic?.platform === "wechat_channels" || topic?.source?.platform === "wechat_channels")
    .map(topic => ({
      platform: "wechat_channels",
      shareLink: topicWorkflowKey(topic),
      topic,
    })),
];

export const runContentAgent = async (shareLinksOrInputs, options = {}) => {
  const config = options.config || getContentAgentConfig();
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const logger = options.logger;
  const inputs = Array.isArray(shareLinksOrInputs) && shareLinksOrInputs.some(item => item && typeof item === "object")
    ? shareLinksOrInputs
    : buildContentAgentInputs({ shareLinks: shareLinksOrInputs });

  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new AgentError("share_links is required", { code: "SHARE_LINKS_EMPTY", status: 400 });
  }
  if (inputs.length > config.maxLinksPerRun) {
    throw new AgentError(`Too many links in one run, max is ${config.maxLinksPerRun}`, {
      code: "TOO_MANY_LINKS",
      status: 400,
    });
  }

  const results = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    const shareLink = input.shareLink;
    const progressBase = { index, total: inputs.length, shareLink, platform: input.platform };
    const itemStartedAt = Date.now();
    logger?.info("agent.item.start", {
      index: index + 1,
      total: inputs.length,
      shareLink: safeLink(shareLink),
      platform: input.platform,
    });

    onProgress({
      ...progressBase,
      step: "resolve-video",
      message: input.platform === "wechat_channels"
        ? `正在准备第 ${index + 1}/${inputs.length} 条视频号媒体`
        : `正在解析第 ${index + 1}/${inputs.length} 条对标视频链接`,
    });
    const video = input.platform === "wechat_channels"
      ? resolveWeChatChannelsTopicVideo(input.topic)
      : await resolveTikHubVideo(shareLink, config, { logger });
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
      total: inputs.length,
      durationMs: Date.now() - itemStartedAt,
      transcriptProvider: transcript.provider,
      title: video.title,
    });
    onProgress({
      ...progressBase,
      step: "completed",
      message: `第 ${index + 1}/${inputs.length} 条视频处理完成`,
    });
  }

  const payload = buildWorkflowCompatiblePayload(results);
  onProgress({
    step: "payload-ready",
    total: inputs.length,
    message: "全部结果已生成，正在输出工作流兼容 payload",
  });
  const validated = validateWorkflowCompatiblePayload(payload, inputs.length);
  logger?.info("agent.payload.ready", {
    resultCount: inputs.length,
  });
  return validated;
};

export const runContentAgentWorkflow = async (_req, res, options = {}) => {
  const config = options.config || getContentAgentConfig();
  const body = options.body || {};
  const shareLinks = getShareLinksFromBody(body);
  const benchmarkTopics = getBenchmarkTopicsFromBody(body);
  const inputs = buildContentAgentInputs({ shareLinks, benchmarkTopics });
  const logger = options.logger || createRequestLogger("content-agent");
  logger.info("workflow.agent.start", {
    workflowId: body?.workflow_id,
    linkCount: shareLinks.length,
    topicCount: benchmarkTopics.length,
    inputCount: inputs.length,
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
      total: inputs.length,
      step: "content-agent-started",
    });

    const payload = await runContentAgent(inputs, {
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
      topicCount: benchmarkTopics.length,
      inputCount: inputs.length,
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
