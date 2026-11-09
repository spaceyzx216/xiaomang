// TikHub 高赞评论抓取：字段别名兜底与目标解析的边界测试。
//
// 这层为什么值得单独测：
//   1. 上游**按次计费**。字段认错 → 评论为空 → 报告里「用户画像」失去证据，
//      而调用已经扣了钱，且失败还会被永久缓存下来；
//   2. TikHub 的评论字段名在 app/v3 与 web 两个端点之间不一致，别名兜底是**唯一**
//      的兼容手段，写漏一个就是整份样本静默变空；
//   3. 判重/截断/排序必须确定性，否则同一份缓存每次读出来顺序都在抖。
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeComments,
  normalizeCommentTargets,
  pickTopComments,
} from "../api/_lib/videoComments.js";

test("评论字段走别名兜底：text / digg_count / cid / user.nickname", () => {
  const comments = normalizeComments({
    data: {
      comments: [
        { cid: "c1", text: "求发一份自查表", digg_count: 120, reply_comment_total: 3, user: { nickname: "老板A" } },
        // web 端点的另一套字段名。
        { comment_id: "c2", content: "我客户赔了 28 万", like_count: 88, reply_count: 1, nickname: "HR小张" },
      ],
    },
  });
  assert.equal(comments.length, 2);
  // 点赞降序：120 在前。
  assert.deepEqual(comments[0], { id: "c1", text: "求发一份自查表", likes: 120, replyCount: 3, authorName: "老板A" });
  assert.deepEqual(comments[1], { id: "c2", text: "我客户赔了 28 万", likes: 88, replyCount: 1, authorName: "HR小张" });
});

test("空文本评论被丢弃：纯表情/被折叠的评论不该占掉 Top-N 名额", () => {
  const comments = normalizeComments([
    { cid: "c1", text: "   ", digg_count: 999 },
    { cid: "c2", text: "", digg_count: 500 },
    { cid: "c3", text: "有内容", digg_count: 1 },
  ]);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, "c3");
});

test("按 id 去重，但没有 id 的评论要保留", () => {
  const comments = normalizeComments([
    { cid: "dup", text: "重复的", digg_count: 10 },
    { cid: "dup", text: "重复的", digg_count: 10 },
    // 没有 id 时无法判定是不是同一条 —— 宁可多一条也不要误删。
    { text: "没有id的A", digg_count: 5 },
    { text: "没有id的B", digg_count: 4 },
  ]);
  assert.equal(comments.filter(item => item.id === "dup").length, 1);
  assert.equal(comments.length, 3);
});

test("点赞数非法值一律归零，不会变成 NaN 污染排序", () => {
  const comments = normalizeComments([
    { cid: "a", text: "负数", digg_count: -5 },
    { cid: "b", text: "非数字", digg_count: "很多" },
    { cid: "c", text: "正常", digg_count: 7 },
  ]);
  const byId = new Map(comments.map(item => [item.id, item]));
  assert.equal(byId.get("a").likes, 0);
  assert.equal(byId.get("b").likes, 0);
  assert.equal(byId.get("c").likes, 7);
  // 有真实点赞的那条必须排在最前。
  assert.equal(comments[0].id, "c");
});

test("limit 截断发生在排序之后：留下的是点赞最高的那几条", () => {
  const comments = normalizeComments([
    { cid: "low", text: "低", digg_count: 1 },
    { cid: "high", text: "高", digg_count: 100 },
    { cid: "mid", text: "中", digg_count: 50 },
  ], { limit: 2 });
  assert.deepEqual(comments.map(item => item.id), ["high", "mid"]);
});

test("同时给出空 comments 和 data 数组时，取非空的那个而不是把评论清空", () => {
  const comments = normalizeComments({ comments: [], data: [{ cid: "c1", text: "有内容", digg_count: 1 }] });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].text, "有内容");
});

test("pickTopComments 排序确定性：点赞相同按回复数，再保持上游顺序", () => {
  const list = [
    { id: "a", text: "A", likes: 10, replyCount: 1 },
    { id: "b", text: "B", likes: 10, replyCount: 9 },
    { id: "c", text: "C", likes: 10, replyCount: 1 },
    { id: "d", text: "D", likes: 99, replyCount: 0 },
  ];
  const top = pickTopComments(list, 3);
  // 点赞优先 → d；同为 10 赞时回复多的 b 在前；a/c 回复数相同则保持上游顺序。
  assert.deepEqual(top.map(item => item.id), ["d", "b", "a"]);
  // 两次调用结果必须一致（同一份缓存读出来不能抖）。
  assert.deepEqual(pickTopComments(list, 3).map(item => item.id), ["d", "b", "a"]);
});

// ── 请求体 → 抓取目标 ────────────────────────────────────────────────────────

test("normalizeCommentTargets 兼容 videos 对象数组与裸 videoIds", () => {
  const fromVideos = normalizeCommentTargets({
    videos: [{ videoId: "v1", platform: "douyin" }, { videoId: "v2" }],
  });
  assert.deepEqual(fromVideos, [
    { videoId: "v1", platform: "douyin" },
    // 没给 platform 时回落到默认 douyin。
    { videoId: "v2", platform: "douyin" },
  ]);

  const fromIds = normalizeCommentTargets({ videoIds: ["a", "b"] });
  assert.deepEqual(fromIds.map(item => item.videoId), ["a", "b"]);
});

test("normalizeCommentTargets 去重：重复项会让付费请求打两遍", () => {
  const targets = normalizeCommentTargets({
    videos: [{ videoId: "same" }, { videoId: "same" }, { videoId: "other" }, { videoId: "" }],
  });
  assert.deepEqual(targets.map(item => item.videoId), ["same", "other"]);
});

test("normalizeCommentTargets 认 videoId 的多种写法，字符串项也接受", () => {
  const targets = normalizeCommentTargets({
    videos: [{ aweme_id: "byAwemeId" }, "plain-string", { id: "byId" }],
  });
  assert.deepEqual(targets.map(item => item.videoId), ["byAwemeId", "plain-string", "byId"]);
});

test("normalizeCommentTargets 空输入返回空数组，不抛异常", () => {
  assert.deepEqual(normalizeCommentTargets(), []);
  assert.deepEqual(normalizeCommentTargets({}), []);
  assert.deepEqual(normalizeCommentTargets({ videos: [] }), []);
});
