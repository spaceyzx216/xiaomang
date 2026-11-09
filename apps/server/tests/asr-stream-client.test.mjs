import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  buildAudioFrame,
  buildFullRequestFrame,
  buildStreamHandshakeHeaders,
  buildStreamRequestPayload,
  parseServerFrame,
  recognizeDoubaoStreamAudio,
} from "../api/_lib/contentAgent/asrStreamClient.js";

/**
 * 这些测试**完全离线**：用注入的假 WebSocket（FakeWebSocket）回放服务端帧，
 * 不发起任何真实连接，也不使用任何真实凭据。
 */

// ── 本地解帧 helper（刻意不复用 parseServerFrame，避免“用被测函数验证被测函数”）──
const decodeClientFrame = (frame) => {
  const buffer = Buffer.from(frame);
  const headerSize = buffer[0] & 0x0f;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  let offset = headerSize * 4;
  const seq = buffer.readInt32BE(offset);
  offset += 4;
  const payloadSize = buffer.readUInt32BE(offset);
  offset += 4;
  const rawPayload = buffer.subarray(offset, offset + payloadSize);
  const payload = compression === 1 ? gunzipSync(rawPayload) : rawPayload;
  return {
    header: [...buffer.subarray(0, 4)],
    headerSize,
    messageType,
    flags,
    serialization,
    compression,
    seq,
    payloadSize,
    payload,
  };
};

/** 构造服务端二进制帧（full response=9 / error response=15），字段与协议一致。 */
const buildServerFrame = ({ msgType = 9, flags, seq, isLast = false, event, code, json } = {}) => {
  let flagBits = flags;
  if (flagBits === undefined) {
    flagBits = (seq !== undefined ? 0x01 : 0)
      | (isLast ? 0x02 : 0)
      | (event !== undefined ? 0x04 : 0);
  }
  const parts = [Buffer.from([
    (1 << 4) | 1,
    ((msgType << 4) | (flagBits & 0x0f)) & 0xff,
    (1 << 4) | 1,
    0,
  ])];
  if (seq !== undefined) {
    const seqBuffer = Buffer.alloc(4);
    seqBuffer.writeInt32BE(seq);
    parts.push(seqBuffer);
  }
  if (event !== undefined) {
    const eventBuffer = Buffer.alloc(4);
    eventBuffer.writeInt32BE(event);
    parts.push(eventBuffer);
  }
  const payload = json === undefined
    ? Buffer.alloc(0)
    : gzipSync(Buffer.from(JSON.stringify(json), "utf8"));
  if (msgType === 15) {
    const codeBuffer = Buffer.alloc(4);
    codeBuffer.writeInt32BE(code ?? 0);
    parts.push(codeBuffer);
  }
  const sizeBuffer = Buffer.alloc(4);
  sizeBuffer.writeUInt32BE(payload.length);
  parts.push(sizeBuffer, payload);
  return Buffer.concat(parts);
};

const isLastAudioFrame = (frame) => {
  const buffer = Buffer.from(frame);
  return (buffer[1] >> 4) === 2 && (buffer[1] & 0x0f) === 3;
};

// ── 假 WebSocket：只实现客户端用到的最小接口（addEventListener / send / close / readyState）──
class FakeWebSocket {
  static instances = [];

  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.sentFrames = [];
    this.listeners = new Map();
    this.closed = false;
    this.readyState = 0;
    this.onSend = null;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.emit("open", { type: "open" });
    });
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(type, handlers.filter(item => item !== handler));
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler(event);
    const legacy = this[`on${type}`];
    if (typeof legacy === "function") legacy(event);
  }

  emitMessage(data) {
    this.emit("message", { type: "message", data });
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("FakeWebSocket: send() on a socket that is not open");
    this.sentFrames.push(Buffer.from(data));
    this.onSend?.(this, this.sentFrames);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { type: "close", code: 1000, reason: "" });
  }
}

const resetFixtures = () => {
  FakeWebSocket.instances = [];
};

const baseConfig = (overrides = {}) => ({
  doubaoStreamAsrUrl: "wss://example.test/api/v3/sauc/bigmodel_async",
  doubaoStreamAsrResourceId: "volc.seedasr.sauc.duration",
  doubaoApiKey: "EXAMPLE_API_KEY_NOT_REAL",
  doubaoStreamAsrChunkBytes: 4,
  doubaoStreamAsrBudgetMs: 2000,
  ...overrides,
});

