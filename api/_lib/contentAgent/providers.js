import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  AgentError,
  appendQuery,
  cleanModelText,
  extractFirstJsonObjectText,
  fetchJson,
  safeJsonParse,
  retryDelayMs,
  sleep,
} from "./http.js";
import {
  DOUBAO_VIDEO_TRANSCRIPT_PROMPT,
  ENDING_HOOK_PROMPT,
  OPENING_HOOK_PROMPT,
  SCRIPT_REWRITE_PROMPT,
  TITLE_PROMPT,
} from "./prompts.js";
import { normalizeEndingHook, normalizeOpeningHook, parseJsonAgentOutput } from "./adapter.js";

const transcriptCache = new Map();

const isObject = value => value && typeof value === "object" && !Array.isArray(value);

const compactDetails = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const collectStrings = (value, out = [], path = "", depth = 0) => {
  if (depth > 8 || out.length > 2500) return out;
  if (typeof value === "string") {
    out.push({ path, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, out, `${path}[${index}]`, depth + 1));
    return out;
  }
  if (isObject(value)) {
    Object.entries(value).forEach(([key, item]) => {
      collectStrings(item, out, path ? `${path}.${key}` : key, depth + 1);
    });
  }
  return out;
};

const firstByPath = (payload, pathRegexes, valuePredicate = () => true) => {
  const strings = collectStrings(payload);
  const found = strings.find(item =>
    pathRegexes.some(regex => regex.test(item.path)) && valuePredicate(item.value),
  );
  return found?.value || "";
};

const isHttpUrl = value => /^https?:\/\//i.test(String(value || ""));

export const isDirectMp4Url = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    return /^https?:$/i.test(parsed.protocol) && /\.mp4$/i.test(parsed.pathname);
  } catch {
    return false;
  }
};

export const describeVideoUrlForDiagnostics = (value) => {
  const text = String(value || "");
  try {
    const parsed = new URL(text);
    let kind = "http-url";
    if (isDirectMp4Url(text)) {
      kind = "direct-mp4";
    } else if (/\/aweme\/v1\/play/i.test(parsed.pathname)) {
      kind = "douyin-aweme-play-api";
    } else if (parsed.searchParams.has("video_id")) {
      kind = "video-id-play-url";
    } else if (/douyin/i.test(parsed.hostname) && /play/i.test(text)) {
      kind = "douyin-play-url";
    }

    return {
      kind,
      host: parsed.host,
      path: parsed.pathname,
      queryKeys: Array.from(parsed.searchParams.keys()).slice(0, 12).join(","),
      isDirectMp4: isDirectMp4Url(text),
    };
  } catch {
    return {
      kind: text ? "invalid-url" : "empty",
      host: "",
      path: text.slice(0, 120),
      queryKeys: "",
      isDirectMp4: false,
    };
  }
};

const isImageUrl = value => {
  const text = String(value || "");
  return isHttpUrl(text) && /(douyinpic|cover|image|img|jpeg|jpg|png|webp|tplv-dy-360p)/i.test(text);
};

const isVideoUrl = value => {
  const text = String(value || "");
  if (!isHttpUrl(text)) return false;
  if (/\/user\//i.test(text)) return false;
  if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(text)) return false;
  return /(\.mp4(\?|$)|\/aweme\/v1\/play|video_id=|play_addr|download_addr|douyin.*play)/i.test(text);
};

const parseAwemeIdFromShareLink = (shareLink) => {
  try {
    const parsed = new URL(shareLink);
    return parsed.searchParams.get("modal_id") || parsed.searchParams.get("aweme_id") || "";
  } catch {
    return "";
  }
};

const extractAwemeId = (payload, shareLink) => {
  return (
    firstByPath(payload, [/aweme[_-]?id$/i, /item[_-]?id$/i], value => /^\d{8,}$/.test(value)) ||
    parseAwemeIdFromShareLink(shareLink)
  );
};

const extractVideoMeta = (payload, shareLink) => {
  const data = payload?.data ?? payload;
  const strings = collectStrings(data);
  const title =
    firstByPath(
      data,
      [/(^|\.)desc$/i, /(^|\.)title$/i, /(^|\.)description$/i, /(^|\.)caption$/i],
      value => value.length > 0 && value.length < 600 && !isHttpUrl(value),
    ) || "";
  const cover = strings.find(item => isImageUrl(item.value))?.value || "";
  const videoUrl =
    firstByPath(data, [/original_video_url$/i, /video_url$/i, /play_addr/i, /download_addr/i], isDirectMp4Url) ||
    strings.find(item => isDirectMp4Url(item.value))?.value ||
    firstByPath(data, [/original_video_url$/i, /video_url$/i, /play_addr/i, /download_addr/i], isVideoUrl) ||
    strings.find(item => isVideoUrl(item.value))?.value ||
    "";

  return {
    awemeId: extractAwemeId(data, shareLink),
    title,
    cover,
    videoUrl,
    raw: data,
  };
};

