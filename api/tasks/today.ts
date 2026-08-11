import { json } from "../_lib/common.js";
import { readTaskSessionUserId } from "../_lib/taskSession.js";
import { getTodayTasksForUser } from "../_lib/taskStore.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return json(res, 405, { success: false, error: "Method not allowed" });

  const userId = readTaskSessionUserId(req.headers?.cookie);
  if (!userId) return json(res, 401, { success: false, error: "Task session is missing or expired" });

  try {
    const data = await getTodayTasksForUser(userId);
    return json(res, 200, { success: true, data });
  } catch (error) {
    return json(res, 500, { success: false, error: error instanceof Error ? error.message : "Task query failed" });
  }
}
