import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";
import {
  deleteTopicRefreshSession,
  getTopicRefreshSession,
  saveTopicRefreshCandidates,
} from "../_lib/topicRefreshSessionStore.js";

// 「新更新视频筛选与打标签」的会话（员工在某客户下的一次处理进度）。
//
// GET    /api/topic-refresh-sessions?customerId=xxx  → 读回上次的进度（候选 + 已判完条目）
// POST   /api/topic-refresh-sessions                 → 保存/替换本轮候选（每次抓完新视频调）
// DELETE /api/topic-refresh-sessions?customerId=xxx  → 清掉（用户点「重新开始」）
//
// ── 权限 ─────────────────────────────────────────────────────────────────────
// 这是**当前用户自己的临时进度**（不是项目经理建的选题库），所以不做角色限制，
// 但一律按 `user.id` 隔离：员工 A 的进度员工 B 看不到，反之亦然。
// 落库的理由见 topicRefreshSessionStore.js 顶部：打标签要几十秒到几分钟，
// 只放前端内存里的话，刷新/切页就把这段时间和钱一起丢了。
export default async function handler(req: any, res: any) {
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const body = readBody(req);
    const customerId = String(req.query?.customerId || body?.customerId || "").trim();

    if (req.method === "GET") {
      if (!customerId) return json(res, 400, { success: false, error: "缺少客户 id" });
      const item = await getTopicRefreshSession({ ownerId: user.id, customerId });
      return json(res, 200, { success: true, item });
    }

    if (req.method === "POST") {
      const result = await saveTopicRefreshCandidates({
        ownerId: user.id,
        customerId,
        accountUrl: body?.accountUrl,
        recentDays: body?.recentDays,
        minLikes: body?.minLikes,
        videos: body?.videos,
      });
      return json(res, 200, { success: true, ...result });
    }

    if (req.method === "DELETE") {
      if (!customerId) return json(res, 400, { success: false, error: "缺少客户 id" });
      const result = await deleteTopicRefreshSession({ ownerId: user.id, customerId });
      return json(res, 200, { success: true, ...result });
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (error: any) {
    return json(res, error?.status || 500, {
      success: false,
      error: error instanceof Error ? error.message : "处理进度请求失败",
    });
  }
}
