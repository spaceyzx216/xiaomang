import { readBody } from "../_lib/common";

const esc = (v: string) => `"${String(v || "").replace(/"/g, '""')}"`;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const body = readBody(req);
  const rows = [
    ["板块", "内容"],
    ["标题", String(body?.titleDraft || "")],
    ["3秒留存", String(body?.hookDraft || "")],
    ["二创文案", String(body?.scriptDraft || "")],
    ["风格转写结果", String(body?.rewriteDraft || "")],
    ["中英翻译结果", String(body?.translationDraft || "")],
  ];

  const csv = rows.map((row) => row.map(esc).join(",")).join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-copy-${Date.now()}.csv"`);
  res.status(200).send(`\uFEFF${csv}`);
}
