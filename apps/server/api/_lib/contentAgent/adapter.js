import { AgentError, cleanModelText, extractFirstJsonObjectText, safeJsonParse } from "./http.js";

export const splitShareLinks = (value) => {
  return String(value || "")
    .split(/\r?\n/)
    .map(link => link.trim())
    .filter(Boolean);
};

export const getShareLinksFromBody = (body) => {
  return splitShareLinks(
    body?.parameters?.share_links ||
      body?._input?.share_links ||
      body?.share_links ||
      body?.parameters?.input ||
      "",
  );
};

export const getBenchmarkTopicsFromBody = (body) => {
  const value =
    body?.parameters?.benchmark_topics ||
    body?.parameters?.benchmarkTopics ||
    body?._input?.benchmark_topics ||
    body?._input?.benchmarkTopics ||
    body?.benchmark_topics ||
    body?.benchmarkTopics ||
    [];
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];
};

/**
 * 取「已提取好的脚本」——选题页（近 7 天）已经把完整脚本提出来并挂在 topic 上了，
 * 二创**不该再解析+转写一遍**（那是 TikHub 解析 3~7s + 整条转写 10~45s 的重复劳动）。
 *
 * 接受两种形状，都是「链接 → 该链接的脚本」，按链接对齐（视频号那条用的是
 * `wechat_channels:<id>` 这种 workflow key，与 `buildContentAgentInputs` 的键同一口径）：
 *   - `parameters.benchmark_videos`: [{ link, script, title, scriptSource }]
 *   - `parameters.scripts`: { [link]: "脚本原文" }
 *
 * ⚠️ 只接受**非空字符串**：空脚本不能被当成"已有脚本"，否则会把"没提取到脚本"
 *    伪装成"已有脚本"，创作 Agent 拿到空文案——比重新转写更糟。
 */
export const getExtractedScriptsFromBody = (body) => {
  const map = new Map();

  const put = (link, script, title) => {
    const key = String(link || "").trim();
    const text = String(script || "").trim();
    if (!key || !text) return;
    if (!map.has(key)) map.set(key, { script: text, title: String(title || "").trim() });
  };

  const videos =
    body?.parameters?.benchmark_videos ||
    body?.parameters?.benchmarkVideos ||
    body?._input?.benchmark_videos ||
    body?._input?.benchmarkVideos ||
    body?.benchmark_videos ||
    body?.benchmarkVideos ||
    [];
  for (const video of Array.isArray(videos) ? videos : []) {
    if (!video || typeof video !== "object") continue;
    put(video.link || video.shareLink || video.url, video.script, video.title);
  }

  const scripts =
    body?.parameters?.scripts ||
    body?._input?.scripts ||
    body?.scripts ||
    null;
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
    for (const [link, script] of Object.entries(scripts)) put(link, script, "");
  }

  return map;
};

const asStringArray = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || "").trim()).filter(Boolean);
};

export const parseJsonAgentOutput = (rawText) => {
  const jsonText = extractFirstJsonObjectText(rawText);
  const parsed = safeJsonParse(jsonText, null);
  if (!parsed || typeof parsed !== "object") {
    throw new AgentError("Model did not return valid JSON", {
      code: "MODEL_JSON_INVALID",
      details: cleanModelText(rawText),
    });
  }
  return parsed.output && typeof parsed.output === "object" ? parsed.output : parsed;
};

/**
 * 「按选题库大类配比」生成的新选项（2026-09-21 第六轮）。
 *
 * 与 `created` / `rcs` 的区别：这批候选**每条都带类型**（它属于哪个三秒/结尾类型），
 * 因为它们是后端按大类配比**逐槽位指定**生成的 —— 类型是配比的落地证据，
 * 丢了类型用户就看不出「这 10 条是按 40/30/20/10 分的」。
 *
 * ⚠️ 这两个字段只在有配比时才存在。旧路径（没有选题库）走原提示词，
 * 拿不到它们，`undefined` 会被这里过滤掉，前端形状不变。
 */
const normalizeCandidates = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const content = String(item?.content || "").trim();
      const type = String(item?.type || "").trim();
      if (!content || !type) return null;
      return {
        index: Number(item?.index) > 0 ? Number(item.index) : index + 1,
        type,
        typeLabel: String(item?.typeLabel || type).trim(),
        content,
      };
    })
    .filter(Boolean);
};

/** 原文案的类型判断（`{ type, typeLabel, reason }`）；没有就返回 null。 */
const normalizeOriginalType = (value) => {
  if (!value || typeof value !== "object") return null;
  const type = String(value.type || "").trim();
  if (!type) return null;
  return {
    type,
    typeLabel: String(value.typeLabel || type).trim(),
    reason: String(value.reason || "").trim(),
  };
};

