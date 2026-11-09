/**
 * 4.1 单条视频复盘的**共享编排层**。
 *
 * 🔴 两套后端（Vercel `api/agent/video-analysis.ts` 与本地 Express `src/index.js`）
 *    都调这里，路由只做「鉴权 + 读 body + 调这里 + 回 JSON」
 *    （HANDOFF §2.1 的优先做法：逻辑放共享层，改一次两套同时生效）。
 *
 * 这里负责五件事：
 *   1. 校验与裁剪入参（**不信任前端**）；
 *   2. 读本客户选题库的**大类/小类词典**（读不到就如实少给，不阻断整条链路）；
 *   3. 先跑一遍**纯后端实算**，拿到判定结论（这是喂给模型的输入，也是最终结论）；
 *   4. 调 Agent —— **只让它写文字、判文案结构标签**；
 *   5. Agent 失败**必须能降级**：降级后仍然返回一份「结论正确、文字待人工补充」的报告。
 *
 * ⚠️ 报告**不在这里落库**：用户要先在界面上看一眼、必要时改，
 *    再走 `/api/video-analysis-reports` 保存（与 1.3 账号规划的流程一致）。
 */

import { getContentAgentConfig } from "./contentAgent/config.js";
import { buildVideoAnalysisAgentInput, runVideoAnalysisSuggestionAgent } from "./contentAgent/reviewAgents.js";
import { buildVideoAnalysisReport } from "./videoAnalysis.js";
import { normalizeReviewPlatform } from "./reviewMetrics.js";
import { getTopicCategoryDictionaryForEmployee } from "./topicLibraryStore.js";

const asText = value => String(value ?? "").trim();

const cleanText = (value, maxLength = 500) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

/**
 * 读本客户选题库的大类/小类词典。
 *
 * 读不到**不是错误**：没有选题库时结构标签的「选题类型」就留空，
 * 3s / 标题 / 结尾钩子照样能判（它们不依赖选题库）。如实记一条 warning 即可。
 */
const loadCategoryDictionary = async ({ customerId, warnings }) => {
  if (!customerId) {
    warnings.push("没有指定客户，无法读取选题库，选题大类/小类将留空");
    return [];
  }
  try {
    const dictionary = await getTopicCategoryDictionaryForEmployee({ customerId });
    const entries = Array.isArray(dictionary?.tagDictionary) ? dictionary.tagDictionary : [];
    if (entries.length === 0) {
      warnings.push("这个客户还没有选题库，选题大类/小类将留空（可先完成 2.4 建库）");
    }
    return entries;
  } catch (error) {
    warnings.push(`读取选题库失败（${cleanText(error?.message, 120)}），选题大类/小类将留空`);
    return [];
  }
};

/**
 * 合并结构标签：**人工给的非空值优先**，Agent 只补空。
 *
 * 理由：用户手动选过的类型不该被模型覆盖掉 —— 他比模型更清楚这条视频是怎么做的。
 */
const mergeStructureTags = ({ manual = {}, agentTags = {} } = {}) => {
  const pick = (manualValue, agentValue) => (asText(manualValue) ? manualValue : agentValue);
  const merged = {
    categoryName: pick(manual.categoryName, agentTags.categoryName),
    subcategoryName: pick(manual.subcategoryName, agentTags.subcategoryName),
    goldThreeSecondsType: pick(manual.goldThreeSecondsType, agentTags.goldThreeSecondsType),
    goldThreeSecondsReason: pick(manual.goldThreeSecondsReason, agentTags.goldThreeSecondsReason),
    titleType: pick(manual.titleType, agentTags.titleType),
    titleReason: pick(manual.titleReason, agentTags.titleReason),
    endingHookType: pick(manual.endingHookType, agentTags.endingHookType),
    endingHookReason: pick(manual.endingHookReason, agentTags.endingHookReason),
  };
  // 来源如实标注：只要有一项是 Agent 补的，就算 agent 判的。
  const fromAgent = ["categoryName", "subcategoryName", "goldThreeSecondsType", "titleType", "endingHookType"]
    .some(key => !asText(manual[key]) && asText(merged[key]));
  return { ...merged, source: fromAgent ? "agent" : "manual" };
};

/**
 * 跑一次 4.1 复盘。
 *
 * @param ownerId  当前登录用户 id（写报告时用，这里只用于读词典的可选鉴权）
 * @param customerId 客户 id（必填，选题库按客户取）
 * @param body     { platform, metrics, script, video, structureTags, feedback }
 */
export const runVideoAnalysis = async ({
  customerId,
  body = {},
  logger,
  config = getContentAgentConfig(),
} = {}) => {
  const warnings = [];
  const platform = normalizeReviewPlatform(body.platform);
  const target = cleanText(customerId, 120);
  if (!target) {
    throw Object.assign(new Error("请先选择客户"), { status: 400 });
  }

  const manualTags = body.structureTags && typeof body.structureTags === "object" ? body.structureTags : {};
  const rawMetrics = body.metrics && typeof body.metrics === "object" ? body.metrics : {};
  const scriptText = asText(body.script ?? body.scriptText);
  const video = body.video && typeof body.video === "object" ? body.video : {};

  // ① 选题库词典（拿不到不阻断）
  const categoryDictionary = await loadCategoryDictionary({ customerId: target, warnings });

  // ② 先跑纯后端实算 —— 这一步产出的判定结论就是最终结论，也是喂给模型的输入。
  const baseReport = buildVideoAnalysisReport({
    platform,
    rawMetrics,
    scriptText,
    structureTags: manualTags,
    categoryDictionary,
    video,
    agentOutput: null,
    extraWarnings: warnings,
  });

  // ③ 调 Agent：只写文字 + 判结构标签。失败就降级，绝不因此让整次复盘失败。
  let agentOutput = null;
  let agentError = "";
  try {
    const input = buildVideoAnalysisAgentInput({ report: baseReport, categoryDictionary });
    const result = await runVideoAnalysisSuggestionAgent(input, config, { logger });
    // 空对象等于模型没给出任何可用内容 —— 当作失败处理，走规则兜底。
    const hasContent = result && typeof result === "object"
      && (result.structures || result.structureTags || result.summary);
    if (hasContent) agentOutput = result;
    else agentError = "Agent 没有返回任何可用内容";
  } catch (error) {
    agentError = cleanText(error?.message || error, 200);
  }

  const agentNotes = [];
  if (agentError) {
    agentNotes.push(`优化建议的 AI 分析没有跑成功（${agentError}），已退化为「只给数据结论、建议文字待人工补充」`);
  }

  // ④ 用 Agent 的输出重新组装一份最终报告（判定结论不变，只是补上文字与标签）。
  const finalReport = buildVideoAnalysisReport({
    platform,
    rawMetrics,
    scriptText,
    structureTags: mergeStructureTags({ manual: manualTags, agentTags: agentOutput?.structureTags || {} }),
    categoryDictionary,
    video,
    agentOutput,
    extraWarnings: [...warnings, ...agentNotes],
    analyzedAt: baseReport.analyzedAt,
  });

  return { report: finalReport, categoryDictionary };
};
