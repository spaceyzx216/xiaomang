import { readBody } from "../_lib/common.js";
import { buildFinalDraftCsvRows, rowsToCsv } from "../_lib/exportFormatters.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const body = readBody(req);
  const csv = rowsToCsv(buildFinalDraftCsvRows(body));

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-copy-${Date.now()}.csv"`);
  res.status(200).send(`\uFEFF${csv}`);
}
