/**
 * 正式选题库存储（客户级，2026-09-21 新增）。
 *
 * ── 业务口径（用户已拍板，别再自行发明）────────────────────────────────────
 * 1. **库来自 2.1 分类分析报告**，不是 1.3 的客户报告。1.3 只产出给客户看的报告。
 * 2. **归属是客户级**：一个客户一份库，库里可以纳入多个对标账号的分析结果。
 * 3. **多个账号的分类各自独立保留，不合并** —— 只靠大类同名就自动合并是被明确
 *    禁止的（HANDOFF §0.1）。所以每个账号在 `accounts[]` 里占一个独立条目，
 *    分类 id 一律带账号前缀（见 `scopedCategoryId`），保证全局唯一、不会同名相撞。
 * 4. **落库靠人工点击**，不自动保存；新视频列表的「勾选」只留在前端，**不入库**
 *    （HANDOFF §0.1：「不能把勾选自动解释为写入正式库」）。
 *
 * ── 为什么存分类树而不是只存分类名 ──────────────────────────────────────
 * 用户明确要求带「核心功能 / 判断核心关键词 / 样本占比」—— 这些是判断依据，
 * 不能只存分类名称（HANDOFF §0.1 第 3 条）。所以整棵分类树快照落库，
 * 新视频打标签时直接拿它当词典，不再回头依赖原报告还在不在。
 */

import { MongoClient, ObjectId } from "mongodb";
import { getGoldThreeSecondReport, listGoldThreeSecondReports } from "./goldThreeSecondStore.js";
import { getEndingHookReport, listEndingHookReports } from "./endingHookStore.js";

let clientPromise;
let indexPromise;
export async function closeMongoClient() {
  const current = clientPromise;
  clientPromise = undefined;
  indexPromise = undefined;
  if (current) await (await current).close();
}

// 建索引是尽力而为：失败不影响读写主流程，只是查询退化成全表扫描。
const ensureIndexes = collection => {
  if (!indexPromise) {
    indexPromise = Promise.all([
      collection.createIndex({ managerId: 1, customerId: 1 }, { unique: true }),
      collection.createIndex({ managerId: 1, updatedAt: -1 }),
    ]).catch(() => { indexPromise = undefined; });
  }
  return indexPromise;
};

const getClient = () => {
  const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || "").trim();
  if (!mongoUri) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    clientPromise = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    }).connect().catch(error => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
};

const getDb = async () => {
  const client = await getClient();
  const dbName = String(process.env.MONGODB_DB_NAME || "").trim();
  return client.db(dbName || undefined);
};

export const TOPIC_LIBRARY_COLLECTION = "topic_libraries";
export const TOPIC_LIBRARY_REPORT_TYPE = "topic_library";

/** 一个库最多纳入多少个对标账号 / 每个账号最多多少个大类。够用且挡住异常输入。 */
export const TOPIC_LIBRARY_MAX_ACCOUNTS = 20;
export const TOPIC_LIBRARY_MAX_CATEGORIES = 40;
export const TOPIC_LIBRARY_MAX_SUBCATEGORIES = 80;

const asText = value => String(value ?? "").trim();

const toIso = value => (value instanceof Date ? value.toISOString() : asText(value));

const cleanText = (value, maxLength = 900) => asText(value).replace(/\s+/g, " ").slice(0, maxLength);

/**
 * 占比：保留一位小数。
 *
 * 不能复用 `asNumber` —— 它 `Math.round` 成整数，会把 8.3% 存成 8%，
 * 而「样本占比」是用户明确要求保留的判断依据（HANDOFF §0.1 第 3 条）。
 */
const asPercent = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 10) / 10 : 0;
};

const asNumber = value => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
};

/**
 * 入参类错误：在 store 里就把 HTTP 状态标好。
 *
 * 路由层据此返回 400 —— **不要靠正则去猜错误消息**。踩过的坑：
 * `getCustomer` 抛的是 `Invalid customer id`（首字母大写 + 空格），
 * 而路由里的正则写的是 `/invalid|customerId/`，于是这个本该 400 的入参错误
 * 被当成 500；反过来，E11000 的报错文本里含有 `customerId` 字段名，
 * 真正的服务端故障又被误判成 400 并把驱动原文回显给用户。
 */
const badRequest = message => {
  const error = new Error(message);
  error.status = 400;
  return error;
};

const ownerObjectId = ownerId => {
  const value = asText(ownerId);
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
};

/**
 * 分类 id 必须带账号作用域。
 *
 * 两个对标账号各有一个叫「风险防御」的大类时，不带前缀就会撞成同一个 id，
 * 于是新视频的标签会指向错误的账号 —— 而这正是「不许自动合并」要防的事。
 */
