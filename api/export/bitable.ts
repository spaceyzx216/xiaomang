import { json, readBody } from "../_lib/common.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { writeFinalDraftToFeishuBitable } from "../_lib/feishuClient.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const body = readBody(req);
  const logger = createRequestLogger("api.export.bitable", req.headers?.["x-request-id"]);
  logger.info("route.request.start", {
    interface: "/api/export/bitable",
    mode: "bitable.write",
  });

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
    return json(res, 200, {
      success: true,
      message: "已写入飞书多维表格",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu bitable export failed";
    logger.error("route.request.error", {
      interface: "/api/export/bitable",
      code: (error as any)?.code,
      error: message,
    });
    return json(res, (error as any)?.status || 500, {
      success: false,
      error: message,
      code: (error as any)?.code,
    });
  }
}
