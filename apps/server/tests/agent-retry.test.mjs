// 通用 Agent 重试机制测试。
//
// 背景（2026-09-17）：分类分析 / 黄金三秒这类「一次调用出一份报告」的 Agent 原先没有
// 重试，一次瞬时故障就直接掉进规则兜底，用户看到的是「分析 Agent 曾发生异常，已生成
// 可人工复核的初步报告」。这些测试锁住新加的重试行为，以及两个必须守住的边界：
//
//   1. 凭证类错误和 4xx 不重试 —— 重试不会变好，只会白等。
//   2. 重试带总时间预算 —— 单次 HTTP 超时 120s，serverless maxDuration 也是 120s，
//      无预算的重试会把函数拖到被平台强杀，连兜底报告都拿不到。
import test from "node:test";
import assert from "node:assert/strict";

import { AgentError } from "../api/_lib/contentAgent/http.js";
import { runAgentWithRetry } from "../api/_lib/contentAgent/providers.js";

// 次数 / 间隔都压到最小，预算给足，让测试只关心「试了几次」。
const baseConfig = {
  agentRetryAttempts: 2,
  agentRetryBaseDelayMs: 1,
  agentRetryBudgetMs: 60000,
};

const counter = () => {
  let count = 0;
  return {
    get count() { return count; },
    next() { count += 1; return count; },
  };
};

const step = (agent = "benchmark-analysis-spoken") => ({ agent, interfaceName: "test:agent" });

test("遇到瞬时 HTTP 故障会重试，成功后不再降级", async () => {
  const attempts = counter();
  const result = await runAgentWithRetry({
    ...step(),
    run: async () => {
      if (attempts.next() < 3) {
        throw new AgentError("HTTP 503 from deepseek", { code: "HTTP_ERROR", status: 503 });
      }
      return { categories: ["行业避坑经验"] };
    },
  }, baseConfig);

  assert.deepEqual(result, { categories: ["行业避坑经验"] });
  assert.equal(attempts.count, 3, "应该在第三次尝试成功");
});

test("DEEPSEEK_EMPTY（推理吃满 max_tokens 导致 content 为空）会重试", async () => {
  const attempts = counter();
  const result = await runAgentWithRetry({
    ...step(),
    run: async () => {
      if (attempts.next() === 1) {
        throw new AgentError("DeepSeek returned empty content", { code: "DEEPSEEK_EMPTY" });
      }
      return "ok";
    },
  }, baseConfig);

  assert.equal(result, "ok");
  assert.equal(attempts.count, 2);
});

test("JSON 解析失败（MODEL_JSON_INVALID）会重试", async () => {
  const attempts = counter();
  const result = await runAgentWithRetry({
    ...step("gold-three-seconds"),
    run: async () => {
      if (attempts.next() === 1) {
        throw new AgentError("Model output is not valid JSON", { code: "MODEL_JSON_INVALID" });
      }
      return { items: [] };
    },
  }, baseConfig);

  assert.deepEqual(result, { items: [] });
  assert.equal(attempts.count, 2);
});

test("凭证缺失不重试，立刻抛出交给上层降级", async () => {
  const attempts = counter();
  await assert.rejects(
    runAgentWithRetry({
      ...step(),
      run: async () => {
        attempts.next();
        throw new AgentError("Missing DEEPSEEK_API_KEY", { code: "DEEPSEEK_TOKEN_MISSING" });
      },
    }, baseConfig),
    /Missing DEEPSEEK_API_KEY/,
  );

  assert.equal(attempts.count, 1, "凭证类错误重试没有意义，只应尝试一次");
});

test("4xx 不重试", async () => {
  const attempts = counter();
  await assert.rejects(
    runAgentWithRetry({
      ...step(),
      run: async () => {
        attempts.next();
        throw new AgentError("HTTP 401 from deepseek", { code: "HTTP_ERROR", status: 401 });
      },
    }, baseConfig),
    /HTTP 401/,
  );

  assert.equal(attempts.count, 1);
});

test("重试用尽后抛出最后一次的错误，上层据此走规则兜底", async () => {
  const attempts = counter();
  await assert.rejects(
    runAgentWithRetry({
      ...step(),
      run: async () => {
        throw new AgentError(`HTTP 500 第 ${attempts.next()} 次`, { code: "HTTP_ERROR", status: 500 });
      },
    }, baseConfig),
    /第 3 次/,
  );

  assert.equal(attempts.count, 3, "agentRetryAttempts=2 表示首次 + 2 次重试");
});

test("重试预算用尽时立刻收手，不把 serverless 函数拖过 maxDuration", async () => {
  const attempts = counter();
  await assert.rejects(
    runAgentWithRetry({
      ...step(),
      run: async () => {
        attempts.next();
        // 单次就超过预算，模拟一次接近 AGENT_REQUEST_TIMEOUT_MS 的慢请求。
        await new Promise(resolve => setTimeout(resolve, 60));
        throw new AgentError("HTTP 504 from deepseek", { code: "HTTP_ERROR", status: 504 });
      },
    }, { ...baseConfig, agentRetryBudgetMs: 30 }),
    /HTTP 504/,
  );

  assert.equal(attempts.count, 1, "预算已耗尽，不应再发起第二次调用");
});

test("agentRetryAttempts=0 时退化成单次调用", async () => {
  const attempts = counter();
  await assert.rejects(
    runAgentWithRetry({
      ...step(),
      run: async () => {
        attempts.next();
        throw new AgentError("HTTP 502", { code: "HTTP_ERROR", status: 502 });
      },
    }, { ...baseConfig, agentRetryAttempts: 0 }),
    /HTTP 502/,
  );

  assert.equal(attempts.count, 1);
});
