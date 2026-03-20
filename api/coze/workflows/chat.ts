import { COZE_API_TOKEN, COZE_BASE_URL, json, readBody } from "../../_lib/common.js";

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

  const body = { ...(readBody(req) || {}) };

  if (!body.workflow_id) {
    return json(res, 400, { error: "workflow_id is required" });
  }

  if (!Array.isArray(body.additional_messages) || body.additional_messages.length === 0) {
    return json(res, 400, { error: "additional_messages must be a non-empty array" });
  }

  if (typeof body.parameters !== "object" || body.parameters == null) {
    body.parameters = {};
  }

  if (body.app_id && body.bot_id) {
    return json(res, 400, { error: "app_id and bot_id cannot be specified together" });
  }

  try {
    const response = await fetch(`${COZE_BASE_URL}/v1/workflows/chat`, {
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
