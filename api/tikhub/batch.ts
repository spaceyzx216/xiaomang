import { TIKHUB_API_TOKEN, TIKHUB_BASE_URL, json, readBody, sanitizeUrl } from "../_lib/common";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  if (!TIKHUB_API_TOKEN) {
    return json(res, 500, { error: "Missing TIKHUB_API_TOKEN" });
  }

  const { urls } = readBody(req);
  if (!Array.isArray(urls) || urls.length === 0) {
    return json(res, 400, { error: "urls must be a non-empty array" });
  }

  const results: Array<Record<string, unknown>> = [];

  for (const rawUrl of urls) {
    const url = String(rawUrl || "").trim();
    if (!url) {
      results.push({ url: rawUrl, error: "Empty url" });
      continue;
    }

    const sanitizedUrl = sanitizeUrl(url);

    try {
      const secResp = await fetch(
        `${TIKHUB_BASE_URL}/api/v1/douyin/web/get_sec_user_id?url=${encodeURIComponent(sanitizedUrl)}`,
        {
          headers: {
            Authorization: `Bearer ${TIKHUB_API_TOKEN}`,
          },
        },
      );
      const secUserResponse = await secResp.json();
      const secUserId = secUserResponse?.data || secUserResponse?.sec_user_id;

      if (!secResp.ok || !secUserId) {
        results.push({
          url,
          secUserResponse,
          error: secUserResponse?.message || "Failed to resolve sec_user_id",
        });
        continue;
      }

      const videosResp = await fetch(
        `${TIKHUB_BASE_URL}/api/v1/douyin/app/v3/fetch_user_post_videos?sec_user_id=${encodeURIComponent(secUserId)}&count=20&max_cursor=0&sort_type=0`,
        {
          headers: {
            Authorization: `Bearer ${TIKHUB_API_TOKEN}`,
          },
        },
      );
      const videosResponse = await videosResp.json();

      const dataBlock = videosResponse?.data;
      const videosList = Array.isArray(dataBlock)
        ? dataBlock
        : Array.isArray(dataBlock?.aweme_list)
          ? dataBlock.aweme_list
          : [];
      const authorName = videosList?.[0]?.author?.nickname;

      results.push({
        url,
        secUserId,
        authorName,
        videosCount: videosList.length,
        secUserResponse,
        videosResponse,
        error: videosResp.ok ? null : videosResponse?.message || "Failed to fetch videos",
      });
    } catch (error) {
      results.push({
        url,
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  return json(res, 200, { results });
}
