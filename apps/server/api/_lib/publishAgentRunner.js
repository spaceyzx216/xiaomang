/**
 * 发布仓三个 Agent 的**共享编排层**。
 *
 * 🔴 两套后端（Vercel `api/**` 与本地 Express `server/index.js`）都调这里，
 *    路由文件只做「鉴权 + 读 body + 调这里 + 回 JSON」（HANDOFF §2.1 的优先做法：
 *    逻辑放共享层，改一次两套同时生效）。
 *
 * 这里负责四件事：
 *   1. 校验与裁剪入参（不信任前端）；
 *   2. 组装 Agent 输入（含「账号上下文」这类只读补充信息）；
 *   3. 调 Agent 并让失败**可降级**；
 *   4. 出图阶段（唯一花钱的步骤）单独一个 phase，由用户确认提示词后才触发。
 */

import { getContentAgentConfig } from "./contentAgent/config.js";
import {
  buildCoverRefinePrompt,
  buildCoverStyleRefineInput,
  buildPublishCopyInput,
  buildPublishCoverInput,
  buildPublishTagsInput,
  runBenchmarkCoverAnalysisAgent,
  runCoverStyleRefineAgent,
  runPublishCopyAgent,
  runPublishCoverAgent,
  runPublishTagsAgent,
} from "./contentAgent/publishAgents.js";
import { editImage, generateImage, isImageGenerationConfigured } from "./contentAgent/imageProvider.js";
import { getTopicLibraryCreativeAdaptation } from "./topicLibraryStore.js";
import { getLatestAccountPlanReportForCustomer } from "./accountPlanStore.js";
import { computeTitleFontSize } from "./publishWarehouse.js";

const asText = value => String(value ?? "").trim();

const cleanText = (value, maxLength = 500) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

const badRequest = message => Object.assign(new Error(message), { status: 400 });

/** 一条选题的入参归一化（只保留 Agent 真正用得到的字段）。 */
export const normalizePublishTopic = value => {
  const source = value && typeof value === "object" ? value : {};
  return {
    topicId: cleanText(source.topicId || source.id, 160),
    title: cleanText(source.title, 300),
    threeSeconds: cleanText(source.threeSeconds, 600),
    script: cleanText(source.script, 8000),
    categoryName: cleanText(source.categoryName, 120),
    subcategoryName: cleanText(source.subcategoryName, 120),
    availableSubcategories: (Array.isArray(source.availableSubcategories) ? source.availableSubcategories : [])
      .map(item => cleanText(item, 120)).filter(Boolean).slice(0, 40),
  };
};

/**
 * 取「账号上下文」，用于账号标签库与封面提示词。
 *
 * 两块来源，**主次分明**：
 *
 *   1. **账号规划（1.3）** —— 3.3 文档明确要求从它推三个角度。
 *      2026-09-21 用户拍板「直接开放权限」，所以员工也能读到**该客户**的账号规划
 *      （按客户收口，不是读任意项目经理的报告；边界见 `accountPlanStore` 顶部注释）。
 *   2. **选题库轻量视图** —— 大类名 + 核心功能 + 关键词。它本来就对员工开放，
 *      既补「账号规划还没跑过」的情况，也给封面 Agent 判断职业与场景。
 *
 * ⚠️ 两块都取不到时返回 null，让 Agent 按提示词里「输入没给的写待人工补充」处理；
 *    **绝不编造账号定位**（§6.3⑪ 同一条纪律）。
 */
export const loadAccountContext = async ({ customerId, logger } = {}) => {
  const target = asText(customerId);
  if (!target) return null;

  // ── 来源 1：账号规划（1.3）─────────────────────────────────────────────────
  let accountPlan = null;
  try {
    const latest = await getLatestAccountPlanReportForCustomer({ customerId: target });
    accountPlan = latest?.report || null;
  } catch (error) {
    // 取不到不能让整个 Agent 失败：还有选题库那条来源兜底。
    logger?.warn("publish.account_plan_failed", {
      customerId: target,
      error: error instanceof Error ? error.message : "account plan read failed",
    });
  }

  // ── 来源 2：选题库（内容定位 / 关键词 / 对标账号名）────────────────────────
  let library = null;
  try {
    library = await getTopicLibraryCreativeAdaptation({ customerId: target });
  } catch (error) {
    logger?.warn("publish.account_context_failed", {
      customerId: target,
      error: error instanceof Error ? error.message : "account context failed",
    });
  }

  const accounts = (Array.isArray(library?.accounts) ? library.accounts : []).filter(Boolean);
  const categories = [];
  for (const account of accounts) {
    const list = account?.goldThreeSeconds?.categoryBreakdown || account?.endingHooks?.categoryBreakdown || [];
    for (const category of Array.isArray(list) ? list : []) {
      const name = cleanText(category?.categoryName, 120);
      if (!name) continue;
      categories.push({
        accountName: cleanText(account?.accountName, 120),
        name,
        coreFunction: cleanText(category?.coreFunction, 300),
        keywords: (Array.isArray(category?.keywords) ? category.keywords : []).map(item => cleanText(item, 60)).filter(Boolean).slice(0, 8),
      });
    }
  }

  if (!accountPlan && categories.length === 0) return null;

  return {
    customerName: cleanText(library?.customerName, 200),
    accountNames: accounts.map(item => cleanText(item?.accountName, 120)).filter(Boolean),
    categories: categories.slice(0, 40),
    referenceTags: categories.flatMap(item => item.keywords).slice(0, 12),
    // 1.3 正文可能很大，只留 Agent 真正用得到的几块，别把一整份六节报告塞进提示词。
    accountPlan: pickAccountPlanFields(accountPlan),
    hasAccountPlan: Boolean(accountPlan),
  };
};

