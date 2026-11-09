import { readFileSync } from "node:fs";

/**
 * 需要真实 MongoDB 的 store 测试共用的小工具。
 *
 * 为什么要有这个文件（两个理由，都是实测踩出来的）：
 *
 *   1. **`.env` 不会被 `npm test` 自动加载**（`node --test` 不带 `--env-file`），
 *      而 `MONGODB_URI` 在 `.env` 里。这里做一次极简解析，**不引外部依赖**
 *      （项目的 `tests/` 目前没有任何第三方依赖，别为了这个破例）。
 *   2. **开发机经常在代理/VPN 后面，MongoDB 的 TLS 握手会被重置**
 *      （DNS 解析到 `198.18.x.x` 保留网段）。每个 store 测试各自 `serverSelectionTimeoutMS: 8000`
 *      的话，`npm test` 会白白多等十几秒。所以进程内**缓存一次失败**，
 *      后续测试直接跳过，不再重复等超时。
 *
 * ⚠️ 连不上时**必须干净跳过**而不是抛出去：环境问题不该让 `npm test` 变红。
 */

const loadEnvFile = () => {
  if (String(process.env.MONGODB_URI || "").trim()) return;
  try {
    // ⚠️ 这个文件在 `tests/helpers/`，所以是**上两级**才是项目根的 `.env`。
    //    写成 `../.env` 会指向 `tests/.env`（不存在），于是 `mongoUri` 恒为空、
    //    所有 store 测试**静默跳过** —— 看起来像「环境没配」，其实是路径写错了。
    const text = readFileSync(new URL("../../.env", import.meta.url), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      if (String(process.env[match[1]] ?? "").trim()) continue;
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* 没有 .env 就走跳过逻辑 */ }
};
loadEnvFile();

export const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || "").trim();

/** 进程内缓存：连不上过一次就不再重试（省掉每个测试文件 8 秒的等待）。 */
let cachedFailure = "";

export const mongoSkipReason = mongoUri
  ? () => cachedFailure || false
  : () => "缺少 MONGODB_URI，跳过需要数据库的 store 测试";

/**
 * 连一个**临时库**（每个测试文件一个，跑完 dropDatabase）。
 *
 * @param tempDbName 临时库名（各文件自己拼 pid + 时间戳，避免并发互删）
 * @returns { db, client, skipReason } —— 连不上时 `db` 为 null，`skipReason` 有可读原因
 */
export const connectTempDb = async (tempDbName) => {
  if (!mongoUri) return { db: null, client: null, skipReason: "缺少 MONGODB_URI，跳过需要数据库的 store 测试" };
  if (cachedFailure) return { db: null, client: null, skipReason: `MongoDB 连不上，跳过（${cachedFailure}）` };

  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 6_000 });
  try {
    await client.connect();
    await client.db(tempDbName).command({ ping: 1 });
  } catch (error) {
    cachedFailure = `${error?.constructor?.name || "Error"}: ${String(error?.message || error).slice(0, 120)}`;
    await client.close().catch(() => {});
    return { db: null, client: null, skipReason: `MongoDB 连不上，跳过（${cachedFailure}）` };
  }
  // store 的 `getDb()` 懒读这个环境变量，指向临时库。
  process.env.MONGODB_DB_NAME = tempDbName;
  return { db: client.db(tempDbName), client, skipReason: "" };
};
