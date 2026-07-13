import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_TOPIC_DAYS,
  groupTopicsByWeek,
  mergeTopicBatchResults,
  parseTopicDays,
  topicRequestLimits,
} from "../src/app/topicTimeWindow.ts";
import {
  MAX_RECENT_DAYS,
  buildCombinedVideosResponse,
  collectRecentAwemePages,
  parseRecentDays,
} from "../api/_lib/topicPagination.js";
import { fetchPlatformTopics } from "../api/_lib/platformAdapters.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-11T12:00:00Z");

const topicAtAge = (id, ageDays) => ({
  id,
  publishDate: new Date(NOW - ageDays * DAY_MS).toISOString(),
});

const videoAtAge = (id, ageDays) => ({
  aweme_id: id,
  create_time: Math.floor((NOW - ageDays * DAY_MS) / 1000),
});

const wechatVideoAtAge = (id, ageDays) => ({
  id,
  title: id,
  create_time: Math.floor((NOW - ageDays * DAY_MS) / 1000),
});

test("accepts a custom topic window up to two years", () => {
  assert.equal(MAX_TOPIC_DAYS, 730);
  assert.equal(MAX_RECENT_DAYS, 730);
  assert.equal(parseTopicDays(1), 1);
  assert.equal(parseTopicDays("730"), 730);
  assert.equal(parseRecentDays(730), 730);
  for (const value of [0, 731, 1.5, "invalid", true, [7], { value: 7 }]) {
    assert.throws(() => parseTopicDays(value), RangeError);
    assert.throws(() => parseRecentDays(value), RangeError);
  }
});

test("scales pagination safety limits with the selected window", () => {
  assert.deepEqual(topicRequestLimits(7), { maxPages: 20, count: 400 });
  assert.deepEqual(topicRequestLimits(30), { maxPages: 25, count: 450 });
  assert.deepEqual(topicRequestLimits(90), { maxPages: 65, count: 1350 });
  assert.deepEqual(topicRequestLimits(365), { maxPages: 100, count: 2000 });
  assert.deepEqual(topicRequestLimits(730), { maxPages: 100, count: 2000 });
});

test("filters awemes by daysFrom lower bound", async () => {
  // days=30, daysFrom=8 → 只保留第 8-30 天的视频，排除近 7 天的
  let calls = 0;
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 30,
    daysFrom: 8,
    expectedPageSize: 2,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      calls += 1;
      const pages = {
        1: [videoAtAge("recent", 3)],
        2: [videoAtAge("in-range-15", 15), videoAtAge("in-range-20", 20)],
        3: [videoAtAge("in-range-25", 25), videoAtAge("outside", 31)],
      };
      return {
        data: { data: { aweme_list: pages[page] || [], max_cursor: page, has_more: 1 } },
      };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.stopReason, "time_boundary");
  assert.deepEqual(result.videos.map(v => v.aweme_id), ["in-range-15", "in-range-20", "in-range-25"]);
});

test("groups ninety days of topics into seven-day collapsed buckets", () => {
  const groups = groupTopicsByWeek([
    topicAtAge("latest", 1),
    topicAtAge("second-week", 8),
    topicAtAge("last-week", 89),
    topicAtAge("outside", 91),
    topicAtAge("latest", 2),
  ], 90, NOW);

  assert.equal(groups.length, 13);
  assert.equal(groups[0].label, "近 7 天");
  assert.deepEqual(groups[0].topics.map(topic => topic.id), ["latest"]);
  assert.deepEqual(groups[1].topics.map(topic => topic.id), ["second-week"]);
  assert.equal(groups[12].label, "第 85–90 天");
  assert.deepEqual(groups[12].topics.map(topic => topic.id), ["last-week"]);
});

