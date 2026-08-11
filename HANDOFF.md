# HANDOFF — 小芒AI 2.0 会话交接文档

> 本文档写给一个**完全没有上下文的新会话**。读完本文即可接手未完成任务。
> 项目路径：`/Users/ypc/Desktop/桌面 - ypc的MacBook Air/项目开发/小芒AI2.0/xiaomang2`
> Git 远端：`origin` = `git@github.com:spaceyzx216/xiaomang.git`（SSH，上游已设为 `origin/main`）
> 当前分支：`main`

---

## 一、本次会话总体任务

用户（项目方）提出了三个问题，前两个已完成并推送，第三个进行到一半被会话中断：

| # | 任务 | 状态 |
|---|---|---|
| 1 | 飞书多维表格权限：让互联网任何人获得链接都能编辑 | ✅ 已完成并推送 |
| 2 | 对标账号抓取：第4个及以后账号抓不到视频 | ✅ 已完成并推送 |
| 3 | 视频号自动生成分享链接（免手动逐个点击） | 🔶 进行中，代码尚未动，方案已明确 |

---

## 二、任务1：飞书多维表格权限（已完成 ✅）

### 背景
机器人用 `tenant_access_token`（应用身份）创建的多维表格/文档默认归属应用且不公开，导致：
- 外部/其他租户用户打不开链接
- 同租户用户只有只读权限，无法编辑

### 做了什么
在 `api/_lib/feishuClient.js` 新增 `setFeishuDocumentPublic` 函数，封装飞书「设置公开权限」接口：
- `PATCH /open-apis/drive/v1/permissions/{token}/public?type={bitable|docx}`
- 固定 `link_share_entity = "anyone_editable"`（互联网任何人获得链接均可编辑）
- **失败不中断导出主流程**，返回 `{ applied, error }` 标记

在 3 个接入点调用（仅对**新建**资源设权限，复用已绑定表格不覆盖）：
1. `createFeishuBitableForTask` — 创建新多维表格后
2. `writeFinalDraftToFeishuBitable` — 仅当 `appCreated === true` 时
3. `writeFinalDraftToFeishu` — 新建飞书文档(docx)后

### 提交
- commit `dfa2234e` — 已推送

### ⚠️ 用户需在飞书后台做的（代码无法完成）
应用必须开通权限点 `drive:drive` + `drive:permission`，并重新发布应用版本。否则权限接口返回权限不足，结果 `permissionApplied: false`。

---

## 三、任务2：对标账号抓取限制（已完成 ✅）

### 背景
用户反馈"对标账号一次性只能获取3个，第4个往后抓不到"。**视频号平台**，通过搜索确认5个账号后只获取了前3个的视频。无报错，结果列表里第4个及之后账号没有视频。

### 排查结论（重要！代码里没有"3个账号"限制）
我把对标账号抓取的**完整链路代码全部读过**（输入解析→搜索→确认→逐账号抓取→后端处理→结果合并→渲染），**确认代码里根本没有"只取3个账号"的硬限制**。账号数量在前后端都没有截断。

代码里出现的"3"是另外两个含义，**不要误以为是账号限制**：
- `MAX_TOPIC_SLICE_PAGES = 3`（`api/_lib/topicPagination.js:5`）：**单个账号**每次请求翻3页，有游标续拉机制会自动拉满
- `slice(0, 3)`（`App.tsx:350,355`）：调试用 JSON 预览面板截断，不丢数据
- `platformAdapters.js:232`：视频号搜索时每个账号取3条候选视频反查，与抓作品无关

### 真正根因
前端账号之间**零间隔连续请求**（`App.tsx:806` 只有 `setTimeout(0)`），触发 TikHub 上游限流。限流表现不是报错，而是返回空数据 → 代码判定 `upstream_exhausted`（作品已取尽）→ 账号作品数为0，看起来像"没抓到"。前3个正常是限流计数还没触发。

### 做了什么
在 `src/app/App.tsx` 的 `runTopicJobs` 函数中：
1. 新增常量 `TOPIC_ACCOUNT_THROTTLE_MS = 1500`（`App.tsx` 顶部，import 之后）
2. 跟踪 `lastAccountKey`，**切换到新账号时**等待 1.5s；同一账号的游标续拉不等待
3. 每个 job 处理后输出诊断日志 `console.info("[topic-fetch]", job.key, {...})`

### 提交
- commit `301f2af9` — 已推送

