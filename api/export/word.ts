import { readBody } from "../_lib/common.js";
import { buildFinalDraftMarkdown } from "../_lib/exportFormatters.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const body = readBody(req);
  const docText = buildFinalDraftMarkdown(body);

  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-copy-${Date.now()}.doc"`);
  res.status(200).send(docText);
}