test("merges background results without deleting first-week data on partial failure", () => {
  const initial = [{ inputName: "账号 A", topics: [topicAtAge("a", 1)], error: null }];
  const failed = mergeTopicBatchResults(initial, [{ inputName: "账号 A", topics: [topicAtAge("b", 20)], error: "timeout" }]);
  assert.deepEqual(failed[0].topics.map(topic => topic.id), ["a", "b"]);
  assert.equal(failed[0].error, null);
  assert.equal(failed[0].backgroundError, "timeout");
  assert.equal(failed[0].videosCount, 2);

  const recovered = mergeTopicBatchResults(failed, [{
    inputName: "账号 A",
    topics: [topicAtAge("a", 1), topicAtAge("b", 20)],
    error: null,
  }]);
  assert.deepEqual(recovered[0].topics.map(topic => topic.id), ["a", "b"]);
  assert.equal(recovered[0].backgroundError, null);
});

test("keeps topics undefined for douyin/tiktok results so videosResponse stays the source of truth", () => {
  // 抖音/TikTok 后端不返回 topics，前端依赖 videosResponse.data.aweme_list 解析。
  // 合并时若把 topics 设成 []，下游 Array.isArray([]) 会短路掉 videosResponse 解析，
  // 导致渐进分页第二次请求合并后内容被清空。
  const initial = [{
    url: "https://www.douyin.com/user/sec-a",
    videosResponse: { data: { aweme_list: [videoAtAge("a", 1)] } },
    error: null,
  }];
  const full = [{
    url: "https://www.douyin.com/user/sec-a",
    videosResponse: { data: { aweme_list: [videoAtAge("a", 1), videoAtAge("b", 20)] } },
    error: null,
  }];
  const merged = mergeTopicBatchResults(initial, full);
  assert.equal("topics" in merged[0], false);
  assert.deepEqual(merged[0].videosResponse.data.aweme_list.map(v => v.aweme_id), ["a", "b"]);
});

test("stops paginated collection at the requested time boundary", async () => {
  let calls = 0;
  const pages = [
    [videoAtAge("a", 1), videoAtAge("b", 2)],
    [videoAtAge("c", 6), videoAtAge("old", 8)],
    [videoAtAge("should-not-load", 9)],
  ];
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 7,
    expectedPageSize: 2,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      calls += 1;
      return {
        data: {
          data: {
            aweme_list: pages[page - 1],
            max_cursor: page,
            has_more: 1,
          },
        },
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.stopReason, "time_boundary");
  assert.equal(result.isComplete, true);
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["a", "b", "c"]);
});

test("ignores an old pinned video on the first page before confirming the boundary", async () => {
  let calls = 0;
  const pages = [
    [videoAtAge("pinned-old", 40), videoAtAge("recent-a", 1)],
    [videoAtAge("recent-b", 12), videoAtAge("filler", 20)],
    [videoAtAge("boundary-old", 31), videoAtAge("should-not-load", 35)],
  ];
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 30,
    expectedPageSize: 2,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      calls += 1;
      return {
        data: {
          data: {
            aweme_list: pages[page - 1],
            max_cursor: page,
            has_more: 1,
          },
        },
      };
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.stopReason, "time_boundary");
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["recent-a", "recent-b", "filler"]);
});

test("continues past a duplicate-only page when the cursor advances", async () => {
  let calls = 0;
  const result = await collectRecentAwemePages({
    platform: "tiktok",
    days: 30,
    expectedPageSize: 1,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      calls += 1;
      const pageVideos = page === 1
        ? [videoAtAge("a", 1)]
        : page === 2 ? [videoAtAge("a", 1)] : [videoAtAge("b", 2), videoAtAge("old", 31)];
      return { data: { data: { aweme_list: pageVideos, cursor: page, has_more: 1 } } };
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["a", "b"]);
});

test("prefers TikHub max_cursor over legacy cursor when continuing", async () => {
  const cursors = [];
  const result = await collectRecentAwemePages({
    platform: "tiktok",
    days: 30,
    expectedPageSize: 1,
    nowMs: NOW,
    fetchPage: async (cursor, page) => {
      cursors.push(cursor);
      if (page === 1) {
        return {
          data: { data: { aweme_list: [videoAtAge("a", 1)], cursor: "legacy-cursor", max_cursor: "official-cursor", has_more: 1 } },
        };
      }
      return {
        data: { data: { aweme_list: [videoAtAge("b", 2)], max_cursor: "end", has_more: 0 } },
      };
    },
  });

  assert.deepEqual(cursors, [0, "official-cursor"]);
  assert.equal(result.stopReason, "upstream_exhausted");
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["a", "b"]);
});

