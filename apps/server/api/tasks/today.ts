import { json } from "../_lib/common.js";
import { requireEmployee } from "../_lib/auth.js";
import { getTodayTasksForUser } from "../_lib/taskStore.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "GET") return json(res, 405, { success: false, error: "Method not allowed" });

  const user = await requireEmployee(req, res);
  if (!user) return;

  try {
    const userId = String(user.employeeId || user.id || "").trim();
    const data = await getTodayTasksForUser(userId);
    return json(res, 200, { success: true, data });
  } catch (error) {
    return json(res, 500, { success: false, error: error instanceof Error ? error.message : "Task query failed" });
  }
}
