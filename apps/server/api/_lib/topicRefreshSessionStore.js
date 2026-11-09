import { createHash } from "node:crypto";

import { MongoClient, ObjectId } from "mongodb";

/**
 * 「新更新视频筛选与打标签」的**会话**（员工在某个客户下的一次处理）。
 *
 * ── 为什么要落库（2026-09-21 用户拍板 B2）──────────────────────────────────
 * 打标签实测要几十秒到几分钟（转写 ~10-15s/条 + 模型调用有 ~20s 固定开销），
 * 而在此之前**所有中间结果都只活在前端内存里**：刷新一下、切个页面、手滑按到返回，
 * 之前花的钱和等待全没了 —— 用户只能干等，正是因为不敢走开。
 * 落库之后：离开再回来直接续上，接着往下跑。
 *
 * ── 存什么 ──────────────────────────────────────────────────────────────────
 * - `videos`：抓取到的候选（标题/点赞/链接），没有它光有标签也没用；
 * - `items`：**判完的条目**（含脚本、大类/小类、置信度、依据），即用户在界面上看到的那一份；
 * - `dictionaryHash`：当时用的是哪一版词典。选题库改了以后旧标签可能不再适用，
 *   界面上给的是「重新打标签」入口，**不自动作废**（用户明确点过才重跑，避免白烧钱）。
 *
 * ── 隔离 ────────────────────────────────────────────────────────────────────
 * 按 `{ managerId, customerId }` 唯一 —— 这里存的是**当前用户自己**的临时处理进度，
 * 与选题库（项目经理建、员工只读）是两回事：员工自己的进度别的员工看不到，反之亦然。
 */

const COLLECTION = "topic_refresh_sessions";
/** 单条脚本存进会话时的截断上限：60 条 × 4000 字 ≈ 240KB，远小于文档上限。 */
const MAX_SCRIPT_CHARS = 4000;
/** 会话里最多保留多少条候选（与后端分析上限一致）。 */
const MAX_VIDEOS = 60;

const asText = value => String(value ?? "").trim();

const badRequest = message => Object.assign(new Error(message), { status: 400 });

// 连接口径与其它 store 保持一致（各 store 各自持有一个 clientPromise，本项目既有惯例）
let clientPromise;
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

const ownerObjectId = value => {
  const text = asText(value);
  if (!ObjectId.isValid(text)) return null;
  return new ObjectId(text);
};

const toIso = value => (value instanceof Date ? value.toISOString() : asText(value));

/**
 * 词典指纹：只由「哪些分类、叫什么」决定，与视频无关。
 *
 * 用它来判断「这批标签是不是按同一版词典打出来的」。选 id + name 是因为：
 * id 决定归属（带账号作用域），name 决定模型看到的分类语义，任一变化都应视为换了词典。
 */
export const dictionaryFingerprint = categories => {
  const parts = (Array.isArray(categories) ? categories : []).map(category => {
    const subs = (Array.isArray(category?.subcategories) ? category.subcategories : [])
      .map(item => `${asText(item?.id)}:${asText(item?.name)}`)
      .join(",");
    return `${asText(category?.id)}:${asText(category?.name)}[${subs}]`;
  });
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
};

/** 会话里存的候选项：只留界面要用的字段，别把 provider 原始响应整包塞进来。 */
const normalizeStoredVideo = video => {
  const source = video && typeof video === "object" ? video : {};
  return {
    id: asText(source.id),
    title: asText(source.title),
    link: asText(source.link),
    authorName: asText(source.authorName),
    publishDate: asText(source.publishDate),
    sourceText: asText(source.sourceText).slice(0, 900),
    platform: asText(source.platform).toLowerCase() === "tiktok" ? "tiktok" : "douyin",
    stats: {
      likes: Number(source.stats?.likes) || 0,
      comments: Number(source.stats?.comments) || 0,
      shares: Number(source.stats?.shares) || 0,
      bookmarks: Number(source.stats?.bookmarks) || 0,
    },
  };
};

/** 会话里存的判完条目：形状与前端 `TopicRefreshItem` 一致，好让界面直接渲染。 */
const normalizeStoredItem = item => {
  const source = item && typeof item === "object" ? item : {};
  const video = normalizeStoredVideo(source.video);
  if (!video.id) return null;
  return {
    video,
    script: asText(source.script).slice(0, MAX_SCRIPT_CHARS),
    scriptSource: source.scriptSource === "transcript" ? "transcript" : "caption",
    category: { id: asText(source.category?.id), name: asText(source.category?.name) },
    subcategory: { id: asText(source.subcategory?.id), name: asText(source.subcategory?.name) },
    confidence: ["high", "medium", "low"].includes(asText(source.confidence)) ? asText(source.confidence) : "low",
    basis: asText(source.basis).slice(0, 500),
  };
};

