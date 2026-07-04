/**
 * 导出路由的共享 handler。
 *
 * 合并 api/export/* 路由为单函数 api/export.ts，通过 vercel.json rewrite
 * 把 /api/export/* 都路由过来，按 req.url 末尾路径分发。
 * 本地 Express 也调用同一份 handler。
 *
 * 子动作：
 *   feishu                —— 把全部选题合并写入一篇飞书文档（需较长 maxDuration）
 *   bitable               —— 把选题记录写入已绑定的飞书多维表格（需较长 maxDuration）
 *   bitable/create        —— 为当前任务创建一份全新的多维表格并完成绑定（需较长 maxDuration）
 *
 * 注：原 word / excel / final-drafts/word / final-drafts/excel 已按要求移除。
 */
import { json, readBody } from "./http-util.js";
import { createRequestLogger } from "../contentAgent/logger.js";
import { buildFinalDraftMarkdown } from "../exportFormatters.js";
import {
  createFeishuBitableForTask,
  writeFinalDraftToFeishu,
  writeFinalDraftToFeishuBitable,
} from "../feishuClient.js";

// Vercel rewrite 后 req.url 变成 destination，原始路径在 x-forwarded-uri header；
// Express 下 req.url / req.path 即原始路径。
const resolveExportAction = (req) => {
  const headers = req.headers || {};
  const raw = String(headers["x-forwarded-uri"] || req.url || req.path || "");
  const withoutQuery = raw.split("?")[0];
  const match = withoutQuery.match(/\/api\/export\/(.+)$/);
  return match ? match[1].replace(/\/+$/, "") : "";
};

const handleFeishu = async (req, res) => {
  const body = readBody(req);
  const logger = createRequestLogger("api.export.feishu", req.headers?.["x-request-id"]);
  logger.info("route.request.start", { interface: "/api/export/feishu", mode: "docx.write" });
  try {
    const result = await writeFinalDraftToFeishu(body, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/feishu",
      documentId: result.documentId,
      blocksCreated: result.blocksCreated,
    });
    return json(res, 200, { success: true, message: "已写入飞书文档", ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu export failed";
    logger.error("route.request.error", {
      interface: "/api/export/feishu",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, {
      success: false,
      error: message,
      code: error?.code,
      markdown: buildFinalDraftMarkdown(body),
    });
  }
};

const handleBitable = async (req, res) => {
  const body = readBody(req);
  const logger = createRequestLogger("api.export.bitable", req.headers?.["x-request-id"]);
  logger.info("route.request.start", { interface: "/api/export/bitable", mode: "bitable.write" });
  try {
    const result = await writeFinalDraftToFeishuBitable(body, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/bitable",
      appToken: result.appToken,
      tableId: result.tableId,
      recordCount: result.recordCount,
      recordsCreated: result.recordsCreated,
      appCreated: result.appCreated,
      tableCreated: result.tableCreated,
      fieldsCreated: result.fieldsCreated,
    });
    return json(res, 200, { success: true, message: "已写入飞书多维表格", ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu bitable export failed";
    logger.error("route.request.error", {
      interface: "/api/export/bitable",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
};

const handleBitableCreate = async (req, res) => {
  const body = readBody(req);
  const logger = createRequestLogger("api.export.bitable.create", req.headers?.["x-request-id"]);
  logger.info("route.request.start", {
    interface: "/api/export/bitable/create",
    mode: "bitable.create",
  });
  try {
    const result = await createFeishuBitableForTask(body, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/bitable/create",
      appToken: result.appToken,
      tableId: result.tableId,
      appCreated: result.appCreated,
      tableCreated: result.tableCreated,
      fieldsCreated: result.fieldsCreated,
    });
    return json(res, 200, { success: true, message: "已创建飞书多维表格", ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu bitable create failed";
    logger.error("route.request.error", {
      interface: "/api/export/bitable/create",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { success: false, error: message, code: error?.code });
  }
};

export const exportRouter = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const action = resolveExportAction(req);
  switch (action) {
    case "feishu":
      return handleFeishu(req, res);
    case "bitable/create":
      return handleBitableCreate(req, res);
    case "bitable":
      return handleBitable(req, res);
    default:
      return json(res, 404, { success: false, error: `Unknown export action: ${action || "(empty)"}` });
  }
};