export const scopedCategoryId = (accountKey, categoryId) => `${asText(accountKey)}::${asText(categoryId)}`;
export const scopedSubcategoryId = (accountKey, categoryId, subcategoryId) =>
  `${scopedCategoryId(accountKey, categoryId)}::${asText(subcategoryId)}`;

/**
 * 账号在库内的稳定 key —— **只由报告内容决定，绝不掺入它在库里的位置**。
 *
 * ⚠️ 早先的实现把数组下标写进兜底 key（`account-${index+1}-${name}`），而调用方传的是
 * `accounts.length`：于是「没有 id、也没有链接」的报告重复入库时，key 从 `account-1-X`
 * 变成 `account-2-X`，去重落空、同一个账号被追加成两份。key 必须与位置无关。
 */
const accountKeyOf = report => {
  const reportId = asText(report?.id || report?._id);
  if (reportId) return `report-${reportId}`;
  const url = asText(report?.accountUrl || report?.account?.url);
  if (url) return `url-${url}`;
  // 只剩账号名可用：仍然只用内容，不用位置。同名账号会被视作同一个（好过去重失效）。
  const name = cleanText(report?.accountName || report?.account?.name, 60);
  const platform = asText(report?.account?.platform).toLowerCase() === "tiktok" ? "tiktok" : "douyin";
  return `name-${platform}-${name || "unknown"}`;
};

/** 从一份报告正文里取出它覆盖的视频 id 集合（2.1 用 `videos`，2.2/2.3 用 `items`）。 */
const videoIdSet = report => new Set(
  (Array.isArray(report?.videos) ? report.videos : Array.isArray(report?.items) ? report.items : [])
    .map(item => asText(item?.id || item?.videoId))
    .filter(Boolean),
);

/** 把 2.1 的分类树压成库里的形状：判断依据 + 样本占比全部保留。 */
const buildCategories = (report, accountKey) => (
  (Array.isArray(report?.categories) ? report.categories : [])
    .slice(0, TOPIC_LIBRARY_MAX_CATEGORIES)
    .map((category, categoryIndex) => {
      const source = category && typeof category === "object" ? category : {};
      const categoryId = cleanText(source.id, 160) || `category-${categoryIndex + 1}`;
      const scoped = scopedCategoryId(accountKey, categoryId);
      const subcategories = (Array.isArray(source.subcategories) ? source.subcategories : [])
        .slice(0, TOPIC_LIBRARY_MAX_SUBCATEGORIES)
        .map((subcategory, subIndex) => {
          const subSource = subcategory && typeof subcategory === "object" ? subcategory : {};
          const subcategoryId = cleanText(subSource.id, 160) || `subcategory-${categoryIndex + 1}-${subIndex + 1}`;
          return {
            id: scopedSubcategoryId(accountKey, categoryId, subcategoryId),
            sourceId: subcategoryId,
            name: cleanText(subSource.name, 120),
            description: cleanText(subSource.description, 360),
          };
        })
        .filter(item => item.name);
      return {
        id: scoped,
        sourceId: categoryId,
        name: cleanText(source.name, 120),
        // 口播大类靠这两项判断，演绎大类不写它们（允许为空，前端按需展示）。
        coreFunction: cleanText(source.coreFunction, 500),
        keywords: Array.isArray(source.keywords)
          ? source.keywords.map(item => cleanText(item, 80)).filter(Boolean).slice(0, 20)
          : [],
        count: asNumber(source.count),
        // 上游 2.1 产出的占比是「一位小数」（Math.round(count/total*1000)/10），
        // 这里不能走 asNumber（它会四舍五入成整数），否则用户要求的样本占比会掉精度。
        percentage: asPercent(source.percentage),
        subcategories,
      };
    })
    // 没有小类的分类没法给新视频打「小类」标签，按要求整条剔除（与 benchmarkTopicRefresh 一致）。
    .filter(category => category.name && category.subcategories.length > 0)
);

/**
 * 库里账号条目的形状：**三份分析**（2.1 分类 / 2.2 黄金三秒 / 2.3 结尾钩子）。
 *
 * 用户要求库不只纳入分类报告，也要纳入 2.2 与 2.3（2026-09-21）。
 * 每份分析的 `status` 如实说明它到底进没进来：
 *   - `included`        已纳入
 *   - `missing`         还没跑过/没保存过这份分析
 *   - `sample_mismatch` 找到了同类报告，但采样不是同一批视频 —— 不敢硬塞
 * 取不到就标 `missing`，**绝不拿别的报告顶替**。
 */
