/**
 * 导出路由的共享 handler。
 *
 * 合并 api/export/* 6 个路由为单函数 api/export.ts，通过 vercel.json rewrite
 * 把 /api/export/* 都路由过来，按 req.url 末尾路径分发。
 * 本地 Express 也调用同一份 handler。
 *
 * 子动作：
 *   feishu / bitable            —— 调飞书 API（需较长 maxDuration）
 *   word / excel                —— 单条文案纯本地格式化
 *   final-drafts/word           —— 全部已存文案汇总为 doc
 *   final-drafts/excel          —— 全部已存文案汇总为 csv
 */
import { json, readBody } from "./http-util.js";
import { createRequestLogger } from "../contentAgent/logger.js";
import {
  buildDraftListCsvRows,
  buildFinalDraftCsvRows,
  buildFinalDraftMarkdown,
  rowsToCsv,
} from "../exportFormatters.js";
import { listDrafts } from "../draftStore.js";
import {
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

const handleExcel = (req, res) => {
  const body = readBody(req);
  const csv = rowsToCsv(buildFinalDraftCsvRows(body));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-copy-${Date.now()}.csv"`);
  return res.status(200).send(`\uFEFF${csv}`);
};

const handleWord = (req, res) => {
  const body = readBody(req);
  const docText = buildFinalDraftMarkdown(body);
  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-copy-${Date.now()}.doc"`);
  return res.status(200).send(docText);
};

const handleFinalDraftsExcel = (req, res) => {
  const items = listDrafts();
  if (items.length === 0) {
    return json(res, 400, { success: false, error: "暂无可导出的已保存文案" });
  }
  const csv = rowsToCsv(buildDraftListCsvRows(items));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-drafts-all-${Date.now()}.csv"`);
  return res.status(200).send(`\uFEFF${csv}`);
};

const handleFinalDraftsWord = (req, res) => {
  const items = listDrafts();
  if (items.length === 0) {
    return json(res, 400, { success: false, error: "暂无可导出的已保存文案" });
  }
  const sections = items.map((item, index) => {
    const body = buildFinalDraftMarkdown(item).replace(/^# 最终文案\n\n/, "");
    return [
      `# 任务 ${index + 1}`,
      `保存时间：${String(item?.createdAt || "")}`,
      "",
      body,
      "---",
      "",
    ].join("\n");
  });
  const docText = ["# 全部任务最终文案汇总", `共 ${items.length} 份`, "", ...sections].join("\n");
  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-drafts-all-${Date.now()}.doc"`);
  return res.status(200).send(docText);
};

export const exportRouter = async (req, res) => {
  if (req.method !== "POST") {
    // excel/word 类返回纯文本错误更友好，但为统一仍用 json
    return json(res, 405, { success: false, error: "Method not allowed" });
  }
  const action = resolveExportAction(req);
  switch (action) {
    case "feishu":
      return handleFeishu(req, res);
    case "bitable":
      return handleBitable(req, res);
    case "excel":
      return handleExcel(req, res);
    case "word":
      return handleWord(req, res);
    case "final-drafts/excel":
      return handleFinalDraftsExcel(req, res);
    case "final-drafts/word":
      return handleFinalDraftsWord(req, res);
    default:
      return json(res, 404, { success: false, error: `Unknown export action: ${action || "(empty)"}` });
  }
};
