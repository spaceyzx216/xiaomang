/**
 * 三秒 / 结尾钩子的「按选题库大类配比」二创适配 —— 模块 3 产出（选题库）回流到员工二创。
 *
 * 用户口径（2026-09-21 第六轮，见 HANDOFF §0.2）：
 *
 *   1. 先判断**原文案**的三秒类型 / 结尾钩子类型；
 *   2. 再按这篇内容所属**大类**在选题库里适配的类型配比，生成 **10 条**新选项，
 *      并**按配比把 10 条分配给不同类型**。
 *
 *   例：某篇属于「政策解读与环境洞察」大类，该大类适配的黄金三秒是
 *       求知欲 40% / 恐惧 30% / 愤怒 20% / 反差 10%
 *       → 10 条候选 = 求知欲 4 条 + 恐惧 3 条 + 愤怒 2 条 + 反差 1 条。
 *
 * 🔴 这个文件里**没有任何模型调用、也没有数据库调用**，只做两件可单测的事：
 *    - `planCreativeSlots`：把配比换算成「第 i 条应该是哪个类型」的槽位计划；
 *    - `buildCategoryAdaptation`：把选题库里某个大类的配比整理成 Agent 输入片段。
 *
 * ⚠️ 三条踩过坑、必须守住的纪律（HANDOFF §6.3⑬ 是同一个道理）：
 *
 *   a. **配比换算一律后端实算，绝不交给模型。**
 *      曾经让模型自己编每个大类的配比，模型不给时就把全局 top3 塞进每个大类 ——
 *      结果所有大类一模一样。这里连「10 条怎么分」都由 `apportionRatios` 算好，
 *      提示词里直接给「第 i 条 = 某类型」，模型只负责往里填文案。
 *
 *   b. **「待人工复核」（review）永远不参与配比。**
 *      它是人工待办队列，不是内容类型。它一旦混进来，用户会拿到一批
 *      「类型名叫待人工复核」的候选，等于把系统的待办当成创作方向。
 *
 *   c. **查不到配比时如实降级，不编造、也不报错挡住生成。**
 *      没有选题库 / 这条视频没有大类标签 / 该大类在库里不存在 —— 三种情况都回退到
 *      **库级全局配比**（`typeDistribution` 去掉 review 后重新归一化），
 *      并把 `source` 如实标成 `library_global` 或 `none`，让前端能告诉用户
 *      「这次是按全局配比生成的」，而不是假装用的是大类配比。
 */

import { apportionRatios } from "./categoryTypeBreakdown.js";
import { GOLD_THREE_SECOND_TYPE_LABELS } from "./goldThreeSeconds.js";
import { ENDING_HOOK_TYPE_LABELS } from "./endingHooks.js";

/** 每种创作方向生成的候选条数。用户明确要求 10 条。 */
export const CREATIVE_CANDIDATE_COUNT = 10;

/** 「待人工复核」不是内容类型，永远不进配比。 */
export const REVIEW_TYPE = "review";

/** 配比来源：用得是这条内容所属大类的配比 / 退回库级全局配比 / 没有库。 */
export const ADAPTATION_SOURCE = {
  category: "category",
  libraryGlobal: "library_global",
  none: "none",
};

const asText = value => String(value ?? "").trim();

const cleanText = (value, maxLength = 900) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

const asNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
};

/**
 * 把一组配比换算成「恰好 `count` 条」的槽位计划。
 *
 * 用户口径：**按配比把 10 条分配给不同类型**。所以这里做两步：
 *   1. 用 `apportionRatios`（项目里已有的最大余额法）把权重换算成**合计恰好 count** 的条数
 *      —— 和 2.2/2.3 报告里「每个大类配比合计恰好 100」是同一条规则，不引第二套算法；
 *   2. 展开成有序槽位，**按 count 降序**排列（占比高的类型先出，用户先看到的候选
 *      就是该大类最主流的类型）。
 *
 * ⚠️ 边界：可用类型数 > count 时（例如 8 个类型抢 10 条、但只有 3 个类型有占比），
 * 最大余额法可能给 `count` 为 0 的类型也分到 0 条 —— 那些类型不会出现在结果里。
 * 这是对的：0 条就是「这次不生成这个方向」。
 *
 * @param dimensions [{ type, count?, ratio }]，ratio 是该类型在本大类里的百分比
 * @param count      要生成的总条数
 * @returns [{ type, count }]，合计恰好 count；合计不足 count 时按现有顺序循环补满
 */
