import { MongoClient, ObjectId } from "mongodb";

/**
 * 视频口播转写的持久化缓存。
 *
 * 为什么必须落库：一次转写实测约 89 秒（下载视频 → ffmpeg 抽音频 → 豆包 ASR），
 * 20 条就是半小时。进程内的 `transcriptCache`（providers.js）在 serverless 上
 * 每个实例各一份、随时被回收，撑不住这个成本。落到 MongoDB 之后，
 * **同一个视频一个项目经理只付一次转写成本**，重跑和追加样本都是秒开。
 *
 * 按 managerId 收口，与其它报告集合保持一致（报告 id / 视频 id 都不作为跨账号读取的入口）。
 *
 * ⚠️ **scope：同一个视频要分开存「开头」和「结尾」两份转写**（2026-09-17 加）
 *
 * 2.2 黄金三秒要**开头**几秒，2.3 结尾钩子要**结尾**几秒 —— 同一个 videoId、两个完全
 * 不同的片段。原来的唯一索引只有 `{managerId, videoId}`，于是：
 *   ① 2.3 写结尾转写会**覆盖**2.2 的开头转写；
 *   ② 2.2 重跑时 `getTranscripts` 读回那段结尾文案，却拿它去判断「开场 3 秒」。
 * 全程不报错，报告看起来正常 —— 是最难发现的那类错。
 *
 * 所以所有读写都必须带 `scope`，唯一索引也扩成三字段。
 */

/** 开场几秒（2.2 黄金三秒用）。 */
export const TRANSCRIPT_SCOPE_HEAD = "head";
/** 结尾几秒（2.3 结尾钩子用）。 */
export const TRANSCRIPT_SCOPE_TAIL = "tail";
/** 完整视频口播（近期开更新选题标签用）。 */
export const TRANSCRIPT_SCOPE_SCRIPT = "script";

const asText = value => String(value ?? "").trim();

/**
 * 认不出的 scope 一律当 head —— 历史数据没有这个字段，它们全是 2.2 的开头转写。
 * 近期开更新标签使用独立的 script scope，不能复用 head，否则完整脚本会污染黄金三秒缓存。
 */
const normalizeScope = value => {
  const scope = asText(value).toLowerCase();
  if (scope === TRANSCRIPT_SCOPE_TAIL) return TRANSCRIPT_SCOPE_TAIL;
  if (scope === TRANSCRIPT_SCOPE_SCRIPT) return TRANSCRIPT_SCOPE_SCRIPT;
  return TRANSCRIPT_SCOPE_HEAD;
};

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

/** 旧索引的名字（只有 managerId + videoId），必须迁掉，否则同一视频存不了两份。 */
const LEGACY_UNIQUE_INDEX = "managerId_1_videoId_1";

const ensureIndexes = collection => {
  if (!indexPromise) {
    indexPromise = (async () => {
      // 1. 历史数据没有 scope 字段 —— 它们都是 2.2 的开头转写，补成 head。
      await collection.updateMany({ scope: { $exists: false } }, { $set: { scope: TRANSCRIPT_SCOPE_HEAD } });
      // 2. 建带 scope 的唯一索引（同一视频的 head / tail 各一条）。
      await collection.createIndex({ managerId: 1, videoId: 1, scope: 1 }, { unique: true });
      // 3. 必须把旧的两字段唯一索引删掉，否则「同一视频存第二份」会被它挡住。
      try {
        const indexes = await collection.indexes();
        if (indexes.some(index => index.name === LEGACY_UNIQUE_INDEX)) {
          await collection.dropIndex(LEGACY_UNIQUE_INDEX);
        }
      } catch {
        // 索引不存在 / 没权限：不该阻塞写入。真出问题时表现是 upsert 覆盖，日志里能看出来。
      }
    })().catch(error => { indexPromise = undefined; throw error; });
  }
  return indexPromise;
};

const ownerObjectId = ownerId => {
  const value = asText(ownerId);
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
};

