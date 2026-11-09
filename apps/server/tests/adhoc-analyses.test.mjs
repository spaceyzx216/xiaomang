// 员工「临时分析」：入参归一化的边界测试。
//
// 背景（见 `api/_lib/adhocAnalysisStore.js` 文件头）：员工原本只能从项目经理布置的
// 「今日任务」进入工作流，没有任务就**无路可走**；临时分析是给「分析一个不属于任何客户的
// 对标账号」留的第二扇门，并且**员工私有**（读写删全部按 userId 收口）。
//
// 这里只测**纯函数** `normalizeAdhocInput`。store 的读写要真实 MongoDB，
// 按 HANDOFF §6.5㉕ 不能进 `npm test`（会让没有数据库的环境挂掉）——
// 那条链路由 `scripts/verify-server-routes.mjs` 打 HTTP 覆盖。
//
// 重点守住四件事：
//
//   1. **换行必须保留**。抓到的链接会被预填进 `/topics` 的抓取框，而那边的解析是按行/逗号
//      拆的（`parseLines` / `parseBenchmarkLinks`）。把换行压成空格 = 多账号静默变成一个乱码账号；
//   2. **空输入必须被挡掉**，不能落一条没有对标账号的空记录（那样员工点进去什么都抓不到，
//      却看不出哪里错了）；
//   3. **视频号填的是账号名称、不是链接**，所以校验不能要求它长得像 URL；
//   4. 平台的取值是**有限枚举**，认不出的落到抖音而不是抛错（表单传脏值时仍能用）。
import test from "node:test";
import assert from "node:assert/strict";

import {
  ADHOC_LIST_LIMIT,
  ADHOC_PLATFORMS,
  DEFAULT_ADHOC_TITLE,
  MAX_ADHOC_TITLE,
  adhocPlatformLabel,
  normalizeAdhocInput,
} from "../api/_lib/adhocAnalysisStore.js";

const PLATFORM_KEYS = ADHOC_PLATFORMS.map(item => item.key);

test("三平台枚举齐全，且标签与键一一对应", () => {
  assert.deepEqual(PLATFORM_KEYS, ["douyin", "wechat_channels", "tiktok"]);
  assert.equal(adhocPlatformLabel("douyin"), "抖音");
  assert.equal(adhocPlatformLabel("wechat_channels"), "视频号");
  assert.equal(adhocPlatformLabel("tiktok"), "TikTok");
  // 认不出的键要有兜底，不能返回 undefined（前端会把它当平台名渲染出来）。
  assert.equal(adhocPlatformLabel("kuaishou"), "抖音");
});

test("★ 多行链接逐行 trim、丢空行，但**保留换行**（下游是按行解析的）", () => {
  const result = normalizeAdhocInput({
    benchmarkAccounts: "  https://www.douyin.com/user/aaa  \n\n   https://www.douyin.com/user/bbb\n   \n",
    platform: "douyin",
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.benchmarkAccounts, "https://www.douyin.com/user/aaa\nhttps://www.douyin.com/user/bbb");
  // 反面：如果实现把换行压成空格，这里会变成一行 —— 那是静默的功能损坏。
  assert.equal(result.value.benchmarkAccounts.includes("\n"), true);
});

test("空输入被挡掉，并给出可读的原因（不是抛异常）", () => {
  for (const input of [
    { benchmarkAccounts: "" },
    { benchmarkAccounts: "   " },
    { benchmarkAccounts: "\n\n   \n" },
    {},
    null,
    undefined,
    "不是对象",
  ]) {
    const result = normalizeAdhocInput(input);
    assert.equal(result.ok, false, `入参 ${JSON.stringify(input)} 应当被挡掉`);
    assert.match(result.error, /对标账号/);
  }
});

test("视频号那一路填的是**账号名称**，不要求是 URL", () => {
  const result = normalizeAdhocInput({ benchmarkAccounts: "人民日报", platform: "wechat_channels" });
  assert.equal(result.ok, true);
  assert.equal(result.value.benchmarkAccounts, "人民日报");
  assert.equal(result.value.platform, "wechat_channels");
});

test("平台：合法值原样保留，脏值落到抖音", () => {
  for (const key of PLATFORM_KEYS) {
    assert.equal(normalizeAdhocInput({ benchmarkAccounts: "a", platform: key }).value.platform, key);
  }
  for (const dirty of ["", "  ", "Douyin", "kuaishou", null, 42]) {
    assert.equal(normalizeAdhocInput({ benchmarkAccounts: "a", platform: dirty }).value.platform, "douyin");
  }
});

test("项目名：留空落默认名，超长截断，多余空白压平", () => {
  const empty = normalizeAdhocInput({ benchmarkAccounts: "a" });
  assert.equal(empty.value.title, DEFAULT_ADHOC_TITLE);

  const blank = normalizeAdhocInput({ benchmarkAccounts: "a", title: "    " });
  assert.equal(blank.value.title, DEFAULT_ADHOC_TITLE);

  const messy = normalizeAdhocInput({ benchmarkAccounts: "a", title: "  抖音   母婴   对标  " });
  assert.equal(messy.value.title, "抖音 母婴 对标");

  const long = normalizeAdhocInput({ benchmarkAccounts: "a", title: "标".repeat(200) });
  assert.equal(long.value.title.length, MAX_ADHOC_TITLE);
});

test("对标账号原文有长度上限，截断而不是无限存", () => {
  const result = normalizeAdhocInput({ benchmarkAccounts: "x".repeat(2000) });
  assert.equal(result.ok, true);
  assert.equal(result.value.benchmarkAccounts.length, 600);
});

test("返回的字段就是落库字段：只有 title / benchmarkAccounts / platform / customerId", () => {
  const result = normalizeAdhocInput({
    benchmarkAccounts: "https://www.douyin.com/user/aaa",
    platform: "douyin",
    title: "临时调研",
    // 客户绑定是 2026-09-21 新增的合法字段（选了客户才能用该客户的选题库打标签）。
    customerId: "507f1f77bcf86cd799439011",
    // 下面这些都不该被带进去（多余的键不进库）。
    userId: "别人的 id",
    _id: "伪造的 id",
    createdAt: "2020-01-01",
    customerName: "伪造的客户名",
  });

  assert.deepEqual(
    Object.keys(result.value).sort(),
    ["benchmarkAccounts", "customerId", "platform", "title"],
  );
  // ★ 客户名由后端从库里取，不接受调用方传进来的值（否则可以伪造成任意客户名）。
  assert.equal("customerName" in result.value, false);
  assert.equal("userId" in result.value, false);
  assert.equal("_id" in result.value, false);
});

test("不选客户时 customerId 归一化成空串（而不是 undefined/缺失）", () => {
  const result = normalizeAdhocInput({ benchmarkAccounts: "https://www.douyin.com/user/aaa" });
  assert.equal(result.value.customerId, "");
});

test("列表上限是个正整数，且不用于删除用户数据", () => {
  assert.equal(Number.isInteger(ADHOC_LIST_LIMIT), true);
  assert.equal(ADHOC_LIST_LIMIT > 0, true);
});
