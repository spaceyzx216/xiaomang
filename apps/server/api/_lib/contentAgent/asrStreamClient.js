import { randomUUID } from "crypto";
import { gzipSync, gunzipSync } from "node:zlib";

import { WebSocket as UndiciWebSocket } from "undici";

import { AgentError } from "./http.js";

/**
 * 豆包**流式/实时语音识别 2.0**（resource id `volc.seedasr.sauc.duration`）的
 * WebSocket 二进制协议客户端。
 *
 * 背景：项目原来用「录音文件识别 2.0」（`doubao-file` → `volc.seedasr.auc`，异步
 * submit + 轮询、只收音频 URL）。现在改为把 **PCM 16k/16bit/单声道** 直接通过
 * WebSocket 流式送上去，拿同步返回。
 *
 * 协议要点（Lead 已在真实 API 验证，本文件严格照做，改动前先对照集成方 providers.js）：
 *   · 连接：wss 端点 + 握手头 `X-Api-Resource-Id`（默认 `volc.seedasr.sauc.duration`）
 *     与 `X-Api-Request-Id`，鉴权优先 `X-Api-Key`，否则 AppKey + AccessKey。
 *   · 帧格式：4 字节头（大端序）：
 *       byte0 = (protocolVersion 1 << 4) | headerSize(1)
 *       byte1 = (messageType << 4) | flags
 *       byte2 = (serialization JSON 1 << 4) | (compression GZIP 1)
 *       byte3 = 0
 *     full request = 1、audio only = 2；服务端 full response = 9、error = 15。
 *   · 发送策略：**burst 全速发送**（不按 200ms 节拍）。seq：full request=1，
 *     音频从 2 递增，最后一包 flags=3（NEG_WITH_SEQUENCE）且 seq 取负。
 *   · 服务端 JSON 根结构：`{audio_info:{duration}, result:{text, utterances,
 *     additions:{log_id}}}`（没有 `payload_msg` 外层）。
 *
 * 本文件**不负责** PCM 解码（ffmpeg 那一层负责），也不写配置默认值（集成方在
 * config.js 里加 `doubaoStreamAsr*` 字段；这里都带 fallback 默认值，便于先接再配）。
 */

export const DEFAULT_STREAM_ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
export const DEFAULT_STREAM_ASR_RESOURCE_ID = "volc.seedasr.sauc.duration";
export const DEFAULT_STREAM_ASR_CHUNK_BYTES = 6400;
export const DEFAULT_STREAM_ASR_BUDGET_MS = 120000;

const PROTOCOL_VERSION = 1;
const HEADER_SIZE_WORDS = 1;
const SERIALIZATION_JSON = 1;
const COMPRESSION_GZIP = 1;

const MSG_FULL_REQUEST = 1;
const MSG_AUDIO_ONLY = 2;
const MSG_FULL_RESPONSE = 9;
const MSG_ERROR_RESPONSE = 15;

const FLAG_POS_SEQUENCE = 1;
const FLAG_NEG_WITH_SEQUENCE = 3;

/** 流式识别固定用 16k / 16bit / 单声道 / raw PCM。 */
const STREAM_AUDIO_FORMAT = Object.freeze({
  format: "pcm",
  codec: "raw",
  rate: 16000,
  bits: 16,
  channel: 1,
});

const BAD_FRAME_CODE = "DOUBAO_STREAM_ASR_BAD_FRAME";

const badFrame = (message, cause) => new AgentError(message, { code: BAD_FRAME_CODE, cause });

const buildHeader = (messageType, flags) => Buffer.from([
  (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS,
  ((messageType << 4) | (flags & 0x0f)) & 0xff,
  (SERIALIZATION_JSON << 4) | COMPRESSION_GZIP,
  0,
]);

const writeInt32 = value => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(Math.trunc(Number(value) || 0), 0);
  return buffer;
};

const writeUInt32 = value => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(Math.max(0, Math.trunc(Number(value) || 0)), 0);
  return buffer;
};

const asBuffer = value => {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
};

/**
 * 完整请求帧（`full request`）：seq 固定为 1。
 *
 * @param {object} payloadObj 完整请求 JSON（见 `buildStreamRequestPayload`）
 * @returns {Buffer}
 */
export const buildFullRequestFrame = (payloadObj) => {
  const payload = gzipSync(Buffer.from(JSON.stringify(payloadObj ?? {}), "utf8"));
  return Buffer.concat([
    buildHeader(MSG_FULL_REQUEST, FLAG_POS_SEQUENCE),
    writeInt32(1),
    writeUInt32(payload.length),
    payload,
  ]);
};

