/**
 * 出图网关自检 —— 用来回答「403 到底是哪种原因」。
 *
 * 背景：2026-09-24 出图返回 403（`IMAGE_HTTP_ERROR`）。这类网关（xxcapi / 星辰）在
 * 403 时通常回一句原因（余额不足 / 没有该模型的权限 / 该端点未开通），
 * 但当时上游原话没进日志，只能靠猜。这个脚本就是把原话打出来。
 *
 * 用法（在 apps/server 目录下）：
 *   node scripts/probe-image-gateway.mjs              # 免费：只列可用模型 + 探端点
 *   node scripts/probe-image-gateway.mjs --generate   # 会真的调一次出图（花钱）
 *
 * 建议先不带 `--generate` 跑一次：如果配的模型根本不在「可用模型」列表里，
 * 那 403 的原因就是「这个密钥没有该模型的权限」，不用花钱试。
 *
 * 只打印，不写任何数据；密钥只显示前后几位。
 */
import "dotenv/config";
import { getImageConfig, isImageGenerationConfigured } from "../api/_lib/contentAgent/imageProvider.js";

const wantsGenerate = process.argv.includes("--generate");

const mask = value => {
  const text = String(value || "");
  if (!text) return "(空)";
  return text.length <= 10 ? `${text.slice(0, 3)}…` : `${text.slice(0, 6)}…${text.slice(-4)}（长度 ${text.length}）`;
};

const raw = async (label, url, init) => {
  console.log(`\n── ${label} ─────────────────────────────────────────`);
  console.log(`   ${init?.method || "GET"} ${url}`);
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    console.log(`   → HTTP ${res.status}`);
    console.log(`   返回：${text.replace(/\s+/g, " ").slice(0, 700) || "(空)"}`);
    return { status: res.status, text };
  } catch (error) {
    console.log(`   → 请求失败：${error.message} | cause=${error.cause?.code || error.cause?.message || "-"}`);
    return { status: 0, text: "" };
  }
};

const config = getImageConfig();
console.log("=== 出图配置 ===");
console.log("  baseUrl :", config.baseUrl);
console.log("  model   :", config.model);
console.log("  密钥    :", mask(config.apiKey));
console.log("  是否已配置:", isImageGenerationConfigured());

if (!isImageGenerationConfigured()) {
  console.log("\n未配置出图密钥，先补 XXCAPI_API_KEY 或 XINGCHEN_API_KEY 再跑。");
  process.exit(0);
}

const base = String(config.baseUrl || "").replace(/\/$/, "");
const headers = { Authorization: `Bearer ${config.apiKey}` };

// ① 列可用模型（免费）。这一条最能回答「密钥有没有这个模型的权限」。
await raw("① 可用模型列表（免费，最能说明权限问题）", `${base}/v1/models`, { headers });

// ② 端点在不在（免费：故意用空 body，看是 400 还是 403/404）
await raw("② generations 端点是否存在（免费，故意发空 body）", `${base}/v1/images/generations`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
await raw("③ edits 端点是否存在（免费，故意发空 body）", `${base}/v1/images/edits`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({}),
});

console.log(`\n${"─".repeat(56)}`);
if (!wantsGenerate) {
  console.log("④ 真要出图才知道质量 —— 加 --generate 才会跑（会花钱）：");
  console.log("   node scripts/probe-image-gateway.mjs --generate");
  process.exit(0);
}

// ④ 真的调一次出图（花钱）。用最小的图，把上游原话带回来。
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const { generateImage, editImage } = await import("../api/_lib/contentAgent/imageProvider.js");

for (const [label, run] of [
  ["⑤ 文生图（花钱）", () => generateImage("一个纯色方块", { config: undefined })],
  ["⑥ 图片编辑（花钱，就是一类走的那条路）", () => editImage("把标题换成：测试", [{ dataUrl: `data:image/png;base64,${tinyPng}` }], { config: undefined })],
]) {
  console.log(`\n── ${label} ─────────────────────────────`);
  try {
    const result = await run();
    console.log(`   成功：${result.images?.length || 0} 张，model=${result.model}，${result.elapsedMs}ms`);
  } catch (error) {
    console.log(`   失败：${error.message}`);
    console.log(`   code=${error.code} status=${error.status}`);
    if (error.details?.body) console.log(`   上游原话：${String(error.details.body).slice(0, 500)}`);
  }
}
