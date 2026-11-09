import test from "node:test";
import assert from "node:assert/strict";

import {
  isConfirmedWechatAccount,
  isFinderUsername,
  retainConfirmedWechatAccounts,
} from "../../web/src/app/wechatAccountValidation.ts";

test("accepts only a finder username bound to the current input name", () => {
  assert.equal(isFinderUsername("v2_example@finder"), true);
  assert.equal(isFinderUsername("  v2_example@finder  "), true);
  assert.equal(isFinderUsername("v2_ @finder"), false);
  assert.equal(isFinderUsername("v2_example@other@finder"), false);
  assert.equal(isFinderUsername(""), false);
  assert.equal(isConfirmedWechatAccount("账号 A", {
    inputName: "账号 A",
    finderUsername: "v2_example@finder",
  }), true);
  assert.equal(isConfirmedWechatAccount("账号 B", {
    inputName: "账号 A",
    finderUsername: "v2_example@finder",
  }), false);
  assert.equal(isConfirmedWechatAccount("账号 A", {
    inputName: "账号 A",
    finderUsername: "",
  }), false);
});

test("retains only valid confirmations for the current WeChat input", () => {
  const accounts = {
    "账号 A": { inputName: "账号 A", finderUsername: "v2_a@finder", displayName: "A" },
    "账号 B": { inputName: "账号 B", finderUsername: "", displayName: "B" },
    "旧账号": { inputName: "旧账号", finderUsername: "v2_old@finder", displayName: "旧" },
  };
  assert.deepEqual(retainConfirmedWechatAccounts(["账号 A", "账号 B", "新账号"], accounts), {
    "账号 A": accounts["账号 A"],
  });
});