/**
 * 音频帧（`audio only`）。最后一包 `flags=3` 且 seq 取负值（协议要求）。
 *
 * @param {number} seq 调用方传音频序号（从 2 起递增）；`isLast` 时内部取负
 * @param {Buffer|Uint8Array} chunk PCM 分片（最后一包可为空）
 * @param {boolean} isLast 是否最后一包
 * @returns {Buffer}
 */
export const buildAudioFrame = (seq, chunk, isLast = false) => {
  const numericSeq = Math.abs(Math.trunc(Number(seq) || 0));
  const frameSeq = isLast ? -numericSeq : numericSeq;
  const payload = gzipSync(asBuffer(chunk));
  return Buffer.concat([
    buildHeader(MSG_AUDIO_ONLY, isLast ? FLAG_NEG_WITH_SEQUENCE : FLAG_POS_SEQUENCE),
    writeInt32(frameSeq),
    writeUInt32(payload.length),
    payload,
  ]);
};

/**
 * 解析服务端二进制帧。
 *
 * flags：bit0=带 seq（int32BE）、bit1=is_last_package、bit2=带 event（int32BE）。
 * type=9 先读 uint32BE payload_size；type=15 先读 int32BE code 再读 uint32BE payload_size。
 *
 * @param {Buffer|Uint8Array} raw
 * @returns {{msgType:number, flags:number, seq:number|null, isLast:boolean,
 *            event:number|null, code:number|null, payloadSize:number|null,
 *            json:object|null, headerSize:number, messageType:number,
 *            serialization:number, compression:number}}
 */
export const parseServerFrame = (raw) => {
  const msg = asBuffer(raw);
  if (msg.length < 4) throw badFrame("Invalid Doubao stream frame: shorter than 4-byte header");
  const headerSize = msg[0] & 0x0f;
  if (headerSize < 1) throw badFrame("Invalid Doubao stream frame: header size is zero");
  const offsetStart = headerSize * 4;
  if (offsetStart > msg.length) throw badFrame("Invalid Doubao stream frame: header size exceeds payload");

  const msgType = msg[1] >> 4;
  const flags = msg[1] & 0x0f;
  const serialization = msg[2] >> 4;
  const compression = msg[2] & 0x0f;
  const frame = {
    headerSize,
    msgType,
    messageType: msgType,
    flags,
    serialization,
    compression,
    seq: null,
    isLast: false,
    event: null,
    code: null,
    payloadSize: null,
    json: null,
  };

  let offset = offsetStart;
  const ensure = (bytes, label) => {
    if (offset + bytes > msg.length) {
      throw badFrame(`Invalid Doubao stream frame: truncated ${label}`);
    }
  };

  if (flags & 0x01) {
    ensure(4, "sequence");
    frame.seq = msg.readInt32BE(offset);
    offset += 4;
  }
  if (flags & 0x02) frame.isLast = true;
  if (flags & 0x04) {
    ensure(4, "event");
    frame.event = msg.readInt32BE(offset);
    offset += 4;
  }

  if (msgType === MSG_ERROR_RESPONSE) {
    ensure(8, "error header");
    frame.code = msg.readInt32BE(offset);
    offset += 4;
    frame.payloadSize = msg.readUInt32BE(offset);
    offset += 4;
  } else if (msgType === MSG_FULL_RESPONSE) {
    ensure(4, "payload size");
    frame.payloadSize = msg.readUInt32BE(offset);
    offset += 4;
  }

  const end = frame.payloadSize == null
    ? msg.length
    : Math.min(msg.length, offset + frame.payloadSize);
  let payload = msg.subarray(offset, end);

  if (compression === COMPRESSION_GZIP && payload.length > 0) {
    try {
      payload = gunzipSync(payload);
    } catch (error) {
      throw badFrame("Invalid Doubao stream frame: gzip payload is corrupt", error);
    }
  }

  if (payload.length > 0) {
    if (serialization === SERIALIZATION_JSON) {
      try {
        frame.json = JSON.parse(payload.toString("utf8"));
      } catch {
        // 解析失败不在这里炸：调用方按“没有可用 JSON”处理（通常随后会 close/超时）。
        frame.json = null;
      }
    } else {
      frame.payload = payload;
    }
  }

  return frame;
};

