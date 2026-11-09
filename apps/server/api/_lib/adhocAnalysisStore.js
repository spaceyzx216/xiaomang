/**
 * 员工「临时分析」—— 不关联任何客户的对标账号分析记录。
 *
 * ── 为什么会有这个 store ──────────────────────────────────────────────────────
 *
 * 员工原本**只能**从「今日任务」进入工作流：任务由项目经理布置、绑定一个客户，
 * 点任务卡时前端把 task 写进 `sessionStorage.contentTasks` 再跳 `/topics`。
 * 于是没有任务时，「今天还没有待处理任务」那个空状态**没有任何出口** ——
 * 而员工有时就是需要分析一个**不属于任何客户**的对标账号（自用调研、临时接的号）。
 *
 * 这条路径不需要新的分析链路（下游 `/topics` → `/content` → `/final-editor`
 * 本来就不依赖 task，全部是 `activeTask?.x || "未提供"`），**缺的只是一扇门**。
 * 本 store 负责给那扇门留痕：员工回头能找到自己分析过哪些账号。
 *
 * ── 🔴 隔离规则与其它集合都不同，别照抄 ────────────────────────────────────────
 *
 * 报告类 store 按 `managerId` 隔离（项目经理各看各的）；`customers` 反过来
 * **不隔离**（公司共用名册）。这里是第三种：
 *
 *   **员工私有** —— 每一次读、写、删都必须带 `userId` 过滤，
 *   删除时 `userId` 必须进 filter，否则记录 id 会变成**跨员工读写/删除**的入口
 *   （与 HANDOFF §6.2⑥「按 id 取单份和删除都必须带 managerId 过滤」是同一条原则）。
 *   项目经理看不到这些记录，端点只用 `requireEmployee` 保护（manager 调用得 403）。
 *
 * ⚠️ 它**不是**任务：不要写回 `tasks` 集合，也不参与今日任务的三个计数。
 *   前端靠 `_id` 的 `adhoc-` 前缀识别它，从而与真实客户任务区分开。
 */
import { MongoClient, ObjectId } from "mongodb";
import { getTopicLibraryForEmployee } from "./topicLibraryStore.js";

const COLLECTION = "adhoc_analyses";

let clientPromise;

const getClient = () => {
  const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || "").trim();
  if (!mongoUri) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    clientPromise = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    }).connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
};

const getDb = async () => {
  const client = await getClient();
  const mongoDbName = String(process.env.MONGODB_DB_NAME || "").trim();
  return client.db(mongoDbName || undefined);
};

/**
 * 平台是有限枚举。**只写一份** —— 表单选项、`platformName` 标签都从这里来，
 * 前端不要再另写一个平台列表。
 */
export const ADHOC_PLATFORMS = [
  { key: "douyin", label: "抖音" },
  { key: "wechat_channels", label: "视频号" },
  { key: "tiktok", label: "TikTok" },
];

const PLATFORM_KEYS = ADHOC_PLATFORMS.map(item => item.key);

export const adhocPlatformLabel = (key) => (
  ADHOC_PLATFORMS.find(item => item.key === key)?.label || "抖音"
);

export const DEFAULT_ADHOC_TITLE = "临时分析";
export const MAX_ADHOC_TITLE = 60;
const MAX_ADHOC_TARGET = 600;

/** 列表一次最多返回多少条。**只截断返回，不删用户数据**（静默删数据比列表短更糟）。 */
export const ADHOC_LIST_LIMIT = 50;

const asText = (value, maxLength) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);

/**
 * 校验并规范化**创建**入参。
 *
 * **纯函数、不碰数据库** —— 单测直接打这里，不需要 MongoDB
 * （HANDOFF §6.5㉕：store 本身要真实库，所以不能进 `npm test`）。
 *
 * ⚠️ `benchmarkAccounts` **刻意保留换行**：它会被预填进 `/topics` 的抓取框，
 * 而那边的解析是按行/逗号拆的（`parseLines` / `parseBenchmarkLinks`）。
 * 把换行压成空格会让「每行一个链接」变成一行乱码。只做「逐行 trim + 丢空行」。
 */
