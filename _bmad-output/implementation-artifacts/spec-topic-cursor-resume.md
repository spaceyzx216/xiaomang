---
title: '今日选题按游标断点续拉'
type: 'refactor'
created: '2026-07-11'
status: 'done'
baseline_commit: '99b3f4d9d7f9c86fb6cce1c82e6d3ee72177c8f0'
context:
  - '_bmad-output/project-knowledge/architecture.md'
  - '_bmad-output/project-knowledge/api-contracts.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 超过 7 天的第二阶段目前从第一页重拉 TikHub，重复付费且 730 天全量请求可能超过 Vercel 300 秒；中途 402 还会留下难以继续的不完整结果。

**Approach:** 三个平台都改成按账号、按少量页切片续拉；服务端返回下一上游游标及逻辑页位置，前端合并本片后从该游标继续，直到时间边界、上游耗尽、安全上限或错误。

## Boundaries & Constraints

**Always:** 最大 730 天；后续切片必须使用上次返回的 `last_buffer`、`max_cursor` 或 `cursor`，不得回第一页；每个 HTTP 请求只处理一个账号、至多 3 个作品页；保留边界页中仍在目标范围内的作品；只有逻辑第一页可忽略置顶旧作品；切片到达即去重合并并更新折叠组；保留现有 408/429/5xx 和网络退避重试；402 不重试、不自动重启，保留数据并从失败游标人工续试；Express 与 Serverless 等价。

**Ask First:** 引入数据库、队列、签名游标或新依赖；要求浏览器关闭后继续任务。

**Never:** 用 `daysFrom` 时间分片模拟跳页；续拉时重新解析已知账号并从第一页开始；失败时清空已到作品或勾选；单请求拉取全部账号的完整历史；记录上游游标日志。

## I/O & Edge-Case Matrix

| Scenario | Expected behavior | Error handling |
|----------|-------------------|----------------|
| 首次/正常切片 | 从当前游标取至多 3 页，立即合并；返回下一游标和逻辑页 | 沿用逐页重试 |
| 时间边界 | 保留本页范围内作品后完整停止 | `time_boundary` |
| 仍有更多 | 返回续拉状态，前端让出事件循环后继续 | `slice_limit`，非错误 |
| 中途 402 | 保留成功页，续拉状态指向失败页 | 停止自动续拉，显示余额提示与重试 |
| 其他最终失败 | 仅暂停该账号，其他账号继续 | 返回账号级错误及失败页状态 |

</frozen-after-approval>

## Code Map

- `api/_lib/topicPagination.js` -- 抖音/TikTok 起始游标、逻辑页与续拉元数据。
- `api/_lib/platformAdapters.js` -- 视频号 `last_buffer` 续拉和部分成功。
- `api/tikhub/batch.ts`、`server/index.js` -- 线上/本地短请求契约及账号标识复用。
- `src/app/App.tsx` -- 逐账号调度、增量合并、暂停和重试。
- `src/app/topicTimeWindow.ts` -- 续拉元数据的幂等合并。
- `tests/topic-time-window.test.mjs` -- 游标、边界和失败回归测试。

## Tasks & Acceptance

**Execution:**
- [x] `api/_lib/topicPagination.js`、`api/_lib/platformAdapters.js` -- 接受起始游标/页偏移，区分 `slice_limit`、完整终止和失败页，并返回下一续拉状态。
- [x] `api/tikhub/batch.ts`、`server/index.js` -- 接收账号级状态，复用 `secUserId`，限制单账号与 3 页。
- [x] `src/app/topicTimeWindow.ts`、`src/app/App.tsx` -- 移除两阶段重跑，逐账号循环切片，实时合并并支持失败游标重试。
- [x] `tests/topic-time-window.test.mjs` -- 覆盖矩阵且保留原有范围、折叠和合并回归。

**Acceptance Criteria:**
- Given 已到第 7 页，when 请求下一片，then TikHub 首次调用使用第 7 页返回游标，逻辑页为 8。
- Given 730 天和多个账号，when 渐进获取，then 每个应用请求仅含一个账号且最多调用 3 个作品页，完成账号不再请求。
- Given 任一片到达，when UI 合并，then 周分组立即可浏览，作品不重复且勾选保持。
- Given 402 或重试耗尽，when 用户重试，then 从失败页继续而非重跑第一页。

## Design Notes

续拉状态保存在页面结果及 `sessionStorage`，至少含平台游标、逻辑页偏移和已解析账号标识；本次不增加服务端持久化，关闭标签页后不保证后台继续。响应只携带本片作品，前端按账号和作品 ID 合并。

## Verification

**Commands:**
- `npm test` -- 分页、边界、错误与合并测试通过。
- `npm run build` -- 生产构建通过。

**Manual checks:**
- 分别用 7/730 天验证视频号和抖音：游标连续、周组渐进出现、402 后停止且可原位重试。

## Suggested Review Order

**渐进调度入口**

- 逐账号轮询短切片，正常切片自动续拉，失败账号独立暂停。
  [`App.tsx:770`](../../src/app/App.tsx#L770)

- 新任务建立可持久化作业，不再执行 7 天加全量重跑。
  [`App.tsx:826`](../../src/app/App.tsx#L826)

- 刷新后从轻量上下文恢复失败游标，人工重试原页。
  [`App.tsx:711`](../../src/app/App.tsx#L711)

- 首组统一显示余额、不完整状态和可用重试入口。
  [`App.tsx:1643`](../../src/app/App.tsx#L1643)

**游标与时间边界**

- 共享分页器接收起始游标和页偏移，并返回紧凑续拉状态。
  [`topicPagination.js:156`](../../api/_lib/topicPagination.js#L156)

- 仅目标时间上界触发停止，逻辑第一页保留置顶例外。
  [`topicPagination.js:95`](../../api/_lib/topicPagination.js#L95)

- 视频号用 `last_buffer` 实现相同三页切片契约。
  [`platformAdapters.js:378`](../../api/_lib/platformAdapters.js#L378)

**部署与成本保护**

- Serverless 单账号校验、25 秒超时和账号标识复用控制执行预算。
  [`batch.ts:17`](../../api/tikhub/batch.ts#L17)

- Express 镜像线上契约，保证本地与 Vercel 行为一致。
  [`index.js:105`](../../server/index.js#L105)

- 错误统一移除查询参数，避免游标进入日志。
  [`http.js:130`](../../api/_lib/contentAgent/http.js#L130)

**合并与回归**

- 跨切片合并作品、页数、命中数和续拉元数据。
  [`topicTimeWindow.ts:201`](../../src/app/topicTimeWindow.ts#L201)

- 验证视频号从保存的 `last_buffer` 继续。
  [`topic-time-window.test.mjs:371`](../../tests/topic-time-window.test.mjs#L371)

- 验证第 7 页游标进入逻辑第 8 页。
  [`topic-time-window.test.mjs:563`](../../tests/topic-time-window.test.mjs#L563)

- 验证错误和日志不包含游标查询参数。
  [`content-agent.test.mjs:488`](../../tests/content-agent.test.mjs#L488)