export const buildLibraryAccount = ({ report, goldThreeSeconds = null, endingHooks = null } = {}) => {
  const accountKey = accountKeyOf(report);
  const contentStyle = asText(report?.contentStyle) === "drama" ? "drama" : "spoken";
  const categories = buildCategories(report, accountKey);
  const snapshot = source => {
    if (!source?.report) return null;
    return {
      reportId: asText(source.id),
      analyzedAt: toIso(source.report?.analyzedAt),
      report: source.report,
    };
  };

  return {
    accountKey,
    // 来源追溯：库条目要能指回它是从哪一份 2.1 报告来的。
    sourceReportId: asText(report?.id || report?._id),
    accountName: cleanText(report?.accountName || report?.account?.name, 160),
    accountUrl: cleanText(report?.accountUrl || report?.account?.url, 1000),
    platform: asText(report?.account?.platform) === "tiktok" ? "tiktok" : "douyin",
    contentStyle,
    contentStyleLabel: cleanText(report?.contentStyleLabel, 40) || (contentStyle === "drama" ? "演绎类" : "口播类"),
    analyzedCount: asNumber(report?.analyzedCount),
    analyses: {
      classification: { status: categories.length > 0 ? "included" : "missing", ...(snapshot({ id: report?.id || report?._id, report }) || { reportId: "", analyzedAt: "", report: null }), categories },
      goldThreeSeconds: { status: goldThreeSeconds?.report ? "included" : "missing", ...(snapshot(goldThreeSeconds) || { reportId: "", analyzedAt: "", report: null, categories: [] }) },
      endingHooks: { status: endingHooks?.report ? "included" : "missing", ...(snapshot(endingHooks) || { reportId: "", analyzedAt: "", report: null, categories: [] }) },
    },
    addedAt: new Date().toISOString(),
  };
};

/**
 * 把库里某个账号要用的三份分析找齐。
 *
 * ⚠️ 2.2 / 2.3 的报告里**没有存来源分类报告的 id**（只存了 account），所以不能靠
 * 报告 id 或账号名关联 —— 按账号名匹配正是被明令禁止的做法。这里改用**采样视频集合**
 * 关联：2.2/2.3 都走 `selectStageVideos`，样本与 2.1 的报告必须完全一致
 * （HANDOFF §3.4(d) 的回归测试就是钉这件事）。完全一致优先，其次 90% 以上重叠。
 * 找不到就留空，由 UI 如实显示「还没纳入」。
 */
export const findAccountAnalyses = async ({ ownerId, classificationReport } = {}) => {
  const targetIds = videoIdSet(classificationReport);
  const matchAgainst = async (listReports, getReport) => {
    if (targetIds.size === 0) return null;
    const summaries = await listReports({ ownerId, limit: 50 }).catch(() => []);
    let best = null;
    let bestScore = 0;
    for (const summary of Array.isArray(summaries) ? summaries : []) {
      const full = await getReport({ ownerId, id: summary?.id }).catch(() => null);
      const ids = videoIdSet(full?.report);
      if (ids.size === 0) continue;
      const overlap = Array.from(ids).filter(id => targetIds.has(id)).length;
      const equal = ids.size === targetIds.size && overlap === targetIds.size;
      const score = equal ? 1 : overlap / Math.max(ids.size, targetIds.size);
      if (score > bestScore) { bestScore = score; best = full; }
    }
    return bestScore >= 0.9 ? best : null;
  };

  const [goldThreeSeconds, endingHooks] = await Promise.all([
    matchAgainst(listGoldThreeSecondReports, getGoldThreeSecondReport),
    matchAgainst(listEndingHookReports, getEndingHookReport),
  ]);
  return { goldThreeSeconds, endingHooks };
};

/** 旧文档只有顶层 `categories`（没有 `analyses`）。统一在这里补成新形状。 */
const normalizeAnalyses = account => {
  const analyses = account?.analyses && typeof account.analyses === "object" ? account.analyses : {};
  const legacyCategories = Array.isArray(account?.categories) ? account.categories : [];
  const classification = analyses.classification && typeof analyses.classification === "object"
    ? analyses.classification
    : { status: legacyCategories.length > 0 ? "included" : "missing", reportId: "", analyzedAt: "", report: null, categories: legacyCategories };
  const ensure = (value, fallbackStatus = "missing") => ({
    status: asText(value?.status) || fallbackStatus,
    reportId: asText(value?.reportId),
    analyzedAt: toIso(value?.analyzedAt),
    report: value?.report || null,
    categories: Array.isArray(value?.categories) ? value.categories : [],
  });
  return {
    classification: ensure(classification),
    goldThreeSeconds: {
      ...ensure(analyses.goldThreeSeconds),
      // 2.2 的配比与类型分布都在报告正文里，这里只补一个空数组占位，保持形状一致。
      categories: [],
    },
    endingHooks: { ...ensure(analyses.endingHooks), categories: [] },
  };
};

