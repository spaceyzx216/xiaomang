/**
 * 发布仓的三个 Agent（2026-09-21 第七轮，见 HANDOFF §0.3）。
 *
 *   3.1 封面     `runPublishCoverAgent`    —— 出提示词与样式模板（**不出图**）
 *   3.2 发布文案 `runPublishCopyAgent`     —— 只出金句与互动（标题/3s 由调用方复用）
 *   3.3 发布标签 `runPublishTagsAgent`     —— phase: account | topic
 *
 * 🔴 与其它 Agent 同一条纪律（§6.3⑪⑫⑬）：
 *   - 提示词里的清单**从 `publishWarehouse.js` 的定义生成**，不在这里手写；
 *   - 模型的原始输出**一律过后端归一化**（数量/配额由后端裁剪，不是模型说了算）；
 *   - 失败要让调用方**能降级**，不要在这里吞掉（见下面 `throwOnEmpty` 的说明）。
 *
 * ⚠️ 封面 Agent **不调出图接口**：文档要求的顺序是「给出提示词 → **人工修改确认** →
 *    再生成图片」。所以出图是用户在界面上确认之后，由 `/api/agent/publish-cover`
 *    的 `image` 阶段单独触发的（那一步才花钱）。
 */

import { getContentAgentConfig } from "./config.js";
import { BENCHMARK_COVER_ANALYSIS_PROMPT, COVER_IMAGE_REFINE_PROMPT, COVER_STYLE_REFINE_PROMPT, PUBLISH_COPY_PROMPT, PUBLISH_COVER_PROMPT, PUBLISH_TAGS_PROMPT } from "./prompts.js";
import { runJsonAgent, understandDoubaoImage } from "./providers.js";
import { parseJsonAgentOutput } from "./adapter.js";
import {
  normalizeAccountTags,
  normalizeBenchmarkCoverAnalysis,
  normalizeCoverPlan,
  normalizePublishCopy,
  normalizeTitleStyleTemplate,
  normalizeTopicTags,
} from "../publishWarehouse.js";

const asText = value => String(value ?? "").trim();

const cleanText = (value, maxLength = 800) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

/** 把任意对象安全地拍平成给模型看的文本（截断，避免把整个库塞进提示词）。 */
const section = (title, value, maxLength = 2000) => {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `【${title}】\n${cleanText(text, maxLength)}`;
};

/**
 * 3.1 封面的输入组装。
 *
 * 账号规划（1.3）是**可选的**：它是 manager-only 的报告，员工侧拿不到全部字段。
 * 拿不到就如实少给，提示词里也写了「输入没给的写待人工补充」——
 * 靠选题库的分类树（coreFunction + keywords）已经足够推出账号级标签与背景方向。
 */
export const buildPublishCoverInput = ({ topic = {}, accountPlan = null, benchmarkCover = null, categoryContext = null } = {}) => [
  section("这条选题", {
    title: topic.title,
    threeSeconds: topic.threeSeconds,
    script: topic.script,
    categoryName: topic.categoryName,
    subcategoryName: topic.subcategoryName,
  }, 3000),
  section("账号规划", accountPlan, 3000),
  section("选题库里的内容定位（大类核心功能与关键词）", categoryContext, 1500),
  section("人工提供的对标封面素材或描述", benchmarkCover, 2000),
].filter(Boolean).join("\n\n");

/** 3.2 发布文案的输入组装。 */
export const buildPublishCopyInput = ({ topic = {}, accountTags = [] } = {}) => [
  section("这条选题", {
    title: topic.title,
    threeSeconds: topic.threeSeconds,
    script: topic.script,
    categoryName: topic.categoryName,
    subcategoryName: topic.subcategoryName,
  }, 4000),
  Array.isArray(accountTags) && accountTags.length > 0
    ? section("本账号的恒定标签（写文案时可与之呼应，但不要直接抄进文案）", accountTags, 400)
    : "",
].filter(Boolean).join("\n\n");

/** 3.3 发布标签的输入组装。 */
export const buildPublishTagsInput = ({ phase = "account", topic = {}, accountPlan = null, categoryContext = null, referenceTags = [] } = {}) => {
  if (phase === "account") {
    return [
      "请执行【任务 A：账号标签库】。",
      section("账号规划", accountPlan, 3000),
      section("选题库里的内容定位（大类核心功能与关键词）", categoryContext, 1500),
      section("对标账号的高频标签（可参考，不要照抄）", referenceTags, 600),
    ].filter(Boolean).join("\n\n");
  }
  return [
    "请执行【任务 B：选题标签】。",
    section("这条选题", {
      title: topic.title,
      threeSeconds: topic.threeSeconds,
      script: topic.script,
      categoryName: topic.categoryName,
      subcategoryName: topic.subcategoryName,
    }, 4000),
    section("库内可选的内容小类", topic.availableSubcategories, 600),
  ].filter(Boolean).join("\n\n");
};

/**
 * 标题样式自然语言微调的输入组装。
 *
 * 带上「视觉模型识别出来的原始描述」：用户改的往往正是**识别得不对**的地方
 * （「这不是书法体」），没有原文的话模型不知道他在否定什么。
 */
