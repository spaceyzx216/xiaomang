import crypto from "node:crypto";

export const AUTH_SESSION_COOKIE = "xm_auth_session";
export const AUTH_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const encode = value => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const decode = value => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

const getSecret = () => String(process.env.JWT_SECRET || "").trim();

const sign = (value, secret) => crypto
  .createHmac("sha256", secret)
  .update(value)
  .digest("base64url");

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const parseCookies = (header = "") => Object.fromEntries(
  String(header)
    .split(";")
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const separator = item.indexOf("=");
      if (separator < 0) return [item, ""];
      return [item.slice(0, separator), decodeURIComponent(item.slice(separator + 1))];
    }),
);

export const issueAuthToken = (user, now = Date.now()) => {
  const secret = getSecret();
  if (!secret) throw new Error("JWT_SECRET is not configured");

  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    userId: String(user.id),
    sub: String(user.id),
    role: user.role,
    email: user.email || "",
    account: user.account || "",
    employeeId: user.employeeId || (user.role === "employee" ? String(user.id) : ""),
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + AUTH_SESSION_TTL_SECONDS,
  });

  const content = `${header}.${payload}`;
  return `${content}.${sign(content, secret)}`;
};

export const verifyAuthToken = (token, now = Date.now()) => {
  const secret = getSecret();
  if (!secret || !token) return null;

  const [header, payload, signature, ...rest] = String(token).split(".");
  if (!header || !payload || !signature || rest.length > 0) return null;
  if (!safeEqual(sign(`${header}.${payload}`, secret), signature)) return null;

  try {
    const data = decode(payload);
    const userId = String(data?.userId || data?.sub || "").trim();
    const role = String(data?.role || "").trim();
    if (!userId || Number(data?.exp || 0) <= Math.floor(now / 1000)) return null;
    if (role && !["manager", "employee"].includes(role)) return null;
    return { ...data, userId, role };
  } catch {
    return null;
  }
};

export const readAuthToken = req => {
  const authorization = String(req?.headers?.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return parseCookies(req?.headers?.cookie || "")[AUTH_SESSION_COOKIE] || "";
};

export const authSessionCookie = (token, isSecure) => [
  `${AUTH_SESSION_COOKIE}=${encodeURIComponent(token)}`,
  "Path=/",
  "HttpOnly",
  "SameSite=Lax",
  `Max-Age=${AUTH_SESSION_TTL_SECONDS}`,
  ...(isSecure ? ["Secure"] : []),
].join("; ");

export const clearAuthSessionCookie = isSecure => [
  `${AUTH_SESSION_COOKIE}=`,
  "Path=/",
  "HttpOnly",
  "SameSite=Lax",
  "Max-Age=0",
  ...(isSecure ? ["Secure"] : []),
].join("; ");

export const requestIsSecure = req => (
  req?.headers?.["x-forwarded-proto"] === "https" || req?.connection?.encrypted === true
);
