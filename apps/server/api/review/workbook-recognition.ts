import { json, readBody } from '../_lib/common.js';
import { requireAuth } from '../_lib/auth.js';
import { getReviewInputOptions, recognizeReviewWorkbook } from '../_lib/reviewWorkbookRecognition.js';
export const config = { maxDuration: 180 };
export default async function handler(req: any, res: any) {
  const user = await requireAuth(req, res);
  if (!user) return;
  try {
    if (req.method === 'GET') return json(res, 200, { success: true, ...getReviewInputOptions(req.query?.platform) });
    if (req.method !== 'POST') return json(res, 405, { success: false, error: 'Method not allowed' });
    return json(res, 200, { success: true, ...await recognizeReviewWorkbook({ body: readBody(req) }) });
  } catch (error: any) { return json(res, error.status || 500, { success: false, error: error.message || '表格识别失败' }); }
}