const mergeMeta = (base, next, options = {}) => {
  const preferVideo = Boolean(options.preferVideo);
  return {
    ...base,
    awemeId: base.awemeId || next.awemeId || "",
    title: base.title || next.title || "",
    cover: base.cover || next.cover || "",
    videoUrl: preferVideo ? next.videoUrl || base.videoUrl || "" : base.videoUrl || next.videoUrl || "",
    raw: base.raw || next.raw || null,
  };
};

const fetchTikHub = async (path, params, config, logger) => {
  if (!config.tikhubApiToken) {
    throw new AgentError("Missing TIKHUB_API_TOKEN", { code: "TIKHUB_TOKEN_MISSING", status: 500 });
  }
  const url = appendQuery(`${config.tikhubBaseUrl.replace(/\/$/, "")}${path}`, params);
  const { data } = await fetchJson(url, {
    timeoutMs: config.requestTimeoutMs,
    retries: config.apiRetryAttempts,
    retryBaseDelayMs: config.apiRetryBaseDelayMs,
    logger,
    interfaceName: `tikhub:${path}`,
    headers: {
      Authorization: `Bearer ${config.tikhubApiToken}`,
    },
  });
  return data;
};

export const resolveTikHubVideo = async (shareLink, config, options = {}) => {
  const logger = options.logger;
  let meta = {
    shareLink,
    awemeId: parseAwemeIdFromShareLink(shareLink),
    title: "",
    cover: "",
    videoUrl: "",
    raw: null,
  };
  const warnings = [];

  const attempts = [
    {
      path: "/api/v1/hybrid/video_data",
      params: { url: shareLink, minimal: false },
      preferVideo: false,
    },
    {
      path: "/api/v1/douyin/app/v3/fetch_one_video_by_share_url",
      params: { share_url: shareLink },
      preferVideo: false,
    },
    {
      path: "/api/v1/douyin/web/fetch_one_video_by_share_url",
      params: { share_url: shareLink },
      preferVideo: false,
    },
    {
      path: "/api/v1/douyin/web/fetch_video_high_quality_play_url",
      params: { share_url: shareLink, region: config.tikhubRegion },
      preferVideo: true,
    },
    {
      path: "/api/v1/douyin/app/v3/fetch_video_high_quality_play_url",
      params: { share_url: shareLink, region: config.tikhubRegion },
      preferVideo: true,
    },
  ];

  for (const attempt of attempts) {
    try {
      const payload = await fetchTikHub(attempt.path, attempt.params, config, logger);
      meta = mergeMeta(meta, extractVideoMeta(payload, shareLink), { preferVideo: attempt.preferVideo });
      if (meta.title && meta.cover && meta.videoUrl && attempt.preferVideo) break;
    } catch (error) {
      warnings.push({
        provider: "tikhub",
        step: attempt.path,
        message: error instanceof Error ? error.message : "TikHub request failed",
      });
    }
  }

  if (!meta.videoUrl) {
    throw new AgentError("Unable to resolve playable video URL from TikHub", {
      code: "VIDEO_URL_MISSING",
      details: warnings,
    });
  }

  logger?.info("tikhub.video.resolved", {
    provider: "tikhub",
    title: meta.title || "未识别标题",
    awemeId: meta.awemeId,
    ...describeVideoUrlForDiagnostics(meta.videoUrl),
  });

  return {
    ...meta,
    title: meta.title || "未识别标题",
    cover: meta.cover || "",
    warnings,
  };
};

const buildDoubaoAsrHeaders = (config, options = {}) => {
  const headers = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": config.doubaoResourceId,
    "X-Api-Request-Id": options.requestId || randomUUID(),
  };
  if (options.sequence) headers["X-Api-Sequence"] = options.sequence;

  if (config.doubaoApiKey) {
    headers["X-Api-Key"] = config.doubaoApiKey;
    return headers;
  }

  if (config.doubaoAppKey && config.doubaoAccessKey) {
    headers["X-Api-App-Key"] = config.doubaoAppKey;
    headers["X-Api-Access-Key"] = config.doubaoAccessKey;
    return headers;
  }

  throw new AgentError("Missing Doubao ASR credentials", { code: "DOUBAO_ASR_CREDENTIALS_MISSING" });
};