const serializeAccount = account => {
  const analyses = normalizeAnalyses(account);
  return {
    accountKey: asText(account?.accountKey),
    sourceReportId: asText(account?.sourceReportId),
    accountName: asText(account?.accountName),
    accountUrl: asText(account?.accountUrl),
    platform: asText(account?.platform) || "douyin",
    contentStyle: asText(account?.contentStyle) || "spoken",
    contentStyleLabel: asText(account?.contentStyleLabel) || "口播类",
    analyzedCount: asNumber(account?.analyzedCount),
    analyses,
    // 兼容别名：分类树仍然从 classification 里取，老调用方不用改。
    categories: analyses.classification.categories,
    addedAt: toIso(account?.addedAt),
  };
};

/**
 * 列表用途的元数据：**故意不带 `accounts` 正文**。
 *
 * 一个账号的库快照约 4 KB（整棵分类树 + 判断依据），5 个账号近 20 KB；列表一次拉
 * 200 个客户就是数 MB，而调用方只是想「看哪个客户已经有库、里面放了谁」。库内明细
 * 按 customerId 单取（与 `benchmarkProfileStore` 的 serializeSummary 同一套契约）。
 */
export const serializeTopicLibrarySummary = (document, accountNames = [], accountCount = 0) => ({
  id: String(document._id),
  reportType: TOPIC_LIBRARY_REPORT_TYPE,
  customerId: asText(document.customerId),
  customerName: asText(document.customerName),
  // 账号数按 **accountKey** 去重后的真实条数，不是名字去重后的个数（两者会不等）。
  accountCount: accountCount || accountNames.length,
  // 只带账号名：`accounts` 被排除掉了，数不到长度，所以由调用方单独取一次名字。
  accountNames,
  createdAt: toIso(document.createdAt),
  updatedAt: toIso(document.updatedAt),
});

export const serializeTopicLibrary = document => ({
  id: String(document._id),
  reportType: TOPIC_LIBRARY_REPORT_TYPE,
  customerId: asText(document.customerId),
  customerName: asText(document.customerName),
  accountCount: Array.isArray(document.accounts) ? document.accounts.length : 0,
  accounts: (Array.isArray(document.accounts) ? document.accounts : []).map(serializeAccount),
  createdAt: toIso(document.createdAt),
  updatedAt: toIso(document.updatedAt),
});

/**
 * 跨账号的扁平标签词典，供新视频打标签使用。
 *
 * `label` 带账号名前缀：两个账号有同名小类时，Agent 与界面都能分辨标签的归属，
 * 而不是把「同名」误当成「同一个分类」。
 */
export const buildTagDictionary = accounts => {
  const list = Array.isArray(accounts) ? accounts : [];
  const withAccountPrefix = list.filter(item => item?.accountKey).length > 1;
  return list.flatMap(account => {
    // 旧文档没有 `analyses`，统一在这里补齐；只算一次，别在 map 里重复调用。
    const categories = normalizeAnalyses(account).classification.categories;
    return (Array.isArray(categories) ? categories : []).map(category => ({
      id: category.id,
      name: cleanText(category.name, 120),
      label: withAccountPrefix
        ? `${cleanText(account.accountName, 60) || "对标账号"} · ${cleanText(category.name, 120)}`
        : cleanText(category.name, 120),
      coreFunction: cleanText(category.coreFunction, 500),
      keywords: Array.isArray(category.keywords) ? category.keywords : [],
      subcategories: (Array.isArray(category.subcategories) ? category.subcategories : []).map(item => ({
        id: item.id,
        name: cleanText(item.name, 120),
        label: withAccountPrefix
          ? `${cleanText(account.accountName, 60) || "对标账号"} · ${cleanText(item.name, 120)}`
          : cleanText(item.name, 120),
      })),
    }));
  });
};

/**
 * 建库 / 追加账号（幂等）。
 *
 * 一个客户一份库，按 `{ managerId, customerId }` upsert；同一份报告重复纳入时按
 * `accountKey` 覆盖那一条。
 *
 * ⚠️ **不能用「读出来 → 改数组 → 整份写回」**：那是 read-modify-write，并发保存时
 * 后写的会把先写的账号整段覆盖掉，而两个请求都返回 201（唯一索引只保护文档不保护数组）。
 * 这里改成**单次原子更新**：`$pull` 摘掉同 key 的旧条目，再用 `$concatArrays` 把它接到末尾。
 * `$pull` + `$push` 不能同时作用于同一字段（MongoDB 会直接报错），所以用聚合管道。
 */
