import type { TopicContent, TopicContentMap } from "./topicContentRules";

/**
 * 「今日选题」内容分析的**纯流水线部件**（无网络、无浏览器 API）。
 *
 * 与 `topicContentRules.ts` 拆开的原因：那个文件是**业务口径**（点赞门槛、时间窗口、
 * 打标签要求），这个是**执行机制**（并行、进度、结果合并）。混在一起会让口径文件
 * 迅速变厚，而这里的每个部件都值得单独测。
 *
 * ── 为什么要有这个文件（用户 2026-09-24 的方案一）──────────────────────
 * 原来的编排是「**先等全部脚本提完，再一次性打标签**」：
 *
 *     读取库 → [转写 60 条，分钟级] → [打标签，一次性 N 条]
 *
 * 两个问题：
 *   1. **慢**：标签必须等最慢的那条脚本，前面提完的全部闲置；而且全程界面没有任何
 *      结果落地，用户看到的是"卡住"。
 *   2. **一错全无**：打标签那一次调用如果 500（实测发生过），前面几分钟的转写结果
 *      一条都显示不出来。
 *
 * 改成「**逐条并行的两段流水线**」：每条视频各自跑「提脚本 → 打标签」，多条同时进行，
 * 谁提完谁立刻打标签，**每完成一条就把它交出去渲染**。
 *
 *     读取库 → ┌ 视频A：提脚本 → 打标签 ┐
 *              ├ 视频B：提脚本 → 打标签 ┤  同时进行，各自完成即上报
 *              └ 视频C：提脚本 → 打标签 ┘
 *
 * 方案二（如果还是慢）是把打标签换成后端批量 agent 链路，一次并行 4 条 —— 那时只需
 * 替换 `analyzeOne` 的实现，本文件的并行/进度/合并机制都不用动。
 */

/** 逐条并行的上限。方案一先给 3；慢的话优先调大这个数，而不是改结构。 */
export const MAX_VIDEO_CONCURRENCY = 3;

/**
 * 组装「这批视频」的范围指纹：客户 + 时间窗口 + 这批视频 id。
 *
 * 用它判断"上一次的分析结果能不能直接复用"。三者任一变化都必须重新分析：
 *   · 换客户 → 打标签的词典换了；
 *   · 换窗口 → 视频集合换了；
 *   · 抓到新视频 → 新视频还没分析过。
 */
export const buildTopicAnalysisScopeKey = (customerId: string, days: number, topicIds: readonly string[]) =>
  `${String(customerId || "")}|${Number(days)}|${(Array.isArray(topicIds) ? topicIds : []).map(id => String(id || "")).join(",")}`;

/**
 * 重建后能否直接复用上一次的分析结果（不取库、不转写、不重新打标签）。
 *
 * 🔴 为什么值得单独成一个纯函数：选题页 →「开始二创」→ 返回，路由会让组件
 *    **卸载重建**（见 App.tsx）。普通 useState 一重建就归零，于是整批重新分析 ——
 *    转写被后端缓存兜住（快），但**打标签要重跑 DeepSeek**，是真实的钱和时间。
 *    这个判断一旦写错，要么白花钱（退化成不复用），要么更糟：复用错批次的标签，
 *    用户拿着上一批的标签去做二创。
 *
 * 前端没有渲染测试基建，所以把判断抽出来，用 `node --test` 直接钉住。
 */
export const canReuseTopicAnalysis = (options: {
  /** 当前这批视频的指纹。 */
  currentKey: string;
  /** 持久化下来的、上一轮分析覆盖的指纹。 */
  savedKey: string;
  /** 上一轮拿到的内容条数（0 表示其实没分析出东西，不该复用）。 */
  contentCount: number;
}): boolean => {
  const currentKey = String(options?.currentKey || "");
  if (!currentKey) return false;                       // 指纹算不出来就不能复用
  if (currentKey !== String(options?.savedKey || "")) return false;  // 换了批次/客户/窗口
  return Number(options?.contentCount || 0) > 0;       // 上次是空结果 → 重新跑
};

/** 单条视频"提脚本"阶段的最大轮次 —— 后端异常时不能变成死循环。 */
export const MAX_VIDEO_TRANSCRIBE_ROUNDS = 10;

