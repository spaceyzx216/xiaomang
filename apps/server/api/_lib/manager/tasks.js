import { getDb, objectId, problem, text } from './db.js';
import { normalizeIpProfileInput, createProfileSnapshot } from './ipProfile.js';

export function shanghaiDay(date = new Date()) {
  const value = typeof date === 'string' ? date : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw problem('日期格式应为 YYYY-MM-DD');
  const start = new Date(value + 'T00:00:00+08:00');
  if (!Number.isFinite(start.getTime())) throw problem('无效日期');
  return { start, end: new Date(start.getTime() + 86400000) };
}
const joins = [
  { $lookup: { from: 'employees', localField: 'ownerId', foreignField: '_id', pipeline: [{ $project: { name: 1, email: 1, department: 1 } }], as: '_employee' } },
  { $lookup: { from: 'users', localField: 'ownerId', foreignField: '_id', pipeline: [{ $project: { name: 1, email: 1 } }], as: '_manager' } },
  { $lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', pipeline: [{ $project: { name: 1, occupation: 1, contact: 1, ipPositioning: 1, contentNeeds: 1, benchmarkAccounts: 1, notes: 1 } }], as: '_customer' } },
  { $set: { ownerId: { $ifNull: [{ $arrayElemAt: ['$_employee', 0] }, { $arrayElemAt: ['$_manager', 0] }] }, customerId: { $arrayElemAt: ['$_customer', 0] } } },
  { $unset: ['_employee', '_manager', '_customer'] },
];
export async function findTasks(filter = {}, sort = { 'collaborationPeriod.start': 1, createdAt: -1 }) {
  return (await getDb()).collection('tasks').aggregate([{ $match: filter }, { $sort: sort }, ...joins]).toArray();
}
export async function findTask(id) { return (await findTasks({ _id: objectId(id) }))[0] || null; }
export async function normalizeTaskPayload(input, existing) {
  const db = await getDb();
  const next = existing ? { ...existing } : { status: 'pending', priority: 'medium', contentRequirements: [], createdAt: new Date(), aiAnalysis: '' };
  for (const key of ['customerName', 'customerOccupation', 'contact', 'ipPositioning', 'contentDirection', 'benchmarkAccounts', 'notes', 'platformName', 'status', 'priority']) {
    if (input[key] !== undefined) next[key] = text(input[key]);
  }
  if (input.ownerId !== undefined) next.ownerId = objectId(input.ownerId);
  if (!next.ownerId) throw problem('请选择任务负责人');
  const [employee, manager] = await Promise.all([
    db.collection('employees').findOne({ _id: next.ownerId, status: { $ne: 'disabled' } }, { projection: { _id: 1 } }),
    db.collection('users').findOne({ _id: next.ownerId }, { projection: { _id: 1 } }),
  ]);
  if (!employee && !manager) throw problem('任务负责人不存在或已停用');
  if (input.customerId !== undefined) next.customerId = input.customerId ? objectId(input.customerId) : null;
  if (input.customerId !== undefined && !next.customerId) {
    next.ipProfileVersion = null;
    next.ipProfileStatus = null;
    next.ipProfileSnapshot = null;
  }
  if (next.customerId && (!existing || input.customerId !== undefined || input.useCustomerProfile !== undefined)) {
    const customer = await db.collection('customers').findOne({ _id: next.customerId });
    if (!customer) throw problem('所选客户不存在');
    const profile = input.useCustomerProfile !== false && customer.ipProfile ? normalizeIpProfileInput(customer.ipProfile) : null;
    next.customerName ||= customer.name;
    next.customerOccupation ||= profile?.identity.occupation || customer.occupation || '';
    next.contact ||= customer.contact || '';
    next.ipPositioning ||= customer.ipPositioning || '';
    next.contentDirection ||= customer.contentNeeds || '';
    next.benchmarkAccounts ||= customer.benchmarkAccounts || '';
    next.notes ||= customer.notes || '';
    next.ipProfileVersion = profile ? Number(customer.ipProfile.profileVersion || 0) : null;
    next.ipProfileStatus = profile ? customer.ipProfile.status || 'draft' : null;
    next.ipProfileSnapshot = profile ? createProfileSnapshot(customer.ipProfile) : null;
  }
  if (!next.customerName || !next.platformName) throw problem('客户名称和发布平台必填');
  if (!['pending', 'in_progress', 'completed'].includes(next.status)) throw problem('无效任务状态');
  if (!['low', 'medium', 'high'].includes(next.priority)) throw problem('无效优先级');
  if (input.contentRequirements !== undefined) {
    if (!Array.isArray(input.contentRequirements)) throw problem('内容需求必须为数组');
    next.contentRequirements = input.contentRequirements.map(text).filter(Boolean);
  }
  const period = input.collaborationPeriod ?? next.collaborationPeriod;
  const start = new Date(period?.start), end = new Date(period?.end);
  if (!period?.start || !period?.end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) throw problem('请填写有效的合作起止日期');
  next.collaborationPeriod = { start, end };
  return next;
}
export async function createTasks(inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 200) throw problem('每次请创建 1 至 200 条任务');
  const documents = await Promise.all(inputs.map(input => normalizeTaskPayload(input)));
  const result = await (await getDb()).collection('tasks').insertMany(documents);
  return findTasks({ _id: { $in: Object.values(result.insertedIds) } });
}
export async function updateTask(id, input) {
  const collection = (await getDb()).collection('tasks');
  const _id = objectId(id);
  const existing = await collection.findOne({ _id });
  if (!existing) throw problem('任务不存在', 404);
  const { _id: ignored, ...fields } = await normalizeTaskPayload(input, existing);
  await collection.updateOne({ _id }, { $set: fields });
  return findTask(id);
}
