declare const process: any;

type VercelRequest = any;
type VercelResponse = any;

export const TIKHUB_BASE_URL = process.env.TIKHUB_BASE_URL || "https://api.tikhub.io";
export const TIKHUB_API_TOKEN = process.env.TIKHUB_API_TOKEN || "";

export const json = (res: VercelResponse, status: number, payload: unknown) => {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(payload));
};

export const sanitizeUrl = (rawUrl: string) => {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return rawUrl.split("?")[0];
  }
};

export const readBody = (req: VercelRequest) => {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
};