/**
 * 从 1.3 报告里挑出「推账号标签」真正需要的字段。
 *
 * 🔴 字段名照**报告真实结构**写（`api/_lib/accountPlan.js` 的返回对象），不是猜的：
 *   1.3 报告**顶层**就是各节正文（`ipPositioning` / `accountSetup` / `topicLibrary` /
 *   `contentFramework` / `production` / `operations`），而顶层 `sections` 只是**键名数组**
 *   （`["ipPositioning", ...]`）—— 对着 `sections.xxx` 取会永远取到空。
 *
 * 3.3 三个角度 ←→ 1.3 的字段：
 *   细分赛道     ← `ipPositioning.businessPositioning`（定位 / 人群 / 赛道）
 *   用户核心痛点 ← 同一块里的 `corePain` / `targetAudience`
 *   内容核心定位 ← `contentPositioning.core` + `frequentTags`（高频标签，文档明确可用）
 * 人设给封面 Agent 判表情场景；选题库给背景关键词。
 * 其余章节（账号搭建 / 内容框架 / 拍摄剪辑 / 起号运营）与标签无关，不传，省 token 也少干扰。
 */
export const pickAccountPlanFields = report => {
  if (!report || typeof report !== "object") return null;
  const pick = (value, maxLength = 2000) => {
    if (value === undefined || value === null || value === "") return null;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    const trimmed = cleanText(text, maxLength);
    return trimmed || null;
  };
  const ip = report.ipPositioning || {};
  const business = ip.businessPositioning || {};
  const content = ip.contentPositioning || {};
  const persona = ip.personaPositioning || {};
  const customer = report.customer || {};

  const picked = {
    商业定位: pick(business),
    内容定位: pick(content.core),
    高频标签: pick(content.frequentTags, 800),
    人设定位: pick(persona),
    客户诉求: pick({
      occupation: customer.occupation,
      ipPositioning: customer.ipPositioning,
      contentNeeds: customer.contentNeeds,
    }, 1200),
    选题库: pick(report.topicLibrary, 1500),
  };
  const nonEmpty = Object.fromEntries(Object.entries(picked).filter(([, value]) => value));
  if (Object.keys(nonEmpty).length > 0) return nonEmpty;
  // 结构完全认不出时（例如以后报告形状改了）退回**整份摘要**，而不是回 null ——
  // 回 null 会让 Agent 以为「没有账号规划」，宁可多给一点上下文。
  return { 报告摘要: pick(report, 2500) };
};

/** 把账号上下文压成给模型看的短文本。 */
const summarizeAccountContext = context => {
  if (!context) return null;
  return {
    customerName: context.customerName,
    accountNames: context.accountNames,
    // ★ 账号规划（1.3）正文 —— 3.3 三个角度的**主来源**。
    accountPlan: context.accountPlan || null,
    hasAccountPlan: Boolean(context.hasAccountPlan),
    categories: context.categories.map(item => ({
      name: item.name,
      coreFunction: item.coreFunction,
      keywords: item.keywords,
    })),
  };
};

/**
 * 端点支持的 phase 清单。
 *
 * ⚠️ 必须声明在 `runPublishPhase` **之前**：它在下面的错误分支里被引用，
 * 声明在使用之后会撞 TDZ（`ReferenceError`），而且**只在「phase 传错」这条路径上炸**
 * —— 正常路径全绿，一传错就 500 而不是可读的 400。HANDOFF §0.0-F2 记过同类坑。
 */
export const PUBLISH_PHASES = ["cover-plan", "cover-base-analysis", "cover-portrait-plan", "cover-style-refine", "cover-title-metrics", "cover-image", "cover-refine-image", "publish-copy", "account-tags", "topic-tags"];

/**
 * 执行一个 phase。
 *
 * @returns { phase, ...payload }
 * @throws  status=400 的入参错误 / 其它交给路由层按 500 处理
 */
