import { json, readBody } from "../../_lib/common.js";
import { getContentAgentConfig } from "../../_lib/contentAgent/config.js";
import { runContentAgentWorkflow } from "../../_lib/contentAgent/index.js";
import { createRequestLogger } from "../../_lib/contentAgent/logger.js";

export const config = {
  maxDuration: 300,
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const agentConfig = getContentAgentConfig();
  const reqBody = readBody(req);
  const body = {
    ...reqBody,
    workflow_id: reqBody?.workflow_id || agentConfig.mainWorkflowId,
  };
  const logger = createRequestLogger("api.agent.workflow.stream-run", req.headers?.["x-request-id"]);

  logger.info("route.request.start", {
    interface: "/api/agent/workflow/stream-run",
    workflowId: body.workflow_id,
    mode: "agent",
  });

  return runContentAgentWorkflow(req, res, { body, config: agentConfig, logger });
}