const getDoubaoUid = config => config.doubaoApiKey || config.doubaoAppKey || "xiaomang-agent";

const getAsrResult = data => Array.isArray(data?.result) ? data.result[0] : data?.result;

const extractAsrTranscript = (data) => {
  const result = getAsrResult(data);
  return String(result?.text || data?.text || "").trim();
};

const extractAsrUtterances = (data) => {
  const result = getAsrResult(data);
  return Array.isArray(result?.utterances) ? result.utterances : [];
};

const extractAsrDuration = (data) => {
  const result = getAsrResult(data);
  return data?.audio_info?.duration || result?.additions?.duration || null;
};

const isRetryableDoubaoAsrStatus = (statusCode) => {
  const code = String(statusCode || "");
  return code === "55000031" || /^55\d+/.test(code);
};

export const recognizeDoubaoAudio = async ({ audioDataBase64 }, config, options = {}) => {
  if (!audioDataBase64) {
    throw new AgentError("audioDataBase64 is required for ffmpeg + Doubao flash ASR", {
      code: "ASR_INPUT_MISSING",
      status: 422,
    });
  }

  const uid = getDoubaoUid(config);
  const logger = options.logger;
  const maxAttempts = Math.max(1, Number(config.apiRetryAttempts || 0) + 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestId = randomUUID();
    const { response, data } = await fetchJson(config.doubaoAsrEndpoint, {
      method: "POST",
      timeoutMs: config.requestTimeoutMs,
      retries: config.apiRetryAttempts,
      retryBaseDelayMs: config.apiRetryBaseDelayMs,
      logger,
      interfaceName: "doubao:asr.flash",
      logFields: {
        inputType: "base64",
        resourceId: config.doubaoResourceId,
        asrAttempt: attempt,
        asrMaxAttempts: maxAttempts,
        requestId,
      },
      headers: buildDoubaoAsrHeaders(config, { sequence: "-1", requestId }),
      body: JSON.stringify({
        user: { uid },
        audio: { data: audioDataBase64 },
        request: { model_name: "bigmodel" },
      }),
    });

    const statusCode = response.headers.get("X-Api-Status-Code");
    const apiMessage = response.headers.get("X-Api-Message");
    const logid = response.headers.get("X-Tt-Logid");
    const transcript = extractAsrTranscript(data);
    logger?.info("doubao.asr.result", {
      interface: "doubao:asr.flash",
      status: response.status,
      apiStatusCode: statusCode,
      apiMessage,
      logid,
      requestId,
      transcriptLength: transcript.length,
    });

    if (statusCode && statusCode !== "20000000") {
      const error = new AgentError(`Doubao ASR failed with code ${statusCode}`, {
        code: "DOUBAO_ASR_FAILED",
        status: response.status,
        details: { statusCode, apiMessage, logid, data },
      });
      lastError = error;
      if (attempt < maxAttempts && isRetryableDoubaoAsrStatus(statusCode)) {
        const delayMs = retryDelayMs(attempt, config.apiRetryBaseDelayMs);
        logger?.warn("external.request.retry", {
          interface: "doubao:asr.flash",
          method: "POST",
          endpoint: config.doubaoAsrEndpoint,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          reason: `ASR status ${statusCode}`,
          apiMessage,
          logid,
          requestId,
        });
        await sleep(delayMs);
        continue;
      }

      logger?.error("external.request.error", {
        interface: "doubao:asr.flash",
        method: "POST",
        endpoint: config.doubaoAsrEndpoint,
        error: error.message,
        code: error.code,
        status: error.status,
        details: compactDetails(error.details),
        requestId,
      });
      throw error;
    }
    if (!response.ok || !transcript) {
      throw new AgentError("Doubao ASR returned empty transcript", {
        code: "DOUBAO_ASR_EMPTY",
        status: response.status,
        details: { statusCode, apiMessage, logid, data },
      });
    }

    return {
      text: transcript,
      utterances: extractAsrUtterances(data),
      logid,
      duration: extractAsrDuration(data),
    };
  }

  throw lastError || new AgentError("Doubao ASR failed", { code: "DOUBAO_ASR_FAILED" });
};