/** 一条视频的逐条执行状态。 */
export type VideoTaskStatus = "pending" | "transcribing" | "tagging" | "done" | "failed";

/**
 * 把 `items` 并发跑 `worker`，最多 `limit` 条同时进行。
 *
 * 🔴 与「一次性 Promise.all」的区别：**并发是有界的**。同时发 60 条会把后端
 * TikHub/ASR/DeepSeek 全部打满，反而更慢，也更容易触发限流。
 *
 * 结果**按输入顺序返回**（不是完成顺序）：调用方要按视频顺序展示，完成顺序会让
 * 进度看起来乱跳。单条失败不影响其他条：那一条记 `null`，其余照跑 —— 一条坏视频
 * 不该让整页分析失败。
 */
export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<R | null>> => {
  const list = Array.isArray(items) ? items : [];
  const results: Array<R | null> = new Array(list.length).fill(null);
  if (list.length === 0) return results;

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(Number(limit) || 1), list.length));

  const run = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch {
        // 单条失败不该带走整批；失败态由 worker 自己写进状态表（见 runTopicContentAnalysis）。
        results[index] = null;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, run));
  return results;
};

/** 把报告里的一条结果并进 content 表（**返回新对象**，不改入参）。 */
export const mergeTopicContent = (
  previous: TopicContentMap,
  videoId: string,
  item: Partial<TopicContent> & { script?: string; scriptSource?: "transcript" | "caption"; categoryId?: string; categoryName?: string; subcategoryName?: string; confidence?: string; basis?: string },
): TopicContentMap => {
  const key = String(videoId || "").trim();
  if (!key) return previous;
  return {
    ...previous,
    [key]: {
      script: String(item.script || ""),
      scriptSource: item.scriptSource === "transcript" ? "transcript" : "caption",
      categoryName: String(item.categoryName || ""),
      subcategoryName: String(item.subcategoryName || ""),
      categoryId: String(item.categoryId || ""),
      confidence: String(item.confidence || "low"),
      basis: String(item.basis || ""),
    },
  };
};

/**
 * 把逐条状态汇总成界面用的进度文案与计数。
 *
 * ⚠️ 必须在**每条完成时**都算一次（而不是最后算一次）：用户要看到"已经出了几条"，
 * 这正是方案一要解决的问题。数字口径与旧实现保持一致（`scriptCount` 只数真转写、
 * `taggedCount` 只数命中库内大类且不是"待人工复核"的）。
 */
export const summarizeTopicAnalysis = (
  statuses: readonly VideoTaskStatus[],
  content: TopicContentMap,
  total: number,
): { processed: number; failed: number; scriptCount: number; taggedCount: number; message: string } => {
  const list = Array.isArray(statuses) ? statuses : [];
  const processed = list.filter(status => status === "done" || status === "failed").length;
  const failed = list.filter(status => status === "failed").length;
  const values = Object.values(content || {});
  const scriptCount = values.filter(item => item.scriptSource === "transcript").length;
  const taggedCount = values.filter(item => item.categoryId && item.categoryId !== "review").length;

  const transcribing = list.filter(status => status === "transcribing").length;
  const tagging = list.filter(status => status === "tagging").length;
  const stage = tagging > 0
    ? `正在打标签 ${tagging} 条`
    : transcribing > 0
      ? `正在提取脚本 ${transcribing} 条`
      : "正在收尾";

  const message = `已处理 ${processed}/${total}（成功 ${processed - failed}，失败 ${failed}）· ${stage} · 已出 ${scriptCount} 条脚本、${taggedCount} 条标签`;

  return { processed, failed, scriptCount, taggedCount, message };
};

/**
 * 一次打标签请求覆盖多少条视频（方案二，2026-09-28）。
 *
 * 背景：原来每条视频单独调一次打标签（一次 DeepSeek），60 条就是 60 次串行等待。
 * 后端本来就能一次吃多条（`analyze` 遍历全部 videos、按 videoId 逐条产出），
 * 所以这里攒够一批再一次发出去 —— **用一次模型调用覆盖多条，是"以空间换时间"**。
 *
 * ⚠️ 批次不能无限大：一个批次的 prompt 里要塞下这一批全部脚本，条数越多
 *    单次 token 越多、越容易触到模型上限或超时。4 条是"快"与"稳"的折中。
 */