export const planCreativeSlotCounts = (dimensions, count = CREATIVE_CANDIDATE_COUNT) => {
  const total = Math.max(1, Math.floor(asNumber(count) || CREATIVE_CANDIDATE_COUNT));
  const usable = (Array.isArray(dimensions) ? dimensions : [])
    .map(item => ({
      type: asText(item?.type),
      count: asNumber(item?.count) || asNumber(item?.ratio),
    }))
    .filter(item => item.type && item.type !== REVIEW_TYPE && item.count > 0)
    // 🔴 字段名必须是 `ratio`：`apportionRatios` 读的是 `item.ratio`（见 categoryTypeBreakdown.js）。
    //    第一版传的是 `weight`，它读到 `undefined` → `total` 变 `NaN` → 判定「合计为 0」
    //    直接返回空数组，症状是**配比计划静默为空**（不报错，只是永远生成不出 10 条）。
    //    这与既有调用方 `{ type, count, ratio: count }` 的写法一致：权重 = 条数。
    .map(item => ({ ...item, ratio: item.count }));

  if (usable.length === 0) return [];

  // ⚠️ `apportionRatios` 返回 `{ ...item, ratio }`，份额写在 `ratio` 字段里。
  //    按条数当权重进来，得到的就是该类型的**占比百分数**（合计恰好 100）。
  const shares = apportionRatios(usable)
    .map((item, index) => ({ type: usable[index].type, share: asNumber(item.ratio) }));
  const shareSum = shares.reduce((sum, item) => sum + item.share, 0);
  if (shareSum <= 0) return [];

  // 占比 → 条数。用户口径：**按配比把 10 条分配给不同类型**。
  // 用最大余额法把不足一条的零头也分掉，保证合计恰好 = total 且不被系统性抹平。
  const quotas = shares.map(item => (item.share / shareSum) * total);
  const allocated = quotas.map(value => Math.floor(value));
  let remainder = total - allocated.reduce((sum, value) => sum + value, 0);
  const byFraction = quotas
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const { index } of byFraction) {
    if (remainder <= 0) break;
    allocated[index] += 1;
    remainder -= 1;
  }
  // 零头还没分完（份额是整数时会发生）→ 从占比最高的类型起补，保证「说好 10 条就是 10 条」。
  let cursor = 0;
  while (remainder > 0) {
    allocated[cursor % allocated.length] += 1;
    remainder -= 1;
    cursor += 1;
  }

  return shares
    .map((item, index) => ({ type: item.type, count: allocated[index], share: item.share }))
    // 占比高的类型排前面；占比相同用类型名稳定排序（不依赖输入顺序，避免槽位抖动）。
    .filter(item => item.count > 0)
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
};

/**
 * 把槽位条数展开成有序的「第 i 条 = 某类型」计划。
 *
 * @returns [{ index, type }]，index 从 1 开始（提示词里直接写「第 3 条」，模型好对齐）
 */
export const planCreativeSlots = (dimensions, count = CREATIVE_CANDIDATE_COUNT) => {
  const counts = planCreativeSlotCounts(dimensions, count);
  const slots = [];
  for (const item of counts) {
    for (let i = 0; i < item.count; i += 1) {
      slots.push({ index: slots.length + 1, type: item.type });
    }
  }
  return slots;
};

/** 类型 → 中文标签。三秒与结尾钩子各一套，撞名时以调用方指定的为准。 */
const labelFor = (type, labels) => asText(labels?.[type]) || asText(type);

/**
 * 把一份报告里的 `categoryBreakdown` 整理成「大类名 → 配比」的查表。
 *
 * ⚠️ 只用报告正文里的 `dimensions`，**不看顶层 `categories`**（那只是分类树的兼容别名，
 * 里面没有配比）。取不到就是空表，调用方走全局兜底。
 */
export const indexBreakdownByCategory = report => {
  const map = new Map();
  const breakdown = Array.isArray(report?.categoryBreakdown) ? report.categoryBreakdown : [];
  for (const category of breakdown) {
    const name = asText(category?.categoryName);
    if (!name) continue;
    const dimensions = (Array.isArray(category?.dimensions) ? category.dimensions : [])
      .map(item => ({
        type: asText(item?.type),
        count: asNumber(item?.count),
        ratio: asNumber(item?.ratio),
      }))
      .filter(item => item.type && item.type !== REVIEW_TYPE);
    if (dimensions.length === 0) continue;
    map.set(name, dimensions);
  }
  return map;
};

/**
 * 库级全局配比：把 `typeDistribution` 去掉 review 后当权重。
 *
 * 这是「查不到大类配比」时的**如实降级**，不是默认口径。
 */
export const globalDimensions = report => (
  (Array.isArray(report?.typeDistribution) ? report.typeDistribution : [])
    .map(item => ({
      type: asText(item?.type),
      count: asNumber(item?.count),
      ratio: asNumber(item?.percentage),
    }))
    .filter(item => item.type && item.type !== REVIEW_TYPE && (item.count > 0 || item.ratio > 0))
);

