import test from "node:test";
import assert from "node:assert/strict";

import { connectTempDb, mongoUri } from "./helpers/mongo-temp-db.mjs";
import {
  closeMongoClient,
  deleteVideoAnalysisReport,
  getVideoAnalysisReport,
  getVideoAnalysisReportForCustomer,
  listVideoAnalysisReports,
  listVideoAnalysisReportsForCustomer,
  saveVideoAnalysisReport,
} from "../api/_lib/videoAnalysisStore.js";
import { buildVideoAnalysisReport } from "../api/_lib/videoAnalysis.js";

/**
 * 4.1 单条视频分析报告的存储契约。
 *
 * 这里钉的是**权限边界**（不是 UI）：
 *   · 经理读自己的（按 managerId 收口）；
 *   · 员工**按客户**读（4.1 对员工开放，用户 2026-09-30 拍板），
 *     但**必须带 customerId**，不带 400，绝不退化成「列出全部」；
 *   · 只回该客户的，不回别人客户的；
 *   · 元数据里**不含 managerId**（属主身份不外泄）、**不含正文**；
 *   · 重复保存幂等（挡住双击与刷新重提）。
 *
 * ⚠️ 需要真实 MongoDB，全程只用**临时库**，跑完 dropDatabase。
 *    `MONGODB_URI` 缺失或连不上时**整组干净跳过**，不会把 `npm test` 弄红。
 */

const TEMP_DB = `xmreviewverify_${process.pid.toString(36)}${Date.now().toString(36)}`;
const skip = mongoUri ? false : "缺少 MONGODB_URI，跳过需要数据库的 store 测试";

let db = null;
let client = null;
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

/** 一份**真实形状**的 4.1 报告（走真实组装，不用手写桩）。 */
const makeReport = (marker, platform = "douyin") => buildVideoAnalysisReport({
  platform,
  rawMetrics: { plays: 12500, likes: 830, comments: 96, shares: 210, bookmarks: 340, completionRate: 0.32, bounce2sRate: 0.18, completion5sRate: 0.55, avgPlaySeconds: 42.5, durationSeconds: 118 },
  scriptText: `员工主动离职能不能要赔偿？${marker}`,
  structureTags: { categoryName: "风险防御与合规建设", subcategoryName: "入职合规与制度完善", goldThreeSecondsType: "fear", titleType: "fear", endingHookType: "interaction" },
  video: { title: `测试视频 ${marker}`, link: "https://v.douyin.com/abc" },
});

test("4.1 报告：保存 → 列表 → 按 id 取 → 删除，且重复保存幂等", { skip }, async t => {
  await setup();
  if (!db) return t.skip(skipReason);
  t.after(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (client) await client.close().catch(() => {});
    await closeMongoClient();
  });

  const report = makeReport("A");
  const saved = await saveVideoAnalysisReport({ ownerId: OWNER_A, customerId: CUSTOMER_A, customerName: "夏律师", report });
  assert.ok(saved.id, "保存应返回 id");
  assert.equal(saved.customerId, CUSTOMER_A);
  assert.equal(saved.videoTitle, "测试视频 A");
  assert.equal(saved.plays, 12500);
  assert.equal(saved.optimizeCount, 0);
  assert.equal(saved.analysisSource, "heuristic");

  // 幂等：同一份报告再存一次，返回同一个 id（不是新记录）
  const again = await saveVideoAnalysisReport({ ownerId: OWNER_A, customerId: CUSTOMER_A, customerName: "夏律师", report });
  assert.equal(again.id, saved.id, "重复保存必须幂等");

  // 列表只给元数据
  const list = await listVideoAnalysisReports({ ownerId: OWNER_A });
  assert.equal(list.length, 1);
  assert.equal("report" in list[0], false, "列表不带正文");
  assert.equal("managerId" in list[0], false, "元数据不含 managerId");

  // 按 id 取正文
  const full = await getVideoAnalysisReport({ ownerId: OWNER_A, id: saved.id });
  assert.equal(full.report.script.text.includes("A"), true);
  assert.equal(full.report.structures.length, 4);

  // 别人的 id 读不到（managerId 收口）
  assert.equal(await getVideoAnalysisReport({ ownerId: OWNER_B, id: saved.id }), null);
  // 别人删不掉
  assert.deepEqual(await deleteVideoAnalysisReport({ ownerId: OWNER_B, id: saved.id }), { deleted: false });

  assert.deepEqual(await deleteVideoAnalysisReport({ ownerId: OWNER_A, id: saved.id }), { deleted: true });
  assert.equal((await listVideoAnalysisReports({ ownerId: OWNER_A })).length, 0);
});

test("4.1 员工按客户读：必须带 customerId，只回该客户的", { skip }, async t => {
  await setup();
  if (!db) return t.skip(skipReason);
  t.after(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (client) await client.close().catch(() => {});
    await closeMongoClient();
  });

  const a = await saveVideoAnalysisReport({ ownerId: OWNER_A, customerId: CUSTOMER_A, customerName: "客户甲", report: makeReport("甲") });
  await saveVideoAnalysisReport({ ownerId: OWNER_B, customerId: CUSTOMER_B, customerName: "客户乙", report: makeReport("乙") });

  // 不带 customerId → 400，绝不退化成「列出全部」
  await assert.rejects(
    () => listVideoAnalysisReportsForCustomer({}),
    error => error.status === 400 && /customerId is required/.test(error.message),
  );
  await assert.rejects(
    () => getVideoAnalysisReportForCustomer({ id: a.id }),
    error => error.status === 400,
  );

  const listA = await listVideoAnalysisReportsForCustomer({ customerId: CUSTOMER_A });
  assert.equal(listA.length, 1);
  assert.equal(listA[0].videoTitle, "测试视频 甲");
  assert.equal("managerId" in listA[0], false, "员工侧元数据同样不含 managerId");
  assert.equal("report" in listA[0], false, "员工侧列表同样不带正文");

  // 按 id + customerId 取正文：客户对不上就读不到
  const full = await getVideoAnalysisReportForCustomer({ customerId: CUSTOMER_A, id: a.id });
  assert.ok(full?.report);
  assert.equal(await getVideoAnalysisReportForCustomer({ customerId: CUSTOMER_B, id: a.id }), null);

  // 员工侧读得到「别的 manager 建的、但属于本客户」的报告 —— 这是有意的（团队共用客户数据）
  const crossList = await listVideoAnalysisReportsForCustomer({ customerId: CUSTOMER_B });
  assert.equal(crossList.length, 1);
});

test("4.1 保存必须带 customerId 且 reportType 必须是 video_analysis", { skip }, async t => {
  await setup();
  if (!db) return t.skip(skipReason);
  t.after(async () => {
    if (db) await db.dropDatabase().catch(() => {});
    if (client) await client.close().catch(() => {});
    await closeMongoClient();
  });

  await assert.rejects(
    () => saveVideoAnalysisReport({ ownerId: OWNER_A, report: makeReport("x") }),
    error => error.status === 400 && /customerId is required/.test(error.message),
  );
  await assert.rejects(
    () => saveVideoAnalysisReport({ ownerId: OWNER_A, customerId: CUSTOMER_A, report: { reportType: "account_plan" } }),
    /invalid video analysis report/,
  );
  await assert.rejects(
    () => saveVideoAnalysisReport({ ownerId: "not-an-object-id", customerId: CUSTOMER_A, report: makeReport("x") }),
    /Invalid manager identity/,
  );
});