const loadFfmpegPath = async () => {
  const imported = await import("ffmpeg-static");
  const ffmpegPath = imported.default || imported;
  if (!ffmpegPath || typeof ffmpegPath !== "string") {
    throw new AgentError("ffmpeg-static did not expose a binary path", { code: "FFMPEG_MISSING" });
  }
  return ffmpegPath;
};

const extractAudioWithFfmpeg = async (videoUrl, config, options = {}) => {
  if (!config.ffmpegEnabled) {
    throw new AgentError("ffmpeg transcript provider is disabled", { code: "FFMPEG_DISABLED" });
  }
  const ffmpegPath = await loadFfmpegPath();
  const logger = options.logger;
  const startedAt = Date.now();
  logger?.info("ffmpeg.extract.start", {
    interface: "ffmpeg-static",
    input: "video-url",
    output: "mp3-base64",
  });

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let stderr = "";
    let finished = false;
    const child = spawn(ffmpegPath, [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoUrl,
      "-vn",
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "32k",
      "-f",
      "mp3",
      "pipe:1",
    ]);

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        reject(new AgentError("ffmpeg audio extraction timed out", { code: "FFMPEG_TIMEOUT" }));
      }
    }, config.ffmpegTimeoutMs);

    child.stdout.on("data", chunk => {
      totalBytes += chunk.length;
      if (totalBytes > config.ffmpegAudioMaxBytes) {
        child.kill("SIGKILL");
        reject(new AgentError("ffmpeg audio output exceeded limit", { code: "FFMPEG_OUTPUT_TOO_LARGE" }));
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on("error", error => {
      clearTimeout(timer);
      logger?.error("ffmpeg.extract.error", {
        interface: "ffmpeg-static",
        durationMs: Date.now() - startedAt,
        error: error.message,
      });
      reject(new AgentError(error.message, { code: "FFMPEG_SPAWN_FAILED", cause: error }));
    });

    child.on("close", code => {
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        logger?.error("ffmpeg.extract.error", {
          interface: "ffmpeg-static",
          durationMs: Date.now() - startedAt,
          exitCode: code,
          error: stderr.trim(),
        });
        reject(new AgentError("ffmpeg audio extraction failed", {
          code: "FFMPEG_FAILED",
          details: stderr.trim(),
        }));
        return;
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        reject(new AgentError("ffmpeg produced empty audio", { code: "FFMPEG_EMPTY" }));
        return;
      }
      logger?.info("ffmpeg.extract.end", {
        interface: "ffmpeg-static",
        durationMs: Date.now() - startedAt,
        bytes: buffer.length,
      });
      resolve(buffer.toString("base64"));
    });
  });
};

const callDoubaoVideoUnderstanding = async (videoUrl, config, options = {}) => {
  if (!config.doubaoVideoEndpoint || !config.doubaoVideoApiKey) {
    throw new AgentError("Missing Doubao video understanding endpoint or credentials", {
      code: "DOUBAO_VIDEO_CREDENTIALS_MISSING",
    });
  }

  const headers = {
    "Content-Type": "application/json",
  };
  if (config.doubaoVideoAuthHeader.toLowerCase() === "authorization") {
    headers.Authorization = `Bearer ${config.doubaoVideoApiKey}`;
  } else {
    headers[config.doubaoVideoAuthHeader] = config.doubaoVideoApiKey;
  }

  const { data } = await fetchJson(config.doubaoVideoEndpoint, {
    method: "POST",
    timeoutMs: config.requestTimeoutMs,
    retries: config.apiRetryAttempts,
    retryBaseDelayMs: config.apiRetryBaseDelayMs,
    logger: options.logger,
    interfaceName: "doubao:video-understanding",
    headers,
    body: JSON.stringify({
      model: config.doubaoVideoModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: DOUBAO_VIDEO_TRANSCRIPT_PROMPT },
            { type: "video_url", video_url: { url: videoUrl } },
          ],
        },
      ],
      temperature: 0.1,
    }),
  });

  const text = cleanModelText(
    data?.choices?.[0]?.message?.content ||
      data?.output_text ||
      data?.text ||
      data?.result?.text ||
      "",
  );

  if (!text) {
    throw new AgentError("Doubao video understanding returned empty text", {
      code: "DOUBAO_VIDEO_EMPTY",
      details: data,
    });
  }
  return text;
};