/**
 * 构造某个大类的适配输入（Agent 直接用）。
 *
 * @param categoryName  这条内容在库里被判定的大类名（可能为空）
 * @param report        选题库里那份 2.2 / 2.3 报告正文
 * @param labels        类型中文标签表
 * @param count         候选条数
 * @returns {
 *   source, categoryName, matchedCategory, slots: [{index,type,typeLabel}],
 *   counts: [{type,typeLabel,count,ratio}], note
 * }
 */
export const buildCategoryAdaptation = ({
  categoryName = "",
  report = null,
  labels = {},
  count = CREATIVE_CANDIDATE_COUNT,
} = {}) => {
  const target = cleanText(categoryName, 120);
  const byCategory = indexBreakdownByCategory(report);
  const matched = target ? byCategory.get(target) || null : null;
  const source = matched
    ? ADAPTATION_SOURCE.category
    : (byCategory.size > 0 || globalDimensions(report).length > 0
      ? ADAPTATION_SOURCE.libraryGlobal
      : ADAPTATION_SOURCE.none);

  const dimensions = matched || globalDimensions(report);
  const slots = planCreativeSlots(dimensions, count).map(slot => ({
    ...slot,
    typeLabel: labelFor(slot.type, labels),
  }));

  // ratio 只是给提示词当上下文（让模型知道哪个方向是主流），**条数才是权威**。
  const ratioByType = new Map(dimensions.map(item => [item.type, item.ratio]));
  const counts = [];
  for (const slot of slots) {
    const existing = counts.find(item => item.type === slot.type);
    if (existing) existing.count += 1;
    else counts.push({ type: slot.type, typeLabel: slot.typeLabel, count: 1, ratio: ratioByType.get(slot.type) || 0 });
  }

  const note = source === ADAPTATION_SOURCE.category
    ? `已按大类「${target}」的适配配比生成 ${slots.length} 条新选项。`
    : source === ADAPTATION_SOURCE.libraryGlobal
      ? (target
        ? `选题库里没有大类「${target}」的配比记录，本次按全库通用配比生成 ${slots.length} 条，供人工复核。`
        : `这条内容还没有库内大类标签，本次按全库通用配比生成 ${slots.length} 条，供人工复核。`)
      : "没有可用的选题库配比，本次不生成按配比分配的新选项，只保留原有的提取与二创结果。";

  return {
    source,
    categoryName: target,
    matchedCategory: matched ? target : "",
    slots,
    counts,
    note,
  };
};

/**
 * 把适配计划渲染成提示词里的一段**确定性输入**。
 *
 * 刻意把「第 i 条必须是某类型」逐条写出来，而不是只说配比 —— 模型对着配比自己分配时，
 * 实测会把 10 条全写成同一种类型（占比最高的那个），或者干脆不给够 10 条。
 */
export const formatAdaptationForPrompt = adaptation => {
  if (!adaptation || adaptation.slots.length === 0) return "";
  const lines = [
    `【本内容所属大类】${adaptation.categoryName || "（没有判定出大类）"}`,
    `【配比来源】${
      adaptation.source === ADAPTATION_SOURCE.category
        ? "该大类的历史适配配比（来自选题库）"
        : adaptation.source === 'review_memory'
          ? '该大类由项目经理确认的周度复盘配比（优先于对标账号统计）'
        : "全库通用配比（该大类没有配比记录，属于降级口径）"
    }`,
    "【本大类的类型配比（后端实算，不要改动）】",
    ...adaptation.counts.map(item => `- ${item.typeLabel}：${item.ratio}%（本次分配 ${item.count} 条）`),
    `【必须生成的 ${adaptation.slots.length} 条，逐条指定类型（顺序不要调换）】`,
    ...adaptation.slots.map(slot => `第 ${slot.index} 条 → ${slot.typeLabel}（${slot.type}）`),
  ];
  if (adaptation.source === 'review_memory' && adaptation.reviewExperience) {
    const experience = adaptation.reviewExperience;
    const notes = cleanText(experience.notes, 2000);
    const summary = cleanText(experience.summary, 3000);
    const actions = (Array.isArray(experience.actions) ? experience.actions : []).map(a => cleanText(a, 1000)).filter(Boolean).slice(0, 12);
    if (notes || summary || actions.length) lines.push(
      '【经理确认的账号复盘经验】作为文案优化参考；遵守上面的候选条数与类型，用本条内容的事实落实建议。',
      JSON.stringify({ notes, summary, actions }),
    );
  }
  return lines.join("\n");
};
