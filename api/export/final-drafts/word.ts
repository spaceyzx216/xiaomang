import { json } from "../../_lib/common.js";
import { listDrafts } from "../../_lib/draftStore.js";
import { buildFinalDraftMarkdown } from "../../_lib/exportFormatters.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

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

  const docText = [
    "# 全部任务最终文案汇总",
    `共 ${items.length} 份`,
    "",
    ...sections,
  ].join("\n");

  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-drafts-all-${Date.now()}.doc"`);
  return res.status(200).send(docText);
}
