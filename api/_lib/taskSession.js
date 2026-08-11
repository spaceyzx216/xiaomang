import crypto from "node:crypto";

export const TASK_SESSION_COOKIE = "xm_task_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

const getSecret = () => String(process.env.TASK_DEMO_SESSION_SECRET || "").trim();

const sign = (payload, secret) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const parseCookies = (header = "") => Object.fromEntries(
  String(header)
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf("=");
      return separator < 0
        ? [item, ""]
        : [item.slice(0, separator), decodeURIComponent(item.slice(separator + 1))];
    }),
);

export const issueTaskSession = (userId, now = Date.now()) => {
  const secret = getSecret();
  if (!secret) throw new Error("TASK_DEMO_SESSION_SECRET is not configured");

  const payload = encode({ sub: String(userId), exp: now + SESSION_TTL_SECONDS * 1000 });
  return `${payload}.${sign(payload, secret)}`;
};

export const readTaskSessionUserId = (cookieHeader, now = Date.now()) => {
  const secret = getSecret();
  const token = parseCookies(cookieHeader)[TASK_SESSION_COOKIE];
  if (!secret || !token) return "";

  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0 || !safeEqual(sign(payload, secret), signature)) return "";

  try {
    const data = decode(payload);
    return typeof data?.sub === "string" && Number(data.exp) > now ? data.sub : "";
  } catch {
    return "";
  }
};

export const taskSessionCookie = (token, isSecure) => [
  `${TASK_SESSION_COOKIE}=${encodeURIComponent(token)}`,
  "Path=/",
  "HttpOnly",
  "SameSite=Lax",
  `Max-Age=${SESSION_TTL_SECONDS}`,
  ...(isSecure ? ["Secure"] : []),
].join("; ");

export const requestIsSecure = (req) => (
  req.headers?.["x-forwarded-proto"] === "https" || req.connection?.encrypted === true
);
