import { buildWorkflowCompatiblePayload, getBenchmarkTopicsFromBody, getExtractedScriptsFromBody, getShareLinksFromBody, validateWorkflowCompatiblePayload } from "./adapter.js";
import { getContentAgentConfig, shouldUseContentAgent } from "./config.js";
import { AgentError, sendSseEvent, setSseHeaders } from "./http.js";
import { createRequestLogger, safeLink } from "./logger.js";
import { buildCreativeFallback, resolveTikHubVideo, resolveWeChatChannelsTopicVideo, runCreativeAgents, transcribeVideo } from "./providers.js";
import { buildCategoryAdaptation } from "../topicCreativeAdaptation.js";
import { buildTitleAdaptation } from "../titleLibrary.js";
import { getTopicLibraryCreativeAdaptation } from "../topicLibraryStore.js";
import { getActiveReviewMemory } from "../weeklyAnalysisStore.js";
import { applyReviewMemory } from "../weeklyCreativeAdaptation.js";
import { GOLD_THREE_SECOND_TYPE_LABELS } from "../goldThreeSeconds.js";
import { ENDING_HOOK_TYPE_LABELS } from "../endingHooks.js";

export { shouldUseContentAgent } from "./config.js";

/**
 * 从请求体里取「分享链接 → 这条视频在选题库里被判定的内容大类」。
 *
 * 前端在「今日选题」页已经把每条的大类判好了（`topic.content.categoryName`），
 * 二创直接用，**后端不再让模型判一次**（那会多付一次 ~20s 的固定开销，
 * 还会和已有标签产生两个互相矛盾的口径）。
 *
 * 兼容三种写法：`content_adaptation` / `contentAdaptation` / 同层 `category_names`。
 */
export const getCategoryNamesFromBody = body => {
  const raw = body?.content_adaptation ?? body?.contentAdaptation ?? body?.category_names ?? body?.parameters?.content_adaptation;
  const map = new Map();
  if (!raw || typeof raw !== "object") return map;
  for (const [link, categoryName] of Object.entries(raw)) {
    const key = String(link || "").trim();
    const value = String(categoryName || "").trim();
    if (key && value) map.set(key, value);
  }
  return map;
};

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

