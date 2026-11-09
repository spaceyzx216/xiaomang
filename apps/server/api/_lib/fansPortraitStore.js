import { MongoClient, ObjectId } from "mongodb";

/**
 * 抖音粉丝画像的缓存。
 *
 * 与 transcriptStore / commentStore 同一套约定（按 managerId 收口、失败也缓存），
 * 但有一处**刻意的差别**：这两个是「一个视频一份、内容永不变」的缓存，
 * 而粉丝画像是**账号级、会随时间漂移**的（粉丝在涨、人群结构在变）。
 * 所以这里带 TTL：超过 `BENCHMARK_PORTRAIT_CACHE_DAYS`（默认 7 天）就当过期重抓，
 * 而不是永久钉死一份老数据。账号 ID 做键 —— 同一个账号换多少个对标任务都只付一次钱。
 */

const COLLECTION = "douyin_fans_portraits";

let clientPromise;
let indexPromise;

const asText = value => String(value ?? "").trim();

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

const ensureIndexes = collection => {
  if (!indexPromise) {
    indexPromise = Promise.all([
      collection.createIndex({ managerId: 1, secUserId: 1 }, { unique: true }),
      collection.createIndex({ fetchedAt: -1 }),
    ]).catch(() => { indexPromise = undefined; });
  }
  return indexPromise;
};

const ownerObjectId = ownerId => {
  const value = asText(ownerId);
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
};

/** 缓存有效期（天）。设 0 表示每次都重抓。 */
export const portraitCacheDays = () => {
  const value = Number(process.env.BENCHMARK_PORTRAIT_CACHE_DAYS);
  return Number.isFinite(value) && value >= 0 ? value : 7;
};

const isFresh = document => {
  const days = portraitCacheDays();
  if (days === 0) return false;
  const fetchedAt = document?.fetchedAt instanceof Date ? document.fetchedAt : new Date(asText(document?.fetchedAt));
  if (Number.isNaN(fetchedAt.getTime())) return false;
  return Date.now() - fetchedAt.getTime() < days * 86_400_000;
};

const serialize = document => ({
  ok: Boolean(document?.ok),
  reason: asText(document?.reason),
  secUserId: asText(document?.secUserId),
  dimensions: Array.isArray(document?.dimensions) ? document.dimensions : [],
  failed: Array.isArray(document?.failed) ? document.failed : [],
  fetchedAt: document?.fetchedAt instanceof Date ? document.fetchedAt.toISOString() : asText(document?.fetchedAt),
  fromCache: true,
});

/** 读缓存。**过期的当作没有**，让调用方去重抓 —— 画像不能拿几个月前的数据当现状。 */
export async function getFansPortrait({ ownerId, secUserId } = {}) {
  const managerId = ownerObjectId(ownerId);
  const userId = asText(secUserId);
  if (!managerId || !userId) return null;

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);
  const document = await collection.findOne({ managerId, secUserId: userId });
  if (!document) return null;
  if (!isFresh(document)) return null;
  return serialize(document);
}

/**
 * 写缓存（upsert）。
 *
 * 失败结果**不写**：与评论/转写不同，画像失败往往是一次上游抖动，
 * 而重抓的代价只有 8 次廉价 GET；把失败缓存 7 天会让用户七天都看不到画像，
 * 得不偿失。这一点与 commentStore 的策略刻意相反，别照抄。
 */
export async function saveFansPortrait({ ownerId, portrait } = {}) {
  const managerId = ownerObjectId(ownerId);
  const userId = asText(portrait?.secUserId);
  if (!managerId) throw new Error("Invalid manager identity");
  if (!userId) throw new Error("portrait.secUserId is required");
  if (!portrait?.ok) return null;

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);

  const document = {
    managerId,
    secUserId: userId,
    ok: true,
    reason: "",
    dimensions: Array.isArray(portrait.dimensions) ? portrait.dimensions : [],
    failed: Array.isArray(portrait.failed) ? portrait.failed : [],
    fetchedAt: new Date(),
  };
  await collection.updateOne(
    { managerId, secUserId: userId },
    { $set: document, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return { ...serialize(document), fromCache: false };
}

/** 清掉某个项目经理的画像缓存（换账号或想强制重抓时用）。 */
export async function clearFansPortraits({ ownerId } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const db = await getDb();
  const result = await db.collection(COLLECTION).deleteMany({ managerId });
  return { deleted: result.deletedCount };
}
