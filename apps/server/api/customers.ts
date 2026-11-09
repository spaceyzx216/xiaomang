import { json } from "./_lib/common.js";
import { requireManager } from "./_lib/auth.js";
import { getCustomer, listCustomers } from "./_lib/ipProfileStore.js";

export const config = {
  maxDuration: 30,
};

// GET /api/customers          → 客户名册（只返回元数据，不含访谈原文）
// GET /api/customers?id=xxx   → 单个客户（含完整 ipProfile 与访谈原文）
//
// ⚠️ 只做 manager-only，**不做 managerId 隔离**：`customers` 是公司共用的客户名册，
// 文档上没有 ownerId（见 ipProfileStore.js 顶部注释）。这不是遗漏，是刻意如此。
export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return json(res, 405, { success: false, error: "Method not allowed" });
  const manager = await requireManager(req, res);
  if (!manager) return;

  try {
    const id = String(req.query?.id || "").trim();
    if (id) {
      const item = await getCustomer({ id });
      if (!item) return json(res, 404, { success: false, error: "客户不存在或已被删除" });
      return json(res, 200, { success: true, item });
    }
    const limit = Number(req.query?.limit || 200);
    return json(res, 200, { success: true, items: await listCustomers({ limit }) });
  } catch (error: any) {
    // 非法 id 在 store 里被标成 400（"Invalid customer id"），其余按 500 处理。
    return json(res, error?.status || 500, {
      success: false,
      error: error instanceof Error ? error.message : "客户名册读取失败",
    });
  }
}
