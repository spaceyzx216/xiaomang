import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";
import { parseWorkbookPayload } from "../_lib/reviewWorkbook.js";

export const config = {
  maxDuration: 30,
};

/**
 * 模块 4「复盘分析」—— Excel 上传解析。
 *
 * 只做「解析 + 给出建议的列映射」，**不落库、不调模型**：
 * 用户确认/修正列映射之后，再调 `/api/agent/video-analysis` 才真正花钱。
 *
 * 入参是 base64（不是 multipart），理由见 `_lib/reviewWorkbook.js`：
 * 本地 Express 与 Vercel 两套入口都要能跑，而 multer 只有前者有。
 *
 * ⚠️ Vercel 侧请求体硬上限 4.5MB；解码后的文件在 `parseWorkbookPayload` 里另卡 5MB。
 */
export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });
  const user = await requireAuth(req, res);
  if (!user) return;

  try {
    const body = readBody(req);
    const parsed = parseWorkbookPayload({
      fileName: body?.fileName,
      dataBase64: body?.dataBase64,
      platform: body?.platform,
      sheetName: body?.sheetName,
    });
    return json(res, 200, { success: true, ...parsed });
  } catch (error: any) {
    return json(res, error?.status || 500, {
      success: false,
      error: error instanceof Error ? error.message : "Excel 解析失败",
    });
  }
}
