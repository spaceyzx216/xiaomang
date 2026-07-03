/**
 * 从上游微信视频号解密源码生成 vendored 模块。
 *
 * 上游：aynakeya/WeChatVideoDownloader 的 electron/decrypt.js
 *      —— 微信官方 wasm_video_decode.wasm 经 wasm2js 忠实转译的纯 JS 版本，
 *         内嵌 wasm 字节码（base64），可在 Node.js / 浏览器 / Worker 中加载。
 *
 * 本脚本对上游源码做两处确定性改写，使其作为 ES module 在 Node.js 中可用：
 *   1. 把 "var Module = typeof Module !== 'undefined' ? Module : {};" 替换为
 *      预定义的 Module 工厂对象（含 onRuntimeInitialized 回调 + readyPromise）。
 *      否则 ESM 顶层作用域里 Module 为 {}，runtime 初始化 hook 丢失。
 *   2. 在末尾导出 readyPromise 与 generateKeystream(decodeKey)。
 *
 * 用法：
 *   node scripts/build-wechat-vendor.mjs <上游 decrypt.js 路径>
 *   不传路径则从 https://cdn.jsdelivr.net/gh/aynakeya/WeChatVideoDownloader@master/electron/decrypt.js 下载。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(PROJECT_ROOT, "api/_lib/contentAgent/vendor/wechatKeystream.mjs");

// 注入到源码开头、替换默认 Module 定义的工厂配置。
// wasm2js 模块顶层执行 run()，会异步初始化，完成后触发 onRuntimeInitialized。
const MODULE_FACTORY = `var __resolveWasmReady, __wasmReadyPromise = new Promise(function (resolve) { __resolveWasmReady = resolve; });
var Module = {
  onRuntimeInitialized: function () {
    try { __resolveWasmReady(Module); } catch (e) { console.error('[wechatKeystream] onRuntimeInitialized error', e); }
  },
  print: function () {},
  printErr: function () {},
};`;

const MODULE_DECL_TO_REPLACE = "var Module = typeof Module !== 'undefined' ? Module : {};";

const TAIL_EXPORTS = `
// === vendored 导出（由 scripts/build-wechat-vendor.mjs 注入）===
// wasm 实例化是否完成；generateKeystream 会先 await 它。
export const readyPromise = __wasmReadyPromise;

/**
 * 用 decodeKey 生成视频号解密所需的 131072 字节 Isaac64 密钥流。
 * @param {string|number} decodeKey 视频号 media.decode_key（数字串）
 * @returns {Promise<Uint8Array>} 长度恒为 131072 的密钥流
 *
 * 实现说明（来自 aynakeya 的逆向 + 官方 wasm 行为）：
 *   - seed = decodeKey 经 stoull 转 uint64
 *   - new Module.WxIsaac64(seed).generate(131072) 把密钥流写入 wasm heap
 *   - wasm_isaac_generate 钩子把堆上的密钥流 reverse() 后存入 decryptor_array
 */
export async function generateKeystream(decodeKey) {
  await __wasmReadyPromise;
  if (typeof Module.WxIsaac64 !== 'function') {
    throw new Error('wechatKeystream: Module.WxIsaac64 not available after init');
  }
  if (typeof get_decryptor_array !== 'function') {
    throw new Error('wechatKeystream: get_decryptor_array not found (vendored module structure changed)');
  }
  // get_decryptor_array 是上游末尾定义的函数，读全局 decryptor_array（reverse 后的密钥流）
  const stream = get_decryptor_array(String(decodeKey));
  if (!stream || stream.length !== 131072) {
    throw new Error('wechatKeystream: keystream length unexpected: ' + (stream && stream.length));
  }
  return stream;
}
`;

function fail(msg) {
  console.error("build-wechat-vendor:", msg);
  process.exit(1);
}

async function fetchUpstream() {
  const url = "https://cdn.jsdelivr.net/gh/aynakeya/WeChatVideoDownloader@master/electron/decrypt.js";
  console.log("build-wechat-vendor: 下载上游源码:", url);
  const res = await fetch(url);
  if (!res.ok) fail(`下载失败 HTTP ${res.status}`);
  const text = await res.text();
  console.log(`build-wechat-vendor: 下载完成，${text.length} 字节`);
  return text;
}

function patch(src) {
  const count = src.split(MODULE_DECL_TO_REPLACE).length - 1;
  if (count !== 1) {
    fail(
      `预期的 Module 声明出现 ${count} 次（应为 1 次）。上游结构可能已变化，请人工核对。` +
      ` 确认目标字符串: ${MODULE_DECL_TO_REPLACE}`
    );
  }
  let out = src.replace(MODULE_DECL_TO_REPLACE, MODULE_FACTORY);

  // 校验上游关键符号仍在，否则导出会失效
  for (const marker of ["get_decryptor_array", "function wasm_isaac_generate", "decryptor_array"]) {
    if (!out.includes(marker)) {
      fail(`上游源码缺少关键标记 "${marker}"，无法安全 patch。请人工核对。`);
    }
  }

  if (!out.endsWith("\n")) out += "\n";
  out += TAIL_EXPORTS;
  return out;
}

async function main() {
  const argPath = process.argv[2];
  let src;
  if (argPath) {
    console.log("build-wechat-vendor: 读取本地源码:", argPath);
    src = fs.readFileSync(argPath, "utf8");
  } else {
    src = await fetchUpstream();
  }

  const patched = patch(src);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, patched);
  console.log(`build-wechat-vendor: 已写入 ${path.relative(PROJECT_ROOT, OUTPUT_PATH)} (${patched.length} 字节)`);
  console.log("build-wechat-vendor: 完成。");
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
