import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { connectTempDb, mongoUri } from "./helpers/mongo-temp-db.mjs";
import {
  closeMongoClient,
  getLatestAccountPlanReportForCustomer,
  listAccountPlanReports,
  listAccountPlanReportsForCustomer,
  saveAccountPlanReport,
} from "../api/_lib/accountPlanStore.js";

/**
 * 1.3 账号规划报告「按客户读」的契约测试（2026-09-21 用户拍板开放 3.3 的权限）。
 *
 * 这里钉的是**权限边界**（不是 UI）：
 *   - 员工侧按客户读得到（发布仓 3.3 三个角度靠它）；
 *   - 但**必须带 customerId**，不带就 400，绝不退化成「列出全部」；
 *   - 只回**该客户**的，不回别人客户的；
 *   - 元数据里**不含 managerId**（属主身份不外泄）。
 *
 * ⚠️ 需要真实 MongoDB，全程只用**临时库**，跑完 dropDatabase。
 *    `MONGODB_URI` 缺失或连不上时**整组干净跳过**，不会把 `npm test` 弄红
 *    （开发机常在代理/VPN 后面，MongoDB 的 TLS 握手会被重置）。
 */

const TEMP_DB = `xmplanverify_${process.pid.toString(36)}${Date.now().toString(36)}`;

/** 没有 MONGODB_URI 时整组跳过；连不上则由 `setup()` 填 `skipReason` 再跳过。 */
const skip = mongoUri ? false : "缺少 MONGODB_URI，跳过需要数据库的 store 测试";

let db = null;
let client = null;
/** 连不上库时的原因（网络/TLS 不通）。非空则整组干净跳过。 */
let skipReason = "";

const setup = async () => {
  if (db) return;
  const result = await connectTempDb(TEMP_DB);
  db = result.db;
  client = result.client;
  skipReason = result.skipReason;
};

const OWNER_A = "661111111111111111111111";
const OWNER_B = "662222222222222222222222";
const CUSTOMER_A = "663333333333333333333333";
const CUSTOMER_B = "664444444444444444444444";


/** 一份**真实形状**的 1.3 报告（顶层就是各节正文；`sections` 只是键名数组）。 */
const makePlan = (customerId, customerName, marker) => ({
  version: "1.0",
  reportType: "account_plan",
  batch: 2,
  sections: ["ipPositioning", "accountSetup", "topicLibrary", "contentFramework", "production", "operations"],
  customer: { id: customerId, name: customerName, occupation: "劳动法律师", ipPositioning: marker },
  ipPositioning: {
    businessPositioning: { targetAudience: { text: "中小企业主" }, corePain: { text: marker } },
    contentPositioning: { core: { text: "政策解读与环境洞察" }, frequentTags: ["劳动法"] },
    personaPositioning: { role: { text: "严谨专业的劳动法律师" } },
  },
  topicLibrary: { topicTotal: 12 },
});

test("1.3 账号规划「按客户读」", { skip }, async t => {
  await setup();
  if (!db) {
    t.skip(skipReason);
    return;
  }
  t.after(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (client) await client.close().catch(() => {});
    // ★ 必须关掉 store 自己缓存的那条连接，否则 node --test 会因为 keep-alive
    //   永远不退出（挂住不动、不报错）。
    await closeMongoClient();
  });

  await t.test("（前置）两个项目经理各为一个客户存报告", async () => {
    const a = await saveAccountPlanReport({ ownerId: OWNER_A, report: makePlan(CUSTOMER_A, "客户甲", "甲客户的痛点") });
    assert.ok(a?.id, "A 的报告存进去了");
    await saveAccountPlanReport({ ownerId: OWNER_B, report: makePlan(CUSTOMER_B, "客户乙", "乙客户的痛点") });
  });

  await t.test("按客户列出：只回该客户的，不带正文、不带 managerId", async () => {
    const items = await listAccountPlanReportsForCustomer({ customerId: CUSTOMER_A });
    assert.equal(items.length, 1, "只回客户甲的那一份");
    assert.equal(items[0].customerId, CUSTOMER_A);
    // ★ 属主身份不外泄：员工不需要知道报告是谁的。
    assert.equal("managerId" in items[0], false, "元数据不含 managerId");
    assert.equal("report" in items[0], false, "列表不带报告正文（与其它 store 同一契约）");
  });

  await t.test("★ 跨客户隔离：查客户乙拿不到客户甲的", async () => {
    const items = await listAccountPlanReportsForCustomer({ customerId: CUSTOMER_B });
    assert.equal(items.length, 1);
    assert.equal(items[0].customerId, CUSTOMER_B);
    const wrong = await listAccountPlanReportsForCustomer({ customerId: "665555555555555555555555" });
    assert.deepEqual(wrong, [], "不存在的客户回空数组，不是全部");
  });

  await t.test("按客户取最新一份正文：正文完整回来（3.3 三个角度的主来源）", async () => {
    const latest = await getLatestAccountPlanReportForCustomer({ customerId: CUSTOMER_A });
    assert.ok(latest, "取到了");
    assert.equal(latest.customerId, CUSTOMER_A);
    assert.equal(latest.report?.ipPositioning?.contentPositioning?.core?.text, "政策解读与环境洞察");
    assert.equal(latest.report?.ipPositioning?.businessPositioning?.corePain?.text, "甲客户的痛点");
  });

  await t.test("★ 不按 managerId 过滤：另一项目经理为同一客户存的报告也读得到", async () => {
    // 这是刻意的：员工不是报告属主，他要的是「这个客户的账号定位」，
    // 谁存的都一样有用。不能因为换了项目经理就突然读不到。
    await saveAccountPlanReport({ ownerId: OWNER_B, report: makePlan(CUSTOMER_A, "客户甲", "B 为甲客户补的痛点") });
    const items = await listAccountPlanReportsForCustomer({ customerId: CUSTOMER_A });
    assert.equal(items.length, 2, "两个项目经理为同一客户存的都读得到");
    const latest = await getLatestAccountPlanReportForCustomer({ customerId: CUSTOMER_A });
    assert.equal(latest.report?.ipPositioning?.businessPositioning?.corePain?.text, "B 为甲客户补的痛点",
      "「最新一份」按 createdAt 倒序取");
  });

  await t.test("★★ 不带 customerId 必须 400 —— 绝不退化成「列出全部」", async () => {
    await assert.rejects(
      () => listAccountPlanReportsForCustomer({ customerId: "" }),
      error => error.status === 400,
    );
    await assert.rejects(
      () => getLatestAccountPlanReportForCustomer({ customerId: "   " }),
      error => error.status === 400,
    );
    await assert.rejects(
      () => listAccountPlanReportsForCustomer({}),
      error => error.status === 400,
    );
  });

  await t.test("没有报告的客户回 null / 空数组（不是抛错）", async () => {
    assert.equal(await getLatestAccountPlanReportForCustomer({ customerId: "666666666666666666666666" }), null);
    assert.deepEqual(await listAccountPlanReportsForCustomer({ customerId: "666666666666666666666666" }), []);
  });

  await t.test("项目经理自己的列表仍按 managerId 收口（没被这次放开弄坏）", async () => {
    const listA = await listAccountPlanReports({ ownerId: OWNER_A });
    assert.equal(listA.length, 1, "A 只看到自己存的那一份");
    assert.equal(listA[0].customerId, CUSTOMER_A);
    const listB = await listAccountPlanReports({ ownerId: OWNER_B });
    assert.equal(listB.length, 2, "B 看到自己存的两份");
  });
});