/**
 * 完整请求 JSON（`payloadObj`）。字段与顺序遵循已验证协议，不要随手改。
 * @returns {{user:object, audio:object, request:object}}
 */
export const buildStreamRequestPayload = () => ({
  user: { uid: "xiaomang-agent" },
  audio: { ...STREAM_AUDIO_FORMAT },
  request: {
    model_name: "bigmodel",
    enable_itn: true,
    enable_punc: true,
    enable_ddc: true,
    show_utterances: true,
    enable_nonstream: true,
    result_type: "full",
  },
});

/**
 * 握手头。鉴权优先 `X-Api-Key`；没有则必须同时有 AppKey + AccessKey，
 * 两者都没有时抛 `DOUBAO_STREAM_CREDENTIALS_MISSING`（**不要**在日志里打凭据）。
 *
 * @param {object} config getContentAgentConfig() 的返回值（或同形对象）
 * @returns {Record<string,string>}
 */
export const buildStreamHandshakeHeaders = (config = {}) => {
  const apiKey = String(config?.doubaoApiKey || "").trim();
  const appKey = String(config?.doubaoAppKey || "").trim();
  const accessKey = String(config?.doubaoAccessKey || "").trim();
  const headers = {
    "X-Api-Resource-Id": String(config?.doubaoStreamAsrResourceId || DEFAULT_STREAM_ASR_RESOURCE_ID),
    "X-Api-Request-Id": randomUUID(),
  };
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  } else if (appKey && accessKey) {
    headers["X-Api-App-Key"] = appKey;
    headers["X-Api-Access-Key"] = accessKey;
  } else {
    throw new AgentError("Missing Doubao credentials for stream ASR", {
      code: "DOUBAO_STREAM_CREDENTIALS_MISSING",
    });
  }
  return headers;
};

const normalizePositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toAudioBuffer = (pcm) => {
  if (Buffer.isBuffer(pcm)) return pcm;
  if (pcm instanceof ArrayBuffer) return Buffer.from(pcm);
  if (ArrayBuffer.isView(pcm)) return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return null;
};

/** 同步可转换的帧数据（Buffer / ArrayBuffer / TypedArray / string）——绝大多数情况。 */
const toFrameBufferSync = (data) => {
  if (data == null) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return null;
};

/** WebSocket 的 message payload 可能是 Buffer / ArrayBuffer / TypedArray / Blob。 */
const toFrameBuffer = async (data) => {
  const sync = toFrameBufferSync(data);
  if (sync) return sync;
  if (data && typeof data.arrayBuffer === "function") {
    try {
      return Buffer.from(await data.arrayBuffer());
    } catch {
      return null;
    }
  }
  return null;
};

/** 兼容标准 EventTarget（undici/浏览器）与 on* 赋值式（部分测试/库实现）。 */
const addWsListener = (ws, type, handler) => {
  if (typeof ws?.addEventListener === "function") {
    ws.addEventListener(type, handler);
    return;
  }
  const key = `on${type}`;
  const previous = typeof ws?.[key] === "function" ? ws[key] : null;
  ws[key] = event => {
    if (typeof previous === "function") previous(event);
    handler(event);
  };
};

const toStreamError = (message, cause) => {
  if (cause instanceof AgentError) return cause;
  const causeMessage = cause instanceof Error
    ? cause.message
    : (typeof cause === "string" ? cause : "");
  return new AgentError(`${message}${causeMessage ? `: ${causeMessage}` : ""}`, {
    code: "DOUBAO_STREAM_ASR_FAILED",
    cause,
  });
};

const errorMessageOf = (json) => {
  if (!json || typeof json !== "object") return "";
  const candidates = [json.message, json.error, json.error_message, json.result?.message];
  const found = candidates.find(item => typeof item === "string" && item.trim());
  return found ? found.trim() : "";
};

const logidOf = (json) => {
  if (!json || typeof json !== "object") return "";
  return String(
    json.log_id
    ?? json.logid
    ?? json.additions?.log_id
    ?? json.result?.additions?.log_id
    ?? "",
  );
};

const mergeServerResult = (target, json) => {
  const result = json?.result;
  if (result && typeof result === "object") {
    if (result.text !== undefined && result.text !== null) target.text = String(result.text);
    if (Array.isArray(result.utterances)) target.utterances = result.utterances;
  }
  const logid = logidOf(json);
  if (logid) target.logid = logid;
  const duration = json?.audio_info?.duration ?? json?.result?.audio_info?.duration;
  if (duration !== undefined && duration !== null) target.duration = duration;
};