// ── 1. 帧编码 ────────────────────────────────────────────────────────────────

test("buildFullRequestFrame: header/seq/payload_size 与 gzip(JSON) 一致", () => {
  const payload = buildStreamRequestPayload();
  const frame = buildFullRequestFrame(payload);
  const decoded = decodeClientFrame(frame);

  assert.deepEqual(decoded.header, [0x11, 0x11, 0x11, 0x00]);
  assert.equal(decoded.headerSize, 1);
  assert.equal(decoded.messageType, 1); // full request
  assert.equal(decoded.flags, 1); // POS_SEQUENCE
  assert.equal(decoded.serialization, 1); // JSON
  assert.equal(decoded.compression, 1); // GZIP
  assert.equal(decoded.seq, 1);
  assert.equal(decoded.payloadSize, gzipSync(Buffer.from(JSON.stringify(payload))).length);
  assert.deepEqual(JSON.parse(decoded.payload.toString("utf8")), payload);
  // 协议 JSON 的固定字段（防止后续被顺手改掉）
  assert.equal(payload.audio.format, "pcm");
  assert.equal(payload.audio.rate, 16000);
  assert.equal(payload.audio.bits, 16);
  assert.equal(payload.audio.channel, 1);
  assert.equal(payload.request.model_name, "bigmodel");
  assert.equal(payload.request.result_type, "full");
  assert.equal(payload.user.uid, "xiaomang-agent");
});

test("buildAudioFrame: 普通帧 flags=1，末帧 flags=3 且 seq 取负", () => {
  const chunk = Buffer.from([1, 2, 3, 4]);
  const normal = decodeClientFrame(buildAudioFrame(2, chunk, false));
  assert.deepEqual(normal.header, [0x11, 0x21, 0x11, 0x00]);
  assert.equal(normal.messageType, 2); // audio only
  assert.equal(normal.flags, 1); // POS_SEQUENCE
  assert.equal(normal.seq, 2);
  assert.equal(normal.payloadSize, gzipSync(chunk).length);
  assert.deepEqual(normal.payload, chunk);

  const last = decodeClientFrame(buildAudioFrame(5, chunk, true));
  assert.deepEqual(last.header, [0x11, 0x23, 0x11, 0x00]);
  assert.equal(last.flags, 3); // NEG_WITH_SEQUENCE
  assert.equal(last.seq, -5);
  assert.deepEqual(last.payload, chunk);

  // 末帧允许空 payload（音频正好切完 / 没有音频数据时）
  const lastEmpty = decodeClientFrame(buildAudioFrame(3, Buffer.alloc(0), true));
  assert.equal(lastEmpty.flags, 3);
  assert.equal(lastEmpty.seq, -3);
  assert.equal(lastEmpty.payloadSize, gzipSync(Buffer.alloc(0)).length);
  assert.equal(lastEmpty.payload.length, 0);
});

// ── 2. 服务端帧解析 ──────────────────────────────────────────────────────────

test("parseServerFrame: 解析 full response（带 seq + is_last + gzip JSON）", () => {
  const body = {
    audio_info: { duration: 26800 },
    result: {
      text: "你好世界",
      utterances: [{ text: "你好", start_time: 0, end_time: 600 }],
      additions: { log_id: "log-123" },
    },
  };
  const frameBuffer = buildServerFrame({ msgType: 9, seq: 3, isLast: true, json: body });
  const frame = parseServerFrame(frameBuffer);

  assert.equal(frame.msgType, 9);
  assert.equal(frame.flags, 3);
  assert.equal(frame.seq, 3);
  assert.equal(frame.isLast, true);
  assert.equal(frame.event, null);
  assert.equal(frame.code, null);
  assert.equal(frame.payloadSize, gzipSync(Buffer.from(JSON.stringify(body))).length);
  assert.deepEqual(frame.json, body);
});

test("parseServerFrame: 解析 partial full response（无 is_last）与 event 位", () => {
  const partial = parseServerFrame(buildServerFrame({ msgType: 9, seq: 2, json: { result: { text: "你" } } }));
  assert.equal(partial.isLast, false);
  assert.equal(partial.seq, 2);
  assert.deepEqual(partial.json, { result: { text: "你" } });

  const withEvent = parseServerFrame(buildServerFrame({
    msgType: 9,
    seq: 4,
    isLast: false,
    event: 7,
    json: { result: { text: "" } },
  }));
  assert.equal(withEvent.event, 7);
  assert.equal(withEvent.seq, 4);
});

