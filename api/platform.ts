import { platformRouter } from "./_lib/routers/platform.js";

// Vercel：所有 /api/platform/* 经 vercel.json rewrite 路由到此单一函数。
// 共享 handler（含本地 Express 复用）按 req.url 末尾路径分发子动作。
export const config = {
  maxDuration: 120,
};

export default async function handler(req: any, res: any) {
  return platformRouter(req, res);
}
