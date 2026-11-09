import { AgentError, appendQuery, fetchJson, isRetryableNetworkError } from "./contentAgent/http.js";

/**
 * 对标视频「高赞评论」的抓取与归一化 —— 本地 Express（server/index.js）与线上 Vercel
 * 端点（api/tikhub/comments.ts）共用这一份，保证两边行为一致。
 *
 * 为什么要抓评论：分类分析、黄金三秒、结尾钩子能看到的都只有**发布文案**，而发布文案
 * 往往只是标题加话题标签；观众真正在讨论什么、哪句话最被认同，只有评论区里才有。
 *
 * 成本约束（决定了下面所有设计）：
 *   ① TikHub 评论接口**按次计费** → 抓过的视频永久落库（见 commentStore.js），
 *      同一个视频一个项目经理只付一次钱，失败也会缓存，不会每轮重试都在烧钱；
 *   ② 一次只抓**首页**（`count` 条）再按点赞取 Top-N —— 评论分页要按游标串行翻页，
 *      成本随页数线性上涨，而「高赞样本」首页就够了；
 *   ③ 只支持抖音 —— TikTok 的评论端点没有在官方 spec 里核对过，见 fetchVideoComments。
 */

const asText = value => String(value ?? "").trim();

/** 单条评论最多留多少字。评论只作为「高赞样本」进报告，超长评论会把报告和分析输入撑爆。 */
const MAX_COMMENT_TEXT_LENGTH = 500;

/** 不传 count 时向 TikHub 要的首页条数（抖音评论首页常见就是 20 条）。 */
const DEFAULT_COMMENT_PAGE_SIZE = 20;

/** 单条评论请求的超时上限（毫秒）。实测几秒内返回，20s 是防单条卡死吃光整批预算。 */
const COMMENT_REQUEST_TIMEOUT_MS = 20_000;

/** 单条评论请求自身的重试次数上限，与 /api/tikhub/batch 的单页重试保持一致。 */
const COMMENT_REQUEST_RETRIES = 1;

/** 两个端点的日志/缓存 provider 标识：缓存里记的是「哪条链路应答的」，排查降级时一眼能看出来。 */
const PROVIDER_APP = "tikhub:douyin:app:fetch_video_comments";
const PROVIDER_WEB = "tikhub:douyin:web:fetch_video_comments";

/** 非负有限数守卫：点赞数、回复数通用。 */
const asNonNegativeInt = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
};

/** 正数守卫（配置项用）。 */
const asPositiveInt = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
};

/** 只认 douyin / tiktok，其余一律当 douyin（与 api/tikhub/batch.ts 的归一化一致）。 */
const normalizePlatform = value => (String(value ?? "").trim().toLowerCase() === "tiktok" ? "tiktok" : "douyin");

/**
 * 取第一个「有值」的别名字段，支持 `user.nickname` 这种点路径。
 *
 * 必须做别名兜底：TikHub 各端点、甚至同一端点的不同版本之间，字段名都在
 * `digg_count` / `like_count`、`cid` / `comment_id` 之间来回漂移（与
 * normalizeBenchmarkVideos 面对的是同一类问题）。缺字段时静默归零，不能让整批抓取失败。
 */
const pickField = (source, paths) => {
  for (const path of paths) {
    let current = source;
    for (const key of String(path).split(".")) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = current[key];
    }
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return undefined;
};

/** 评论列表可能出现的键名。 */
const COMMENT_LIST_KEYS = ["comments", "comment_list", "commentList", "items", "list"];

/**
 * 从 TikHub 响应里找评论数组。
 *
 * 取第一个**非空**数组，而不是第一个「是数组」的键 —— 与 normalizeBenchmarkVideos 的
 * collectReferences 同一条经验：上游完全可能同时给出 `comments: []` 和 `data: [...]`，
 * 此时按「第一个数组」取会把整个视频的评论清空，而且不报任何错。
 */
const pickCommentList = rawResponse => {
  const roots = [rawResponse, rawResponse?.data];
  const candidates = [];
  for (const root of roots) {
    if (Array.isArray(root)) {
      candidates.push(root);
      continue;
    }
    if (!root || typeof root !== "object") continue;
    for (const key of COMMENT_LIST_KEYS) {
      if (Array.isArray(root[key])) candidates.push(root[key]);
    }
  }
  return candidates.find(list => list.length > 0) || [];
};