### 验证方式
用户需重新构建前端后，用5个对标账号测试，F12 控制台看 `[topic-fetch]` 日志：
- 第4、5个账号 `videosCount > 0` → 节流生效，问题解决
- 仍为0 → 不是限流，需看 `stopReason` 进一步排查
- 1.5s 不够可调大 `TOPIC_ACCOUNT_THROTTLE_MS`

---

## 四、任务3：视频号自动生成分享链接（进行中 🔶 — 下一步重点）

### 背景
视频号抓取到的视频，每条需要用户**手动点击"生成链接"按钮**，生成可访问的分享链接后才能查看和导出到多维表格。用户希望**自动化**这个操作，不用逐个点。

### 已查清的完整链路（不要重复探索，直接用）

**"生成链接"的本质**：视频号列表抓取接口 `fetch_user_videos` 不返回可直接分享的 `share_url`，每条视频要单独调一次 TikHub 的 `fetch_video_share_url` 接口才能拿到可访问链接。

**数据流**：
```
用户点"生成链接"按钮 (App.tsx:1751)
  → generateWechatShareLink(topic) (App.tsx:1064-1099)
    → POST /api/platform/topics/share-link  body: { platform:"wechat_channels", objectId }
      → vercel.json rewrite → api/platform.ts → platformRouter
      → handleTopicsShareLink (api/_lib/routers/platform.js:85)
      → fetchWeChatChannelsShareLink (api/_lib/platformAdapters.js:337-365)
        → TikHub POST /api/v1/wechat_channels/v2/fetch_video_share_url
            body: { object_id: <objectId>, raw: false }
        → 返回 { shareUrl } （读 data.share_url 或 data.feedH5Url）
  → updateTopicLink(topic.id, shareUrl) (App.tsx:1051-1062) → state + sessionStorage
  → window.open(shareUrl)  ← 注意：批量时绝对不能逐个弹窗
```

**关键字段**：抓取时 `normalizeWeChatChannelsTopic`（`platformAdapters.js:299-335`）已把 `source.objectId` 填入 topic。`fetchWeChatChannelsShareLink` 只需 `objectId` 一个参数即可调通。所以**前端拿到 tikhubResults 后，遍历所有 `platform==="wechat_channels" && !link && source.objectId` 的 topic 调接口即可，无需额外请求**。

**导出到多维表格时用的就是 `topic.link` 字段**（`feishuClient.js` 的"视频链接"列）。若没生成链接，该列为空。

### 下一步实现计划（方案已明确，代码未写）

**改动全部在 `src/app/App.tsx`，后端无需改**（`fetchWeChatChannelsShareLink` 已支持单条且只靠 objectId）。

1. **新增批量函数** `generateAllWechatShareLinks`（仿 `generateWechatShareLink`）：
   - 遍历 `tikhubResults` 里所有 topic，筛 `platform === "wechat_channels" && !topic.link && topic.source?.objectId`
   - **串行调用**（不要并发！TikHub 按次计费+限流），每条之间加节流间隔（参考任务2，用 `sleepMs` 或类似，间隔建议 1-1.5s）
   - 复用 `/api/platform/topics/share-link` 接口
   - 成功后调 `updateTopicLink(topic.id, shareUrl)` 写回
   - **不要调 `window.open`**（批量弹窗会被浏览器拦截 + 体验灾难）
   - 失败的条目收集起来，最后统一提示

2. **加载状态**：当前 `topicLinkLoadingId` 是单值 `useState<string|null>`（`App.tsx:518`），批量场景需新增一个批量加载状态，比如 `batchLinkLoading: boolean` + 进度计数（已处理/总数）

3. **UI 入口**：在选题列表 CardHeader 区域（`App.tsx:1598-1637`，"今日选题"卡片头部，排序按钮旁边）加一个"一键生成视频号链接"按钮。仅当 `sourcePlatform === "wechat_channels"` 且存在未生成链接的视频号 topic 时显示。

4. **节流常量复用**：`sleepMs` 函数已在 `App.tsx` 顶部定义（任务2加的），可直接复用。

### 实现注意事项（踩坑预防）
- **绝对不要并发**：TikHub 是按次计费的付费 API，代码里多处注释提到"浪费 API 余额"（`platformAdapters.js:501` 等）。串行 + 间隔。
- **`window.open` 只在单条手动点击时用**，批量函数里不要弹窗。
- **`updateTopicLink` 内部会 `persistTikhubResults` 写 sessionStorage**，批量循环里每条都调即可，已自带持久化。
- **`topicLinkLoadingId` 和批量加载状态不要冲突**：批量进行时，单条按钮应 disabled。
- **页面刷新后 rawData 会丢失**（`persistTikhubResults` 剔除 rawData 省空间），但生成链接只依赖 `source.objectId`（不依赖 rawData），所以刷新后仍可批量生成。
- **少数视频可能 objectId 为空**（上游列表接口三个 id 字段都缺时兜底为 `wechat_channels:${objectNonceId}`），`generateWechatShareLink` 已有兜底报错，批量时跳过这类即可。

