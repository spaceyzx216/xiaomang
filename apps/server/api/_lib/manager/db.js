import { MongoClient, ObjectId } from 'mongodb';

let connection;
export async function getDb() {
  if (!connection) {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI is not configured');
    connection = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 }).connect().catch(error => {
      connection = undefined;
      throw error;
    });
  }
  return (await connection).db(process.env.MONGODB_DB_NAME || undefined);
}
export async function closeManagerDb() {
  const current = connection;
  connection = undefined;
  if (current) await (await current).close();
}
export function problem(message, status = 400) { return Object.assign(new Error(message), { status }); }
export function objectId(value) {
  const text = String(value || '');
  if (!/^[a-f0-9]{24}$/i.test(text)) throw problem('无效的记录 ID');
  return new ObjectId(text);
}
export const text = value => String(value ?? '').trim();
export const safeEmployeeProjection = { password: 0, passwordHash: 0 };

export async function ensureManagerIndexes() {
  const db = await getDb();
  await Promise.all([
    db.collection('employees').createIndex({ account: 1 }, { unique: true }),
    db.collection('customers').createIndex({ name: 1 }, { unique: true }),
    db.collection('tasks').createIndex({ customerId: 1, createdAt: -1 }),
    db.collection('tasks').createIndex({ ownerId: 1, 'collaborationPeriod.start': 1 }),
  ]);
}
