#!/usr/bin/env node
// 种一条新的「经理」邀请码，用于开通注册。
//
// 为什么需要它：`POST /api/auth/register` 强制要求邀请码（`registerManager` →
// `consumeInviteCode`），而库里只存 bcrypt 哈希，**明文不可反推**（见 HANDOFF：
// 「邀请码在库里是哈希、读不出明文」）。因此全新部署、invitecodes 集合为空时，
// 没有任何人能注册 —— 必须由运维侧种一条已知明文的邀请码。
//
// 用法（在 app 容器内、工作目录 /app 下执行）：
//   node apps/server/scripts/seed-invite-code.mjs <明文邀请码> [maxUses] [note]
//   目标库由环境变量 MONGODB_URI / MONGODB_DB_NAME 决定。
//
// 文档形状照抄 apps/server/scripts/verify-server-routes.mjs 里的冒烟种子，
// 保证与 consumeInviteCode 的查询条件（type/status）一致。

import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';

const [code, maxUses = '1', note = 'deploy-seed'] = process.argv.slice(2);
if (!code) {
  console.error('用法: node seed-invite-code.mjs <明文邀请码> [maxUses] [note]');
  process.exit(2);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('缺少 MONGODB_URI 环境变量');
  process.exit(2);
}
const dbName = process.env.MONGODB_DB_NAME || 'xiaomang';

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
await client.connect();
const db = client.db(dbName);

const { insertedId } = await db.collection('invitecodes').insertOne({
  type: 'manager',
  status: 'active',
  codeHash: await bcrypt.hash(code, 10),
  maxUses: Number(maxUses),
  usedCount: 0,
  note,
  createdAt: new Date(),
});

console.log(`已种邀请码：${code}（maxUses=${maxUses}，id=${insertedId}）`);
await client.close();