export async function saveTopicLibrary({ ownerId, customer, report } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw badRequest("Invalid manager identity");
  if (!report || typeof report !== "object") throw badRequest("report is required");
  if (report.reportType !== "benchmark_classification") {
    throw badRequest("invalid benchmark classification report");
  }

  const customerId = asText(customer?.id);
  const customerName = cleanText(customer?.name, 160);
  if (!customerId) {
    throw badRequest("customerId is required");
  }

  const db = await getDb();
  const collection = db.collection(TOPIC_LIBRARY_COLLECTION);
  await ensureIndexes(collection);

  // 用户要求：正式选题库不只纳入 2.1 分类报告，也要纳入 2.2 黄金三秒与 2.3 结尾钩子。
  // 2.2/2.3 的报告里没有存来源分类报告的 id，所以按**采样视频集合**关联（见
  // findAccountAnalyses 的注释）。找不到就如实标 missing，不拿别的报告顶替。
  const matched = await findAccountAnalyses({ ownerId, classificationReport: report }).catch(() => ({
    goldThreeSeconds: null,
    endingHooks: null,
  }));

  const nextAccount = buildLibraryAccount({
    report,
    goldThreeSeconds: matched.goldThreeSeconds,
    endingHooks: matched.endingHooks,
  });
  // ⚠️ 分类树现在在 `analyses.classification.categories` 下面（顶层 `categories` 只是
  // 序列化时的兼容别名）。这里读错路径会让**每一次保存都抛异常**。
  if (nextAccount.analyses.classification.categories.length === 0) {
    throw badRequest("这份分类报告没有可用的大类/小类，无法入选题库");
  }

  const filter = { managerId, customerId };
  // 先看一眼这条账号在不在（只为两件事：保留 addedAt、判断是否要查上限）。
  const existingDoc = await collection.findOne(filter, { projection: { accounts: 1 } });
  const existingAccounts = Array.isArray(existingDoc?.accounts) ? existingDoc.accounts : [];
  const existingAccount = existingAccounts.find(item => asText(item?.accountKey) === nextAccount.accountKey);

  if (!existingAccount && existingAccounts.length >= TOPIC_LIBRARY_MAX_ACCOUNTS) {
    // 上限是保护性规则，不是并发敏感的硬约束：只读判断就够，且不会误伤「覆盖已有账号」。
    throw badRequest(`一个选题库最多纳入 ${TOPIC_LIBRARY_MAX_ACCOUNTS} 个对标账号`);
  }

  const now = new Date();
  const updated = await collection.findOneAndUpdate(
    filter,
    [
      {
        $set: {
          managerId,
          customerId,
          // 库里冗余存客户名：客户改名后旧库仍能显示它入库时的归属，便于人工核对。
          // 本次拿不到名字时保留原有的，不要把已有名字清空。
          customerName: customerName || { $ifNull: ["$customerName", ""] },
          reportType: TOPIC_LIBRARY_REPORT_TYPE,
          accounts: {
            $concatArrays: [
              // 摘掉同 key 的旧条目（幂等：同一份报告重复纳入只会覆盖，不会追加）
              {
                $filter: {
                  input: { $ifNull: ["$accounts", []] },
                  as: "account",
                  cond: { $ne: ["$$account.accountKey", nextAccount.accountKey] },
                },
              },
              // 再接上新的那条；覆盖时保留原有 addedAt，让重复纳入是无感的。
              [{ $mergeObjects: [nextAccount, { addedAt: existingAccount?.addedAt || nextAccount.addedAt }] }],
            ],
          },
          updatedAt: now,
          createdAt: { $ifNull: ["$createdAt", now] },
        },
      },
    ],
    { upsert: true, returnDocument: "after" },
  );

  // 并发删除可能在 upsert 之后让文档消失；如实报错，不要解引用 null 崩成 500。
  const saved = updated?.value ?? updated;
  if (!saved || !Array.isArray(saved.accounts)) throw new Error("选题库保存后读取失败，请重试");
  return serializeTopicLibrary(saved);
}

/**
 * 把某个账号从库里移除。
 *
 * 用 `$pull` 原子地改数组（不是「读出来 → 改 → 整份写回」），并且**如实报告是否真删到东西**：
 * 早先的实现无论 key 匹不匹配都返回 `removedAccount: true`，于是两个端点那个 404 分支
 * 永远不会走到，用户拿一个过期的 accountKey 点「移除」会看到成功提示、账号其实还在，
 * 而且 `updatedAt` 还被无意义地刷新了一次。
 */