const buildContentAgentInputs = ({ shareLinks = [], benchmarkTopics = [], shareLinkPlatform = "douyin" } = {}) => [
  ...shareLinks.map(link => ({
    platform: shareLinkPlatform,
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

/**
 * 取「某个客户的选题库 → 链接 → 三秒/结尾钩子适配计划」。
 *
 * 一次请求只读一次库（不是每条视频读一次），然后把类别配比**按大类名**解析出来，
 * 最后按链接挂到每条视频上。
 *
 * ⚠️ 三类失败都**不影响生成**，只降级：没有 customerId / 没有库 / 库读失败
 * → 返回空表，下面 `runCreativeAgents` 会自动退回原来的自由二创提示词。
 * 二创是这个页面的主功能，不该因为「这个客户还没建库」就整条挂掉。
 */
const loadAdaptationByLink = async ({ customerId, categoryNames, platforms = new Map(), logger }) => {
  const target = String(customerId || "").trim();
  if (!target || categoryNames.size === 0) return { map: new Map(), enabled: false };
  const memories = new Map();
  await Promise.all([...new Set(platforms.values())].filter(p => ['douyin', 'wechat_channels'].includes(p)).map(async platform => {
    try { memories.set(platform, await getActiveReviewMemory({ customerId: target, platform })); }
    catch (error) { logger?.warn('creative.review_memory_failed', { error: error.message }); }
  }));
  let library = null;
  try {
    // 员工侧只读口径：不按 managerId 过滤（员工不是库的属主），只回配比来源。
    library = await getTopicLibraryCreativeAdaptation({ customerId: target });
  } catch (error) {
    logger?.warn("creative.adaptation.library_failed", {
      code: error?.code || "TOPIC_LIBRARY_READ_FAILED",
      error: error instanceof Error ? error.message : "library read failed",
    });
  }
  if (!library && ![...memories.values()].some(Boolean)) {
    logger?.info("creative.adaptation.library_missing", { customerId: target });
    return { map: new Map(), enabled: false };
  }

  // 一个库可能有多个对标账号，各自一棵分类树。同一大类名在多个账号下都要能命中
  // —— 用「包含即命中」而不是「取第一个账号」，否则第二个账号的配比永远用不上。
  const accounts = Array.isArray(library?.accounts) ? library.accounts.filter(Boolean) : [];
  const map = new Map();
  for (const [link, categoryName] of categoryNames.entries()) {
    const matches = accounts.map(account => ({
      accountName: account.accountName,
      goldThreeSeconds: buildCategoryAdaptation({
        categoryName,
        report: account.goldThreeSeconds,
        labels: GOLD_THREE_SECOND_TYPE_LABELS,
      }),
      endingHooks: buildCategoryAdaptation({
        categoryName,
        report: account.endingHooks,
        labels: ENDING_HOOK_TYPE_LABELS,
      }),
      // 标题配比（2.3 标题）：**刻意复用 2.2 黄金三秒报告** —— 标题类型就是
      // 三秒那 8 个类型，所以那份报告的 categoryBreakdown 就是标题配比。
      // 理由与边界见 titleLibrary.js 顶部的两个设计决定。
      title: buildTitleAdaptation({
        categoryName,
        report: account.goldThreeSeconds,
      }),
    }))
      // 只保留真的算出了槽位的账号：算不出槽位等于这个账号的库没纳入那份分析。
      // （标题与三秒同源，所以三秒有槽位时标题必然也有；这里仍显式列出，
      //   将来标题配比独立成源时不用回来改这一行。）
      .filter(item => item.goldThreeSeconds.slots.length > 0
        || item.endingHooks.slots.length > 0
        || item.title.slots.length > 0);
    const memory = memories.get(platforms.get(link));
    if (matches.length > 0 || memory) map.set(link, { customerName: library?.customerName || '', candidates: matches, memory, categoryName });
  }

  logger?.info("creative.adaptation.ready", {
    customerId: target,
    accountCount: accounts.length,
    requestedLinks: categoryNames.size,
    matchedLinks: map.size,
  });
  return { map, enabled: true };
};

/**
 * 多条账号命中同一个大类时，选槽位最全的那一条。
 *
 * 一个客户可以有多个对标账号（「不合并」是明确口径），同名大类可能同时存在于
 * 两个账号的分类树里。二创只需要**一份**配比，所以取「能算出槽位更多」的那份
 * —— 也就是库纳入得更完整的那份分析。两边都一样时保持原顺序（稳定，不随机）。
 *
 * 返回值显式带上标题配比：`runCreativeAgents` 读的是 `adaptation.title`，
 * 漏掉这个字段会让标题静默退回自由创作口径（不报错，只是配比不生效）。
 */
export const buildVideoAdaptation = entry => {
  const candidates = Array.isArray(entry?.candidates) ? entry.candidates : [];
  if (candidates.length === 0) return applyReviewMemory({ memory: entry?.memory, categoryName: entry?.categoryName });
  const slotCount = value => (Array.isArray(value?.slots) ? value.slots.length : 0);
  // 🔴 标题配比与三秒配比**同源**（都来自 2.2 报告），所以这里刻意**不把标题
  //    算进分数**：算了等于把同一份报告数两遍，「纳入更完整」的判断会被
  //    重复计数带偏。总分仍然只以三秒 + 结尾钩子两份来分析。
  const score = item => slotCount(item.goldThreeSeconds) + slotCount(item.endingHooks);
  const best = candidates.reduce((current, item) => (score(item) > score(current) ? item : current), candidates[0]);
  return applyReviewMemory({ memory: entry?.memory, categoryName: entry?.categoryName, adaptation: {
    accountName: best.accountName,
    goldThreeSeconds: best.goldThreeSeconds || null,
    endingHooks: best.endingHooks || null,
    title: best.title || null,
  } });
};

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

  // 前端随请求带来的「已提取好的脚本」（选题页近 7 天提过的那批）。
  // 命中就跳过 resolve + transcribe 两步 —— 见下面 `preset` 处的说明。
  const providedScripts = options.providedScripts instanceof Map ? options.providedScripts : new Map();

  // 选题库配比：一次读库、按链接挂到每条视频上（读不到就是空表，自动降级）。
  const adaptationContext = await loadAdaptationByLink({
    customerId: options.customerId,
    platforms: new Map(inputs.map(input => [input.shareLink, input.platform])),
    categoryNames: options.categoryNames instanceof Map ? options.categoryNames : new Map(),
    logger,
  });

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

    // ── 已提取好的脚本：直接复用，不解析、不转写 ──────────────────────────
    // 选题页（近 7 天）已经把每条选题的完整脚本提出来了，前端随请求一起带过来。
    // 这里**跳过 resolve + transcribe 两步**：
    //   · resolve（TikHub 3~7s）只为了拿 title/cover/直链，而创作 Agent 真正需要的
    //     只有「标题 + 原视频链接 + 脚本正文」（见 `buildCreativeInput`）；
    //   · transcribe（整条视频 10~45s）就是要把脚本再抽一遍 —— 纯重复劳动。
    // 两步都不做，二创从"分钟级"降到"只需 4 个创作 Agent 的时间"。
    const preset = providedScripts.get(shareLink);
    let video;
    let transcript;
    if (preset) {
      video = {
        shareLink,
        platform: input.platform,
        title: preset.title || input.topic?.title || "未识别标题",
        cover: "",
        videoUrl: "",
        videoUrls: [],
        sourceProvider: "preset-script",
      };
      transcript = { text: preset.script, provider: "preset-script", cached: true };
      logger?.info("agent.item.script_reused", {
        index: index + 1,
        shareLink: safeLink(shareLink),
        scriptLength: preset.script.length,
        title: video.title,
      });
      onProgress({
        ...progressBase,
        step: "transcript-ready",
        provider: transcript.provider,
        message: "已复用选题页提取好的脚本，跳过解析与转写",
      });
    } else {
      onProgress({
        ...progressBase,
        step: "resolve-video",
        message: input.platform === "wechat_channels"
          ? `正在准备第 ${index + 1}/${inputs.length} 条视频号媒体`
          : `正在解析第 ${index + 1}/${inputs.length} 条对标视频链接`,
      });
      video = input.platform === "wechat_channels"
        ? resolveWeChatChannelsTopicVideo(input.topic)
        : await resolveTikHubVideo(shareLink, config, { logger, platform: input.platform });
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
      transcript = await transcribeVideo(video, config, {
        logger,
        onProgress: progress => onProgress({ ...progressBase, ...progress }),
      });
      onProgress({
        ...progressBase,
        step: "transcript-ready",
        provider: transcript.provider,
        message: `口播转写完成，命中方案：${transcript.provider}`,
      });
    }

    onProgress({
      ...progressBase,
      step: "creative-agents",
      provider: transcript.provider,
      message: "开始并行调用 4 个 DeepSeek 创作 Agent：开头钩子、结尾钩子、标题、二创文案",
    });
    // 这条视频的库内大类适配。取不到就是 null（`runCreativeAgents` 会退回原提示词）。
    const adaptation = buildVideoAdaptation(adaptationContext.map.get(shareLink));
    let creative;
    try {
      creative = await runCreativeAgents(video, transcript, config, {
        logger,
        adaptation,
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
  // 前端通过 source_platform 标记分享链接来源平台（douyin/tiktok），默认 douyin。
  // 视频号走 benchmark_topics，平台由 topic 自身标记，不依赖此字段。
  const shareLinkPlatform = String(body?.source_platform || body?.sourcePlatform || "douyin").toLowerCase() === "tiktok"
    ? "tiktok"
    : "douyin";
  const inputs = buildContentAgentInputs({ shareLinks, benchmarkTopics, shareLinkPlatform });
  const logger = options.logger || createRequestLogger("content-agent");
  // 选题库的二创适配：客户在「入口」就定了（临时任务 / 指派任务带下来），
  // 大类由前端从「今日选题」页**已判定**的标签带过来 —— 后端不再让模型判一次。
  const customerId = String(body?.customerId || body?.customer_id || body?.parameters?.customerId || "").trim();
  const categoryNames = getCategoryNamesFromBody(body);
  // 「已提取脚本」：有就复用，没有才现场解析+转写（不是所有入口都有——例如纯手贴链接）。
  const providedScripts = getExtractedScriptsFromBody(body);
  logger.info("workflow.agent.start", {
    workflowId: body?.workflow_id,
    linkCount: shareLinks.length,
    topicCount: benchmarkTopics.length,
    inputCount: inputs.length,
    // 只记个数，不记客户 id 与大类名（日志里不带业务内容）。
    adaptationCustomerBound: Boolean(customerId),
    adaptationCategoryCount: categoryNames.size,
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
      customerId,
      categoryNames,
      providedScripts,
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
