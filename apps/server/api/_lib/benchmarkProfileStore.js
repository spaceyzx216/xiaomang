import { createHash } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";

/**
 * 模块 1「对标账号分析」(1.2) 报告的存储。
 *
 * 与 benchmarkReportStore / goldThreeSecondStore / endingHookStore **完全同构** ——
 * 同样的幂等策略、同样的契约（列表只给元数据、正文按 id 取）、同样按 managerId 收口。
 * 改动时四个 store 一起改，别只改一个（§6.2⑥）。
 */

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

// 建索引是尽力而为：失败不影响读写主流程。
const ensureIndexes = collection => {
  if (!indexPromise) {
    indexPromise = Promise.all([
      collection.createIndex({ managerId: 1, createdAt: -1 }),
      collection.createIndex({ managerId: 1, contentHash: 1 }),
    ]).catch(() => { indexPromise = undefined; });
  }
  return indexPromise;
};

const ownerObjectId = ownerId => {
  const value = asText(ownerId);
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
};

const reportObjectId = id => {
  const value = asText(id);
  if (!ObjectId.isValid(value)) throw new Error("Invalid report id");
  return new ObjectId(value);
};

const toIso = value => (value instanceof Date ? value.toISOString() : asText(value));

// 保存幂等用的内容指纹。同其它三个 store。
const reportFingerprint = report => createHash("sha256")
  .update(JSON.stringify(report))
  .digest("hex");

/**
 * 列表用途的元数据，**故意不带 report 正文**。
 * 1.2 的正文比其它报告更大（含 20 条样本的双向文案 + 评论证据），列表更不能拖正文。
 */
const serializeSummary = document => ({
  id: String(document._id),
  reportType: "benchmark_profile",
  accountName: asText(document.accountName),
  accountUrl: asText(document.accountUrl),
  contentStyle: asText(document.contentStyle),
  analyzedCount: Number(document.analyzedCount || 0),
  createdAt: toIso(document.createdAt),
});

const serializeFull = document => ({ ...serializeSummary(document), report: document.report || null });

export async function saveBenchmarkProfileReport({ ownerId, report } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  if (!report || typeof report !== "object") throw new Error("report is required");
  if (report.reportType !== "benchmark_profile") throw new Error("invalid benchmark profile report");

  const db = await getDb();
  const collection = db.collection("benchmark_profile_reports");
  await ensureIndexes(collection);

  const contentHash = reportFingerprint(report);
  // 幂等：完全相同的重复提交直接返回已有记录，挡住双击和刷新重提。
  const existing = await collection.findOne({ managerId, contentHash });
  if (existing) return serializeSummary(existing);

  const document = {
    managerId,
    reportType: "benchmark_profile",
    accountName: asText(report.account?.name),
    accountUrl: asText(report.account?.url),
    contentStyle: asText(report.contentStyle),
    // 「分析了多少条」在 1.2 里指前 20 条样本，不是分类报告的 60 条。
    analyzedCount: Number(report.dataCoverage?.profileSampleCount || 0),
    contentHash,
    report,
    createdAt: new Date(),
  };
  const result = await collection.insertOne(document);
  return serializeSummary({ ...document, _id: result.insertedId });
}

/** 列表：只返回元数据。 */
export async function listBenchmarkProfileReports({ ownerId, limit = 12 } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const db = await getDb();
  const collection = db.collection("benchmark_profile_reports");
  await ensureIndexes(collection);

  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
  const documents = await collection
    .find({ managerId }, { projection: { report: 0 } })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .toArray();
  return documents.map(serializeSummary);
}

/** 按 id 取单份完整报告。按 managerId 收口，读不到别人的数据。 */
export async function getBenchmarkProfileReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const document = await db.collection("benchmark_profile_reports").findOne({ _id: reportObjectId(id), managerId });
  return document ? serializeFull(document) : null;
}

/** 删除单份报告。按 managerId 收口。 */
export async function deleteBenchmarkProfileReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const result = await db.collection("benchmark_profile_reports").deleteOne({ _id: reportObjectId(id), managerId });
  return { deleted: result.deletedCount > 0 };
}
