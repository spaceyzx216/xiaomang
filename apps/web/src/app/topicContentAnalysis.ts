import { analyzeTopicRefresh, getTopicCategoryDictionary, transcribeTopicRefresh, type TopicLibraryDetail } from "./topicLibrary";
import {
  MAX_VIDEO_CONCURRENCY,
  MAX_VIDEO_TRANSCRIBE_ROUNDS,
  TOPIC_TAG_BATCH_SIZE,
  createBatcher,
  mapWithConcurrency,
  mergeTopicContent,
  summarizeTopicAnalysis,
  type VideoTaskStatus,
} from "./topicAnalysisPipeline";
import {
  TOPIC_MIN_LIKES,
  shouldExtractTranscripts,
  transcribableVideos,
  type TopicContentMap,
} from "./topicContentRules";

/**
 * 「今日选题」的内容分析**编排**：取库 → 逐条并行「提脚本 → 打标签」。
 *
 * 纯规则在 `topicContentRules.ts`、并行/进度/合并的纯部件在 `topicAnalysisPipeline.ts`
 * （两边都不拉浏览器依赖，可被 `node --test` 直接加载）；这里只负责网络与流程编排。
 *
 * 词典来自**入口就定好的那个客户**：临时任务绑定的客户 / 指派任务的客户。
 * 没有客户、或该客户还没建库时**不猜**，直接如实说明原因，让界面提示去补。
 *
 * ── 2026-09-24 改成逐条并行的两段流水线（用户方案一）────────────────────
 *
 * 旧顺序是「等全部脚本提完 → 一次性打标签」，两个毛病：
 *   ① 慢：标签要等最慢的那条，前面提完的闲置；全程界面无结果落地，看着像卡死；
 *   ② 一错全无：打标签那次调用一旦 500，前面几分钟的转写一条都显示不出来。
 *
 * 新顺序：每条视频各自跑「提脚本 → 打标签」，多条同时进行（上限
 * `MAX_VIDEO_CONCURRENCY`），**每完成一条立刻通过 `onContent` 交出去渲染**。
 * 单条失败只标红那一条，不影响其他条，也不再让整页报错。
 *
 * 打标签**只读选题库词典**（`?view=categories`），黄金三秒 / 结尾钩子那两份报告
 * 与打标签无关 —— 之前走全量 `getTopicLibrary` 会把它们一并拉下来，纯属白等。
 */

export type TopicAnalysisStatus =
  | "idle"
  | "loading-library"
  | "transcribing"
  | "tagging"
  | "done"
  | "no-library"
  | "error";

export type TopicAnalysis = {
  status: TopicAnalysisStatus;
  message: string;
  /** 本次是否真的提取了脚本（只有近 7 天才为 true）。 */
  transcriptsExtracted: boolean;
  taggedCount: number;
  scriptCount: number;
  error: string;
};

/**
 * 取某个客户的选题库词典。
 *
 * ⚠️ 用**轻量视图** `?view=categories`：打标签只需要「大类 / 小类 / 关键词」这份词典。
 * 全量视图会把 2.2 / 2.3 的报告正文一起返回（几十条样本 + 逐条文案），
 * 而打标签一行都用不到 —— 白等几秒到十几秒，还多占内存。
 *
 * 返回 null 表示"没有库"，由界面如实说明；抛错才是真的故障。
 *
 * ── in-flight memo（一进入页面就预热）────────────────────────────────
 * 选题页挂载时会先 `void loadLibraryForCustomer(id)` 把请求发出去（见 App.tsx），
 * 真正开始分析时再调一次。两次调用共用**同一个 Promise**，所以预热不是白做。
 *
 * ⚠️ 命中失败也必须清掉：否则一次网络抖动会被记成"这个客户没有库"，
 *    而界面会照着"没有库"给出错误提示，用户完全看不出是网络问题。
 */
let libraryMemo: { customerId: string; promise: Promise<TopicLibraryDetail | null> } | null = null;

