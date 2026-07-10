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

test("accepts a custom topic window up to three months", () => {
  assert.equal(MAX_TOPIC_DAYS, 90);
  assert.equal(parseTopicDays(1), 1);
  assert.equal(parseTopicDays("90"), 90);
  assert.equal(parseRecentDays(90), 90);
  for (const value of [0, 91, 1.5, "invalid", true, [7], { value: 7 }]) {
    assert.throws(() => parseTopicDays(value), RangeError);
    assert.throws(() => parseRecentDays(value), RangeError);
  }
});

test("scales pagination safety limits with the selected window", () => {
  assert.deepEqual(topicRequestLimits(7), { maxPages: 20, count: 400 });
  assert.deepEqual(topicRequestLimits(30), { maxPages: 25, count: 450 });
  assert.deepEqual(topicRequestLimits(90), { maxPages: 60, count: 1200 });
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

  const recovered = mergeTopicBatchResults(failed, [{
    inputName: "账号 A",
    topics: [topicAtAge("a", 1), topicAtAge("b", 20)],
    error: null,
  }]);
  assert.deepEqual(recovered[0].topics.map(topic => topic.id), ["a", "b"]);
  assert.equal(recovered[0].backgroundError, null);
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
    [videoAtAge("recent-b", 12)],
    [videoAtAge("boundary-old", 31)],
  ];
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 30,
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
  assert.deepEqual(result.videos.map(video => video.aweme_id), ["recent-a", "recent-b"]);
});

test("continues past a duplicate-only page when the cursor advances", async () => {
  let calls = 0;
  const result = await collectRecentAwemePages({
    platform: "tiktok",
    days: 30,
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

test("keeps successful pages when a later page fails", async () => {
  const result = await collectRecentAwemePages({
    platform: "douyin",
    days: 30,
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

test("reports incomplete data when pagination reaches a safety cap", async () => {
  const result = await collectRecentAwemePages({
    platform: "tiktok",
    days: 90,
    maxPages: 2,
    maxVideos: 1200,
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

test("keeps pagination internals out of the browser response payload", () => {
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
  });
  assert.equal("pages" in response.topicWindow, false);
  assert.equal("videos" in response.topicWindow, false);
});
