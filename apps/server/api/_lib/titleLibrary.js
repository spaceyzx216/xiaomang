/**
 * 标题库（2.3 标题）—— 模块 3 产出回流到员工二创的第三条链路。
 *
 * 用户口径（2026-09-24，见需求文档「2.3 标题」）：
 *
 *   1. 先建**账号标题库**：按选题库已完成的账号分类，为每个大類筛出适配的标题类型，
 *      并按匹配度给出配比；
 *   2. 新选题生成标题时，**判断原标题的标题类型**，再按该大类的配比生成 **10 条**
 *      新标题，并**按配比把 10 条分配给不同类型**；
 *   3. 每周复盘：按用户最终选中的标题类型标签调下一次的配比。
 *
 * ── 两个刻意的设计决定（都有用户确认） ──────────────────────────────
 *
 * 🔴 决定一：**标题类型就是黄金三秒那 8 个类型，不另立一套。**
 *    需求文档给的 8 个类型「好奇心、恐惧、愤怒、反差、痛点、兴趣、求知欲、欲望」
 *    与 `GOLD_THREE_SECOND_DIMENSIONS` 完全同名同义（含定义与例句）。
 *    所以这里**从那份唯一定义重新导出**，而不是抄一份新的：
 *    两套同义类型表一旦各维护一份，必然漂移（prompts.js 顶部记着同类事故：
 *    「之前两处各写一份，结果提示词里的维度集和代码里的对不上，用户直接发现了」）。
 *
 * 🔴 决定二：**标题配比直接复用 2.2 黄金三秒报告的 `categoryBreakdown`。**
 *    既然类型集合相同，那份报告里「每个大类 × 8 类型」的配比就是标题配比，
 *    不需要第三次跑分析、也不需要新报告类型。因此本模块**不新增任何
 *    Mongo 集合 / store / 分析阶段**，只做「把 2.2 的配比当成标题配比」这件事。
 *
 *    如果将来用户要求标题配比与三秒配比分开，那时再引入独立的标题分析报告；
 *    届时只需替换 `buildTitleAdaptation` 的 `report` 入参来源，下游（槽位计划、
 *    提示词片段、归一化）全部不用动 —— 这也是把它单独成文件的原因。
 *
 * ⚠️ 与 topicCreativeAdaptation.js 同一套纪律：
 *    - 配比换算一律后端实算，绝不交给模型；
 *    - 「待人工复核」（review）永远不参与配比；
 *    - 查不到配比时如实降级并标注来源，不编造、也不阻断生成。
 */

import {
  GOLD_THREE_SECOND_DIMENSIONS,
  GOLD_THREE_SECOND_TYPE_LABELS,
} from "./goldThreeSeconds.js";
import { buildCategoryAdaptation } from "./topicCreativeAdaptation.js";

/** 标题类型的判定口径（定义 + 例句 + 典型强度），与黄金三秒共用同一份。 */
export const TITLE_TYPES = GOLD_THREE_SECOND_DIMENSIONS;

/** 标题类型英文 key。 */
export const TITLE_TYPE_KEYS = GOLD_THREE_SECOND_DIMENSIONS.map(item => item.type);

/** 标题类型 → 中文标签。与黄金三秒同义，故直接复用那份表。 */
export const TITLE_TYPE_LABELS = GOLD_THREE_SECOND_TYPE_LABELS;

/** Agent 标识：写进 interfaceName 与归一化告警，便于日志定位是哪条链路。 */
export const TITLE_AGENT_NAME = "title";

/**
 * 标题二创的展示形状：把「槽位计划」渲染成前端 `parseTitleBlocks`
 * 能认的文本块。
 *
 * 🔴 格式必须与 `ContentPage.tsx` 的 `parseTitleBlocks` 严格对齐：
 *      `N. 标题正文` + `类型：/ 优势：/ 技巧：` 三行。
 *    标题这条链路的产物最终是**一个字符串**（`creative.titleText` → 工作流
 *    payload 的 `Code_list[].fields.title`），前端再从字符串里解析出候选列表；
 *    所以类型标签只能随文本一起走，不能另开一个结构化字段。
 *    「类型」一行同时写中文标签与英文 key：用户看中文，复盘按 key 归类。
 *
 * ⚠️ 原标题类型判断**必须写进每个候选块内部**，不能单独放一行表头。
 *    `parseTitleBlocks` 会把「不是块起始、又还没进入任何块」的行直接丢掉，
 *    所以表头式的 `原标题类型判断：X` 会被静默丢弃；而若它恰好落在第一个块
 *    之后，还会被当成该块的正文行吸附进去。
 *
 * @param candidates [{ index, type, typeLabel, content }]
 * @param originalType { type, typeLabel, reason } 原标题类型判断
 * @returns 形如 "1. 《标题》\n类型：好奇心（curiosity）\n优势：…" 的文本
 */
