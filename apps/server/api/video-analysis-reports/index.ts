import { json, readBody } from "../_lib/common.js";
import { requireAuth, requireManager } from "../_lib/auth.js";
import {
  deleteVideoAnalysisReport,
  getVideoAnalysisReport,
  getVideoAnalysisReportForCustomer,
  listVideoAnalysisReports,
  listVideoAnalysisReportsForCustomer,
  saveVideoAnalysisReport,
} from "../_lib/videoAnalysisStore.js";

// GET    /api/video-analysis-reports                        → 经理：自己建的列表（元数据）
// GET    /api/video-analysis-reports?id=xxx                 → 经理：自己建的单份正文
// GET    /api/video-analysis-reports?customerId=xxx         → **员工也可读**：该客户的列表（元数据）
// GET    /api/video-analysis-reports?customerId=xxx&id=xxx  → **员工也可读**：该客户的单份正文
// POST   /api/video-analysis-reports                        → 保存（幂等）
// DELETE /api/video-analysis-reports?id=xxx                 → 删除（只能删自己建的）
//
// ── 鉴权口径（2026-09-30，与其它六个报告 store 的差异）────────────────────────
//
// 用户拍板「经理端新模块 4 + 员工端只读/单条分析」，所以 4.1 **允许员工创建**。
// 边界仍然是「按客户」而不是「按所有人」：
//   · 带 `customerId` 的读一律 `requireAuth` —— 同一客户的数据是团队共用的；
//   · **不带 `customerId` 的读**（按 id 取单份 / 列自己的全部）仍然 `requireManager`，
//     否则员工拿到一个 id 就能读任意项目经理的报告；
//   · 写操作 `requireAuth`：`managerId` 存的是**创建者 id**，所以员工只能删自己建的
//     （`deleteVideoAnalysisReport` 按 managerId 收口）。
export default async function handler(req: any, res: any) {
  const customerId = String(req.query?.customerId || "").trim();
  const isCustomerScoped = Boolean(customerId);
  const user = isCustomerScoped
    ? await requireAuth(req, res)
    : await requireManager(req, res);
  if (!user) return;

  try {
    if (req.method === "GET") {
      const id = String(req.query?.id || "").trim();

      if (isCustomerScoped) {
        // 员工侧：按客户收口（不按 managerId 过滤 —— 同一客户的数据团队共用）。
        if (id) {
          const item = await getVideoAnalysisReportForCustomer({ customerId, id });
          if (!item) return json(res, 404, { success: false, error: "报告不存在或不属于该客户" });
          return json(res, 200, { success: true, item });
        }
        const limit = Number(req.query?.limit || 20);
        return json(res, 200, { success: true, items: await listVideoAnalysisReportsForCustomer({ customerId, limit }) });
      }

      if (id) {
        const item = await getVideoAnalysisReport({ ownerId: user.id, id });
        if (!item) return json(res, 404, { success: false, error: "报告不存在或已被删除" });
        return json(res, 200, { success: true, item });
      }
      const limit = Number(req.query?.limit || 12);
      return json(res, 200, { success: true, items: await listVideoAnalysisReports({ ownerId: user.id, limit }) });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const item = await saveVideoAnalysisReport({
        ownerId: user.id,
        customerId: body?.customerId,
        customerName: body?.customerName,
        report: body?.report,
      });
      return json(res, 201, { success: true, item });
    }

    if (req.method === "DELETE") {
      const id = String(req.query?.id || readBody(req)?.id || "").trim();
      if (!id) return json(res, 400, { success: false, error: "缺少报告 id" });
      const result = await deleteVideoAnalysisReport({ ownerId: user.id, id });
      if (!result.deleted) return json(res, 404, { success: false, error: "报告不存在或已被删除" });
      return json(res, 200, { success: true });
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (error: any) {
    return json(res, error?.status || 500, {
      success: false,
      error: error instanceof Error ? error.message : "Video analysis report request failed",
    });
  }
}