const serialize = document => ({
  customerId: asText(document.customerId),
  accountUrl: asText(document.accountUrl),
  recentDays: Number(document.recentDays) || 7,
  minLikes: Number(document.minLikes) || 100,
  dictionaryHash: asText(document.dictionaryHash),
  videos: Array.isArray(document.videos) ? document.videos : [],
  items: Array.isArray(document.items) ? document.items : [],
  updatedAt: toIso(document.updatedAt),
});

/**
 * 保存/替换会话里的**候选列表**（每次抓完新视频调一次）。
 *
 * 与「标签」分开写：抓取会换掉整批候选，此时旧的标签必须一起清掉，
 * 否则会出现「这批视频没抓过，却带着上一批的标签」——那是最坏的一类脏数据。
 */
export async function saveTopicRefreshCandidates({ ownerId, customerId, accountUrl = "", recentDays = 7, minLikes = 100, videos = [] } = {}) {
  const owner = ownerObjectId(ownerId);
  if (!owner) throw badRequest("Invalid owner identity");
  const target = asText(customerId);
  if (!target) throw badRequest("customerId is required");

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);

  const list = (Array.isArray(videos) ? videos : []).map(normalizeStoredVideo).filter(video => video.id).slice(0, MAX_VIDEOS);
  const now = new Date();
  await collection.updateOne(
    { managerId: owner, customerId: target },
    {
      $set: {
        managerId: owner,
        customerId: target,
        accountUrl: asText(accountUrl),
        recentDays: Number(recentDays) || 7,
        minLikes: Number(minLikes) || 100,
        videos: list,
        // 换了候选 = 这一轮从头开始，旧标签必须清掉（见函数注释）
        items: [],
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  return { customerId: target, videoCount: list.length };
}

/**
 * 把**判完的条目**追加进会话（每批判完调一次）。
 *
 * ⚠️ 用聚合管道做「按 videoId 去重后追加」的**单次原子更新**：
 * `$pull` 与 `$push` 不能同时作用于同一字段（MongoDB 直接报错），
 * 而「读出来 → 改数组 → 整份写回」会在并发批次之间互相覆盖（两个请求都返回成功）。
 * 这个坑在 topicLibraryStore 里踩过，这里用同一套写法。
 */
export async function appendTopicRefreshItems({ ownerId, customerId, items = [], dictionaryHash = "" } = {}) {
  const owner = ownerObjectId(ownerId);
  if (!owner) throw badRequest("Invalid owner identity");
  const target = asText(customerId);
  if (!target) throw badRequest("customerId is required");

  const normalized = (Array.isArray(items) ? items : []).map(normalizeStoredItem).filter(Boolean);
  if (normalized.length === 0) return { appended: 0 };

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);

  const ids = normalized.map(item => item.video.id);
  const now = new Date();
  const result = await collection.updateOne(
    { managerId: owner, customerId: target },
    [
      {
        $set: {
          items: {
            $concatArrays: [
              {
                $filter: {
                  input: { $ifNull: ["$items", []] },
                  as: "existing",
                  cond: { $not: [{ $in: ["$$existing.video.id", ids] }] },
                },
              },
              normalized,
            ],
          },
          ...(dictionaryHash ? { dictionaryHash: asText(dictionaryHash) } : {}),
          updatedAt: now,
        },
      },
    ],
  );
  // 没有会话时不新建：没有候选列表的标签是孤儿数据，读出来也没法用
  return { appended: result.modifiedCount > 0 ? normalized.length : 0 };
}

/** 读会话（当前用户 + 客户）。没有就返回 null —— 调用方据此走「全新一轮」。 */
export async function getTopicRefreshSession({ ownerId, customerId } = {}) {
  const owner = ownerObjectId(ownerId);
  if (!owner) throw badRequest("Invalid owner identity");
  const target = asText(customerId);
  if (!target) throw badRequest("customerId is required");

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);
  const document = await collection.findOne({ managerId: owner, customerId: target });
  return document ? serialize(document) : null;
}

/** 清掉会话（用户点「重新开始」时用）。 */
export async function deleteTopicRefreshSession({ ownerId, customerId } = {}) {
  const owner = ownerObjectId(ownerId);
  if (!owner) throw badRequest("Invalid owner identity");
  const target = asText(customerId);
  if (!target) throw badRequest("customerId is required");

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);
  const result = await collection.deleteOne({ managerId: owner, customerId: target });
  return { deleted: result.deletedCount > 0 };
}

let indexPromise = null;
function ensureIndexes(collection) {
  if (!indexPromise) {
    indexPromise = collection.createIndex({ managerId: 1, customerId: 1 }, { unique: true }).catch(() => {});
  }
  return indexPromise;
}
