import { json, readBody } from "../_lib/common.js";
import { requireManager } from "../_lib/auth.js";
import {
  deleteGoldThreeSecondReport,
  getGoldThreeSecondReport,
  listGoldThreeSecondReports,
  saveGoldThreeSecondReport,
} from "../_lib/goldThreeSecondStore.js";

// GET    /api/gold-three-second-reports          → 列表（只返回元数据）
// GET    /api/gold-three-second-reports?id=xxx   → 单份完整报告
// POST   /api/gold-three-second-reports          → 保存（幂等）
// DELETE /api/gold-three-second-reports?id=xxx   → 删除
export default async function handler(req: any, res: any) {
  const manager = await requireManager(req, res);
  if (!manager) return;

  try {
    if (req.method === "GET") {
      const id = String(req.query?.id || "").trim();
      if (id) {
        const item = await getGoldThreeSecondReport({ ownerId: manager.id, id });
        if (!item) return json(res, 404, { success: false, error: "报告不存在或已被删除" });
        return json(res, 200, { success: true, item });
      }
      const limit = Number(req.query?.limit || 12);
      return json(res, 200, { success: true, items: await listGoldThreeSecondReports({ ownerId: manager.id, limit }) });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const item = await saveGoldThreeSecondReport({ ownerId: manager.id, report: body?.report });
      return json(res, 201, { success: true, item });
    }

    if (req.method === "DELETE") {
      const id = String(req.query?.id || readBody(req)?.id || "").trim();
      if (!id) return json(res, 400, { success: false, error: "缺少报告 id" });
      const result = await deleteGoldThreeSecondReport({ ownerId: manager.id, id });
      if (!result.deleted) return json(res, 404, { success: false, error: "报告不存在或已被删除" });
      return json(res, 200, { success: true });
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (error) {
    return json(res, 500, { success: false, error: error instanceof Error ? error.message : "Gold three seconds report request failed" });
  }
}