export const buildCoverStyleRefineInput = ({ titleStyle = null, instruction = "", recognized = null, history = [] } = {}) => [
  section("当前标题样式（用户没说到的字段要原样保留）", titleStyle, 1200),
  section("视觉模型对这张图标题样式的原始描述（用户可能是在否定它）", recognized, 1200),
  section("用户的要求", instruction, 800),
  Array.isArray(history) && history.length > 0
    ? section("最近的对话（仅供理解上下文，不要重复回答）", history.slice(-6), 1200)
    : "",
].filter(Boolean).join("\n\n");

/** 3.1 封面：出方案（提示词 + 样式模板 + 背景候选）。 */
export const runPublishCoverAgent = async (input, config = getContentAgentConfig(), options = {}) => {
  const plan = await runJsonAgent({
    system: PUBLISH_COVER_PROMPT,
    user: input,
    interfaceName: "deepseek:agent-publish-cover",
    normalizer: normalizeCoverPlan,
  }, config, options);

  // 一个背景候选都没有 = 这次没产出任何可出图的东西。宁可让调用方知道并降级，
  // 也不要回一个空壳让界面显示「生成了 0 个候选」却不说为什么。
  if (plan.backgrounds.length === 0 && !plan.ipPortrait.prompt) {
    const error = new Error("封面 Agent 没有产出可用的提示词");
    error.code = "PUBLISH_COVER_EMPTY";
    throw error;
  }
  return plan;
};

/** 3.2 发布文案：只出金句与互动；标题 / 3s 由调用方从已选结果复用进来。 */
export const runPublishCopyAgent = async (input, reuse = {}, config = getContentAgentConfig(), options = {}) => {
  const agentValue = await runJsonAgent({
    system: PUBLISH_COPY_PROMPT,
    user: input,
    interfaceName: "deepseek:agent-publish-copy",
    // 归一化在这里就把「复用」的两类合进去 —— 保证四类永远齐，
    // 不会因为模型那一侧少给而让界面缺一块。
    normalizer: value => value,
  }, config, options);
  return normalizePublishCopy(agentValue, reuse);
};

/** 3.1 封面基底：把「视觉模型识别出的标题样式」按用户自然语言微调（只改他提到的那部分）。 */
export const runCoverStyleRefineAgent = async (input, fallbackStyle = null, config = getContentAgentConfig(), options = {}) => {
  const value = await runJsonAgent({
    system: COVER_STYLE_REFINE_PROMPT,
    user: input,
    interfaceName: "deepseek:cover-style-refine",
    normalizer: raw => raw,
  }, config, options);
  return {
    // 模型没回样式时退回当前样式（而不是清空）—— 清空会让用户刚调好的东西凭空消失。
    titleStyle: normalizeTitleStyleTemplate(value?.titleStyle || fallbackStyle || {}),
    reply: cleanText(value?.reply, 200),
  };
};

/**
 * 「对话式改图」的输入组装（封面候选旁边那个话框）。
 *
 * 带上**之前的调整记录**：用户常说「再亮一点」「字再大些」这类相对说法，
 * 没有上文模型不知道是相对哪一版。也带上这一条封面的标题与样式，作为「不要乱改」的锚点。
 */
export const buildCoverRefineInput = ({ instruction = "", history = [], title = "", titleStyle = null } = {}) => [
  section("这张封面的已知信息（只用于理解上下文，不要照抄进图里）", {
    标题: title || undefined,
    标题样式: titleStyle || undefined,
  }, 800),
  Array.isArray(history) && history.length > 0
    ? section("之前的调整记录（从早到晚）", history.slice(-6), 1200)
    : "",
  section("这次要改什么", instruction, 600),
].filter(Boolean).join("\n\n");

/**
 * 把「改图说明 + 输入」拼成出图接口要的单一 prompt。
 *
 * ⚠️ 出图接口只收一个 prompt（没有 system 消息），所以规则必须拼进同一段文本 ——
 *    这一点与 DeepSeek 那几个 Agent 不同，别照搬那边的 { system, user } 写法。
 */
export const buildCoverRefinePrompt = payload => (
  `${COVER_IMAGE_REFINE_PROMPT}\n\n${buildCoverRefineInput(payload)}`
);

/** 3.1 封面基底第一步：上传一张对标封面图 → 拆解（画风 / 元素 / 排版 / 视觉风格 + 留白 + 标题样式）。 */
export const runBenchmarkCoverAnalysisAgent = async (imageUrl, config = getContentAgentConfig(), options = {}) => {
  const text = await understandDoubaoImage(imageUrl, BENCHMARK_COVER_ANALYSIS_PROMPT, config, options);
  let parsed;
  try {
    parsed = parseJsonAgentOutput(text);
  } catch {
    // 拆解不出结构就别硬塞给用户看一段自由文本 —— 让调用方按 502 如实报错，用户重传一次即可。
    const error = new Error("对标封面拆解没有返回可解析的 JSON，请重新上传或换一张图");
    error.code = "BENCHMARK_COVER_ANALYSIS_BAD_JSON";
    throw error;
  }
  return normalizeBenchmarkCoverAnalysis(parsed);
};

/** 3.3 发布标签：phase=account 出账号标签库；phase=topic 出选题标签。 */
export const runPublishTagsAgent = async (input, phase = "account", config = getContentAgentConfig(), options = {}) => {
  const value = await runJsonAgent({
    system: PUBLISH_TAGS_PROMPT,
    user: input,
    interfaceName: `deepseek:agent-publish-tags-${phase === "account" ? "account" : "topic"}`,
    normalizer: raw => raw,
  }, config, options);
  return phase === "account" ? normalizeAccountTags(value) : normalizeTopicTags(value);
};