test("parseServerFrame: 解析 error response（code + gzip JSON）", () => {
  const body = { message: "audio decode failed", log_id: "log-err" };
  const frame = parseServerFrame(buildServerFrame({ msgType: 15, code: 45000081, json: body }));

  assert.equal(frame.msgType, 15);
  assert.equal(frame.code, 45000081);
  assert.equal(frame.isLast, false);
  assert.equal(frame.payloadSize, gzipSync(Buffer.from(JSON.stringify(body))).length);
  assert.deepEqual(frame.json, body);
});

// ── 3. 握手头 ────────────────────────────────────────────────────────────────

test("buildStreamHandshakeHeaders: 优先 X-Api-Key，resource id 默认 seedasr.sauc.duration", () => {
  const headers = buildStreamHandshakeHeaders({ doubaoApiKey: "EXAMPLE_API_KEY_NOT_REAL" });
  assert.equal(headers["X-Api-Key"], "EXAMPLE_API_KEY_NOT_REAL");
  assert.equal(headers["X-Api-Resource-Id"], "volc.seedasr.sauc.duration");
  assert.equal(headers["X-Api-App-Key"], undefined);
  assert.match(headers["X-Api-Request-Id"], /^[0-9a-f-]{36}$/i);
});

test("buildStreamHandshakeHeaders: 无 ApiKey 时回退 AppKey + AccessKey；都没有则抛错", () => {
  const headers = buildStreamHandshakeHeaders({
    doubaoAppKey: "test-app-key",
    doubaoAccessKey: "test-access-key",
  });
  assert.equal(headers["X-Api-Key"], undefined);
  assert.equal(headers["X-Api-App-Key"], "test-app-key");
  assert.equal(headers["X-Api-Access-Key"], "test-access-key");

  assert.throws(
    () => buildStreamHandshakeHeaders({}),
    { code: "DOUBAO_STREAM_CREDENTIALS_MISSING" },
  );
});

// ── 4. 假 WebSocket 全流程 ───────────────────────────────────────────────────

test("recognizeDoubaoStreamAudio: burst 发送全部帧并返回末包文本/utterances/logid/duration", async () => {
  resetFixtures();
  const pcm = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const config = baseConfig();

  const fullResponse = {
    audio_info: { duration: 26800 },
    result: {
      text: "你好世界",
      utterances: [{ text: "你好世界", start_time: 0, end_time: 1200 }],
      additions: { log_id: "log-123" },
    },
  };

  class ReplayWebSocket extends FakeWebSocket {
    constructor(url, options) {
      super(url, options);
      this.onSend = (socket, frames) => {
        // 1 个 full request + 4 个音频帧（16 字节 / 每包 4 字节）
        if (frames.length !== 5) return;
        queueMicrotask(() => {
          socket.emitMessage(buildServerFrame({ msgType: 9, seq: 1, json: { result: { text: "" } } }));
          socket.emitMessage(buildServerFrame({ msgType: 9, seq: 2, json: { result: { text: "你好" } } }));
          socket.emitMessage(buildServerFrame({
            msgType: 9,
            seq: 3,
            isLast: true,
            json: fullResponse,
          }));
        });
      };
    }
  }

  const result = await recognizeDoubaoStreamAudio({ pcm, config, WebSocketImpl: ReplayWebSocket });

  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, config.doubaoStreamAsrUrl);
  assert.equal(socket.options.headers["X-Api-Key"], "EXAMPLE_API_KEY_NOT_REAL");
  assert.equal(socket.options.headers["X-Api-Resource-Id"], "volc.seedasr.sauc.duration");
  assert.match(socket.options.headers["X-Api-Request-Id"], /^[0-9a-f-]{36}$/i);
  assert.equal(socket.closed, true, "所有退出路径都必须 best-effort close");

  assert.equal(socket.sentFrames.length, 5);
  const fullFrame = decodeClientFrame(socket.sentFrames[0]);
  assert.equal(fullFrame.messageType, 1);
  assert.equal(fullFrame.seq, 1);
  assert.deepEqual(JSON.parse(fullFrame.payload.toString("utf8")), buildStreamRequestPayload());

  const audioFrames = socket.sentFrames.slice(1).map(decodeClientFrame);
  assert.equal(audioFrames.length, 4);
  for (let index = 0; index < audioFrames.length; index += 1) {
    const isLast = index === audioFrames.length - 1;
    assert.equal(audioFrames[index].messageType, 2);
    assert.equal(audioFrames[index].seq, isLast ? -(index + 2) : index + 2);
    assert.deepEqual(audioFrames[index].payload, pcm.subarray(index * 4, index * 4 + 4));
    assert.equal(audioFrames[index].flags, isLast ? 3 : 1);
  }
  // 最后一帧：flags=3、seq 为负（-5），且确实由 buildAudioFrame 直接发出
  assert.equal(audioFrames[3].flags, 3);
  assert.equal(audioFrames[3].seq, -5);
  assert.equal(isLastAudioFrame(socket.sentFrames[4]), true);

  assert.equal(result.text, "你好世界");
  assert.deepEqual(result.utterances, fullResponse.result.utterances);
  assert.equal(result.logid, "log-123");
  assert.equal(result.duration, 26800);
  assert.equal(result.provider, "doubao-stream-asr");
  assert.equal(result.bytes, pcm.length);
});