test("treats an empty page as upstream exhaustion even if a cursor is present", async () => {
  let calls = 0;
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 30,
    expectedPageSize: 1,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      calls += 1;
      return page === 1
        ? { data: { data: { aweme_list: [videoAtAge("a", 1)], max_cursor: 1, has_more: 1 } } }
        : { data: { data: { aweme_list: [], max_cursor: 2, has_more: 1 } } };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.stopReason, "upstream_exhausted");
  assert.equal(result.isComplete, true);
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["a"]);
});

test("stops after consecutive duplicate-only pages to avoid wasting API calls", async () => {
  // 账号作品已取尽，但 TikHub 持续返回新游标 + 全是重复视频的页面。
  // 第 1 页有新作品；随后连续两页重复时停止。允许穿过一页重叠数据，
  // 同时避免无意义地持续调用 API。
  let calls = 0;
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 730,
    expectedPageSize: 20,
    maxPages: 100,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      calls += 1;
      // 每页都返回同样的 2 条视频（全是已见过的重复）
      return { data: { data: { aweme_list: [videoAtAge("a", 1), videoAtAge("b", 2)], max_cursor: page, has_more: 1 } } };
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.stopReason, "upstream_exhausted");
  assert.equal(result.isComplete, true);
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["a", "b"]);
});

test("resets consecutive duplicate counter when a page has new videos", async () => {
  // 第 1 页有新视频 → consecutiveEmptyPages 重置为 0，
  // 第 2 页重复(计数=1)，第 3 页重复(计数=2 >= 2 → 触发停止)
  let calls = 0;
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 730,
    expectedPageSize: 20,
    maxPages: 100,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      calls += 1;
      if (page === 1) return { data: { data: { aweme_list: [videoAtAge("a", 1), videoAtAge("b", 2)], max_cursor: page, has_more: 1 } } };
      // pages 2+ 全是重复
      return { data: { data: { aweme_list: [videoAtAge("a", 1), videoAtAge("b", 2)], max_cursor: page, has_more: 1 } } };
    },
  });

  // 第 1 页有新增(2 条)→重置(计数=0), 第 2 页重复(计数=1), 第 3 页重复(计数=2 >= 2 → 停止)
  assert.equal(calls, 3);
  assert.equal(result.stopReason, "upstream_exhausted");
  assert.equal(result.isComplete, true);
  assert.deepEqual(result.videos.map(v => v.aweme_id), ["a", "b"]);
});

test("keeps successful pages when a later page fails", async () => {
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 30,
    expectedPageSize: 1,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      if (page === 2) throw new Error("upstream timeout");
      return { data: { data: { aweme_list: [videoAtAge("a", 1)], max_cursor: 1, has_more: 1 } } };
    },
  });

  assert.deepEqual(result.videos.map(video => video.aweme_id), ["a"]);
  assert.equal(result.stopReason, "page_error");
  assert.equal(result.isComplete, false);
  assert.equal(result.partialError, "upstream timeout");
});