export const transcribeVideo = async (videoMeta, config, options = {}) => {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const logger = options.logger;
  const cacheKey = videoMeta.awemeId || videoMeta.videoUrl || videoMeta.shareLink;
  const cached = transcriptCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < config.transcriptCacheTtlMs) {
    onProgress({
      step: "transcript-cache-hit",
      provider: cached.value.provider,
      message: `命中转写缓存：${cached.value.provider}`,
    });
    return { ...cached.value, cached: true };
  }

  const warnings = [];
  for (const provider of config.transcriptProviders) {
    try {
      logger?.info("transcript.provider.start", {
        provider,
        videoTitle: videoMeta.title,
      });
      onProgress({
        step: "transcript-provider-start",
        provider,
        message: `尝试转写方案：${provider}`,
      });
      if (provider === "ffmpeg") {
        const audioDataBase64 = await extractAudioWithFfmpeg(videoMeta.videoUrl, config, { logger });
        onProgress({
          step: "audio-extracted",
          provider,
          message: "ffmpeg-static 已提取音频，开始调用豆包 ASR",
        });
        const asr = await recognizeDoubaoAudio({ audioDataBase64 }, config, { logger });
        const value = { ...asr, provider: "ffmpeg+doubao-asr", warnings };
        logger?.info("transcript.provider.success", {
          provider: value.provider,
          textLength: value.text.length,
          duration: value.duration,
        });
        onProgress({
          step: "transcript-provider-success",
          provider: value.provider,
          message: `转写方案成功：${value.provider}`,
        });
        transcriptCache.set(cacheKey, { createdAt: Date.now(), value });
        return value;
      }
      if (provider === "doubao-video") {
        const text = await callDoubaoVideoUnderstanding(videoMeta.videoUrl, config, { logger });
        const value = { text, utterances: [], provider: "doubao-video", warnings };
        logger?.info("transcript.provider.success", {
          provider: value.provider,
          textLength: value.text.length,
        });
        onProgress({
          step: "transcript-provider-success",
          provider: value.provider,
          message: "多模态视频理解兜底成功：doubao-video",
        });
        transcriptCache.set(cacheKey, { createdAt: Date.now(), value });
        return value;
      }
      warnings.push({ provider, message: "Unknown transcript provider" });
    } catch (error) {
      logger?.warn("transcript.provider.failed", {
        provider,
        code: error?.code,
        status: error?.status,
        error: error instanceof Error ? error.message : "Transcript provider failed",
        details: compactDetails(error?.details),
      });
      onProgress({
        step: "transcript-provider-failed",
        provider,
        level: "warn",
        message: `转写方案失败：${provider}`,
        detail: error instanceof Error ? error.message : "Transcript provider failed",
        code: error?.code,
      });
      warnings.push({
        provider,
        message: error instanceof Error ? error.message : "Transcript provider failed",
        code: error?.code,
      });
    }
  }

  throw new AgentError("All transcript providers failed", {
    code: "TRANSCRIPT_FAILED",
    details: warnings,
  });
};

const chatEndpoint = (baseUrl) => {
  const clean = String(baseUrl || "").replace(/\/$/, "");
  if (/\/chat\/completions$/i.test(clean)) return clean;
  return `${clean}/chat/completions`;
};

const callDeepSeek = async ({ system, user, jsonMode = false, interfaceName = "deepseek:chat" }, config, options = {}) => {
  if (!config.deepseekApiKey) {
    throw new AgentError("Missing DEEPSEEK_API_KEY", { code: "DEEPSEEK_TOKEN_MISSING" });
  }
  const body = {
    model: config.deepseekModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: config.deepseekTemperature,
    max_tokens: config.deepseekMaxTokens,
  };
  if (jsonMode && config.useDeepseekJsonMode) {
    body.response_format = { type: "json_object" };
  }

  const endpoint = chatEndpoint(config.deepseekBaseUrl);
  const headers = {
    Authorization: `Bearer ${config.deepseekApiKey}`,
    "Content-Type": "application/json",
  };
  const postChat = requestBody =>
    fetchJson(endpoint, {
      method: "POST",
      timeoutMs: config.requestTimeoutMs,
      retries: config.apiRetryAttempts,
      retryBaseDelayMs: config.apiRetryBaseDelayMs,
      logger: options.logger,
      interfaceName,
      headers,
      body: JSON.stringify(requestBody),
    });

  let data;
  try {
    ({ data } = await postChat(body));
  } catch (error) {
    if (body.response_format && error?.status === 400) {
      const retryBody = { ...body };
      delete retryBody.response_format;
      ({ data } = await postChat(retryBody));
    } else {
      throw error;
    }
  }

  const text = cleanModelText(data?.choices?.[0]?.message?.content || data?.output_text || "");
  if (!text) {
    throw new AgentError("DeepSeek returned empty content", { code: "DEEPSEEK_EMPTY", details: data });
  }
  return text;
};