/**
 * 点赞降序取前 N 条 —— 即「每个视频最被认同的几条评论」，每个视频单独调一次
 * （normalizeComments 内部也用它截断）。limit <= 0 表示不截断。
 *
 * 排序必须**确定性**：点赞相同时按回复数降序，再保持上游顺序（Array#sort 稳定）。
 * 否则同一份缓存每次读出来的顺序都在抖，报告里的「第几条」没法复核。
 */
export const pickTopComments = (comments, limit = 0) => {
  const list = Array.isArray(comments) ? [...comments] : [];
  list.sort((a, b) => (
    asNonNegativeInt(b?.likes) - asNonNegativeInt(a?.likes)
    || asNonNegativeInt(b?.replyCount) - asNonNegativeInt(a?.replyCount)
  ));
  const max = asPositiveInt(limit, 0);
  return max > 0 ? list.slice(0, max) : list;
};

/**
 * 上游评论 → 归一化结构（`{ id, text, likes, replyCount, authorName }`）。
 *
 * 字段名全部走别名兜底，理由见 pickField。丢弃空文本评论：纯表情、被折叠的评论没有
 * 分析价值，留着只会把 Top-N 的名额占掉。最后按点赞降序截断到 limit 条。
 */
export const normalizeComments = (rawResponse, options = {}) => {
  const list = pickCommentList(rawResponse);
  const seenIds = new Set();
  const comments = [];

  for (const item of list) {
    const source = item && typeof item === "object" ? item : {};
    const text = asText(pickField(source, ["text", "content", "comment", "comment_text"]))
      .replace(/\s+/g, " ")
      .slice(0, MAX_COMMENT_TEXT_LENGTH);
    if (!text) continue;

    const id = asText(pickField(source, ["cid", "comment_id", "commentId", "id"]));
    // 同一页里偶尔会重复出现同一条评论（上游分页边界），按 id 去重；
    // 没有 id 的评论无法判定是不是同一条，保留 —— 宁可多一条也不要误删。
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }

    comments.push({
      id,
      text,
      likes: asNonNegativeInt(pickField(source, ["digg_count", "diggCount", "like_count", "likeCount", "likes"])),
      replyCount: asNonNegativeInt(pickField(source, ["reply_comment_total", "replyCommentTotal", "reply_count", "replyCount"])),
      authorName: asText(pickField(source, ["user.nickname", "nickname", "author.nickname", "author_name", "authorName"])),
    });
  }

  return pickTopComments(comments, options.limit);
};

/**
 * TikHub 凭证在**调用时**读，而不是从 api/_lib/common 里 import。
 *
 * 原因：本文件是纯 ESM 的 .js，同时被本地 Express（node server/index.js，不经 TS 编译）
 * 和 Vercel 的 TS 端点引用；common 那份是 TypeScript，本地运行时解析不了。
 * 调用时读取还顺带让 dotenv / 测试能在模块加载之后再改 env。
 * 优先用显式传入的 config（与 providers.js 的 fetchTikHub 一致），env 只是兜底。
 */
const tikHubCredentials = config => ({
  baseUrl: asText(config?.tikhubBaseUrl) || asText(process.env.TIKHUB_BASE_URL) || "https://api.tikhub.io",
  token: asText(config?.tikhubApiToken) || asText(process.env.TIKHUB_API_TOKEN),
});

/**
 * app/v3 失败后是否值得退到 web 端点。
 *
 * 与 /api/tikhub/batch 的 shouldRetryInitialTopicPage 同一套判据：网络抖动/超时，
 * 以及 TikHub 抖音接口偶发用 HTTP 400 表达限流 —— 这两种都可能只是上游抖了一下，
 * 换 web 端点通常能拿到。其余 4xx（尤其 402 余额不足）不该退：换端点一样扣不动费，
 * 只会把一次明确的错误拖成两次无效调用。
 */
const shouldFallbackToWeb = error => isRetryableNetworkError(error) || Number(error?.status) === 400;

