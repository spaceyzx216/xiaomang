---
title: '今日选题自定义时间范围与渐进展示'
type: 'feature'
created: '2026-07-10'
status: 'done'
baseline_commit: '0ba58ec68b7efa59c8f287ce9bbbc9e198bfd937'
context:
  - '_bmad-output/project-knowledge/architecture.md'
  - '_bmad-output/project-knowledge/development-guide.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** 今日选题固定只展示近 7 天作品；扩大范围后，长请求和长列表还会拖慢反馈与渲染。

**Approach:** 抖音、视频号、TikTok 统一支持 1–90 天，以 7 天分组折叠；超过 7 天时先展示首周，再后台补齐旧作品，展开未完成分组时显示转圈动画。

## Boundaries & Constraints

**Always:** 默认 7 天，提供 7/15/30/90 快捷项和 1–90 整数输入；严格按发布时间过滤、去重并倒序；首周可立即浏览/勾选，旧组默认折叠；局部失败保留已到数据；复用现有前端及上游退避重试；Express 与 Serverless 等价；第一页的期限外置顶作品不得触发早停，存在下一页时至少再取一页确认，从第二页开始遇到期限外作品才按时间边界停止；上游耗尽即停止，命中安全上限时提示可能不完整。

**Ask First:** 支持 90 天以上；引入数据库、持久队列或新依赖；修改无关接口契约。

**Never:** 后台加载清空首周结果或勾选；预渲染所有折叠内容；移除重试；改动后续生成、编辑、导出流程。

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| 默认 | 7 天 | 一次获取并展示，不创建空旧组 | 沿用现有提示/重试 |
| 扩展 | 15/30/90 天 | 首周先显示；旧作品按 7 天进入后续折叠组，最后一组止于所选天数 | 保留已到内容 |
| 提前展开 | 旧组加载中 | 小型旋转动画；到达后自动显示 | 组内提供重试 |
| 非法或部分失败 | 非 1–90 整数；部分账号失败 | 非法值前后端拒绝；成功账号照常展示 | 4xx 不请求上游；失败账号可重试 |

</frozen-after-approval>

## Code Map

- `src/app/App.tsx` -- 范围控件、两阶段获取、周折叠、加载/失败状态与缓存。
- `src/app/topicTimeWindow.ts` -- 范围校验、分组、跨阶段去重合并。
- `api/_lib/platformAdapters.js` -- 视频号按时间边界分页和完整度元数据。
- `api/tikhub/batch.ts`、`server/index.js` -- 抖音/TikTok 的 Serverless/本地分页对齐。
- `tests/topic-time-window.test.mjs` -- 边界、早停、合并与部分失败测试。

## Tasks & Acceptance

**Execution:**
- [x] `src/app/topicTimeWindow.ts` -- 实现可测试的范围、分组、合并纯函数。
- [x] `api/_lib/platformAdapters.js`、`api/tikhub/batch.ts`、`server/index.js` -- 三平台按天数翻页、时间早停、完整度提示，并保留逐页上游重试。
- [x] `src/app/App.tsx` -- 增加范围控件；超过 7 天先取首周再后台取完整范围；旧组折叠、旋转加载、失败重试，长列表延迟渲染。
- [x] `tests/topic-time-window.test.mjs` -- 覆盖矩阵中的边界和异步合并行为。

**Acceptance Criteria:**
- Given 任一支持平台，when 选择 15/30/90 天获取，then 近 7 天先可操作，旧作品随后无重复进入对应组。
- Given 旧组仍在获取，when 立即展开，then 显示非阻塞转圈状态，数据到达后自动展示。
- Given 网络错误或 408/429/5xx，when 未超过现有重试次数，then 沿用退避重试；最终失败仅影响对应账号/旧组。
- Given 折叠或视口外有大量作品，when 浏览、排序、勾选，then 不承担全部布局绘制成本且交互保持响应。
- Given 本地与 Serverless 等价请求，when 完成，then 窗口、早停和完整度提示一致。

## Design Notes

7 天桶兼容旧默认并让 15/30/90 天形成可理解分组。首周完成即渲染，完整范围后台继续；第二阶段按账号和作品 ID 幂等合并，重试不会重复卡片或清空选择。

## Verification

**Commands:**
- `npm test` -- Node 测试通过。
- `npm run build` -- Vite 构建通过。

**Manual checks (if no CLI):**
- 验证 7/15/30/90 天首周优先、折叠加载、自动展示、局部重试、勾选保持和窄屏布局。

## Suggested Review Order

**渐进获取入口**

- 首周先展示，完整时间窗在后台合并且失败不清空已有结果。
  [`App.tsx:543`](../../src/app/App.tsx#L543)

- 90 天控件与自定义整数输入绑定同一范围状态。
  [`App.tsx:1093`](../../src/app/App.tsx#L1093)

**分页边界与可靠性**

- 第一页忽略旧置顶，第二页起确认时间边界并保留部分成功页。
  [`topicPagination.js:128`](../../api/_lib/topicPagination.js#L128)

- 视频号采用相同首屏例外、重复页推进和不完整结果标记。
  [`platformAdapters.js:367`](../../api/_lib/platformAdapters.js#L367)

- Serverless 入口校验 1–90 天并复用共享分页器。
  [`batch.ts:19`](../../api/tikhub/batch.ts#L19)

- Express 入口保持与 Serverless 相同的请求和结果语义。
  [`index.js:105`](../../server/index.js#L105)

**前端分组与合并**

- 严格范围校验并按天数动态提高分页安全额度。
  [`topicTimeWindow.ts:34`](../../src/app/topicTimeWindow.ts#L34)

- 以七天为桶生成最多十三个可折叠分组。
  [`topicTimeWindow.ts:90`](../../src/app/topicTimeWindow.ts#L90)

- 后台成功、部分失败和重试都做账号级幂等合并。
  [`topicTimeWindow.ts:186`](../../src/app/topicTimeWindow.ts#L186)

**回归测试**

- 覆盖第一页旧置顶仍继续翻页的核心规则。
  [`topic-time-window.test.mjs:118`](../../tests/topic-time-window.test.mjs#L118)

- 覆盖后续页失败时保留已获取作品。
  [`topic-time-window.test.mjs:167`](../../tests/topic-time-window.test.mjs#L167)

- 覆盖视频号的旧置顶、重复页与部分失败。
  [`topic-time-window.test.mjs:184`](../../tests/topic-time-window.test.mjs#L184)
