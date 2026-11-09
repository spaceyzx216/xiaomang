import { createHash } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";

/**
 * 模块 4「复盘分析」的 4.1 单条视频报告存储。
 *
 * 与其它六个报告 store **完全同构**（同样的幂等策略、同样的契约：列表只给元数据、
 * 正文按 id 取、同样的 `managerId` 收口）—— 见 `accountPlanStore.js`。
 * 改动时七个 store 一起改，别只改一个（HANDOFF §6.2⑥）。
 *
 * ── 与其它六个 store 的一处**有意差异** ─────────────────────────────────
 *
 * 4.1 允许**员工创建**（用户 2026-09-30 拍板：「经理端新模块 4 + 员工端只读/单条分析」）。
 * 所以 `managerId` 这个字段在本集合里存的是**创建者 id**（可能是员工），
 * 语义与其它六个 store 的「报告属主」一致，只是属主不一定是经理。
 *
 * 🔴 边界（照 `accountPlanStore.js:186-204` 的同一套写法）：
 *   · 经理读自己的：`{ managerId }` 收口；
 *   · 员工读**按客户**：**不按 managerId 过滤**（同一客户的东西是团队共用的），
 *     但**必须带 customerId** —— 没有就 400，绝不退化成「列出全部」；
 *   · 两个序列化器都**不含 managerId**，属主身份不外泄；
 *   · 删除仍然只看 `managerId`（自己的才能删）。
 */

let clientPromise;
let indexPromise;

const asText = value => String(value ?? "").trim();

const COLLECTION = "video_analysis_reports";
const REPORT_TYPE = "video_analysis";

/**
 * 关掉本模块缓存的 MongoClient。
 *
 * ⚠️ **只给测试收尾用**（生产不需要主动关）：
 *    需要真实数据库的 store 测试如果不关它，Node 进程会因为这条 keep-alive 连接
 *    **永远不退出** —— 症状是 `node --test` 挂住不动、既不报错也不结束（实测踩过）。
 *    测试里在 `t.after` 调它即可。
 */
export const closeMongoClient = async () => {
  const pending = clientPromise;
  clientPromise = undefined;
  indexPromise = undefined;
  if (!pending) return;
  try {
    const client = await pending;
    await client.close();
  } catch {
    // 连接本来就没建起来 / 已经关了：忽略。
  }
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

// 建索引是尽力而为：失败不影响读写主流程。
const ensureIndexes = collection => {
  if (!indexPromise) {
    indexPromise = Promise.all([
      collection.createIndex({ managerId: 1, createdAt: -1 }),
      collection.createIndex({ managerId: 1, contentHash: 1 }),
      // 员工侧按**客户**读：没有这个索引就是全表扫。
      // 排序字段一起进索引，`sort({createdAt:-1})` 才能走索引。
      collection.createIndex({ customerId: 1, createdAt: -1 }),
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

// 保存幂等用的内容指纹。同其它六个 store。
const reportFingerprint = report => createHash("sha256")
  .update(JSON.stringify(report))
  .digest("hex");

/** 列表用途的元数据，**故意不带 report 正文**。 */
const serializeSummary = document => ({
  id: String(document._id),
  reportType: REPORT_TYPE,
  customerId: asText(document.customerId),
  customerName: asText(document.customerName),
  platform: asText(document.platform),
  platformLabel: asText(document.platformLabel),
  videoTitle: asText(document.videoTitle),
  videoLink: asText(document.videoLink),
  categoryName: asText(document.categoryName),
  subcategoryName: asText(document.subcategoryName),
  plays: document.plays === null || document.plays === undefined ? null : Number(document.plays),
  playBucketLabel: asText(document.playBucketLabel),
  optimizeCount: Number(document.optimizeCount || 0),
  analysisSource: asText(document.analysisSource),
  createdAt: toIso(document.createdAt),
});

const serializeFull = document => ({ ...serializeSummary(document), report: document.report || null });

export async function saveVideoAnalysisReport({ ownerId, customerId, customerName, report } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const target = asText(customerId);
  if (!target) throw Object.assign(new Error("customerId is required"), { status: 400 });

  if (!report || typeof report !== "object") throw new Error("report is required");
  if (report.reportType !== REPORT_TYPE) throw new Error("invalid video analysis report");

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);

  const contentHash = reportFingerprint(report);
  // 幂等：完全相同的重复提交直接返回已有记录，挡住双击和刷新重提。
  const existing = await collection.findOne({ managerId, contentHash });
  if (existing) return serializeSummary(existing);

  const document = {
    managerId,
    reportType: REPORT_TYPE,
    customerId: target,
    customerName: asText(customerName),
    platform: asText(report.platform),
    platformLabel: asText(report.platformLabel),
    videoTitle: asText(report.video?.title),
    videoLink: asText(report.video?.link),
    categoryName: asText(report.structureTags?.categoryName),
    subcategoryName: asText(report.structureTags?.subcategoryName),
    plays: typeof report.metrics?.plays === "number" ? report.metrics.plays : null,
    playBucketLabel: asText(report.playBucket?.label),
    optimizeCount: (Array.isArray(report.structures) ? report.structures : [])
      .filter(item => item?.verdict === "optimize").length,
    analysisSource: asText(report.analysisSource),
    contentHash,
    report,
    createdAt: new Date(),
  };
  const result = await collection.insertOne(document);
  return serializeSummary({ ...document, _id: result.insertedId });
}

/** 经理侧列表：只返回元数据。 */
export async function listVideoAnalysisReports({ ownerId, limit = 12 } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  const db = await getDb();
  const collection = db.collection(COLLECTION);
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
 *
 * ⚠️ 与 `getAccountPlanReport` 的差别：4.1 允许员工读，所以这里**先按 id 取**，
 *    由调用方（端点）用 `managerId` 或 `customerId` 二选一收口 —— 见 `getVideoAnalysisReport`
 *    与 `getVideoAnalysisReportForCustomer`。
 */
export async function getVideoAnalysisReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const document = await db.collection(COLLECTION).findOne({ _id: reportObjectId(id), managerId });
  return document ? serializeFull(document) : null;
}

/** 删除单份报告。按 managerId 收口（只有自己的能删）。 */
export async function deleteVideoAnalysisReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const result = await db.collection(COLLECTION).deleteOne({ _id: reportObjectId(id), managerId });
  return { deleted: result.deletedCount > 0 };
}

// ── 员工侧（按客户收口，只读）──────────────────────────────────────────────

/** 员工按**客户**列该客户的全部 4.1 报告（只返回元数据，不带正文）。 */
export async function listVideoAnalysisReportsForCustomer({ customerId, limit = 20 } = {}) {
  const target = asText(customerId);
  if (!target) throw Object.assign(new Error("customerId is required"), { status: 400 });

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);

  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  const documents = await collection
    .find({ customerId: target }, { projection: { report: 0 } })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .toArray();
  return documents.map(serializeSummary);
}

/** 员工按 id 取单份正文 —— **必须同时给出该报告所属的 customerId**，否则读不到。 */
export async function getVideoAnalysisReportForCustomer({ customerId, id } = {}) {
  const target = asText(customerId);
  if (!target) throw Object.assign(new Error("customerId is required"), { status: 400 });

  const db = await getDb();
  const document = await db.collection(COLLECTION).findOne({ _id: reportObjectId(id), customerId: target });
  return document ? serializeFull(document) : null;
}