const runJsonAgent = async ({ system, user, normalizer, interfaceName }, config, options = {}) => {
  const raw = await callDeepSeek({ system, user, jsonMode: true, interfaceName }, config, options);
  try {
    return normalizer(parseJsonAgentOutput(raw));
  } catch (firstError) {
    const repaired = await callDeepSeek({
      system: "你是严格 JSON 修复器。只把用户给出的内容修复为合法 JSON 对象，不添加解释。",
      user: `请把下面模型输出修复为合法 JSON，只输出 JSON：\n${extractFirstJsonObjectText(raw) || raw}`,
      jsonMode: true,
      interfaceName: "deepseek:json-repair",
    }, config, options);
    try {
      return normalizer(parseJsonAgentOutput(repaired));
    } catch {
      throw firstError;
    }
  }
};

const buildCreativeInput = (videoMeta, transcriptText) => {
  return [
    `原视频标题：${videoMeta.title || "未识别标题"}`,
    `原视频链接：${videoMeta.shareLink || ""}`,
    "原视频转写文案：",
    transcriptText,
  ].join("\n");
};

const compactText = (value, maxLength = 80) => {
  const text = cleanModelText(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
};

const firstSentence = (value, maxLength = 80) => {
  const text = cleanModelText(value).replace(/\s+/g, " ").trim();
  const sentence = text.split(/(?<=[。！？!?])|[\r\n]+/).map(item => item.trim()).find(Boolean) || text;
  return compactText(sentence, maxLength);
};

const fallbackOpeningHook = (videoMeta, transcriptText) => {
  const extracted = firstSentence(transcriptText, 90);
  const title = compactText(videoMeta.title || extracted || "这条对标视频", 32);
  const created = [
    title ? `${title}，这条内容值得你先看完` : "",
    extracted ? `开头这句话别划走：${compactText(extracted, 42)}` : "",
  ].filter(Boolean);

  return normalizeOpeningHook({
    extracted,
    created,
  });
};

const fallbackEndingHook = () => normalizeEndingHook({
  extracted_result: "无",
  rcs: [],
});

const fallbackTitleText = (videoMeta, transcriptText) => {
  const title = compactText(videoMeta.title || firstSentence(transcriptText, 32) || "对标视频核心内容拆解", 32);
  return [
    `1. 《${title}》`,
    "类型：原始标题保底",
    "优势：DeepSeek 创作 Agent 暂时不可用时，保留可编辑标题，避免任务中断",
    "技巧：使用原视频标题承接内容主题，后续可人工继续优化",
  ].join("\n");
};

const fallbackScriptText = (videoMeta, transcriptText) => {
  const text = cleanModelText(transcriptText).trim();
  if (text) return text;
  return cleanModelText(videoMeta.title || "当前视频已完成转写，但二创文案 Agent 暂时不可用，请稍后重新生成。");
};

export const buildCreativeFallback = (videoMeta = {}, transcript = {}, error = null) => {
  const transcriptText = typeof transcript === "string" ? transcript : String(transcript?.text || "");
  return {
    openingHook: fallbackOpeningHook(videoMeta, transcriptText),
    endingHook: fallbackEndingHook(),
    titleText: fallbackTitleText(videoMeta, transcriptText),
    scriptText: fallbackScriptText(videoMeta, transcriptText),
    warnings: [
      {
        agent: "creative-agents",
        code: error?.code || "CREATIVE_AGENT_FALLBACK",
        status: error?.status,
        error: error instanceof Error ? error.message : "Creative agents fell back to compatible output",
        details: compactDetails(error?.details),
        fallbackUsed: true,
      },
    ],
  };
};

const creativeErrorFields = (agent, error) => ({
  agent,
  code: error?.code,
  status: error?.status,
  error: error instanceof Error ? error.message : "Creative agent failed",
  details: compactDetails(error?.details),
});

const isRetryableCreativeError = (error) => {
  const code = String(error?.code || "");
  const status = Number(error?.status || 0);
  if (["DEEPSEEK_TOKEN_MISSING", "DEEPSEEK_CREDENTIALS_MISSING"].includes(code)) return false;
  if ([400, 401, 403, 404, 422].includes(status)) return false;
  return (
    code === "NETWORK_ERROR" ||
    code === "HTTP_ERROR" ||
    code === "DEEPSEEK_EMPTY" ||
    code === "MODEL_JSON_INVALID" ||
    code === "AGENT_ERROR" ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
};

const creativeRetryConfig = (config) => {
  const attempts = Number.parseInt(String(config.creativeAgentRetryAttempts ?? 2), 10);
  const baseDelayMs = Number.parseInt(String(config.creativeAgentRetryBaseDelayMs ?? 1200), 10);
  return {
    maxAttempts: Math.max(1, Number.isFinite(attempts) ? attempts + 1 : 3),
    baseDelayMs: Math.max(0, Number.isFinite(baseDelayMs) ? baseDelayMs : 1200),
  };
};

const runCreativeStep = async ({ agent, interfaceName, run, fallback }, config, options = {}) => {
  const logger = options.logger;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const { maxAttempts, baseDelayMs } = creativeRetryConfig(config);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    logger?.info("creative.agent.attempt.start", {
      interface: interfaceName,
      agent,
      attempt,
      maxAttempts,
    });
    onProgress({
      step: "creative-agent-attempt",
      agent,
      interface: interfaceName,
      attempt,
      maxAttempts,
      message: `创作 Agent ${agent} 第 ${attempt}/${maxAttempts} 次执行`,
    });

    try {
      const value = await run();
      logger?.info("creative.agent.attempt.success", {
        interface: interfaceName,
        agent,
        attempt,
        maxAttempts,
      });
      return {
        value,
        warning: null,
        attempts: attempt,
        fallbackUsed: false,
      };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableCreativeError(error);
      const fields = {
        interface: interfaceName,
        attempt,
        maxAttempts,
        retryable,
        ...creativeErrorFields(agent, error),
      };
      logger?.warn("creative.agent.attempt.failed", fields);
      onProgress({
        step: "creative-agent-attempt-failed",
        agent,
        interface: interfaceName,
        attempt,
        maxAttempts,
        level: "warn",
        retryable,
        code: error?.code,
        message: `创作 Agent ${agent} 第 ${attempt}/${maxAttempts} 次执行失败`,
      });

      if (attempt < maxAttempts && retryable) {
        const delayMs = retryDelayMs(attempt, baseDelayMs);
        logger?.warn("creative.agent.retry", {
          interface: interfaceName,
          agent,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          code: error?.code,
          status: error?.status,
        });
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }

  const warning = creativeErrorFields(agent, lastError);
  logger?.warn("creative.agent.fallback", {
    interface: interfaceName,
    maxAttempts,
    ...warning,
  });
  onProgress({
    step: "creative-agent-fallback",
    agent,
    interface: interfaceName,
    level: "warn",
    code: lastError?.code,
    message: `创作 Agent ${agent} 多次失败，已使用兼容保底结果`,
  });
  return {
    value: fallback(),
    warning: {
      ...warning,
      attempts: maxAttempts,
      fallbackUsed: true,
    },
    attempts: maxAttempts,
    fallbackUsed: true,
  };
};

export const runCreativeAgents = async (videoMeta, transcript, config, options = {}) => {
  const creativeInput = buildCreativeInput(videoMeta, transcript.text);
  const logger = options.logger;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const transcriptText = transcript.text || "";
  const [openingHook, endingHook, titleText, scriptText] = await Promise.all([
    runCreativeStep({
      agent: "opening-hook",
      interfaceName: "deepseek:agent-opening-hook",
      run: () => runJsonAgent({
        system: OPENING_HOOK_PROMPT,
        user: creativeInput,
        interfaceName: "deepseek:agent-opening-hook",
        normalizer: normalizeOpeningHook,
      }, config, { logger }),
      fallback: () => fallbackOpeningHook(videoMeta, transcriptText),
    }, config, { logger, onProgress }),
    runCreativeStep({
      agent: "ending-hook",
      interfaceName: "deepseek:agent-ending-hook",
      run: () => runJsonAgent({
        system: ENDING_HOOK_PROMPT,
        user: creativeInput,
        interfaceName: "deepseek:agent-ending-hook",
        normalizer: normalizeEndingHook,
      }, config, { logger }),
      fallback: fallbackEndingHook,
    }, config, { logger, onProgress }),
    runCreativeStep({
      agent: "title",
      interfaceName: "deepseek:agent-title",
      run: () => callDeepSeek({ system: TITLE_PROMPT, user: creativeInput, interfaceName: "deepseek:agent-title" }, config, { logger }),
      fallback: () => fallbackTitleText(videoMeta, transcriptText),
    }, config, { logger, onProgress }),
    runCreativeStep({
      agent: "script",
      interfaceName: "deepseek:agent-script",
      run: () => callDeepSeek({ system: SCRIPT_REWRITE_PROMPT, user: creativeInput, interfaceName: "deepseek:agent-script" }, config, { logger }),
      fallback: () => fallbackScriptText(videoMeta, transcriptText),
    }, config, { logger, onProgress }),
  ]);
  const warnings = [openingHook.warning, endingHook.warning, titleText.warning, scriptText.warning].filter(Boolean);
  if (warnings.length > 0) {
    logger?.warn("creative.agents.completed_with_fallback", {
      failedAgents: warnings.map(item => item.agent).join(","),
      count: warnings.length,
    });
  }

  return {
    openingHook: openingHook.value,
    endingHook: endingHook.value,
    titleText: cleanModelText(titleText.value),
    scriptText: cleanModelText(scriptText.value),
    warnings,
  };
};

const normalizeTranslationResult = (value, sourcePayload) => {
  const output = value?.output && typeof value.output === "object" ? value.output : value;
  const rawList = Array.isArray(output?.translations)
    ? output.translations
    : Array.isArray(output?.results)
      ? output.results
      : [];
  const sourceItems = [
    ...(Array.isArray(sourcePayload?.titles) ? sourcePayload.titles.map(text => ({ sourceType: "title", original: text })) : []),
    ...(Array.isArray(sourcePayload?.hooks) ? sourcePayload.hooks.map(text => ({ sourceType: "hook", original: text })) : []),
    ...(Array.isArray(sourcePayload?.scripts) ? sourcePayload.scripts.map(text => ({ sourceType: "script", original: text })) : []),
  ];

  const translations = rawList
    .map((item, index) => {
      const source = sourceItems[index] || {};
      const original = String(item?.original || item?.source || item?.zh || source.original || "").trim();
      const translated = String(item?.translated || item?.target || item?.en || item?.english || "").trim();
      const sourceType = item?.sourceType || item?.type || source.sourceType || "script";
      if (!original || !translated) return null;
      return {
        id: `${sourceType}-${index + 1}`,
        sourceType,
        original,
        translated,
        zh: original,
        en: translated,
      };
    })
    .filter(Boolean);

  return { translations };
};

export const runTranslationAgent = async (sourcePayload, config, options = {}) => {
  const system = [
    "你是专业短视频文案中英翻译助手。",
    "请把用户提供的标题、钩子和文案翻译成自然、适合内容生产场景的英文。",
    "必须输出严格 JSON：{\"translations\":[{\"sourceType\":\"title|hook|script\",\"original\":\"原文\",\"translated\":\"英文翻译\"}]}。",
    "不要输出 Markdown，不要添加解释。",
  ].join("\n");
  const user = JSON.stringify(sourcePayload || {});
  const raw = await callDeepSeek({
    system,
    user,
    jsonMode: true,
    interfaceName: "deepseek:agent-translation",
  }, config, options);
  return normalizeTranslationResult(parseJsonAgentOutput(raw), sourcePayload || {});
};

export const runRewriteAgent = async ({ targetPlatform, scripts }, config, options = {}) => {
  const system = [
    "你是资深新媒体编辑，请将用户给出的文案改写为指定平台风格。",
    "保持原意、核心卖点和行动指令，语言贴合目标平台，不输出分析过程。",
    "必须输出严格 JSON：{\"results\":[{\"id\":\"原id\",\"rewritten\":\"改写结果\"}]}。",
    "不要输出 Markdown，不要添加解释。",
  ].join("\n");
  const user = JSON.stringify({ targetPlatform, scripts: Array.isArray(scripts) ? scripts : [] });
  const raw = await callDeepSeek({
    system,
    user,
    jsonMode: true,
    interfaceName: "deepseek:agent-platform-rewrite",
  }, config, options);
  const output = parseJsonAgentOutput(raw);
  const rawResults = Array.isArray(output?.results) ? output.results : [];
  return {
    results: rawResults
      .map((item, index) => {
        const source = scripts?.[index] || {};
        const id = String(item?.id || source.id || `rw-${index + 1}`);
        const rewritten = String(item?.rewritten || item?.content || item?.text || "").trim();
        if (!rewritten) return null;
        return { id, rewritten };
      })
      .filter(Boolean),
  };
};

export const clearTranscriptCacheForTests = () => {
  transcriptCache.clear();
};

export const parseJsonForTests = (raw) => {
  return safeJsonParse(extractFirstJsonObjectText(raw), null);
};