export const TOPIC_TAG_BATCH_SIZE = 4;

/**
 * 攒批器：把陆续到达的条目按 `size` 分组，**每凑满一批就立刻交出去**。
 *
 * 为什么需要它、而不是简单地 `chunk(items, 4)`：条目是**陆续**到达的
 * （每条转写耗时不同、谁先好谁先到）。如果等到"全部转写完"再分块，就把
 * 「谁先跑完谁先显示」这个特性丢掉了；而每条单独发又太慢。攒批器让两者兼得。
 *
 * 🔴 `flush()` 必须在所有条目都到达后调用一次，否则**最后不足一批的条目
 *    永远不会被处理** —— 那种 bug 表现为"大部分出来了，尾巴几条永远转圈"，
 *    极难定位。
 */
export const createBatcher = <T>(size: number, onBatch: (batch: T[]) => void) => {
  const limit = Math.max(1, Math.floor(Number(size) || 1));
  let buffer: T[] = [];
  return {
    /** 收下一条；凑满一批就同步交出去并清空。 */
    add(item: T) {
      buffer.push(item);
      if (buffer.length >= limit) {
        const batch = buffer;
        buffer = [];
        onBatch(batch);
      }
    },
    /** 交掉剩余不足一批的条目。全部 add 完之后必须调用。 */
    flush() {
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      onBatch(batch);
    },
    /** 当前还没交出去的条数（测试与进度用）。 */
    pending: () => buffer.length,
  };
};

/**
 * 分析运行的**取消策略**。
 *
 * 🔴 这条规则是为了修一个真实的死锁（2026-09-28 用户实测：界面永久停在
 *    「正在读取本账号的选题库…」，不报错、不推进）。根因是 React effect 的依赖数组里
 *    放了**这个 effect 自己会写的 state**（`topicAnalysisScope` / `topicContent`）：
 *
 *      ① effect 跑 → `setTopicAnalysisScope` / `setTopicContent` → 启动异步分析
 *      ② 异步函数执行到第一个 `await` 前发出「正在读取本账号的选题库…」
 *         —— 此时还没被取消，所以这句话**显示出来了**（用户看到的就是它）
 *      ③ `await` 让出 → React 重渲染 → 依赖变了 → cleanup 执行 `cancelled = true`
 *      ④ effect 重跑 → 已登记过的 key → 提前 return，**不再注册新 cleanup**
 *      ⑤ 正在跑的分析被**永久**取消：`onProgress`/`onContent` 全被 `if (!cancelled)`
 *         挡掉，结束时 `if (cancelled) return` 把结果整个丢掉
 *
 *    服务端其实跑完了，前端把每一次更新都扔了 —— 所以既没结果也没有错误。
 *
 * 结论：**只有「这批视频的范围」真的变了才允许取消**；其余变化（进度文案、已落地的
 * 逐条结果等）一律不得取消。所以 effect 的唯一依赖必须是"范围指纹"这个字符串。
 */
export const shouldCancelAnalysisRun = (runningKey: string, nextKey: string): boolean =>
  Boolean(runningKey) && runningKey !== nextKey;

/**
 * 决定这一次 effect 该做什么：
 *   · `"skip"`  —— 没有可分析的选题，或这批范围已经登记过（跑过 / 正在跑）
 *   · `"reuse"` —— 这批范围**上次已经分析完**（结果已持久化），直接复用，不重新花钱
 *   · `"run"`   —— 真的开始分析
 */
export const decideTopicAnalysisAction = (options: {
  scopeKey: string;
  analyzedKey: string;
  savedScopeKey: string;
  contentCount: number;
}): "skip" | "reuse" | "run" => {
  const { scopeKey, analyzedKey, savedScopeKey, contentCount } = options;
  if (!String(scopeKey || "")) return "skip";
  if (analyzedKey === scopeKey) return "skip";
  if (canReuseTopicAnalysis({ currentKey: scopeKey, savedKey: savedScopeKey, contentCount })) return "reuse";
  return "run";
};
