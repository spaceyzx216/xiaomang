import { COZE_API_TOKEN, COZE_BASE_URL, COZE_WORKFLOW_ID, json, readBody } from "../../_lib/common.js";

export const config = {
  maxDuration: 60,
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  if (!COZE_API_TOKEN) {
    return json(res, 500, { error: "Missing COZE_API_TOKEN" });
  }

  const reqBody = readBody(req);
  const body = {
    ...reqBody,
    workflow_id: reqBody?.workflow_id || COZE_WORKFLOW_ID,
  };

  if (!body.workflow_id) {
    return json(res, 400, { error: "workflow_id is required" });
  }

  if (body.bot_id && body.app_id) {
    return json(res, 400, { error: "bot_id and app_id cannot be specified together" });
  }

  try {
    const response = await fetch(`${COZE_BASE_URL}/v1/workflow/stream_run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COZE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    res.status(response.status);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    return res.send(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return json(res, 500, { error: message });
  }
}
