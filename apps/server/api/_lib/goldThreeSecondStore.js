import { createHash } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";

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

// 保存幂等用的内容指纹。同 benchmarkReportStore。
const reportFingerprint = report => createHash("sha256")
  .update(JSON.stringify(report))
  .digest("hex");

/**
 * 列表用途的元数据，**故意不带 report 正文**。
 * 调用方（黄金三秒页的历史列表）只是想挑一份，正文用 getGoldThreeSecondReport 按 id 取。
 */
const serializeSummary = document => ({
  id: String(document._id),
  reportType: "gold_three_seconds",
  accountName: asText(document.accountName),
  accountUrl: asText(document.accountUrl),
  contentStyle: asText(document.contentStyle),
  analyzedCount: Number(document.analyzedCount || 0),
  createdAt: toIso(document.createdAt),
});

const serializeFull = document => ({ ...serializeSummary(document), report: document.report || null });

export async function saveGoldThreeSecondReport({ ownerId, report } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  if (!report || typeof report !== "object") throw new Error("report is required");
  if (report.reportType !== "gold_three_seconds") throw new Error("invalid gold three seconds report");

  const db = await getDb();
  const collection = db.collection("gold_three_second_reports");
  await ensureIndexes(collection);

  const contentHash = reportFingerprint(report);
  // 幂等：完全相同的重复提交直接返回已有记录，挡住双击和刷新重提。
  const existing = await collection.findOne({ managerId, contentHash });
  if (existing) return serializeSummary(existing);

  const document = {
    managerId,
    reportType: "gold_three_seconds",
    accountName: asText(report.account?.name),
    accountUrl: asText(report.account?.url),
    contentStyle: asText(report.contentStyle),
    analyzedCount: Number(report.analyzedCount || 0),
    contentHash,
    report,
    createdAt: new Date(),
  };
  const result = await collection.insertOne(document);
  return serializeSummary({ ...document, _id: result.insertedId });
}

/** 列表：只返回元数据。 */
export async function listGoldThreeSecondReports({ ownerId, limit = 12 } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const db = await getDb();
  const collection = db.collection("gold_three_second_reports");
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
export async function getGoldThreeSecondReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const document = await db.collection("gold_three_second_reports").findOne({ _id: reportObjectId(id), managerId });
  return document ? serializeFull(document) : null;
}

/** 删除单份报告。按 managerId 收口。 */
export async function deleteGoldThreeSecondReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const result = await db.collection("gold_three_second_reports").deleteOne({ _id: reportObjectId(id), managerId });
  return { deleted: result.deletedCount > 0 };
}
