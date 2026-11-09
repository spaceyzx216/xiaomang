const MAX_BENCHMARK_VIDEOS = 60;

// 「待人工复核」是人工待办队列，不是真实内容主题。分类阶段用它兜住大类覆盖不到的样本，
// 后续阶段（黄金三秒配比、账号定位）必须能把它和真实内容大类区分开，所以在这里统一导出，
// 避免各处各写一份中文字面量导致漂移。
export const REVIEW_CATEGORY_ID = "category-review";
export const REVIEW_CATEGORY_NAME = "待人工复核";

const CONTENT_STYLE_LABELS = {
  spoken: "口播类选题",
  drama: "演绎类选题",
};

const PLATFORM_LABELS = {
  douyin: "抖音",
  tiktok: "TikTok",
};

const asText = (value, fallback = "") => String(value ?? fallback).trim();

const asNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
};

const asList = value => {
  if (Array.isArray(value)) return value.map(item => asText(item)).filter(Boolean);
  const text = asText(value);
  return text ? text.split(/[、,，;；\n]+/).map(item => item.trim()).filter(Boolean) : [];
};

const cleanText = (value, maxLength = 900) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

const normalizeContentStyle = value => {
  const normalized = asText(value).toLowerCase();
  return normalized === "drama" || normalized === "演绎" || normalized === "演绎类" ? "drama" : "spoken";
};

const normalizePlatform = value => asText(value).toLowerCase() === "tiktok" ? "tiktok" : "douyin";

export const normalizeBenchmarkVideos = (value, options = {}) => {
  const list = Array.isArray(value) ? value : [];
  const usable = [];

  // 先判定「是不是一条真实作品」，再计入 60 条窗口。
  // 反向做法（先 slice 再 filter）有两个后果：一条空壳会把第 60 条真实作品挤出窗口；
  // 而兜底标题「未命名视频 N」又让 filter 恒为真，空壳就被洗成可分析作品送进模型。
  for (const item of list) {
    const source = item && typeof item === "object" ? item : {};
    const rawTitle = cleanText(source.title || source.desc || source.description || "", 240);
    const link = asText(source.link || source.shareUrl || source.share_url);
    if (!rawTitle && !link) continue;
    usable.push({ source, rawTitle, link });
    if (usable.length >= MAX_BENCHMARK_VIDEOS) break;
  }

  return usable.map(({ source, rawTitle, link }, index) => {
    const platform = normalizePlatform(options.platform || source.platform);
    const id = asText(source.id || source.videoId || source.aweme_id || source.awemeId || `benchmark-${index + 1}`);
    const stats = source.stats && typeof source.stats === "object" ? source.stats : {};

    return {
      id,
      // 兜底标题只用于展示，绝不参与「是否可分析」的判定。
      title: rawTitle || `未命名视频 ${index + 1}`,
      link,
      authorName: cleanText(
        source.authorName || source.nickname || (typeof source.author === "string" ? source.author : source.author?.nickname) || "未知作者",
        120,
      ),
      publishDate: cleanText(source.publishDate || source.createTime || "", 40),
      sourceText: cleanText(source.sourceText || source.script || rawTitle || "", 900),
      coverUrl: asText(source.coverUrl || source.cover || ""),
      stats: {
        likes: asNumber(stats.likes ?? source.likes ?? source.likeCount ?? source.digg_count),
        comments: asNumber(stats.comments ?? source.comments ?? source.commentCount ?? source.comment_count),
        shares: asNumber(stats.shares ?? source.shares ?? source.shareCount ?? source.share_count),
        bookmarks: asNumber(stats.bookmarks ?? source.bookmarks ?? source.bookmarkCount ?? source.collect_count),
      },
      platform,
    };
  });
};

const referenceId = reference => {
  if (typeof reference === "string" || typeof reference === "number") return asText(reference);
  if (!reference || typeof reference !== "object") return "";
  return asText(reference.videoId || reference.id || reference.awemeId || reference.aweme_id || reference.title);
};

const referenceTitle = reference => {
  if (!reference || typeof reference !== "object") return "";
  return asText(reference.title || reference.videoTitle || reference.name);
};

const findVideo = (reference, videos, byId, byTitle) => {
  const id = referenceId(reference);
  if (id && byId.has(id)) return byId.get(id);
  const title = referenceTitle(reference) || (typeof reference === "string" ? asText(reference) : "");
  if (title && byTitle.has(title)) return byTitle.get(title);
  return null;
};