export async function removeTopicLibraryAccount({ ownerId, customerId, accountKey } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw badRequest("Invalid manager identity");
  const key = asText(accountKey);
  if (!key) throw badRequest("accountKey is required");
  const owner = asText(customerId);

  const db = await getDb();
  const collection = db.collection(TOPIC_LIBRARY_COLLECTION);
  await ensureIndexes(collection);

  const filter = { managerId, customerId: owner };
  // ⚠️ `$pull` 必须**单独**发一次，不能顺手带上 `$set: { updatedAt }`：
  // 那样即使 key 一个都没匹配上，`modifiedCount` 也会变成 1（时间戳被改了），
  // 于是「什么都没删到」被误判成「删成功了」—— 这个假成功正是要修的东西。
  const pullResult = await collection.updateOne(filter, { $pull: { accounts: { accountKey: key } } });

  // matchedCount 0 → 这个客户压根没有库（或不是本人的库）。
  if (pullResult.matchedCount === 0) return { deleted: false, removedAccount: false };

  const removedAccount = pullResult.modifiedCount > 0;
  if (!removedAccount) return { deleted: false, removedAccount: false };
  const remaining = await collection.countDocuments({ ...filter, "accounts.0": { $exists: true } });
  if (remaining === 0) {
    // 最后一个账号被移除后不留空壳库，否则「已建库」的状态会撒谎。
    // 条件删除：并发下若又有人加了账号，这次删除不会命中。
    const deletion = await collection.deleteOne({ ...filter, "accounts.0": { $exists: false } });
    return { deleted: deletion.deletedCount > 0, removedAccount, libraryDeleted: deletion.deletedCount > 0 };
  }

  // 真删到了才刷新 updatedAt（放在最后，避免无意义地改动文档）。
  await collection.updateOne(filter, { $set: { updatedAt: new Date() } });
  return { deleted: false, removedAccount };
}

/**
 * 列表：只返回库级元数据，**不带 `accounts` 正文**（正文按 customerId 单取）。
 *
 * ⚠️ 不能用 `{ "accounts.categories": 0 }` 这种投影来做 —— MongoDB 的投影里
 * 除了 `_id` 之外**不能混用包含与排除**，那个写法会被服务端直接拒绝
 * （被冒烟测试逮到过）。这里的做法与 `benchmarkReportStore.listBenchmarkReports`
 * 排除 `report` 正文完全一致：整个重字段一起排除。
 */
export async function listTopicLibraries({ ownerId, limit = 50 } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw badRequest("Invalid manager identity");

  const db = await getDb();
  const collection = db.collection(TOPIC_LIBRARY_COLLECTION);
  await ensureIndexes(collection);

  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const documents = await collection
    .find({ managerId }, { projection: { accounts: 0 } })
    .sort({ updatedAt: -1 })
    .limit(safeLimit)
    .toArray();
  // 账号数与账号名单独取一次（只取字符串，不背分类树正文），列表因此既轻又能显示库里有谁。
  //
  // ⚠️ 计数必须 distinct **accountKey** 而不是 accountName：accountKey 每个账号唯一，
  // 而 accountName 会重复（两个抖音号同名、或同一账号用两种链接形式入库）。
  // 按名字去重会让列表的 accountCount 小于详情里的账号数，两处对不上。
  const withAccounts = await Promise.all(documents.map(async document => {
    const names = await collection.distinct("accounts.accountName", { _id: document._id, managerId });
    const keys = await collection.distinct("accounts.accountKey", { _id: document._id, managerId });
    return serializeTopicLibrarySummary(document, names.map(asText).filter(Boolean), keys.length);
  }));
  return withAccounts;
}

/**
 * 按客户取完整库（含分类树 + 标签词典）。
 * 必须同时按 managerId 过滤 —— 客户 id 不能成为跨项目经理读取别人选题库的入口。
 */
export async function getTopicLibrary({ ownerId, customerId } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw badRequest("Invalid manager identity");

  const db = await getDb();
  const collection = db.collection(TOPIC_LIBRARY_COLLECTION);
  await ensureIndexes(collection);

  const document = await collection.findOne({ managerId, customerId: asText(customerId) });
  if (!document) return null;
  const library = serializeTopicLibrary(document);
  return { ...library, tagDictionary: buildTagDictionary(library.accounts) };
}