---

## 五、踩过的坑（绝对不要再踩）

### 坑1：代码里没有的"限制"不要瞎改
任务2用户说"只能获取3个账号"，但代码里**根本没有这个限制**。如果盲目去找一个不存在的 `slice(0,3)` 并修改，会引入 bug。**遇到"限制"类问题，先彻底排查完整链路确认根因，再动手**。本次根因是上游限流（零间隔连续请求），不是代码上限。

### 坑2：npm cache 权限问题
跑 `npx tsc` 会报 `EACCES`（npm cache 目录有 root 文件）。**不要用 `npx`**，直接用本地 `node_modules/.bin/` 下的工具，或用 esbuild 验证语法：
```bash
node -e "require('esbuild').transformSync(require('fs').readFileSync('src/app/App.tsx','utf8'),{loader:'tsx'}); console.log('✅ OK');"
```
注意：这个项目的 `node_modules/.bin/` 里**没有 tsc**（用 Vite，不直接装 tsc binary）。

### 坑3：Git 远端配置
- 原始 `origin` 是 HTTPS（`https://github.com/spaceyzx216/xiaomang.git`），推送会失败（无权限）
- 已改为 SSH（`git@github.com:spaceyzx216/xiaomang.git`）
- 还有一个 `xiaomang-test` 远端（`git@github.com:spaceyzx216/xiaomang_test.git`），SSH key 对它无权限，**不要推到这里**
- `main` 分支上游已设为 `origin/main`，直接 `git push` 即可

### 坑4：BMAD skills 不要乱用
本会话有一堆 bmad-* skills 可用，但**这个项目不是 BMAD 工作流项目**，不要调用它们。

### 坑5：飞书权限 API 的 type 参数
- 多维表格传 `type=bitable`，token 是 `app_token`
- 文档传 `type=docx`，token 是 `document_id`
- `setFeishuDocumentPublic` 函数里已处理（`feishuClient.js` 约 L150）

### 坑6：探索 agent 可能遗漏
用 Explore agent 搜索时，它报告"代码里没有3个账号限制"是**正确的**，但它没有进一步定位运行时根因（限流）。需要自己读关键代码（`runTopicJobs` 的 `setTimeout(0)`）才能确认。**探索结论要自己验证关键点**。

---

## 六、关键文件速查表

| 文件 | 作用 | 本次改动 |
|---|---|---|
| `api/_lib/feishuClient.js` | 飞书多维表格/文档创建、写入、权限 | ✅ 新增 `setFeishuDocumentPublic` + 3个接入点 |
| `src/app/App.tsx` | 前端主页面：对标账号抓取、选题列表、生成链接 | ✅ 任务2节流；🔶 任务3待改 |
| `api/_lib/platformAdapters.js` | 视频号后端：搜索、抓取、生成分享链接 | 未改（任务3无需改后端） |
| `api/_lib/topicPagination.js` | 选题翻页逻辑（单账号内） | 未改 |
| `api/_lib/routers/platform.js` | 平台路由分发 | 未改 |
| `src/app/topicTimeWindow.ts` | 结果合并逻辑 `mergeTopicBatchResults` | 未改 |
| `src/app/ContentPage.tsx` | 内容页：导出到飞书、buildBenchmarkVideos | 未改 |

### 任务3需要改的具体位置（App.tsx）
- `generateWechatShareLink` 函数：`App.tsx:1064-1099`（参考模板）
- `updateTopicLink` 函数：`App.tsx:1051-1062`（写回链接，复用）
- `topicLinkLoadingId` state：`App.tsx:518`（单值，需加批量状态）
- `sleepMs` 函数：`App.tsx` 顶部（任务2加的，复用）
- UI 按钮位置：`App.tsx:1598-1637`（"今日选题"CardHeader，加"一键生成"按钮）
- 单条"生成链接"按钮：`App.tsx:1751-1774`（批量时需 disabled）

---

## 七、环境信息

- 平台：macOS (darwin 25.5.0 arm64)
- Shell：zsh
- Node 项目，前端 Vite + React + TypeScript，后端 Vercel serverless + 本地 Express（`server/index.js`）
- `.env` 已配置飞书凭证（`FEISHU_APP_ID/SECRET` 等，已 gitignore）
- 用户同时用本地 server 和 Vercel 线上两个环境
