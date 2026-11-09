#!/usr/bin/env node
// 把 .migration/<stamp>/ 形式的历史备份（.ejsonl + manifest.ejson）导回当前数据库。
//
// 为什么需要它：apps/server/scripts/migrate-local-mongo.mjs 是**单向**的
// （本地源 → 本地目标），而且硬性拒绝非 localhost 的目标库。服务器上要把历史备份
// 导回来时，没有现成工具 —— 这个脚本补上这一环，解析格式与那个脚本的导出格式一一对应
// （BSON.EJSON.stringify(doc, { relaxed: false }) 每行一条）。
//
// 用法（在 app 容器内、工作目录 /app 下执行，这样能解析到 node_modules）：
//   node apps/server/scripts/import-migration-dump.mjs <dumpDir>
//   目标库由环境变量 MONGODB_URI / MONGODB_DB_NAME 决定。
//
// 安全边界：**只往空集合里写**。已有数据的集合一律跳过并打印原因，
// 绝不清空、绝不覆盖 —— 与 restore.sh「不 --drop 覆盖线上库」的取舍保持一致。

import fs from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, BSON } from 'mongodb';

const dir = process.argv[2];
if (!dir) {
  console.error('用法: node import-migration-dump.mjs <dumpDir>');
  process.exit(2);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('缺少 MONGODB_URI 环境变量');
  process.exit(2);
}
const dbName = process.env.MONGODB_DB_NAME || 'xiaomang';

const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.ejson'), 'utf8'));
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(dbName);

console.log(`导入 ${manifest.sourceDatabase} → ${dbName}（备份时间 ${manifest.createdAt}）`);

let written = 0;
let skipped = 0;
const mismatches = [];

// manifest.ejson 是**规范** EJSON：索引键被写成 {"$numberInt":"1"} 这类包装，
// 而 createIndex 只接受普通数字/字符串。所以键要先按 EJSON 解析回来再传。
const decodeKey = rawKey => BSON.EJSON.parse(JSON.stringify(rawKey), { relaxed: true });

for (const collection of manifest.collections) {
  const target = db.collection(collection.name);
  const existing = await target.estimatedDocumentCount();
  let imported = 0;

  if (existing > 0) {
    console.log(`  跳过 ${collection.name}：集合已有 ${existing} 条，不覆盖`);
    skipped++;
  } else {
    const raw = await fs.readFile(path.join(dir, collection.file), 'utf8');
    const documents = raw
      .split('\n')
      .filter(line => line.trim())
      .map(line => BSON.EJSON.parse(line, { relaxed: false }));

    if (documents.length) await target.insertMany(documents, { ordered: true });
    imported = documents.length;
    written += documents.length;
    console.log(`  导入 ${collection.name}：${imported} 条`);
  }

  // 索引无论集合是否刚导入都要补齐 —— createIndex 幂等，且几个 unique 索引
  // （users.email / customers.name / employees.account）是真约束，漏了会放进重复数据。
  for (const index of collection.indexes || []) {
    if (index.name === '_id_') continue;
    const { v, key, name, ns, ...rest } = index;
    try {
      await target.createIndex(decodeKey(key), { ...rest, name });
    } catch (error) {
      console.log(`    索引 ${collection.name}.${name} 未建立：${error.message}`);
    }
  }

  const declared = Number(collection.count?.$numberInt ?? collection.count);
  if (imported !== declared && existing === 0) {
    mismatches.push(`${collection.name}: 导入 ${imported} / 备份声明 ${declared}`);
  }
}

console.log(`完成：写入 ${written} 条，跳过 ${skipped} 个非空集合。`);
if (mismatches.length) {
  console.error('数量与备份声明不一致：');
  for (const line of mismatches) console.error(`  ${line}`);
  await client.close();
  process.exit(1);
}

await client.close();