export const loadLibraryForCustomer = async (customerId: string): Promise<TopicLibraryDetail | null> => {
  const key = String(customerId || "").trim();
  if (!key) return null;
  if (libraryMemo?.customerId === key) return libraryMemo.promise;

  const promise = getTopicCategoryDictionary(key)
    .then(dictionary => (dictionary || null) as TopicLibraryDetail | null)
    .catch(error => {
      // 失败不留缓存：下次调用重新请求。
      if (libraryMemo?.promise === promise) libraryMemo = null;
      throw error;
    });
  libraryMemo = { customerId: key, promise };
  return promise;
};

/** 清掉库词典的 in-flight memo。分析真正开始时用一次，确保拿到的是本次的库。 */
export const clearLibraryMemo = () => { libraryMemo = null; };

/**
 * 一条视频的**提脚本**阶段（方案二后，打标签不再在这里做）。
 *
 * 脚本结果通过 `onScript` 即时交出去（用户先看到脚本，标签随后由攒批器统一补）。
 * 完成后把这条交给 `onTranscribed`，由主流程攒批 —— 见 `createBatcher`。
 */
const transcribeOneVideo = async (options: {
  video: ReturnType<typeof transcribableVideos>[number];
  days: number;
  minLikes: number;
  extractTranscripts: boolean;
  /** 拿到脚本时立刻上报（用户先看到脚本，标签随后补）。 */
  onScript: (videoId: string, patch: { script: string; scriptSource: "transcript" | "caption" }) => void;
}): Promise<void> => {
  const { video, days, minLikes, extractTranscripts } = options;

  // 提脚本：分批推进这一条，直到后端说它 finished（或超过轮次上限）。
  // 后端按 `scope: "script"` 永久缓存，换窗口 / 二次进入是秒开的。
  if (!extractTranscripts) return;
  let round = 0;
  for (;;) {
    round += 1;
    const progress = await transcribeTopicRefresh({ videos: [video], recentDays: days, minLikes });
    if (progress.finished || round >= MAX_VIDEO_TRANSCRIBE_ROUNDS) break;
  }
};

/**
 * 跑一次完整的内容分析（逐条并行版）。
 *
 * `onProgress` 把进度写到界面上 —— 转写是分钟级的，没有进度用户会以为卡死。
 * `onContent` **每完成一条就被调用一次**，把增量结果直接交给界面渲染：这是
 * 「边跑边出结果」的关键，不要改成最后统一返回。
 */
