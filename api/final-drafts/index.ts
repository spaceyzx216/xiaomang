import { addDraft, clearDrafts, listDrafts } from "../_lib/draftStore.js";
import { json, readBody } from "../_lib/common.js";

export default async function handler(req: any, res: any) {
  if (req.method === "GET") {
    return json(res, 200, { success: true, items: listDrafts() });
  }

  if (req.method === "POST") {
    const body = readBody(req);
    const item = addDraft({
      titleDraft: body?.titleDraft,
      hookDraft: body?.hookDraft,
      scriptDraft: body?.scriptDraft,
      rewriteDraft: body?.rewriteDraft,
      translationDraft: body?.translationDraft,
      benchmarkVideos: Array.isArray(body?.benchmarkVideos) ? body.benchmarkVideos : [],
    });
    return json(res, 200, { success: true, item });
  }

  if (req.method === "DELETE") {
    const removed = clearDrafts();
    return json(res, 200, { success: true, removed });
  }

  return json(res, 405, { success: false, error: "Method not allowed" });
}
