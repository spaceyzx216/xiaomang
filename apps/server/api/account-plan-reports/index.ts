import { json, readBody } from "../_lib/common.js";
import { requireAuth, requireManager } from "../_lib/auth.js";
import {
  deleteAccountPlanReport,
  getAccountPlanReport,
  getLatestAccountPlanReportForCustomer,
  listAccountPlanReports,
  listAccountPlanReportsForCustomer,
  saveAccountPlanReport,
} from "../_lib/accountPlanStore.js";

// GET    /api/account-plan-reports                    → 经理：列表（只返回元数据）
// GET    /api/account-plan-reports?id=xxx             → 经理：单份完整报告
// GET    /api/account-plan-reports?customerId=xxx     → **员工也可读**：该客户的列表（元数据）
// GET    /api/account-plan-reports?customerId=xxx&latest=1 → **员工也可读**：该客户最新一份正文
// POST   /api/account-plan-reports                    → 保存（幂等）
// DELETE /api/account-plan-reports?id=xxx             → 删除
//
// ── 鉴权为什么要分叉（2026-09-21 第七轮，用户拍板「3.3 账号标签文档直接开放权限」）──
//
// 3.3 账号标签要从**账号规划（1.3）**推三个角度，而发布仓跑在员工端。
// 所以把**读**开放给登录用户，但**边界是「按客户」而不是「按所有人」**：
//   - 必须带 `customerId`；不带就 **400**，绝不退化成「列出全部」；
//   - 不带 `customerId` 的那两条（按 id 取单份 / 列全部）**仍然 manager-only** ——
//     否则员工拿到一个 id 就能读任意项目经理的报告；
//   - **POST / DELETE 仍然 manager-only**，一条都没放开。
// 报告正文含客户 IP 档案，放开给员工是用户明确拍板的；要收回只需改这里与 store。
export default async function handler(req: any, res: any) {
  const customerId = String(req.query?.customerId || "").trim();
  // 只有「按客户读」这一条路对员工开放；写操作与按 id 读一律要 manager。
  const isEmployeeRead = req.method === "GET" && Boolean(customerId);
  const user = isEmployeeRead
    ? await requireAuth(req, res)
    : await requireManager(req, res);
  if (!user) return;

  try {
    if (req.method === "GET") {
      if (customerId) {
        // 员工侧：按客户收口（不按 managerId 过滤 —— 员工不是报告属主）。
        if (req.query?.latest || req.query?.id === "latest") {
          const item = await getLatestAccountPlanReportForCustomer({ customerId });
          if (!item) return json(res, 404, { success: false, error: "该客户还没有账号规划报告" });
          return json(res, 200, { success: true, item });
        }
        const limit = Number(req.query?.limit || 12);
        return json(res, 200, { success: true, items: await listAccountPlanReportsForCustomer({ customerId, limit }) });
      }

      const id = String(req.query?.id || "").trim();
      if (id) {
        const item = await getAccountPlanReport({ ownerId: user.id, id });
        if (!item) return json(res, 404, { success: false, error: "报告不存在或已被删除" });
        return json(res, 200, { success: true, item });
      }
      const limit = Number(req.query?.limit || 12);
      return json(res, 200, { success: true, items: await listAccountPlanReports({ ownerId: user.id, limit }) });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const item = await saveAccountPlanReport({ ownerId: user.id, report: body?.report });
      return json(res, 201, { success: true, item });
    }

    if (req.method === "DELETE") {
      const id = String(req.query?.id || readBody(req)?.id || "").trim();
      if (!id) return json(res, 400, { success: false, error: "缺少报告 id" });
      const result = await deleteAccountPlanReport({ ownerId: user.id, id });
      if (!result.deleted) return json(res, 404, { success: false, error: "报告不存在或已被删除" });
      return json(res, 200, { success: true });
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (error: any) {
    return json(res, error?.status || 500, {
      success: false,
      error: error instanceof Error ? error.message : "Account plan report request failed",
    });
  }
}
