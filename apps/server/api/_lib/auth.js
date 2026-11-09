import { canUseWorkbench } from '@xiaomang/shared/roles';
import { resolveAuthUser } from "./authStore.js";
import { readAuthToken, verifyAuthToken } from "./authToken.js";

const sendJson = (res, status, payload) => {
  if (typeof res.send === "function") {
    res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(JSON.stringify(payload));
    return;
  }
  res.status(status).json(payload);
};

export async function getRequestAuthUser(req) {
  const claims = verifyAuthToken(readAuthToken(req));
  if (!claims) return null;
  return resolveAuthUser(claims);
}

export async function requireAuth(req, res) {
  const token = readAuthToken(req);
  if (!token) {
    sendJson(res, 401, { success: false, error: "请先登录" });
    return null;
  }

  try {
    const user = await getRequestAuthUser(req);
    if (!user) {
      sendJson(res, 401, { success: false, error: "登录已失效，请重新登录" });
      return null;
    }
    req.authUser = user;
    return user;
  } catch (error) {
    sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : "认证服务不可用" });
    return null;
  }
}

export async function requireEmployee(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (!canUseWorkbench(user.role)) {
    sendJson(res, 403, { success: false, error: "该功能仅供员工使用" });
    return null;
  }
  return user;
}

export async function requireManager(req, res) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "manager") {
    sendJson(res, 403, { success: false, error: "该功能仅供项目经理使用" });
    return null;
  }
  return user;
}
