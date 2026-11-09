import 'dotenv/config';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import { spawn } from 'node:child_process';

const client = await new MongoClient(process.env.MONGODB_URI).connect();
const database = `xmmerge_ui_${Date.now().toString(36)}`;
const db = client.db(database);
const passwordHash = await bcrypt.hash('MergePreview123', 10);
await db.collection('users').insertOne({ name: '合并验收经理', email: 'mergepreview@example.test', passwordHash });
const employee = await db.collection('employees').insertOne({ name: '验收员工', account: 'mergepreview-employee', passwordHash, status: 'active', createdAt: new Date() });
const customer = await db.collection('customers').insertOne({ name: '演示客户', occupation: '知识顾问', contact: '', notes: '仅用于合并界面验收', createdAt: new Date() });
await db.collection('tasks').insertOne({ customerId: customer.insertedId, customerName: '演示客户', ownerId: employee.insertedId, platformName: '抖音', collaborationPeriod: { start: new Date(Date.now() - 86400000), end: new Date(Date.now() + 86400000) }, status: 'pending', priority: 'medium', contentRequirements: ['口播'], createdAt: new Date() });
const child = spawn(process.execPath, ['src/index.js'], { env: { ...process.env, MONGODB_DB_NAME: database, PORT: '8792' }, stdio: 'inherit' });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  child.kill();
  await db.dropDatabase();
  await client.close();
  process.exit(0);
}
process.on('SIGTERM', close);
process.on('SIGINT', close);
child.on('exit', close);
console.log('PREVIEW: http://127.0.0.1:8792 — mergepreview@example.test / MergePreview123 (temporary test data)');