export const formatTitleCandidatesAsText = (candidates, originalType = null) => {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return "";

  const known = originalType && originalType.type && originalType.type !== "unknown";
  const originalLabel = known
    ? String(originalType.typeLabel || TITLE_TYPE_LABELS[originalType.type] || originalType.type).trim()
    : "";
  // 判断不出时如实说明，**不借用「待人工复核」**：那是选题库的人工待办队列名，
  // 借来当「判不出」会让两个概念混在一起。
  const originalLine = known
    ? `原标题类型：${originalLabel}（${originalType.type}）`
    : "原标题类型：未能判断";
  const originalReason = known && originalType.reason ? `判断依据：${originalType.reason}` : "";

  const blocks = list.map((item, position) => {
    const index = Number(item?.index) > 0 ? Number(item.index) : position + 1;
    const typeLabel = String(item?.typeLabel || TITLE_TYPE_LABELS[item?.type] || "").trim();
    const typeKey = String(item?.type || "").trim();
    const typeLine = typeLabel && typeKey ? `类型：${typeLabel}（${typeKey}）` : "类型：";
    return [
      `${index}. 《${String(item?.content || "").trim()}》`,
      typeLine,
      // 「优势」与「技巧」在这个链路里没有独立语义，但**必须保留这两行**：
      // parseTitleBlocks 靠它们承载说明，删掉会让说明并进标题正文。
      `优势：按「${typeLabel || typeKey || "未标注"}」类型生成，与该大类的标题类型配比一致`,
      "技巧：后端按大类配比实算槽位，模型只负责填文案",
      originalLine,
      originalReason,
    ].filter(Boolean).join("\n");
  });

  return blocks.join("\n\n");
};

/**
 * 标题配比来源的说明文案，给前端直接展示。
 *
 * 刻意与 `buildCategoryAdaptation` 的 note 分开写：那边说的是「三秒/结尾钩子」，
 * 这里必须说「标题」，否则用户会以为改的是三秒配比。
 */
export const describeTitleAdaptation = adaptation => {
  if (!adaptation) return "";
  const count = Array.isArray(adaptation.slots) ? adaptation.slots.length : 0;
  if (adaptation.source === 'review_memory') return adaptation.note;
  if (adaptation.source === "category") {
    return `标题库已按大类「${adaptation.categoryName}」的配比分配 ${count} 条标题。`;
  }
  if (adaptation.source === "library_global") {
    return adaptation.categoryName
      ? `标题库里没有大类「${adaptation.categoryName}」的配比记录，本次按全库通用配比生成 ${count} 条标题。`
      : `这条内容还没有库内大类标签，本次按全库通用配比生成 ${count} 条标题。`;
  }
  return "没有可用的标题库配比，本次标题沿用原来的自由创作口径。";
};

/**
 * 从标题库报告里取某个大类的标题配比。
 *
 * 复用 `topicCreativeAdaptation.buildCategoryAdaptation` 的完整语义
 * （大类命中 → category；查不到 → library_global；没有库 → none），
 * 只是把 labels 换成标题的（实际与三秒同表，这里显式写出来是为了表态：
 * 标题链路用的是标题类型表，不是"碰巧"和三秒一样）。
 *
 * 刻意做成薄封装而不是让调用方直接调：将来标题配比若要独立来源，
 * 只改这一个函数的 `report` 来源即可，`index.js` / providers 都不用动。
 */
export const buildTitleAdaptation = ({ categoryName = "", report = null, count } = {}) => (
  buildCategoryAdaptation({
    categoryName,
    report,
    labels: TITLE_TYPE_LABELS,
    ...(count === undefined ? {} : { count }),
  })
);
