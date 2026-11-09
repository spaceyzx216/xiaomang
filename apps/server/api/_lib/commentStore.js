import { MongoClient, ObjectId } from "mongodb";

/**
 * 对标视频「高赞评论」的持久化缓存。
 *
 * 为什么必须落库：TikHub 评论接口是**按次计费**的。评论本身不大，但每抓一次都要付钱，
 * 而前端是分批驱动的（10 条一批、可能要跑好几轮），进程内缓存在 serverless 上每个实例
 * 各一份、随时被回收 —— 靠它省不掉任何一次调用。落到 MongoDB 之后，
 * **同一个视频一个项目经理只付一次评论费**，重跑和追加样本都是秒开。
 *
 * 按 managerId 收口，与其它报告/缓存集合保持一致（videoId 不作为跨账号读取的入口）。
 *
 * ⚠️ 与 transcriptStore 的 scope 不同：评论没有「开头/结尾」之分，唯一索引就是
 * `{ managerId, videoId }`。代价是**同一个视频只有一条记录**，失败缓存想重试必须显式
 * 清掉（clearComments）—— 这是刻意的：失败也会缓存，否则前端每轮都会重抓同一个坏视频。
 */

const COLLECTION = "benchmark_video_comments";

const asText = value => String(value ?? "").trim();

let clientPromise;
let indexPromise;

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

/**
 * 唯一索引是这套缓存的地基：没有它 upsert 会退化成「同一视频存多条」，
 * getComments 读回来的就是随机一条。所以这里**不吞异常**（与 transcriptStore 一致）：
 * 建不出来就让它报错，绝不静默降级成看起来正常的随机数据。
 */
const ensureIndexes = collection => {
  if (!indexPromise) {
    indexPromise = collection
      .createIndex({ managerId: 1, videoId: 1 }, { unique: true })
      .catch(error => {
        indexPromise = undefined;
        throw error;
      });
  }
  return indexPromise;
};

const ownerObjectId = ownerId => {
  const value = asText(ownerId);
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
};

/**
 * 对外形状。`failed` 是给调用方/日志一眼看出来的冗余标记，判定本身仍以 `status` 为准。
 *
 * 必须能区分「缓存了失败」和「抓到了 0 条评论」：这两种的 commentCount 都是 0，
 * 只看条数会把失败当成功，于是前端再也不会重试这个视频（或者反过来无限重试）。
 */
const serialize = document => {
  const status = asText(document.status) || "failed";
  return {
    videoId: asText(document.videoId),
    status,
    failed: status === "failed",
    comments: Array.isArray(document.comments) ? document.comments : [],
    provider: asText(document.provider),
    error: asText(document.error),
    durationMs: Number(document.durationMs || 0),
    updatedAt: document.updatedAt instanceof Date ? document.updatedAt.toISOString() : asText(document.updatedAt),
  };
};

/**
 * 写入一个视频的评论抓取结果（**成功和失败都写**）。
 *
 * 失败的也落库，是为了让 getCommentProgress 把它算成「已尝试」—— 否则前端分批循环
 * 会永远卡在同一个失败视频上来回重抓，在付费接口上就是持续烧钱。
 */
export async function saveComments({
  ownerId,
  videoId,
  comments = [],
  provider = "",
  status = "ok",
  error = "",
  durationMs = 0,
} = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const id = asText(videoId);
  if (!id) throw new Error("videoId is required");

  const normalizedStatus = status === "ok" ? "ok" : "failed";
  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);

  const document = {
    managerId,
    videoId: id,
    status: normalizedStatus,
    failed: normalizedStatus === "failed",
    // 失败记录不留上次的评论：半新半旧的数据比没有数据更容易误导分析。
    comments: normalizedStatus === "ok" && Array.isArray(comments) ? comments : [],
    commentCount: normalizedStatus === "ok" && Array.isArray(comments) ? comments.length : 0,
    provider: asText(provider),
    // 错误信息截断：上游可能返回一整页 HTML/JSON，整段塞进文档没有意义。
    error: asText(error).slice(0, 400),
    durationMs: Number(durationMs || 0),
    updatedAt: new Date(),
  };
  await collection.updateOne(
    { managerId, videoId: id },
    { $set: document, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return serialize(document);
}

/**
 * 按 videoId 批量取已缓存的评论。
 *
 * 只返回**成功**的（失败的没有评论可取）；「这个视频抓过没有、成功还是失败」用
 * getCommentProgress 查，两者分工与 transcriptStore 一致。
 */
export async function getComments({ ownerId, videoIds = [] } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const ids = Array.from(new Set((Array.isArray(videoIds) ? videoIds : []).map(asText).filter(Boolean)));
  if (ids.length === 0) return new Map();

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);
  const documents = await collection
    .find({ managerId, videoId: { $in: ids }, status: "ok" })
    .toArray();
  return new Map(documents.map(document => [asText(document.videoId), serialize(document).comments]));
}

/**
 * 批量进度：哪些已尝试过（成功或失败）、哪些还没动。
 *
 * **不变量：attempted = ok + failed —— 失败的也算「已尝试」。**
 * 漏掉失败项，前端的分批循环就会一直认为还有 pending，对着同一个坏视频无限重抓；
 * 在按次计费的 TikHub 评论接口上，这个 bug 是直接烧钱（转写链路踩过同一个坑，
 * 见 tests/gold-three-seconds-transcript.test.mjs）。
 * 想让失败的重新试，走 clearComments 或换一份报告重新触发。
 */
export async function getCommentProgress({ ownerId, videoIds = [] } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const ids = Array.from(new Set((Array.isArray(videoIds) ? videoIds : []).map(asText).filter(Boolean)));
  if (ids.length === 0) return { total: 0, ok: 0, failed: 0, attempted: 0, pendingIds: [] };

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);
  const documents = await collection
    .find({ managerId, videoId: { $in: ids } }, { projection: { videoId: 1, status: 1 } })
    .toArray();
  const byId = new Map(documents.map(document => [asText(document.videoId), asText(document.status)]));
  const ok = ids.filter(id => byId.get(id) === "ok").length;
  const failed = ids.filter(id => byId.get(id) === "failed").length;
  return {
    total: ids.length,
    ok,
    failed,
    // 失败也计入 attempted（见上面的不变量说明），否则前端会无限重试同一个失败视频。
    attempted: ok + failed,
    pendingIds: ids.filter(id => !byId.has(id)),
  };
}

/**
 * 清掉某个项目经理的全部评论缓存。
 *
 * 这是**唯一**能让失败视频重试的入口（失败也缓存，否则每轮重抓就是烧钱），
 * 换账号或想强制重抓时用。想只清一部分就传 videoIds。
 */
export async function clearComments({ ownerId, videoIds } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const ids = Array.isArray(videoIds) ? Array.from(new Set(videoIds.map(asText).filter(Boolean))) : [];
  const db = await getDb();
  const filter = ids.length > 0 ? { managerId, videoId: { $in: ids } } : { managerId };
  const result = await db.collection(COLLECTION).deleteMany(filter);
  return { deleted: result.deletedCount };
}