const collectReferences = value => {
  if (!value || typeof value !== "object") return [];
  const candidates = [value.videoIds, value.video_ids, value.topicIds, value.topic_ids, value.videos, value.topics, value.items];
  // 取第一个「非空数组」，而不是第一个「是数组」的键：模型完全可能同时返回
  // videoIds: [] 和 topics: [...]，此时空数组会把整个大类清空，该类视频全部掉进
  // 「待人工复核」。
  return candidates.find(item => Array.isArray(item) && item.length > 0) || [];
};

const categoryReferences = category => {
  const direct = collectReferences(category);
  if (direct.length > 0) return direct;
  return [];
};

const summarizeVideoIds = category => {
  const refs = categoryReferences(category);
  return refs.map(referenceId).filter(Boolean);
};

const toPercent = (count, total) => total > 0 ? Math.round((count / total) * 1000) / 10 : 0;

const defaultSummary = (contentStyle, accountName, count) => {
  const style = CONTENT_STYLE_LABELS[contentStyle] || CONTENT_STYLE_LABELS.spoken;
  return `${accountName || "该对标账号"}共整理 ${count} 条${style}作品，分类结果需要结合账号定位进行人工确认。`;
};

const buildCategory = ({ raw, name, topics, index, total }) => {
  const category = raw && typeof raw === "object" ? raw : {};
  const categoryName = cleanText(category.name || category.categoryName || name || `主题大类 ${index + 1}`, 100);
  const coreFunction = cleanText(
    category.coreFunction || category.core_function || category.coreSummary || category.description || "待补充核心作用",
    500,
  );
  const keywords = asList(category.keywords || category.keyWords || category.key_phrases)
    .slice(0, 12)
    // 条数限制之外还要限单条长度，否则模型返回的超长关键词会原样落库。
    .map(keyword => cleanText(keyword, 40))
    .filter(Boolean);
  const subcategories = Array.isArray(category.subcategories) ? category.subcategories : [];

  // 提示词约定「每一条视频必须且只能归入一个小类」。按引用顺序去重，
  // 避免同一视频被多个小类（或同一小类内重复引用）累加计数，把大类占比顶到 100% 以上。
  const claimedTopicIds = new Set();
  const normalizedSubs = subcategories.map((rawSub, subIndex) => {
    const sub = rawSub && typeof rawSub === "object" ? rawSub : {};
    const subName = cleanText(sub.name || sub.subcategoryName || `主题小类 ${subIndex + 1}`, 100);
    const subRefs = collectReferences(sub);
    const subTopics = subRefs
      .map(reference => topics.find(item => item.id === referenceId(reference) || item.title === referenceTitle(reference)))
      .filter(Boolean)
      .filter(item => {
        if (claimedTopicIds.has(item.id)) return false;
        claimedTopicIds.add(item.id);
        return true;
      });
    return {
      id: `${categoryName}-${subIndex + 1}`,
      name: subName,
      description: cleanText(sub.description || sub.coreFunction || sub.scenario || "", 320),
      topics: subTopics,
    };
  }).filter(sub => sub.topics.length > 0);

  const assigned = new Set(normalizedSubs.flatMap(sub => sub.topics.map(topic => topic.id)));
  const directTopics = topics.filter(topic => summarizeVideoIds(category).includes(topic.id) && !assigned.has(topic.id));
  if (directTopics.length > 0) {
    normalizedSubs.push({
      id: `${categoryName}-direct`,
      name: "其他相关选题",
      description: "模型未进一步拆分的小类，建议人工确认后归档。",
      topics: directTopics,
    });
  }

  const allTopics = normalizedSubs.flatMap(sub => sub.topics);
  return {
    id: `category-${index + 1}`,
    name: categoryName,
    count: allTopics.length,
    percentage: toPercent(allTopics.length, total),
    coreFunction,
    keywords,
    subcategories: normalizedSubs,
    topics: allTopics,
  };
};

const buildReviewCategory = (topics, total, contentStyle) => {
  if (topics.length === 0) return null;
  return {
    id: REVIEW_CATEGORY_ID,
    name: REVIEW_CATEGORY_NAME,
    count: topics.length,
    percentage: toPercent(topics.length, total),
    coreFunction: contentStyle === "drama"
      ? "当前素材不足以稳定判断场景、主角身份或演绎人物数量，避免自动归错。"
      : "当前标题或发布文案缺少足够重复词句，建议结合完整脚本人工确认主题归属。",
    keywords: ["低置信度", "人工确认"],
    subcategories: [{
      id: "subcategory-review",
      name: "需要人工确认",
      description: "这部分作品保留在报告中，不做黑盒排除。",
      topics,
    }],
    topics,
  };
};