export const normalizeAdhocInput = (input) => {
  const source = input && typeof input === "object" ? input : {};

  const benchmarkAccounts = String(source.benchmarkAccounts ?? "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_ADHOC_TARGET);

  // 视频号这一路填的是**账号名称**而不是链接（与 /topics 的输入框口径一致），
  // 所以这里不能要求它长得像 URL —— 只要求非空。
  if (!benchmarkAccounts) return { ok: false, error: "请填写要分析的对标账号链接或账号名称" };

  const requested = String(source.platform || "").trim();
  const platform = PLATFORM_KEYS.includes(requested) ? requested : "douyin";

  // 客户绑定（选填）。绑了才能用客户选题库里的分类给新视频打标签。
  // 这里只做格式校验；「这个客户到底有没有库」由 createAdhocAnalysis 查库确认。
  const rawCustomerId = String(source.customerId ?? "").trim();

  return {
    ok: true,
    value: {
      title: asText(source.title, MAX_ADHOC_TITLE) || DEFAULT_ADHOC_TITLE,
      benchmarkAccounts,
      platform,
      customerId: rawCustomerId,
    },
  };
};

/** 库里的文档 → 前端形状。多带一个 `platformName`，省得前端再映射一次平台标签。 */
const normalizeAdhoc = (doc) => {
  const platform = PLATFORM_KEYS.includes(doc.platform) ? doc.platform : "douyin";
  return {
    id: String(doc._id),
    title: asText(doc.title, MAX_ADHOC_TITLE) || DEFAULT_ADHOC_TITLE,
    benchmarkAccounts: String(doc.benchmarkAccounts || "").trim(),
    platform,
    platformLabel: adhocPlatformLabel(platform),
    platformName: adhocPlatformLabel(platform),
    // 客户绑定（旧记录没有这两个字段，如实回空串，由前端显示「未绑定客户」）。
    customerId: String(doc.customerId || "").trim(),
    customerName: String(doc.customerName || "").trim(),
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt || ""),
  };
};

const requireUserId = (value) => {
  const id = String(value || "").trim();
  if (!ObjectId.isValid(id)) throw new Error("Invalid adhoc analysis user identity");
  return new ObjectId(id);
};

/** 当前员工自己的临时分析，新的在前。 */
export async function listAdhocAnalyses(userId) {
  const owner = requireUserId(userId);
  const db = await getDb();
  const docs = await db.collection(COLLECTION)
    .find({ userId: owner })
    .sort({ createdAt: -1 })
    .limit(ADHOC_LIST_LIMIT)
    .toArray();
  return docs.map(normalizeAdhoc);
}

/** 新建一条。入参不合法时**不抛异常**，返回 `{ ok:false, error }` 让端点如实回 400。 */
export async function createAdhocAnalysis(userId, input) {
  const owner = requireUserId(userId);
  const normalized = normalizeAdhocInput(input);
  if (!normalized.ok) return normalized;

  const { customerId, ...rest } = normalized.value;

  // 客户绑定必须指向一个**真的有选题库**的客户。
  // 这样绑上就一定能拿到打标签的词典；绑一个空客户只会让员工在界面上撞一堵墙。
  // 客户名从库里取，前端不用再查一次客户名册（`customers` 是经理专属端点）。
  let customerName = "";
  if (customerId) {
    const library = await getTopicLibraryForEmployee({ customerId });
    if (!library) return { ok: false, error: "这个客户还没有正式选题库，请让项目经理先在账号定位里建库" };
    customerName = library.customerName || "";
  }

  const db = await getDb();
  const doc = {
    userId: owner,
    ...rest,
    ...(customerId ? { customerId, customerName } : {}),
    createdAt: new Date(),
  };
  const result = await db.collection(COLLECTION).insertOne(doc);
  return { ok: true, item: normalizeAdhoc({ ...doc, _id: result.insertedId }) };
}

/** 删除自己的一条。`userId` 在 filter 里 —— 别人的 id 传进来只会得到 `deleted:false`。 */
export async function deleteAdhocAnalysis(userId, id) {
  const owner = requireUserId(userId);
  if (!ObjectId.isValid(String(id || "").trim())) return { deleted: false };

  const db = await getDb();
  const result = await db.collection(COLLECTION).deleteOne({
    _id: new ObjectId(String(id).trim()),
    userId: owner,
  });
  return { deleted: result.deletedCount === 1 };
}
