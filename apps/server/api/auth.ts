import { json, readBody } from "./_lib/common.js";
import { authenticateCredentials, registerManager, resolveAuthUser } from "./_lib/authStore.js";
import {
  authSessionCookie,
  clearAuthSessionCookie,
  issueAuthToken,
  readAuthToken,
  requestIsSecure,
  verifyAuthToken,
} from "./_lib/authToken.js";

const resolveAction = (req: any) => {
  const rawPath = String(req.headers?.["x-forwarded-uri"] || req.url || "").split("?")[0];
  const match = rawPath.match(/\/api\/auth\/([^/]+)$/);
  let urlAction = "";
  try {
    urlAction = new URL(String(req.url || ""), "http://localhost").searchParams.get("action") || "";
  } catch {
    urlAction = "";
  }
  const queryAction = String(req.query?.action || urlAction || "");
  return String(match?.[1] || queryAction || req.body?.action || "").trim().toLowerCase();
};

export default async function handler(req: any, res: any) {
  const action = resolveAction(req);

  if (action === "login" && req.method === "POST") {
    try {
      const body = readBody(req);
      const user = await authenticateCredentials({
        login: body?.login || body?.email || body?.account,
        password: body?.password,
      });
      if (!user) return json(res, 401, { success: false, error: "账号或密码错误，或账号已停用" });

      const token = issueAuthToken(user);
      res.setHeader("Set-Cookie", authSessionCookie(token, requestIsSecure(req)));
      return json(res, 200, { success: true, user });
    } catch (error) {
      return json(res, 500, { success: false, error: error instanceof Error ? error.message : "登录服务不可用" });
    }
  }

  if (action === "register" && req.method === "POST") {
    try {
      const user = await registerManager(readBody(req));
      const token = issueAuthToken(user);
      res.setHeader("Set-Cookie", authSessionCookie(token, requestIsSecure(req)));
      return json(res, 201, { success: true, user });
    } catch (error: any) {
      return json(res, Number(error?.status) || 400, {
        success: false,
        error: error instanceof Error ? error.message : "注册失败",
      });
    }
  }

  if (action === "me" && req.method === "GET") {
    const claims = verifyAuthToken(readAuthToken(req));
    if (!claims) return json(res, 401, { success: false, error: "未登录或登录已过期" });
    try {
      const user = await resolveAuthUser(claims);
      if (!user) return json(res, 401, { success: false, error: "登录用户不存在或已停用" });
      return json(res, 200, { success: true, user });
    } catch (error) {
      return json(res, 500, { success: false, error: error instanceof Error ? error.message : "认证服务不可用" });
    }
  }

  if (action === "logout" && req.method === "POST") {
    res.setHeader("Set-Cookie", clearAuthSessionCookie(requestIsSecure(req)));
    return json(res, 200, { success: true });
  }

  return json(res, 404, { success: false, error: "Unknown auth action" });
}
