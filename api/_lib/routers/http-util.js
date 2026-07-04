/**
 * Router 共享的 HTTP 工具（纯 .js，本地 Node 与线上 Vercel 均可直接加载）。
 *
 * 注意：不 import 上层的 ../common.js，因为那是 common.ts，本地 node 直接运行
 * server/index.js 时无法解析 .ts 扩展。这里内联等价实现，避免 ESM 解析失败。
 */

// 兼容 Vercel res.send 与 Express res.json：统一用 status + JSON body 输出。
export const json = (res, status, payload) => {
  if (typeof res.status === "function" && typeof res.send === "function") {
    res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify(payload));
    return;
  }
  // 兜底：Express 原生 res.json
  res.status(status).json(payload);
};

// 读取请求体，兼容字符串/对象/空 body（Vercel 可能不预解析 body）。
export const readBody = (req) => {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
};