export const normalizeBenchmarkAnalysis = ({
  contentStyle: rawContentStyle,
  platform: rawPlatform,
  accountUrl = "",
  accountName = "",
  videos: rawVideos = [],
  agentOutput = {},
  analysisSource = "agent",
  warnings = [],
  fetchMode: rawFetchMode = "latest",
  // 账号资料（简介 / 粉丝数）。由前端从 TikHub 抓取结果里提出来传进来 ——
  // 它是模块 1「对标账号分析」做商业定位的唯一直接依据，以前被丢掉了。
  // 与其它输入一样**不信任前端**：这里再清洗一次长度与数值（§6.3⑪）。
  accountProfile = {},
} = {}) => {
  const contentStyle = normalizeContentStyle(rawContentStyle);
  const platform = normalizePlatform(rawPlatform);
  const videos = normalizeBenchmarkVideos(rawVideos, { platform });
  const total = videos.length;
  const fetchMode = asText(rawFetchMode).toLowerCase() === "recent" ? "recent" : "latest";
  const byId = new Map(videos.map(video => [video.id, video]));
  const byTitle = new Map(videos.map(video => [video.title, video]));
  const rawCategories = Array.isArray(agentOutput?.categories)
    ? agentOutput.categories
    : Array.isArray(agentOutput?.data?.categories) ? agentOutput.data.categories : [];
  const assigned = new Set();
  const categories = [];

  rawCategories.forEach((rawCategory, index) => {
    const rawSubcategories = Array.isArray(rawCategory?.subcategories) ? rawCategory.subcategories : [];
    const categoryRefs = categoryReferences(rawCategory);
    const categoryTopics = categoryRefs
      .map(reference => findVideo(reference, videos, byId, byTitle))
      .filter(Boolean)
      .filter(video => !assigned.has(video.id));
    categoryTopics.forEach(video => assigned.add(video.id));

    const preparedSubcategories = rawSubcategories.map(rawSub => ({
      ...rawSub,
      videoIds: collectReferences(rawSub),
    }));
    const categoryWithRefs = {
      ...rawCategory,
      subcategories: preparedSubcategories,
      videoIds: categoryTopics.map(video => video.id),
    };
    const categoryTopicsFromSubs = preparedSubcategories
      .flatMap(sub => collectReferences(sub))
      .map(reference => findVideo(reference, videos, byId, byTitle))
      .filter(Boolean)
      .filter(video => !assigned.has(video.id));
    categoryTopicsFromSubs.forEach(video => assigned.add(video.id));
    categoryWithRefs.videoIds = [...categoryTopics.map(video => video.id), ...categoryTopicsFromSubs.map(video => video.id)];

    const normalized = buildCategory({
      raw: categoryWithRefs,
      name: rawCategory?.name,
      topics: videos.filter(video => categoryWithRefs.videoIds.includes(video.id)),
      index,
      total,
    });
    // buildCategory only knows about subcategory references. If the model put the
    // item directly on the category, preserve it in a reviewable bucket inside it.
    const represented = new Set(normalized.topics.map(topic => topic.id));
    const direct = categoryTopics.filter(topic => !represented.has(topic.id));
    if (direct.length > 0) {
      normalized.subcategories.push({
        id: `${normalized.id}-direct`,
        name: "其他相关选题",
        description: "模型只判断到大类，具体小类待人工确认。",
        topics: direct,
      });
      normalized.topics.push(...direct);
      normalized.count = normalized.topics.length;
      normalized.percentage = toPercent(normalized.count, total);
    }
    normalized.topics.forEach(topic => assigned.add(topic.id));
    if (normalized.count > 0) categories.push(normalized);
  });

  const unassigned = videos.filter(video => !assigned.has(video.id));
  const reviewCategory = buildReviewCategory(unassigned, total, contentStyle);
  if (reviewCategory) categories.push(reviewCategory);

  return {
    version: "1.0",
    reportType: "benchmark_classification",
    contentStyle,
    contentStyleLabel: CONTENT_STYLE_LABELS[contentStyle],
    account: {
      name: cleanText(accountName || agentOutput?.accountName || "未识别账号", 120),
      url: asText(accountUrl),
      platform,
      platformLabel: PLATFORM_LABELS[platform],
      // 空串表示「没取到」，不是「这个账号没有简介」。1.2 会据此把商业定位
      // 如实标成「待人工补充」，所以这里不要塞任何兜底文案。
      signature: cleanText(accountProfile?.signature, 1000),
      followerCount: asNumber(accountProfile?.followerCount),
      // 抖音 sec_user_id：模块 1「用户画像」拉真实粉丝画像分布要用。
      // 旧报告没有这个字段 —— 那时 1.2 会如实提示「无法获取粉丝画像」，不静默失败。
      secUserId: cleanText(accountProfile?.secUserId, 120),
    },
    analyzedCount: total,
    fetchMode,
    sampleWindow: fetchMode === "latest" ? "最新作品（最多 60 条）" : "时间窗口作品",
    summary: cleanText(agentOutput?.accountSummary || agentOutput?.summary || agentOutput?.overallSummary, 800)
      || defaultSummary(contentStyle, accountName, total),
    methodology: contentStyle === "drama"
      ? "按剧情场景、主角身份、演绎人物数量识别剧情类型，再拆分为内容主题大类与小类。"
      : "按标题重复关键词、脚本或发布文案中的重复词句识别主题功能，再拆分为内容主题大类与小类。",
    categories: slimCategories(categories),
    videos,
    analysisSource,
    warnings: Array.isArray(warnings) ? warnings : [],
    analyzedAt: new Date().toISOString(),
  };
};

