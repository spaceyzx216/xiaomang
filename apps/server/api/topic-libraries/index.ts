import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";
import { getCustomer } from "../_lib/ipProfileStore.js";
import {
  deleteTopicLibrary,
  getTopicCategoryDictionary,
  getTopicCategoryDictionaryForEmployee,
  getTopicLibrary,
  getTopicLibraryForEmployee,
  listTopicLibraries,
  listTopicLibrariesForEmployee,
  removeTopicLibraryAccount,
  saveTopicLibrary,
} from "../_lib/topicLibraryStore.js";

// 正式选题库（客户级，每客户一份，可纳入多个对标账号的分析结果）
//
// GET    /api/topic-libraries                  → 列表
// GET    /api/topic-libraries?customerId=xxx   → 单个客户的完整库（含分类树与标签词典）
// GET    /api/topic-libraries?customerId=xxx&view=categories
//                                              → **轻量**：只要打标签用的分类词典，
//                                                不返回三份报告快照（员工端打标签走这条）
// POST   /api/topic-libraries                  → 建库 / 追加账号（幂等）
// POST   /api/topic-libraries?action=remove-account → 从库里移除某个对标账号
// DELETE /api/topic-libraries?customerId=xxx   → 删除整个库
//
// ── 权限（2026-09-21 放宽，用户拍板）────────────────────────────────────────
// **读**：项目经理读自己的库；**员工也能读**，但要跑「新视频筛选打标签」就得拿库里的
//   分类当词典。员工侧走 `*ForEmployee` 两个函数，**刻意收窄**：不回 managerId、
//   不回客户 IP 档案，只给「客户名 + 分类树」，且只列真的有内容的库。
// **写**：建库 / 移除账号 / 删库全部仍为 manager-only。
export default async function handler(req: any, res: any) {
  const user = await requireAuth(req, res);
  if (!user) return;

  // 写操作一律项目经理专属。
  if (req.method !== "GET" && user.role !== "manager") {
    return json(res, 403, { success: false, error: "该操作仅供项目经理使用" });
  }

  try {
    if (req.method === "GET") {
      const customerId = String(req.query?.customerId || "").trim();
      // 轻量视图：只要分类词典。员工端「按库内分类打标签」用它，
      // 避免为了几个大类名把三份报告快照（~148KB/份）一起拖回来。
      const categoriesOnly = String(req.query?.view || "").trim() === "categories";
      if (user.role === "manager") {
        if (customerId) {
          const item = categoriesOnly
            ? await getTopicCategoryDictionary({ ownerId: user.id, customerId })
            : await getTopicLibrary({ ownerId: user.id, customerId });
          if (!item) return json(res, 404, { success: false, error: "这个客户还没有正式选题库" });
          return json(res, 200, { success: true, item });
        }
        const limit = Number(req.query?.limit || 50);
        return json(res, 200, { success: true, items: await listTopicLibraries({ ownerId: user.id, limit }) });
      }
      // 员工：只读、跨项目经理、收窄字段。
      if (customerId) {
        const item = categoriesOnly
          ? await getTopicCategoryDictionaryForEmployee({ customerId })
          : await getTopicLibraryForEmployee({ customerId });
        if (!item) return json(res, 404, { success: false, error: "这个客户还没有正式选题库" });
        return json(res, 200, { success: true, item });
      }
      const limit = Number(req.query?.limit || 50);
      return json(res, 200, { success: true, items: await listTopicLibrariesForEmployee({ limit }) });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const customerId = String(body?.customerId || "").trim();
      if (!customerId) return json(res, 400, { success: false, error: "请先选择这份选题库归属的客户" });

      if (String(req.query?.action || "").trim() === "remove-account") {
        const accountKey = String(body?.accountKey || "").trim();
        if (!accountKey) return json(res, 400, { success: false, error: "缺少要移除的对标账号" });
        const removed = await removeTopicLibraryAccount({ ownerId: user.id, customerId, accountKey });
        if (!removed.removedAccount) return json(res, 404, { success: false, error: "这个客户还没有正式选题库" });
        return json(res, 200, { success: true, ...removed });
      }

      // 客户名册是公司共用的（不按 managerId 过滤），这里只校验客户真实存在，
      // 避免把随便传的 id 写成一份查不到归属的库。
      const customer = await getCustomer({ id: customerId });
      if (!customer) return json(res, 404, { success: false, error: "客户不存在或已被删除" });
      if (!body?.report) return json(res, 400, { success: false, error: "缺少要纳入选题库的分类报告" });

      const item = await saveTopicLibrary({
        ownerId: user.id,
        // 用 **customer.id（规范形态）** 而不是请求里那串原始文本：
        // ObjectId 解析是大小写不敏感的，但唯一索引比较的是字符串 ——
        // 传大写 hex 会建出一份客户端拿小写 id 永远查不到的库，
        // 再传小写还会再建第二份，「一个客户一份库」就破了。
        customer: { id: customer.id, name: customer.name },
        report: body.report,
      });
      return json(res, 201, { success: true, item });
    }

    if (req.method === "DELETE") {
      const customerId = String(req.query?.customerId || readBody(req)?.customerId || "").trim();
      if (!customerId) return json(res, 400, { success: false, error: "缺少客户 id" });
      const result = await deleteTopicLibrary({ ownerId: user.id, customerId });
      if (!result.deleted) return json(res, 404, { success: false, error: "这个客户还没有正式选题库" });
      return json(res, 200, { success: true });
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (error: any) {
    // 按 store / getCustomer 标好的 `error.status` 取码，**不要用正则猜错误消息**。
    // 猜错过两次：`Invalid customer id`（首字母大写+空格）不匹配 /invalid|customerId/，
    // 本该 400 的入参错误被当成 500；而 E11000 的报错文本里含有 `customerId` 字段名，
    // 真正的服务端故障又被误判成 400 并把驱动原文回显出去。这也是全项目的惯例写法。
    return json(res, error?.status || 500, {
      success: false,
      error: error instanceof Error ? error.message : "选题库请求失败",
    });
  }
}