/**
 * 请求一个视频的评论首页，返回 `{ comments, provider }`。
 *
 * 主用 app/v3（字段最全），失败再退 web —— 与 batch.ts 的
 * `fetch_user_post_videos` app→web 降级完全同构：**同一轮里只选一条链路**，
 * 不混用两个端点的返回值。
 */
const requestVideoComments = async ({ awemeId, platform, config, logger, count } = {}) => {
  const id = asText(awemeId);
  if (!id) throw new AgentError("缺少 aweme_id，无法抓取评论", { code: "COMMENTS_AWEME_ID_REQUIRED", status: 400 });

  // 只支持抖音：TikTok 的评论端点没有核对过。宁可把这条记成失败，也不能凭猜去调付费接口。
  if (normalizePlatform(platform) === "tiktok") {
    throw new AgentError("评论抓取暂不支持 TikTok（没有验证过的评论端点）", { code: "COMMENTS_PLATFORM_UNSUPPORTED", status: 400 });
  }

  const { baseUrl, token } = tikHubCredentials(config);
  if (!token) throw new AgentError("Missing TIKHUB_API_TOKEN", { code: "COMMENTS_TIKHUB_TOKEN_MISSING", status: 500 });

  const limit = asNonNegativeInt(config?.benchmarkCommentLimitPerVideo);
  const params = {
    aweme_id: id,
    cursor: 0,
    count: asPositiveInt(count, 0) || limit || DEFAULT_COMMENT_PAGE_SIZE,
  };
  const requestOptions = {
    // 与 batch.ts 一样夹一层上限：配置里的 120s 是给整份报告 Agent 用的，
    // 单条评论请求要几秒，不能让一条慢请求吃掉整批预算。
    timeoutMs: Math.min(asPositiveInt(config?.requestTimeoutMs, COMMENT_REQUEST_TIMEOUT_MS), COMMENT_REQUEST_TIMEOUT_MS),
    retries: Math.min(asNonNegativeInt(config?.apiRetryAttempts), COMMENT_REQUEST_RETRIES),
    retryBaseDelayMs: asPositiveInt(config?.apiRetryBaseDelayMs, 500),
    logger,
    logFields: { awemeId: id },
    headers: { Authorization: `Bearer ${token}` },
  };

  const appEndpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/douyin/app/v3/fetch_video_comments`;
  const webEndpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/douyin/web/fetch_video_comments`;

  try {
    const { data } = await fetchJson(appendQuery(appEndpoint, params), {
      ...requestOptions,
      interfaceName: PROVIDER_APP,
      // TikHub 抖音接口会把偶发限流/抖动包成 HTTP 400，先让 fetchJson 自己重试一次再谈降级。
      retryableExtraStatuses: 400,
    });
    return { comments: normalizeComments(data, { limit }), provider: PROVIDER_APP };
  } catch (error) {
    if (!shouldFallbackToWeb(error)) throw error;
    logger?.warn("tikhub.douyin.app_to_web_fallback", {
      operation: "fetch_video_comments",
      awemeId: id,
      error: error instanceof Error ? error.message : "App V3 request failed",
      code: error?.code,
      status: error?.status,
    });
    // web 兜底同样不重试 400：真正的参数错误两个端点都会错，重试只会多扣一次费。
    const { data } = await fetchJson(appendQuery(webEndpoint, params), {
      ...requestOptions,
      interfaceName: PROVIDER_WEB,
    });
    return { comments: normalizeComments(data, { limit }), provider: PROVIDER_WEB };
  }
};

/**
 * 抓取一个视频的评论（已归一化、点赞降序、按 `benchmarkCommentLimitPerVideo` 截断）。
 * 失败一律抛错（含 TikTok 不支持、缺 token），由调用方按「失败项」记账 —— 见 fetchCommentsBatch。
 */
export const fetchVideoComments = async (options = {}) => (await requestVideoComments(options)).comments;

/**
 * 并发抓一批视频的评论，**单条失败不影响整批**。
 *
 * 与 goldThreeSecondTranscripts.transcribeTargets 同构：有界并发 + 时间预算 +
 * **每完成一条立刻交出去落库**（onResult）。整批跑完才写的话，函数被平台杀掉这一批
 * 就全白做 —— 而每条评论都是真金白银买的，丢掉比跑得慢更不可接受。
 */
