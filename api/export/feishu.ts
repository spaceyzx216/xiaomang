import { json, readBody } from "../_lib/common.js";
import { buildFinalDraftMarkdown } from "../_lib/exportFormatters.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { writeFinalDraftToFeishu } from "../_lib/feishuClient.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const body = readBody(req);
  const logger = createRequestLogger("api.export.feishu", req.headers?.["x-request-id"]);
  logger.info("route.request.start", {
    interface: "/api/export/feishu",
    mode: "docx.write",
  });

  try {
    const result = await writeFinalDraftToFeishu(body, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/feishu",
      documentId: result.documentId,
      blocksCreated: result.blocksCreated,
    });
    return json(res, 200, {
      success: true,
      message: "已写入飞书文档",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu export failed";
    logger.error("route.request.error", {
      interface: "/api/export/feishu",
      code: (error as any)?.code,
      error: message,
    });
    return json(res, (error as any)?.status || 500, {
      success: false,
      error: message,
      code: (error as any)?.code,
      markdown: buildFinalDraftMarkdown(body),
    });
  }
}
