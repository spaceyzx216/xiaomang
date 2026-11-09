import { exportRouter } from "./_lib/routers/export.js";
import { requireAuth } from "./_lib/auth.js";

// Vercel：所有 /api/export/* 经 vercel.json rewrite 路由到此单一函数。
// feishu/bitable 需调飞书 API，故整体设较长 maxDuration；纯本地导出不受影响。
export const config = {
  maxDuration: 120,
};

export default async function handler(req: any, res: any) {
  if (!await requireAuth(req, res)) return;
  return exportRouter(req, res);
}
