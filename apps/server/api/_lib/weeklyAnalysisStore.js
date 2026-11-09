import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { getDb, objectId, problem } from './manager/db.js';
import { getTopicCategoryDictionaryForEmployee, getTopicLibraryCreativeAdaptation } from './topicLibraryStore.js';
import { buildWeeklyAnalysisReport, normalizeWeeklyInput, normalizeWeeklyPlan, weeklyBaselinePlan, WEEKLY_REPORT_TYPE } from './weeklyAnalysis.js';

export const WEEKLY_REPORT_COLLECTION = 'weekly_account_analysis_reports';
export const REVIEW_MEMORY_COLLECTION = 'weekly_review_memory_versions';
const ACTIVE_COLLECTION = 'weekly_review_memory_active';
const text = v => String(v ?? '').trim();
const hashes = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const indexed = new Map();
const database = async () => {
  const db = await getDb();
  if (!indexed.has(db.databaseName)) {
    const promise = Promise.all([
      db.collection(WEEKLY_REPORT_COLLECTION).createIndex({ managerId: 1, contentHash: 1 }, { unique: true }),
      db.collection(WEEKLY_REPORT_COLLECTION).createIndex({ managerId: 1, customerId: 1, platform: 1, 'period.start': -1 }),
      db.collection(REVIEW_MEMORY_COLLECTION).createIndex({ managerId: 1, confirmationKey: 1 }, { unique: true }),
      db.collection(REVIEW_MEMORY_COLLECTION).createIndex({ customerId: 1, platform: 1, createdAt: -1 }),
    ]).catch(error => { indexed.delete(db.databaseName); throw error; });
    indexed.set(db.databaseName, promise);
  }
  await indexed.get(db.databaseName);
  return db;
};
export const requireWeeklyCustomer = async customerId => {
  const db = await getDb();
  const customer = await db.collection('customers').findOne({ _id: objectId(customerId) }, { projection: { name: 1 } });
  if (!customer) throw problem('客户不存在', 404);
  return { id: String(customer._id), name: text(customer.name) };
};
const summary = d => ({ id: String(d._id), customerId: d.customerId, customerName: d.customerName, platform: d.platform, accountName: d.accountName,
  period: d.period, sampleCount: d.report.summary.sampleCount, analysisSource: d.report.analysisSource, createdAt: d.createdAt.toISOString() });
const full = d => d ? { ...summary(d), report: d.report } : null;
export const getWeeklyAnalysisReport = async ({ ownerId, id }) => full(await (await database()).collection(WEEKLY_REPORT_COLLECTION).findOne({ _id: objectId(id), managerId: objectId(ownerId) }));
export const listWeeklyAnalysisReports = async ({ ownerId, customerId, platform }) => {
  const filter = { managerId: objectId(ownerId) };
  if (customerId) filter.customerId = text(customerId);
  if (platform) filter.platform = text(platform);
  // Project only metadata and the three report fields used by the summary.
  const docs = await (await database()).collection(WEEKLY_REPORT_COLLECTION).find(filter, { projection: { sourceRows: 0, 'report.sourceRows': 0, 'report.videos': 0, 'report.categories': 0, 'report.plan': 0, 'report.suggestions': 0, 'report.daily': 0, 'report.pools': 0 } }).sort({ createdAt: -1 }).limit(30).toArray();
  return docs.map(summary);
};
export const getPreviousWeeklyReport = async ({ ownerId, customerId, input }) => {
  const previousStart = new Date(Date.parse(input.period.start) - 7 * 86400000).toISOString().slice(0, 10);
  const doc = await (await database()).collection(WEEKLY_REPORT_COLLECTION).findOne({ managerId: objectId(ownerId), customerId: text(customerId), platform: input.platform, accountName: input.accountName, 'period.start': previousStart }, { sort: { createdAt: -1 } });
  return doc?.report || null;
};
export const saveWeeklyAnalysisReport = async ({ ownerId, customerId, report }) => {
  const customer = await requireWeeklyCustomer(customerId);
  if (report?.reportType !== WEEKLY_REPORT_TYPE) throw problem('周报格式无效');
  const input = normalizeWeeklyInput({ platform: report.platform, accountName: report.accountName, period: report.period, nextWeekCount: report.nextWeekCount, rows: report.sourceRows });
  const dictionary = await getTopicCategoryDictionaryForEmployee({ customerId });
  const previous = await getActiveReviewMemory({ customerId, platform: report.platform });
  const canonical = buildWeeklyAnalysisReport({ input, categoryDictionary: dictionary?.tagDictionary || [], previousPlan: weeklyBaselinePlan(previous, await getTopicLibraryCreativeAdaptation({ customerId }), dictionary?.tagDictionary || []),
    previousReport: await getPreviousWeeklyReport({ ownerId, customerId, input }), suggestions: report.analysisSource === 'agent' ? report.suggestions : null,
    extraWarnings: report.analysisSource === 'agent' ? [] : ['AI 建议未生成，解释文字待人工补充'] });
  const identity = { managerId: objectId(ownerId), contentHash: hashes([customerId, input, canonical.suggestions]) };
  const doc = { ...identity, customerId: customer.id, customerName: customer.name, platform: canonical.platform, accountName: canonical.accountName,
    period: canonical.period, report: canonical, createdAt: new Date() };
  const collection = (await database()).collection(WEEKLY_REPORT_COLLECTION);
  try { await collection.updateOne(identity, { $setOnInsert: doc }, { upsert: true }); } catch (error) { if (error.code !== 11000) throw error; }
  return full(await collection.findOne(identity));
};
export const deleteWeeklyAnalysisReport = async ({ ownerId, id }) => {
  const result = await (await database()).collection(WEEKLY_REPORT_COLLECTION).deleteOne({ managerId: objectId(ownerId), _id: objectId(id) });
  return result.deletedCount > 0;
};
const activeKey = (customerId, platform) => JSON.stringify([text(customerId), text(platform)]);
const serializeMemory = d => d ? { id: String(d._id), sourceReportId: d.sourceReportId, customerId: d.customerId, platform: d.platform, accountName: d.accountName,
  period: d.period, plan: d.plan, nextWeekCount: d.nextWeekCount, notes: d.notes, experience: d.experience, createdAt: d.createdAt.toISOString() } : null;