test("recognizeDoubaoStreamAudio: 每 20 个音频包让出一次事件循环（burst 不饿死实例）", async () => {
  resetFixtures();
  // 25 个音频包（chunkBytes=1，pcm 25 字节）：至少有一次 setImmediate 让出。
  const pcm = Buffer.alloc(25, 7);
  class CollectWebSocket extends FakeWebSocket {
    constructor(url, options) {
      super(url, options);
      this.onSend = (socket, frames) => {
        if (frames.length === 26) {
          queueMicrotask(() => socket.emitMessage(buildServerFrame({
            msgType: 9,
            seq: 3,
            isLast: true,
            json: { result: { text: "ok" }, audio_info: { duration: 1000 } },
          })));
        }
      };
    }
  }
  const result = await recognizeDoubaoStreamAudio({
    pcm,
    config: baseConfig({ doubaoStreamAsrChunkBytes: 1 }),
    WebSocketImpl: CollectWebSocket,
  });
  assert.equal(result.text, "ok");
  assert.equal(FakeWebSocket.instances[0].sentFrames.length, 26); // 1 full + 25 audio
});

// ── 5. 异常路径 ──────────────────────────────────────────────────────────────

test("recognizeDoubaoStreamAudio: 缺凭据抛 DOUBAO_STREAM_CREDENTIALS_MISSING，且不构造连接", async () => {
  resetFixtures();
  let constructed = 0;
  class NoopWebSocket extends FakeWebSocket {
    constructor(...args) {
      constructed += 1;
      super(...args);
    }
  }
  await assert.rejects(
    recognizeDoubaoStreamAudio({
      pcm: Buffer.alloc(4),
      config: { doubaoStreamAsrUrl: "wss://example.test/asr" },
      WebSocketImpl: NoopWebSocket,
    }),
    { code: "DOUBAO_STREAM_CREDENTIALS_MISSING" },
  );
  assert.equal(constructed, 0);
  assert.equal(FakeWebSocket.instances.length, 0);
});

test("recognizeDoubaoStreamAudio: 总预算超时抛 DOUBAO_STREAM_ASR_TIMEOUT 并 close", async () => {
  resetFixtures();
  class SilentWebSocket extends FakeWebSocket {}
  await assert.rejects(
    recognizeDoubaoStreamAudio({
      pcm: Buffer.alloc(8),
      config: baseConfig({ doubaoStreamAsrBudgetMs: 40 }),
      WebSocketImpl: SilentWebSocket,
    }),
    { code: "DOUBAO_STREAM_ASR_TIMEOUT" },
  );
  assert.equal(FakeWebSocket.instances[0].closed, true);
});

test("recognizeDoubaoStreamAudio: 服务端 error 帧抛 DOUBAO_STREAM_ASR_FAILED（带 code/message/logid）", async () => {
  resetFixtures();
  class ErrorReplyWebSocket extends FakeWebSocket {
    constructor(url, options) {
      super(url, options);
      this.onSend = (socket, frames) => {
        if (frames.length !== 2) return; // 1 full + 1 audio
        queueMicrotask(() => socket.emitMessage(buildServerFrame({
          msgType: 15,
          code: 45000081,
          json: { message: "audio decode failed", log_id: "log-err" },
        })));
      };
    }
  }
  await assert.rejects(
    recognizeDoubaoStreamAudio({
      pcm: Buffer.alloc(4),
      config: baseConfig(),
      WebSocketImpl: ErrorReplyWebSocket,
    }),
    (error) => {
      assert.equal(error.code, "DOUBAO_STREAM_ASR_FAILED");
      assert.equal(error.details.code, 45000081);
      assert.equal(error.details.message, "audio decode failed");
      assert.equal(error.details.logid, "log-err");
      assert.match(error.message, /audio decode failed/);
      return true;
    },
  );
  assert.equal(FakeWebSocket.instances[0].closed, true);
});