test("wechat pagination also ignores old pinned posts on page one", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const pages = [
    { videos: [wechatVideoAtAge("pinned-old", 40), wechatVideoAtAge("recent-a", 1)], last_buffer: "b1", up_continue: 1 },
    { videos: [wechatVideoAtAge("recent-b", 12)], last_buffer: "b2", up_continue: 1 },
    { videos: [wechatVideoAtAge("boundary-old", 31)], last_buffer: "b3", up_continue: 1 },
  ];
  global.fetch = async () => {
    const page = pages[calls];
    calls += 1;
    return new Response(JSON.stringify({ data: page }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const payload = await fetchPlatformTopics(
      {
        platform: "wechat_channels",
        accounts: [{ inputName: "账号 A", finderUsername: "finder-a" }],
        days: 30,
        count: 400,
        maxPages: 10,
      },
      {
        tikhubBaseUrl: "https://example.invalid",
        tikhubApiToken: "test-token",
        requestTimeoutMs: 1000,
        apiRetryAttempts: 1,
        apiRetryBaseDelayMs: 1,
      },
    );

    assert.equal(calls, 3);
    assert.equal(payload.results[0].stopReason, "time_boundary");
    assert.deepEqual(payload.results[0].topics.map(topic => topic.id), [
      "wechat_channels:recent-a",
      "wechat_channels:recent-b",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("wechat pagination advances beyond a duplicate-only page", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const pages = [
    { videos: [wechatVideoAtAge("a", 1)], last_buffer: "b1", up_continue: 1 },
    { videos: [wechatVideoAtAge("a", 1)], last_buffer: "b2", up_continue: 1 },
    { videos: [wechatVideoAtAge("b", 2), wechatVideoAtAge("old", 31)], last_buffer: "b3", up_continue: 1 },
  ];
  global.fetch = async () => {
    const page = pages[calls];
    calls += 1;
    return new Response(JSON.stringify({ data: page }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const payload = await fetchPlatformTopics(
      {
        platform: "wechat_channels",
        accounts: [{ inputName: "账号 A", finderUsername: "finder-a" }],
        days: 30,
        maxPages: 10,
      },
      {
        tikhubBaseUrl: "https://example.invalid",
        tikhubApiToken: "test-token",
        requestTimeoutMs: 1000,
        apiRetryAttempts: 1,
        apiRetryBaseDelayMs: 1,
      },
    );

    assert.equal(calls, 3);
    assert.deepEqual(payload.results[0].topics.map(topic => topic.id), [
      "wechat_channels:a",
      "wechat_channels:b",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("wechat continues from last_buffer even when up_continue is zero", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const pages = [
    { videos: [wechatVideoAtAge("a", 1)], last_buffer: "buffer-1", up_continue: 0 },
    { videos: [wechatVideoAtAge("b", 12)], last_buffer: "buffer-2", up_continue: 0 },
    { videos: [wechatVideoAtAge("old", 31)], last_buffer: "buffer-3", up_continue: 0 },
  ];
  global.fetch = async () => {
    const page = pages[calls];
    calls += 1;
    return new Response(JSON.stringify({ data: page }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const payload = await fetchPlatformTopics(
      {
        platform: "wechat_channels",
        accounts: [{ inputName: "账号 A", finderUsername: "finder-a" }],
        days: 30,
        count: 400,
        maxPages: 10,
      },
      {
        tikhubBaseUrl: "https://example.invalid",
        tikhubApiToken: "test-token",
        requestTimeoutMs: 1000,
        apiRetryAttempts: 1,
        apiRetryBaseDelayMs: 1,
      },
    );

    assert.equal(calls, 3);
    assert.equal(payload.results[0].stopReason, "time_boundary");
    assert.equal(payload.results[0].isComplete, true);
    assert.deepEqual(payload.results[0].topics.map(topic => topic.id), [
      "wechat_channels:a",
      "wechat_channels:b",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("wechat pagination preserves earlier pages when a later page fails", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        data: { videos: [wechatVideoAtAge("a", 1)], last_buffer: "b1", up_continue: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "bad page" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const payload = await fetchPlatformTopics(
      {
        platform: "wechat_channels",
        accounts: [{ inputName: "账号 A", finderUsername: "finder-a" }],
        days: 30,
        maxPages: 10,
      },
      {
        tikhubBaseUrl: "https://example.invalid",
        tikhubApiToken: "test-token",
        requestTimeoutMs: 1000,
        apiRetryAttempts: 1,
        apiRetryBaseDelayMs: 1,
      },
    );

    assert.equal(calls, 2);
    assert.deepEqual(payload.results[0].topics.map(topic => topic.id), ["wechat_channels:a"]);
    assert.equal(payload.results[0].stopReason, "page_error");
    assert.equal(payload.results[0].isComplete, false);
    assert.match(payload.results[0].backgroundError, /HTTP 400/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("wechat continuation starts after the saved last_buffer", async () => {
  const originalFetch = global.fetch;
  const requestBodies = [];
  global.fetch = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      data: {
        videos: [wechatVideoAtAge("old", 31)],
        last_buffer: "buffer-8",
        up_continue: 1,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const payload = await fetchPlatformTopics(
      {
        platform: "wechat_channels",
        accounts: [{
          inputName: "账号 A",
          finderUsername: "finder-a",
          resume: { cursor: "buffer-7", pageOffset: 7 },
        }],
        days: 30,
        maxPages: 100,
      },
      {
        tikhubBaseUrl: "https://example.invalid",
        tikhubApiToken: "test-token",
        requestTimeoutMs: 1000,
        apiRetryAttempts: 1,
        apiRetryBaseDelayMs: 1,
      },
    );

    assert.equal(requestBodies.length, 1);
    assert.equal(requestBodies[0].last_buffer, "buffer-7");
    assert.equal(payload.results[0].totalPageCount, 8);
    assert.equal(payload.results[0].stopReason, "time_boundary");
    assert.equal(payload.results[0].isComplete, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("reports incomplete data when pagination reaches a safety cap", async () => {
  const result = await collectRecentAwemePages({
    platform: "tiktok",
    days: 90,
    maxPages: 2,
    maxVideos: 1200,
    expectedPageSize: 1,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => ({
      data: {
        data: {
          aweme_list: [videoAtAge(`page-${page}`, page)],
          cursor: page,
          has_more: 1,
        },
      },
    }),
  });

  assert.equal(result.pageCount, 2);
  assert.equal(result.stopReason, "safety_limit");
  assert.equal(result.isComplete, false);
  assert.match(result.incompleteReason, /可能不完整/);
});

test("treats a repeated cursor as complete instead of a partial failure", async () => {
  // 作品少的博主：第 1 页拿满（恰好等于 expectedPageSize），第 2 页游标重复且无新内容。
  // 旧逻辑标记 repeated_cursor + isComplete=false，触发前端误报"获取失败"。
  // 现在应视为正常取尽（upstream_exhausted + isComplete=true）。
  let calls = 0;
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 30,
    expectedPageSize: 2,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      calls += 1;
      return {
        data: {
          data: {
            // 第 2 页返回空且游标重复，模拟上游无法前进
            aweme_list: page === 1 ? [videoAtAge("a", 1), videoAtAge("b", 2)] : [],
            max_cursor: 5,
            has_more: 1,
          },
        },
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.stopReason, "upstream_exhausted");
  assert.equal(result.isComplete, true);
  assert.equal(result.incompleteReason, null);
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["a", "b"]);
});

test("stops early when the first page returns fewer than the expected page size", async () => {
  // 作品少的博主（如 4 条）：第 1 页返回的视频数 < 每页请求量（expectedPageSize），
  // 说明上游已到底，无需再请求第 2 页。
  let calls = 0;
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 15,
    expectedPageSize: 20,
    nowMs: NOW,
    fetchPage: async (_cursor, page) => {
      calls += 1;
      return {
        data: {
          data: {
            // 只返回 3 条，小于 expectedPageSize=20
            aweme_list: [videoAtAge("a", 1), videoAtAge("b", 5), videoAtAge("c", 10)],
            max_cursor: 100,
            has_more: 0,
          },
        },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.stopReason, "upstream_exhausted");
  assert.equal(result.isComplete, true);
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["a", "b", "c"]);
});

test("distinguishes an exact final page from a truncated final page", async () => {
  const exact = await collectRecentAwemePages({
    platform: "douyin",
    days: 30,
    maxVideos: 20,
    nowMs: NOW,
    fetchPage: async () => ({
      data: { data: { aweme_list: Array.from({ length: 20 }, (_, index) => videoAtAge(`exact-${index}`, 1)), max_cursor: 1, has_more: 0 } },
    }),
  });
  assert.equal(exact.isComplete, true);
  assert.equal(exact.stopReason, "upstream_exhausted");

  const truncated = await collectRecentAwemePages({
    platform: "douyin",
    days: 30,
    maxVideos: 20,
    nowMs: NOW,
    fetchPage: async () => ({
      data: { data: { aweme_list: Array.from({ length: 21 }, (_, index) => videoAtAge(`truncated-${index}`, 1)), max_cursor: 1, has_more: 0 } },
    }),
  });
  assert.equal(truncated.isComplete, false);
  assert.equal(truncated.stopReason, "safety_limit");
});

test("returns only compact continuation metadata in the browser response payload", () => {
  const response = buildCombinedVideosResponse(
    [{ data: { data: { aweme_list: [videoAtAge("a", 1)] } } }],
    [videoAtAge("a", 1)],
    {
      pages: [{ huge: true }],
      videos: [videoAtAge("a", 1)],
      pageCount: 1,
      rawVideosCount: 1,
      recentDays: 90,
      hasMore: false,
      stopReason: "time_boundary",
      isComplete: true,
      incompleteReason: null,
      totalPageCount: 7,
      resume: { cursor: "cursor-7", pageOffset: 7 },
    },
  );

  assert.deepEqual(response.topicWindow, {
    pageCount: 1,
    rawVideosCount: 1,
    recentDays: 90,
    hasMore: false,
    stopReason: "time_boundary",
    isComplete: true,
    incompleteReason: null,
    totalPageCount: 7,
    resume: { cursor: "cursor-7", pageOffset: 7 },
  });
  assert.equal("pages" in response.topicWindow, false);
  assert.equal("videos" in response.topicWindow, false);
});

test("resumes from the supplied cursor and keeps logical page numbering", async () => {
  const calls = [];
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 730,
    maxPages: 100,
    slicePages: 3,
    startCursor: 700,
    pageOffset: 7,
    expectedPageSize: 1,
    nowMs: NOW,
    fetchPage: async (cursor, logicalPage) => {
      calls.push({ cursor, logicalPage });
      return {
        data: {
          data: {
            aweme_list: [videoAtAge(`page-${logicalPage}`, logicalPage)],
            max_cursor: 800,
            has_more: 0,
          },
        },
      };
    },
  });

  assert.deepEqual(calls, [{ cursor: 700, logicalPage: 8 }]);
  assert.equal(result.totalPageCount, 8);
  assert.equal(result.isComplete, true);
});

test("returns a resumable cursor after a normal three-page slice", async () => {
  const result = await collectRecentAwemePages({
    platform: "tiktok",
    days: 730,
    maxPages: 100,
    slicePages: 3,
    expectedPageSize: 1,
    nowMs: NOW,
    fetchPage: async (_cursor, logicalPage) => ({
      data: {
        data: {
          aweme_list: [videoAtAge(`page-${logicalPage}`, logicalPage)],
          cursor: logicalPage * 10,
          has_more: 1,
        },
      },
    }),
  });

  assert.equal(result.stopReason, "slice_limit");
  assert.equal(result.isComplete, false);
  assert.deepEqual(result.resume, { cursor: 30, pageOffset: 3 });
  assert.equal(result.incompleteReason, null);
});

test("keeps the failed page cursor when a resumed slice errors", async () => {
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 730,
    maxPages: 100,
    slicePages: 3,
    startCursor: 700,
    pageOffset: 7,
    expectedPageSize: 1,
    nowMs: NOW,
    fetchPage: async (cursor, logicalPage) => {
      if (logicalPage === 9) {
        const error = new Error("HTTP 402");
        error.status = 402;
        throw error;
      }
      return {
        data: {
          data: {
            aweme_list: [videoAtAge("page-8", 8)],
            max_cursor: 800,
            has_more: 1,
          },
        },
      };
    },
  });

  assert.equal(result.stopReason, "page_error");
  assert.equal(result.partialErrorStatus, 402);
  assert.deepEqual(result.resume, { cursor: 800, pageOffset: 8 });
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["page-8"]);
});