/**
 * 识别一段 PCM 音频（16k / 16bit / 单声道 raw）。**burst 全速发送**音频帧，
 * 等待服务端 `is_last_package=true` 的完整响应后返回最终文本。
 *
 * 失败语义（与集成方 providers.js 的 provider 链约定一致）：
 *   · 缺凭据 → `DOUBAO_STREAM_CREDENTIALS_MISSING`
 *   · 服务端 error 帧 / WS error / 未拿到末包就 close / 发送失败 → `DOUBAO_STREAM_ASR_FAILED`
 *   · 总预算超时 → `DOUBAO_STREAM_ASR_TIMEOUT`
 *   · 末包文本为空 → `DOUBAO_STREAM_ASR_EMPTY`
 * 所有退出路径都会 best-effort `ws.close()`。
 *
 * @param {object} options
 * @param {Buffer|Uint8Array|ArrayBuffer} options.pcm
 * @param {object} options.config
 * @param {object} [options.logger]
 * @param {Function} [options.WebSocketImpl] 可注入的 WebSocket 实现（测试用假实现）
 * @returns {Promise<{text:string, utterances:Array, logid:string, duration:number|null,
 *                    provider:"doubao-stream-asr", bytes:number}>}
 */
export const recognizeDoubaoStreamAudio = async ({
  pcm,
  config = {},
  logger,
  WebSocketImpl,
} = {}) => {
  const audio = toAudioBuffer(pcm);
  if (!audio) {
    throw new AgentError("pcm audio is required for Doubao stream ASR", {
      code: "ASR_INPUT_MISSING",
      status: 422,
    });
  }

  // 先做凭据/端点校验：缺凭据时不构造连接，也不留下任何可疑日志。
  const headers = buildStreamHandshakeHeaders(config);
  const url = String(config?.doubaoStreamAsrUrl || DEFAULT_STREAM_ASR_URL);
  const resourceId = headers["X-Api-Resource-Id"];
  const budgetMs = normalizePositiveNumber(config?.doubaoStreamAsrBudgetMs, DEFAULT_STREAM_ASR_BUDGET_MS);
  const chunkBytes = Math.max(
    1,
    Math.floor(normalizePositiveNumber(config?.doubaoStreamAsrChunkBytes, DEFAULT_STREAM_ASR_CHUNK_BYTES)),
  );
  const Impl = typeof WebSocketImpl === "function" ? WebSocketImpl : UndiciWebSocket;

  logger?.info("doubao.stream.asr.start", {
    interface: "doubao:asr.stream",
    endpoint: url,
    resourceId,
    bytes: audio.length,
    chunkBytes,
    budgetMs,
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let sendingStarted = false;
    let ws = null;
    let timer = null;
    const latest = { text: "", utterances: [], logid: "", duration: null };

    const closeQuietly = () => {
      try {
        ws?.close?.();
      } catch {
        // best-effort：关闭失败不影响已经确定的成功/失败结果。
      }
    };

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      closeQuietly();
      if (error) {
        logger?.warn("doubao.stream.asr.failed", {
          interface: "doubao:asr.stream",
          code: error?.code,
          error: error instanceof Error ? error.message : "Doubao stream ASR failed",
        });
        reject(error);
        return;
      }
      logger?.info("doubao.stream.asr.result", {
        interface: "doubao:asr.stream",
        textLength: value.text.length,
        utteranceCount: value.utterances.length,
        duration: value.duration,
        logid: value.logid,
        bytes: value.bytes,
      });
      resolve(value);
    };

    timer = setTimeout(() => {
      settle(new AgentError(`Doubao stream ASR did not finish within ${budgetMs}ms`, {
        code: "DOUBAO_STREAM_ASR_TIMEOUT",
        details: { budgetMs },
      }));
    }, budgetMs);

    try {
      ws = new Impl(url, { headers });
    } catch (error) {
      settle(new AgentError("Failed to open Doubao stream ASR websocket", {
        code: "DOUBAO_STREAM_ASR_FAILED",
        cause: error,
      }));
      return;
    }

    // 二进制帧用 arraybuffer 接收（默认 blob 会多一次异步读；两种都在 toFrameBuffer 里兜住）。
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      // 某些实现不允许写 binaryType：不影响，message 回调里会兼容 Blob。
    }

    const sendAllFrames = async () => {
      if (settled) return;
      ws.send(buildFullRequestFrame(buildStreamRequestPayload()));
      const chunks = [];
      for (let offset = 0; offset < audio.length; offset += chunkBytes) {
        chunks.push(audio.subarray(offset, Math.min(offset + chunkBytes, audio.length)));
      }
      if (chunks.length === 0) chunks.push(Buffer.alloc(0));

      for (let index = 0; index < chunks.length; index += 1) {
        if (settled) return;
        const isLast = index === chunks.length - 1;
        ws.send(buildAudioFrame(index + 2, chunks[index], isLast));
        // 全速 burst 会让出事件循环一次，避免 26s 音频（几百包）把同实例的其它请求饿死。
        if (!isLast && (index + 1) % 20 === 0) {
          await new Promise(resolveNext => setImmediate(resolveNext));
        }
      }
    };

    const startSending = () => {
      if (sendingStarted || settled) return;
      sendingStarted = true;
      void sendAllFrames().catch(error => {
        settle(toStreamError("Failed to send Doubao stream ASR frames", error));
      });
    };

    const processServerFrameBuffer = (frameBuffer) => {
      if (settled) return;
      const frame = parseServerFrame(frameBuffer);
      if (frame.msgType === MSG_ERROR_RESPONSE) {
        const message = errorMessageOf(frame.json);
        const logid = logidOf(frame.json);
        settle(new AgentError(
          `Doubao stream ASR failed with code ${frame.code ?? "unknown"}${message ? `: ${message}` : ""}`,
          {
            code: "DOUBAO_STREAM_ASR_FAILED",
            details: { code: frame.code, message, logid },
          },
        ));
        return;
      }
      if (frame.msgType !== MSG_FULL_RESPONSE) return;
      mergeServerResult(latest, frame.json);
      if (!frame.isLast) return;
      if (!latest.text.trim()) {
        settle(new AgentError("Doubao stream ASR returned empty transcript", {
          code: "DOUBAO_STREAM_ASR_EMPTY",
          details: { duration: latest.duration, logid: latest.logid },
        }));
        return;
      }
      settle(null, {
        text: latest.text,
        utterances: latest.utterances,
        logid: latest.logid,
        duration: latest.duration,
        provider: "doubao-stream-asr",
        bytes: audio.length,
      });
    };

    const handleFrameEvent = (event) => {
      if (settled) return;
      const data = event?.data ?? event;
      // 🔴 二进制帧必须**同步**处理：服务端可能“发完末包立刻 close”，若这里 await
      // （哪怕 await 一个已 resolve 的 Buffer 也会让到微任务），close 事件会先于末包
      // 被处理，表现为“明明成功了却报 websocket closed”。只有 Blob 才走异步分支。
      const syncBuffer = toFrameBufferSync(data);
      if (syncBuffer) {
        try {
          processServerFrameBuffer(syncBuffer);
        } catch (error) {
          logger?.warn("doubao.stream.asr.bad_frame", {
            interface: "doubao:asr.stream",
            code: error?.code,
            error: error instanceof Error ? error.message : "Invalid server frame",
          });
        }
        return;
      }
      void (async () => {
        try {
          const frameBuffer = await toFrameBuffer(data);
          if (!frameBuffer || settled) return;
          processServerFrameBuffer(frameBuffer);
        } catch (error) {
          // 单帧解析/读取失败不直接判死：继续等后续帧（最终由超时或 close 收口）。
          logger?.warn("doubao.stream.asr.bad_frame", {
            interface: "doubao:asr.stream",
            code: error?.code,
            error: error instanceof Error ? error.message : "Invalid server frame",
          });
        }
      })();
    };

    addWsListener(ws, "open", startSending);
    addWsListener(ws, "message", handleFrameEvent);
    addWsListener(ws, "error", event => {
      const cause = event?.error || event?.message || "websocket error";
      settle(toStreamError("Doubao stream ASR websocket error", cause));
    });
    addWsListener(ws, "close", event => {
      if (settled) return;
      const codeSuffix = event?.code ? ` (code ${event.code})` : "";
      settle(new AgentError(`Doubao stream ASR websocket closed before final response${codeSuffix}`, {
        code: "DOUBAO_STREAM_ASR_FAILED",
        details: { closeCode: event?.code ?? null, reason: event?.reason ?? "" },
      }));
    });

    // 兜底：某些实现（或已同步 open 的假实现）不会补发 open 事件。
    if (ws.readyState === 1) startSending();
  });
};
