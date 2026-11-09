import { json, readBody } from "../_lib/common.js";
import { requireEmployee } from "../_lib/auth.js";
import {
  createAdhocAnalysis,
  deleteAdhocAnalysis,
  listAdhocAnalyses,
} from "../_lib/adhocAnalysisStore.js";

// 员工「临时分析」—— 不关联客户的对标账号分析记录（见 `api/_lib/adhocAnalysisStore.js` 的文件头）。
//
// 🔴 与其它报告端点都不同：数据是**员工私有**的，每个操作都按 userId 收口，
//    并且这里用 `requireEmployee` —— 项目经理调会拿到 403，看不到员工的临时分析。
//
// GET    /api/adhoc-analyses          → 我的临时分析列表
// POST   /api/adhoc-analyses          → 新建（返回新建的那一条，前端拿它直接进工作流）
// DELETE /api/adhoc-analyses?id=xxx   → 删除我的一条
export default async function handler(req: any, res: any) {
  const user = await requireEmployee(req, res);
  if (!user) return;
  // 与 `/api/tasks/today` 同一口径：员工的 `id` / `_id` / `employeeId` 是同一个值，
  // 但仍按这个顺序取，保证与 tasks 的归属口径完全一致。
  const userId = String(user.employeeId || user.id || "").trim();

  try {
    if (req.method === "GET") {
      return json(res, 200, { success: true, items: await listAdhocAnalyses(userId) });
    }

    if (req.method === "POST") {
      const result = await createAdhocAnalysis(userId, readBody(req));
      if (!result.ok) return json(res, 400, { success: false, error: result.error });
      return json(res, 201, { success: true, item: result.item });
    }

    if (req.method === "DELETE") {
      const id = String(req.query?.id || readBody(req)?.id || "").trim();
      if (!id) return json(res, 400, { success: false, error: "缺少记录 id" });
      const result = await deleteAdhocAnalysis(userId, id);
      if (!result.deleted) return json(res, 404, { success: false, error: "记录不存在或已被删除" });
      return json(res, 200, { success: true });
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (error) {
    return json(res, 500, { success: false, error: error instanceof Error ? error.message : "Adhoc analysis request failed" });
  }
}
