import { json, readBody } from '../_lib/common.js';
import { requireAuth } from '../_lib/auth.js';
import { handleWeeklyRequest } from '../_lib/weeklyRoutes.js';
export default async function handler(req: any, res: any) {
  const user = await requireAuth(req, res);
  if (!user) return;
  const result = await handleWeeklyRequest({ method: req.method, user, body: readBody(req), query: req.query, resource: 'memory' });
  return json(res, result.status, result.payload);
}