/**
 * 落库前把大类/小类下的选题压成引用 `{ id, title }`。
 *
 * 完整视频数据统一放在 report.videos。之前大类和小类下又各存了一份完整对象
 * （含 sourceText / stats / link），实测单份报告因此从 62 KB 涨到 146 KB。
 * 下游按 id 回查 report.videos 即可，第二步判断视频归属哪个大类也只用得到 id。
 */
const toTopicRef = video => ({ id: asText(video?.id), title: cleanText(video?.title, 240) });

const slimSubcategory = subcategory => ({
  ...subcategory,
  topics: (Array.isArray(subcategory?.topics) ? subcategory.topics : []).map(toTopicRef),
});

const slimCategories = categories => (Array.isArray(categories) ? categories : []).map(category => ({
  ...category,
  topics: (Array.isArray(category?.topics) ? category.topics : []).map(toTopicRef),
  subcategories: (Array.isArray(category?.subcategories) ? category.subcategories : []).map(slimSubcategory),
}));

const HEURISTIC_RULES = {
  spoken: [
    {
      name: "问题解决与方法建议",
      coreFunction: "通过步骤、清单与方法建议解决用户的具体问题，帮助账号建立实用价值和专业信任。",
      keywords: ["方法", "步骤", "清单", "怎么", "技巧", "建议", "教程", "解决"],
      subcategories: [
        ["步骤清单与操作方法", ["步骤", "清单", "流程", "怎么"]],
        ["技巧建议与经验分享", ["技巧", "建议", "经验", "方法"]],
        ["教程与场景解决方案", ["教程", "解决", "场景", "操作"]],
      ],
    },
    {
      name: "问题、风险与边界提示",
      coreFunction: "通过拆解常见问题、风险和边界，帮助用户识别误区、降低试错成本并形成清晰判断。",
      keywords: ["问题", "风险", "避坑", "纠纷", "痛点", "错误", "为什么", "边界"],
      subcategories: [
        ["常见问题与误区拆解", ["问题", "错误", "为什么", "误区"]],
        ["风险预警与避坑建议", ["风险", "避坑", "损失", "注意"]],
        ["争议处理与边界判断", ["纠纷", "争议", "边界", "投诉"]],
      ],
    },
    {
      name: "政策、趋势与行业观察",
      coreFunction: "通过解读政策、趋势和行业环境变化，帮助用户获得背景信息并调整决策与行动。",
      keywords: ["政策", "新规", "官方", "监管", "趋势", "行业", "最新", "通知"],
      subcategories: [
        ["新政速递与权威解读", ["新规", "政策", "通知", "官方"]],
        ["行业趋势与环境观察", ["趋势", "行业", "环境", "市场"]],
      ],
    },
  ],
  drama: [
    {
      name: "冲突与反转类",
      coreFunction: "通过人物冲突、误会和反转制造情绪张力，帮助账号建立鲜明人设并提升用户停留。",
      keywords: ["冲突", "反转", "打脸", "套路", "争议", "误会", "对立"],
      subcategories: [
        ["冲突升级与情绪释放", ["冲突", "对立", "争吵", "情绪"]],
        ["误会反转与结果揭示", ["反转", "误会", "真相", "结果"]],
        ["博弈、打脸与关系变化", ["打脸", "套路", "博弈", "关系"]],
      ],
    },
    {
      name: "场景知识与决策类",
      coreFunction: "通过具体场景中的知识、判断和决策建议建立专业信任，帮助用户完成选择或行动。",
      keywords: ["鉴定", "真假", "避坑", "养护", "保养", "行情", "购买", "指南"],
      subcategories: [
        ["识别、鉴定与避坑场景", ["鉴定", "真假", "避坑"]],
        ["使用、养护与科普场景", ["养护", "保养", "护理", "科普"]],
        ["比较、购买与决策场景", ["行情", "价格", "购买", "指南"]],
      ],
    },
    {
      name: "真实体验与趣味互动类",
      coreFunction: "通过真实体验、趣味表达和生活化互动呈现人物或行业观察，促进评论讨论并保持账号活跃度。",
      keywords: ["吐槽", "真实", "心理", "槽点", "大实话", "搞笑", "趣味", "体验"],
      subcategories: [
        ["人物心理与真实独白场景", ["心理", "大实话", "独白"]],
        ["产品体验与痛点表达场景", ["槽点", "痛点", "产品", "体验"]],
        ["关系互动与趣味表达场景", ["关系", "趣味", "搞笑", "互动"]],
      ],
    },
  ],
};

