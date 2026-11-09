import { createHash } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";

/**
 * 模块 2「账号定位」(1.3) 报告的存储。
 *
 * 与 benchmarkReportStore / goldThreeSecondStore / endingHookStore / benchmarkProfileStore
 * **完全同构** —— 同样的幂等策略、同样的契约（列表只给元数据、正文按 id 取）、
 * 同样按 managerId 收口。改动时五个 store 一起改，别只改一个（§6.2⑥）。
 */

let clientPromise;
let indexPromise;

const asText = value => String(value ?? "").trim();

const COLLECTION = "account_plan_reports";
const REPORT_TYPE = "account_plan";

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
      // 员工侧按**客户**读（`listAccountPlanReportsForCustomer` /
      // `getLatestAccountPlanReportForCustomer`）：没有这个索引就是全表扫。
      // 排序字段一起进索引，`sort({createdAt:-1}).limit(1)` 才能走索引取第一条。
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

// 保存幂等用的内容指纹。同其它四个 store。
const reportFingerprint = report => createHash("sha256")
  .update(JSON.stringify(report))
  .digest("hex");

/**
 * 列表用途的元数据，**故意不带 report 正文**。
 * 1.3 的正文比 1.2 还大（1.2 的分类选题库整体透传 + 三种方法的选题 + 两版简介），
 * 列表更不能拖正文（§6.2⑥）。
 */
const serializeSummary = document => ({
  id: String(document._id),
  reportType: REPORT_TYPE,
  customerId: asText(document.customerId),
  customerName: asText(document.customerName),
  benchmarkAccountName: asText(document.benchmarkAccountName),
  contentStyle: asText(document.contentStyle),
  batch: Number(document.batch || 0),
  // ⚠️ 1.3 的「分析了多少条」没有 1.2 那种样本数含义（它不分析视频），
  // 这里存的是**产出章节数**（0~3）。字段名保持与其它四个 store 一致，
  // 这样历史列表的渲染与排序逻辑不必为 1.3 分叉。
  analyzedCount: Number(document.analyzedCount || 0),
  createdAt: toIso(document.createdAt),
});

const serializeFull = document => ({ ...serializeSummary(document), report: document.report || null });

export async function saveAccountPlanReport({ ownerId, report } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");
  if (!report || typeof report !== "object") throw new Error("report is required");
  if (report.reportType !== REPORT_TYPE) throw new Error("invalid account plan report");

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
    customerId: asText(report.customer?.id),
    customerName: asText(report.customer?.name),
    benchmarkAccountName: asText(report.benchmark?.accountName),
    contentStyle: asText(report.benchmark?.contentStyle),
    batch: Number(report.batch || 0),
    analyzedCount: Number(report.dataCoverage?.producedSectionCount || 0),
    contentHash,
    report,
    createdAt: new Date(),
  };
  const result = await collection.insertOne(document);
  return serializeSummary({ ...document, _id: result.insertedId });
}

/** 列表：只返回元数据。 */
export async function listAccountPlanReports({ ownerId, limit = 12 } = {}) {
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

/** 按 id 取单份完整报告。按 managerId 收口，读不到别人的数据。 */
export async function getAccountPlanReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const document = await db.collection(COLLECTION).findOne({ _id: reportObjectId(id), managerId });
  return document ? serializeFull(document) : null;
}

/** 删除单份报告。按 managerId 收口。 */
export async function deleteAccountPlanReport({ ownerId, id } = {}) {
  const managerId = ownerObjectId(ownerId);
  if (!managerId) throw new Error("Invalid manager identity");

  const db = await getDb();
  const result = await db.collection(COLLECTION).deleteOne({ _id: reportObjectId(id), managerId });
  return { deleted: result.deletedCount > 0 };
}

// ── 员工侧（只读，按客户收口）────────────────────────────────────────────────
//
// 2026-09-21 用户拍板：「3.3 账号标签文档直接开放权限」。
//
// 背景：3.3 的账号标签库要求从**账号规划（1.3）**推「细分赛道 / 用户核心痛点 /
// 内容核心定位」三个角度，而 1.3 报告原来是 manager-only，发布仓又跑在员工端 ——
// 不放行的话这条链只能用选题库的关键词凑，标签质量会打折。
//
// 🔴 **边界是「按客户」，不是「按所有人」**：
//   - **不按 managerId 过滤**（员工不是报告属主，库是项目经理建的；这一点与
//     `getTopicLibraryForEmployee` 同一口径），但**必须带 customerId**；
//   - 只回**该客户**的报告，不是「任意员工的任意报告」——
//     没有 customerId 直接 400，绝不退化成「列出全部」；
//   - `serializeSummary` / `serializeFull` 都**不含 managerId**，属主身份不外泄；
//   - **写操作（保存 / 删除）仍然 manager-only**，一条都没放开。
//
// ⚠️ 注意：1.3 报告里含**客户 IP 档案**（人口属性、定价等）。放开给员工是用户明确
//    拍板的（同类内容在 `getTopicLibraryForEmployee` 里当初是刻意收窄掉的）。
//    如果以后要收回，改这两个函数即可，端点无需改动。

/** 员工按**客户**列该客户的账号规划报告（只返回元数据，不带正文）。 */
export async function listAccountPlanReportsForCustomer({ customerId, limit = 12 } = {}) {
  const target = asText(customerId);
  if (!target) throw Object.assign(new Error("customerId is required"), { status: 400 });

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);

  const safeLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
  const documents = await collection
    .find({ customerId: target }, { projection: { report: 0 } })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .toArray();
  return documents.map(serializeSummary);
}

/**
 * 员工按**客户**取该客户**最新一份**账号规划报告正文。
 *
 * 发布仓要的是「这个客户的账号定位」，不需要用户先挑哪一份 ——
 * 所以这里直接给最新一份（`createdAt` 倒序第一条）。没有就回 null。
 */
export async function getLatestAccountPlanReportForCustomer({ customerId } = {}) {
  const target = asText(customerId);
  if (!target) throw Object.assign(new Error("customerId is required"), { status: 400 });

  const db = await getDb();
  const collection = db.collection(COLLECTION);
  await ensureIndexes(collection);
  const document = await collection
    .find({ customerId: target })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  return document ? serializeFull(document) : null;
}