const serialize = document => ({
  videoId: asText(document.videoId),
  scope: normalizeScope(document.scope),
  status: asText(document.status) || "failed",
  text: asText(document.text),
  provider: asText(document.provider),
  error: asText(document.error),
  durationMs: Number(document.durationMs || 0),
  updatedAt: document.updatedAt instanceof Date ? document.updatedAt.toISOString() : asText(document.updatedAt),
});

/** 写入一条转写结果（成功或失败都写，失败的也记下来，避免每次重跑都撞同一堵墙）。 */
export async function saveTranscript({ ownerId, videoId, scope, status, text = "", provider = "", error = "", durationMs = 0 } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const id = asText(videoId);
  if (!id) throw new Error("videoId is required");
  const normalizedScope = normalizeScope(scope);

  const db = await getDb();
  const collection = db.collection("gold_three_second_transcripts");
  await ensureIndexes(collection);

  const document = {
    managerId,
    videoId: id,
    scope: normalizedScope,
    status: status === "ok" ? "ok" : "failed",
    text: asText(text),
    provider: asText(provider),
    error: asText(error).slice(0, 400),
    durationMs: Number(durationMs || 0),
    updatedAt: new Date(),
  };
  await collection.updateOne(
    { managerId, videoId: id, scope: normalizedScope },
    { $set: document, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  return serialize(document);
}

/** 按 videoId 批量取已缓存的转写。只返回已完成的（失败的不算「有转写」）。 */
export async function getTranscripts({ ownerId, videoIds = [], scope } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const ids = Array.from(new Set((Array.isArray(videoIds) ? videoIds : []).map(asText).filter(Boolean)));
  if (ids.length === 0) return new Map();

  const db = await getDb();
  const collection = db.collection("gold_three_second_transcripts");
  // 读路径也触发一次迁移：不能只在写入时才补 scope / 换索引，
  // 否则第一次读到的仍是旧形状的数据（更糟的是旧唯一索引还挡着 tail 的写入）。
  await ensureIndexes(collection);
  const documents = await collection
    .find({ managerId, videoId: { $in: ids }, scope: normalizeScope(scope), status: "ok" })
    .toArray();
  return new Map(documents.map(document => [asText(document.videoId), serialize(document)]));
}

/**
 * 批量进度：哪些已尝试过（成功或失败）、哪些还没动。
 *
 * **失败的也算「已尝试」**，否则前端分批循环会永远卡在同一个失败视频上来回重试。
 * 想让失败的重新试，走 clearTranscripts 或换一份报告重新触发。
 */
export async function getTranscriptProgress({ ownerId, videoIds = [], scope } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const ids = Array.from(new Set((Array.isArray(videoIds) ? videoIds : []).map(asText).filter(Boolean)));
  if (ids.length === 0) return { total: 0, ok: 0, failed: 0, attempted: 0, pendingIds: [] };

  const db = await getDb();
  const collection = db.collection("gold_three_second_transcripts");
  await ensureIndexes(collection);
  const documents = await collection
    .find({ managerId, videoId: { $in: ids }, scope: normalizeScope(scope) }, { projection: { videoId: 1, status: 1 } })
    .toArray();
  const byId = new Map(documents.map(document => [asText(document.videoId), asText(document.status)]));
  const ok = ids.filter(id => byId.get(id) === "ok").length;
  const failed = ids.filter(id => byId.get(id) === "failed").length;
  return {
    total: ids.length,
    ok,
    failed,
    attempted: ok + failed,
    pendingIds: ids.filter(id => !byId.has(id)),
  };
}

/** 清掉某个项目经理的全部转写缓存（换账号或想强制重转时用）。head / tail 一起清。 */
export async function clearTranscripts({ ownerId } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const db = await getDb();
  const result = await db.collection("gold_three_second_transcripts").deleteMany({ managerId });
  return { deleted: result.deletedCount };
}