export const buildHeuristicBenchmarkAnalysis = ({ contentStyle: rawContentStyle, videos: rawVideos = [] } = {}) => {
  const contentStyle = normalizeContentStyle(rawContentStyle);
  const videos = normalizeBenchmarkVideos(rawVideos);
  const rules = HEURISTIC_RULES[contentStyle];
  const assignments = videos.map(video => {
    const text = `${video.title} ${video.sourceText}`.toLowerCase();
    let best = null;
    let bestScore = 0;
    rules.forEach(rule => {
      const score = rule.keywords.reduce((sum, keyword) => sum + (text.includes(keyword.toLowerCase()) ? 1 : 0), 0);
      if (score > bestScore) {
        best = rule;
        bestScore = score;
      }
    });
    if (!best) return { video, rule: null, subcategory: null };
    const subcategory = best.subcategories.find(([, keywords]) => keywords.some(keyword => text.includes(keyword.toLowerCase())));
    return { video, rule: best, subcategory: subcategory?.[0] || "其他相关选题" };
  });

  const categories = rules.map((rule, index) => {
    const matched = assignments.filter(item => item.rule?.name === rule.name).map(item => item.video);
    const subcategories = rule.subcategories.map(([name]) => ({
      id: `heuristic-${index + 1}-${name}`,
      name,
      description: "基于标题与发布文案关键词的初步归类，建议结合完整脚本人工确认。",
      topics: assignments.filter(item => item.rule?.name === rule.name && item.subcategory === name).map(item => item.video),
    })).filter(item => item.topics.length > 0);
    const represented = new Set(subcategories.flatMap(item => item.topics.map(topic => topic.id)));
    const other = matched.filter(topic => !represented.has(topic.id));
    if (other.length > 0) subcategories.push({ id: `heuristic-${index + 1}-other`, name: "其他相关选题", description: "待进一步拆分的小类。", topics: other });
    return {
      id: `heuristic-category-${index + 1}`,
      name: rule.name,
      count: matched.length,
      percentage: toPercent(matched.length, videos.length),
      coreFunction: rule.coreFunction,
      keywords: rule.keywords,
      subcategories,
      topics: matched,
    };
  }).filter(category => category.count > 0);

  const matchedIds = new Set(categories.flatMap(category => category.topics.map(topic => topic.id)));
  const review = buildReviewCategory(videos.filter(video => !matchedIds.has(video.id)), videos.length, contentStyle);
  if (review) categories.push(review);
  return {
    categories,
    summary: `由于分析 Agent 暂不可用，已按${CONTENT_STYLE_LABELS[contentStyle]}规则对标题与发布文案完成初步归类；结果需要人工复核。`,
  };
};

export const benchmarkContentStyleLabels = CONTENT_STYLE_LABELS;
export const benchmarkPlatformLabels = PLATFORM_LABELS;
export const MAX_BENCHMARK_VIDEO_COUNT = MAX_BENCHMARK_VIDEOS;