export const runPublishPhase = async ({ phase, body = {}, user, logger, config = getContentAgentConfig() } = {}) => {
  const target = asText(phase).toLowerCase();
  const topic = normalizePublishTopic(body?.topic);
  const customerId = asText(body?.customerId);

  if (target === "cover-plan") {
    const accountContext = await loadAccountContext({ customerId, logger });
    const input = buildPublishCoverInput({
      topic,
      accountPlan: body?.accountPlan || summarizeAccountContext(accountContext)?.accountPlan || null,
      benchmarkCover: body?.benchmarkCover || null,
      categoryContext: summarizeAccountContext(accountContext)?.categories || null,
    });
    const plan = await runPublishCoverAgent(input, config, { logger });
    return {
      phase: target,
      plan,
      // 出图能力是否可用要如实告诉前端：没配 key 时界面该说明原因，而不是点了没反应。
      imageGenerationAvailable: isImageGenerationConfigured(),
      accountContext: summarizeAccountContext(accountContext),
    };
  }

  if (target === "cover-base-analysis") {
    // 封面基底第一步（二类/三类）：用户上传对标封面 → 拆解画风/元素/排版/视觉风格。
    // **只用视觉模型，不出图** —— 这一步不花钱，和后面 cover-image 严格分开（§0.3-F1）。
    const image = body?.image && typeof body.image === "object" ? body.image : {};
    // 上传的图是 base64 dataURL（前端 FileReader），也允许直接给一个 http 链接。
    const imageUrl = asText(image.dataUrl) || asText(image.url) || asText(body?.imageUrl);
    if (!imageUrl) throw badRequest("缺少对标封面图片");
    const result = await runBenchmarkCoverAnalysisAgent(imageUrl, config, { logger });
    return {
      phase: target,
      analysis: result.analysis,
      titleStyle: result.titleStyle,
      summary: result.summary,
      // 出图能力照旧如实回报：没配密钥时界面要说明原因，而不是点了没反应。
      imageGenerationAvailable: isImageGenerationConfigured(),
    };
  }

  if (target === "cover-portrait-plan") {
    // IP 形象照是**账号级**的（三类的可复用 agent 之一）：输入只有账号规划/人设定位。
    // ⚠️ 所以 topic 刻意传空对象 —— 形象照不该被「当前这条选题」影响，
    //    否则同一账号每换一条选题就会得到一张不同的脸，那不是「账号恒定」。
    // 复用同一个封面提示词的 Agent，只取它的 ipPortrait 部分（不额外维护一套提示词）。
    const accountContext = await loadAccountContext({ customerId, logger });
    const input = buildPublishCoverInput({
      topic: {},
      accountPlan: body?.accountPlan || summarizeAccountContext(accountContext)?.accountPlan || null,
      categoryContext: summarizeAccountContext(accountContext)?.categories || null,
    });
    const plan = await runPublishCoverAgent(input, config, { logger });
    return {
      phase: target,
      ipPortrait: plan.ipPortrait,
      imageGenerationAvailable: isImageGenerationConfigured(),
    };
  }

  if (target === "cover-style-refine") {
    // 标题样式的自然语言微调（用户口径：样式由视觉模型识别，之后用聊天框自然语言调整）。
    // 纯文本调用，不出图。
    const instruction = cleanText(body?.instruction, 800);
    if (!instruction) throw badRequest("请说明要调整什么");
    const current = body?.titleStyle && typeof body.titleStyle === "object" ? body.titleStyle : {};
    const input = buildCoverStyleRefineInput({
      titleStyle: current,
      instruction,
      recognized: body?.recognized || null,
      history: Array.isArray(body?.history) ? body.history : [],
    });
    return { phase: target, ...(await runCoverStyleRefineAgent(input, current, config, { logger })) };
  }

  if (target === "cover-title-metrics") {
    // 纯计算：不调模型、不出图。用户口径是「标题风格锁在模板里，只按长度和空间调字号」，
    // 所以这一步按基底里的标题样式，给每个候选标题算出最终字号与行数。
    // 让后端算（而不是前端各写一份）的理由同 §6.3⑬：这条规则一旦两边各写一份就会漂。
    const titleStyle = body?.titleStyle && typeof body.titleStyle === "object" ? body.titleStyle : {};
    const titles = (Array.isArray(body?.titles) ? body.titles : [])
      .map(item => cleanText(item, 300))
      .filter(Boolean)
      .slice(0, 12);
    return {
      phase: target,
      items: titles.map(title => ({ title, ...computeTitleFontSize({ title, titleStyle }) })),
    };
  }

  if (target === "cover-refine-image") {
    // 对话式改图：以**当前这张封面**为参考图重新出图，只改用户提到的部分。
    // 与 cover-image 的区别只有两点：提示词不同、必须带上一张图（它是迭代，不是从零出图）。
    // 单独一个 phase 是为了让规则只有一份，调用方不用自己拼。
    const instruction = cleanText(body?.instruction, 600);
    if (!instruction) throw badRequest("请说明要改什么");
    const image = body?.image && typeof body.image === "object" ? body.image : {};
    const currentImage = {
      url: asText(image.url).slice(0, 4_000_000),
      dataUrl: asText(image.dataUrl).slice(0, 4_000_000),
    };
    if (!currentImage.url && !currentImage.dataUrl) {
      throw badRequest("缺少要修改的封面图（改图必须基于上一版）");
    }
    if (!isImageGenerationConfigured()) {
      throw Object.assign(
        new Error("服务器未配置出图密钥（XXCAPI_API_KEY），暂时无法改图"),
        { status: 501, code: "IMAGE_NOT_CONFIGURED" },
      );
    }
    const prompt = buildCoverRefinePrompt({
      instruction,
      history: Array.isArray(body?.history) ? body.history : [],
      title: cleanText(body?.title, 300),
      titleStyle: body?.titleStyle && typeof body.titleStyle === "object" ? body.titleStyle : null,
    });
    const result = await editImage(prompt, [currentImage], {
      config: undefined,
      size: body?.size,
      quality: body?.quality,
      aspectRatio: body?.aspectRatio || "3:4",
      logger,
    });
    return { phase: target, images: result.images, model: result.model, elapsedMs: result.elapsedMs };
  }

  if (target === "cover-image") {
    // ⚠️ **先校验入参，再校验配置**：提示词为空是调用方的错（400），
    //    没配密钥是部署方的事（501）。顺序反了会在「没配密钥」时把 400 也报成 501，
    //    用户拿到指向错误方向的提示（冒烟实测抓到过这一条）。
    const prompt = cleanText(body?.prompt, 2000);
    if (!prompt) throw badRequest("缺少出图提示词");
    if (!isImageGenerationConfigured()) {
      throw Object.assign(new Error("服务器未配置出图密钥（XXCAPI_API_KEY），暂时无法生成图片"), { status: 501, code: "IMAGE_NOT_CONFIGURED" });
    }
    // 参考图（可选）：IP 形象照、背景模板、用户上传的照片。
    const referenceImages = (Array.isArray(body?.referenceImages) ? body.referenceImages : [])
      .map(item => ({
        url: asText(item?.url).slice(0, 4_000_000),
        dataUrl: asText(item?.dataUrl).slice(0, 4_000_000),
      }))
      .filter(item => item.url || item.dataUrl)
      .slice(0, 4);

    const options = {
      config: undefined,
      size: body?.size,
      quality: body?.quality,
      background: body?.background,
      aspectRatio: body?.aspectRatio || "3:4",
      logger,
    };
    const result = referenceImages.length > 0
      // 有参考图就必须走 edits —— 文档的「结合客户现有参考照片」只能这么做。
      ? await editImage(prompt, referenceImages, options)
      : await generateImage(prompt, options);
    return { phase: target, images: result.images, model: result.model, elapsedMs: result.elapsedMs };
  }

  if (target === "publish-copy") {
    const accountTags = (Array.isArray(body?.accountTags) ? body.accountTags : []).map(item => cleanText(item, 80)).filter(Boolean).slice(0, 10);
    const input = buildPublishCopyInput({ topic, accountTags });
    // ★ 标题与 3s 是「复用」，由前端把内容生成页已选的结果传进来，**不调模型**。
    const reuse = {
      title: (Array.isArray(body?.reuseTitles) ? body.reuseTitles : []).map(item => cleanText(item, 200)).filter(Boolean).slice(0, 4),
      threeSeconds: (Array.isArray(body?.reuseThreeSeconds) ? body.reuseThreeSeconds : []).map(item => cleanText(item, 200)).filter(Boolean).slice(0, 4),
    };
    const publishCopy = await runPublishCopyAgent(input, reuse, config, { logger });
    return { phase: target, publishCopy };
  }

  if (target === "account-tags" || target === "topic-tags") {
    const accountContext = await loadAccountContext({ customerId, logger });
    const input = buildPublishTagsInput({
      phase: target === "account-tags" ? "account" : "topic",
      topic,
      accountPlan: body?.accountPlan || summarizeAccountContext(accountContext)?.accountPlan || null,
      categoryContext: summarizeAccountContext(accountContext)?.categories || null,
      referenceTags: accountContext?.referenceTags || [],
    });
    const value = await runPublishTagsAgent(input, target === "account-tags" ? "account" : "topic", config, { logger });
    return target === "account-tags"
      ? { phase: target, accountTags: value }
      : { phase: target, topicTags: value };
  }

  throw badRequest(`不支持的 phase：${asText(phase) || "(空)"}（可用：${PUBLISH_PHASES.join(" / ")}）`);
};