test("recognizeDoubaoStreamAudio: 末包文本为空抛 DOUBAO_STREAM_ASR_EMPTY", async () => {
  resetFixtures();
  class EmptyReplyWebSocket extends FakeWebSocket {
    constructor(url, options) {
      super(url, options);
      this.onSend = (socket, frames) => {
        if (frames.length !== 2) return;
        queueMicrotask(() => socket.emitMessage(buildServerFrame({
          msgType: 9,
          seq: 2,
          isLast: true,
          json: { result: { text: "" }, audio_info: { duration: 900 } },
        })));
      };
    }
  }
  await assert.rejects(
    recognizeDoubaoStreamAudio({
      pcm: Buffer.alloc(4),
      config: baseConfig(),
      WebSocketImpl: EmptyReplyWebSocket,
    }),
    { code: "DOUBAO_STREAM_ASR_EMPTY" },
  );
  assert.equal(FakeWebSocket.instances[0].closed, true);
});

test("recognizeDoubaoStreamAudio: 末包与 close 同一 tick 到达时按成功处理（不得被 close 抢先判死）", async () => {
  resetFixtures();
  class FinalThenCloseWebSocket extends FakeWebSocket {
    constructor(url, options) {
      super(url, options);
      this.onSend = (socket, frames) => {
        if (frames.length !== 2) return;
        // 关键顺序：先同步派发末包，紧接着同步派发 close（模拟服务端发完就断开）。
        socket.emitMessage(buildServerFrame({
          msgType: 9,
          seq: 2,
          isLast: true,
          json: { result: { text: "完成", additions: { log_id: "log-close" } }, audio_info: { duration: 800 } },
        }));
        socket.readyState = 3;
        socket.emit("close", { type: "close", code: 1000, reason: "" });
      };
    }
  }
  const result = await recognizeDoubaoStreamAudio({
    pcm: Buffer.alloc(4),
    config: baseConfig(),
    WebSocketImpl: FinalThenCloseWebSocket,
  });
  assert.equal(result.text, "完成");
  assert.equal(result.logid, "log-close");
  assert.equal(result.duration, 800);
});

test("recognizeDoubaoStreamAudio: 未拿到末包就 close / error 事件抛 DOUBAO_STREAM_ASR_FAILED", async () => {
  resetFixtures();
  class CloseEarlyWebSocket extends FakeWebSocket {
    constructor(url, options) {
      super(url, options);
      this.onSend = (socket, frames) => {
        if (frames.length !== 2) return;
        queueMicrotask(() => {
          socket.readyState = 3;
          socket.emit("close", { type: "close", code: 1006, reason: "abnormal" });
        });
      };
    }
  }
  await assert.rejects(
    recognizeDoubaoStreamAudio({
      pcm: Buffer.alloc(4),
      config: baseConfig(),
      WebSocketImpl: CloseEarlyWebSocket,
    }),
    (error) => {
      assert.equal(error.code, "DOUBAO_STREAM_ASR_FAILED");
      assert.equal(error.details.closeCode, 1006);
      return true;
    },
  );

  resetFixtures();
  class ErrorEventWebSocket extends FakeWebSocket {
    constructor(url, options) {
      super(url, options);
      this.onSend = (socket, frames) => {
        if (frames.length !== 2) return;
        queueMicrotask(() => socket.emit("error", { type: "error", error: new Error("socket boom") }));
      };
    }
  }
  await assert.rejects(
    recognizeDoubaoStreamAudio({
      pcm: Buffer.alloc(4),
      config: baseConfig(),
      WebSocketImpl: ErrorEventWebSocket,
    }),
    (error) => {
      assert.equal(error.code, "DOUBAO_STREAM_ASR_FAILED");
      assert.match(error.message, /socket boom/);
      return true;
    },
  );
});
