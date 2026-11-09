/** Both Express and Vercel call these handlers after resolving the same authenticated user. */
import { runWeeklyAnalysis } from './weeklyAgentRunner.js';
import { confirmReviewMemory, deactivateReviewMemory, deleteWeeklyAnalysisReport, getActiveReviewMemory, getWeeklyAnalysisReport, listReviewMemoryVersions, listWeeklyAnalysisReports, saveWeeklyAnalysisReport } from './weeklyAnalysisStore.js';
import { problem } from './manager/db.js';
import { isReviewPlatform } from './reviewMetrics.js';
import { MAX_WEEKLY_ROWS, normalizeWeeklyPlan, WEEKLY_STRUCTURE_FIELDS } from './weeklyAnalysis.js';
const manager = user => { if (!user) throw problem('请先登录', 401); if (user.role !== 'manager') throw problem('该功能仅供项目经理使用', 403); };
export const handleWeeklyRequest = async ({ method, user, body = {}, query = {}, resource }) => {
  try {
    if (!user) throw problem('请先登录', 401);
    if (resource === 'memory' && method === 'GET' && query.view === 'active') {
      if (!query.customerId || !isReviewPlatform(query.platform)) throw problem('请指定客户和平台');
      return { status: 200, payload: { success: true, item: await getActiveReviewMemory(query) } };
    }
    manager(user);
    const ownerId = user.id;
    if (resource === 'analysis' && method === 'GET') return { status: 200, payload: { success: true, maxRows: MAX_WEEKLY_ROWS, structures: WEEKLY_STRUCTURE_FIELDS } };
    if (resource === 'analysis' && method === 'POST') return { status: 200, payload: { success: true, report: await runWeeklyAnalysis({ ownerId, customerId: body.customerId, body }) } };
    if (resource === 'reports') {
      if (method === 'GET') {
        if (query.id) { const item = await getWeeklyAnalysisReport({ ownerId, id: query.id }); if (!item) throw problem('报告不存在或无权读取', 404); return { status: 200, payload: { success: true, item } }; }
        return { status: 200, payload: { success: true, items: await listWeeklyAnalysisReports({ ownerId, customerId: query.customerId, platform: query.platform }) } };
      }
      if (method === 'POST') return { status: 201, payload: { success: true, item: await saveWeeklyAnalysisReport({ ownerId, customerId: body.customerId, report: body.report }) } };
      if (method === 'DELETE') { if (!await deleteWeeklyAnalysisReport({ ownerId, id: query.id })) throw problem('报告不存在或无权删除', 404); return { status: 200, payload: { success: true } }; }
    }
    if (resource === 'memory') {
      if (method === 'POST' && body.action === 'preview') {
        const saved = await getWeeklyAnalysisReport({ ownerId, id: body.reportId });
        if (!saved) throw problem('报告不存在或无权操作', 404);
        return { status: 200, payload: { success: true, plan: normalizeWeeklyPlan(body.plan, saved.report.plan, saved.report.nextWeekCount) } };
      }
      if (method === 'POST') return { status: 201, payload: { success: true, ...await confirmReviewMemory({ ownerId, reportId: body.reportId, plan: body.plan, notes: body.notes, requestId: body.requestId }) } };
      if (!query.customerId || !isReviewPlatform(query.platform)) throw problem('请指定客户和平台');
      if (method === 'GET') return { status: 200, payload: { success: true, items: await listReviewMemoryVersions({ ownerId, ...query }), active: await getActiveReviewMemory(query) } };
      if (method === 'DELETE') { await deactivateReviewMemory({ ownerId, customerId: query.customerId, platform: query.platform, versionId: query.id }); return { status: 200, payload: { success: true } }; }
    }
    return { status: 405, payload: { success: false, error: 'Method not allowed' } };
  } catch (error) { return { status: error.status || 500, payload: { success: false, error: error.message || '周度复盘请求失败' } }; }
};
