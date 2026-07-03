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

export const normalizeOpeningHook = (value) => {
  const output = value?.output && typeof value.output === "object" ? value.output : value;
  return {
    extracted: String(output?.extracted || "").trim(),
    created: asStringArray(output?.created).slice(0, 5),
  };
};

export const normalizeEndingHook = (value) => {
  const output = value?.output && typeof value.output === "object" ? value.output : value;
  const extracted = String(output?.extracted_result || "无").trim() || "无";
  const rcs = extracted === "无" ? [] : asStringArray(output?.rcs).slice(0, 5);
  return {
    extracted_result: extracted,
    rcs,
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
