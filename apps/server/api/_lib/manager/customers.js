import { getDb, objectId, problem } from './db.js';

export async function findCustomers() {
  return (await getDb()).collection('customers').find().sort({ createdAt: -1 }).toArray();
}
export async function findCustomer(id) {
  return (await getDb()).collection('customers').findOne({ _id: objectId(id) });
}
export async function insertCustomer(payload) {
  const document = { ...payload, createdAt: new Date() };
  const result = await (await getDb()).collection('customers').insertOne(document);
  return { ...document, _id: result.insertedId };
}
export async function saveCustomer(document, previousUpdatedAt) {
  const { _id, ...fields } = document;
  const filter = { _id: objectId(_id) };
  if (previousUpdatedAt !== undefined) filter['ipProfile.updatedAt'] = previousUpdatedAt;
  const saved = await (await getDb()).collection('customers').findOneAndUpdate(filter, { $set: fields }, { returnDocument: 'after' });
  if (!saved) throw problem('客户档案已被修改或删除，请刷新后重试', 409);
  return saved;
}
export async function deleteCustomer(id) {
  const db = await getDb();
  const _id = objectId(id);
  if (await db.collection('tasks').findOne({ customerId: _id })) throw problem('客户仍关联任务，请先处理关联任务', 409);
  return db.collection('customers').findOneAndDelete({ _id });
}