export const normalizeOpeningHook = (value) => {
  const output = value?.output && typeof value.output === "object" ? value.output : value;
  const candidates = normalizeCandidates(output?.candidates);
  const originalType = normalizeOriginalType(output?.originalType);
  return {
    extracted: String(output?.extracted || "").trim(),
    created: asStringArray(output?.created).slice(0, 5),
    ...(candidates.length > 0 ? { candidates } : {}),
    ...(originalType ? { originalType } : {}),
  };
};

export const normalizeEndingHook = (value) => {
  const output = value?.output && typeof value.output === "object" ? value.output : value;
  const extracted = String(output?.extracted_result || "无").trim() || "无";
  const rcs = extracted === "无" ? [] : asStringArray(output?.rcs).slice(0, 5);
  const candidates = normalizeCandidates(output?.candidates);
  const originalType = normalizeOriginalType(output?.originalType);
  return {
    extracted_result: extracted,
    rcs,
    ...(candidates.length > 0 ? { candidates } : {}),
    ...(originalType ? { originalType } : {}),
  };
};

const ensureText = (value, fallback = "") => {
  const text = cleanModelText(value).trim();
  return text || fallback;
};

export const normalizeAgentResult = (item) => {
  const transcript = ensureText(item.transcript?.text, "");
  const originalTitle = ensureText(item.video?.title, "未识别标题");
  const videoUrl = ensureText(item.video?.videoUrl || item.video?.shareLink, item.shareLink || "");
  const cover = ensureText(item.video?.cover, "");

  return {
    shareLink: ensureText(item.shareLink, videoUrl),
    video: {
      cover,
      title: originalTitle,
      video: videoUrl,
    },
    originalTitle,
    transcript,
    openingHook: normalizeOpeningHook(item.creative?.openingHook || {}),
    endingHook: normalizeEndingHook(item.creative?.endingHook || {}),
    titleText: ensureText(item.creative?.titleText, originalTitle),
    scriptText: ensureText(item.creative?.scriptText, transcript),
  };
};

export const buildWorkflowCompatiblePayload = (items) => {
  const normalized = items.map(normalizeAgentResult);
  return {
    Code_list: normalized.map(item => ({
      fields: [
        JSON.stringify({
          content: item.scriptText,
          title: item.titleText,
        }),
      ],
    })),
    Code_list1: normalized.map(item => ({
      records: [
        {
          fields: JSON.stringify({
            链接: JSON.stringify(item.video),
            标题: item.originalTitle,
            封面: item.video.cover,
            内容: item.transcript,
            开头钩子: item.openingHook,
            结尾钩子: item.endingHook,
          }),
        },
      ],
    })),
  };
};

export const validateWorkflowCompatiblePayload = (payload, expectedCount) => {
  if (!payload || typeof payload !== "object") {
    throw new AgentError("Agent payload is empty", { code: "PAYLOAD_INVALID" });
  }
  if (!Array.isArray(payload.Code_list) || !Array.isArray(payload.Code_list1)) {
    throw new AgentError("Agent payload is missing Code_list fields", { code: "PAYLOAD_INVALID" });
  }
  if (payload.Code_list.length !== expectedCount || payload.Code_list1.length !== expectedCount) {
    throw new AgentError("Agent payload result count does not match input links", {
      code: "PAYLOAD_COUNT_MISMATCH",
      details: { expectedCount, codeList: payload.Code_list.length, codeList1: payload.Code_list1.length },
    });
  }

  payload.Code_list.forEach((item, index) => {
    const raw = item?.fields?.[0];
    const parsed = typeof raw === "string" ? safeJsonParse(raw, null) : raw;
    if (!parsed || typeof parsed.content !== "string" || typeof parsed.title !== "string") {
      throw new AgentError(`Code_list[${index}] is not compatible`, { code: "PAYLOAD_INVALID" });
    }
  });

  payload.Code_list1.forEach((item, index) => {
    const raw = item?.records?.[0]?.fields;
    const parsed = typeof raw === "string" ? safeJsonParse(raw, null) : raw;
    if (
      !parsed ||
      typeof parsed.标题 !== "string" ||
      typeof parsed.内容 !== "string" ||
      typeof parsed.链接 !== "string" ||
      typeof parsed.开头钩子 !== "object" ||
      typeof parsed.结尾钩子 !== "object"
    ) {
      throw new AgentError(`Code_list1[${index}] is not compatible`, { code: "PAYLOAD_INVALID" });
    }
  });

  return payload;
};
