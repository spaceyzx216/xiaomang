import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";
import {
  clearPublishSelections,
  deleteAccountTags,
  deleteCoverBase,
  deletePublishSelection,
  getAccountTags,
  getCoverBase,
  listPublishSelections,
  saveAccountTags,
  saveCoverBase,
  savePublishSelection,
} from "../_lib/publishWarehouseStore.js";
import { COVER_TIERS } from "../_lib/publishWarehouse.js";

/**
 * 发布仓的持久化端点（2026-09-21 第七轮，见 HANDOFF §0.3；封面基底 2026-09-23 增补）。
 *
 * **几个资源合用一个端点**，靠 `?resource=` 区分（默认 `selections`）：
 *
 *   `?resource=selections`（默认）—— 每条选题的发布选择（封面/文案/标签）
 *     GET    /api/publish-warehouse?customerId=            → 该客户下当前用户的全部选择
 *     POST   /api/publish-warehouse  { customerId, topicId, cover, publishCopy, topicTags }
 *     DELETE /api/publish-warehouse?customerId=&topicId=   → 删单条
 *     DELETE /api/publish-warehouse?customerId=            → 清整批
 *
 *   `?resource=account-tags` —— 账号恒定标签库（人工确认后长期复用）
 *     GET    /api/publish-warehouse?resource=account-tags&customerId=
 *     POST   /api/publish-warehouse?resource=account-tags  { customerId, angleGroups, confirmed, referenceTags }
 *     DELETE /api/publish-warehouse?resource=account-tags&customerId=
 *
 *   `?resource=cover-base` —— **封面基底**（账号级：IP 形象照 / 背景风格模板 / 标题样式）
 *     生命周期与 account-tags 同类（一次确认、长期复用），所以与它并排放在这里。
 *     GET / POST / DELETE 同形；`tier` 三个字面量见 `COVER_TIERS`。
 *
 *   `?resource=cover-tiers` —— 三类封面的**定义**（纯常量，不需要 customerId）
 *     GET    /api/publish-warehouse?resource=cover-tiers
 *
 * 合用一个端点是刻意的：它们**生命周期都是「某个用户在某客户下的发布仓」**，
 * 分开会多出好几套路由与好几份 `vercel.json` 条目，而它们永远一起被改。
 *
 * 鉴权：`requireAuth`（员工也要用）。数据按**当前用户**隔离，员工之间互不可见。
 */

export const config = { maxDuration: 30 };

const asText = (value: unknown) => String(value ?? "").trim();

const RESOURCES = ["selections", "account-tags", "cover-base", "cover-tiers"];

export default async function handler(req: any, res: any) {
  const user = await requireAuth(req, res);
  if (!user) return;

  const resource = asText(req.query?.resource) || "selections";
  if (!RESOURCES.includes(resource)) {
    return json(res, 400, { success: false, error: `不支持的 resource：${resource}（可用：${RESOURCES.join(" / ")}）` });
  }

  try {
    // 类型定义是纯常量，不依赖客户 —— 前端只管读它渲染。
    if (resource === "cover-tiers") {
      if (req.method !== "GET") return json(res, 405, { success: false, error: "Method not allowed" });
      return json(res, 200, { success: true, items: COVER_TIERS });
    }

    if (resource === "account-tags" || resource === "cover-base") {
      const isCoverBase = resource === "cover-base";
      if (req.method === "GET") {
        const customerId = asText(req.query?.customerId);
        if (!customerId) return json(res, 400, { success: false, error: "缺少 customerId" });
        const item = isCoverBase
          ? await getCoverBase({ ownerId: user.id, customerId })
          : await getAccountTags({ ownerId: user.id, customerId });
        return json(res, 200, { success: true, item });
      }
      if (req.method === "POST") {
        const body = readBody(req);
        const item = isCoverBase
          ? await saveCoverBase({
            ownerId: user.id,
            customerId: body?.customerId,
            customerName: body?.customerName,
            tier: body?.tier,
            sourceImage: body?.sourceImage,
            analysis: body?.analysis,
            titleStyle: body?.titleStyle,
            backgroundTemplate: body?.backgroundTemplate,
            backgroundPrompt: body?.backgroundPrompt,
            portrait: body?.portrait,
          })
          : await saveAccountTags({
            ownerId: user.id,
            customerId: body?.customerId,
            customerName: body?.customerName,
            angleGroups: body?.angleGroups,
            confirmed: body?.confirmed,
            referenceTags: body?.referenceTags,
            summary: body?.summary,
          });
        return json(res, 200, { success: true, item });
      }
      if (req.method === "DELETE") {
        const customerId = asText(req.query?.customerId || readBody(req)?.customerId);
        if (!customerId) return json(res, 400, { success: false, error: "缺少 customerId" });
        const result = isCoverBase
          ? await deleteCoverBase({ ownerId: user.id, customerId })
          : await deleteAccountTags({ ownerId: user.id, customerId });
        return json(res, 200, { success: true, ...result });
      }
      return json(res, 405, { success: false, error: "Method not allowed" });
    }

    if (req.method === "GET") {
      const customerId = asText(req.query?.customerId);
      if (!customerId) return json(res, 400, { success: false, error: "缺少 customerId" });
      const items = await listPublishSelections({ ownerId: user.id, customerId });
      return json(res, 200, { success: true, items });
    }

    if (req.method === "POST") {
      const body = readBody(req);
      const item = await savePublishSelection({
        ownerId: user.id,
        customerId: body?.customerId,
        topicId: body?.topicId,
        title: body?.title,
        cover: body?.cover,
        publishCopy: body?.publishCopy,
        topicTags: body?.topicTags,
      });
      return json(res, 200, { success: true, item });
    }

    if (req.method === "DELETE") {
      const customerId = asText(req.query?.customerId || readBody(req)?.customerId);
      const topicId = asText(req.query?.topicId);
      if (!customerId) return json(res, 400, { success: false, error: "缺少 customerId" });
      // 带 topicId 删单条；不带就清整批（界面上分别是「重跑这条」与「重新开始」）。
      const result = topicId
        ? await deletePublishSelection({ ownerId: user.id, customerId, topicId })
        : await clearPublishSelections({ ownerId: user.id, customerId });
      return json(res, 200, { success: true, ...result });
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (error: any) {
    return json(res, error?.status || 500, {
      success: false,
      error: error instanceof Error ? error.message : "Publish warehouse request failed",
      code: error?.code,
    });
  }
}
