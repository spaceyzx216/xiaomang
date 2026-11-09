/**
 * 复盘分析（模块 4）的 Agent 层。
 *
 * 目前只有一个 Agent：4.1 单条视频的「判结构标签 + 写优化建议」。
 *
 * 🔴 与 `publishAgents.js` 同一条纪律：
 *   - 提示词里的清单**从既有定义生成**（8 个三秒类型 / 5 个结尾钩子类型），
 *     不在这里手写第二份；
 *   - **判定结论不由模型决定** —— 后端实算的结果作为输入喂进去，
 *     模型只写「为什么 / 怎么调」；归一化在 `videoAnalysis.js` 里核对；
 *   - 失败要让调用方**能降级**，不要在这里吞掉。
 *
 * ⚠️ 这个 Agent **不落库、不做判定**：它只产出文本与标签，
 *    报告的组装永远是 `buildVideoAnalysisReport`（纯函数，可单测）。
 */

import { getContentAgentConfig } from "./config.js";
import { VIDEO_ANALYSIS_SUGGESTION_PROMPT } from "./prompts.js";
import { runJsonAgent } from "./providers.js";
import { formatThreshold } from "../reviewMetrics.js";

const asText = value => String(value ?? "").trim();

const cleanText = (value, maxLength = 2000) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

const section = (title, value, maxLength = 2000) => {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `【${title}】\n${cleanText(text, maxLength)}`;
};

/**
 * 把选题库的大类/小类词典压成给模型看的清单。
 *
 * 只给名字与核心功能：小类 id 是 `账号key::cat-1` 这种两百来字符的长串
 * （见 `topicLibraryStore.js` 的账号作用域），塞进提示词纯属浪费 token，
 * 而且模型也用不上 —— 它只需要**名字**。
 */
export const buildCategoryDictionaryText = (dictionary = []) => (Array.isArray(dictionary) ? dictionary : [])
  .filter(item => item && asText(item.name))
  .map(item => {
    const subcategories = (Array.isArray(item.subcategories) ? item.subcategories : [])
      .map(sub => asText(sub?.name)).filter(Boolean).join("、");
    const core = cleanText(item.coreFunction, 200);
    return `- ${asText(item.name)}${core ? `（${core}）` : ""}${subcategories ? `\n    小类：${subcategories}` : ""}`;
  })
  .join("\n");

/**
 * 组装 4.1 的 Agent 输入。
 *
 * 🔴 `【后端已实算的判定结果】`是**最重要的一节**：它把「哪个指标高/低于标准值、
 *    对应哪个结构、结论是什么」全部**确定性地**告诉模型。
 *    模型因此没有"自由发挥判定"的空间 —— 它只能解释与建议。
 */
export const buildVideoAnalysisAgentInput = ({ report = {}, categoryDictionary = [] } = {}) => {
  const judgments = (Array.isArray(report.judgments) ? report.judgments : []).map(item => ({
    指标: item.label,
    实测值: item.value === null || item.value === undefined ? "未提供" : item.value,
    标准线: formatThreshold(item),
    结论: item.levelLabel,
  }));

  const structures = (Array.isArray(report.structures) ? report.structures : []).map(item => ({
    结构: item.label,
    结论: item.verdictLabel,
    判定依据: item.reasons?.length ? item.reasons : ["该项数据不足，无法判定"],
  }));

  const dictionaryText = buildCategoryDictionaryText(categoryDictionary);

  return [
    section("这条视频", {
      平台: report.platformLabel,
      标题: report.video?.title || undefined,
      链接: report.video?.link || undefined,
      发布时间: report.video?.publishedAt || undefined,
    }, 600),
    section("视频文案（结构标签的判定依据）", report.script?.text || "（未提供文案）", 8000),
    section(`原始数据（${report.platformLabel}）`, {
      播放量: report.metrics?.plays ?? undefined,
      点赞: report.metrics?.likes ?? undefined,
      评论: report.metrics?.comments ?? undefined,
      转发: report.metrics?.shares ?? undefined,
      收藏: report.metrics?.bookmarks ?? undefined,
      红心: report.metrics?.recommends ?? undefined,
      关注: report.metrics?.follows ?? undefined,
      完播率: report.metrics?.completionRate ?? undefined,
      "2s跳出率": report.metrics?.bounce2sRate ?? undefined,
      "5s完播率": report.metrics?.completion5sRate ?? undefined,
      "3秒以上播放率": report.metrics?.play3sRate ?? undefined,
      平均播放时长: report.metrics?.avgPlaySeconds ?? undefined,
      视频时长: report.metrics?.durationSeconds ?? undefined,
      互动率: report.derived?.interactionRate ?? undefined,
      平均播放率: report.derived?.avgPlayRate ?? undefined,
    }, 1200),
    section("后端已实算的判定结果（结论以这里为准，你只解释原因）", { 指标判定: judgments, 四大结构: structures }, 2500),
    dictionaryText ? `【本客户的选题库大类与小类】\n${dictionaryText}` : section("本客户的选题库大类与小类", "（没有取到选题库，两类都留空字符串）", 300),
    report.feedback ? section("人工补充说明", report.feedback, 800) : "",
  ].filter(Boolean).join("\n\n");
};

/**
 * 调 Agent 写优化建议 + 判结构标签。
 *
 * 返回**模型的原始输出**（不归一化）—— 归一化统一在 `buildVideoAnalysisReport` 里做，
 * 这样「模型说了什么」与「最终报告长什么样」两件事不会散在两个地方。
 */
export const runVideoAnalysisSuggestionAgent = async (input, config = getContentAgentConfig(), options = {}) => {
  const value = await runJsonAgent({
    system: VIDEO_ANALYSIS_SUGGESTION_PROMPT,
    user: input,
    interfaceName: "deepseek:agent-video-analysis",
    normalizer: raw => raw,
  }, config, options);
  return value && typeof value === "object" ? value : {};
};
