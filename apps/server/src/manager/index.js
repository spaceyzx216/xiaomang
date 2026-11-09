import { Router } from 'express';
import bcrypt from 'bcryptjs';
import customers from './customers.js';
import ai from './ai.js';
import { getDb, objectId, problem, text, safeEmployeeProjection } from '../../api/_lib/manager/db.js';
import { createTasks, findTask, findTasks, updateTask, shanghaiDay } from '../../api/_lib/manager/tasks.js';

const router = Router();
router.use((req, res, next) => {
  if (req.authUser?.role !== 'manager') return res.status(403).json({ error: '该功能仅供项目经理使用' });
  req.user = { ...req.authUser, _id: objectId(req.authUser.id) };
  next();
});
router.use('/customers', customers);
router.use('/ai', ai);

router.get('/employees/options', async (_req, res) => {
  const db = await getDb();
  const [employees, managers] = await Promise.all([
    db.collection('employees').find({ status: { $ne: 'disabled' } }, { projection: { name: 1, department: 1, status: 1 } }).sort({ createdAt: -1 }).toArray(),
    db.collection('users').find({}, { projection: { name: 1 } }).toArray(),
  ]);
  res.json([...employees.map(e => ({ ...e, role: 'employee' })), ...managers.map(m => ({ ...m, role: 'manager', department: '项目经理', status: 'active' }))]);
});
router.get('/employees', async (_req, res) => res.json(await (await getDb()).collection('employees').find({}, { projection: safeEmployeeProjection }).sort({ createdAt: -1 }).toArray()));
router.get('/employees/:id', async (req, res) => {
  const item = await (await getDb()).collection('employees').findOne({ _id: objectId(req.params.id) }, { projection: safeEmployeeProjection });
  if (!item) throw problem('员工不存在', 404);
  res.json(item);
});
async function employeeInput(body, create, editingId) {
  const updates = {};
  for (const key of ['name', 'account', 'email', 'department', 'status']) if (body[key] !== undefined) updates[key] = text(body[key]);
  if ((create || body.name !== undefined) && !updates.name) throw problem('姓名必填');
  if ((create || body.account !== undefined) && !updates.account) throw problem('账号必填');
  if (updates.status !== undefined && !['active', 'disabled'].includes(updates.status)) throw problem('无效员工状态');
  if (create || body.password) {
    if (String(body.password || '').length < 6) throw problem('密码至少 6 位');
    updates.passwordHash = await bcrypt.hash(String(body.password), 12);
  }
  if (updates.account) {
    const db = await getDb();
    const exact = updates.account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const collision = await db.collection('employees').findOne({ account: new RegExp(`^${exact}$`, 'i'), ...(editingId ? { _id: { $ne: objectId(editingId) } } : {}) });
    if (collision || await db.collection('users').findOne({ email: updates.account.toLowerCase() })) throw problem('该账号已被使用', 409);
  }
  return updates;
}
router.post('/employees', async (req, res) => {
  const payload = { ...await employeeInput(req.body, true), status: 'active', createdAt: new Date() };
  const collection = (await getDb()).collection('employees');
  const result = await collection.insertOne(payload);
  res.status(201).json(await collection.findOne({ _id: result.insertedId }, { projection: safeEmployeeProjection }));
});
router.put('/employees/:id', async (req, res) => {
  const fields = await employeeInput(req.body, false, req.params.id);
  const item = await (await getDb()).collection('employees').findOneAndUpdate({ _id: objectId(req.params.id) }, { $set: fields, $unset: { password: '' } }, { returnDocument: 'after', projection: safeEmployeeProjection });
  if (!item) throw problem('员工不存在', 404);
  res.json(item);
});
router.delete('/employees/:id', async (req, res) => {
  const db = await getDb(), _id = objectId(req.params.id);
  if (await db.collection('tasks').findOne({ ownerId: _id })) throw problem('员工仍有关联任务，请先重新分配任务或停用账号', 409);
  if (!await db.collection('employees').findOneAndDelete({ _id })) throw problem('员工不存在', 404);
  res.json({ message: '员工已删除' });
});

router.get('/tasks/today/grouped', async (_req, res) => {
  const { start, end } = shanghaiDay();
  const tasks = await findTasks({ 'collaborationPeriod.start': { $lt: end }, 'collaborationPeriod.end': { $gte: start } });
  const groups = new Map();
  for (const task of tasks) {
    const key = String(task.ownerId?._id || 'unknown');
    if (!groups.has(key)) groups.set(key, { employee: task.ownerId, tasks: [] });
    groups.get(key).tasks.push(task);
  }
  res.json([...groups.values()]);
});
router.get('/tasks', async (req, res) => {
  const { employeeId, projectId, status, date } = req.query;
  const filter = {};
  if (employeeId) filter.ownerId = objectId(employeeId);
  if (projectId) filter.platformName = text(projectId);
  if (status) filter.status = text(status);
  if (date) { const { start, end } = shanghaiDay(date); filter['collaborationPeriod.start'] = { $lt: end }; filter['collaborationPeriod.end'] = { $gte: start }; }
  res.json(await findTasks(filter));
});
router.get('/tasks/:id', async (req, res) => {
  const task = await findTask(req.params.id);
  if (!task) throw problem('任务不存在', 404);
  res.json(task);
});
router.post('/tasks', async (req, res) => res.status(201).json((await createTasks([req.body]))[0]));
router.post('/tasks/batch', async (req, res) => res.status(201).json(await createTasks(req.body.tasks)));
router.put('/tasks/:id', async (req, res) => res.json(await updateTask(req.params.id, req.body)));
router.delete('/tasks/:id', async (req, res) => {
  if (!await (await getDb()).collection('tasks').findOneAndDelete({ _id: objectId(req.params.id) })) throw problem('任务不存在', 404);
  res.json({ message: '任务已删除' });
});

router.get('/projects', async (_req, res) => res.json(await (await getDb()).collection('projects').find().sort({ createdAt: -1 }).toArray()));
router.get('/projects/:id', async (req, res) => {
  const item = await (await getDb()).collection('projects').findOne({ _id: objectId(req.params.id) });
  if (!item) throw problem('项目不存在', 404);
  res.json(item);
});
function projectInput(body) {
  const payload = { name: text(body.name), description: text(body.description), status: text(body.status || 'active') };
  if (!payload.name || !['active', 'completed', 'archived'].includes(payload.status)) throw problem('项目名称或状态无效');
  if (body.managerId) payload.managerId = objectId(body.managerId);
  return payload;
}
router.post('/projects', async (req, res) => {
  const item = { ...projectInput(req.body), createdAt: new Date() };
  const result = await (await getDb()).collection('projects').insertOne(item);
  res.status(201).json({ ...item, _id: result.insertedId });
});
router.put('/projects/:id', async (req, res) => {
  const item = await (await getDb()).collection('projects').findOneAndUpdate({ _id: objectId(req.params.id) }, { $set: projectInput(req.body) }, { returnDocument: 'after' });
  if (!item) throw problem('项目不存在', 404);
  res.json(item);
});
router.delete('/projects/:id', async (req, res) => {
  if (!await (await getDb()).collection('projects').findOneAndDelete({ _id: objectId(req.params.id) })) throw problem('项目不存在', 404);
  res.json({ message: '项目已删除' });
});
router.use((error, _req, res, _next) => {
  res.status(error.code === 11000 ? 409 : error.status || 500).json({ error: error.code === 11000 ? '记录已存在，请检查名称或账号' : error.message });
});
export default router;
