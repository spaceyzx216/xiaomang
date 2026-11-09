import { createHash } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";

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

// 建索引是尽力而为：失败不影响读写主流程，只是查询退化成全表扫描。
const ensureIndexes = collection => {
  if (!indexPromise) {
    indexPromise = Promise.all([
      collection.createIndex({ managerId: 1, createdAt: -1 }),
      collection.createIndex({ managerId: 1, contentHash: 1 }),
    ]).catch(() => { indexPromise = undefined; });
  }
  return indexPromise;
};

const asText = value => String(value ?? "").trim();

const toIso = value => (value instanceof Date ? value.toISOString() : asText(value));

/**
 * 内容指纹，用于保存幂等。
 *
 * 故意把重点样本 id 也算进去：内容相同但重点样本不同，那是用户改过标记的新版本，
 * 应该新建一条；只有「整份提交完全一致」才是重复提交（双击、刷新重提）。
 * 也不包含 createdAt —— 那正是每次都会变的东西。
 */
const reportFingerprint = (report, selectedVideoIds) => createHash("sha256")
  .update(JSON.stringify([report, selectedVideoIds]))
  .digest("hex");

/**
 * 列表用途的元数据。**故意不带 report 正文。**
 *
 * 单份报告正文约 148 KB（60 条视频在 videos 和 categories[].topics 里各存一份），
 * 列表一次拉 12 份就是近 2 MB —— 而调用方只是想「挑一份」。正文改用
 * getBenchmarkReport 按 id 单独取。
 */
const serializeSummary = document => ({
  id: String(document._id),
  reportType: asText(document.reportType || "benchmark_classification"),
  accountName: asText(document.accountName),
  accountUrl: asText(document.accountUrl),
  platform: asText(document.platform),
  contentStyle: asText(document.contentStyle),
  analyzedCount: Number(document.analyzedCount || 0),
  selectedCount: Array.isArray(document.selectedVideoIds) ? document.selectedVideoIds.length : 0,
  // 前端要用它恢复「重点样本」勾选状态，id 列表本身很小。
  selectedVideoIds: Array.isArray(document.selectedVideoIds) ? document.selectedVideoIds.map(asText).filter(Boolean) : [],
  createdAt: toIso(document.createdAt),
});

/** 详情用途：元数据 + 正文。 */
const serializeFull = document => ({ ...serializeSummary(document), report: document.report || null });

const ownerObjectId = ownerId => {
  const value = asText(ownerId);
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
};

const reportObjectId = id => {
  const value = asText(id);
  if (!ObjectId.isValid(value)) throw new Error("Invalid report id");
  return new ObjectId(value);
};

export async function saveBenchmarkReport({ ownerId, report, selectedVideoIds = [] } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  if (!report || typeof report !== "object") throw new Error("report is required");
  // 与 goldThreeSecondStore 对齐：只允许分类阶段产出的报告落库，
  // 避免任意对象被写进 benchmark_reports（落库时 reportType 是写死的）。
  if (report.reportType !== "benchmark_classification") throw new Error("invalid benchmark classification report");

  const db = await getDb();
  const collection = db.collection("benchmark_reports");
  await ensureIndexes(collection);

  const validVideoIds = new Set(
    (Array.isArray(report.videos) ? report.videos : [])
      .map(video => asText(video?.id || video?.videoId))
      .filter(Boolean),
  );
  const focusVideoIds = Array.from(new Set(
    (Array.isArray(selectedVideoIds) ? selectedVideoIds : [])
      .map(asText)
      .filter(videoId => validVideoIds.has(videoId)),
  ));

  const contentHash = reportFingerprint(report, focusVideoIds);
  // 幂等：完全相同的重复提交（双击、刷新重提）直接返回已有记录，不再新建一条。
  const existing = await collection.findOne({ managerId, contentHash });
  if (existing) return serializeSummary(existing);

  const document = {
    managerId,
    reportType: "benchmark_classification",
    accountName: asText(report.account?.name),
    accountUrl: asText(report.account?.url),
    platform: asText(report.account?.platform),
    contentStyle: asText(report.contentStyle),
    analyzedCount: Number(report.analyzedCount || 0),
    // 重点样本只能引用本报告中的视频，避免客户端误传无关 ID。
    selectedVideoIds: focusVideoIds,
    contentHash,
    report,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await collection.insertOne(document);
  return serializeSummary({ ...document, _id: result.insertedId });
}

/** 列表：只返回元数据，正文不随列表返回。 */
export async function listBenchmarkReports({ ownerId, limit = 12 } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const collection = db.collection("benchmark_reports");
  await ensureIndexes(collection);

  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
  const documents = await collection
    .find({ managerId }, { projection: { report: 0 } })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .toArray();
  return documents.map(serializeSummary);
}

/**
 * 按 id 取单份完整报告。
 * 必须同时按 managerId 过滤 —— 报告 id 不能成为跨项目经理读取别人报告的入口。
 */
export async function getBenchmarkReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const document = await db.collection("benchmark_reports").findOne({ _id: reportObjectId(id), managerId });
  return document ? serializeFull(document) : null;
}

/** 删除单份报告。同样按 managerId 收口，删不掉别人的数据。 */
export async function deleteBenchmarkReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const result = await db.collection("benchmark_reports").deleteOne({ _id: reportObjectId(id), managerId });
  return { deleted: result.deletedCount > 0 };
}
