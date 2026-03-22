import { deleteDraft } from "../_lib/draftStore.js";
import { json } from "../_lib/common.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "DELETE") {
    return json(res, 405, { success: false, error: "Method not allowed" });
  }

  const id = String(req.query?.id || "").trim();
  if (!id) {
    return json(res, 400, { success: false, error: "id is required" });
  }

  const removed = deleteDraft(id) ? 1 : 0;
  return json(res, 200, { success: true, removed });
}