export const fetchCommentsBatch = async ({
  targets = [],
  config,
  logger,
  budgetMs = 0,
  concurrency = 1,
  onResult,
} = {}) => {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) return [];

  const results = [];
  const startedAt = Date.now();
  let cursor = 0;

  const emit = async result => {
    results.push(result);
    try {
      await onResult?.(result);
    } catch (error) {
      // 落库失败不能中断整批：剩下的视频还是要抓，否则钱花了却什么都没留下。
      logger?.warn("tikhub.comments.persist_failed", {
        videoId: result.videoId,
        error: error instanceof Error ? error.message : "评论落库失败",
      });
    }
  };

  const worker = async () => {
    while (cursor < list.length) {
      // 预算守卫，与转写链路同一个模式：宁可少抓几条留给下一批，
      // 也不要拖到 serverless 函数被强杀 —— 那样在途的付费请求结果全丢。
      if (budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
        logger?.warn("tikhub.comments.budget_exhausted", {
          attempted: results.length,
          remaining: list.length - results.length,
          elapsedMs: Date.now() - startedAt,
          budgetMs,
        });
        return;
      }
      // 取件与自增之间没有 await，多个 worker 之间不会拿到同一个下标。
      const target = list[cursor];
      cursor += 1;
      const videoStartedAt = Date.now();
      try {
        const { comments, provider } = await requestVideoComments({
          awemeId: target.videoId,
          platform: target.platform,
          config,
          logger,
        });
        await emit({
          videoId: target.videoId,
          status: "ok",
          comments,
          provider,
          durationMs: Date.now() - videoStartedAt,
        });
        logger?.info("tikhub.comments.ok", {
          videoId: target.videoId,
          provider,
          commentCount: comments.length,
          durationMs: Date.now() - videoStartedAt,
        });
      } catch (error) {
        // 失败也要落库（带 failed 标记 + 错误原因）：否则前端每轮都会重抓同一个坏视频，
        // 付费接口上这是持续烧钱。想重试走 clearComments 或换一份报告重新触发。
        await emit({
          videoId: target.videoId,
          status: "failed",
          comments: [],
          error: error instanceof Error ? error.message : "评论抓取失败",
          durationMs: Date.now() - videoStartedAt,
        });
        logger?.warn("tikhub.comments.failed", {
          videoId: target.videoId,
          code: error?.code,
          status: error?.status,
          error: error instanceof Error ? error.message : "评论抓取失败",
        });
      }
    }
  };

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
};

/**
 * 请求体 → 抓取目标列表。两个运行时共用，避免本地和线上对「哪些视频要抓」判断不一致。
 *
 * 兼容两种写法：`{ videos: [{ videoId, platform }] }`（前端主用）与裸
 * `{ videoIds: ["..."] }`（截图/脚本调用的简写）。同一个视频去重 —— 重复项会让
 * progress 的总数虚高，更糟的是同一个付费请求会打两遍。
 */
export const normalizeCommentTargets = (payload = {}) => {
  const body = payload && typeof payload === "object" ? payload : {};
  const fallbackPlatform = normalizePlatform(body.platform);
  const rawList = Array.isArray(body.videos) ? body.videos : [];
  const candidates = rawList.map(item => {
    if (typeof item === "string") return { videoId: asText(item), platform: fallbackPlatform };
    return {
      videoId: asText(pickField(item, ["videoId", "video_id", "aweme_id", "awemeId", "id"])),
      platform: normalizePlatform(item?.platform ?? fallbackPlatform),
    };
  });
  // 裸 videoIds 只在 videos 完全没给出可用项时才兜底，避免两种写法各取一半拼出乱七八糟的批次。
  if (candidates.every(item => !item.videoId) && Array.isArray(body.videoIds)) {
    candidates.length = 0;
    for (const id of body.videoIds) candidates.push({ videoId: asText(id), platform: fallbackPlatform });
  }

  const unique = [];
  const seenIds = new Set();
  for (const item of candidates) {
    if (!item.videoId || seenIds.has(item.videoId)) continue;
    seenIds.add(item.videoId);
    unique.push(item);
  }
  return unique;
};
