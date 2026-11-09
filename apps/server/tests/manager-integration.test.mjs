import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

test('unified manager CRUD, employee handoff, workbench permissions and private data', { timeout: 45000 }, async t => {
  const config = dotenv.parse(fs.readFileSync(new URL('../.env', import.meta.url)));
  const client = new MongoClient(process.env.MONGODB_URI || config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const databaseName = `xmmerge_${process.pid}_${Date.now().toString(36)}`;
  const db = client.db(databaseName);
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await db.dropDatabase();
    await client.close();
  });
  const manager = await db.collection('users').insertOne({ name: '合并验收经理', email: 'merge-manager@example.test', passwordHash: await bcrypt.hash('MergePass123', 10) });
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let logs = '';
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, ...config, MONGODB_DB_NAME: databaseName, PORT: String(port), AUTH_SESSION_SECRET: 'merge-integration-secret', JWT_SECRET: 'merge-integration-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-6000); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'unified server starts');
  async function request(path, { cookie, method = 'GET', body } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const loggedIn = await request('/api/auth/login', { method: 'POST', body: { login: 'merge-manager@example.test', password: 'MergePass123' } });
  assert.equal(loggedIn.status, 200);
  const cookie = loggedIn.cookie;
  const admin = (path, options = {}) => request('/api/management' + path, { cookie, ...options });
  assert.equal((await request('/api/management/employees')).status, 401);
  const createdEmployee = await admin('/employees', { method: 'POST', body: { name: '员工甲', account: 'merge-employee', password: 'Employee123' } });
  assert.equal(createdEmployee.status, 201);
  assert.equal(createdEmployee.body.password, undefined);
  assert.equal(createdEmployee.body.passwordHash, undefined);
  const employeeId = createdEmployee.body._id;
  const storedEmployee = await db.collection('employees').findOne({ account: 'merge-employee' });
  assert.equal(storedEmployee.password, undefined);
  assert.ok(await bcrypt.compare('Employee123', storedEmployee.passwordHash));
  assert.equal((await admin('/employees', { method: 'POST', body: { name: '重复', account: 'MERGE-EMPLOYEE', password: 'Employee123' } })).status, 409);
  assert.equal((await admin(`/employees/${employeeId}`, { method: 'PUT', body: { name: '员工甲更新', password: '' } })).status, 200);
  const employeeSession = await request('/api/auth/login', { method: 'POST', body: { login: 'merge-employee', password: 'Employee123' } });
  assert.equal(employeeSession.status, 200);
  assert.equal((await request('/api/management/employees', { cookie: employeeSession.cookie })).status, 403);
  const customer = await admin('/customers', { method: 'POST', body: { name: '迁移客户', occupation: '顾问', notes: '真实访谈' } });
  assert.equal(customer.status, 201);
  const customerId = customer.body._id;
  const profile = await admin(`/customers/${customerId}/ip-profile`);
  const savedProfile = await admin(`/customers/${customerId}/ip-profile`, { method: 'PUT', body: { action: 'save_draft', profile: profile.body.profile, expectedUpdatedAt: profile.body.updatedAt } });
  assert.equal(savedProfile.status, 200);
  assert.equal((await admin(`/customers/${customerId}/ip-profile`, { method: 'PUT', body: { action: 'save_draft', profile: profile.body.profile, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' } })).status, 409);
  const time = Date.now();
  const taskPayload = { customerId, ownerId: employeeId, platformName: '抖音', collaborationPeriod: { start: new Date(time - 86400000), end: new Date(time + 86400000) }, contentRequirements: ['口播'], priority: 'high' };
  const task = await admin('/tasks', { method: 'POST', body: taskPayload });
  assert.equal(task.status, 201);
  assert.equal(task.body.customerId._id, customerId);
  assert.equal(task.body.ownerId._id, employeeId);
  assert.equal(task.body.ownerId.passwordHash, undefined);
  assert.equal(task.body.ipProfileSnapshot.identity.name, '迁移客户');
  const today = await request('/api/tasks/today', { cookie: employeeSession.cookie });
  assert.equal(today.status, 200);
  assert.equal(today.body.data.length, 1);
  assert.equal(today.body.data[0].customerId, customerId, 'manager→employee handoff retains the customer library key');
  const managerTask = await admin('/tasks', { method: 'POST', body: { ...taskPayload, ownerId: String(manager.insertedId) } });
  assert.equal(managerTask.status, 201);
  const managerToday = await request('/api/tasks/today', { cookie });
  assert.equal(managerToday.status, 200);
  assert.equal(managerToday.body.data.length, 1, 'manager only reads own workbench tasks');
  assert.equal(managerToday.body.data[0].ownerName, '合并验收经理');
  assert.equal((await request('/api/tasks/session', { cookie, method: 'POST', body: { taskUserId: employeeId } })).status, 403);
  assert.equal((await request('/api/adhoc-analyses', { cookie })).status, 200);
  assert.equal((await admin('/tasks', { method: 'POST', body: { ...taskPayload, ownerId: 'bad-id' } })).status, 400);
  assert.equal((await admin(`/employees/${employeeId}`, { method: 'DELETE' })).status, 409);
  assert.equal((await admin(`/customers/${customerId}`, { method: 'DELETE' })).status, 409);
  assert.equal((await admin('/tasks/batch', { method: 'POST', body: { tasks: [taskPayload, { ...taskPayload, ownerId: 'bad-id' }] } })).status, 400);
  assert.equal(await db.collection('tasks').countDocuments(), 2, 'batch validation writes no partial tasks');
  assert.equal((await admin(`/tasks/${task.body._id}`, { method: 'PUT', body: { status: 'completed' } })).status, 200);
  assert.equal((await request('/api/tasks/today', { cookie: employeeSession.cookie })).body.data.length, 0);
  for (const id of [task.body._id, managerTask.body._id]) assert.equal((await admin(`/tasks/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin(`/customers/${customerId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin(`/employees/${employeeId}`, { method: 'DELETE' })).status, 200);
});