export const runTopicContentAnalysis = async (options: {
  topics: Array<{
    id: string; title?: string; link?: string; authorName?: string; publishDate?: string;
    platform?: string; stats?: { likes?: number; comments?: number; shares?: number; bookmarks?: number };
  }>;
  customerId: string;
  days: number;
  /** 点赞门槛（自定义）。不传用默认值。口径是**大于等于**。 */
  minLikes?: number;
  onProgress?: (patch: Partial<TopicAnalysis>) => void;
  /** 每完成一条（或拿到脚本）就回调一次，参数是**累计**的内容表。 */
  onContent?: (content: TopicContentMap) => void;
}): Promise<{ content: TopicContentMap; analysis: Partial<TopicAnalysis> }> => {
  const { topics, customerId, days, onProgress, onContent } = options;
  // 门槛贯穿"转写"与"打标签"两次后端调用：两边必须用同一个值，否则会出现
  // 「转了 A 这批视频、却给 B 这批打标签」的错位（后端各自按门槛重新过滤）。
  const minLikes = Number.isFinite(Number(options.minLikes)) && Number(options.minLikes) >= 0
    ? Number(options.minLikes)
    : TOPIC_MIN_LIKES;
  const videos = transcribableVideos(topics);
  const extractTranscripts = shouldExtractTranscripts(days);

  if (!customerId) {
    // ⚠️ 所有提前返回都必须回调 onProgress：只 return 会让界面停在上一次的文案上，
    //    用户看到的是"卡住"而不是"原因"（下面每一处都遵守这条）。
    const message = "这条任务没有绑定客户，无法确定用哪份选题库打标签。请在创建任务时选择客户。";
    onProgress?.({ status: "no-library", message });
    return {
      content: {},
      analysis: {
        status: "no-library", transcriptsExtracted: false, taggedCount: 0, scriptCount: 0,
        message,
      },
    };
  }

  onProgress?.({ status: "loading-library", message: "正在读取本账号的选题库…" });
  // 用掉预热的那份 memo（同一个 Promise，0 成本），再清掉，避免后续轮次一直吃旧词典。
  const library = await loadLibraryForCustomer(customerId);
  clearLibraryMemo();
  if (!library || !Array.isArray(library.tagDictionary) || library.tagDictionary.length === 0) {
    const message = "这个客户还没有正式选题库，无法给视频打标签。请让项目经理先在「账号定位 → 2.4」里建库。";
    onProgress?.({ status: "no-library", message });
    return {
      content: {},
      analysis: {
        status: "no-library", transcriptsExtracted: false, taggedCount: 0, scriptCount: 0,
        message,
      },
    };
  }

  if (videos.length === 0) {
    // 🔴 必须**同时通过 onProgress 上报**：只 return 不回调的话，界面会一直停在
    //    上一次的文案上（用户实测遇到过"卡在正在读取本账号的选题库…"这种误导性状态）。
    //    这句话要如实说清"为什么一条都进不来"——视频号缺 mediaUrl/decodeKey 是常见原因。
    const hasWechat = topics.some(topic => topic?.platform === "wechat_channels");
    const message = hasWechat
      ? "这批视频号选题缺少媒体直连地址或解密密钥，无法在本地提取脚本（请重新获取该账号的作品后重试）。"
      : "达标视频都没有可用链接，无法提取脚本或打标签。";
    onProgress?.({ status: "done", message, scriptCount: 0, taggedCount: 0 });
    return {
      content: {},
      analysis: { status: "done", transcriptsExtracted: false, taggedCount: 0, scriptCount: 0, message },
    };
  }

  // ── 逐条并行流水线 ────────────────────────────────────────────────────
  // 状态表固定按 `videos` 顺序建好，进度与最终汇总都读它。
  const statuses: VideoTaskStatus[] = videos.map(() => "pending");
  let content: TopicContentMap = {};
  const publish = (stage: TopicAnalysisStatus) => {
    const summary = summarizeTopicAnalysis(statuses, content, videos.length);
    onProgress?.({ status: stage, message: summary.message, scriptCount: summary.scriptCount, taggedCount: summary.taggedCount });
  };
  const publishContent = () => onContent?.(content);

  publish("transcribing");

  // 把一条的打标签结果并进 content 并立刻上报。
  // 抽成函数是因为**脚本**和**标签**两个时机都要走同一套合并规则。
  const absorb = (videoId: string, item: Record<string, any> | null) => {
    if (item) {
      content = mergeTopicContent(content, videoId, {
        script: item.script || "",
        scriptSource: item.scriptSource,
        categoryName: item.category?.name,
        subcategoryName: item.subcategory?.name,
        categoryId: item.category?.id,
        confidence: item.confidence,
        basis: item.basis,
      });
    }
    publishContent();
  };

  /**
   * 打标签：**攒批**发出（方案二）。
   *
   * 每条转写完成后进来登记，凑满 `TOPIC_TAG_BATCH_SIZE` 就发一次请求覆盖这一批 ——
   * 用一次模型调用换多条，而不是每条一次。批次内**逐条回填**，所以结果依然是
   * 一批一批地往外冒，而不是全部跑完才显示。
   */
  let inFlight: Promise<void> = Promise.resolve();
  let inFlightCount = 0;
  const waitForBatches = async () => {
    while (inFlightCount > 0) await inFlight;
  };

  const runTagBatch = async (batch: Array<{ video: (typeof videos)[number]; index: number }>) => {
    for (const entry of batch) statuses[entry.index] = "tagging";
    publish("tagging");
    try {
      const report = await analyzeTopicRefresh({
        videos: batch.map(entry => entry.video),
        categories: library.tagDictionary,
        recentDays: days,
        minLikes,
        customerId,
      });
      const byId = new Map(
        (Array.isArray(report.items) ? report.items : []).map(item => [String(item?.video?.id || ""), item]),
      );
      for (const entry of batch) {
        const item = byId.get(entry.video.id) || null;
        if (!item) statuses[entry.index] = "failed";
        absorb(entry.video.id, item);
      }
    } catch {
      // 整批失败：这批全部标红。不重试单条 —— 那会让已成功的条目重复花钱。
      for (const entry of batch) statuses[entry.index] = "failed";
    } finally {
      publish("tagging");
    }
  };

  const tagging = createBatcher<{ video: (typeof videos)[number]; index: number }>(
    TOPIC_TAG_BATCH_SIZE,
    batch => {
      // 串行排队而不是并发发批：批次本身就是"合并调用"，再并发会把模型打满，
      // 而且一个请求内已经有多条了，收益递减、超时风险上升。
      inFlightCount += 1;
      inFlight = inFlight
        .then(() => runTagBatch(batch))
        .catch(() => { /* 单批失败已在 runTagBatch 内部标红 */ })
        .finally(() => { inFlightCount -= 1; });
    },
  );

  // ⚠️ `mapWithConcurrency` 只负责**提脚本**。打标签被移出去攒批，
  //    所以这里不再是"每条一个完整流水线"，而是「并行提脚本 → 攒批打标签」两段。
  await mapWithConcurrency(videos, MAX_VIDEO_CONCURRENCY, async (video, index) => {
    try {
      statuses[index] = extractTranscripts ? "transcribing" : "tagging";
      publish(extractTranscripts ? "transcribing" : "tagging");

      await transcribeOneVideo({
        video,
        days,
        minLikes,
        extractTranscripts,
        onScript: (videoId, patch) => {
          // 先把脚本交出去（用户先看到脚本），标签随后由攒批器补上。
          content = mergeTopicContent(content, videoId, { ...content[videoId], ...patch });
          publishContent();
        },
      });
      // 转写完成 → 登记进批次。没轮到发批次时，这条先显示「脚本已出、标签待补」。
      tagging.add({ video, index });
    } catch {
      // 提脚本失败的条目**不进批次**（进去了也只会拿到 caption 兜底），直接标红。
      statuses[index] = "failed";
      publish("transcribing");
    }
  });

  // 🔴 必须 flush：否则最后不足一批的条目永远不会被打标签 ——
  //    那种 bug 表现为"大部分出来了，尾巴几条永远转圈"，极难定位。
  tagging.flush();
  await waitForBatches();
  // 完成状态统一在这里落一次（转写+标签都结束了才算 done）。
  for (let index = 0; index < statuses.length; index += 1) {
    if (statuses[index] !== "failed") statuses[index] = "done";
  }
  publish("tagging");

  publishContent();

  const summary = summarizeTopicAnalysis(statuses, content, videos.length);
  const failedNote = summary.failed > 0 ? `，${summary.failed} 条失败（已如实标出，可重试）` : "";
  return {
    content,
    analysis: {
      status: "done",
      transcriptsExtracted: extractTranscripts,
      scriptCount: summary.scriptCount,
      taggedCount: summary.taggedCount,
      message: extractTranscripts
        ? `已提取 ${summary.scriptCount} 条完整脚本，${summary.taggedCount}/${videos.length} 条打上库内大类/小类标签${failedNote}。`
        : `本时间范围不提取脚本；${summary.taggedCount}/${videos.length} 条打上库内大类/小类标签${failedNote}。`,
    },
  };
};