/** Customer/platform read scope matches the existing team-shared topic library. Only confirmed pointers are read. */
export const getActiveReviewMemory = async ({ customerId, platform }) => {
  if (!customerId || !platform) return null;
  const db = await database();
  const active = await db.collection(ACTIVE_COLLECTION).findOne({ _id: activeKey(customerId, platform) });
  if (!active?.versionId) return null;
  return serializeMemory(await db.collection(REVIEW_MEMORY_COLLECTION).findOne({ _id: active.versionId, customerId: text(customerId), platform: text(platform) }));
};
export const listReviewMemoryVersions = async ({ ownerId, customerId, platform }) => {
  const docs = await (await database()).collection(REVIEW_MEMORY_COLLECTION).find({ managerId: objectId(ownerId), customerId: text(customerId), platform: text(platform) }).sort({ createdAt: -1 }).limit(30).toArray();
  return docs.map(serializeMemory);
};
export const confirmReviewMemory = async ({ ownerId, reportId, plan, notes, requestId }) => {
  if (!/^[A-Za-z0-9-]{16,80}$/.test(text(requestId))) throw problem('缺少有效的确认请求标识');
  const saved = await getWeeklyAnalysisReport({ ownerId, id: reportId });
  if (!saved) throw problem('报告不存在或无权操作', 404);
  const dictionary = await getTopicCategoryDictionaryForEmployee({ customerId: saved.customerId });
  const definitions = new Map((dictionary?.tagDictionary || []).map(c => [c.name, new Set((c.subcategories || []).map(s => s.name))]));
  if (saved.report.plan.topics.some(c => !definitions.has(c.name) || c.subcategories.some(s => !definitions.get(c.name).has(s.name)))) throw problem('选题库分类已变化，请重新分析再确认');
  const normalized = normalizeWeeklyPlan(plan, saved.report.plan, saved.report.nextWeekCount);
  const managerId = objectId(ownerId);
  const confirmationKey = text(requestId);
  const db = await database();
  const versions = db.collection(REVIEW_MEMORY_COLLECTION);
  const payloadHash = hashes([saved.id, normalized, text(notes).slice(0, 2000)]);
  const key = activeKey(saved.customerId, saved.platform);
  const pointer = db.collection(ACTIVE_COLLECTION);
  if (!await versions.findOne({ managerId, confirmationKey })) {
    // Mongo allocates the sequence across processes; ObjectIds from different server instances are not globally ordered.
    let clock;
    try { clock = await pointer.findOneAndUpdate({ _id: key }, { $inc: { nextSequence: 1 } }, { upsert: true, returnDocument: 'after' }); }
    catch (error) {
      if (error.code !== 11000) throw error;
      clock = await pointer.findOneAndUpdate({ _id: key }, { $inc: { nextSequence: 1 } }, { returnDocument: 'after' });
    }
    const doc = { _id: new ObjectId(), sequence: clock.nextSequence, managerId, confirmationKey, payloadHash, sourceReportId: saved.id, customerId: saved.customerId,
      platform: saved.platform, accountName: saved.accountName, period: saved.period, nextWeekCount: saved.report.nextWeekCount,
      plan: normalized, notes: text(notes).slice(0, 2000), experience: saved.report.suggestions, createdAt: new Date() };
    try { await versions.updateOne({ managerId, confirmationKey }, { $setOnInsert: doc }, { upsert: true }); } catch (error) { if (error.code !== 11000) throw error; }
  }
  const version = await versions.findOne({ managerId, confirmationKey });
  if (version.payloadHash !== payloadHash) throw problem('确认请求内容已变化，请重新确认', 409);
  // Equal and older sequences are no-ops, including retries of a deactivated version.
  await pointer.updateOne({ _id: key, $or: [{ lastSequence: { $lt: version.sequence } }, { lastSequence: { $exists: false } }] },
    { $set: { versionId: version._id, lastSequence: version.sequence, managerId, customerId: version.customerId, platform: version.platform } });
  return { version: serializeMemory(version), active: await getActiveReviewMemory(version) };
};
export const deactivateReviewMemory = async ({ ownerId, customerId, platform, versionId }) => {
  const result = await (await database()).collection(ACTIVE_COLLECTION).updateOne({ _id: activeKey(customerId, platform), managerId: objectId(ownerId), versionId: objectId(versionId) }, { $set: { versionId: null } });
  if (!result.matchedCount) throw problem('当前生效版本已变化或无权停用，请刷新后重试', 409);
};
