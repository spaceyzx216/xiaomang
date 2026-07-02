import { json } from "../../_lib/common.js";
import { listDrafts } from "../../_lib/draftStore.js";
import { buildDraftListCsvRows, rowsToCsv } from "../../_lib/exportFormatters.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const items = listDrafts();
  if (items.length === 0) {
    return json(res, 400, { success: false, error: "暂无可导出的已保存文案" });
  }

  const csv = rowsToCsv(buildDraftListCsvRows(items));

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-drafts-all-${Date.now()}.csv"`);
  return res.status(200).send(`\uFEFF${csv}`);
}
