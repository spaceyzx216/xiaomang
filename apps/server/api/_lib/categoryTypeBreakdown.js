/**
 * 「按内容大类的类型配比」—— 模块 3 各子步骤**共用**的计算。
 *
 * 2.2 黄金三秒和 2.3 结尾钩子产出的是同一个形状：
 *
 *     账号 → 大类（核心功能 / 判断关键词）→ [类型, 配比, 原因]
 *
 * 这份计算里有几条**踩过坑、必须守住**的规则，所以只写一份、两边共用：
 *
 *   1. **配比由后端按条数统计，绝不采用模型填的百分比。**
 *      曾经让模型自己编每个大类的配比，模型不给时还会把全局 top3 原样塞进每一个大类 ——
 *      结果所有大类的类型和原因都一模一样（用户反馈「逻辑不太对」）。
 *   2. **每个大类的配比合计恰好 100**（最大余额法）。旧实现末位用「100 减去其余项」，
 *      与已归一化的其余项混算，实测出过 33+33+98 = 164。
 *   3. **「待人工复核」永远不参与配比** —— 它是人工待办队列，不是内容大类。
 *   4. **模型没给原因就留空字符串**，由前端如实说明「待人工补充」，
 *      不许编一句「出现频率较高」糊过去。
 *   5. 大类清单和顺序取自上一步的分类报告，保证两个子步骤对得上。
 */

const asText = value => String(value ?? "").trim();

const cleanText = (value, maxLength = 900) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

/** 占比：一位小数。 */
const ratio = (count, total) => (total > 0 ? Math.round((count / total) * 1000) / 10 : 0);

/**
 * 按最大余额法把任意权重分配成合计**恰好 100** 的百分比。
 *
 * 之前末位用的是「100 减去其余项的原始 ratio」，而其余项已经被归一化成百分比了，
 * 两套口径混算会算出远超 100 的合计（模型返回 1/1/1 时实测 33+33+98 = 164）。
 */
export const apportionRatios = items => {
  const total = items.reduce((sum, item) => sum + item.ratio, 0);
  if (!(total > 0)) return [];
  const quotas = items.map(item => (item.ratio / total) * 100);
  const shares = quotas.map(value => Math.floor(value));
  let remainder = 100 - shares.reduce((sum, value) => sum + value, 0);
  const byFraction = quotas
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const { index } of byFraction) {
    if (remainder <= 0) break;
    shares[index] += 1;
    remainder -= 1;
  }
  return items.map((item, index) => ({ ...item, ratio: shares[index] }));
};

/**
 * 按大类统计类型分布。
 *
 * @param items            每条样本：{ categoryName, type }（type 已归一化，"review" 表示待复核）
 * @param inputCategories  分类报告的大类：{ name, coreFunction, keywords }
 * @param categoryReasons  模型只提供「大类 + 类型 → 原因」
 * @param typeLabels       { type: 中文标签 }
 * @param normalizeType    类型归一化函数
 * @param isReviewCategory (category) => boolean
 */
export const buildCategoryTypeBreakdown = ({
  items = [],
  inputCategories = [],
  categoryReasons = [],
  typeLabels = {},
  normalizeType = value => asText(value) || "review",
  isReviewCategory = () => false,
  reviewCategoryName = "待人工复核",
} = {}) => {
  const order = [];
  const meta = new Map();
  for (const category of Array.isArray(inputCategories) ? inputCategories : []) {
    const name = asText(category?.name);
    if (!name || meta.has(name)) continue;
    order.push(name);
    meta.set(name, {
      coreFunction: cleanText(category?.coreFunction, 500),
      keywords: Array.isArray(category?.keywords)
        ? category.keywords.map(item => cleanText(item, 80)).filter(Boolean).slice(0, 12)
        : [],
    });
  }
  // 样本里出现、但不在分类报告大类清单里的（理论上不该有）：兜底保留，不让样本凭空消失。
  // **但「待人工复核」是人工待办队列，不是内容大类** —— 绝不能让它变成一档策略分类。
  for (const item of items) {
    const name = asText(item?.categoryName);
    if (!name || isReviewCategory({ name }) || meta.has(name)) continue;
    order.push(name);
    meta.set(name, { coreFunction: "", keywords: [] });
  }

  // 模型只提供「大类 + 类型 → 原因」。类型走归一化，认不出的直接丢。
  const reasons = new Map();
  for (const entry of Array.isArray(categoryReasons) ? categoryReasons : []) {
    const categoryName = asText(entry?.categoryName || entry?.category_name || entry?.name);
    if (!categoryName) continue;
    const bucket = reasons.get(categoryName) || new Map();
    for (const item of Array.isArray(entry?.reasons) ? entry.reasons : []) {
      const type = normalizeType(item?.type || item?.name);
      const reason = cleanText(item?.reason || item?.explanation || "", 420);
      if (type !== "review" && reason) bucket.set(type, reason);
    }
    reasons.set(categoryName, bucket);
  }

  return order.map(categoryName => {
    const bucketItems = items.filter(item => (asText(item.categoryName) || reviewCategoryName) === categoryName);
    const counts = new Map();
    let reviewCount = 0;
    for (const item of bucketItems) {
      if (item.type === "review") {
        reviewCount += 1;
        continue;
      }
      counts.set(item.type, (counts.get(item.type) || 0) + 1);
    }
    // 用条数当权重过一遍最大余额法，保证每个大类的配比合计恰好 100。
    const dimensions = apportionRatios([...counts.entries()].map(([type, count]) => ({ type, count, ratio: count })))
      .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type))
      .map(item => ({
        type: item.type,
        typeLabel: typeLabels[item.type],
        count: item.count,
        ratio: item.ratio,
        // 模型没给原因就留空，由前端如实说明 —— 不编一句「出现频率较高」糊过去。
        reason: reasons.get(categoryName)?.get(item.type) || "",
      }));

    return {
      categoryName,
      count: bucketItems.length,
      percentage: ratio(bucketItems.length, items.length),
      coreFunction: meta.get(categoryName).coreFunction,
      keywords: meta.get(categoryName).keywords,
      dimensions,
      reviewCount,
    };
  });
};

/** 全局类型分布（含计 0 的维度），用于「8 个维度分布」那类展示。 */
export const buildTypeDistribution = ({ items = [], allTypes = [], typeLabels = {} } = {}) => {
  const counts = new Map();
  for (const item of items) counts.set(item.type, (counts.get(item.type) || 0) + 1);
  return allTypes.map(type => ({
    type,
    typeLabel: typeLabels[type],
    count: counts.get(type) || 0,
    percentage: ratio(counts.get(type) || 0, items.length),
  }));
};