// ── 轻量视图：只要「打标签用的分类词典」─────────────────────────────────────
//
// 🔴 为什么需要它（2026-09-21 用户反馈「读库等待时间特别长」）：
// 完整库正文里挂着每个账号的**三份报告快照**（2.1 分类 + 2.2 黄金三秒 + 2.3 结尾钩子，
// 单份分类报告正文就约 148 KB）。而员工端跑「新视频筛选打标签」**只用得到大类/小类**，
// 把三份报告一起拖回来纯属浪费：网络大、解析慢、首屏白等。
//
// 所以这里用**嵌套字段投影**只取分类树那一支（MongoDB 支持 `accounts.analyses.classification.categories`
// 这种点路径投影）：2.2/2.3 的报告正文、2.1 的报告正文、视频样本全都不出库。
// 打标签的词典**仍然带小类** —— 后端 `normalizeTopicLibrary` 会把没有小类的大类整个丢掉、
// 且只有大类+小类都命中才算有效标签，只给大类等于让所有条目落「待人工复核」。
const CATEGORY_DICTIONARY_PROJECTION = {
  customerId: 1,
  customerName: 1,
  updatedAt: 1,
  managerId: 1,
  "accounts.accountKey": 1,
  "accounts.accountName": 1,
  "accounts.contentStyleLabel": 1,
  "accounts.analyses.classification.categories": 1,
};

const toCategoryDictionary = document => {
  const accounts = Array.isArray(document.accounts) ? document.accounts : [];
  return {
    customerId: asText(document.customerId),
    customerName: asText(document.customerName),
    accountCount: accounts.length,
    updatedAt: toIso(document.updatedAt),
    tagDictionary: buildTagDictionary(accounts),
  };
};

/** 项目经理自己的库：只要分类词典（轻量）。 */
export async function getTopicCategoryDictionary({ ownerId, customerId } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw badRequest("Invalid manager identity");
  const target = asText(customerId);
  if (!target) throw badRequest("customerId is required");

  const db = await getDb();
  const collection = db.collection(TOPIC_LIBRARY_COLLECTION);
  await ensureIndexes(collection);
  const document = await collection.findOne(
    { managerId, customerId: target },
    { projection: CATEGORY_DICTIONARY_PROJECTION },
  );
  return document ? toCategoryDictionary(document) : null;
}

/**
 * 员工侧：只要分类词典（轻量）。
 *
 * 与 `getTopicLibraryForEmployee` 同一套边界：**不按 managerId 过滤**（员工不是库的属主）、
 * 不回 managerId、不回客户 IP 档案，只给「客户名 + 打标签要用的分类词典」。
 */
export async function getTopicCategoryDictionaryForEmployee({ customerId } = {}) {
  const target = asText(customerId);
  if (!target) throw badRequest("customerId is required");

  const db = await getDb();
  const collection = db.collection(TOPIC_LIBRARY_COLLECTION);
  await ensureIndexes(collection);
  const document = await collection.findOne(
    { customerId: target, "accounts.0": { $exists: true } },
    { projection: CATEGORY_DICTIONARY_PROJECTION },
  );
  return document ? toCategoryDictionary(document) : null;
}

// ── 员工侧（只读）────────────────────────────────────────────────────────────
//
// 🔴 选题库由**项目经理**建（写操作全部 manager-only）。员工要跑「新视频筛选打标签」，
// 需要把客户库里已有的分类当词典 —— 所以给员工开一条**只读**的路，且**故意收窄**：
//
//   - 不返回 `managerId`（员工不需要知道库是谁的，也不需要拿到内部身份）
//   - 不返回客户 IP 档案 / 访谈原文（那是 `customers.ipProfile` 的内容，与打标签无关）
//   - 只列出**真的有内容**的库，否则员工选到一个空库只会得到满屏「待人工复核」
//
// 这条边界是刻意画出来的：HANDOFF §0.1 明确「未经定义不得把经理报告打通给所有员工」，
// 所以这里放出去的只有「客户名 + 分类树」，不是整个客户名册。
// 只要词典（不要报告快照）时走上面的 `getTopicCategoryDictionary*`。

/** 员工可读的库列表：跨项目经理、只给有内容的库、不带 managerId。 */
export async function listTopicLibrariesForEmployee({ limit = 50 } = {}) {
  const db = await getDb();
  const collection = db.collection(TOPIC_LIBRARY_COLLECTION);
  await ensureIndexes(collection);

  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
  const documents = await collection
    .find({ "accounts.0": { $exists: true } }, { projection: { accounts: 0, managerId: 0 } })
    .sort({ updatedAt: -1 })
    .limit(safeLimit)
    .toArray();

  const items = await Promise.all(documents.map(async document => {
    const keys = await collection.distinct("accounts.accountKey", { _id: document._id });
    return {
      customerId: asText(document.customerId),
      customerName: asText(document.customerName),
      accountCount: keys.length,
      accountNames: (await collection.distinct("accounts.accountName", { _id: document._id })).map(asText).filter(Boolean),
      updatedAt: toIso(document.updatedAt),
    };
  }));
  return items.filter(item => item.customerId && item.accountCount > 0);
}

