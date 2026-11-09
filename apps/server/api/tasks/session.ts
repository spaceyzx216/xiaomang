import { json, readBody } from "../_lib/common.js";
import { requireEmployee } from "../_lib/auth.js";
import { issueTaskSession, requestIsSecure, taskSessionCookie } from "../_lib/taskSession.js";
import { getTodayTasksForUser, isActiveTaskUser, isTaskUserId } from "../_lib/taskStore.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return json(res, 405, { success: false, error: "Method not allowed" });

  const user = await requireEmployee(req, res);
  if (!user) return;

  const requestedTaskUserId = String(readBody(req)?.taskUserId || "").trim();
  const authenticatedUserId = String(user.employeeId || user.id || "").trim();
  if (requestedTaskUserId && requestedTaskUserId !== authenticatedUserId) {
    return json(res, 403, { success: false, error: "不能建立其他员工的任务会话" });
  }
  const taskUserId = requestedTaskUserId || authenticatedUserId;
  if (!isTaskUserId(taskUserId)) {
    return json(res, 400, { success: false, error: "Invalid task user identity" });
  }

  try {
    if (!await isActiveTaskUser(taskUserId)) {
      return json(res, 401, { success: false, error: "Task user is not active" });
    }
    const session = issueTaskSession(taskUserId);
    res.setHeader("Set-Cookie", taskSessionCookie(session, requestIsSecure(req)));
    return json(res, 200, { success: true, data: await getTodayTasksForUser(taskUserId) });
  } catch (error) {
    return json(res, 500, { success: false, error: error instanceof Error ? error.message : "Session setup failed" });
  }
}
