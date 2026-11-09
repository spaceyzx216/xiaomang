/**
 * 模块 3 各子步骤**共用**的样本窗口与归类规则。
 *
 * 2.2（黄金三秒）和 2.3（结尾钩子）必须吃**同一批样本**，否则两份报告的大类配比
 * 没法互相印证。所以「取多少条」「怎么排序」「样本归到哪个大类」只在这里写一份。
 *
 * 2026-09-17：从 goldThreeSeconds.js 抽出来。当时两处各写一份的风险很实在 ——
 * 大类和配比都建立在这套口径上，两边一旦漂移，报告看起来都对但数字对不上。
 */

/**
 * 子步骤分析的样本上限。
 *
 * 2026-09-17：从 20 改成 60 —— 用户要求「不要只选前 20 条，60 条都做分析」。
 * 原因是这些子步骤的产出是**每个内容大类的配比**：只取 20 条时，样本被拆到
 * 3～5 个大类里，每个大类只剩几条，配比没有统计意义（有的类甚至一条都没有）。
 */
export const MAX_STAGE_VIDEOS = 60;

const asText = value => String(value ?? "").trim();

const asNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

const parseDateMs = value => {
  const text = asText(value);
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * 取样本窗口内的视频：点赞降序 → 发布时间降序 → 原顺序。
 *
 * `limit` 越界（0 / NaN / 超过上限）时回落到上限，**不会**把样本清空 ——
 * 调用方一个手滑不该让整份报告变空。
 */
export const selectStageVideos = (videos, limit = MAX_STAGE_VIDEOS) => (
  (Array.isArray(videos) ? videos : [])
    .map((video, index) => ({ video, index }))
    .sort((left, right) => {
      const likesDiff = asNumber(right.video?.stats?.likes) - asNumber(left.video?.stats?.likes);
      if (likesDiff !== 0) return likesDiff;
      return parseDateMs(right.video?.publishDate) - parseDateMs(left.video?.publishDate) || left.index - right.index;
    })
    .slice(0, Math.max(1, Math.min(Number(limit) || MAX_STAGE_VIDEOS, MAX_STAGE_VIDEOS)))
    .map(item => item.video)
);

/** 样本属于哪个内容大类；分类报告覆盖不到的落到「待人工复核」。 */
export const categoryForVideo = (videoId, categories, reviewCategoryName) => {
  for (const category of Array.isArray(categories) ? categories : []) {
    if (category.topics?.some(topic => topic.id === videoId)) return category.name;
  }
  return reviewCategoryName;
};