/**
 * 员工按客户取库（只读，用于取标签词典）。
 *
 * **不按 managerId 过滤**：员工不是库的属主，库属于建它的项目经理。
 * 这是本项目里第四种读取口径，与 §3.7(d) 的三种都不同，所以单独一个函数、单独注释。
 */
export async function getTopicLibraryForEmployee({ customerId } = {}) {
  const target = asText(customerId);
  if (!target) throw badRequest("customerId is required");

  const db = await getDb();
  const collection = db.collection(TOPIC_LIBRARY_COLLECTION);
  await ensureIndexes(collection);

  const document = await collection.findOne({ customerId: target, "accounts.0": { $exists: true } });
  if (!document) return null;
  const library = serializeTopicLibrary(document);
  return {
    // 刻意不回 managerId。
    id: library.id,
    reportType: library.reportType,
    customerId: library.customerId,
    customerName: library.customerName,
    accountCount: library.accountCount,
    accounts: library.accounts,
    updatedAt: library.updatedAt,
    tagDictionary: buildTagDictionary(library.accounts),
  };
}

/**
 * 员工侧：只要「大类 → 三秒 / 结尾钩子配比」（用于内容生成页的二创适配）。
 *
 * 🔴 **这是第三种轻量投影，别和上面两个混用**：
 *   - `CATEGORY_DICTIONARY_PROJECTION` 给**打标签**用（分类树），里面**没有配比**；
 *   - 本投影给**二创适配**用（配比），**不取分类树**——二创只要大类配比，不需要小类。
 *
 * ⚠️ 两者取数口径本来就不同，**不要为了「省一个函数」把它们合并**：
 * 打标签必须带小类（`normalizeTopicLibrary` 会把没有小类的大类整个丢掉），
 * 二创只要大类的配比，多取 80 个小类纯属浪费。
 *
 * 必须把 `report` 整份取出来才能读到 `categoryBreakdown` / `typeDistribution`
 * —— 那两个字段是 2.2/2.3 **报告正文**的一部分，不是库文档的顶层字段。
 * 它比分类树小得多（单份约 3~8 KB，且不含 60 条视频正文），可以接受。
 */
const CREATIVE_ADAPTATION_PROJECTION = {
  customerId: 1,
  customerName: 1,
  "accounts.accountKey": 1,
  "accounts.accountName": 1,
  "accounts.analyses.goldThreeSeconds.report": 1,
  "accounts.analyses.endingHooks.report": 1,
};

/**
 * 取「大类 → 配比」的轻量视图。
 *
 * **不按 managerId 过滤**：员工要为任意客户的选题库做二创适配，而库属于建它的项目经理。
 * 这与 `getTopicCategoryDictionaryForEmployee` 是同一条边界，所以同样只回
 * 「客户名 + 两份报告的配比来源」，不回 managerId、不回客户 IP 档案、不回分类树。
 */
export async function getTopicLibraryCreativeAdaptation({ customerId } = {}) {
  const target = asText(customerId);
  if (!target) throw badRequest("customerId is required");

  const db = await getDb();
  const collection = db.collection(TOPIC_LIBRARY_COLLECTION);
  await ensureIndexes(collection);
  const document = await collection.findOne(
    { customerId: target, "accounts.0": { $exists: true } },
    { projection: CREATIVE_ADAPTATION_PROJECTION },
  );
  if (!document) return null;

  return {
    customerId: asText(document.customerId),
    customerName: asText(document.customerName),
    accounts: (Array.isArray(document.accounts) ? document.accounts : []).map(account => ({
      accountKey: asText(account?.accountKey),
      accountName: asText(account?.accountName),
      // 库允许只纳入其中一份分析，取不到就是 null（调用方如实降级）。
      goldThreeSeconds: account?.analyses?.goldThreeSeconds?.report || null,
      endingHooks: account?.analyses?.endingHooks?.report || null,
    })),
  };
}

/** 删除整个库（客户维度）。 */
export async function deleteTopicLibrary({ ownerId, customerId } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw badRequest("Invalid manager identity");

  const db = await getDb();
  const result = await db.collection(TOPIC_LIBRARY_COLLECTION).deleteOne({
    managerId,
    customerId: asText(customerId),
  });
  return { deleted: result.deletedCount > 0 };
}
