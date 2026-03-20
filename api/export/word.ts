import { readBody } from "../_lib/common.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const body = readBody(req);
  const docText = [
    "# 最终文案",
    "",
    "## 标题",
    String(body?.titleDraft || ""),
    "",
    "## 3 秒留存",
    String(body?.hookDraft || ""),
    "",
    "## 二创文案",
    String(body?.scriptDraft || ""),
    "",
    "## 风格转写结果",
    String(body?.rewriteDraft || ""),
    "",
    "## 中英翻译结果",
    String(body?.translationDraft || ""),
    "",
  ].join("\n");

  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-copy-${Date.now()}.doc"`);
  res.status(200).send(docText);
}
