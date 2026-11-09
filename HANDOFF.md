# HANDOFF — 小芒（合并后项目）

> 本文档写给一个**完全没有上下文的新会话**，请以本文为准。
>
> **项目路径：`/Users/ypc/Desktop/归档项目/xiaomang`**
> （文档就在这个目录的根下，你已经在正确的地方了。）
>
> ## 这是什么项目
>
> 原本是**两个独立项目**，2026-09-22 已**合并成一个**：
>
> | 原项目 | 现在的位置 |
> |---|---|
> | `xiaomang2`（员工端 + 账号定位，3 模块 2 层） | `apps/web/src/app` + `apps/server/api` |
> | `ai-project-assistant-main`（项目经理站：客户/任务/员工/IP档案） | `apps/web/src/manager` + `apps/server/src/manager` |
>
> 合并前快照：`../xiaomang-merge-backups/20260922-165556/*.tar`。
> 两个原目录（`../xiaomang2`、`../ai-project-assistant-main`）仍在，但**都是旧副本，不要再开发**。
>
> ## 五分钟上手
>
> ```bash
> cd /Users/ypc/Desktop/归档项目/xiaomang
> npm test               # 期望 634 passed / 0 failed
> npm run build          # 期望成功（⚠️ vite build 只转译，**不做类型检查**，见 §0.9-E-1 / §0.10-E-1）
> npm run verify:render  # 期望 30 passed / 0 failed（前端真渲染检查，见 §0.13）
> npm run verify:routes  # 期望 330 passed / 0 failed（需要本地 MongoDB）
> npm run dev            # Express(8787) + Vite；⚠️ Vite 只监听 [::1]:5173（IPv6），
>                        #    `curl 127.0.0.1:5173` 连不上不代表服务没起
> ```
>
> - **一个前端**（`apps/web`，React 18 + Vite + Tailwind）：`/manager/*` 经理端、
>   `/topics`·`/content`·`/publish-warehouse`·`/final-editor` 员工侧。
> - **一个后端**（`apps/server`，Express + 原生 mongodb 驱动）：员工/定位 API 在
>   `src/index.js` + `api/**`；经理端在 `src/manager/*`（挂在 `/api/management/*`）。
> - **一个库**：本地 MongoDB（`127.0.0.1:27018`，Docker 容器 `xiaomang-local-mongo-1`），
>   20 集合 / 366 文档，已从线上 Atlas 迁移完成。
> - **`.env` 在 `apps/server/.env`**（不在根目录）—— 从根跑脚本读不到 `MONGODB_URI`，
>   这不是 bug 是 workspace 结构。
> - ⚠️ **工作树很脏且混了三轮改动**：`git status` 有 **31 改 + 25 项新增**（其中两项是目录），
>   既有 §0.9 的选题轮、又有**腾讯云部署轮**、还有本轮的复盘轮（见 §0.10-F）。提交前先分开。
>
> ## 🔴 最新进度看 §0.16（最终草稿/飞书导出修复已部署）；业务详情看 §0.15/§0.12/§0.13
>
> 最近一轮是 **§0.16 最终草稿按选题保存/用户隔离与飞书多记录导出部署**（2026-10-20），包含 10-19 的发布仓勾选修复、现有周度复盘、表单/AI Excel 识别及 10-18 的流式 ASR 改动。
> 服务入口为 **`https://124.223.15.17/`**；用户确认域名暂缓，先使用 IP。最新发布、回滚与证书记录见 **`docs/DEPLOY.md` §0**。
> §0.11 是 2026-10-09 从零重建的历史记录，其证书日期和数据库数量已更新，勿作为当前值使用。
> §0.10-D 的「4.2 尚未实现」已由 §0.12 更新；其他旧业务待办需按各节核实。
>
> 上一轮（**复盘分析模块 4 的一期：4.1 单条视频数据分析**）的待办与卡点在 **§0.10-D**。
> ⚠️ **部署轮已经做完了，但 §0.9 及更早的正文完全没记** —— 见 **§0.10-C**，
> 在信那些章节之前先看这一节。
>
> 安全上仍有一条没做：**轮换 / 停用 Atlas 密码**（见 §0.7）。
> git 历史里的明文凭据已清除、并装了提交前扫描钩子；但**当前仍在用同一个密码**。
> 本机库已是主库，Atlas 只是历史来源，直接停用那套凭据也可以。
>
> ## 各节导读
>
> - **`docs/PRD.md`** 全项目产品需求基线（2026-10-14）：122 条用户故事、25 个验收场景，区分现有能力与待验收事项
> - **§0.16** 最终草稿按选题保存/用户隔离、飞书多记录导出更新部署（**最新进度**）
> - **§0.15** 发布仓选择/草稿修复更新部署、回滚与验证
> - **§0.14** 服务器更新部署、真实模型验收、回滚资产
> - **§0.13** 4.1/4.2 直接填表与 AI 识别 Excel
> - **§0.12** 周度账号分析 4.2、确认记忆与上游回流
> - **§0.11** **重新部署到腾讯云（服务器被重装后从零重建）**（部署进度）
> - **§0.10** 第十一轮：复盘分析模块 4（4.1 落地）+ 腾讯云部署补记
> - **§0.9** 第十轮：选题生成页大修
> - **§0.8** 第九轮：发布仓 3.1～3.3 落地 + 一类出图打通
> - **§0.7** 第八轮修复结果 + code review（四项问题全部已修）
> - **§0.6** 合并后的审查结论（四项问题的原始证据）
> - **§0.5** 架构合并方案（已按其执行，保留作背景）
> - §0.3 发布仓（封面/发布文案/发布标签）· §0.4 1.3 权限按客户开放
> - §0.2 大类配比回流二创 · §0.0 打标签体验改造 · §0.1 选题库口径
> - §7 接手后的第一步 · §6 绝对不要再踩的坑 · §8 当前基线（**第八轮快照，数字已过期，见 §0.10**）

---

## 0.16 最终草稿按选题保存/用户隔离与飞书多记录导出更新部署（2026-10-20）

正式入口仍为 **`https://124.223.15.17/`**。本次把最终文案草稿从「全局 append 一坨文本」改成按 `ownerId|customerId|taskId|topic.id` 归一化 upsert，并做用户隔离；`/api/final-drafts` 系列全部要求登录，列表按 owner 过滤、按客户/任务筛选。飞书文档/多维表导出支持一次导出多条已保存记录（发布仓/内容页），单条草稿旧调用兼容；同时带上发布仓勾选/草稿与最终编辑的修复。

- 发布标识 `20261020T0640Z`，镜像 `xiaomang-app:release-20261020T0640Z`（`sha256:30b95f2d81d34b021c1dd12bf597f6afc35027708c2f245b1b6f41392aed9705`），源码包 SHA256 `bb54c7080fc5d6f6b1a4558ffd9a9e80157d5dde8c318a730ce89dec7d6470b9`；版本记录 `/opt/xiaomang/deployment-current.json`，切换时间北京时间 15:08。
- 只重建 app；mongo/nginx 未动，`app.env`/`mongo.env` 逐字节一致（SHA256 校验通过）。正式库切换前后均为 **22 集合、831 条记录**，逐集合一致；测试只写独立临时库并已删除。
- 部署前 **667 单测 / 339 路由 / 30 渲染** 全过；新镜像独立临时库冒烟通过。部署后公网 `/`、`/health`、`/health/ready` 200，新资产 `assets/index-CMpVgb12.js` 200，未登录 `/api/final-drafts`、`/api/management/employees` 均 401；Chrome 无头浏览器登录页正常渲染。
- 回滚：**已按用户要求全部清理**（2026-10-20 15:15～15:20）。`/opt/xiaomang-rollbacks/` 已空；`/opt/xiaomang-releases/` 只保留 `20261020T0640Z`；旧镜像（`c5a21c83a0ae`、`a45908f33a51`、`2b4c07401bcd`、`bd3e3c2ec493`、`fc13fbbfce8b`）与 Docker 构建缓存（约 6.4GB）已删除。磁盘 15GB→**7.3GB 已用（19%，余 33GB）**。当前版本**没有代码回滚点**，`/opt/xiaomang/deployment-current.json` 的 `previous`/`rollback` 已置空、`cleanup` 记录删除清单；清理后容器 healthy、公网与健康检查 200、401 边界正常。
- 注意：仓库 `apps/**` 文件是 **CRLF** 行尾；服务器既有副本是 LF。本次按源码包原样同步代码目录、未覆盖 `deploy/`；下次改代码后仍建议先跑 `npm test` + `verify:routes` + `verify:render`。

完整记录见 `docs/DEPLOY.md` 最新 §0。本轮未修改用户业务代码、未提交 Git。

---

## 0.15 发布仓选择与草稿修复更新部署（2026-10-19）

用户修复提交 `addc7e0` 已随当前工作区发布，正式入口仍为 **`https://124.223.15.17/`**。发布仓勾选立即生效、按选题串行保存，失败草稿可在切换选题/刷新后恢复并重试；后端局部保存不再清空其他板块，封面勾选不重传图片，最终编辑等待未完成保存。

- 发布镜像 `xiaomang-app:release-20261019T0516Z`，镜像 ID `sha256:a45908f33a517c7f4e3475a3bf924584aaf6cff20b1663edb54e56622c31e22c`；切换时间为北京时间 13:20。版本记录 `/opt/xiaomang/deployment-current.json`。
- 仅重建 app，正式 `app.env` / `mongo.env` 逐字节保留，原有流式 ASR 配置不变。mongo/nginx 容器未重建，nginx 配置检查后重载。
- 回滚执行 `sh /opt/xiaomang-rollbacks/pre-20261019T0516Z/rollback.sh`，恢复 10-18 版应用与配置，保留当前数据库/数据卷。旧镜像、源码/配置、数据库和应用数据已备份校验，数据库在独立库实际恢复 825 条、零失败；开发机 `.deploy/rollbacks/pre-20261019T0516Z/` 有额外副本。
- 正式数据库部署前后均为 **22 集合、825 条记录**，逐集合计数一致。测试仅用独立库，测试库/容器/临时高权限配置已清理。
- 本轮 634 单测、330 路由、30 渲染及构建通过；服务器新镜像真实浏览器验证即时勾选、快速连选、跨板块保存、失败保留/刷新恢复/重试、最终编辑接收最新选择；3 秒流式 ASR 冒烟通过。公网证书可信，新资产、健康接口与 401 边界正常，桌面/手机无运行错误。
- IP 证书有效至 **2026-10-23 09:01（北京时间）**，自动续期/日常备份继续。域名按之前用户决定暂缓。

完整记录见 `docs/DEPLOY.md` 最新 §0。本轮未修改用户业务代码、未提交 Git；原有工作区改动完整保留。

---

## 0.14 当前项目部署与回滚保留（2026-10-14）

已部署当前工作区，包括 4.2 周度账号分析、经理确认记忆与二创/选题回流，以及 4.1/4.2 表单和 AI Excel 导入。公网 **`https://124.223.15.17/`** 实测 200、数据库健康，真实浏览器正常且证书可信。用户确认没有香港/境外服务器，本次先完成部署并保留 IP 入口；现有 `xiaomang.cloud` 解析正确，但公网存在腾讯云未备案拦截，不改 DNS、不购买新资源。

- 服务器运行 OpenCloudOS 9.6，2 vCPU、约 1.9GB 内存、40GB 磁盘。正式目录 `/opt/xiaomang`，应用、Mongo、nginx 三容器。只切应用镜像，正式密钥配置逐字节保留。
- 发布标识 `20261014T0950Z`；镜像 `xiaomang-app:release-20261014T0950Z`，ID `sha256:bd3e3c2ec493a8ef0c6bd894ae3617c707bc3a45978192b29b7714672179c546`；发布记录 `/opt/xiaomang/deployment-current.json`。
- 回滚目录 `/opt/xiaomang-rollbacks/pre-20261014T0950Z` 保留旧源码/配置、镜像、数据库、应用数据和证书配置。回滚执行 `sh /opt/xiaomang-rollbacks/pre-20261014T0950Z/rollback.sh`，保留当前业务数据。备份 SHA256 通过，独立库实际恢复 685 条、零失败；开发机 `.deploy/rollbacks/` 另有数据与配置备份，不进 Git。
- 切换前后正式数据库均为 17 个集合、685 条记录。未覆盖历史数据，测试只写独立验收库，测试库/容器及临时凭据已清理。
- 部署前 576 单测、330 路由检查、30 渲染检查及构建通过。服务器新版镜像真实浏览器验证了登录、单条填表分析保存、**真实模型**识别带说明的 Excel 并从原表取值、周度填表统计、保存/预览/确认及桌面/手机布局。公网登录页、新版资产、健康检查、401 边界均正常。
- IP 证书已自动续期，当前到期时间为 **2026-10-20 01:01（北京时间）**，下一 ARI 窗口为 **2026-10-16 16:04**；原有每日三次续期和每日备份保留。

完整部署/回滚说明与验证记录见 `docs/DEPLOY.md` §0。真实 AI 的本次验收样例通过，但其他业务表格、模型建议质量与真实平台二创效果仍需业务验收；既有类型错误尚未修复。本轮未提交 Git。

---

## 0.13 复盘表单与 AI 识别 Excel（2026-10-10）

4.1 单条视频、4.2 周度账号分析均默认直接填写，不再要求先上传 Excel。4.2 可以添加、删除视频；两页共用视频信息、平台指标和结构标签表单。切换平台读取后端字段口径，避免把抖音字段混入视频号。

- Excel 导入保留原有手工列映射，新增「AI 识别并填入表单」。支持表头前有说明、常规逐行视频表和横向逐列视频表；4.1 可选择识别出的某条视频，4.2 导入全部有效记录。导入后可逐项修改，再生成分析。
- AI 只返回字段及行列位置，后端从原始单元格取值，校验字段、索引、重复映射、百分比/万单位；缺失指标保留空白、真实零值保留。汇总行跳过并提示，识别结果显示来源和待核对提示。Excel 日期序号转为日期，带百分比格式的数字保持百分比含义；旧读取入口的默认行为不变。
- 新增鉴权接口 `/api/review/workbook-recognition`：GET 返回对应平台表单字段，POST 识别指定工作表。Express 与 Vercel 共用 `reviewWorkbookRecognition.js`；使用现有内容 AI 配置，无新增运行依赖。AI 失败提示手动填表或列映射，已有表单数据保留。
- 一次最多 120 条视频；AI 识别工作表最多 600 行、80 列，提示词有采样及长度限制。支持 `.xlsx` / `.xlsm`，旧 `.xls` 需另存。周报保存、经理确认配比及下一轮复用延续 §0.12。

核心前端文件：`ReviewVideoFields.tsx`、`ReviewWorkbookImport.tsx`、`reviewInputApi.ts`、`reviewInputRows.ts`，由 `VideoAnalysisStage.tsx` 与 `WeeklyAnalysisStage.tsx` 共用；使用说明见 `docs/WEEKLY-REVIEW.md`。

当前验证基线：**576 单测 / 330 路由冒烟 / 30 渲染检查，均通过**；Vite 构建通过。独立测试库中真实浏览器已验证两页直接填表、AI 导入有前置说明的 Excel、单视频选择、手工映射、导入后修改数据、识别失败保留表单、切换平台、分析保存、配比预览与确认；桌面及 390px 手机宽度无溢出或运行错误。

AI 导入端到端使用本地模拟模型返回字段位置，实际 Excel 读取、取值与后续分析走真实后端；未调用真实模型额度，实际识别质量仍需用业务 Excel 验收。临时 TypeScript 检查中本轮文件无错误，旧模块仍有 8 处错误，全项目类型检查未通过；原有构建包体积警告仍在。

**本轮未部署、未提交**，保留工作树原有部署改动。

---

## 0.12 周度账号分析 4.2（2026-10-10）

已实现「一周 Excel → 类型标签拆解 → 周报 → 下周配比 → 经理确认 → 选题筛选与二创复用」闭环。入口为经理端账号定位的复盘分析模块 4.2；详细使用流程、算法与生效范围见 **`docs/WEEKLY-REVIEW.md`**。

- 共用 4.1 的 Excel 解析、抖音/视频号标准值与四个流量池。严格拆分 `>1000`、`<1000`、`=1000`，展示每日趋势、前一周环比、大小类和三秒/标题/结尾类型的样本与表现。
- 配比数字由后端确定性计算、归一化及换算条数。报告中说明调整算法；小样本弱证据和缺失标签明确提示。AI 补标签、结合真实文案解释反馈及优化建议，失败时数据统计和配比仍可用。
- 保存报告不激活。经理修改配比、预览条数、补充经验后确认，产生独立版本与生效指针。旧请求重试不能覆盖新版本，也不能复活停用版本。
- 生效范围为 **客户 + 平台**，同一范围一个版本；账号名称用于报告与环比。同平台多个自有账号需分别绑定客户。员工只读生效方案；按大小类配额勾选候选并报告缺额，二创优先采用对应大类的各结构配比与确认经验。原始选题库统计不被改写。
- 新增 API：`/api/review/weekly`、`/api/weekly-analysis-reports`、`/api/review-memory`，Express/Vercel 共用 `weeklyRoutes.js`。新增三个 Mongo 集合与自动创建的唯一索引，详见使用文档。

验证基线：**568 单测 / 322 路由冒烟 / 23 渲染检查，均通过**；Vite 构建通过。真实浏览器在独立测试库中跑通 Excel 上传、分析、保存、预览、确认、停用，桌面及 390px 手机宽度无页面溢出或运行错误。测试库和临时服务已清理。

验证边界：真实 AI 额度未调用，端到端刻意验证 AI 失败降级；实际模型建议质量与下一轮真实平台二创效果仍待验收。临时 TypeScript 检查中本轮文件无错误，旧模块仍有 8 处错误，全项目类型检查未通过。已有大包体积警告仍在。

**本轮未部署、未提交**。工作树还包含原有部署改动，交付时不要把它们当作本轮修改覆盖。业务后续可用真实账号 Excel 与模型配置验收，再部署。

---

## 0.11 🚀 重新部署到腾讯云（**服务器被重装后从零重建**）（2026-10-09）

> 自包含。完整手册在 **`docs/DEPLOY.md`**（含全部运维命令与实测记录），本节只讲
> 「新会话接手必须知道的事」。

### 0. 三十秒结论

**服务已上线并验证通过：`http://124.223.15.17/`**（公网实测 200，真实浏览器渲染正常）。

- ⚠️ **服务器被重装过** —— `124.223.15.17` 的 SSH 三个主机密钥全变、磁盘从 13.4G 回到
  3.4G、`/opt` 为空、宝塔面板与 `/www` 全没。**上次部署（含容器、Mongo 数据、nginx、
  Let's Encrypt 证书）已全部消失**，本次是从零重建。
- ⚠️ **数据只恢复到 2026-09-22 的快照（225 文档）**。上次部署曾迁过一份更新的
  （20 集合 / 366 文档），**那份备份不在开发机上**，服务器上也没了 —— 要那版只能另找。
- ✅ **HTTPS 已启用**：`https://124.223.15.17/` **公网可达**（Let's Encrypt 的 IP 证书，从外网
  不加 `-k` 也校验通过），`http://` 一律 **301** 跳过去，避免密码明文过公网。
  ⚠️ 但 IP 证书**只有 6 天有效期**（Let's Encrypt 的 `shortlived` profile），
  这是整套方案最脆的点 —— 见 D-1。
- 🔴 **登录方式有两条，且数据不互通**（业务数据按 `managerId` 隔离）：
  - **A. 原账号** `2146986718@qq.com` —— 能看到已恢复的历史数据，但**密码是 bcrypt 哈希、
    不可反推**，且项目**没有找回/改密接口**，只能靠用户自己记得；
  - **B. 邀请码注册新号** —— 邀请码 **`<从服务器私有文件读取>`**（一次性，已存服务器
    `/opt/xiaomang/.invite-code`），但新号是**空工作台**。

### A. 这一轮在做什么（一句话）

把合并后的小芒重新部署到重装过的腾讯云 CVM 上，并补齐「全新空库根本没人能注册」
这个会锁死系统的缺口。

### B. ✅ 已完成（按「用户能看到什么」列）

| 用户能看到什么 | 证据 |
|---|---|
| 打开 `http://124.223.15.17/` 就是小芒登录页 | 公网 200 + 无头 Chrome 渲染（标题/2 输入框/2 按钮/中文文案全对，零应用级报错） |
| 历史数据在里面（5 客户 / 5 任务 / 163 条口播稿…） | 库内 225 文档，`users`/`customers`/`employees` 唯一索引已建 |
| 能注册新账号 | 用**一次性测试邀请码**跑通注册 → 201 + Cookie → `/api/auth/me` 200；测试数据已清理 |
| 每天自动备份 | 实测产出 219KB 归档 + sha256 通过；`/etc/cron.d/xiaomang-backup` |
| 重启后服务自己回来 | `systemctl restart docker` 后 3 容器 5 秒内自愈，`RestartCount=0` |
| 能用 HTTPS 打开（浏览器不报警） | 公网 `https://124.223.15.17/` → 200，`ssl_verify_result=0`，从外网 `openssl` 校验 `0 (ok)`；`http://` → 301 |

### C. 🔴 本轮新增的文件（都是可复现的资产，别删）

| 文件 | 作用 |
|---|---|
| `docs/DEPLOY.md` | **当前环境的部署手册**（权威，先看这个） |
| `deploy/compose.cvm.yml` | 腾讯云覆盖：换 Debian 源 + 发布 443 + 挂 ACME/证书目录 |
| `deploy/compose.server.yml` | 聚合 `compose.yml + compose.cvm.yml`，供 `backup.sh`/`restore.sh` 用（它们只收单个 `-f`） |
| `deploy/cron/xiaomang-ip-cert` | 证书续期（每天 02/10/18 点） |
| `deploy/cron/xiaomang-backup` | 每日 03:00 备份 |
| `deploy/cron/xiaomang-logrotate` | 两个日志的轮转（防写满 40G 盘） |
| `apps/server/scripts/import-migration-dump.mjs` | 把 `.ejsonl` 历史备份导回库（**只写空集合，不覆盖**） |
| `apps/server/scripts/seed-invite-code.mjs` | 种邀请码（见 D-1） |
| `deploy/nginx.conf` | 改为双 server 块：80（应用 + ACME）+ 443（TLS） |

> `docs/DEPLOY-TENCENT.md`（9/28 那份）描述的是**已被重装的旧机器**，已在文首加过期提示；
> 其中**§7「域名为什么被腾讯云拦」的分析仍然成立**（备案策略，与机器无关）。

### D. 🔴 卡在哪 / 待办（按优先级）

1. **种邀请码是硬需求，不是可选优化** —— `registerManager()` 强制校验邀请码，而邀请码只存
   bcrypt 哈希、`index.js` 里**没有任何创建邀请码的接口**。**空库 = 整个系统谁都进不去。**
   加人时要再种：`docker exec -u root -w /app xiaomang-app-1 node apps/server/scripts/seed-invite-code.mjs <明文> [maxUses]`
2. **盯住证书续期（6 天有效期，最脆的一环）** —— 当前证书 2026-10-16 到期，下次续期窗口
   **2026-10-12**（ARI 决定）。续期 cron 已装（每天 02/10/18 点）且**只走 80 端口**。
   若续期连续失败，6 天后 HTTPS 失效 → 因为 80 跳 301，**站点会整体打不开**。
   应急回退步骤见 `docs/DEPLOY.md` §6.2（把 80 的 301 换回普通反代即可退回 HTTP）。
   排查：`cat /var/log/xiaomang-ip-cert.log`
3. **确认原账号能否登录** `2146986718@qq.com`。不可登录时要么运维直接改库里该用户的
   `passwordHash`，要么用邀请码注册新号（空工作台）。
4. 服务器 root 密码本次以明文传递过，**建议轮换**。
5. 内存 1.9G 偏紧（当前可用约 1.1G）；40G 盘用 8.1G，其中 Docker 构建缓存 2.09G 可 `docker builder prune` 回收。

### E. 🔴 绝对不要再踩的坑（本轮新增，每条都带症状）

| # | 症状 | 根因 | 处置 |
|---|---|---|---|
| 1 | `dnf install docker-ce` 404 | OpenCloudOS 报 `releasever=9.6`，docker-ce 仓只有 `9` 目录 | `sed -i 's/$releasever/9/g' /etc/yum.repos.d/docker-ce.repo` |
| 2 | 源码目录混入大量 `._*` 文件 | macOS `tar` 打包 AppleDouble 扩展属性 | 打包加 `COPYFILE_DISABLE=1`，落盘后 `find -name "._*" -delete` |
| 3 | 数据导入了但**唯一索引没建** | manifest 里索引键是**规范 EJSON**（`{"$numberInt":"1"}`），`createIndex` 只收普通数字 | 导入脚本先 `BSON.EJSON.parse` 解回来（已修） |
| 4 | `restore.sh` 用不了 `.migration` 备份 | 它只认 `mongodump --archive`，而 `.migration` 是 `.ejsonl` + manifest | 用新写的 `import-migration-dump.mjs` |
| 5 | `backup.sh` 报找不到 mongo 容器 | 只收单个 `-f`，而本机要叠两个 compose 文件 | `compose.server.yml` 用 `include` 聚合，并**显式写 `name: xiaomang`** |
| 6 | nginx 写了 `listen 443 ssl`，外面仍连不上 | `compose.yml` 只发布了 `80:80`；**容器监听 ≠ 宿主发布端口** | `compose.cvm.yml` 补 `ports: ["443:443"]` |
| 7 | **误判「安全组没放行 443」**（本次真的误判过一轮） | 第 6 条那个状态下，从外网 `nc -z ... 443` 同样不通 —— **「宿主没监听」和「被安全组 DROP」表现一样**，只看外网连通性会得出错误结论 | 判端口是否被安全组拦，**先 `ss -tlnp` 确认宿主有没有在监听**；只有「宿主在监听 + 外网不通」才是安全组问题 |
| 8 | ACME 验证路径返回 index.html / 或 404 | ① SPA 反代的 `location /` 把 `/.well-known/...` 也吞了 → ACME location 必须**排在** `location /` 之前；② 自己测的时候忘了 `cd`，探针文件建到了 `/root/` 而不是挂载目录 | ACME location 前置；测的时候用**绝对路径**写探针文件 |
| 9 | 装了 acme.sh 但卡住不动 | `raw.githubusercontent.com` 从该机器不通（`get.acme.sh` 本身通） | 改从 gitee 镜像取：`https://gitee.com/neilpang/acme.sh/raw/master/acme.sh` |

### F. 怎么验证（命令 + 期望数字）

```bash
# 公网可达（从任意外部机器）
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}\n" http://124.223.15.17/   # 期望 301 -> https://124.223.15.17/
curl -sL -o /dev/null -w "%{http_code}\n" http://124.223.15.17/                    # 跟随跳转后期望 200
curl -s -o /dev/null -w "%{http_code} ssl=%{ssl_verify_result}\n" https://124.223.15.17/  # 期望 200 ssl=0（不加 -k）

# 容器与健康
ssh root@124.223.15.17 'cd /opt/xiaomang/deploy && docker compose -f compose.yml -f compose.cvm.yml ps'
ssh root@124.223.15.17 'curl -s http://127.0.0.1/health/ready'          # {"status":"ok"}

# 库内计数
ssh root@124.223.15.17 'docker exec -u root xiaomang-mongo-1 mongosh --quiet \
  --username xiaomang_admin --password "$(grep ^MONGO_INITDB_ROOT_PASSWORD /opt/xiaomang/deploy/mongo.env | cut -d= -f2)" \
  --authenticationDatabase admin --eval "const d=db.getSiblingDB(\"xiaomang\"); print(d.users.countDocuments()+\"/\"+d.customers.countDocuments()+\"/\"+d.tasks.countDocuments())"'
# 期望 1/5/5

# ACME 验证路径（续期的命脉：必须是 200 且**不被 301**）
ssh root@124.223.15.17 'D=/opt/xiaomang/deploy/acme-webroot; mkdir -p $D/.well-known/acme-challenge; \
  echo ok > $D/.well-known/acme-challenge/t.txt; \
  curl -s -o /dev/null -w "%{http_code} redirect=%{redirect_url}\n" http://127.0.0.1/.well-known/acme-challenge/t.txt; \
  rm -f $D/.well-known/acme-challenge/t.txt'
# 期望 200 redirect=（空）
```

### G. 下一会话第一步（建议顺序）

1. 先跑 **F** 的三条命令 —— 确认服务还活着、数据还在、计数是 `1/5/5`。
2. 查**证书续期有没有成功**（6 天有效期是最脆的一环）：`cat /var/log/xiaomang-ip-cert.log`，
   并确认 `openssl x509 -in /etc/ssl/xiaomang-ip/fullchain.pem -noout -enddate` 的到期时间已往后滚。
   失败时按 `docs/DEPLOY.md` §6.2 应急回退。**别让 80 的 301 在证书失效时把站点整体锁死。**
3. 问用户**能否登录原账号** —— 这是「看到历史数据」的唯一入口（§0.11-D-3）。
4. 之后再回到 §0.10-D 的**业务待办**（复盘分析模块 4 等）。本轮只动了部署，没动业务代码。

---

## 0.10 ✅ 第十一轮：复盘分析（模块 4 / 4.1 落地）+ 腾讯云部署补记（2026-09-30）

> 自包含。读完这一节就能接手，不必先读 §0.9 及以前。
> ⚠️ 本项目文档有「反复滞后于代码」的前科（**这一轮又抓到一次，见 C**），关键结论请拿代码复核。

### 0. 三十秒结论

```text
项目路径        /Users/ypc/Desktop/归档项目/xiaomang
git             42 个提交；⚠️ 工作树**很脏**：31 改 + 25 项新增（混了三轮改动，见 F）
npm test        553 passed / 0 failed
npm run build   成功（vite build，**不做类型检查**）
npm run verify:render   16 passed / 0 failed   ← 本轮新增，前端真渲染检查
npm run verify:routes   299 passed / 0 failed（需本地 MongoDB + apps/server/.env）
线上            https://124.223.15.17/  200（腾讯云，IP 入口；域名被拦，见 C）
```

**这一轮的主线**：把「复盘分析」立项并落地**一期 4.1 单条视频数据分析** ——
这是本项目**第一次让数据倒流回上游**（前面所有链路都是单向的）。

**✅ 已完成并真跑通**：Excel 上传 + 列映射确认 → 后端按平台标准值**实算判定** →
Agent 只写「为什么 / 怎么调」→ 报告落库 → 经理端模块 4 / 4.1 阶段组件。
（4.2 账号周度分析是二期，界面上如实标「待实现」）

**🔴 本轮最大的三个坑**（详见 §E）：**手写的 Electron/无头浏览器在本机沙箱里起不来**
（改用 SSR 真渲染替代，并把它做成了 `npm run verify:render`）；
**子代理新建的文件默认是 600 权限**（正是部署轮那个 EACCES 事故的同款根因）；
**codegraph 的 MCP 仍然绑着别的项目**（必须用 CLI）。

---

### A. 这一轮在做什么（一句话）

用户口径：**「复盘分析 —— 真正能让本项目从自动化新媒体工具，变为可以自我更新迭代的
agent 系统的重要核心」**。链路分两条：**选题优化复盘**（4.2，周度）与
**单个视频数据分析**（4.1，已做）；两者共用同一套「数据 → 判定 → 建议 → 记忆」。

**🔴 一个必须记住的前提（用户本轮明确纠正过一次）**：
4.1/4.2 分析的是**客户自己发布、系统从来没见过的视频**，不是选题库里的对标视频。
所以这些数据**系统拿不到、也不能自动补**，只能由人工从平台后台导出后上传。
选题库在这条链路上的作用只有两个：提供大类/小类**词典**，以及（二期）承接复盘后的新配比。

### B. ✅ 已完成（按「用户能看到什么」列）

| # | 用户能看到什么 | 关键文件 |
|---|---|---|
| 1 | 经理端账号定位多了**模块 4「复盘分析」**，含 4.1 / 4.2 两个子步骤 | `web/src/app/accountPositioningModules.ts`、`AccountPositioningPage.tsx` |
| 2 | 上传 Excel → **逐列确认「这列是什么」**（自动识别只给建议） | `web/src/app/VideoAnalysisStage.tsx`、`api/_lib/reviewWorkbook.js` |
| 3 | 判定表：每个指标**实测值 / 标准线 / 判定 / 说明**，并把「这个数字代表什么」标在旁边 | `api/_lib/reviewMetrics.js`、`VideoAnalysisStage.tsx` |
| 4 | 四大结构（选题类型 / 3s / 标题 / 结尾钩子）各自的**可复用 / 需要优化**结论与依据 | `api/_lib/videoAnalysis.js` |
| 5 | 「为什么 / 怎么调」两栏建议；**模型没给就如实显示「待人工补充」**，不编套话 | `contentAgent/prompts.js`、`reviewAgents.js` |
| 6 | 报告落库、按客户回看、可删除（员工也能做单条分析） | `api/_lib/videoAnalysisStore.js` |

**关键数字（都是实算，可复现）**：互动率 =（赞+评+转+藏）/播放量；
平均播放率 = 平均播放时长/视频时长；播放量 12500 → 「爆款」档；全优数据 → 四大结构全判「可模仿复用」。

### C. 🔴 本轮纠正的两处「文档与现实不符」

**C-1. 腾讯云部署**其实早在 §0.9 写完后当天就做完了，但 HANDOFF 一个字没记。**
现状（取自 `docs/DEPLOY-TENCENT.md`，并已实测复核）：

| 项 | 值 |
|---|---|
| 服务器 | `124.223.15.17`（腾讯云 CVM，2 vCPU / 1.9G） |
| 代码目录 | `/opt/xiaomang`，`docker compose`（容器 `xiaomang-app-1` / `xiaomang-mongo-1`） |
| 当前入口 | **`https://124.223.15.17/`**（IP 证书，6 天续期一次）—— 本轮实测 200、TLS 校验通过 |
| 域名 | `xiaomang.cloud` **被腾讯云按备案策略拦截**，服务器端无解（详见 `docs/DEPLOY-TENCENT.md` §7） |
| 数据 | 容器内 MongoDB 8.0，**20 集合 / 366 文档**，与本地一致 |

**C-2. `docs/DEPLOY-TENCENT.md` 是一份完整、可靠、20+ 项实测的部署手册**，
新会话要动服务器**先读它**。部署中还修了 5 个真 bug（源文件 600 权限致容器 EACCES、
apt 源、compose 项目名、SPA 吃掉 robots/sitemap、迁移被空集合拒绝）。

### D. 🔴 卡在哪 / 待办（按优先级）

**D-1. 🔴 项目仍然没有类型检查（承接 §0.9-D-1，本轮再次被它咬到）**
`build` 只有 `vite build`。本轮实测：`node_modules` 里**已经有 typescript 5.9.3**，
直接 `tsc --noEmit` 就能用（无需安装）。本轮新增的前端文件跑过一遍，**0 错误**；
存量错误（`accountPlan.ts` 的 `DocxBlock`、`api.ts` 的 `import.meta.env` 等）仍在。
→ **建议**：加 `tsconfig.json` + `npm run typecheck`，把这批清掉。

**D-2. 4.2 账号数据分析是二期，未做。** 界面上如实标「待实现」。
它的两块产出——**选题配比**与**三类结构配比**——需要先解决「写新配比」这个缺口（见 D-3）。

**D-2b. 「复盘记忆」闭环未打通（二期核心）。**
`titleLibrary.js:10` 早就写着「每周复盘：按用户最终选中的标题类型标签调下一次的配比」，
但**全仓只有这一句注释、无实现**。当前配比是**读时从报告实算**的
（`topicCreativeAdaptation.js` 的 `indexBreakdownByCategory`），
没有任何 PATCH/PUT 通路，也没有版本历史 —— 「第一周配比」和「第二周配比」当前无法共存。

**D-3. 数据来源已确认：只能人工上传，不要考虑自动抓取。**（用户 2026-09-30 明确）

**D-4. 列映射的「真实样例」还没拿到。** 本轮的自动识别是基于用户需求里列的指标名写的
同义词表；拿到真实 Excel 后应把它补进 `reviewMetrics.js` 的 `aliases`。
**界面本身有兜底**（认不出就让用户指认），所以这不是阻塞项。

**D-5. 长期未做（承接 §0.9-D / §0.8-D）**：真人模板出图 403、飞书导出未用真实凭据跑过、
Atlas 密码未轮换、宝塔 8888 端口对公网开放、SSH 密码登录未关（见 `docs/DEPLOY-TENCENT.md` §5）。

### E. 🔴 绝对不要再踩的坑（本轮新增，每条都带症状）

**E-1. 🔴🔴 `vite build` 不做类型检查 —— 本轮又验证了一次它是真会咬人的。**
用户给的两个历史事故（缺 import、TDZ）都是这个根因。本轮因此**新增了一条防线**（见 E-2）。

**E-2. ✅ 新增 `npm run verify:render` —— 前端真渲染检查，改前端后必须跑。**
做法：用 esbuild 把 `AccountPositioningPage` / `VideoAnalysisStage` 连同 React
打成**单份 CJS**（单实例 React，否则 `Invalid hook call`），再 `renderToString` 渲染并断言。
**变异验证过**：把 `MODULE_ICONS` 的 `review` 键或 `STEP_ICONS` 的 `video-review` 键删掉，
它会红并且报出准确原因
（`Element type is invalid ... got: undefined`）—— 而 `npm run build` **照样绿**。
⚠️ 它**抓不到** `useEffect`、事件处理器与真实请求，改了交互仍要人工真点一次。

**E-3. 🔴 本机没有任何可用的无头浏览器 —— 别再试了。**
`Google Chrome --headless=new / --headless=old`（`/Applications/Google Chrome.app/...`）
在本机沙箱里**直接挂起不返回**（crashpad 写 `~/Library/...` 被拒 → GPU 进程退出）。
CDP 那条路也走不通：Chrome 需要 `--remote-allow-origins=*` 才接受 WS 连接，
而连上之后 undici 的 WebSocket 消息投递在本机也不可用。
→ **要「看一眼」就用 E-2 的 SSR 检查**（它覆盖了白屏那一类），
需要真交互时再说 —— 别在这上面重复烧时间。

**E-4. ⚠️ 本机新建文件默认 `600` 权限 —— 这正是部署轮 EACCES 事故的同款根因。**
本轮子代理新建的 6 个文件、以及我新建的若干文件都是 `-rw-------`。
Docker 镜像里非 root 的 `node` 用户读不到就会**启动即崩**。
→ **每轮结束前跑一次**：`find apps packages -type f ! -perm -o=r | grep -v '\.env'`
（应当为空）。修正用 `chmod a+r <文件>`。
→ 🔴 **不要图省事写 `chmod -R a+rX apps packages`** —— 那会把 `apps/server/.env`
（含 MongoDB 与各 API 密钥）一起变成全局可读。`.env` 必须保持 `600`，
要修只修源码与测试文件。

**E-5. 🔴 codegraph：CLI 是对的，MCP 仍然是错的（§0.9-E-13 依然成立）。**
本轮实测：`codegraph status` 正确显示本项目（227 文件 / 4878 节点 / 11149 边，
`Index is up to date`），`codegraph files` 给出的目录树就是本仓库。
**但 `mcp__codegraph__*` 系列工具查到的仍是别的项目**，别用。
CLI 常用：`codegraph status` / `codegraph files` / `codegraph query "<符号>"` /
`codegraph callers <符号>` / `codegraph impact <符号>`。

**E-6. 🔴 百分比列的三种写法必须都认，认错一列整份报告全错且用户看不出来。**
Excel 里同一列可能是 `0.32`、`32`、`"32%"`。`reviewMetrics.js` 的 `toRate` 统一成
「带 % ⇒ 除以 100；纯数字 > 1 ⇒ 视作百分数除以 100」。
**由此得出一条口径约定**：想填 1.5% 就写 `1.5`；想填 150% 得写 `150`（写 1.5 会被读成 1.5%）。
越界值**不夹取**，如实标「数据可疑」。

**E-7. 🔴 判定结论绝不能交给模型 —— 这是本项目第三次强调同一条纪律了。**
4.1 的做法：**先后端实算**（阈值表 → 判定），把结论**作为输入喂给模型**，
模型只写「为什么 / 怎么调」。归一化层会核对模型有没有自报结论，
**说反了就丢弃并记 warning**（有一对一测试钉着）。

**E-8. 加平台/指标时，先看 `reviewMetrics.js` 是不是已经有第二份定义。**
抖音与视频号的指标集**不同**（抖音有 2s跳出率/5s完播率/收藏；视频号是 3秒以上播放率/红心），
阈值也不同（视频号的完播率**同时**影响选题类型与结尾钩子，抖音不是）。
这些差异全部收敛在一张 `RULE_TABLE` 里，前端与提示词都从这里取，别另写。

**E-9. 文件上行走 base64 + JSON，不走 multipart。**
项目里唯一的 multipart 先例（`src/manager/ai.js` 的 `extract-document`，用 multer）
是**本地 Express 专有**的 —— Vercel 那套没有 multer、`readBody` 也只解析 JSON。
为守住「两套后端必须同步」，复盘的上传走 `{ fileName, dataBase64 }` 的 JSON。
代价是 body 大 1.33 倍：只给 `/api/review` 放宽到 8mb，**不要动全局 1mb**，
且解码后的文件另卡 5MB（Vercel 请求体硬上限 4.5MB，抬本地救不了线上）。

**E-10. Excel 读取器是零依赖手写的，不要引包。**
`api/_lib/xlsxWorkbook.js` 只用 `node:zlib` 的 `inflateRawSync` 解 DEFLATE。
**踩过的坑**：zip 中央目录里 rels 的**属性顺序不固定**（Excel 写 `Id` 在前、
openpyxl 写 `Target` 在前），用固定顺序的正则解析会得到空结果 —— 必须逐元素分别取属性。

### F. 工作树状态（提交前必看）

`git status`：**31 改 + 25 项新增**（其中两项是目录），混了**三轮**改动，提交时应分开：

| 轮次 | 大致内容 |
|---|---|
| §0.9 选题轮（未提交） | `titleLibrary.js`、`topicAnalysisPipeline.ts`、`benchmarkTopicRefresh.js`、`App.tsx`、`ContentPage.tsx` 等 |
| 部署轮（未提交） | `Dockerfile`、`.gitignore`、`deploy/compose.tencent.yml`、`docs/DEPLOY-TENCENT.md` |
| **§0.10 复盘轮（本轮）** | `_lib/review*.js`、`_lib/videoAnalysis*.js`、`_lib/xlsxWorkbook.js`、`api/agent/video-analysis.ts`、`api/video-analysis-reports/`、`api/review/workbook.ts`、`scripts/verify-web-render.mjs`、前端 `VideoAnalysisStage.tsx` / `reviewApi.ts` 等 |

### G. 怎么验证（命令 + 期望数字）

```bash
cd /Users/ypc/Desktop/归档项目/xiaomang
npm test               # 553 passed / 0 failed
npm run build          # 成功（⚠️ 不做类型检查，绿 ≠ 对）
npm run verify:render  # 16 passed / 0 failed ← 前端真渲染检查（本轮新增）
npm run verify:routes  # 299 passed / 0 failed（需本地 MongoDB + apps/server/.env）
```

**本轮新增的测试**：
- `tests/review-metrics.test.mjs` —— 阈值口径、平台差异、单位归一化、表头识别（40 项）
- `tests/video-analysis.test.mjs` —— 4.1 组装、模型结论核对、降级、warnings（21 项）
- `tests/review-workbook.test.mjs` —— Excel 解析与列映射建议（13 项）
- `tests/xlsx-workbook.test.mjs` —— 零依赖 xlsx 读取器（24 项，子代理产出）
- `tests/video-analysis-store.test.mjs` —— 存储与权限边界（3 项，需真实 MongoDB）
- `scripts/verify-server-routes.mjs` —— 新增 44 条冒烟（含 Excel 上传与 4.1 权限矩阵）

**这些测试都做过变异验证**（把被保护的代码改坏，确认测试真的会红）——
不会红的测试是负资产，见 §0.9-E-3。

### H. 下一会话第一步（建议顺序）

1. **先跑 §G 的四条命令**，确认基线（553 / build / 16 / 299）与工作树状态。
2. **问用户要不要把这三轮改动分开提交**（见 §F）。
3. **优先做 §D-1（加类型检查）** —— typescript 已经在 `node_modules` 里，代价最低。
4. **二期做 4.2**，但要先解决 §D-2b 的「写新配比」缺口：
   复盘的产物是**处方**（我们下周该怎么做），而现有 `categoryBreakdown` 是**诊断**
   （对标账号过去怎么做的）—— **语义不同，不能覆盖**，必须新建一层客户级的
   「复盘记忆」并按优先级被二创读取。

---

## 0.9 ✅ 第十轮：选题生成页大修（2026-09-28）

> 自包含。读完这一节就能接手，不必先读 §0.8 及以前。
> ⚠️ 本项目文档有「反复滞后于代码」的前科（已多次），**关键结论请拿代码复核**。

### 0. 三十秒结论（新任会话读这一段就能开工）

```text
项目路径        /Users/ypc/Desktop/归档项目/xiaomang
git             42 个提交；⚠️ 工作树**脏**：22 个文件已改、4 个新文件未跟踪，本轮改动**全部未提交**
npm test        452 passed / 0 failed
npm run build   成功（vite build，**不做类型检查**，见 §E-1）
npm run verify:routes  255 passed / 0 failed（需本地 MongoDB + apps/server/.env）
本地库          mongodb://127.0.0.1:27018/xiaomang，20 集合 / 366 文档
未提交的新文件  apps/server/api/_lib/titleLibrary.js
                apps/server/tests/title-library.test.mjs
                apps/server/tests/topic-analysis-pipeline.test.mjs
                apps/web/src/app/topicAnalysisPipeline.ts
```

**这一轮的主线**：员工侧「选题生成页」（`/topics`）从"能筛能看"做成**真能出脚本+标签**，
并把它与二创页、视频号平台打通。

**✅ 已完成并真跑通**：标题库二创、自定义点赞门槛（含口径从 `>` 改 `>=`）、
视频号选题在选题页提取脚本 + 二创直接复用（**用户 2026-09-28 实测确认"OK了这次成功了"**）、
打标签改攒批（方案二）。

**🔴 本轮最大的两个坑**（都是我自己引入、又自己修掉的，详见 §E）：
「React effect 依赖含自己会写的 state」导致**界面永久卡死而后端正常干活**；
「项目无类型检查」导致**未定义标识符构建期不报错**（踩了两次，其中一次是别人早就埋下的必崩 bug）。

---

### A. 这一轮在做什么（一句话）

把「内容生成页」的这一整套经验（**前期构建库 → 生成时匹配库类别做二创**）搬到
**标题**上，并把「选题 → 脚本 → 标签 → 二创」这条链路的**性能、稳定性、平台覆盖**补齐。

用户口径的原话（按时间顺序）：
1. 「内容生成页中的标题现在也需要做一下改动，同样在前期需要构建标题库，然后内容生成页中生成标题时，匹配标题库类别进行二创生成」
2. 「过滤条件默认是点赞数大于等于 100。现在加一个功能支持用户自定义过滤筛选条件」
3. 「视频号获取的选题需要解码下载…把二创部分提取脚本的功能前移到选题生成页」
4. 「选题现在是所有都处理完之后再显示，还是想抖音平台的方式一样，一条处理完之后就直接显示」
5. 「帮我上方案二吧」（后端批量并行 agent）

---

### B. ✅ 已完成（按「用户能看到什么」列）

| # | 用户能看到什么 | 关键文件 | 备注 |
|---|---|---|---|
| 1 | **内容生成页标题按库类别二创**：标题类型直接复用 2.2 那 8 个类型（好奇心/恐惧/愤怒/反差/痛点/兴趣/求知欲/欲望），配比按「大类 × 类型」 | 新增 `api/_lib/titleLibrary.js`；`contentAgent/prompts.js` 加 `CREATIVE_TITLE_PROMPT` | 2.4 建库页加了「标题库（同源 2.2）」徽章，让用户看得见它不是没做 |
| 2 | **2.3 结尾钩子不再重复调 TikHub** | `contentAgent/providers.js` 的 `resolveCache` | TikHub 解析 3~7s，同一链接只解析一次 |
| 3 | **点赞门槛可自定义**（含 0），默认 100，口径 `>=` | `web/src/app/topicContentRules.ts`、`App.tsx`、`api/_lib/benchmarkTopicRefresh.js` | ⚠️ 口径从 `>` 改成 `>=`，见 §E-6 |
| 4 | **视频号选题能在选题页提取脚本**，二创直接复用、不再现场解密转写 | `goldThreeSecondTranscripts.js`、`platformAdapters.js`、`ContentPage.tsx` | 靠 `mediaUrl`+`decodeKey`，**没有 link**，见 §E-4 |
| 5 | **列表逐条/逐批往外冒**，不再是"全部跑完才显示" | `web/src/app/topicContentAnalysis.ts` | 见 §E-5（根因不在网络，在上报时机） |
| 6 | **打标签改攒批**（方案二）：一次模型调用覆盖 4 条 | `topicAnalysisPipeline.ts` 的 `createBatcher` | 后端本来就能批量，只改了前端编排 |
| 7 | **从二创页返回不再重跑分析**（不重复花钱） | `topicAnalysisPipeline.ts` 的 `canReuseTopicAnalysis` | 范围指纹 = 客户 + 时间窗口 + 这批视频 id |
| 8 | 去掉「已提取脚本」徽章与「（真实转写）」后缀 | `App.tsx` | 纯外观 |
| 9 | **ASR 换豆包录音文件识别 2.0**（异步 submit+poll，只收 URL） | `contentAgent/providers.js` 的 `recognizeDoubaoFileAudio` | 与旧的 flash（同步、base64）是两条通道 |
| 10 | **选题库只读分类词典**，不再拉 2.2/2.3 报告 | `topicLibraryStore.js` 的 `CATEGORY_DICTIONARY_PROJECTION` | 实测 253KB → 8.2KB，**省 96.7%** |

---

### C. 🐛 本轮抓到的真 bug（**多数不是本轮引入的，是早就存在的**）

**C-1. 🔴 界面永久卡死，而后端在正常干活（本轮最严重，我自己引入的）**
选题列表已列出、界面却永久停在「正在读取本账号的选题库…」，不报错不推进。
**判据**：服务端日志显示 DeepSeek 打标签正在正常调用 —— 后端跑完了，前端把每次更新都扔了。
根因见 §E-2。

**C-2. 🔴 「删除 1.2 报告」必然抛 `ReferenceError`（早就存在、一直没人发现）**
`deleteBenchmarkProfileReport` 在 `reportApi.ts:296` 定义并导出，`BenchmarkProfileStage.tsx`
正确导入了，但 `AccountPlanStage.tsx:782` **调用了却没导入** → 点击即崩。
**靠临时装 TypeScript 跑 `tsc --noEmit` 才发现**（本项目没有类型检查，见 §E-1）。已修。

**C-3. 🔴 视频号选题在选题页被静默丢光（三处独立原因，叠在一起）**
1. 前端 `transcribableVideos` 一律要求 `link` —— 视频号**没有分享链接**；
2. 后端 `benchmarkTopicRefresh.js` 有**自己的一份** `normalizePlatform`，把 `wechat_channels`
   压成了 `douyin`，随后被"抖音必须有 link"再丢一次；
3. 路由 `src/index.js` 自己拼 `targets` 时只挑 `id/link/title/platform`，**漏了 mediaUrl/decodeKey**。
症状统一是「选题列表有内容，但脚本和标签一直不动」，且不报错。已全部修掉。

**C-4. 🔴 媒体流断开会把 Node 进程打死（不是普通失败）**
终端 `Unhandled 'error' event` + `UND_ERR_SOCKET: other side closed` → `Failed running 'src/index.js'`
→ 前端 `socket hang up` + 长时间无结果。
根因：`Readable.fromWeb(response.body)` 建好后，消费侧的 `inputStream.on("error")` 要等
**ffmpeg 启动**才挂上；这段窗口里断流就没人接。已加 `guardStreamErrors`。

**C-5. 后端点赞门槛的"默认值"其实变成了 0**
`resolveMinLikes = Math.max(TOPIC_REFRESH_MIN_LIKES, asNumber(value))`。
`asNumber(undefined)` 是 0 —— 下界从 100 放开到 0 之后，**不传门槛就变成"不限点赞"**，
比业务默认（100）宽松得多，且报告里回显 `minLikes: 0` 看起来很"正常"。已拆成两个常量。

**C-6. 前后端对非法点赞的处理不一致（同一批数据筛出不同结果）**
前端 `Number("abc")` → `NaN`，而 `NaN >= 0` 是 **false**（挡住）；后端 `asNumber` 归一化成 0（放行）。
已加 `normalizeLikes` 与后端同口径。

**C-7. 所有请求都没有超时**
`fetchWithRetry` 完全依赖 `fetch`，而 **`fetch` 永不超时**。选题页每一步都 `await` 在它上面，
任何请求悬挂（服务端重启、连接半开）界面就永久停在那一句文案上。已加 330s 超时并报成"请求超时"。

**C-8. 提前 return 不回调 `onProgress` → 界面停在上一次文案**
`runTopicContentAnalysis` 的每个提前返回只把结论写进**返回值**，没推给界面。
用户看到的是"卡住"而不是"原因"。已修（**每个提前返回都必须回调**）。

---

### D. 🔴 卡在哪 / 待办（按优先级）

**D-1. 🔴 项目没有类型检查（结构性风险，建议优先处理）**
`build` 只有 `vite build`，**没有 TypeScript、没有 tsconfig、没有任何 linter**。
所以"标识符未定义 / 导入漏了"这类错误**构建期完全不报错**，运行时才炸。
本轮我因此踩了两次（一次自己写的、一次 C-2 那个必崩 bug）。
代价已实测：临时装 `typescript@5` 跑 `tsc --noEmit`，**只有 22 个错误**，且多数是类型漂移
（`DocxBlock` 类型不存在、`CoverCandidate` 只在类型位置、`fontSizePx` 有 `|| 48` 兜底、`import.meta.env` 缺 vite/client 类型）。
→ **建议**：加 `typescript` devDependency + `tsconfig.json` + `npm run typecheck`，并把这 22 个清掉。
（我临时装过 typescript，`--no-save`，**package.json 未被改动**；`node_modules` 里可能还留着，`npm install` 会清掉。）

**D-2. 视频号的真实性能未测量**
视频号媒体在 CDN 上且被 Isaac64 加密，**用不了 `doubao-file`（URL 直取）**，只能走本地解密 + ffmpeg。
实测单条 ffmpeg 抽取 **25~86 秒**（波动取决于 CDN 当时速度），ASR 只花 2.7s。
→ 它注定比抖音慢，这是加密格式的固有代价，**不是编排能解决的**。
→ 若要提速，方向是**本地缓存已下载的视频**（同一视频重复转写不再重下），**不是**调超时或换编码器（见 §E-7）。

**D-3. 攒批打标签的准确率未验证**
`TOPIC_TAG_BATCH_SIZE = 4` 意味着一次 prompt 里塞 4 条视频的信息。
**若发现标签串了（A 视频的标签跑到 B 上），把它降到 2 或 1** —— 这个值是权衡，不是定论。

**D-4. 本轮改动全部未提交**
22 改 + 4 新增都在工作树里，`git status` 能看到。新会话开工前先确认要不要提交。

**D-5. 未验：2.1 对标账号分析不支持视频号**
`benchmarkAnalysis` 里没有任何 `wechat_channels` 分支，只吃抖音/TikTok。
→ 所以**没法把视频号账号加进选题库当对标账号**，库只能由抖音账号建。
用户 2026-09-28 确认「两个平台的分类树对得上」，所以目前共用一份库是**正确行为**，不是缺口。
若将来对不上，就要让 2.1 支持视频号（**优先这条**，而不是给库加平台维度）。

**D-6. 长期未做（承接 §0.8-D）**：真人模板出图 403、出图域名 DNS 抖动、飞书导出未用真实凭据跑过、
Atlas 密码未轮换。

---

### E. 🔴 绝对不要再踩的坑（本轮新增，每条都带症状）

**E-1. 🔴🔴 `vite build` 不做类型检查 —— "调用了没导入"构建期完全绿，运行时才炸。**
本轮我改了 `App.tsx` 后忘了导入 `decideTopicAnalysisAction`，`npm run build` 照样
`✓ built in 1.35s`，但运行时会直接抛 `is not defined`。
更严重的是 C-2：`deleteBenchmarkProfileReport` 这种**必崩 bug 在代码里躺了很久没人发现**。
→ **判断"改对了"不能只看 build 绿**。至少手动核对新增标识符的 import 是否存在；
→ 涉及跨模块调用时，跑一次 `tsc --noEmit`（见 §D-1），或写一条源码级断言（见 E-3）。

**E-2. 🔴🔴 React effect 的依赖数组里，绝不能放「这个 effect 自己会写的 state」。**
症状极具迷惑性：**界面永久停在第一句文案，不报错不推进，而后端日志显示正在正常干活**。
根因时序（精确复现过）：
```
① effect 跑 → setTopicAnalysisScope / setTopicContent → 启动异步分析
② 异步函数在第一个 await 之前发出「正在读取本账号的选题库…」
   —— 此时还没被取消，所以这句话**显示出来了**（用户看到的就是它）
③ await 让出 → React 重渲染 → 依赖变了 → cleanup 执行 cancelled = true
④ effect 重跑 → 已登记过的 key → 提前 return，**不再注册新 cleanup**
⑤ 正在跑的分析被**永久**取消：onProgress/onContent 全被 if(!cancelled) 挡掉，结果被整个丢掉
```
→ **关键认知：提前 return 并不能"取消"上一次已经发出的取消信号。**
→ 正确写法：effect 的**唯一依赖**是"范围指纹"字符串（`topicAnalysisScopeKey`），
   其余值走 `useRef` 读取。取消只在"这批范围真的变了"时发生。
→ 已加**源码级回归测试**钉住依赖数组（`topic-analysis-pipeline.test.mjs`），并**变异验证过**：退回旧写法该测试会红。
→ 顺带扫过全仓同类模式，另有 6 处（`inView` / `sourcePlatform` / `wechatShareLinksLoading` /
   `TopicLibraryStage` 两处 customerId / selectedReportId）**全部是误报** —— 它们都有收敛判断
   且没有可取消的异步工作。**别再重复扫这个**。

**E-3. 测试必须用「变异测试」验证它真的会红。**
我第一版给流断开写的回归测试**是假的** —— 把兜底逻辑停用（变异）后它照样通过，
说明它根本没走到那条路径（真实原因：媒体走的是 `undiciFetch` 而非全局 `fetch`，stub 拦不到；
1.8ms 就结束是因为 ffmpeg 二进制当场失败）。
→ **写完"防回归"测试后，把被保护的那段代码改坏，确认测试真的会红。** 不会红的测试是负资产。

**E-4. 视频号没有分享链接 —— 判"能不能转写"必须按平台分开判。**
它的媒体地址在 `source.mediaUrl`，且被 Isaac64 加密，靠 `source.decodeKey` 本地解密。
抖音/TikTok 要 `link`，视频号要 `mediaUrl` + `decodeKey`。
→ 一律要求 `link` 会把视频号**整批静默丢掉**（前端过滤比后端严，用户只看到"没有可分析的视频"）。
→ 视频号也**用不了 `doubao-file`**（需要公网可拉的 URL），只能走 `ffmpeg`。

**E-5. 「都处理完才显示」的根因通常不是网络，是上报时机。**
`mapWithConcurrency` 的结果是**按输入顺序**收集的（这是它的契约）。
`await` 它之后再统一合并 → 标签必须等**最慢的那一条**。
→ 正确做法：让每条 worker **自己**在完成时上报（`onResolved`），谁先跑完谁先显示。
→ 攒批时同理：`createBatcher` 的 **`flush()` 必须在所有条目到达后调用一次**，
   否则最后不足一批的条目**永远不会被处理** —— 症状是"大部分出来了，尾巴几条永远转圈"。

**E-6. 改比较符口径（`>` → `>=`）时，必须连**测试、错误文案、边界断言**一起改。**
点赞门槛从「严格大于 100」改成「大于等于」后，4 处旧口径测试必须同步（**这不是"让测试变绿"，
是口径变更的一部分**）。其中一条是**保护性测试**（"防调用方绕过业务下界"）——
下界从 100 放开到 0 后，**保护本身要保留、只换下界**（负数仍会被夹到 0），不是把测试删掉。
→ 后端错误文案也必须改：写「点赞未**超过** 100」在新口径下**自相矛盾**（100 其实达标了），
   现为「点赞未**达到** 100」。

**E-7. 🔴 不要凭"看起来合理"去调超时 / 换编码器 —— 我因此给过两次错建议。**
- **超时**：我建议把 `FFMPEG_TIMEOUT_MS` 从 90s 降到 30~45s。实测后发现**是错的**：
  57s 视频要 64.3s、103s 视频要 90.2s（余量只有 1.0x），调低会让**正常视频直接超时失败**，
  然后回退到下一个 provider 再失败一遍，**比不调更低效**。
- **编码器**：我测出 `aac` 比 `mp3` 快 2.6 倍，差点就改了。复测后**反转**（aac 反而慢 3 倍）。
  真正原因是**抖音 CDN 每次解析出的主机不同、速度波动 3 倍以上**，而我那个对照是**顺序跑**的，
  把网速差异错记到了编码器头上。
→ **结论**：0.4MB 的音频用 mp3 还是 aac，ASR 都只花 ~2.7s，**编码器没有优化空间**；
   真正的耗时是**下载整条视频**。改动前先做**控制变量**的测量。
→ 现已把实测数字写进 `config.js` 注释与 `.env.example`，避免下一个会话再犯。

**E-8. 测量时小心缓存把结果伪装成"很快"。**
我测"瓶颈在哪"时得到 6.2s（看起来编码很快），实际是**转写缓存命中**、根本没跑 ffmpeg。
真实值是 54s。**测量前先清缓存，或用日志确认真实走了那条路**。

**E-9. 🔴 同名的工具函数在多个文件里各写了一份，其中几份是错的。**
`normalizePlatform` 在 **4 个文件**里各有一份局部实现，其中
`benchmarkTopicRefresh.js` / `benchmarkAnalysis.js` / `videoComments.js` 那几份都是
`=== "tiktok" ? "tiktok" : "douyin"` —— **把 `wechat_channels` 压成了 `douyin`**（C-3 的根因之一）。
`platformAdapters.js` 里才有**规范版本**（认 `wechat`/`wechat_channels`/`channels`/`视频号`）。
→ 本轮只修了本链路用到的那个；**其余几处属同类隐患，尚未清理**。
→ 加新平台时，先 grep 一遍有没有别的 `normalizePlatform`。

**E-10. 两套后端必须同步改。**
`apps/server/src/index.js`（Express）与 `apps/server/api/agent/*.ts`（Vercel）是同构的两份。
本轮 `targets` 构造在两处都漏了 `mediaUrl/decodeKey`，只改一处会让线上线下行为分叉（§6.2⑤）。

**E-11. 流（stream）的 `error` 事件没人接 = 进程级事故，不是"请求失败"。**
`Readable.fromWeb(response.body)` 建好后到消费侧挂上监听之间有一段**窗口期**，
这段窗口里断流就是 unhandled `'error'` → 进程退出（前端只看到 `socket hang up`）。
→ 流一建好就挂兜底监听（`guardStreamErrors`），**不要等消费侧挂**。
→ 另外：**Node 的 `pipe()` 不转发源流的 error**（出错时只调 `dest.end()`，不 emit error）。
   失败感知靠消费侧在**同一个流**上直接挂的监听。我一开始把注释写错了，已更正。

**E-12. 局部实现覆盖全局口径 —— 别在函数里另写一份"默认值"。**
`resolveMinLikes` 用 `Math.max(下界, 传入值)`，而 `asNumber(undefined)` 是 0。
下界一旦从 100 放开到 0，"不传门槛"就悄悄变成"不限点赞"（C-5）。
→ **"没给"与"显式给了 0"必须区分开**，默认值要显式写出来，别让 `asNumber` 兜底。

**E-13. ⚠️ codegraph 的 MCP 工具在本机返回的是**别的项目的陈旧索引**，不要用它了解本项目。**
本机 DSH 的 MCP 配置（`~/.dsh/profiles/web/cordis.patch.yml`）里**硬编码**了
`-p /Users/ypc/Desktop/Amazon-agent`，所以 `mcp__codegraph__*` 系列工具查到的是
**Amazon-agent 的旧快照**，与 `xiaomang` 无关。曾因此浪费大量时间在"代码对不上"上。
→ **要了解本项目结构，用 codegraph 的 CLI**（`codegraph status` / `codegraph query`），
   它读的是磁盘上的当前索引；或直接用 `grep` / `glob` 读代码。
→ 上游无法修：DSH 的 MCP 客户端不声明 `roots`，而 codegraph 只取第一个 root，
   且 `--path` 的优先级高于 cwd。**已确认不可行，不要再尝试改这个配置。**

---

### F. 怎么验证（命令 + 期望数字）

```bash
cd /Users/ypc/Desktop/归档项目/xiaomang
npm test               # 期望 452 passed / 0 failed
npm run build          # 期望成功（⚠️ 不做类型检查，绿 ≠ 对）
npm run verify:routes  # 期望 255 passed / 0 failed（需本地 MongoDB + apps/server/.env）
npm run dev            # Express(8787) + Vite；⚠️ Vite 只监听 [::1]:5173（IPv6 localhost），
                       #    `curl 127.0.0.1:5173` 会连不上，别误判成"服务没起"
```

**本轮新增的测试（含防线）**：
- `apps/server/tests/topic-analysis-pipeline.test.mjs` —— 完成即上报、攒批、**取消策略 + 依赖数组源码断言**
- `apps/server/tests/title-library.test.mjs` —— 标题库
- `apps/server/tests/topic-content-rules.test.mjs` —— 门槛口径、`parseMinLikes`
- `apps/server/tests/topic-library.test.mjs` —— 视频号进转写、平台不被压成 douyin、负门槛被夹
- `apps/server/tests/content-agent.test.mjs` —— 流断开不打死进程、豆包 file-ASR

**怎么"真看一眼"前端（本项目没有浏览器测试基建）**：
改动 effect / 组件后**必须手动刷新页面确认**。历史上 TDZ 那类问题（§0.8-E-4）就是
build 绿 + 单测全过但整页白屏。⚠️ **改了 effect 依赖数组时 HMR 不一定能干净应用，要硬刷新（Cmd+Shift+R）。**

---

### G. 下一会话第一步（建议顺序）

1. **先跑 §F 的三条命令**，确认基线（452 / build / 255）与工作树状态（`git status`，本轮改动**未提交**）。
2. **问用户要不要先提交这一轮的改动**（22 改 + 4 新增）。
3. **评估 §D-1（加类型检查）** —— 这是本轮最值得做的结构性改进，且代价已实测（22 个错误）。
4. 若用户报告视频号仍然慢或标签串了，按 §D-2 / §D-3 处理；**动手前先读 §E-7，别再去调超时或换编码器**。

---

## 0.8 ✅ 第九轮：发布仓 3.1～3.3 落地 + 一类出图打通（2026-09-23 ~ 09-24）

> 自包含。读完这一节就能接手，不必先读 §0.7 及以前。
> ⚠️ 本项目文档有「反复滞后于代码」的前科（已多次），**关键结论请拿代码复核**。

### 0. 三十秒结论（新任会话读这一段就能开工）

```text
git              41 个提交；工作树干净；无远端
npm test         382 passed / 0 failed
npm run build    成功（vite build，**不做类型检查**）
npm run verify:routes  255 passed / 0 failed（需本地 MongoDB + apps/server/.env）
本地库           mongodb://127.0.0.1:27018/xiaomang，20 集合 / 226 文档
出图密钥         isImageGenerationConfigured() === true（XXCAPI_API_KEY / XINGCHEN_API_KEY 两套名都认）
```

**这一轮的主线**：把 3.1 封面从「能选一选」做成**真的能出图**（三种类型分层 + 两个可复用
Agent + 对话式改图），并把发布仓的三块产出真正接进最终草稿与飞书导出。

**✅ 已完成并真跑通**：出图的两条路（`generations` 与 `edits`）都实测成功；
一类「模型在模板上替换标题」的中文效果正确、**没有乱码**。
**🔴 卡在三个地方**（详见 §D）：出图域名 DNS 时通时不通（环境问题）、
用户真人模板出图被网关 403（疑似内容策略）、飞书导出从未用真实凭据跑过。

---

### A. 这一轮做了什么（按「用户能看到什么」列）

| # | 事项 | 状态 | 提交 |
|---|---|---|---|
| 1 | 收尾：把上一轮未提交的 UI/交互改造落成提交 | ✅ | `776f7117` |
| 2 | 内容生成页删掉「最终文案（可编辑）」板块 | ✅ | `76a6e8b4` |
| 3 | 发布仓 3.1 两处「按选题」状态错位 | ✅ | `8b8e1ad2` |
| 4 | **发布仓三块产出并入最终草稿并跟着导出走**（用户选 B） | ✅ | `4ab7201c` |
| 5 | 3.1 封面重做：先按资产生命周期分两层，再按用户反馈**改成三种类型分层** | ✅ | `11ea4512` `ab63306a` |
| 6 | 把用户抽出的视觉词表落到全页 + 清死代码 | ✅ | `5c69cde1` |
| 7 | 一类叠字「大黑字」：三个根因 + 首屏状态不一致 | ✅ | `2a94af23` |
| 8 | 带图保存 413（body 上限） | ✅ | `d780dc0f` |
| 9 | 出图 403 的**原因可见**（上游原话进消息）+ 免费自检脚本 | ✅ | `1f78ddb0` |
| 10 | 出图支持代理 + 网络失败翻译成中文 | ✅ | `c36f4f8f` |
| 11 | DNS 抖动时重试（只重试「请求没到网关」） | ✅ | `7de9605b` |
| 12 | **一类改为模型在模板上做图片编辑**出图（不再前端叠字） | ✅ | `272667c0` |
| 13 | **封面生成后可对话改图** | ✅ | `c41ca707` |
| 14 | 损坏封面图：存储层截断成坏 base64（两轮才修净） | ✅ | `f4d701f3` `9c3994a4` |
| 15 | 封面候选可删除 | ✅ | `6da1a546` |
| 16 | 飞书多维表格改成用户给的 **14 列** | ✅ | `29bead49` |
| 17 | 导航：内容页回 `/topics`、选题页加返回今日任务 | ✅ | `83ad84c6` |

---

### B. 🔴 3.1 的目标形态（用户拍板的口径，**别改**）

**三种类型各一层，它们是「步骤数 + 用哪些 Agent」不同，不是「参数不同」**：

| 类型 | 人像 | 背景 | 用到哪些可复用 Agent | 每期只做 |
|---|---|---|---|---|
| 一类 标准模板类 | 固定 | 固定 | **两个都不用** | 只换标题 |
| 二类 半非标内容类 | 固定 | 每期个性化 | 只用个性化背景生成 | 背景提示词 |
| 三类 非标内容类 | 每期个性化 | 每期个性化 | **两个都用** | 背景提示词 + 人像表情 |

**两个可复用 Agent**（用户口径：它们是可复用功能，不只属于某一类）：
- **IP 形象照**：输入账号规划（穿着/场景←内容定位与职业；表情/动作←人设定位）
  → 人工改提示词 → 结合客户参考照片出图。
- **个性化背景模板**：用户上传对标封面 → 视觉模型拆解（画风/元素/排版/视觉风格 + 留白）
  → 模仿它生成自家背景风格模板。

**出图方式（关键，别搞反）**：
- **一类 = 模型在模板上做图片编辑**（`edits`，模板当参考图），提示词明确要求
  「**不要保留模板上原有的标题文字**」→ 旧标题由模型替换掉，**不做前端叠字**。
- **二 / 三类 = 生成图（提示词要求「不要写任何文字」）+ 前端 CSS 叠标题**。

**UI 结构**：3.1 里就是**三个类型层**（页签）。两个 Agent 的 UI 在二、三类的层里被引用，
**不再单独开页签** —— 用户自己判定「页签只切三个类型之后独立板块不可达，是死代码」并移除。

**类型只在「保存基底」时落库**，进某一层只是看一下（避免随手点一下就改了类型）。

**本页有一份视觉词表**（`PublishWarehousePage.tsx` 里 `BTN_*` / `CARD` / `INPUT*` / `LABEL` /
`CHIP_ON|OFF` / `SEG_*` / `EMPTY_BOX`）—— 是用户为治「散、不工整」抽出来的，**新加 UI 请复用它**。

---

### C. 3.1 的 7 个 agent phase（`publishAgentRunner.js` 的 `PUBLISH_PHASES`）

| phase | 干什么 | 花钱？ |
|---|---|---|
| `cover-plan` | 旧的「出方案」（提示词 + 样式 + 背景候选），仍在用 | 否 |
| `cover-base-analysis` | **视觉模型**拆解用户上传的图（四角度 + 留白 + 标题样式） | 否 |
| `cover-portrait-plan` | IP 形象照提示词建议（**topic 刻意传空** —— 形象照是账号级的） | 否 |
| `cover-style-refine` | 标题样式**自然语言微调**（纯文本，只改用户提到的字段） | 否 |
| `cover-title-metrics` | 标题字号/行数**纯计算**（规则在后端，别在前端再写一份） | 否 |
| `cover-image` | **出图**（一类=edits 改标题；二/三类=generations） | **是** |
| `cover-refine-image` | **对话改图**：以当前封面为参考图重新出图 | **是** |

「IP 形象照/背景模板」的落地物是**账号级**的 `publish_cover_bases`（与 `publish_account_tags` 同构），
按 `{managerId, customerId}` 唯一；每期的选择在 `publish_selections`。

---

### D. 🔴 卡在哪 / 待办（按优先级）

**D-1. 用户的真人模板出图被网关 403 —— 未解决。**
日志是 `image.edit.start` 之后 `出图接口返回 403`。同一天用**合成图**跑 `edits` 与
`generations` **都成功**，`/v1/models` 也列出该模型 ⇒ 端点/密钥/模型都正常，
**403 来自那张图本身**（模板含真人肖像，这类网关的内容策略常见）。
下一步：让用户再试一次，**现在错误消息会带上网关原话**（§E-9 的修复），
按原话决定：换图 / 裁剪人脸 / 或退回「模型只出背景、文字前端叠」。

**D-2. 这台机器到 `xxcapi.com` 的 DNS 时通时不通（环境问题，不是代码）。**
症状：`ENOTFOUND`，6ms 就失败（请求根本没发出去）。同一天里时而 200 时而 ENOTFOUND，
与 §0.3-H 记的代理/VPN fake-IP DNS 抖动同源。
已做：只对「请求没到网关」那类失败**自动重试 3 次**（见 §E-10、§E-11）。
根治要么把 VPN 的 DNS 放行该域名，要么配 `XXCAPI_PROXY_URL`（也认 `HTTPS_PROXY`）。
自检：`npm run probe:image --workspace @xiaomang/server`（默认**免费**，只列模型与探端点；
加 `--generate` 才真出图）。

**D-3. 飞书「原文案」列的取值口径待用户确认。**
按每条对标视频的语义取的 `benchmarkVideos[].script`（提取到的原文案，带 `scriptSource`）。
代码里 `original_text` 出现在翻译链路，含义是「用户已选的稿」，**不是**按条视频的，所以没采用。
若口径不对，改一行即可。

**D-4. 经理端「返回项目经理工作台」未实测。** 选题页的返回入口按角色分岔
（员工→`/workbench`，经理→`/manager`），**只有员工那一支真点过** ——
邀请码在库里是哈希、读不出明文，没注册临时经理。

**D-5. 「导出时间」列被移除**（按用户给的 14 列清单执行）。它是唯一的审计列，
要留一行就能加回。**已向用户说明，等他决定。**

**D-6. 飞书导出从未用真实凭据跑过**（文档/多维表格都是单测 + 桩）。
真实凭据下的端到端从未跑过（沿上几轮）。

**D-7. 二 / 三类的真实出图与多轮改图质量未验。** 真跑过的是：一类模板改标题（合成图）、
单轮 `edits`（约 49s）。改图我只真跑过一轮；**多轮迭代质量、构图类修改（「人物往右移」）
效果如何，只能真跑才看得出。**

**D-8. ⚠️ §0.3-F7 那条规则已作废。** 它写着「封面文字用 CSS 叠，不要让模型写字 ——
模型写中文字会写成乱码」。2026-09-24 实测：`gpt-image-2.5-sunburst` 在模板上替换标题，
**中文清晰无乱码、样式与模板一致**。所以一类改成让模型写标题是对的，别拿旧规则把它改回去。

---

### E. 🔴 绝对不要再踩的坑（本轮新增，每条都带症状）

**E-1. 图片数据（base64）绝不截断 —— 截断出来的是「看着像图」的坏数据。**
存储层曾用 `.slice(0, MAX_IMAGE_URL_CHARS)` 截断超限的图。症状极具迷惑性：
预览可能还糊得出，**发给出图网关却报 `invalid_reference_image`（参考图无效）**，
排查方向被带偏到密钥/模型/数量上整整一轮。
现在口径：**超限就明确 400 拒绝**（既不截断也不静默丢图）。截断与静默丢失都是**看不见**的错。

**E-2. 存储上限必须装得下网关产出的 2K 图。**
实测一张 2K PNG 约 2.86MB，base64 后约 5MB 字符 —— 上限定 4,000,000 时**正常出图的结果就会被截断**。
现为 `8_000_000`，并有一条单测钉住「2K 图必须能完整存下」。

**E-3. 出图结果也要压图，别只压上传。**
修 413 时只压了上传路径，**漏了出图路径** → 网关返回的 ~5MB 字符图直接进库。
现在 `makeCoverImage` / `runCoverRefine` / `makeBaseImage` 三处都过 `downscaleDataUrl`。

**E-4. 🔴 TDZ：派生值写在被引用变量之前 → 整页白屏，而 build 与全部单测都是绿的。**
`const selectedCoverBroken = ... selectedCover ...` 写在 `const selectedCover` 之前 →
`Cannot access 'selectedCover' before initialization` → 整页掉进错误边界。
`vite build` **不做类型检查**、`npm test` **只覆盖数据层**，两边都拦不住。
**前端改动必须真渲染看一眼**（§F）。本项目对 TDZ 早有前科（§6 记过同类问题），别以为 build 绿、单测全过就没事。

**E-5. 归一化函数会把「不在白名单」的字段悄悄剥掉。**
`normalizeBenchmarkVideos` 原来不认 `script`（提取到的原文案）→ 飞书「原文案」列会**永远是空的**。
加字段时记得同时加到归一化白名单里，并用一条「值确实写进去了」的断言钉住。

**E-6. schema 删了列，写入侧也要停。**
`BITABLE_FIELDS` 移除了「视频封面」，但 `buildBitableRecord` 里还在
`if (coverLink) fields["视频封面"] = coverLink` → 往不存在的列写。
**改列清单时，schema 与 record builder 要一起看。**

**E-7. 模型给的颜色是自然语言，不能直接当 CSS 值。**
模型回的是「白色、橙色，无描边或阴影」。直接塞进 `style={{ color }}` 会被浏览器
**静默丢弃** → 文字继承成黑色（用户实测：一片大黑字）。
现在 `normalizeCssColor` 把它收敛成合法 CSS，原话另存 `colorDescription` 给界面显示。

**E-8. 设计稿的绝对 px 不能在缩略图里直接用。**
标题字号是按 1080 宽设计稿算的，而缩略图只有 ~260px → 直接用等于放大四倍多，
**预览会骗人**。现在用容器查询单位（`cqw`）随缩略图等比缩放。

**E-9. 上游给的原因不拼进 `error.message` 就等于丢了。**
路由只记录 `error.message`。原来 403 只记「出图接口返回 403」，
而网关回的「余额不足 / 无权限 / 端点未开通」全被塞在 `details` 里没人看 →
**完全不知道该找谁**。现在上游原话拼进消息（截断 200 字）。
加错误处理时先问一句：**日志里能不能看出该动什么？**

**E-10. 重试只能覆盖「请求根本没到网关」那一类。**
只重试 `ENOTFOUND` / `EAI_AGAIN` / `ECONNREFUSED`（退避 1.5s/3s，共 3 次）：
这类失败不可能已受理，重试**不会重复计费**。
**超时与 5xx 绝不重试** —— 上游可能已经在出图了，重试等于重复扣费。有单测钉住「5xx 只打一次」。

**E-11. 在 `try` 里自己抛的错会被同一个 `catch` 接住再包一层。**
`postWithTimeout` 里「非 2xx」是在 try 内抛的 → 被自己的 catch 当成网络失败再包 →
「403：余额不足」变成「发不出去：undefined」，把上游原因盖掉。
修法：`if (error?.code?.startsWith("IMAGE_")) throw error;` 先原样上抛。
**同类坑**：重试判断写成「有 code 就不重试」，而包装出来的网络错误**恰好带 code** → 永远不重试。

**E-12. body 上限要装得下 base64 图。**
全局 `express.json({ limit: "1mb" })` 装不下封面图 → 保存 413（`entity.too.large`）。
现在只给 `/api/publish-warehouse` 与 `/api/agent/publish` 放宽到 24mb；
**线上 Vercel 请求体硬上限只有 4.5MB，服务端改不动** —— 真正的修法是前端**先压图**。
另：`final-drafts` 的 Express 侧是**落 JSON 文件**（`src/data/final-drafts.json`），
临时库隔离不了它，改它要小心污染真实数据。

**E-13. ⚠️ 写「真实渲染核查」脚本时，我自己反复踩的四个坑 —— 假失败比真 bug 更耗时：**
1. **子串匹配**：`半非标内容类` **包含** `非标内容类` → 按后者点按钮一直点到二类那张卡上。
   点页签/按钮要用**完整标签**。
2. **`innerText` 不含 `<textarea>` 的 `value`** → 会误判「提示词没填上」。要读 `value`。
3. **按下标删/点会错位**：删一张之后后面的下标就移位了。按**内容或标题**定位。
4. **断言过严**：把「显示里的文字」当成「旧表单的字段名」
   （`最多行数：2` 里就含 `最多行数`）。负向断言要挑**只可能出现在旧实现里**的特征。
   还有：候选卡片的标题在按钮**外面**，`button.textContent` 找不到它。

**E-14. 环境类（每一条都真的误诊过）：**
- **Vite 只监听 IPv6**：`nc -z 127.0.0.1 5173` 会报「端口空闲」的**假结论**。
  探活请用 `curl http://localhost:<port>/` 或 `lsof`。
- **残留 Vite**：上一轮会话的 Vite 可能还活着（旧进程占着 5173），
  于是两个实例同时服务同一个项目。`pkill -f vite` 后要复核。
- **`node --watch` 重启竞态**：改服务端文件时偶发重启撞端口，**Express 会静默不在**，
  而 Vite 代理报 `ECONNREFUSED`。表现像业务报错，其实服务没起来。
  单独起一次 `node src/index.js` 能确认代码本身没问题。
- **我的渲染核查会往真实 `apps/server/src/data/final-drafts.json` 写草稿**
  （冒烟脚本有 `DATA_DIR` 隔离，我的临时脚本没有）。**跑完记得清回 `{"items": []}`。**

---

### F. 怎么验证（命令 + 期望数字）

```bash
cd /Users/ypc/Desktop/归档项目/xiaomang
npm test                 # 期望 382 passed / 0 failed
npm run build            # 期望成功（**不做类型检查**）
npm run verify:routes    # 期望 255 passed / 0 failed（需本地 MongoDB）
npm run dev              # Express(8787) + Vite（**注意端口，可能不是 5173**）
```

**前端改动必须真渲染**（E-4 的教训）：起 `npm run dev`，用无头 Chrome
（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` + `/tmp/ui-audit` 下的
puppeteer-core 脚手架）**真登录真点**。本轮所有前端改动都是这么验的，脚本留在
`/tmp/ui-audit/check-*.mjs` 可复用（`check-hooks-split` / `check-delete` / `check-corrupt` /
`check-nav-back` / `check-refine` / `check-tier1-gen` / `check-413` / `check-bigimage`）。
出图相关的核查请**桩掉出图那一次调用**（真跑要花钱），只验请求载荷与 UI 行为。

**出图自检**（免费）：`npm run probe:image --workspace @xiaomang/server`

---

### G. 下一会话第一步（建议顺序）

1. 先跑 §F 的三条命令，确认基线数字与本节一致。
2. 问用户 D-1 那条 403 的**网关原话**（现在能看到），据此定「换图 / 裁剪 / 退回叠字」。
3. 确认 D-3（原文案口径）与 D-5（导出时间列是否要留）—— 都是改一行的事。
4. 若要继续做出图：D-7（二/三类真实出图 + 多轮改图质量）是唯一能证明「好不好用」的路径，
   但**每次出图都花钱**，跑之前跟用户确认。
5. 飞书导出（D-6）要真凭据，用户给之前不要动。

---

## 0.7 ✅ 第八轮修复结果 + code review（四项问题全部已修）

> 用户指令：「帮我按严重程度依次修复你提到的四个问题。修改完之后进行 code review」。
> **四项全部修完并实测验收**；本节末尾是对**我自己这四项修改的评审**（含一处我自己
> 引入又被自己抓到的缺陷）。**所有操作都在 `归档项目/xiaomang` 里做的。**

### A. 四项修复结果

| # | 问题 | 状态 | 关键证据 |
|---|---|---|---|
| 1 | 🔴🔴 数据库迁移未执行 | ✅ **已修** | 本地库 **18 集合 / 225 文档**；真实账号可登录；17/18 集合指纹与源库**完全一致** |
| 2 | 🔴 出图密钥变量名不一致 | ✅ **已修** | 真实 `.env` 下 `isImageGenerationConfigured() === true`（修前恒 false） |
| 3 | 🟠 经理端 API 零冒烟覆盖 | ✅ **已修** | 冒烟 **194 → 226**（+32 条），全绿 |
| 4 | 🟠 git 历史含明文密码 | ✅ **已修** | 全历史含凭据 **0 处**；新增提交前扫描钩子（四方向验证通过） |

**回归（全部在修复后重跑）**：
```
npm test               → 366 passed / 0 failed / 0 skipped
npm run build          → 成功
npm run verify:routes  → 226 passed / 0 failed
```

#### 修复 1 的细节（迁移）

- 迁移脚本第一次跑被**自己的安全守卫**拦下（`Target database is not empty`）——
  那是正确的行为。本地库当时有 3 个**空壳集合**（我先前启动服务器时建索引产生的），
  逐一确认 `countDocuments() === 0` 后删掉，再跑迁移。
- 结果：`{"collections":18,"reconciled":true,"passwordMigrations":2}`；
  `manifest.verified = true`；备份落在 `.migration/mongo-2026-09-22T09-39-59-223Z/`
  （18 个 `.ejsonl` + `manifest.ejson`，权限 600）。
- **密码迁移实测**：`employees` 的 `password` 字段**已移除（0 条残留）**、
  全部转成 bcrypt `passwordHash`；这也是 18 个集合里**唯一**指纹与源库不同的那个
  （其余 17 个 sha256 完全一致）——差异正是预期的、且被我独立复算指纹确认过。
- **端到端验收（临时库，跑完 dropDatabase，不碰真实数据）11/11 通过**，含：
  未登录 401、**员工访问经理端 403**、注册经理 201、经理登录 role=manager、
  **员工用明文密码登录 200（bcrypt 兼容路径）**、经理端建客户 201 且能查回、
  **员工账号重复 409**、员工侧旧接口 `/api/tasks/today` 仍 200。

#### 修复 4 的细节（凭据清理）

- 先摸清范围：凭据出现在 **4 个提交**、**2 个文件**（`server/.env`、`server/index.js`），
  **其中 `.env` 当时其实被提交过**（`.gitignore` 是后来才加的）。
- 仓库当时**没有公网远端**（唯一 remote 是指向本地旧项目目录的路径），所以**未曾泄露**。
- 用 `git filter-repo --replace-text` 在**全部历史**替换为 `***REMOVED-CREDENTIAL***`
  （19 个提交被重写）。验证：`git log --all -S <密码>` → 空；
  遍历**所有 blob 对象** grep → **0 处**。
- 顺手提交了此前**完全没被版本控制**的合并结果（当时 `git ls-files` 是 0，
  5376 个删除被暂存、新结构全未跟踪 —— 索引处于半途状态）。
- ⚠️ **两个副作用要知道**：
  1. `filter-repo` **移除了 `origin`**（它原本指向上级项目目录）。现在 `git remote -v` 为空。
  2. **密码本身没有换**。密码在 `.env`（明文）与历史里都出现过，**仍建议轮换**
     ——我没做，因为改数据库密码需要你在 Atlas 控制台操作，而且会同步影响 `.env`。

### B. 🔍 对我这四项修改的 code review

#### B-1. 🐛 我自己引入、又被自己抓到的缺陷（**已修，值得记下来**）

**提交前扫描钩子的排除规则过宽 → 凭据被静默放行。**
我最初写的排除规则里有 `example|xxx` 这种**无锚定子串**。结果钩子拿去测真实连接串
（`…@cluster0.example.net/…`）时，行里的 `example` 命中排除规则，**整行被当成文档示例放行**了。
钩子「跑过了、退出了 0」，看起来一切正常 —— 这是**最难发现的一类错**。

修法：排除规则只认**明确占位写法**（`YOUR_` / `<...>` / `***` / `EXAMPLE_` / `process.env`），
不再用可能出现在真实值里的裸词。**并做了四方向验证**：

| 输入 | 期望 | 实测 |
|---|---|---|
| 真实 mongo 连接串 | 拦住 | ✅ 拦住 |
| `XINGCHEN_API_KEY=<32位>` | 拦住 | ✅ 拦住 |
| 文档占位符（`<username>` / `YOUR_API_KEY`） | 放行 | ✅ 放行 |
| `process.env.X` / `import.meta.env.X` | 放行 | ✅ 放行 |

**复盘**：这个 bug 的根因不是「正则写错」，而是**排除规则比匹配规则更危险**——
匹配规则漏了会「多拦」（人会发现），排除规则宽了会「漏拦」（没人发现）。
凡是写 exclude 白名单，都要拿**最像真实数据的样本**去反向测试。

#### B-2. ✅ 修得站得住的地方

1. **迁移没有硬删数据库**：只删了三个**逐一确认过 0 文档**的空壳集合，
   没用 `dropDatabase()` 一把梭（那会连带删掉可能存在的其它数据）。
2. **密码迁移做了独立验证**：不只看脚本自己的 `reconciled: true`，
   还**自己重算了 18 个集合的 sha256**与 manifest 比对，确认「只有 employees 不同、且差异就是密码字段」。
3. **钩子做了正负双向验证**：只测「能拦住」不够 —— 误拦正常提交同样会让人绕开钩子
   （`--no-verify`），那钩子就废了。所以两个方向都测了。
4. **改名策略选了「宽容读取」而不是「要求改名」**：`pickEnv` 同时接受
   `XXCAPI_*` 与 `XINGCHEN_*`。理由是**改名靠人为约定，迟早会再错一次**；
   而宽容读取让两种配置都能工作。错误文案也同步点明了两套变量名。
5. **冒烟断言挑的是「改写时最容易丢的东西」**：不是覆盖率的堆砌，而是
   `account` 唯一性 → 409、`safeEmployeeProjection` 不外泄密码、
   `$unset` 明文生效、关联任务时删员工 → 409 —— 这几条正是 Mongoose→原生驱动
   重写过程中**最容易静默丢掉**的校验。

#### B-3. ⚠️ 遗留 / 我没做但你应该知道的

1. **`core.hooksPath=.githooks` 是本仓库的本地配置，不会随 clone 传播。**
   别人克隆后在跑 `npm install` 之前，钩子是**不生效**的。
   建议加 `"prepare": "git config core.hooksPath .githooks || true"` 到根 `package.json`
   （我没加，因为 `prepare` 在 CI/无 git 环境会报错，需要你确认要不要这种自动化）。
2. **`git filter-repo` 顺手删掉了 `origin`**（原指向上级项目目录）。要恢复：
   `git remote add origin <url>`。**建议先决定新远端放哪**，别再指回旧目录。
3. **密码未轮换**（见 A-修复4）。历史清干净了，但**当前仍在使用同一个密码**。
4. **`/api/auth/*` 与 `/api/management/*` 两套响应风格并存**（前者 `{success,user}` 包装、
   后者裸 JSON）。前端已各按各的解析、能跑，但这是**将来的技术债**，统一时要一起改。
5. **`.migration/` 里有 18 个 `.ejsonl` 备份**（含 225 文档，**其中可能含客户业务数据**）。
   它在 `.gitignore` 里、不会被提交，但**本机磁盘上是明文**。
   如果这台机器不是只有你用，考虑加密或迁走。

### C. 现在的基线（`归档项目/xiaomang`）

```
git              20 个提交；工作树干净；无远端；钩子已启用
npm test         366 passed / 0 failed / 0 skipped
npm run build    成功
npm run verify:routes  226 passed / 0 failed
本地库            mongodb://127.0.0.1:27018 / xiaomang，18 集合 / 225 文档
出图              isImageGenerationConfigured() === true
git 历史          含明文凭据 0 处
```

### D. 下一步（建议顺序）

1. **轮换 Atlas 数据库密码**（唯一还没做的安全项）；轮换后同步更新 `apps/server/.env`
   ——注意本机库已经是主库，Atlas 只是历史来源，所以也可以直接**停用**那套 Atlas 凭据。
2. 决定新远端 + 恢复 `origin`，然后第一次 push（此时历史已干净）。
3. 可选：把 `core.hooksPath` 自动化（`prepare` 脚本）。
4. 回到 §0.5 阶段的后续：腾讯云部署加固（备份定时任务、nginx、灰度切换）。

---

## 0.6 🔴🔴 第八轮：合并后的 code review 结论 + 迁移执行清单

> 用户说「刚刚我已经进行了合并工作，你 code review 一下，并更新一下工程进度」。
> 本节是审查结论。**审查对象是 `归档项目/xiaomang`（不是本目录）。**
> 所有结论都是**实测**出来的，不是读代码猜的。

### A. ✅ 合并做得对的地方（已逐项实测通过）

| 项 | 结论 |
|---|---|
| **目录结构** | 用了 npm workspace：`apps/server` + `apps/web` + `packages/shared` + `deploy/`，**符合 §0.5-C 的建议形态** |
| **经理端代码落位** | 后端 `apps/server/src/manager/{index,customers,ai}.js` + `api/_lib/manager/`；前端 `apps/web/src/manager/{pages,services}/`，原 xiaomang2 代码在 `apps/web/src/app/` |
| **Mongoose → 原生驱动** | 按建议做了（**判断 3 选的 A**）。6 个 model 的校验**都保留了**：`enum` 白名单、必填、状态校验、bcrypt 12 轮 |
| **明文密码治理** | 🎯 处理得**很好**：`router.put` 里 `$unset: { password: '' }`（写员工时删掉旧明文），登录侧 `verifyPassword(pw, passwordHash, legacyPassword)` **兼容两者**，不会把老账号锁在外面 |
| **鉴权合并** | 统一到一套：先查 `users`（项目经理）再查 `employees`，两条链共用一个 `/api/auth/login` |
| **经理端鉴权** | 前端 `managed()` 包了 `RequireRole role="manager"`（我一度以为放宽了，核实后**守卫是完整的**）；后端 `/api/management` 路由器**第一行就是 403 守卫** |
| **前端路由** | 统一成一个 SPA：`/manager/*`（经理端）+ `/topics`·`/content`·`/publish-warehouse`·`/final-editor`（员工侧）+ `/workbench`。经理端页面**按路由 lazy 分割**（构建产物里是独立 chunk，很正确） |
| **API 前缀自洽** | 经理端前端 `baseURL = apiUrl('/api/management')`，后端挂在 `/api/management`，**两边对得上** |
| **构建** | `npm run build` ✅ 成功（`dist/assets/index-*.js` + 5 个经理端 chunk）。经理端 CSS 并入了 Tailwind 产物（**判断 4 选的 A**） |
| **测试** | `npm test` → **366 passed / 0 failed**（比合并前的 365 多 1 条） |
| **冒烟** | `npm run verify:routes` → **194 passed / 0 failed** —— **合并没破坏任何后端契约** |
| **服务器** | 实测能启动（8787），所有 provider 配置就绪；未登录访问 `/api/management/customers` → **401**（鉴权生效） |
| **部署栈** | `Dockerfile`（多阶段、装 ffmpeg、非 root `node` 用户、tini）、`deploy/compose.yml` + `compose.local.yml` + `nginx.conf` + `backup.sh`/`restore.sh` + `mongo-init.js` |
| **本地库已起** | Docker 里 `xiaomang-local-mongo-1`（mongo:8.0，映射 `127.0.0.1:27018`），**app `.env` 已经指向它** —— 方向完全正确，正是本次改造的目标 |
| **凭据卫生** | `.migration/` 已进 `.gitignore`（第 14 行），`source.env` 权限 `600`，**未被 git 跟踪** |

### B. 🔴 四个问题，**按严重度排序**

#### 🔴🔴 问题 1（**会导致系统跑不起来**）：数据库迁移**还没执行**

**实测证据**：
```
本地库 mongodb://127.0.0.1:27018 / xiaomang  → 3 个集合，全是 0 条
   （tasks / customers / employees 是服务器启动时建索引产生的空壳）
Atlas 源库 / test                            → 18 个集合、users 1、employees 2（数据完好）
.migration/ 目录                             → 只有 source.env，**没有 mongo-<stamp> 备份目录**
                                                → 说明迁移脚本从未成功跑完
```
**后果**：app 现在指向空库 → **任何人都登录不进去**（实测 `POST /api/auth/login` → 401
「账号或密码错误」），且没有任何客户/任务数据。**系统处于「代码能跑、但没有数据」的状态。**

**迁移脚本本身写得很好**（`apps/server/scripts/migrate-local-mongo.mjs`，119 行）：
源库只读、先建备份、逐集合对账、`manifest.verified`、
**把明文密码 bcrypt 化并用 `bcrypt.compare` 回验**、写完 `$unset` 明文、manifest 权限 `0600`。

**卡在哪**：脚本连接 Atlas 失败。`MIGRATION_DNS_OVER_HTTPS=1`（走 Cloudflare DoH）
实测报 `fetch failed / ECONNRESET` —— **本机网络把 Atlas 与 Cloudflare DoH 都阻断了**
（DNS 解析到 `198.18.x.x` 保留网段，DNS 假 IP → TLS 被重置）。

**执行命令**（网络恢复后跑，**注意必须在 `apps/server` 目录**，`.env` 在那里）：
```bash
cd /Users/ypc/Desktop/归档项目/xiaomang/apps/server
MIGRATION_DNS_OVER_HTTPS=1 node scripts/migrate-local-mongo.mjs
# 若 DoH 也被拦，脚本还支持走本地 SOCKS：
# MIGRATION_SOCKS_HOST=127.0.0.1 MIGRATION_SOCKS_PORT=<port> node scripts/migrate-local-mongo.mjs
```
**跑完要验收四件事**：① `.migration/mongo-<stamp>/` 出现备份；
② `manifest.json` 里 `verified: true`；③ 本地库集合数 = 18、users/employees/customers/tasks 条数对得上；
④ **用真实账号登录成功**（这是最终判据）。

#### 🔴 问题 2：出图密钥**变量名不一致 → 出图静默不可用**

- 代码读 `XXCAPI_API_KEY`（`apps/server/api/_lib/contentAgent/imageProvider.js` 第 44 行）；
- 但 `.env` 里配的是 **`XINGCHEN_API_KEY`**（有值，51 字符）；`XXCAPI_API_KEY` **未定义**。
- 后果：`isImageGenerationConfigured()` 恒 false → 3.1 出图**永远回 501**，
  但用户看到的是「服务器未配置出图密钥」，会以为是没买/没配，而其实**密钥就在那儿，只是名字不一样**。
- **修法（二选一）**：把 `.env` 改名为 `XXCAPI_API_KEY=...`，
  或让 `getImageConfig()` 同时认 `XXCAPI_API_KEY || XINGCHEN_API_KEY`（**建议后者**，两边都认更稳）。
- ⚠️ **`.env.example` 里这两个变量一个都没有** → 新人照着 example 配不出出图。

#### 🟠 问题 3：经理端 API（`/api/management/*`）**零「路由冒烟」覆盖**

> 注意区分：**单元测试是有覆盖的**（`manager-integration.test.mjs`，见 C-1）。
> 缺的是**起真服务器打 HTTP 的那层**（`scripts/verify-server-routes.mjs`）。

- 194 条冒烟断言**全部**打在员工侧与账号定位侧（`/api/*`），
  **没有任何一条覆盖 `/api/management/{customers,tasks,employees,projects,ai}`**。
- 而这块是**本轮新合并进来的代码**（Mongoose→原生驱动重写、6 个 model 的校验）。
  现在它「能构建、能启动」，但**没有回归网** —— 以后改动能悄悄改坏。
- 建议补冒烟：员工/未登录访问 `/api/management/*` → 403/401（**权限边界**）、
  经理端客户的增删改查、任务创建与批量、员工 CRUD 的 `account` 唯一性冲突 → 409。

#### 🟠 问题 4：git 历史里有**明文数据库密码**（推远端前必须处理）

- 实测：**3 个提交**（`bc98f6e9`、`443e2ea4`、`ded2582b`）都含
  `MONGO_URI=mongodb+srv://2146986718_db_user:<明文密码>@cluster0...`，
  且**与当前线上密码是同一个**（sha256 一致，非占位符）。
- 现状**不算事故**：仓库还是纯本地、没有 remote。
- **但只要 push 到任何远端（GitHub / Gitee / 腾讯云 CODING），凭据即泄露**。
- **处理建议（按顺序）**：
  1. **轮换 Atlas 数据库密码**（最稳，因为密码已经落过盘）；
  2. 推远端前用 `git filter-repo --replace-text` 抹掉历史里那串；
  3. 顺手把 `apps/server/.env` 也确认在 `.gitignore`（已确认 `xiaomang` 的 ignore 覆盖 `.env`）。

### C. ⚠️ 两个结构性观察（不是 bug，但要知道）

1. ✅ **测试覆盖没有缺口（已核实）**：比对两边测试文件清单 ——
   旧 xiaomang2 的 **23 个测试文件一个都没丢**，新增了 `manager-integration.test.mjs`，
   所以 **366 = 365 + 1** 完全对得上。`apps/server/tests/` 确实被 `npm test` 覆盖。
2. **`/api/auth/*` 与 `/api/management/*` 是新旧两套风格**：前者是 xiaomang2 的
   `{success, user}` 包装，后者是另一个项目的裸 JSON。**前端已经各按各的解析、能跑**，
   但以后统一 API 响应风格时要一起改，别只改一半。

### D. 本次 review 我自己造出来的痕迹（**需清理**）

- 我在**源库 `test`** 上跑过冒烟脚本，它会建**临时库**、跑完 `dropDatabase()`。
  实测 `test` 库里残留了几个 `xmpubverify_*` 临时库名可见（Atlas 的 `listDatabases` 里能看到），
  **是空库，不含业务数据**，可留可删。
- 我启动过一次合并项目服务器（8787），**已 kill**。
- **我没有修改 `xiaomang` 里的任何代码**（只读审查）。
- **我没有执行数据库迁移**（网络阻断，见问题 1）。

### E. 本轮实测数字（`归档项目/xiaomang`）

```
npm test                    → 366 passed / 0 failed / 0 skipped
npm run verify:routes       → 194 passed / 0 failed
npm run build               → 成功（index-*.js 772KB + 5 个经理端 lazy chunk）
服务器启动                   → 成功（8787，所有 provider 已配置）
未登录访问 /api/management   → 401 ✅
本地库 mongodb:27018/xiaomang → 3 个集合，0 条数据（⚠️ 迁移未执行）
Atlas 源库 test              → 18 个集合，users 1 / employees 2（数据完好）
```

### F. 下一会话的建议顺序

1. **先问用户网络是否可用**，然后**执行迁移**（问题 1）→ 验收登录。
   **这是让系统真正可用的唯一阻塞项。**
2. 修问题 2（出图密钥变量名，一行代码或一行 `.env`）→ 顺手补 `.env.example`。
3. 补问题 3 的经理端冒烟断言。
4. 处理问题 4（轮换密码 + 洗历史），**在 push 之前**。
5. 上面做完，才算合并真正收尾；然后再回到 §0.5 的后续（腾讯云部署加固）。

---

## 0.5 架构合并方案（✅ **已执行**，保留作背景）

> ⚠️ **这一节是「方案」，已经被用户执行了。执行结果与遗留问题的审查见 §0.6。**
> 保留它的价值：① 里面那份「现状事实」表说明了两边差异；
> ② 阶段 1~6 的划分仍是后续（腾讯云部署加固）的依据；
> ③ 四个「预告的坑」中**已经应验了两个**（数据库迁移、明文密码）。
>
> 用户原话：
>
> > 「这一块就先这样吧，我觉得再做 3.1～3.2 功能之前，我们需要解决一个架构问题，
> > 现在本项目只是整套系统的一个板块，整套系统有两个板块组成共用一个云 mongodb 数据库，
> > 以此完成数据互联和传输。但是现在我想将整套系统的架构合二为一，变成一个项目，
> > 这样的话就可以先使用本地 sqlite 或 mongodb 来存储数据，之后我打算部署在腾讯云上……
> > 这样可以完美解决延迟慢和数据库有时不可达的问题。
> > 另外一个项目（项目经理网站）：`/Users/ypc/Desktop/归档项目/ai-project-assistant-main`。
> > 你帮我构思一下执行方案和改造计划。」

### A. 现状事实（**已逐条核实，不是推测**）

| | **xiaomang2**（本项目，员工端 + 账号定位） | **ai-project-assistant-main**（项目经理站） |
|---|---|---|
| 路径 | `/Users/ypc/Desktop/归档项目/xiaomang` | `/Users/ypc/Desktop/归档项目/ai-project-assistant-main` |
| 规模 | 186 文件（codegraph 索引）/ 明显更大 | **35 文件 / 4,958 行** |
| 后端 | Express + **原生 mongodb 驱动** | Express + **Mongoose** |
| 模块制式 | **ESM**（`import`） | **CommonJS**（`require`） |
| 前端 | React 18 + Vite + **Tailwind 4** | React 18 + Vite + **纯 CSS（无 Tailwind）** |
| 路由库 | `react-router` **v7** | `react-router-dom` **v6** |
| 鉴权 | bcrypt `passwordHash` + `role`(manager/employee) | `users.passwordHash`(bcrypt) + `employees.password`(**明文，有兼容意图**) |
| git | ❌ **不是仓库（没有回退能力）** | ✅ 是仓库 |
| 部署 | Vercel + 本地 Express 8787 | Vercel + docker-compose |

**共用集合只有 5 个**（已核对 `mongoose.model('X')` → 集合名，以及 xiaomang2 的
`collection("...")` 调用）：

```
users(1)  employees(2)  invitecodes(1)  customers(5)  tasks(5)   ← 两边共用
projects(0)                                                     ← 另一个项目有 model，但是**空集合**，xiaomang2 从不碰
+ xiaomang2 独有 12 个报告/缓存集合（benchmark_reports、gold_three_second_transcripts…）
```

**整个库只有 0.9 MB / 18 个集合** —— 迁移成本几乎为零。

**一个关键好消息**：xiaomang2 的 `authStore.verifyPassword()` **本来就兼容明文密码**
（有 `legacyPassword` 分支），也就是说它现在就能读另一个项目写的 `employees` 记录。
**鉴权不是拦路虎**，但字段分歧必须在合并时一次性收口（见 D-1）。

### B. 我给出的三个判断（方案的核心）

**判断 1：合并方向正确，且比想象中便宜。**
两边都是 **React 18 + Vite + Express + MongoDB**，共用 5 个集合，另一个项目只有 5k 行。
这不是「异构系统对接」，是「同一套技术栈的两个前端 + 两套后端路由」。

**判断 2：🔴 数据库不要换 SQLite。**
用户想换 SQLite 的动机是「解决延迟慢和数据库有时不可达」，但**根因不是数据库类型，
是「跨公网连 Atlas」**。自建 MongoDB 放在**同一台腾讯云 CVM** 上，延迟就到亚毫秒级。
换 SQLite 的代价：现有数据层大量用了 MongoDB 特有写法（聚合管道 `$concatArrays + $filter`
做原子数组更新、`$project` 嵌套投影、`distinct`、`createIndex(unique)`），
**换库等于把 15 个 store 全部重写 + 365 条单测与 194 条冒烟断言推倒重来**。
→ 建议**自建 MongoDB（同机）**。真要 SQLite 应该是独立决策，不该和合并绑在一起做。

**判断 3：分阶段做，先把「数据只有一份」坐实。**
最危险的不是代码合并，是**过程中两边同时写库导致数据打架**。

### C. 目标架构（建议形态）

```
xiaomang/                        ← 一个 npm workspace 仓库（建议用另一个项目的 git 历史打底）
├── apps/
│   ├── web/                     ← 唯一前端：React 18 + Vite + Tailwind
│   │   └── src/{employee,manager,positioning,shared}/
│   └── server/                  ← 唯一后端：Express
│       └── src/{routes,data,agents}/
├── packages/shared/             ← 双方共用的类型/常量/纯函数
└── deploy/                      ← docker-compose（app + mongodb）+ nginx + 备份脚本
```

### D. 🔴 五个必须**用户拍板**的决策点（我给了建议，但没替他定）

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| **1** | **前端合并深度** | A. 真合并成一个 SPA（统一登录/导航/按角色显示菜单）<br>B. 两个 SPA 共用一个后端 | **A**（两边都是 React+Vite，合并后只维护一套登录态） |
| **2** | **数据库** | A. 自建 MongoDB（同机）<br>B. SQLite | **A**（见判断 2） |
| **3** | **统一到哪个数据访问层** | A. 全部统一到**原生驱动**（另一个项目 6 个 model 改写）<br>B. 全部统一到 **Mongoose**（xiaomang2 的 15 个 store 改写）<br>C. 两套并存 | **A**（只改 6 个文件；xiaomang2 的复杂聚合不用动）。<br>⚠️ **C 是陷阱**：两套 ODM 对同一集合的 schema 认知必然漂移 |
| **4** | **CSS 体系** | A. 统一到 **Tailwind**（另一个项目 ~12 个页面重写样式）<br>B. 各自保留 | **A**（统一后才有「一个项目」的样子） |
| **5** | **腾讯云形态** | A. 一台 CVM + docker-compose（app + mongodb）<br>B. CVM 跑应用 + 腾讯云托管 MongoDB | **A**（最省、延迟最低）；要托管库再上 B，代码只换 `MONGODB_URI` |

### E. 分阶段执行计划（每阶段结束系统都可运行）

| 阶段 | 内容 | 预估 |
|---|---|---|
| **0. 冻结与基线** | xiaomang2 **全量拷贝归档**（它不是 git 仓库，没有回退能力，这步不能省）；记录基线 `365/0` + `194/0` + build 成功；另一个项目打 tag | 半天 |
| **1. 建骨架** | 用另一个项目的 git 仓库做底改造成 workspace；建空壳 `apps/web`、`apps/server`、`packages/shared`；**业务代码先原样放着**，只换目录 | 1 天 |
| **2. 数据库本地化** ⭐ | CVM 起 MongoDB（加认证、只监听内网）→ `mongodump`/`mongorestore`（0.9MB，几秒）→ 写**对账脚本**（逐集合比条数 + 抽样比文档哈希）→ 两边指向新库 → 跑完整冒烟。**✅ 做完这步，用户说的延迟/不可达当场解决，即使合并暂停收益也已拿到** | 1~2 天 |
| **3. 后端合并** | 另一个项目 6 个 Mongoose model → 原生驱动 store（各 ~50 行）；6 个路由搬进 `apps/server`（**路径保持 `/api/...` 不变**）；统一鉴权；**冒烟断言合并成一个脚本**（防回归关键） | 3~5 天 |
| **4. 前端合并** | `react-router` 统一 v7（v6→v7 渐进兼容，`react-router-dom` 导入改 `react-router`）；两套 `AuthProvider` 合一；另一个项目 12 个页面套 Tailwind；统一导航按角色渲染 | 3~5 天 |
| **5. 部署加固** | docker-compose（app + mongo 数据卷 + nginx）；MongoDB **每日 `mongodump` 到对象存储保留 7 天**；密钥别再用项目目录里明文 `.env`；**灰度：先切员工端观察一天，再切项目经理站** | 1~2 天 |
| **6. 收尾** | 更新 HANDOFF（新增「合并后架构」+ 部署手册）；归档旧仓库 | 1 天 |

**合计约 10~16 个工作日。**

### F. 🔴 我预告的四个坑（做的时候重点盯）

1. **`employees` 密码字段分歧**：另一个项目写 `password`（明文），xiaomang2 写 `passwordHash`。
   合并时**必须先做一次数据迁移把明文批量 bcrypt 化**，否则两套登录逻辑各修各的、越走越远。
2. **`tasks` 是唯一的数据交接点**：项目经理站写任务、员工端读任务。合并后**这条链必须优先保通**
   —— 它是业务主干（xiaomang2 的 `taskStore` 聚合里带 `customerId`，这是它读选题库拿标签的钥匙，
   见 §0.1「接线点」）。
3. **以谁的 git 历史为基座**：另一个项目**是** git 仓库、xiaomang2 **不是**。
   建议以另一个项目的仓库为基座，把 xiaomang2 作为一次大提交进去。
4. **Vercel → 腾讯云的假设差异**：现有端点有 serverless 假设（例如 300s `maxDuration`）。
   自建服务器没有这个限制，但**也没有自动扩缩**；转写这类长任务要改成后台任务 + 轮询，
   不能靠单次请求撑 300 秒。

### G. 🔴 **在等用户回答的问题（下一会话先问这些，别自己猜）**

1. **还有别的系统/客户端在读这个库吗？**（小程序、报表、别人的脚本）—— 有的话合并期间库结构不能动。
2. **腾讯云那边买了吗？什么配置？** —— 决定 MongoDB 自建还是托管。
3. **两个站的用户是同一批人吗？** 项目经理是否也用员工端功能？
   —— 合并后**角色模型怎么统一**是设计问题，不只是代码问题。
4. **D 节那五个决策点**（最影响工作量的是 1、3、4）。

### H. 我的建议：可以只做阶段 2

**阶段 2（数据库本地化）收益最大、风险最小**：做完你的延迟与不可达问题当场解决，
合并可以慢慢来。**建议向用户提议先单独做这一步**，不必等五个决策点全部拍板。

### I. 本轮为这个改造做的「顺手修复」（**与改造相关，别重复踩**）

在做发布仓与权限开放的过程中，数据库一度不可达（见 §0.3-H），暴露出几个问题，
已修复并且**这些经验在阶段 2/3 会直接用到**：

1. **`authStore.verifyPassword()` 已兼容明文密码** —— 这是阶段 3 统一鉴权的现成基础。
2. **`closeMongoClient()` 已加到需要考虑进程退出的 store**（`accountPlanStore` /
   `publishWarehouseStore`）：需要真实库的测试若不关掉 store 缓存的 MongoClient，
   `node --test` **会挂住不退出**（不报错、不结束）。
3. **`tests/helpers/mongo-temp-db.mjs`（🆕）**：需要 DB 的测试共用 `.env` 解析 +
   **失败缓存**（否则每个测试文件各等 6~8 秒超时）。
   ⚠️ 它踩过一个坑：helper 在 `tests/helpers/`，`.env` 在**上两级**，
   写成 `../.env` 会指向不存在的 `tests/.env` → `mongoUri` 恒空 → **所有 store 测试静默跳过**
   （看起来像「环境没配」，其实是路径写错）。**已修，有注释钉着。**
4. **数据库不可达时 store 测试要干净跳过**，不能把 `npm test` 弄红（开发机常在代理/VPN 后面，
   MongoDB 的 TLS 握手会被重置，DNS 解析到 `198.18.x.x` 保留网段）。

---

## 0.3 第七轮会话交接：发布仓 ✅（架构已合并，现状看 §0.6）

> 自包含：读完它就能接手。⚠️ **本文档有「反复滞后于代码」的前科（已三次），务必拿代码核对。**

### A. 这一轮在做什么

用户要求：**在内容生成页之后新增「发布仓」页面**，做三块选择（【3.1 封面】【3.2 发布文案】
【3.3 发布标签】），UI 沿用内容生成页；并把内容生成页的**核查、写入飞书文档/多维表格、导出**
都搬到发布仓 —— 「因为现在发布仓功能页才是最后一个步骤」。

**用户当场拍板的三条口径**：

| 问题 | 结论 |
|---|---|
| 发布仓与 `/final-editor` 的关系 | **发布仓插在中间，`/final-editor` 仍然在最后**（最终文案编辑页保留） |
| 3.1 封面做到哪一层 | **完整实现，包括真的生成图片**（不是只出提示词） |
| 3.2 四类发布文案怎么生成 | **金句+互动走 Agent；标题+3s 直接复用**内容生成页已确认的结果（不重跑模型） |

**出图用哪家**：用户指定 **星辰API（`https://xxcapi.com`）**，OpenAI 兼容协议，
模型 **`gpt-image-2.5-sunburst`**。它同时提供 `/v1/images/generations`（文生图）与
`/v1/images/edits`（multipart 参考图编辑）—— 后者正好对应文档里
「结合客户现有参考照片生成 IP 形象照」。

### B. 已完成（按「用户能看到什么」列）

1. **发布仓页面**（`/publish-warehouse`，员工端）：顶部选题切换，下面三块分栏
   —— 3.1 封面 / 3.2 发布文案 / 3.3 发布标签，最后是「核查与导出」。
2. **3.1 封面**：出方案（IP 形象照提示词 / 对标封面拆解 / 标题样式 / 4 个背景候选）
   → **提示词可人工改** → 确认后**真的出图** → 出图结果作为封面候选，
   可直接把标题**以选定样式叠在封面上预览**（文字用 CSS 叠，不让模型写字，否则会写成乱码）。
3. **3.2 发布文案**：金句与互动由 Agent 出；**标题与 3s 直接复用**内容生成页已选结果。
   界面上每一类都标了来源（`AI 生成` / `复用已有`），用户能分清哪句是谁写的。
4. **3.3 发布标签**：账号标签库（细分赛道 / 用户核心痛点 / 内容核心定位，各 2 候选 → 人工确认 1）
   **持久化复用**（文档：账号恒定）；选题标签严格按**小类x2 + 脚本核心内容x2 + 目标用户x1**，
   界面显示配额进度（如 `小类 2/2`），凑不够的**如实列出缺额**。
   三个角度的**主来源是 1.3 账号规划** —— 用户随后追加指令「直接开放权限」，
   边界见 **§0.4**（按客户开放，按 id 读与写操作仍 manager-only）。
5. **核查与导出搬到发布仓**：写入飞书文档、写入/创建多维表格、确认无误（结束任务）。
   内容生成页那一屏改成「下一步：进入发布仓」的交接。
6. **不配置出图密钥也不崩**：缺 `XXCAPI_API_KEY` 时回**可读的 501**，
   前端提示「配好密钥即可出图」，提示词链路照常可用。

### C. 改了什么（文件地图）

| 文件 | 作用 |
|---|---|
| `api/_lib/publishWarehouse.js` | 🆕 **纯逻辑层**（无模型、无 DB）：三块产出的归一化、配额裁剪、发布文本拼装。**单测主要打这里** |
| `api/_lib/publishWarehouseStore.js` | 🆕 两个集合：`publish_account_tags`（账号恒定，按客户唯一）+ `publish_selections`（每条选题，按 topicId 唯一） |
| `api/_lib/contentAgent/imageProvider.js` | 🆕 **出图 provider**（星辰API）：文生图 + 参考图编辑 + 参数收敛 + 体积限制 + 日志脱敏 |
| `api/_lib/contentAgent/publishAgents.js` | 🆕 三个 Agent 的输入组装与调用（封面 / 发布文案 / 标签） |
| `api/_lib/contentAgent/prompts.js` | 新增 `PUBLISH_COVER_PROMPT` / `PUBLISH_COPY_PROMPT` / `PUBLISH_TAGS_PROMPT`，清单从 `publishWarehouse.js` 派生 |
| `api/_lib/publishAgentRunner.js` | 🆕 **共享编排**：phase 分流、入参裁剪、账号上下文读取、出图阶段 |
| `api/agent/publish.ts` + `server/index.js` | 发布 Agent 端点（两套后端同构） |
| `api/publish-warehouse/index.ts` + `server/index.js` | 发布仓持久化端点（`?resource=selections\|account-tags`） |
| `vercel.json` | 新增两个函数的 `maxDuration` |
| `src/app/PublishWarehousePage.tsx` | 🆕 发布仓页面 |
| `src/app/publishWarehouseApi.ts` | 🆕 客户端接口与类型 |
| `src/app/ContentPage.tsx` | 导出/核查 UI 换成「进入发布仓」交接；**顺手修掉 `unbindBitableBinding` 声明被吃掉的语法错误** |
| `src/app/main.tsx` | 注册 `/publish-warehouse` 路由 |
| `tests/image-provider.test.mjs` | 🆕 11 条（出图请求形状 / 返回解析 / 密钥不进日志 / 体积与张数限制） |
| `tests/publish-warehouse.test.mjs` | 🆕 13 条（三块归一化与配额） |
| `tests/publish-agent-runner.test.mjs` | 🆕 7 条（输入组装 / 复用硬约束 / 配额由后端执行） |
| `tests/publish-warehouse-store.test.mjs` | 🆕 store 契约（需 MongoDB；**连不上会干净跳过**） |
| `scripts/verify-server-routes.mjs` | 新增发布仓断言（鉴权 / 校验 / 保存读回 / 用户隔离 / 阶段校验 / 出图缺密钥 501） |

**两套后端同构**：本次改动同样全部落在 `api/_lib/**` 共享层，路由层只是薄壳
（Express 侧挂在已有的 `/api` 鉴权中间件之下，新路由自动受保护）。

### D. 🐛 CDP 渲染验证抓到的真 bug（**第 2 次了**）

**账号标签保存后整页崩溃**：渲染层写的是
`(accountTags?.angles.find(...)?.candidates || []).map(...)`，
而 `accountTags` 在**保存后的读回**或**空结果**时可能是 `undefined` / 没有 `angles` →
`Cannot read properties of undefined (reading 'find')` → **整页白屏**。

两处修法（缺一不可）：
1. `loadAccountTags` 里**空结果如实提示**，不再 `setAccountTags(undefined)`；
2. 渲染层改成 `.map(angle => { const candidates = (accountTags?.angles || []).find(...)?.candidates || []; return (...) })`
   —— **派生值先取出来再用**，不要写成 `a || [].map(...)`（`.map` 会绑到 `[]` 上）。

单测全绿、`npm run build` 成功、`node --check` 全过 —— **只有真渲染才暴露**。
（上一轮同样的事：前端解析丢弃 `candidates`，也是 CDP 抓的。见 §0.2-E。）

### E. 当前状态（数字都要能复现）

- ✅ **[会话末更新] MongoDB 已恢复，全部真跑过**：
  **单测 365 / 365 pass / 0 fail / 0 skipped**（311 → 365：新增 11 + 13 + 7 + 11 + 9 + 3 条，
  store 两组已能真跑）；**冒烟 194 / 0**（150 → 194）。
- **`npm run build` 成功**（`dist/assets/index-BfJZHRgv.js`）。
- **CDP 渲染验证 35 / 0**（真组件 + 真路由 + 桩 fetch，12 条真实请求）。
- ✅ **冒烟已复跑：194 passed / 0 failed**（含本轮新增的发布仓与权限断言）。
  ⚠️ **Vercel 侧仍没有部署验证过**。
- **没有 git**：这个目录不是仓库，改动无法 `git diff` 回看。
- 脚手架（`scaffold-publish.html` / `scaffold-pw-verify.mjs`）**已删干净**，
  截图留在 `.preview-shots/publish-warehouse.png`。

### F. 🔴 绝对不要再踩的坑（本轮新增）

**F1. 出图是唯一花钱的步骤，必须由用户确认提示词后再触发。**
3.1 文档的顺序是「给出提示词 → **人工修改确认** → 再生成图片」。
所以 `cover-plan`（出方案）与 `cover-image`（出图）是**两个 phase**，
不要合并成一次调用 —— 合并会在用户还没看提示词时就先把钱花了。

**F2. 参考图存在时必须走 `/v1/images/edits`（multipart），不能走 generations。**
文档要求的「结合客户现有参考照片生成 IP 形象照」只有 edits 做得到；
只实现 generations 会做出一个「看起来能用、但永远用不上客户照片」的功能。
编辑接口**不要手写 `Content-Type`**，要让 fetch 自己带 boundary。

**F3. 密钥绝不进日志、绝不进代码、绝不回显。**
`imageProvider.js` 里日志只记「模型 / 尺寸 / 张数 / 耗时 / 从 url 还是 b64 回来」，
**不记密钥、不记图片内容**（base64 几十 MB 会把日志撑爆，也等于把客户素材写进日志）。
这条有单测钉着（`日志里不出现密钥与图片内容`）。

**F4. `apportionRatios` 那类「静默返回空」的坑在本轮又出现了一次不同版本**：
`(x?.y.find(...)?.candidates || []).map(...)` 这种写法**极易读错** ——
`.map` 实际绑在 `[]` 上，而不是整个 `||` 表达式上。派生值一律**先赋值再用**。
（§0.2-G1 是同一族问题的另一种表现：不报错，只是结果不对或整页崩。）

**F5. 发布仓有两个集合，生命周期完全不同，不要合并。**
- `publish_account_tags`：**账号恒定**（文档原话「作为账号恒定的标签库」），
  人工确认一次后长期复用 —— 每轮重生成会让用户每轮都要重确认，而且标签会漂。
- `publish_selections`：**每条选题一份**，换一批选题就是新的一份。
两者都按 `{owner, customerId}` / `{owner, customerId, topicId}` 唯一，**都按当前登录用户隔离**
（发布仓在员工端，员工之间互不可见）。

**F6. 3.2 的「复用」是硬约束，不要图省事让模型把四类都写一遍。**
用户明确要求「标题复用选题的标题」——让模型再写一遍会与用户已确认的内容**不一致**，
还白花一次模型调用。`normalizePublishCopy(agentValue, reuse)` 的第二个参数就是这条约束的落点，
有单测钉着（模型只回金句时，四类仍然齐）。

**F7. 封面文字用 CSS 叠，不要让模型在图上写字。**
出图提示词里明确写了「不要写具体文字内容」—— 模型写中文字会写成乱码字。
标题由前端按 `titleStyle`（字体/字号/颜色/位置）叠加。

**F8. 账号标签取不到 1.3 账号规划时不要卡住。**
1.3 报告是 **manager-only**，而发布仓要在员工端跑。为了让账号标签这条链不掉链子，
`loadAccountContext` 改用员工**本来就能读**的选题库轻量视图
（大类名 + 核心功能 + 关键词）来推三个角度。
**不要为了让标签更准就去放开 1.3 报告的员工读权限** —— 那是三处权限口径里的一条（§3.7(d)）。

### G. 仍未做 / 未决

1. **真实端到端验收未做（本轮最大的未知）**：
   - **出图没跑过真图**（当前 `.env` 里没有 `XXCAPI_API_KEY`，没人验证过真实出图效果）；
   - 三个新 Agent **没有用真模型跑过**（单测 + 冒烟 + CDP 全是桩）。
   **真实验收要确认**：① 出图质量与「关键词是否真的体现在背景里」；
   ② 参考图编辑（客户照片）出来的 IP 形象照可用性；③ 发布文案的金句/互动质量；
   ④ 账号标签三个角度是否贴合账号定位。
2. **标题类型配比仍不存在**（§0.2-B 遗留）：3.2 的「标题」是复用，不是新生成 —— 与这条一致。
3. **标签抖动没有量化**（上上轮遗留，仍是最大质量不确定性）。
4. 用户提过「还有一个问题要解决」，**始终没说清是哪个**（§0.0-D.3）。

### H. ⚠️ 本轮的环境异常（**已恢复，但会再犯**）

**MongoDB 中途变成不可达**：域名解析到 `198.18.0.41`（保留网段，典型代理/VPN fake-IP），
TLS 握手被重置（`ECONNRESET` / `MongoServerSelectionError`）。
症状是**冒烟脚本在 `client.connect()` 就退出**。

- ✅ **会话末已恢复**：`npm test` → **365 / 365 / 0 skipped**，冒烟 → **194 / 0**
  （含本轮全部新增断言）。**所有「未复跑」的说明都已作废。**
- 这不是本轮改动引起的：**改动前冒烟是 150 / 0**，同一套 URI 当时能连上。
- **🔴 这件事本身就是 §0.5 要解决的核心动机之一** —— 用户原话
  「可以完美解决**延迟慢和数据库有时不可达**的问题」。所以 §0.5 的**阶段 2（数据库本地化）
  优先级最高**：库挪到同机之后，这类假 IP / TLS 重置 / 公网抖动就不再影响开发与运行。
- 已做的防御（**新会话别再重复踩**）：
  - `tests/*.store.test.mjs` **连不上就干净跳过**，不会把 `npm test` 弄红；
  - `tests/helpers/mongo-temp-db.mjs` 做**失败缓存**，否则每个测试文件各等 6~8 秒超时；
  - 需要 DB 的测试必须在 `t.after` 里调 store 的 `closeMongoClient()`，
    否则 `node --test` **挂住不退出**（不报错也不结束，见 §0.5-I）。

### I. 怎么验证（命令 + 期望数字）

```bash
cd /Users/ypc/Desktop/归档项目/xiaomang
npm test                                    # 期望：tests 365 / pass 365 / fail 0 / skipped 0
node scripts/verify-server-routes.mjs       # 期望：150 + 本轮新增 ≈ 180 passed / 0 failed（需 MongoDB）
npm run build                               # 期望：built in ~1s，dist/assets/index-*.js 更新
```

**出图怎么开**：在 `.env` 里加一行（**别把密钥贴进聊天、别写进代码**）

```bash
XXCAPI_API_KEY=你的星辰密钥
# 可选：# XXCAPI_BASE_URL=https://xxcapi.com
# 可选：# XXCAPI_IMAGE_MODEL=gpt-image-2.5-sunburst
```

配好后 `cover-image` 阶段就能出图；没配时该阶段回 **501** 且提示缺哪个配置项。

---


---

## 0.4 🔴 本轮追加（2026-09-21 第七轮补充）—— 1.3 账号规划权限按客户开放

> 用户指令：「**3.3 账号标签文档直接开放权限**」。
> 这一节讲清**开了什么、边界在哪、为什么这样开**，以及**哪里不能动**。

### A. 开了什么

3.3 账号标签文档要求从**账号规划（1.3）**推三个角度
（细分赛道 / 用户核心痛点 / 内容核心定位），而 1.3 报告原来是 manager-only，
发布仓又跑在**员工端** —— 不放行这条链只能用选题库关键词凑，标签质量打折。

**现在**：`GET /api/account-plan-reports?customerId=…` 对**登录用户**开放
（`requireAuth`），员工也能读。发布仓的 `loadAccountContext` 已经接上：
`getLatestAccountPlanReportForCustomer({ customerId })` 取该客户最新一份报告正文，
按真实字段路径挑出三个角度的来源（见 §0.4-C）。

### B. 🔴 边界（**这才是重点，别理解成「全开放」**）

| 请求 | 员工 | 为什么 |
|---|---|---|
| `GET ?customerId=…`（按客户列出，只元数据） | ✅ 200 | 3.3 要用 |
| `GET ?customerId=…&latest=1`（该客户最新正文） | ✅ 200 | 3.3 要用 |
| `GET ?id=…`（按 id 取单份） | ❌ **403** | 否则拿到一个 id 就能读**任意**项目经理的报告 |
| `GET`（不带 customerId，列出全部） | ❌ **403** | 绝不退化成「列全部」 |
| `POST` 保存 / `DELETE` 删除 | ❌ **403** | **写操作一条都没放开** |
| 未登录 | ❌ 401 | 放开的是「登录用户」，不是「所有人」 |

再加三条数据层保证：
1. **必须带 `customerId`**，不带直接 **400**（`listAccountPlanReportsForCustomer` /
   `getLatestAccountPlanReportForCustomer` 的第一行就校验）；
2. **不按 `managerId` 过滤**（员工不是报告属主）—— 所以**两个项目经理为同一客户
   存的报告，员工都读得到**。「最新一份」按 `createdAt` 倒序取。这是刻意的：
   员工要的是「这个客户的账号定位」，谁存的都一样有用。
3. `serializeSummary` / `serializeFull` **都不含 `managerId`**，属主身份不外泄。

### C. 🔴 字段路径必须照真实结构写（**踩过一次**）

1.3 报告的形状是**顶层就是各节正文**：

```
report.ipPositioning.businessPositioning   ← 细分赛道 / 用户核心痛点
report.ipPositioning.contentPositioning    ← 内容核心定位 + frequentTags（高频标签）
report.ipPositioning.personaPositioning    ← 人设（封面 Agent 推表情场景用）
report.topicLibrary / report.customer
```

⚠️ **而顶层 `report.sections` 只是键名数组**（`["ipPositioning", "accountSetup", …]`），
**不是正文**。我第一版就是照 `sections.xxx` 取，会**永远取到空**、而且不报错 ——
症状是「Agent 拿不到账号规划，标签只能用选题库凑」，从界面上完全看不出来。

`pickAccountPlanFields` 现在照真实路径取，并**只挑与标签有关的几块**
（账号搭建 / 内容框架 / 拍摄剪辑 / 起号运营不传，省 token 也少干扰），
认不出结构时**退回整份摘要**而不是回 `null`（回 null 会让 Agent 以为「没有账号规划」）。
**有单测钉着这条**（`tests/publish-agent-runner.test.mjs` 的
「sections 只是键名数组：照它取会得到空（回归钉子）」）。

### D. 配套改动

| 文件 | 改动 |
|---|---|
| `api/_lib/accountPlanStore.js` | 🆕 `listAccountPlanReportsForCustomer` / `getLatestAccountPlanReportForCustomer`；🆕 `{customerId:1, createdAt:-1}` 索引（不加就是全表扫） |
| `api/_lib/publishAgentRunner.js` | `loadAccountContext` 改成**两条来源**：1.3 账号规划为主、选题库为辅；🆕 `pickAccountPlanFields` |
| `api/account-plan-reports/index.ts` + `server/index.js` | 鉴权分叉：**按客户读**走 `requireAuth`，其余仍 `requireManager`（两套同构） |
| `tests/account-plan-store.test.mjs` | 🆕 跨客户隔离 / 必须带 customerId / 同一客户多项目经理都读得到 / 不带 managerId |
| `tests/helpers/mongo-temp-db.mjs` | 🆕 需要 DB 的测试共用：`.env` 解析 + **失败缓存**（否则每个测试文件各等 8 秒超时） |
| `scripts/verify-server-routes.mjs` | 🆕 权限边界断言（含 4 条 403、401、跨客户、字段提取衔接） |

### E. ⚠️ 需要留意

- **1.3 报告含客户 IP 档案**（人口属性、定价等）。放开给员工是用户明确拍板的；
  同类内容在 `getTopicLibraryForEmployee` 里当初是**刻意收窄掉**的，两处口径现在不同，
  **别再当成不一致去「统一」**。
- **要收回**只需改 `accountPlanStore.js` 那两个函数（端点无需改动）。
- ✅ **[会话末更新] 冒烟已复跑：194 / 0**，本节新增的权限断言**全部真跑过并通过**
  （4 条 403、401、跨客户隔离、字段提取衔接）。

### F. 本节实测

```text
npm test        → 365 / 365 pass / 0 fail / 0 skipped
npm run build   → 成功
冒烟            → 194 / 0（含本节的权限边界断言）
```

---

## 0.2 🔴 本轮会话交接（2026-09-21 第六轮）—— 新会话先读这一节

> 这一节是**自包含**的：读完它就能接手，不必先读完整份文档。
> ⚠️ **本文档有「反复滞后于代码」的前科（已三次），接手时务必拿代码核对。**

### A. 这一轮在做什么

用户要求改**内容生成页**（`/content`，员工二创）：

> 二创文案的 agent 功能不变，而**三秒、结尾钩子和标题**的 agent 需要结合选题库中
> 黄金三秒库进行二创：① 判断原文案的三秒类型；② 按这篇内容所属**大类**适配的
> 三秒类型配比，**生成 10 条新的三秒选项**，并**按配比分配给不同的三秒类型**。

例：某篇属于「政策解读与环境洞察」，该大类适配黄金三秒
（求知欲 40%、恐惧 30%、愤怒 20%、反差 10%）→ 10 条候选 = 求知欲 4 + 恐惧 3 + 愤怒 2 + 反差 1。

**用户当场拍板的三条口径**（不用再问）：

| 问题 | 结论 |
|---|---|
| **标题 agent 要不要一起做** | ❌ **本轮不做**，只做**三秒 + 结尾钩子**两项。原因见下面的「🔴 关键缺口」 |
| **10 条怎么按配比切** | **最大余额法**换算成条数、总数凑满 10（复用项目已有的 `apportionRatios`） |
| **每条视频的大类从哪来** | 直接用**今日选题页已判定**的 `categoryName` 带下来，**不重新判** |

### B. 🔴 本轮的关键缺口（为什么会砍掉标题）

**「标题类型」的配比在全项目里不存在。** 用户给的第三张图要求
「大类 → 标题类型配比（恐惧 40%/求知欲 30%/愤怒 30%）」，但：

- 搜 `标题类型` / `titleType` / `titleTypes` / `titleBreakdown` → **零命中**；
- 全项目**没有任何一个分析步骤给标题分过类**，也没有任何地方统计过「某大类的标题类型配比」；
- 图 3 那三个类型名（恐惧/求知欲/愤怒）与**三秒的 8 个维度同名**，图里还写着
  「按3秒判断：好奇心+求知欲」——所以「标题类型」极可能就是**同一套 8 分类换个分析对象**，
  但**这份数据必须新跑一次分析才能得到**，不能凭空造。

已与用户确认：**本轮只做三秒 + 结尾钩子**，标题 agent 保持原样（纯内容改写）。
**要补标题，得先新增「标题类型分析」步骤**（新 Agent + 报告存储 + 端点 + 进库），
别拿三秒配比顶替（两者分析对象不同，口径会混）。

### C. 已完成（按「用户能看到什么」列）

1. **三秒候选按配比生成 10 条**：内容生成页的「3 秒留存」卡片里，除了原有的
   「原文提取」，会多出 **10 条按该篇所属大类配比分配的新开场**，每条带一个类型徽章
   （求知欲/恐惧/愤怒/反差…）。
2. **结尾钩子候选同理**：按大类的结尾钩子配比（共鸣＋IP符号/金句/引导互动…）
   生成 10 条带类型的新结尾。
3. **类型徽章可见**：候选上直接标出它属于哪个类型 —— 这是「10 条按 40/30/20/10 分配」
   在界面上的落地证据（只存不显示等于没做）。
4. **没有选题库时不退化**：查不到库 / 这条没有大类标签 / 该大类在库里没有配比记录，
   三种情况都**自动退回原来的自由二创提示词**，照常出结果，不会报错也不会空手。
5. **配比是后端实算的**：10 条怎么分由后端算好、**逐槽位指定类型**写进提示词，
   模型只负责往槽位里填文案。**绝不让模型自己分配配比**（§6.3⑬ 同一条纪律）。

### D. 改了什么（文件地图）

| 文件 | 作用 |
|---|---|
| `api/_lib/topicCreativeAdaptation.js` | 🆕 **纯逻辑层**（无模型、无 DB）：配比→10 槽位、大类查表、提示词片段。**单测都在这个文件上** |
| `api/_lib/topicLibraryStore.js` | 🆕 `getTopicLibraryCreativeAdaptation`：第三种轻量投影，只取两份报告的配比，**不取分类树** |
| `api/_lib/contentAgent/prompts.js` | 🆕 `CREATIVE_GOLD_THREE_SECONDS_PROMPT` / `CREATIVE_ENDING_HOOKS_PROMPT`（维度清单仍从 `GOLD_THREE_SECOND_DIMENSIONS` / `ENDING_HOOK_TYPES` 生成，§6.3⑫） |
| `api/_lib/contentAgent/providers.js` | `runCreativeAgents` 接 `options.adaptation`；有配比走新 agent，**没有就走原提示词**；新增 `normalizeCreativeCandidates` |
| `api/_lib/contentAgent/adapter.js` | `normalizeOpeningHook` / `normalizeEndingHook` 放行新增的 `candidates` / `originalType`（**旧路径不产出这两个字段**，形状不变） |
| `api/_lib/contentAgent/index.js` | 🆕 `getCategoryNamesFromBody` + `loadAdaptationByLink`：**一次读库**、按链接挂到每条视频 |
| `src/app/ContentPage.tsx` | 请求体补 `customerId` + `content_adaptation`；**🐛 修掉解析丢弃 `candidates` 的真 bug**；渲染类型徽章 |
| `src/app/App.tsx` | 提交选题时把 `customerId` 落进 sessionStorage（**原来没存，二创页拿不到**） |
| `tests/topic-creative-adaptation.test.mjs` | 🆕 13 条单测 |
| `scripts/verify-server-routes.mjs` | 新增 12 条断言（含**直接调用**读库函数） |

**两套后端同构**：本次改动全部落在 `api/_lib/**` 共享层，`server/index.js` 与
`api/**` 的路由层**一行都没改**（这正是 §2.1 推荐的优先做法）。冒烟验的是 Express 那套。

### E. 🐛 本轮抓到的真 bug（**不是本轮引入的，是早就存在的**）

**前端解析把 `candidates` 整个丢掉了 —— 后端生成了 10 条，用户一条都看不到。**

`ContentPage.tsx` 里读 `开头钩子` / `结尾钩子` 时只认
`extracted` / `created`（三秒）与 `extracted_result` / `rcs`（结尾），
**新增的 `candidates` 字段没有任何地方读**。症状极隐蔽：不报错、不白屏，
后端日志一切正常，只是用户界面里那 10 条**静默消失**。

⚠️ **这段解析逻辑在文件里有两份**（当前任务一份、按链接分组一份），
**改一处不够**。已抽成 `readHookCandidates()` helper，两份共用，防止再次漂移。

**这个 bug 是 CDP 渲染验证抓到的**（单测只覆盖 `api/_lib`，构建不做类型检查，
`node --check` 也查不出「字段没人读」）。**验证不是走过场 —— 它真的拦下了一个上线级缺陷。**

### F. 当前状态（数字都要能复现）

- **测试基线**：单测 **311 / 0**（298 → 311，新增 13 条）；冒烟 **150 / 0**（138 → 150）；
  `npm run build` 成功（`dist/assets/index-CHN6b9ux.js`）；**CDP 渲染 16 / 0**。
- **`dist/` 已重新构建** —— 前端改动只有重新构建后才会在浏览器里生效。
- **Vercel 侧没有部署验证过**（只跑过本地 Express 的冒烟）。
- **没有 git**：这个目录不是仓库，改动无法 `git diff` 回看。
- 脚手架（`scaffold-*.html` / `scaffold-cdp-drive.mjs`）**已删干净**，
  截图留在 `.preview-shots/content-adapt-candidates.png`。

### G. 🔴 绝对不要再踩的坑（本轮新增）

**G1. `apportionRatios` 的调用契约（踩了两次，都是静默返回空数组）**

```js
apportionRatios(items)   // items[].ratio 是【权重】，返回 { ...item, ratio: 份额 }
```

- **字段名必须是 `ratio`**。传 `weight` 会让它读到 `undefined` → 内部 `total` 变 `NaN`
  → 判定「合计为 0」→ **直接返回空数组**，不报错。症状是配比计划永远为空。
  正确写法（与既有调用方一致）：权重 = 条数，即 `{ type, count, ratio: count }`。
- **它的输出是「合计恰好 100 的百分比」，不是条数。**
  直接把返回值当条数用会得到 40/30/20/10 → 再被 `count > 0` 过滤，仍然是空计划。
  要么让它算到 100 再折算，要么用现成的 `planCreativeSlotCounts`（本轮已封装并单测）。

**G2. 「待人工复核」（`review`）永远不进配比。**
它是人工待办队列，不是创作类型。混进来的后果是用户拿到一批
「类型名叫待人工复核」的候选 —— 等于把系统的待办当成了创作方向。
`indexBreakdownByCategory` 与 `globalDimensions` **两处都要剔**，别只剔一处。

**G3. 降级必须如实标注来源。**
`ADAPTATION_SOURCE` 三态（`category` / `library_global` / `none`）不是装饰：
查不到大类配比时**退回全库配比**是可以的，但必须让前端能说出「这次是通用配比」，
**不许假装用的是大类配比**。同理没有库时回 `none`，调用方据此退回原提示词。

**G4. 前端 `ContentPage.tsx` 的解析逻辑有两份。**
改 hooks 的解析**必须同时改两处**（当前任务 / 分组），或用 `readHookCandidates()`。
只改一处会表现为「当前任务卡片有候选、切换任务后候选消失」这种薛定谔 bug。

**G5. `customerId` 必须单独落 sessionStorage。**
它只在 `App.tsx` 的 `activeTask` 内存里，**`selectedTopics` 上并没有这个字段**。
不单独存一份（`contentCustomerId`），二创页永远拼不出配比请求 ——
**功能静默不生效**，不报任何错。

**G6. 不要用 CDP 的 `/json/list` 页面 target 发命令。**
实测：连上去 `open` 事件正常，但 `Runtime.enable` **永远不应答**（消息根本不回）。
✅ 正确做法：连 `/json/version` 的**浏览器级** WebSocket，再
`Target.createTarget` + `Target.attachToTarget({flatten:true})`，后续命令都带 `sessionId`。
另外 `WebSocket` 的 message 在 Node 里可能给的是 `Buffer`/`ArrayBuffer`，
直接 `JSON.parse(event.data)` 会抛错。

**G7. SPA 要落在指定路由，得在文档起点改路径。**
`Page.navigate` 到 `/content` 会被 Vite 的 SPA fallback 兜住，但应用是 `BrowserRouter`
（读 `location.pathname`），实测直接导航仍渲染**首页**。
✅ 用 `Page.addScriptToEvaluateOnNewDocument` 注入 `history.replaceState(null,"","/content")`，
在文档开始执行前生效。

### H. 仍未做 / 未决（沿上轮，未变）

1. **标题类型配比**（见 §0.2-B）—— 要做得先新增标题类型分析步骤。
2. **标签抖动没有量化**（上轮遗留，仍是最大质量不确定性）。
3. **真实规模端到端验收未做**：本轮的配比链路**没有用真实选题库 + 真模型跑过** ——
   所有验证都是单测 + 冒烟 + 夹具渲染（CDP 里 workflow 响应是桩的）。
   **真实验收要确认三件事**：① 真实库里 `analyses.goldThreeSeconds.report.categoryBreakdown`
   的形状与夹具一致；② 真实模型 20 次里有几次真按槽位回了 10 条、类型对不对；
   ③ 真实模型对原文案类型（`originalType`）判得准不准。
4. 用户提过「还有一个问题要解决」，**始终没说清是哪个**（§0.0-D.3）。

### I. 怎么验证（命令 + 期望数字）

```bash
cd /Users/ypc/Desktop/归档项目/xiaomang
npm test                                    # 期望：tests 311 / pass 311 / fail 0
node scripts/verify-server-routes.mjs       # 期望：150 passed / 0 failed（需要 MongoDB + .env）
npm run build                               # 期望：built in ~1s，dist/assets/index-*.js 更新
```

⚠️ **本轮改动没有任何路由层改动**，但冒烟仍然要跑 —— 它同时钉着
「读库函数确实取得到配比」这条**不经 HTTP** 的链路（脚本里直接
`await import("../api/_lib/topicLibraryStore.js")` 调它，见 §6.5㉕ 的做法）。

---


---

## 0.0 🔴 本轮会话交接（2026-09-21 第五轮）—— 新会话先读这一节

> 这一节是**自包含**的：读完它就能接手，不必先读完整份文档。
> 更早的口径见 §0.1；但 ⚠️ **本文档有「反复滞后于代码」的前科，接手时务必拿代码核对**。

### A. 这一轮在做什么

起点只有一句话：**「检查 topic 页的功能使用权限，哪些只能项目经理用、哪些员工能用」。**
顺着审计查出**一串真 bug 与体验问题**，于是滚成了 5 件事，全部做完并实测：

| # | 事情 | 状态 | 关键改动 |
|---|---|---|---|
| 1 | topic 页权限矩阵审计（三身份实测） | ✅ 已交付结论 | 无代码改动（结论见 §0.1 各节） |
| 2 | 员工只读视图顶部挂着 403 红条 | ✅ 已修 | `TopicLibraryStage` 的 effect 加 `readOnly` 守卫 |
| 3 | **「提取完整脚本」永远 0 条**（根因） | ✅ 已修 | `resolveTranscriptScope`：scope 三态不再被吞 |
| 4 | 顺序改为「抓视频 → 提脚本 → 读库 → 打标签」+ 轻量读库 | ✅ 已改 | `?view=categories` + `TopicLibraryStage` 重排 |
| 5 | 打标签：渐进显示 + **A2 短代号协议** + **B2 进度落库** | ✅ 已做 | `benchmarkTopicRefresh` / `topicRefreshSessionStore` |

### B. 已完成（按「用户能看到什么」列）

1. **权限矩阵**：写操作（建库/移除账号/删库）**只有项目经理**（员工 403，前后端双层拦）；
   「新视频筛选与打标签」整条链路**只有员工**（经理端连面板构造都跳过）；
   读选题库两边都能（员工走**收窄的只读视图**）。矩阵有实测状态码，不是读代码猜的。
2. **员工端首屏不再有 `该功能仅供项目经理使用` 红条**：员工视图原来无条件调两个 manager-only
   接口（`/api/customers`、`/api/benchmark-reports`），`Promise.all` 一抛错就渲染成红色错误条。
   现在 `readOnly` 下直接不调。
3. **转写能真的出脚本了**：完整脚本原来被写进 `scope: "head"`（开场片段缓存），
   导致 ① 2.2 拿整篇口播当「开场三秒」② `getTranscriptProgress({scope:"script"})` 永远查不到
   → 前端以为全失败，**反复重跑 20 轮**（又慢又重复烧钱），最后报「没在预期轮数内完成」。
   修完实测：`ok:0/attempted:0/finished:false` + `scope=head` → `ok:1/attempted:1/finished:true` + `scope=script`。
4. **顺序与体积**：员工端挂载时**不再读整库**（完整库带每账号三份报告快照，单份约 148 KB），
   改成点「打标签」时按需读 `?view=categories`（嵌套字段投影，只取分类树）。
   实测请求顺序：`auth/me → tikhub/batch → 转写 → topic-libraries?view=categories → 打标签`。
5. **渐进显示**：打标签改成小批流水线（每批 5 条：转写 → 立刻发该批打标签请求，
   **不 await**，与下一批转写并行 → 哪批回来贴哪批）。实测 15 条 = 3 批：
   `0 → 5 条 @8.5s → 10 条 @12.1s → 15 条 @14.5s`（旧行为是 14.5s 一次性弹出）。
   界面加了实时 chips（已判完/还剩/脚本已就绪）、**排队区**、按钮显示「剩 N 条」。
6. **A2 短代号协议**：词典真实 id 长约 200 字符（带账号作用域），原来要模型**回抄**，
   实测**一次 30 条里 29 条抄错**（抄错→名称兜底救一部分→救不回就落「待人工复核」），
   还白烧几千输出 token。现在大类 `c1/c2`、小类在各自大类内 `s1/s2`，后端按位置映射回真实 id。
   实测：prompt 词典 1,746 字符且**不含长 id**，模型 **20/20 回短代号、20/20 正确入类、0 条复核**。
7. **B2 进度落库**：新增 `topicRefreshSessionStore.js` + `/api/topic-refresh-sessions`（GET/POST/DELETE），
   存**候选 + 判完条目**，按 `{user, customer}` 唯一、**按 user 隔离**。
   实测：跑完 15 条 → 服务端改成 10 条（模拟半途离开）→ **新标签页**恢复出 10 条、
   **0 次打标签请求**、按钮显示「剩 5 条」→ 点继续**只发 1 次**请求补满 15 条。
8. **配套**：`scripts/clean-polluted-head-transcripts.mjs`（被污染的 head 缓存排查/清理，默认 dry-run）。

### C. 当前状态（数字都要能复现）

- **测试基线**：单测 **298 / 0**；冒烟 **138 / 0**；`npm run build` 成功。
  （本轮从 288→298、117→138，新增 10 条单测 + 21 条冒烟，全部有断言、无 TODO。）
- **`dist/` 已重新构建**（`index-fNYZ4-PT.js`）——前端改动只有重新构建后才会在浏览器里生效。
- **两套后端已同构改完**：`api/**`（Vercel）与 `server/index.js`（本地 Express）。
  **但 Vercel 侧没有部署验证过**，只跑过本地 Express 的冒烟与端到端。
- **真实库遗留数据**：`gold_three_second_transcripts` 里有 **21 条「长文本 head 行」**
  （判据：`scope=head` 且正文 > 120 字）。其中**今天 12:46 那 2 条**确定是修复前的串味；
  其余来自 9-17/9-18，**很可能是 2.2「开头几秒是纯音乐→回退完整转写」的正常行为**，
  两者在库里长得一模一样。⚠️ **没有执行删除**，工具默认 dry-run。
- **没有 git**：这个目录不是 git 仓库，改动无法 `git diff` 回看，只能靠本文档 + 文件名。

### D. 卡在哪 / 未决

1. **标签抖动没有量化**（当前最大的质量不确定性）。同一份输入跑两次，最终标签实测一致率不高
   （一次 A/B 只有 11/30 一致，分类分布也不同）。用户看到的可能是「同一批视频两次结果不一样」。
   **做任何「初判→复核」「重跑」「A1 规则先行」之前，先把这件事量清楚**（同批跑 3 次看稳定率）。
2. **真实规模端到端验收未做**。本轮所有端到端都是 **2 条真实视频**（真转写真打标签）
   或 **15 条桩数据**（预置转写 + 假 DeepSeek key + 代理加延迟）。**几十条真实视频、真模型
   的完整一轮没跑过**：总时长、失败率、模型 JSON 是否稳定、60 条上限下的表现都未知。
3. **用户提过「还有一个问题要解决」，但没说是哪个**（原话：「然后还有一个问题要解决。
   然后还有一个小问题…」后半段说的是打标签耗时）。**下次开工先问清这一句**，别再自己猜。
4. **A1 / A3 / B3 没做**（用户明确只选了 A2+B2）：
   - **A1 规则先行**：词典自带 `keywords`，规则匹配是毫秒级 → 能秒出「初判」，模型只复核疑难。
     这是唯一能进一步压缩「首屏第一条」的路子（当前首条仍要等一个模型调用 ≈20s）。
     代价：标签来源要如实标注（初判 vs AI 判定），且会有一次「标签被更新」的视觉变化。
   - **A3 标签缓存**：A2/B2 已覆盖大部分收益，优先级低。
   - **B3 后台跑 + 先给可用清单**：抓完先把标题/点赞/脚本列出来，用户可以先勾选先看脚本，
     标签慢慢补 —— 把「干等」变成「边用边等」。

### E. 下一步计划（建议顺序）

1. **先问用户那句没说完的「还有一个问题」**（§D.3），再决定要不要插队。
2. **量化标签抖动**：同一批 20~30 条真实视频连跑 3 次，统计一致率与落复核比例。
   这一步**便宜且决定后面所有设计**（要不要初判、要不要复核、敢不敢让用户重跑）。
3. **真实规模验收**：拿一个真实客户的库 + 一个真实对标账号，跑 20~60 条，
   记录总时长 / 首条时间 / 失败率 / 落复核比例。**这一轮才能回答「够不够快」。**
4. 再谈 A1（规则先行）/ B3（后台 + 先给可用清单）。**动手前先跟用户确认**，
   因为两者都改变标签来源或交互语义。
5. 遗留数据：确认那 21 条要不要清（`node scripts/clean-polluted-head-transcripts.mjs`，
   加 `--apply` 才真删，可用 `--video-id` 定向；删的是缓存，代价只是下次重转，
   但**已生成的 2.2 报告不会自动变，要重跑**）。

### F. 🔴 绝对不要再踩的坑

**F1. 业务 / 协议口径（改这里会静默出错，不报错的那种）**

- **`scope` 三态必须原样保留**（`head` / `tail` / `script`）。曾经写成
  `scope === TAIL ? TAIL : HEAD`，把 `script` 吞成 `head` —— **转写其实全都成功了**，
  界面上却显示「0 条」，还导致前端重跑 20 轮。已抽成 `resolveTranscriptScope` 并有单测钉着。
- **`normalizeTopicLibrary` 会把「没有小类的大类」整个丢掉**，而且**只有大类+小类都命中
  才算有效标签**。所以：① 任何给模型/前端的词典**必须带小类**；
  ② 用户说「只要看有哪几个大类」时**不能照字面实现**（会立刻 400 + 全落「待人工复核」）——
  已与用户确认过：**保留小类，只是不再整库读取**。
- **转写阶段不需要分类词典**。那条 `categories.length === 0 → 400` 的校验原来卡在两个 phase
  前面，会用一个跟转写毫无关系的理由挡掉「先提脚本、再读库」。现在已下沉到 analyze。
- **不要把「没有标题」的作品丢掉**。抖音允许无描述发布，前端 `isAnalysableRawVideo`
  明确放行；后端曾经卡 `video.title` 把它们静默丢光，只回一句没信息量的 400。
- **短代号协议是位置约定**：`c{index+1}` / `s{index+1}`（小类在**各自大类内**编号），
  发送端与解析端**各自按归一化顺序算一遍**。⚠️ 改 `normalizeTopicLibrary` 的排序/裁剪，
  等于改了协议，两边必须同时改。
- **旧格式解析要保留**（`categoryId` / `categoryName`）：模型偶尔回旧格式，能对上就对上，
  否则会把本来正确的输出打成「待人工复核」。
- **同名分类不许猜**：多个账号的分类名会重复（「不合并」的后果），按名字匹配只在**唯一命中**
  时才可用，否则一律落复核。短代号正是为了解决这个。
- **换候选必须清会话条目**，否则会出现「这批没抓过的视频却带着上一批的标签」——
  最坏的一类脏数据。
- **写操作仍然全部 manager-only**（建库/移除账号/删库），冒烟里有 3 条 403 钉着；
  **不要**因为「员工也要用」就把写权限放开。

**F2. 工程 / 验证手法（这些坑会浪费一整轮时间）**

- **`--dump-dom` + `--virtual-time-budget` 驱动不了多步网络流程**：页面一空闲虚拟时钟就快进，
  Chrome 立刻 dump，注入的脚本还没点完第二个按钮。**本会话踩了两次**。
  ✅ 正确做法：`--remote-debugging-port=<port>` + Node 全局 `WebSocket`（Node 26 自带）
  手写一个极简 CDP 客户端，用 `Runtime.evaluate` 在**真实时间**里点按钮、轮询 DOM。
- **Node 直接 spawn Chrome 的 .app 二进制会 `exit 13 / Multiple targets are not supported`**。
  ✅ 必须 `spawn(cmd, { shell: true })` 并用引号包住带空格的路径。
- **macOS 上 `--dump-dom` 打完 DOM 不会自己退出**（CVDisplayLink/crashpad 噪音）：
  要么看到 `</html>` 就收工，要么直接走 CDP。
- **CDP 里不要用 `location.reload()` / 跳转去灌 sessionStorage**：跳转会销毁执行上下文，
  后面的等待代码根本跑不到。✅ 改成**真去点 UI**（点 2.4 步骤、选客户下拉），
  或者用两个独立的 evaluate。
- **注入脚本用 `setTimeout` 轮询在虚拟时钟下会被快进**（等待窗口瞬间烧光）。
  要用 MutationObserver；不过走 CDP 就没这个问题。
- **代理里记请求路径不要截断**：我写过 `url.split("&")[0]` 做日志，结果
  `?customerId=…&view=categories` 被记成 `?customerId=…`，于是**误判「没走轻量视图」**。
  记完整 URL。
- **别用错集合名**：我查 `transcripts` 得到 0 行，差点得出「一次都没写过」的结论；
  真实集合是 **`gold_three_second_transcripts`**。**查库前先 `listCollections()` 确认名字**。
- **`dist/` 不重新构建，前端改动在浏览器里完全不生效**（本项目的验证一律跑 `dist`）。
  改完前端先 `npm run build`。
- **两套后端必须同步改**（`api/**` 与 `server/index.js`），这是本项目铁律；
  冒烟脚本验的是 Express 那套，Vercel 那套要自己核对同构。
- **同一次 `updateOne` 里 `$pull` 和 `$push` 不能作用于同一字段**（MongoDB 直接报错）；
  「读出来 → 改数组 → 整份写回」在并发批次之间会互相覆盖（两边都返回成功）。
  ✅ 用聚合管道 `$concatArrays` + `$filter` 做单次原子更新（`topicLibraryStore` 与
  `topicRefreshSessionStore` 都是这个写法）。
- **函数体里 `const` 声明在 JSX 使用之后 → TDZ 整页白屏**（不是 undefined，是崩）。
  本会话在按钮文案上踩过一次（`untaggedCount`）。派生值统一放在使用它的 JSX **之前**。

**F3. 诊断时的误判（会让你朝错方向查半天）**

- **接口返回 200 ≠ 转写成功**：`phase=transcribe` 即使每条都失败也返回 200，
  `progress.ok=0`。用户说「报 400 / 全失败」时，**先看 `progress.batch` 里的逐条 status**，
  不要只盯 HTTP 码。本轮已把失败原因（`error`）加进 batch，就是为了这个。
- **`DOUBAO_APP_KEY` / `DOUBAO_ACCESS_KEY` 为空 ≠ ASR 没配**：
  `buildDoubaoAsrHeaders` 只要 `DOUBAO_API_KEY` 有值就够。我据此误判过一次「根因是凭证缺失」。
  **下结论前先读那段代码。**
- **`head` 里的长文本不等于脏数据**：2.2 的「开头几秒是纯音乐 → 回退完整转写」是**设计内行为**，
  和修复前的串味在库里长得一样。清理工具默认 dry-run 就是为此。
- **用户的「实测结论」要复现再采信**：用户说「打标签很久」，实测发现**模型调用有 ~20s 固定开销**
  （8 条 21.6s / 30 条 22.8s），于是「把批切小并行发」并不能提速 —— 只能改善体感。
  不量就动手，会做错方向。

**F4. 被实测否掉的方案（别再试一遍）**

- **关掉模型思考**（`thinking:{type:"disabled"}` / `reasoning_effort:"none"`）：
  微请求确实 5.5s→1.2s，但**真实 30 条任务只有 1.1~1.6×**（不稳定），
  而且**标签变了**（两次判定只一致 11/30，分布也不同；另一轮「带思考」时 29/30 id 抄错）。
  **结论：没有开，也不要开。**
- **把批切小 + 并行发来提速**：总时长不变（固定开销按批付），只改善「多快看到第一条」。
- **照搬二创的 provider 顺序到完整脚本**：`tikhub-music` 取的是**背景音乐轨**，
  对「完整口播脚本」有取错内容的风险。实测现有链路（`ffmpeg + 豆包 ASR`）在真实视频上
  6.5s 出 454 字正确口播，**没有问题，别乱改**。

### G. 怎么验证（命令 + 期望数字）

```bash
cd /Users/ypc/Desktop/归档项目/xiaomang
npm test                                    # 期望：tests 298 / pass 298 / fail 0
node scripts/verify-server-routes.mjs       # 期望：138 passed / 0 failed（需要 MongoDB + .env）
npm run build                               # 期望：built in ~1s，dist/assets/index-*.js 更新
node scripts/clean-polluted-head-transcripts.mjs   # 只报告不删；--apply 才真删
```

- 冒烟脚本会**自己起一个临时库 + 随机端口的 server**，跑完 `dropDatabase()`，
  **不碰真实数据**；DeepSeek 用假 key（走规则兜底），**不花模型钱**。
- 端到端如果要用真浏览器：**必须走 CDP**（见 F2 第一条），并且**抓账号那一步用代理桩掉**、
  **预置转写**、**DeepSeek 假 key** —— 这样一轮验证零成本。要验真实 provider 时才放开。

### H. 关键文件地图（本会话碰过的）

| 文件 | 作用 |
|---|---|
| `src/app/TopicLibraryStage.tsx` | 2.4 的全部界面：经理建库视图 + 员工只读视图（渐进流水线、续跑、排队区都在这） |
| `src/app/topicLibrary.ts` | 该页面的客户端接口与类型（含轻量词典、进度会话） |
| `api/_lib/goldThreeSecondTranscripts.js` | 转写编排；**`resolveTranscriptScope` 是 scope 事故的修复点** |
| `api/_lib/benchmarkTopicRefresh.js` | 打标签的归一化 / 短代号协议 / 兜底 / 丢光时的报错 |
| `api/_lib/topicRefreshSessionStore.js` | 🆕 处理进度（候选 + 判完条目，按 user 隔离，原子追加） |
| `api/_lib/topicLibraryStore.js` | 选题库存储；轻量词典（`?view=categories`）走这里的投影 |
| `api/_lib/contentAgent/prompts.js` | `BENCHMARK_TOPIC_REFRESH_PROMPT`：**已改成回短代号** |
| `api/agent/benchmark-topic-refresh.ts` | 转写 / 打标签两个 phase（Vercel） |
| `api/topic-libraries/index.ts`、`api/topic-refresh-sessions/index.ts` | 选题库与进度端点（Vercel） |
| `server/index.js` | 上面这些的 Express 同构版（本地开发真正跑的那套，8787） |
| `scripts/verify-server-routes.mjs` | 冒烟：138 条断言，**改后端之后必跑** |
| `scripts/clean-polluted-head-transcripts.mjs` | 🆕 head 缓存排查/清理 |
| `tests/topic-library.test.mjs`、`tests/gold-three-seconds-transcript.test.mjs` | 本轮新增的单测都在这里 |

**本地开发怎么起**：`npm run dev:full`（Express 8787 + Vite 5173，Vite 把 `/api` 代理到 8787）。
`.env` 里 `MONGODB_DB_NAME` 为空 → 用 URI 里的默认库（实测是 `test`）。

---

## 0. 三十秒速览

| | |
|---|---|
| **🔴 工作目录** | **`/Users/ypc/Desktop/归档项目/xiaomang`（合并后）**；本目录 `xiaomang2` 是旧副本。详见 §0.6 |
| **在做什么** | 接通 **2.1～2.3 → 正式选题库 → 新视频筛选打标签 → 员工二创（含按大类配比的 10 条候选）→ 发布仓（封面/发布文案/发布标签 + 核查导出）→ 最终文案编辑页** ✅ 已实现；口径见 §0.1，第五轮见 §0.0，第六轮见 §0.2，**第七轮「发布仓」见 §0.3** |
| **板块结构** | **三个模块、两层**：模块 3「选题库构建」（2.1/2.2/2.3/**2.4** 是它的子步骤）是底座；模块 1「对标账号分析」(1.2)、模块 2「账号规划」(1.3) **复用模块 3 的产出**（其中 1.3 是**经 1.2 间接**复用，见 §1.2 结论 2） |
| **整体进度** | 2.1/2.2/2.3、1.2、1.3、员工临时分析入口**均已完成**；选题库 + 新视频筛选打标签（§0.1）、打标签体验改造（§0.0）、大类配比回流二创（§0.2）、**发布仓（§0.3）** 均已完成 |
| **员工端页面链** | `/topics`（今日选题）→ `/content`（内容生成）→ **`/publish-warehouse`（发布仓）** → `/final-editor`（最终文案编辑页） |
| **当前卡在哪** | ①**真实端到端验收没做**（含本轮的出图与三个新 Agent，全是桩）②**标题类型配比不存在**（§0.2-B）③**标签抖动未量化**④用户还有一句「**还有一个问题要解决**」没说完。详见 §0.3-G |
| **下一步** | 先问清 §0.0-D.3 那句话 → 配 `XXCAPI_API_KEY` 跑真实出图与三个新 Agent 的验收 → 量化标签抖动。**不要再重新实现选题库、配比链路或发布仓** |
| **测试基线** | **本轮最终实测** `npm test` → **365 / 365 pass / 0 fail / 0 skipped**；`node scripts/verify-server-routes.mjs` → **194 / 0**；`npm run build` → 成功；CDP 渲染验证 → **35 / 0**。（更早：347 / 343 / 311 / 298 / 288 / 256；冒烟 150 / 138 / 117 / 52） |
| **2.2 转写性能** | ✅ 已优化并**由用户实测通过**（2026-09-17）：单条 8632→1667ms、整批 3318→1509ms。详见 §4.4 |
| **最需要注意** | ①两套后端必须同步改（**优先改 `api/_lib` 共享层，两套自动生效**）②Agent 输出必须后端归一化 ③前端改动必须真的渲染看一眼 ④**别再把三个模块当成一条平级阶段直线**（见 §1.2）⑤**转写链路的 provider 顺序是刻意的**，别改回 TikHub 优先（见 §3.3(a)）⑥**开头/结尾/完整脚本靠 `scope` 分开存**，head / tail / script **三态都要原样保留**（§0.0-F1、§6.6㉚）⑦**1.2 的输出必须做证据分级**，不许编造用户画像与定价（见 §3.5）⑧**codegraph MCP 默认绑错库**，必须显式传 `projectPath`（见 §6.7㉛）⑨🔴**本文档反复滞后于代码** —— 接手时请拿代码核对本文档 ⑩**本项目有四种隔离口径，别混用**：报告类按 `managerId`、`customers` **完全不隔离**（公司共用名册）、「临时分析」按 `userId` 员工私有（§3.7）、「打标签处理进度」也按 `userId` 私有（§0.0-B7）⑪**前端/端到端验证一律走 CDP，别用 `--dump-dom --virtual-time-budget`**（§0.0-F2，已踩两次）⑫🔴**配比换算（10 条怎么分）必须后端实算，绝不交给模型**；`apportionRatios` 的入参字段名是 `ratio`、输出是百分比不是条数（§0.2-G1）⑬**「待人工复核」永远不进配比**（§0.2-G2）⑭`ContentPage.tsx` 的 hooks 解析**有两份**，改一处等于没改（§0.2-G4）⑮**1.3 账号规划对员工开放的是「按客户读」**，按 id 读与全部读写仍是 manager-only；别把它做成「全开放」（§0.4-B）⑯**1.3 报告的 `sections` 只是键名数组**，正文在顶层各节 —— 照 `sections.xxx` 取会永远取到空且不报错（§0.4-C） |

---

### 0.1 本轮交接：正式选题库与新更新视频筛选 ✅ 已实现（2026-09-21）

#### 🔴 上一轮文档在这里是错的 —— 先看这一条

**2026-09-20 的文档写「正式选题库持久化与新视频标签流程尚未实现」，但当时后端其实已经写完了。**
本轮核对代码发现：

- `api/_lib/benchmarkTopicRefresh.js`（归一化 / 标签 / 兜底）✅ 早已存在
- `api/agent/benchmark-topic-refresh.ts` + `server/index.js` + `vercel.json` ✅ 早已三处同步
- `BENCHMARK_TOPIC_REFRESH_PROMPT` 与 `runBenchmarkTopicRefreshAgent` ✅ 早已存在
- `transcriptStore` 的 `TRANSCRIPT_SCOPE_SCRIPT = "script"` ✅ 早已存在（完整脚本独立 scope）

**当时真正缺的只有两件**：① 正式选题库的**持久化与绑定**；② 前端**没有任何入口**（UI 无门，
只能用 API 直接调）。所以本轮不是从零实现，而是**补这两件 + 修一个口径 bug**。
**教训（这是第三次了）：拿代码核对本文档，不要只信文档。**

#### 本轮已确认的业务口径（用户 2026-09-21 拍板，不用再问）

| 项 | 结论 |
|---|---|
| **库归属** | **客户级**：一个客户一份库，可纳入多个对标账号的分析结果 |
| **多账号分类** | **各自独立保留，不合并**。只靠大类同名就自动合并是被禁止的（§6.1③） |
| **保存触发** | **分析完成 → 人工点「保存入库」**，不自动保存 |
| **勾选语义** | 新视频列表的勾选**只留在前端，不入库** —— 不把「勾选」自动解释成「写入正式库」 |
| **库来源** | **2.1 分类分析报告**，不是 1.3 的客户报告 |
| **点赞门槛** | **严格 `likes > 100`**（100 不达标）；点赞缺失归一化成 0，不算达标 |
| **时间窗口** | 默认近 7 天，可选 15/30/90 天；复用 `src/app/topicTimeWindow.ts` |

#### 本轮实现了什么

1. **`api/_lib/topicLibraryStore.js`（新）** —— 集合 `topic_libraries`，按
   `{ managerId, customerId }` 唯一。一个客户一份库，`accounts[]` 里每个对标账号一棵
   **独立分类树**（含 `coreFunction` / `keywords` / `count` / `percentage` + 小类）。
   - **分类 id 带账号作用域**（`scopedCategoryId` = `账号key::分类id`）：两个账号有同名大类时
     id 不会相撞 —— 这是「不合并」在数据层的落地方式。
   - `buildTagDictionary()` 跨账号展平成标签词典；多账号时 `label` 带账号名前缀。
   - 幂等：同一份报告重复纳入按 `accountKey` 覆盖，不会出现两份。
   - 支持移除单个账号；移掉最后一个账号时**连空壳库一起删**（否则「已建库」会撒谎）。
2. **选题库端点（新）** —— `api/topic-libraries/index.ts` + `server/index.js` + `vercel.json`
   三处同步。契约与其它 5 个 store 一致：**列表只给元数据**（`accounts` 正文排除），
   正文按 `customerId` 单取；读写一律按 `managerId` 收口。
   - `GET /api/topic-libraries`（列表）/ `?customerId=`（完整库 + `tagDictionary`）
   - `POST /api/topic-libraries`（建库 / 追加账号）
   - `POST /api/topic-libraries?action=remove-account`
   - `DELETE /api/topic-libraries?customerId=`
   - 客户名册是公司共用的，端点只**校验客户真实存在**，不按 managerId 过滤（§2.3）。
3. **`src/app/topicLibrary.ts`（新）** —— 客户端类型 + 接口，沿用 `reportApi.ts` 的约定
   （不自动重试、列表只取元数据）。
4. **`src/app/TopicLibraryStage.tsx`（新）** —— 2.4 的前端步骤，两块：
   - **正式选题库**：选客户 → 选 2.1 分类报告 → 保存入库；展示库内各账号独立分类树；
     可移除单个账号、删除整个库。
   - **新更新视频筛选与标签**：链接 + 时间范围 → 抓取 → **严格 `> 100`** 过滤 →
     分批提取完整脚本 → 按库内大类/小类打标签 → **可勾选列表**（标题 / 时间 / 互动数据 /
     两个标签 / 来源徽章 / 置信度 / 可展开脚本）。
   - 界面明说「勾选不会自动写入正式选题库」，并显示 `likes > 100` 的口径。
   - 「待人工复核」条目单独用琥珀色标出；Agent `warnings` 显示**真实错误码与消息**
     （照 §4.3 第 1 条 1.2 的做法，2.4 不再写硬编码那句话）。
5. **`src/app/accountPositioningModules.ts`** —— 新增 `library` 步骤（**2.4**），在模块 3 的
   步骤轨道里**整行渲染**（`sm:col-span-3`，见 §1.2 界面形态）。同时**修掉了 §4.3 第 6 条的
   `1.3 reuses` 错误文案**。
6. **🐛 修掉一个真实口径 bug**：`normalizeTopicRefreshVideos` 原来用 `likes >= minLikes`，
   于是**刚好 100 赞的视频会被放进来**，与用户口径 `> 100` 相反。已改成 `>`，
   并写了回归测试钉住（`tests/topic-library.test.mjs`）。
   **这是单元测试抓到的，不是看出来的。**

#### 本轮验证（都是真跑的，不是历史基线）

```text
npm test                              → 288 passed / 0 failed（新增 21 条选题库契约测试）
node scripts/verify-server-routes.mjs → 117 passed / 0 failed（新增 40 条选题库路由断言 + 16 条员工权限/绑定断言）
npm run build                          → 成功（新 Stage 已进产物）
前端渲染                               → 无头 Chrome 截图 + DOM 断言，页面无 console 报错
临时库覆盖语义验证                      →  12 passed / 0 failed（用完 dropDatabase）
```

- 新增 `tests/topic-library.test.mjs`：分类 id 作用域、判断依据落库、`>100`/`=100`/缺失点赞
  边界、只认库内分类、脚本来源、兜底不发明标签。
- 路由冒烟新增：建库 upsert、重复纳入幂等、多账号不合并、跨客户隔离、移除单个账号、
  员工访问 403、客户不存在 404、非分类报告 400、列表不带 `accounts` 正文。
- 渲染验证用临时脚手架（只替换 `window.fetch`）驱动真实交互走完
  「抓取 → 提取脚本 → 打标签 → 展开脚本」，确认 8 条抓取里**只有 6 条达标**
  （100 赞的边界样本与点赞缺失的样本都被正确筛掉）。**脚手架用完已删干净。**

#### 🔎 实现后做了一轮 code review，修掉 8 个真实缺陷（**别再改回去**）

写完之后又用两个独立视角做了对抗式复审，抓到下面这些问题。每一条都配了回归测试，
所以**改坏了会立刻变红**：

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| 1 | 点赞门槛是可传参数，`normalizeTopicRefreshVideos` 默认 **0** | 调用方传 `minLikes:0` 就能把 1 个赞的视频放进打标签流程，**「>100」这条业务规则静默失效** | 新增 `TOPIC_REFRESH_MIN_LIKES = 100` + `resolveMinLikes()` 做成**下界**（不是默认值），三处统一夹紧 |
| 2 | 分类匹配 `id === text \|\| name === text` | 多账号有同名大类时，模型回裸名字会**静默绑到第一个账号**（打错账号还不报错） | 只认 id（id 带账号作用域、全局唯一）；名称仅在**全局唯一**时才接受，同名歧义落「待人工复核」。兜底路径同样处理 |
| 3 | 没有转写时仍沿用模型自称的 `confidence: high` | 界面同时显示「发布文案推断」和「置信度 high」，自相矛盾 | `scriptSource === "caption"` 时置信度强制压到 `low`（提示词写了这条，但提示词管不住模型） |
| 4 | 账号 key 兜底写成 `account-${index+1}-${name}`，而调用方传 `accounts.length` | 无 id、无链接的报告重复入库时 key 变化 → **去重落空、同一账号存两份** | key **只由报告内容决定**，与在库里的位置无关 |
| 5 | 「移除账号」无论 key 匹不匹配都回 `removedAccount: true` | 两个端点那个 404 分支成了**死代码**；用过期的 key 点「移除」会**假成功**，账号还在、`updatedAt` 还被刷了一次 | 用 `$pull` 原子改数组，按真实 `modifiedCount` 如实回报；没删到东西就不碰 `updatedAt` |
| 6 | 保存是「读数组 → 改 → 整份写回」 | **并发保存会丢掉先写进去的账号**，而两个请求都返回 201 | 改成单次原子更新：`$pull` 摘旧 + `$concatArrays` 接新（`$pull`/`$push` 不能同字段同时用，所以走聚合管道） |
| 7 | 用正则 `/invalid\|customerId/` 猜 HTTP 状态码 | `Invalid customer id`（首字母大写+空格）**匹配不上** → 本该 400 却返回 500；而 E11000 报错文本含 `customerId` → 真故障被误判成 400 | 存储层抛错时带 `error.status`，两个后端统一按 `error?.status \|\| 500` 取码（全项目惯例） |
| 8 | `platformFromUrl` 用未锚定的 `/tiktok\.com/i` | `douyin.com/user/x?from=tiktok.com` 会被判成 tiktok，抓取请求带**错误平台**打给 TikHub | 用 `new URL().hostname` 锚定 host 再判断 |

顺带修的：`customerId` 未规范化（传大写 hex 会建出一份客户端查不到的库，
再传小写又建第二份 → 「一客户一库」破功，改为存 `customer.id`）、列表 `accountCount`
按**名字**去重（同名账号会少数，改为按 `accountKey` 计数）、占比被 `Math.round` 成整数
（丢掉用户明确要求的一位小数）、`selectedVideoIds` 结构上恒空（已删）。

**已知但不打算修的**（记在这里免得下次当成新 bug 重查）：

- **库文档没有总量上限**：`20 账号 × 40 大类 × 80 小类`的理论体积可能越过 BSON 16MB，
  届时该库只能删掉重建。真实报告约 50~150KB/账号，UI 路径到不了；直接打 API 才可能。
- **列表是 1+N 次查询**（每个库额外 `distinct` 两次取账号名）。库数量少时无感，
  真到几百个客户再改成一次聚合。
- **`150 字前缀相同的两个超长分类 id` 会在 `cleanText(id,160)` 处截断而相撞**的概率问题，
  真实分类 id 远短于 160。


#### 员工端入口与「绑定客户」（2026-09-21 追加，用户拍板）

**背景**：用户手动测试时发现，从「临时任务」进去看到的是 `/topics`（今日选题）——
那个页面**本来就没有点赞门槛、也没有分类标签**（它只是按点赞**排序**），
而 2.4 当时挂在经理端的 `/manager/account-positioning`，**员工根本进不去**。
根因是**临时分析完全不绑客户**（真实记录里连 `customerName` 都没有），
而选题库是客户级的 —— 没有客户就没有词典，打不出标签。

**按用户选择实现（方案 B）**：

1. **选题库对员工开放「只读」**（`listTopicLibrariesForEmployee` /
   `getTopicLibraryForEmployee`）。这是**故意收窄**的视图：
   - **不回 `managerId`**（员工不需要知道库的属主）
   - **不回客户 IP 档案 / 访谈原文**（`customers.ipProfile` 与打标签无关）
   - **只列真的有内容的库**（`accounts.0` 存在），免得员工选到空库满屏「待人工复核」
   - **写操作（建库 / 移除账号 / 删库）仍然全部 manager-only**，冒烟里 3 条 403 断言钉着
2. **临时任务支持「绑定客户」**：表单新增客户下拉（**只列已有选题库的客户**），
   落库 `{ customerId, customerName }`。`customerName` **由后端从库里取**，
   不接受前端传值（否则可伪造成任意客户名）。绑一个没库的客户直接 400。
   旧记录没有这两个字段 → 归一化成空串，UI 显示「未绑定客户」，**不破坏老数据**。
3. **员工跑新流程的入口**：临时分析列表里，绑了客户的那条多一个「**筛选新视频**」按钮 →
   `/topics?view=newVideos&customerId=<id>`。分支放在 `src/main.tsx` 的 `TopicsRoute`
   （**不是**塞进 `App` 里提前 return —— `App` 有几十个 hook，
   条件式提前 return 会让 hook 顺序随 query 变化）。
4. **`TopicLibraryStage` 支持 `readOnly` + `lockedCustomerId`**：复用同一个组件
   （不复制一套），只读模式藏掉建库/改库入口，客户由 URL 锁定。
   ⚠️ `lockedCustomerId` 必须**覆盖草稿里的旧值**，不能只当初始值 ——
   草稿（sessionStorage）里可能有上次看过的别的客户，只当初始值会让员工读到**别人的库**。

**验证**：单测 278 / 冒烟 108（新增 16 条：员工可读、收窄字段、写操作 403、
绑定空客户 400、绑定成功带 customerId/customerName、不绑仍可建）；
**无头 Chrome 渲染了两遍** —— 员工只读视图（`hasManagerOnlyText: false`，确认
「保存入库/删除这个库/移除」都没泄漏出去）与经理视图（`保存入库` 在、3 个下拉在），
两遍都无 console 报错。脚手架用完已删。

**🐛 顺带修掉一个「看着已选好、按钮却是灰的」缺陷**：直接进 2.4（**没走**
2.1 → 2.4 的交接，即 `preselectedReport` 为空）时，报告下拉由浏览器自动选中第一项，
但 `selectedReportId` 状态仍是空的 —— 于是下拉**显示**着报告、「保存入库」却**禁用**。
已补一个 effect：没选过就默认第一份。**客户仍需人工选**（下拉首项是「请选择客户…」占位），
选完客户按钮才可用 —— 这是刻意保留的显式确认，不是 bug。
（这条是用无头 Chrome 读 DOM 状态复现的，肉眼只看到「按钮是灰的」，猜不出原因。）

**🐛 员工只读视图顶层挂着一条红色报错（2026-09-21 第三轮修复）**：`TopicLibraryStage`
里那对「载入客户名册 + 已保存分类报告」的 `listCustomers` / `listBenchmarkReports`
**没有 `readOnly` 守卫**，员工一进 `/topics?view=newVideos` 就白发两个必然 403 的请求，
`Promise.all` 一抛错就写进 `libraryError`，于是页面**第一个元素**是红色错误条
`该功能仅供项目经理使用` —— 员工看到一句与自己无关的报错，会以为功能坏了。
（上一条「验证」里写的 `hasManagerOnlyText: false` **当时是误判**：那次只搜了
「保存入库/删除这个库/移除」三个按钮文案，没搜 403 的报错文案，所以漏掉了。
⚠️ 教训：验「没泄漏」不能只搜正例文案，**要连错误态一起搜**。）
修法是一行 `if (readOnly) return;` —— 这两份列表只有经理端的两个下拉用得到。

**验证**：冒烟 **121**（新增 4 条：★员工读 `/api/customers` → 403、★员工读
`/api/benchmark-reports` → 403、项目经理这两条仍 → 200 ×2）/ 单测 **288**；
**无头 Chrome 实测了两个视图，并在反向代理里记录每个 `/api` 请求路径**：
- 员工只读视图 —— 红色错误条消失，实际只打了 `/api/auth/me` 与
  `/api/topic-libraries?customerId=…`，**`/api/customers` 与 `/api/benchmark-reports`
  一个都没打**；「抓取新更新视频 / 按库内分类打标签 / 词典来源提示」照旧齐全，
  建库改库入口仍然没泄漏；
- 经理 2.4（预选客户+落在 2.4 步骤）—— 那两个接口**照旧都打**，客户下拉与报告下拉
  都有内容，「保存入库 / 删除这个库 / 移除」都在，视频筛选面板仍不渲染。
脚手架用完已删（结论：只修了这一个守卫，别处不用动）。

#### 🔴 转写链路两个真 bug + 员工端顺序调整（2026-09-21 第四轮，用户实测驱动）

用户实测反馈两件事：① 顺序不对（应该「先抓视频 → 再提脚本 → 最后才读库」，而且库不用整份读）；
② 「提取完整脚本」全失败。查下来是两个**独立**的缺陷，外加一个顺序问题。

**🐛 bug 1（根因）：`scope: "script"` 被静默收敛成 `"head"`** ——
`goldThreeSecondTranscripts.js:transcribeTargets` 里写的是
`scope === TAIL ? TAIL : HEAD`，这个函数原本只为 head/tail 而写，2.4 传进来的
`script` 直接掉进 else 分支。连锁反应非常隐蔽：
- 完整脚本被写进**开场片段**的缓存槽（2.2 会拿整篇口播当「开场三秒」）；
- `getTranscriptProgress({ scope: "script" })` **永远查不到**这批结果 → 后端每轮都答
  「还没转写完」→ 前端以为一条都没成功，**反复重跑 20 轮**（每轮重新下载 + ASR），
  「等待时间特别长」+ 重复烧钱，最后报「脚本提取没有在预期轮数内完成」；
- 症状极具迷惑性：**转写其实全都成功了**（`batch` 里每条都是 `status: ok`），
  用户看到的却是「已提取 0 条完整脚本」。
修法：抽出纯函数 `resolveTranscriptScope`（trim + 小写，与 `transcriptStore.normalizeScope`
同一口径），三态原样保留，**抽出来就是为了能单测**。**实测对比**：修复前同一请求
`ok: 0, attempted: 0, finished: false`，库里的行是 `scope: head`；修复后
`ok: 1, attempted: 1, finished: true`，行是 `scope: script`（耗时 15.3s → 一轮收敛）。

**🐛 bug 2：`normalizeTopicRefreshVideos` 卡 `title`，把「无描述发布」的作品丢光** ——
前端 `isAnalysableRawVideo` 明确允许无描述作品（注释写着「『有文案』不是必要条件」），
后端却要求 `video.title` 非空才保留，两边契约相反。候选被丢光时只回一句
「没有满足筛选条件的可分析视频」，看不出任何线索。修法：不再要求标题（标题只是打标签的
上下文，界面早有「（无标题）」兜底），并把错误信息改成**逐项计数**
（`describeTopicRefreshVideoDrop`：缺链接 N 条 / 点赞未超过 100 的 M 条）。

**顺序与轻量读库（用户拍板）**：员工端改成**抓视频 → 提脚本 → 读库 → 打标签**。
- 抓视频、提脚本**不再要求选题库存在**（原来 `hasLibrary` 卡着，没库连抓都点不动）；
- 新增轻量视图 `GET /api/topic-libraries?customerId=…&view=categories`
  （`getTopicCategoryDictionary{,ForEmployee}`）：用**嵌套字段投影**只取分类树那一支，
  2.1/2.2/2.3 三份报告正文（单份约 148 KB）**不出库**；
- 员工端**挂载时不再读库**，只在点「打标签」时按需读一次轻量词典；
- ⚠️ 轻量词典**必须带小类**：`normalizeTopicLibrary` 会把没有小类的大类整个丢掉，
  且只有大类+小类都命中才算有效标签 —— 只回大类等于让所有条目落「待人工复核」。
  （用户原话是「只要看有哪几个大类」，按此实现会直接触发 400「没有可用的选题库分类」，
  已与用户确认：**保留小类，只是不再整库读取**。）
- 转写阶段**不再校验 `categories`**（它只用得到视频链接）—— 原来那条校验卡在两个 phase 前面，
  「先提脚本、再读库」会被一句与转写无关的 400 挡掉。

**验证**：单测 **293**（新增 5 条：scope 三态不被收敛、非法值才回退 head、
无描述作品仍可分析、缺链接仍要丢、丢光时的报错逐项计数）/ 冒烟 **129**
（新增 8 条：轻量视图 200 + 带 tagDictionary + **不含 accounts** + 体积明显更小 +
**每个大类都带小类**，员工与经理两侧都验）。
**端到端用 CDP 驱动真浏览器**（⚠️ 不能用 `--dump-dom --virtual-time-budget`：虚拟时钟会把
定时器快进、立刻 dump，多步网络流程根本走不完 —— 这个坑踩了两次），自动点完三步，
代理记录**真实请求顺序**：
`auth/me → tikhub/batch → benchmark-topic-refresh(转写) → topic-libraries?view=categories → benchmark-topic-refresh(打标签)`，
即「**提脚本之后才读库**」，且全程**没有读完整库正文**、没有碰任何经理专属接口，
2 条视频转写全部 `scope=script / status=ok`；经理 2.4 侧同时回归验证
（保存入库/删除这个库/移除都在、客户下拉有内容、照旧读完整库正文）—— 共 **21 条断言全绿**。
（抓账号那一步在代理里用固定样本桩掉以免付费；转写走真实 provider。）

#### 打标签：渐进显示 + 短代号协议 + 进度落库（2026-09-21 第五轮，用户拍板 A2+B2）

用户三个诉求：① 别等所有脚本转完才出标签，**一个选题判完就先显示**；② 打标签很久、期间用户
干等 —— 要么提速、要么换交互。先量了一遍时间花在哪：

| 环节 | 实测 |
|---|---|
| 转写完整脚本 | ~10–15s/条（并发 3） |
| 打标签（模型） | **8 条 21.6s / 30 条 22.8s** —— 有 **~20s 固定开销，与条数几乎无关** |

固定开销这一条直接否掉了「把批切小并行发」的提速思路（每批都要各付一次 20s），
**批大小只影响「多快看到第一条」，不影响总时长**。

🔴 **一条被实测否掉的思路（记下来免得再试）**：关掉模型思考
（`thinking:{type:"disabled"}` / `reasoning_effort:"none"`）。微请求确实 5.5s→1.2s，
但**真实 30 条任务只有 1.1~1.6×**（不稳定），而且**标签变了**：两次判定最终只一致 11/30，
分布也不同；另一轮还出现「带思考时 30 条里 29 条 id 抄错」。所以**没有开**。

**① 渐进显示（已做）**：`handleAnalyze` 从「全部转写完 → 一次判完 → 一次性出结果」改成
**小批流水线**（`TAG_BATCH_SIZE = 5`）：每批先转写 → 转完**立刻发这一批的打标签请求
（不 await，与下一批的转写并行）** → 哪批回来贴哪批。界面加了三样东西：
顶部实时 chips（`N 条已判完 / 还剩 M 条在处理 / 脚本已就绪 K 条`）、**排队区**
（列出还没轮到的选题，等待期间屏幕上一直有东西在动）、主按钮显示「还剩 N 条」。
**不需要新后端接口**：`phase=analyze` 本来就只处理传进来的视频，传一小批就等于只判这一小批。
实测 15 条 = 3 批：`0 → 5 条 @8.5s → 10 条 @12.1s → 15 条 @14.5s`（旧行为是 14.5s 一次性弹出）。

**② A2 短代号协议（已做）**：词典里的真实 id 带账号作用域，**长约 200 字符**
（`url-https://www.douyin.com/user/MS4wLjABAAAA…::cat-1`）。提示词原来要模型**回抄这个 id**，
既贵又不可靠 —— 实测一次 30 条里 **29 条 id 抄错**（抄错的会被名称兜底救回一部分，
救不回就静默落「待人工复核」），而且每条输出都要写这串，白烧几千个输出 token。
现在：大类给 `c1/c2/…`、小类在**各自大类内**给 `s1/s2/…`，模型只回短代号，后端按位置映射回真实 id。
- 代号按**归一化顺序**生成，发送端（`buildBenchmarkTopicRefreshInput`）与解析端
  （`resolveTagging`）各自算一遍就能对上，**不需要传映射表**；
- 旧的 `categoryId` / `categoryName` 解析**保留作兜底**（模型偶尔回旧格式，能对上就对上）；
- 同名歧义照旧**不猜**（用户名匹配只在唯一命中时才用）—— 而短代号天然区分同名分类，
  这正是它比「按名字匹配」强的地方。
**实测**：prompt 词典从「一堆 200 字符 id」变成 1,746 字符且**不含任何长 id**；
模型 **20/20 全回短代号**，端到端 **20/20 正确入类、0 条落复核**。

**③ B2 进度落库（已做）**：打标签要几十秒到几分钟，而在此之前**所有中间结果只活在前端内存里**
—— 刷新/切页/手滑返回就把这段时间和花的钱全丢了，用户不敢走开，只能干等。
新增 `api/_lib/topicRefreshSessionStore.js` + `/api/topic-refresh-sessions`（GET/POST/DELETE）：
- 按 `{managerId, customerId}` 唯一，**按 user 隔离**（员工 A 的进度员工 B 看不到）；
- 存**候选列表**（没有它光有标签也没用）+ **判完的条目**（含脚本/大类/小类/置信度/依据，
  形状与前端 `TopicRefreshItem` 一致，恢复后界面直接渲染）；
- 抓完新视频 → POST 候选项，**同时清空旧条目**（否则会出现「这批没抓过的视频却带着上一批的标签」）；
- 打标签**每批判完由后端自动 `appendTopicRefreshItems`** —— 用聚合管道做「按 videoId 去重后追加」
  的**单次原子更新**（`$pull` 与 `$push` 不能同时作用于同一字段；「读出来改数组再写回」会在
  并发批次间互相覆盖，这个坑在 topicLibraryStore 里踩过）；
- 前端挂载时读回进度：有就恢复候选+条目并显示「已恢复上次的处理进度」+「重新开始」；
  主按钮变成「剩 N 条」—— **续跑只处理没判过的**，已经花过钱的不再重跑。
- 落进度失败**不影响出结果**：只记日志，报告照常返回。

**验证**：单测 **298**（新增 5 条：词典只给短代号不含长 id / 短代号精确映射且小类在所属大类内解析 /
越权代号与自造代号落复核 / 旧格式 id、名称仍认 / **多账号同名分类时短代号能落到对的账号**
（同一份断言里对照「按名字必须歧义落复核」））/ 冒烟 **138**（新增 9 条：保存进度、读回候选、
**打完标签条目自动落进进度**、**员工 B 看不到员工 A 的进度**、清进度后读不到）。
**CDP 端到端**（真浏览器、真点击）：
- 渐进显示：15 条分 3 批滚动出现（时间线见上）；
- 短代号：真实模型 20/20 回代号、20/20 入类；
- **续跑**：跑完 15 条 → 服务端把进度改成 10 条（模拟半途离开）→ **新标签页**恢复出 10 条、
  **0 次打标签请求**、按钮显示「剩 5 条」→ 点继续**只发 1 次**打标签请求就补满 15 条
  → 「重新开始」清空会话。共 **14 条断言全绿**。
脚手架用完已删（预置转写跳过付费 ASR、DeepSeek 假 key 走规则兜底、代理给模型调用加延迟
—— 所以这一轮验证**没有产生额外费用**）。

**仍开放（用户已知晓、未选）**：`A1 规则先行`（词典自带 keywords，秒出「初判」再让模型复核，
是唯一能进一步压缩「首屏第一条」的路子，代价是标签来源要标注且会更新一次）、
`A3 标签缓存`（A2/B2 已经覆盖了大部分收益）、`B3 后台跑 + 先给可用清单`。
另：模型两次判定的**标签抖动**（同输入一致率实测不高）是当前最大的质量不确定性，
如果要做「初判→复核」或重跑，先把这件事量化清楚。

**遗留数据**：修复前写坏的 `head` 行还在库里（21 条长文本）。⚠️ 它们**不能一概当成脏数据**：
`head` 里出现长文本有**两种**来源 —— ① 修复前 2.4 的串味（今天 12:46 那 2 条就是）；
② **设计内的回退**：2.2 取的开头几秒是纯音乐/静音时，转写返回空，代码会回退成完整转写
并存回 head（这类是正常的）。两者在库里长得一模一样。排查/清理工具：
`node scripts/clean-polluted-head-transcripts.mjs`（默认只报告，`--apply` 才删，
可 `--video-id` 定向；删的是缓存，代价只是下次重转）。**已生成的 2.2 报告不会自动变，要重跑。**

**⚠️ 使用顺序（否则会以为功能坏了）**：员工要打标签，**项目经理必须先在
`/manager/account-positioning` 的 2.4 里给该客户建库**（人工点「保存入库」）。
截至 2026-09-21 真实库里 `topic_libraries` 是 **0 条**，所以绑定客户的下拉是空的 ——
这是预期状态，不是 bug。

#### 库纳入「三份分析」+ 视频筛选只留员工端（2026-09-21 第二轮，用户拍板）

**用户要求**：① 正式选题库不只要纳入 2.1 分类报告，**也要纳入 2.2 黄金三秒与 2.3 结尾钩子**；
② **删掉项目经理端的「新更新视频筛选与标签」**，这个功能**只留在员工端**。

**① 三份分析进库**

库条目形状从「一棵分类树」扩成 `analyses: { classification, goldThreeSeconds, endingHooks }`，
每份带 `{ status, reportId, analyzedAt, report }`，`status` 如实三态：

| status | 含义 |
|---|---|
| `included` | 已纳入（报告正文快照就在库里） |
| `missing` | 还没跑过 / 没保存过这份分析 |
| `sample_mismatch` | 找到了同类报告，但采样不是同一批视频，不敢硬塞 |

🔴 **关联方式是这一轮最容易做错的地方**：**2.2/2.3 的报告里没有存来源分类报告的 id**
（`normalizeGoldThreeSeconds` / `normalizeEndingHooks` 只写了 `account` + `contentStyle`），
所以**不能靠报告 id 关联，更不能按账号名匹配**（按名匹配是被 §0.1 明令禁止的做法）。

改用**采样视频集合**关联：2.2/2.3 都走 `selectStageVideos`，样本必须与 2.1 报告完全一致
（§3.4(d) 的回归测试就是钉这件事）。实现见 `findAccountAnalyses`：完全一致优先，
其次要求 ≥90% 重叠，**低于阈值就返回 null、如实标 missing**，绝不拿别的报告顶替。

- ⚠️ 判定「分类树为空」的路径也要跟着改：分类树现在在 `analyses.classification.categories`，
  顶层 `categories` 只是**序列化时的兼容别名**。我在 `saveTopicLibrary` 里漏改了这处，
  读 `nextAccount.categories.length` → `undefined.length` → **每一次保存都抛异常**。
  **单元测试没抓到（它们只测 `buildLibraryAccount`），是临时库上的端到端脚本抓到的** ——
  所以「改数据结构」之后一定要跑一次真的读写，别只跑纯函数测试。
- 旧库文档（只有顶层 `categories`、没有 `analyses`）在 `normalizeAnalyses` 里补成新形状，
  老库不会「分类全没了」，有回归测试钉着。
- **标签词典仍然只取分类树**（2.2/2.3 不参与打标签的词典）—— 打标签要的是大类/小类。

**② 视频筛选只留员工端**

- 项目经理的 2.4 现在**只有建库/维护库**（选客户 + 选报告 + 保存入库 + 查看 + 移除/删库）。
- 「新更新视频筛选与标签」+ 结果列表**只在员工只读视图**（`/topics?view=newVideos`）渲染。
- ⚠️ 不只是「不渲染」：经理视图里连那两个面板的**构造**都跳过了（`body` 按 `readOnly` 分支
  各返回一套），免得白做一遍渲染工作。
- 副作用（**预期，不是 bug**）：项目经理自己不再能跑「新视频筛选」，要先建库、再由员工跑。

**验证**：单测 **282** / 冒烟 **113**（新增三份分析断言：`analyses` 三个键都在、
没跑过的 2.2/2.3 如实 `missing`、分类树挂在 `analyses.classification.categories` 下）；
临时库端到端脚本 9 条断言（采样一致→纳入、采样不一致→不纳入、幂等没坏、读回形状完整、词典仍只取分类），
跑完 `dropDatabase`；**无头 Chrome 渲染两个视图并读 DOM**：经理视图
（有 2.1/2.2/2.3 徽章、`未纳入`/`采样不一致` 各 1、**无**视频面板、有保存/删除库）
与员工视图（三徽章齐、**有**视频面板、**无**保存/删除库），两遍都无 console 报错。脚手架用完已删。

#### 「今日选题」页改造：点赞门槛 + 脚本 + 标签（2026-09-21 第三轮，用户拍板）

**用户要求**：把员工端「今日选题」（`/topics`）的输出与筛选改掉 ——
每条选题只保留**近 7 天、点赞 > 100** 的视频，**语音提取完整脚本**，并**按本账号选题库的
大类/小类打标签**，仍然输出可打勾的列表；勾选进二创时**不必再提取脚本**。
15/30 天及以上的时间筛选**保留**，但**不提取脚本**（与老页面的区别就是多了
**基础数据筛选（点赞 > 100）** 和 **标签判定**）。

**落地方式**：不新建页面，直接改 `/topics` 本身（保留它原有的分组、排序、勾选、发送）。

1. **`src/app/topicContentRules.ts`（新，纯规则）** —— 点赞门槛、脚本提取范围、
   `attachContent`（把脚本/标签挂到 topic 上）、转写目标筛选。
   🔴 **这个文件刻意不 import 任何会拉进浏览器依赖的模块**：`node --test` 只能直接加载
   **不依赖浏览器**的 `.ts`。第一版把纯规则和网络编排写在同一个文件里，
   测试直接 `ERR_MODULE_NOT_FOUND`（它 import 的 `api.ts` 用了 `import.meta.env`）。
2. **`src/app/topicContentAnalysis.ts`（新，网络编排）** —— 取库 → 分批转写 → 打标签。
   客户没有库时**不猜**，直接说明原因。
3. **`App.tsx`** —— `qualifiedTopics`（严格 `>100` 过滤）→ 异步补 `content`（脚本+标签）
   → `topicsWithContent` 供列表与勾选共用；卡片上渲染大类/小类标签、`已提取脚本` 徽章、
   可展开的脚本；状态条如实汇报进度与失败原因。
4. **`ContentPage.tsx`** —— `TopicLike`/`BenchmarkVideo` 接收 `content`，
   `buildBenchmarkVideos` 把 `script` 一起带上；最终草稿的 `benchmarkVideos` 因此**自带脚本**，
   这正是「二创不必再提取」的落点。

🔴 **两个必须记住的接线点**：

- **`customerId` 必须从任务带下来**。用户口径：客户在**入口**就定了 ——
  临时任务创建时选客户、指派任务点某个客户的任务进入。但
  `/api/tasks/today` 的聚合 `$project` **原本没带 `customerId`**（只有 `customerName`），
  前端因此永远拿不到库。已补进投影 + `TaskItem` 类型 + 临时任务的伪任务。
  **词库从入口来，不要在 `/topics` 上另加客户选择器**（用户明确否掉了这个方案）。
- **2.2/2.3、以及脚本的转写都按 `scope` 隔离**：这里的完整脚本走 `scope: "script"`，
  与黄金三秒的 `head`、结尾钩子的 `tail` 互不命中（§6.6㉚）。

**🐛 渲染时才炸出来的一个崩溃（build 与单测都拦不住）**：
`topicsWithContent` 的 `useMemo` 写在两个 `useState` **之前**，读 `topicContent` 撞 TDZ →
`Cannot access 'topicContent' before initialization`，**整页白屏**。
`npm run build` 只转译不做绑定检查、单测只覆盖纯函数，都发现不了 ——
**是无头 Chrome 渲染时才报出来的**。修法：`useState` 必须声明在用到它的 `useMemo` 之前。

**验证**：单测 **288**（新增 6 条：`=100` 不达标 / 缺失点赞不算达标 /
只有 ≤7 天才提取脚本 / 脚本挂载不改原数组 / 序列化往返后脚本仍在 / 转写只送有链接的）；
无头 Chrome 渲染整页（含自动抓取 → 过滤 → 打标签全流程）并断言：
列表只剩 **2 条**（夹具 6 条里 59、100、缺失点赞的三条**都被滤掉**，`exact100` 与
`leakedLow` 均为 false）、筛选口径文案在、状态条在、大类/小类/「待人工复核」标签各 1、
`已提取脚本` 与「查看脚本」都在、**页面无 console 报错**。脚手架用完已删。

#### 脚本 / 标签分析对所有登录用户开放（2026-09-21 第四轮，用户拍板）

**症状**：员工在「今日选题」看到
「脚本 / 标签分析失败：**该功能仅供项目经理使用**」。

**原因**：`/api/agent/benchmark-topic-refresh` 一直用 `requireManager`，
而这一轮才让员工端用它 → 403。

**修法**（两套后端同步）：
- `requireManager` → **`requireAuth`**（登录即可，员工 / 项目经理都能用）；
  两处 `ownerId` 从 `manager.id` 改成 **`user.id``。
- 🔴 **`ownerId` 必须传当前用户的 id**，不能为了"共享缓存"统一成某个固定值：
  `gold_three_second_transcripts` 的唯一索引是 `{managerId, videoId, scope}`，
  传项目经理的 id 会让**员工的完整脚本写进项目经理的命名空间**（反之亦然）。
  代价是转写缓存按人隔离、员工之间不复用；这是**有意的**，别当 bug 改掉。
- 未登录仍然 401（放开的是"登录用户"，不是"所有人"）。

**冒烟新增 3 条**：员工调用 → 200、**项目经理仍能调用 → 200**（放开权限不能把经理那条弄坏）、
未登录 → 401。

⚠️ **`node server/index.js` 没有热重载**：改完必须**重启本地服务**，
否则浏览器仍打在旧进程上、报的还是那句 403（实测确认旧进程返回
`{"error":"该功能仅供项目经理使用"}`）。线上 Vercel 重新部署后自动生效。

#### ⚠️ 仍未做的（只剩这一件）

**没有用真实账号 + 真实 TikHub/DeepSeek 跑过这条新链路。** 上面全部是单测 + 冒烟 +
夹具渲染，属于 §6.5㉓ 允许的范围，但**不等于端到端可用**。按风险排序：

1. 真实抓取近 7 天 + 真实点赞过滤（要确认 TikHub 的 `days` 参数真按**发布时间**开窗）。
2. **完整脚本转写**：新视频走 `scope: "script"`（完整口播，**不裁剪**），这是本项目里
   **第一条完整转写的新链路**；§4.4 的性能基线是在「裁剪 5 秒」上测的，**不能直接套用**。
   60 条完整转写会不会超 `maxDuration: 300` 未验证。
3. 真实 DeepSeek 打标签的质量（尤其「同名大类跨账号」时会不会选错账号的标签）。
4. 2.1 报告分类树 → 库 → 标签词典这条传递在真实数据下的表现。

#### 本轮绝对不要再踩的坑

- **把 1.3 的客户报告当成建库源头**；完整选题库从 2.1～2.3 来。
- **把两类内容都套成口播分类**；把图里的分类名与比例写死。
- **拿 2.2 开头几秒或 2.3 末尾片段缓存充当完整脚本**。完整脚本必须走
  `TRANSCRIPT_SCOPE_SCRIPT`，与 `head`/`tail` 隔离（§6.6㉚ 同一条纪律）。
- **把点赞排序当成门槛过滤**，或把 `> 100` 改回 `>= 100`；
  **点赞缺失不能视作已达标**（归一化成 0，被 `>` 挡掉是对的）。
- **跨账号仅按标题/同名分类误绑定** —— 库内分类 id 带账号作用域就是为了防这个，别去掉。
- **把勾选自动解释为写入正式库**。
- **不要为了「让列表小一点」把 `accounts` 塞回列表接口**：逐库取账号名（`distinct`）
  已经够用，分类树正文按 `customerId` 单取。
- **MongoDB 投影不能混用包含与排除**（`_id` 除外）。`{ "accounts.categories": 0 }` 会被
  服务端拒绝 —— 本轮被冒烟测试逮到过一次，正确做法是整个 `accounts` 一起排除。
- **按账号名或报告 id 去关联 2.2/2.3**：它们的报告里**没有**来源分类报告的 id，
  只能按**采样视频集合**关联（`findAccountAnalyses`）。按名匹配是被明令禁止的做法，
  匹配不上就如实标 `missing`，不许拿别的报告顶替。
- **改库条目结构后只跑纯函数单测**：分类树从顶层 `categories` 挪到
  `analyses.classification.categories` 时，`saveTopicLibrary` 里一处漏改
  （`nextAccount.categories.length`）会让**每次保存都抛异常**，而单测全绿。
  改数据结构必须补一次**真实读写**（临时库端到端脚本）。
- **把 `analyses.classification.categories` 和顶层 `categories` 搞混**：
  顶层那个只是**序列化出来的兼容别名**，`buildLibraryAccount` 的返回值里**没有**它。
- **把 `customerId` 换到 `/topics` 上选**：客户在**入口**就定了（临时任务创建时选、
  指派任务点某个客户的任务进入）。`/api/tasks/today` 的 `$project` 必须带 `customerId`，
  否则前端只知道客户名、查不到库，标签无从谈起。
- **把纯规则和浏览器依赖写在同一个 `.ts` 里**：`node --test` 只能直接加载**不依赖浏览器**的
  模块，混在一起会让测试 `ERR_MODULE_NOT_FOUND`。纯规则放 `topicContentRules.ts`。
- **`useState` 声明晚于用它的 `useMemo`**：会撞 TDZ 整页白屏，
  而 `npm run build` 与单测**都发现不了**，只有无头浏览器渲染时才报出来。
- **让项目经理也能跑「新更新视频筛选与标签」**：用户明确要求这个功能**只留员工端**，
  经理的 2.4 只建库/维护库。
- **把 2.4 的写操作开放给员工**：员工只该**读**库（拿它当打标签的词典）。
  建库/移除账号/删库必须保持 manager-only —— 冒烟里 3 条 403 钉着。
- **在员工侧回传 `managerId` 或客户 IP 档案**：`*ForEmployee` 两个函数故意收窄，
  别图省事改回 `getTopicLibrary`（那条按 managerId 过滤，员工根本读不到东西）。
- **把 `lockedCustomerId` 只当初始值**：必须覆盖草稿里的旧值，
  否则员工会读到上一次看过的**别的客户**的库（sessionStorage 里的残留）。
- **把客户名交给前端传**：`customerName` 一律由后端从库里取。
- **在 `App` 里按 query 提前 return 切视图**：`App` 有几十个 hook，
  条件式提前 return 会让 hook 顺序随 query 变化。分支放 `src/main.tsx` 的 `TopicsRoute`。
- **未经定义打通经理报告给所有员工读取**：三种隔离口径见 §3.7(d)。

---

## 1. 我们在做什么

### 1.1 两个项目的关系

账号定位是一条跨两个项目的完整流水线：

1. **`/Users/ypc/Desktop/归档项目/ai-project-assistant-main`**
   - 项目经理在这里录入外部客户/IP 档案（原来的「IP 账号规划访谈信息采集清单」入口）。
   - **该功能已完成**，数据写入线上 MongoDB。
   - 本项目**不重复实现**，直接沿用。

2. **`/Users/ypc/Desktop/归档项目/xiaomang`**（本文档所在项目）
   - 员工继续使用原有的今日任务、文案二创、发布仓功能。
   - 项目经理功能也整合在这里，共用同一套登录认证和 MongoDB。
   - **当前工作全部集中在这里。**

### 1.2 板块结构：三个模块、两层

> **⚠️ 2026-09-17 修正：这里的模型之前是错的。**
> 旧文档和旧代码把它写成「5 个平级阶段」，按 `2.1 → 2.2 → 2.3 → 1.2 → 1.3` 排成一条
> 直线，于是 2.x 看起来像是 1.2/1.3 的**前序阶段**。
> **实际上不是**：编号先 2 后 1 本身就是提示 —— 2.x 和 1.x 是**两个章节**。
> 2.1/2.2/2.3 是**模块 3 的内部子步骤**；1.2/1.3 是**复用模块 3** 的上层模块。

```text
外部客户 / IP 档案（另一个项目录入，已完成）
        │
        ▼
┌─── 模块 3　选题库构建 ───────────────────────┐
│      ├── 2.1 对标账号分类分析      ✅ 已完成  │
│      ├── 2.2 黄金三秒库分析        ✅ 已完成  │
│      └── 2.3 结尾钩子库分析        ✅ 已完成  │
│                                              │
│    产出：正式选题库                           │
└──────────────────────────────────────────────┘
        │
        │ 复用（读模块 3 的产出，不是流水线的下游）
        ▼
┌─── 模块 1　对标账号分析（1.2）     ✅ 已完成 ─┐
└──────────────────────────────────────────────┘
┌─── 模块 2　账号规划（1.3）         ✅ 已完成 ─┐
└──────────────────────────────────────────────┘
```

**三条必须记住的结论：**

1. **模块 3 是底座。** 2.1/2.2/2.3 是它的**内部子步骤**，不是和 1.2/1.3 平级的模块。
2. **模块 1 / 2 复用模块 3 的产出。** 方向是单向的（复用，不是回写）。
   ⚠️ 准确说：**1.2 直接读模块 3**；**1.3 直接读「客户 IP 档案 + 1.2 的报告」**，
   经 1.2 间接用到模块 3（见 §3.6 的 `customer.context` 与分类透传）。
3. **正式选题库 = 模块 3 的产出。** ⚠️ 这与旧文档相反：旧约束「账号定位阶段不建立
   正式选题库」**已作废**，详见 §6.1 ③。

**界面形态**：单页 Hub `/manager/account-positioning` —— 顶部 3 个模块卡片，选中模块 3 时
在它下方展开 **2.1/2.2/2.3 + 2.4** 的子步骤轨道（缩进 + 左侧描边表示层级，不加页面级小标题）。
2.1～2.3 排成一行，**2.4 整行渲染**（`sm:col-span-3`）—— 它是模块 3 的产出落地步骤，
单独占一行才不会把前三步挤窄。

**模块清单只有一份**：`src/app/accountPositioningModules.ts`。`AccountPositioningPage`
和 `ManagerHomePage` 都从它读。**不要再在任何地方另写一份阶段/模块列表** —— 旧版本两处各
写一遍，2.3 上线时必须记得同时改两处（而且其中一处已经被漏掉过一次）。

---

## 2. 项目结构与约定

### 2.1 🔴 两套后端必须同步

这是本项目最容易出错的地方。**任何后端改动都要同时改两处**：

| | 位置 | 说明 |
|---|---|---|
| 本地开发 | `server/index.js` | Express，端口 8787，无限时 |
| 线上部署 | `api/**/*.ts` + `vercel.json` | Vercel Serverless，有 `maxDuration` 限制 |

只改本地会导致「本地能用、线上 404」；只改线上会导致本地调试不了。
两套入口的**鉴权、错误处理、响应结构必须完全一致**。

为此项目把业务逻辑都放在 **`api/_lib/*.js` 共享层**，`server/index.js` 和 `api/**` 都 import 它。
**改共享层时两套自动同时生效，路由层不用动** —— 优先这么做。

### 2.2 关键目录

```
src/app/          前端页面与组件（React + TypeScript + Tailwind）
api/_lib/         后端共享业务逻辑（纯 JS，两套入口共用）★ 大部分改动在这里
api/agent/        Agent 类 Vercel 端点
api/*/index.ts    报告存储类 Vercel 端点
server/index.js   本地 Express（把 api/_lib 挂成路由）
tests/            node:test 单测（npm test）
docs/             产品需求文档、技术设计文档（.docx）
```

### 2.3 鉴权与数据

- 项目经理/员工身份区分，`RequireRole` / `requireManager` 保护。
- 项目经理入口：`/manager`、`/manager/account-positioning`。
- 数据全部在**线上 MongoDB**，按 `managerId` 严格隔离。
- 连接配置：`MONGODB_URI || MONGO_URI`，`MONGODB_DB_NAME` 可选（见 §6.2）。
- 当前库名是 `test`（连接串里的默认库），**有真实数据，不要改**。

### 2.4 账号定位相关文件一览

**前端**
| 文件 | 作用 |
|---|---|
| `accountPositioningModules.ts` | ★ **三个模块 + 模块 3 子步骤的唯一结构定义**。页面和工作台都从这里读，别再各写一份清单 |
| `AccountPositioningPage.tsx` | 唯一入口。两层导航（3 模块 → 模块 3 的 2.1/2.2/2.3/2.4）+ 阶段组件挂载点 |
| `TopicLibraryStage.tsx` | ★ **子步骤 2.4 正式选题库与更新筛选**：建库/追加账号 + 新视频筛选打标签（2026-09-21 新增） |
| `topicLibrary.ts` | 2.4 的客户端类型与接口（库 CRUD + 新视频转写/打标签） |
| `BenchmarkClassificationStage.tsx` | 子步骤 2.1 分类分析 |
| `GoldThreeSecondsStage.tsx` | 子步骤 2.2 黄金三秒 |
| `StageShell.tsx` | 阶段共用的外壳（状态驱动布局） |
| `stageDraft.ts` | 阶段草稿（sessionStorage 持久化，切阶段/刷新不丢数据） |
| `reportApi.ts` | 报告接口客户端（列表 / 按 id 取 / 保存 / 删除） |
| `benchmarkAnalysis.ts` | 分类报告的客户端类型与归一化 |
| `goldThreeSeconds.ts` | 三秒报告的客户端类型与 Markdown 导出 |
| `EndingHooksStage.tsx` | 子步骤 2.3 结尾钩子 |
| `endingHooks.ts` | 结尾钩子报告的客户端类型与 Markdown 导出 |
| `BenchmarkProfileStage.tsx` | ★ **模块 1 对标账号分析（1.2）**：五步驱动循环 + 结果页 |
| `benchmarkProfile.ts` | 1.2 的客户端类型、证据分级徽章查表与 Markdown 导出 |
| `benchmarkRun.ts` | ★ **1.2 / 2.1 共用**：抓 60 条 + 跑分类 → 分类报告 |
| `BenchmarkSetupForm.tsx` | ★ **1.2 / 2.1 共用**的「分析设置」表单卡片 |
| `docx.ts` | ★ **零依赖 .docx 生成器**（手写 zip+WordprocessingML），报告「导出 Word」用 |
| `stageSampleWindow.ts`（后端） | 2.2/2.3 共用的样本窗口与归类规则 |
| `categoryTypeBreakdown.js`（后端） | 2.2/2.3 共用的按大类配比计算 |
| `AccountPlanStage.tsx` | ★ **模块 2 账号规划（1.3）**：六节报告渲染 + 客户选择 + 已保存规划列表 |
| `accountPlan.ts` | 1.3 的客户端类型、`ACCOUNT_PLAN_SECTION_LABELS` 与 Markdown / Word 导出 |
| `ErrorBoundary.tsx` | 全局渲染错误兜底 |

**后端**
| 文件 | 作用 |
|---|---|
| `api/_lib/benchmarkAnalysis.js` | 分类分析归一化 + 关键词规则兜底 |
| `api/_lib/benchmarkReportStore.js` | 分类报告存储（幂等保存 / 列表 / 按 id / 删除） |
| `api/_lib/goldThreeSeconds.js` | 三秒阶段核心：输入组装 + 归一化 + 按大类配比统计 |
| `api/_lib/goldThreeSecondStore.js` | 三秒报告存储 |
| `api/_lib/endingHooks.js` | 结尾钩子核心：5 个类型的唯一定义 + 输入组装 + 归一化 |
| `api/_lib/endingHookStore.js` | 结尾钩子报告存储 |
| `api/_lib/stageSampleWindow.js` | 2.2/2.3 共用的样本窗口（60 条 / 点赞降序 / 归类） |
| `api/_lib/categoryTypeBreakdown.js` | 2.2/2.3 共用的按大类类型配比 |
| `api/_lib/goldThreeSecondTranscripts.js` | 真实口播转写编排（有界并发 + 时间预算） |
| `api/_lib/transcriptStore.js` | 转写结果持久化缓存 |
| `api/_lib/contentAgent/prompts.js` | 所有 Agent 提示词 |
| `api/_lib/contentAgent/providers.js` | 所有 Agent 调用（DeepSeek / 豆包 / TikHub） |
| `api/_lib/contentAgent/config.js` | 所有 Agent 配置（读环境变量） |
| `api/_lib/benchmarkProfile.js` | ★ **模块 1 核心**：输入组装 + 归一化 + 证据分级 + 后端实算 |
| `api/_lib/benchmarkProfileStore.js` | 1.2 报告存储（与其它四个 store 同构） |
| `api/_lib/videoComments.js` | 高赞评论抓取（app/v3 主 + web 兜底、字段别名兜底） |
| `api/_lib/commentStore.js` | 评论永久缓存（成功与失败都缓存，`attempted = ok + failed`） |
| `api/_lib/douyinFansPortrait.js` | ★ **粉丝画像真实数据源**：热榜 8 维度并发抓取 + 归一化 + 映射到用户画像 |
| `api/_lib/fansPortraitStore.js` | 粉丝画像账号级缓存（**带 7 天 TTL**，与永久缓存的两个 store 不同） |
| `api/tikhub/fans-portrait.ts` | 粉丝画像端点（**付费**，manager-only，一次并发 8 个上游 GET） |
| `api/agent/benchmark-profile.ts` | 1.2 Agent 端点（`phase: transcribe\|analyze`，transcribe 带 scope） |
| `api/benchmark-profile-reports/index.ts` | 1.2 报告 CRUD |
| `api/tikhub/comments.ts` | 评论抓取端点（**付费调用**，manager-only） |
| `api/_lib/evidence.js` | ★ **1.2 / 1.3 共用**的证据助手（分级 / 引文核对 / 价格核对）。**报告诚实性规则只在这里实现一份**，两处不再各写一份 |
| `api/_lib/accountPlan.js` | ★ **模块 2（1.3）核心**：输入组装 + 证据分级 + 后端实算 + 六节归一化（含带 `template` 标记的固定文本） |
| `api/_lib/accountPlanStore.js` | 第 5 个同构报告 store，集合 `account_plan_reports` |
| `api/_lib/ipProfileStore.js` | 客户名册读取层（`customers.ipProfile`）+ `IP_PROFILE_GROUPS`（3 组 19 字段的**唯一来源**） |
| `api/customers.ts` | 客户列表 / 详情（manager-only，**不按 managerId 过滤**） |
| `api/agent/account-plan.ts` | 1.3 Agent 端点（只有 `analyze` 阶段，不需要转写与评论） |
| `api/account-plan-reports/index.ts` | 1.3 报告 CRUD |
| `api/_lib/topicLibraryStore.js` | ★ **2.4 正式选题库存储**（2026-09-21 新增）：集合 `topic_libraries`，客户级唯一，多账号各自独立分类，分类 id 带账号作用域。**另含三种轻量投影**：`getTopicCategoryDictionary*`（打标签用，带小类）、`getTopicLibraryCreativeAdaptation`（🆕 二创适配用，带配比、不带小类） |
| `api/_lib/topicCreativeAdaptation.js` | 🆕 **二创适配纯逻辑**（2026-09-21 第六轮）：配比→10 槽位（最大余额法）、大类配比查表、提示词片段。**无模型无 DB，单测都打在这里**（§0.2） |
| `api/_lib/benchmarkTopicRefresh.js` | ★ **2.4 新视频打标签核心**：只认库内大类/小类、点赞门槛、脚本来源、Agent 失败兜底 |
| `api/agent/benchmark-topic-refresh.ts` | 2.4 Agent 端点（`phase: transcribe\|analyze`，转写走 `scope: "script"`） |
| `api/topic-libraries/index.ts` | 选题库 CRUD（列表只给元数据；`?action=remove-account` 移除单个账号） |

---

## 3. 已完成的能力

### 3.1 统一鉴权 ✅

项目经理账号登录进 `/manager`，员工账号进原有工作流；登录、注册、会话、身份都用线上 MongoDB。

**历史排查结论（遇到时别重新查）**：
- `/api/auth/me` 未登录返回 401 是**正常的未认证状态**，不代表登录接口坏了。
- 浏览器报 `content_main.js ... toLowerCase` 来自**浏览器扩展**，不是本项目代码。
- 本地 Vite 报 `ECONNREFUSED /api/auth/login`，通常是本地 Express（8787）没启动。

### 3.2 子步骤 2.1 对标账号分类分析 ✅

入口：`/manager/account-positioning` 的第 2.1 步。

**流程**：

```
① POST /api/tikhub/batch  { urls, platform, latestOnly:true, count:60, maxPages:20 }
      → 抓该账号最新 60 条作品（一次最多 3 个账号，串行）
② normalizeBenchmarkVideosFromBatch()   [前端]
      → 先剔除空壳（无 id 且无「标题+分享链接」）→ 再截 60 条窗口 → 最后映射字段
③ POST /api/agent/benchmark-analysis
      ↓ 后端：
      a. normalizeBenchmarkVideos()   后端再归一化一次（不信任前端）
      b. runBenchmarkAnalysisAgent()  按口播/演绎选**两套独立 prompt** → DeepSeek
                                      JSON 解析失败会再调一次「JSON 修复器」
      c. 失败 → 兜底：analysisSource="heuristic" + 关键词规则分类
      d. normalizeBenchmarkAnalysis() ★ 只接受输入里的 videoId，
                                      重算 count/percentage，未知 → 「待人工复核」
④ 展示 → 勾选重点样本 → 保存 → POST /api/benchmark-reports → MongoDB benchmark_reports
```

**报告结构**：大类 → 小类 → 具体选题（标题 + 链接 + 互动数据）。
大类/小类下的选题**只存 `{ id, title }` 引用**，完整视频数据统一在 `report.videos`。

### 3.3 子步骤 2.2 黄金三秒分析 ✅

入口：`/manager/account-positioning` 的第 2.2 步。

**这一阶段在 2026-09-17 做过多次修正，当前形态如下：**

#### (a) 开场文案来自真实口播转写

**重要**：`sourceText` 是 TikHub 的 `desc`（平台发布文案），往往只是标题加话题标签，**不等于视频里说的话**。所以 2.2 会先做真实转写。

**两条链要分清楚**（2026-09-17 实测后调整过，别搞混）：

```text
黄金三秒链路（config.goldTranscriptProviders）★ 2.2/2.3 走这条
    ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video
    (本地·能裁剪)   (TikHub·mp3)   (TikHub·兜底)    (视频理解兜底)

全局链路（config.transcriptProviders）—— 员工二创走这条，保持原样
    tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video
```

黄金三秒把**本地 ffmpeg 提到第一位**：只有它能吃到 `-t` 裁剪，而且实测比 TikHub 服务端的
ffmpeg 快 5 倍（§4.4）。TikHub 两个 provider 留在后面兜底。

实测对比同一条视频：

```
发布文案："再这么下去，就没人敢创业了！ #老板用工 #劳动仲裁 #用工风险"
真实转写："再这么下去就没人敢创业了。现在民营企业说好听点叫中国经济的根，
          但说难听点就是案板上的一块肉……"   ← 真正的开场白
```

**完整转写单条实测约 89 秒**（55 秒的视频：解析 4.7s + 转写 84.2s），而本步骤现在要覆盖
**全部 60 条**。2026-09-17 加了「只转写开头几秒」（`GOLD_TRANSCRIPT_CLIP_SECONDS`，给 ffmpeg
加 `-t N`）。**但必须知道下面两件事，否则会误判它已经生效：**

> ✅ **① 黄金三秒有自己的 provider 顺序，本地 ffmpeg 排第一。**
> 全局链路（员工二创用）是 `tikhub-music → tikhub-ffmpeg → ffmpeg → doubao-video`，
> 前两个的 ffmpeg **跑在 TikHub 服务端**，我们传不了 `-t` —— 本地 ffmpeg 在第 3 位时
> **裁剪等于死代码**。所以黄金三秒改用 `config.goldTranscriptProviders`
> （默认 `ffmpeg → tikhub-music → tikhub-ffmpeg → doubao-video`）。
> 显式传这个顺序还会**关掉「有 TikHub 就跳过本地 ffmpeg」那条隐式优化**
> （`transcribeVideo` 里的 `explicitProviders`），否则顺序会被静默改回去。
> TikHub 仍留作兜底：本地 ffmpeg 失败会自动往下走。实测见 §4.4。
>
> ⚠️ 注意：在 `.env` 里写 `TRANSCRIPT_PROVIDERS=ffmpeg,...` **不能**把本地 ffmpeg 提到
> 全局链首 —— `getTranscriptProviders()` 会自动把 TikHub 两个 provider `unshift` 进去。
>
> ✅ **② EPIPE 崩溃已修**（2026-09-17）—— 见 §4.3.4。

**只对黄金三秒生效**：员工二创链路要完整脚本，`transcribeVideo` 不传 `clipSeconds`
就是原来的行为，**不要给它加这个参数**。

**裁剪口径进缓存 key**（`::clip5` vs `::clip0`）：否则同一个进程里，黄金三秒的 5 秒转写
会被员工二创当成「完整转写」命中，而且不会有任何报错。

**开头没人声时回退完整转写**：开头 5 秒可能是纯音乐/环境音，人声从第 7 秒才开始。这种
情况裁剪转写会返回空文本，worker 会拿 `clipSeconds: 0` 再转一次 —— 宁可慢也不丢样本。

批量机制：**前端驱动分批** + **服务端有界解析预取**。

- `/api/agent/gold-three-seconds` 分两个 `phase`：
  - `transcribe` → 转写下一批没做过的样本，返回累计进度
  - `analyze` → 用已有转写跑 DeepSeek，产出报告
- 前端 `collectTranscripts` 循环调 transcribe 直到 `finished`，再调 analyze
- **每批条数 `GOLD_TRANSCRIPT_BATCH_SIZE`（默认 30）** —— 2026-09-17 从 3 放大。
  60 条现在 2 轮就完（原来 20 轮，每轮的鉴权 + 2 次进度查询 + 往返已经和实际工作同量级）
- **解析预取 `GOLD_TRANSCRIPT_RESOLVE_CONCURRENCY`（默认 8）** —— TikHub 解析 3.4~4.7s/条，
  比裁剪后的转写还慢，所以让它提前、更宽地跑，转写 worker 直接取现成结果。
  实现在 `createResolvePrefetch`，**两条不变量有回归测试**（见 §4.4⑥）
- 每批带时间预算 `GOLD_TRANSCRIPT_BUDGET_MS`（默认 240s），必须小于端点 `maxDuration`（**300s**）
- 转写结果**按视频永久缓存**到 MongoDB（`gold_three_second_transcripts`）——
  **同一个视频一个项目经理只付一次成本**，重跑和追加样本秒开
- ⚠️ 缓存里可能同时存在「旧的完整转写」和「新的前 5 秒转写」，两者都是真实口播，可以混用；
  但如果以后要改裁剪秒数，记得旧缓存不会自动失效。

#### (b) 8 个分析维度

**好奇心、恐惧、愤怒、反差、痛点、兴趣、求知欲、欲望**（顺序即此）。

判定口径定义在 `api/_lib/goldThreeSeconds.js` 的 `GOLD_THREE_SECOND_DIMENSIONS`
（含 `definition` / `example` / `strength`）。**这份定义是唯一来源**：提示词从它生成，
报告里带 `dimensions` 字段供前端直接渲染。详见 §6.3。

#### (c) 按大类出配比（本步骤的主产出）★

> **2026-09-17 用户用一张导图明确了这一节，是本节唯一的验收口径：**
> `口播类对标账号 → 账号 → 每个大类 → (3s类型 / 配比 / 原因分析)`，
> 大类框里带「核心功能」与「判断核心关键词/语句」，三列分别是 **大类 | 3s类型/配比 | 原因分析**。
>
> **呈现照 2.1 分类分析的「大类块」做**（可折叠 + 序号徽章 + 「大类」标签 + 占比进度条，
> 展开后左边是该大类的核心功能/判断关键词，右边按维度缩进列出配比与原因）。
> 位置：`GoldThreeSecondsStage.tsx` 的 `CategoryBreakdown`。
> **逐条样本列表已按用户要求删掉**（页面和 Markdown 导出都删了），
> `report.items` 字段仍然保留 —— 配比就是从它统计出来的，别删数据。

```text
账号
└── 大类（本次样本 N 条 · X%）
    ├── 核心功能            ← 从分类报告带过来
    ├── 判断核心关键词/语句  ← 从分类报告带过来
    └── 3s维度 / 配比 / 原因
```

**配比由后端按每条样本的 `type` 实际统计**（最大余额法，每个大类合计恰好 100）。
**模型只提供 `reason` 解释**，它填的百分比一概不采信。详见 §6.4。

**⚠️ 原因分析的依据（曾经写错，2026-09-17 修正）：**

- `reason` 只能建立在**该大类自己的** `coreFunction` + `keywords` 之上，回答
  「这个大类的这类内容，为什么用这个三秒类型」—— 卖点是什么、这个类型怎么放大它、
  这类受众在什么心理状态下会被抓住。
- **不要**从**账号定位 / 人设定位 / 用户画像**的角度解释。那是**模块 1.2 对标账号分析**的
  工作，不是 2.2 的依据。提示词里现在有一句明确的禁止，**别删**。
- `topTypes` 是**账号级汇总**，提示词已写明它**不替代**按大类的解释 ——
  这正是 §6.3 ⑬ 那个「所有大类一模一样」的复发口子。

#### (d) 每条样本都标来源

- `真实转写`（绿）—— 开场文案来自 ASR/视频理解
- `发布文案推断`（琥珀）—— 该视频没做成转写，只能从发布文案推断

报告头部另有「开场文案：真实转写 N 条 / 发布文案推断 N 条」。
**不标出来用户会以为两者是一回事。**

#### (e) Agent 重试与输出上限

- 分类/三秒 Agent 都有**自动重试**（`AGENT_RETRY_ATTEMPTS`，默认 2 次 + 首次），
  带**时间预算** `AGENT_RETRY_BUDGET_MS`（默认 90000ms）。
- `DEEPSEEK_MAX_TOKENS=393216`（API 上限）。**别调小**，见 §6.3。

---

### 3.4 子步骤 2.3 结尾钩子库分析 ✅

与 2.2 **同构**（独立 Agent、独立报告、独立存储、独立端点），但看的是视频**结尾**。
2026-09-17 实现。

**文件结构**（照抄黄金三秒，一一对应）：

| 2.3 | 对应 2.2 的 |
|---|---|
| `api/_lib/endingHooks.js` | `goldThreeSeconds.js` |
| `api/_lib/endingHookStore.js` | `goldThreeSecondStore.js` |
| `api/agent/ending-hooks.ts` | `api/agent/gold-three-seconds.ts` |
| `api/ending-hook-reports/index.ts` | `api/gold-three-second-reports/index.ts` |
| `src/app/endingHooks.ts` | `goldThreeSeconds.ts` |
| `src/app/EndingHooksStage.tsx` | `GoldThreeSecondsStage.tsx` |

`server/index.js`（4 条路由）与 `vercel.json`（2 条 functions）都已同步。

#### (a) ⚠️ 结尾转写和开头转写是**两件事**

- 取**结尾**用 ffmpeg 的 `-sseof -N`（相对 EOF 定位）。它是**输入选项**，必须放在 `-i` **之前**；
  而且**要求输入可 seek** —— 管道 seek 不了，所以尾部裁剪**强制走 URL 输入**，
  依赖 CDN 支持 Range 请求（**抖音 CDN 实测支持**）。
  `extractAudioFromStream` 遇到 `tailSeconds > 0` 会直接报
  `FFMPEG_TAIL_NEEDS_SEEKABLE_INPUT`，不让用户拿到位置错误的音频。
- 尾部裁剪**不加 fast-probe**：`-sseof` 已经定位到文件尾，实测加上没有差别（1376ms vs 1354ms）。
- **开头/结尾必须分开存**：靠 `transcriptStore` 的 `scope` 字段（`head` / `tail`）。
  详见 §6.6㉚ —— 这是实现 2.3 时发现的一个**会静默毁掉 2.2** 的坑。

#### (a2) 🔴 已确认的语义：「配比」是**观测事实**，不是设计建议

**2026-09-17 用户拿导图确认过，这一条被误解过两次，别再改。**

导图的形状是 `账号 → 大类 → 结尾类型 / 配比 / 原因分析`，用户的措辞也像在设计
（「筛选每个大类适配的结尾类型并进行配比，解释**选择**和配比的原因」）。
但**确认下来的语义是**：

- **配比 = 这个账号在这个大类里实际用出来的分布**（后端按每条样本的类型判统计条数，
  最大余额法，每个大类合计 100）。**不是**模型建议「应该怎么配」。
- 原因那一列解释的是「**这类内容为什么用这种方式收尾**」——
  依据是该大类自己的核心功能 / 判断关键词 / **对用户的核心吸引力**，
  **不是**在论证「应该选它」。
- 所以：**模型不能自己填百分比**，只能给原因。这正是 §6.3⑬ 的规则，
  2.2 和 2.3 完全一致。
- 导图里只写「共鸣」是**简写**，类型仍是 `共鸣＋IP符号`（用户已确认）。

> 提示词口径与这条语义都有回归测试钉住（`tests/ending-hooks.test.mjs` 末尾两条），
> 改提示词时如果把它们改红了，先回来看这一节。

#### (b) 结尾类型：5 个，唯一来源是 `endingHooks.js`

`引导互动 / 引导转化 / 反转 / 金句 / 共鸣＋IP符号`（用户 2026-09-17 给定口径）。
判定口径与例句写在 `ENDING_HOOK_TYPES`，**提示词从它生成**（`ENDING_HOOKS_PROMPT`），
报告通过 `types` 字段带给前端渲染，**前端不另存一份**。改类型只改这一处。

#### (c) 结尾文案取**末句**

与 2.2 取首句对称：`lastSentence()` 分句后取最后一段。超长时从**尾部**截 160 字
（别把结尾截掉）。引用核对规则与 2.2 完全一致：模型自称引用了转写不算数，
要真能在转写原文里找到，否则退回 `caption` 并把置信度压到 low。

#### (d) 配比与样本窗口**与 2.2 共用同一份实现**

抽出了两个共用模块，避免两个子步骤各写一份然后漂移：

- `api/_lib/stageSampleWindow.js` —— 取多少条（60）、怎么排序（点赞降序）、样本归到哪个大类。
  **两份报告的大类配比要能互相印证，样本必须先一致**（有回归测试比对两边取到的样本完全相同）。
- `api/_lib/categoryTypeBreakdown.js` —— 按大类的类型配比（最大余额法、待复核不进配比、
  原因缺失留空）。这里集中了 §6.3⑬ 踩过的所有坑，**只写一份**。

#### (e) 呈现

与 2.2 完全一致：报告头 → 最常用 3 种 → 5 个类型分布（含判定口径）→
**各大类的结尾类型配比**（2.1 风格可折叠大类块：左「核心功能 / 判断关键词」，
右「结尾类型 / 配比 / 原因分析」）→ 保存。**没有逐条样本列表**（与 2.2 保持一致）。


---

### 3.5 模块 1 对标账号分析（1.2）✅ 2026-09-18 实现

**入口**：`/manager/account-positioning` 选中模块 **1.2** 卡片。它是**单体模块**（没有子步骤），
所以选中时**不展开** 2.1/2.2/2.3 那条子步骤轨道（`AccountPositioningPage` 里按
`isTopicLibrary` 判断）。

**它与模块 3 的三个子步骤是不同性质的东西，别照抄：**

| | 2.1 / 2.2 / 2.3 | 1.2 |
|---|---|---|
| 定位 | 各看一件事，产出可复用的选题库素材 | **上层综合模块**，复用 2.1 的产出 |
| 样本 | 全部 60 条 | 三秒/结尾只取**点赞最高的前 20 条** |
| 产出 | 每个大类的配比 | 最常用 3 种类型 + **4 个角度**的原因 |
| 原因角度 | **禁止**从账号定位/人设定位/用户画像解释 | **必须**从这 4 个角度解释 |

**四大板块（用户 2026-09-18 给的规格）**：商业定位、用户画像、内容定位、高频标签、运营策略。

**完整链路**（前端驱动，见 `BenchmarkProfileStage.tsx` 的 `driveBatches`）：

```text
输入（两条路，二选一）：
  A. 新账号 —— 在「分析设置」里填账号链接（表单与 2.1 共用，见 (e)）
       第 0 步：runAccountClassification() 抓 60 条 + 跑分类 → 内存里的分类报告（**不落库**）
  B. 复用 —— 选一份已保存的分类报告（或 2.1 刚交接过来的那一份）
  ① transcribe head  → 前 20 条**开头**转写（scope=head）
  ② transcribe tail  → 前 20 条**结尾**转写（scope=tail）
  ③ /api/tikhub/comments → 前 20 条的高赞评论
  ④ /api/tikhub/fans-portrait → 该账号的真实粉丝画像（8 维度）
  ⑤ /api/agent/benchmark-profile (phase=analyze) → 归一化后的报告
```

**① ② ③ 都是分批循环**，各自带「一轮没有推进就收手」的守卫（`MAX_BATCH_ROUNDS=40`），
某一步失败**不中断整条链路** —— 用已经拿到的部分继续分析，报告照出。
④ 只调一次（后端自己并发 8 个上游 GET），失败也不中断。

> 💡 **转写几乎不额外花钱**：1.2 的前 20 条是 2.2/2.3 那 60 条的**子集**，
> 排序口径相同（点赞降序），缓存键是 `(managerId, videoId, scope)` ——
> 2.2/2.3 跑过的样本这里直接命中缓存。评论与粉丝画像都是**新的付费调用**，
> 所以各自按视频 / 按账号永久缓存（画像是 7 天 TTL）。

#### (a) 三条硬性诚实性不变量 ★ 改之前必读

> 用户规格里「用户画像」要求「通过评论区和粉丝，结合平台用户画像进行分析」，
> 但**项目里没有可靠的人口属性数据源**（详见下面 (c)）。所以 1.2 的核心设计是
> **证据分级**，而不是把模型的话当真。

每个叙述字段都带 `level`：`evidence`（**输入证据**）/ `inference`（**Agent 推断**）/
`manual`（**待人工补充**）。实现在 `api/_lib/benchmarkProfile.js`：

1. **不采信模型自报的 level。** 它声明 `evidence` 时必须给出 `basis` 引文，
   而后端会把引文**拿去输入里核对**；核对不上就降级成 `inference`
   （与 §6.3⑭「不信模型自称引用了转写」同一条原则）。有回归测试。
2. **用户画像的人口属性：有真实画像分布支撑时标 `evidence`，否则最多 `inference`**，
   没依据就 `manual`。热榜粉丝画像（见 (c)）覆盖 性别/年龄/收入/消费习惯；
   **职业/行业没有对应维度，永远不是 `evidence`**。这是 HANDOFF §5「不要输出看似完整但
   没有数据依据的用户画像」的**代码化** —— 既不许编造，也不许把真实数据降级浪费。
3. **变现产品的定价必须能在输入里找到依据，否则整个清空**并标「输入中没有定价依据，
   待人工补充」。注意**「免费」「面议」这类没有数字的说法同样要核对** ——
   一个凭空的「0 元」和一个凭空的「29800 元」一样会被项目经理当成调研结论。

**可以在真实数据里看到的验证结果**（`.preview-shots/acctpos-profile-12*.png`）：
人设定位=输入证据、核心痛点=Agent 推断、年龄/收入/消费习惯=待人工补充、
三档变现产品全部显示「输入中没有定价依据」。

#### (b) 后端实算 vs 模型只给解释（沿用 §6.3⑬ 的口径）

- **高频标签**：后端从发布文案里正则抽 `#话题` 并统计条数（`extractFrequentTags`），
  **不采用模型给的词频**；同一条视频刷同一个话题只算一次。
- **发布频率**：后端从 `publishDate` 实算跨度/每周条数/星期分布（`summarizePublishing`）。
  ⚠️ 只到**日**粒度 —— 报告里存的是发布日期，没有时刻。拿不到时刻就**如实说明
  「具体发布时段待人工补充」**，不许编一个「晚 8 点」。
- **三秒/结尾的配比与「最常用 3 种」**：后端按每条样本的 `type` 重新统计条数与占比，
  **模型填的百分比一概不采信**；「待人工复核」不进 `topTypes`；8 个维度 / 5 个类型
  全部列出（含计 0）。
- **样本口径如实写清**：标签统计基于分类报告那 60 条，**不是「最近三个月」**
  （§6.1① 禁止恢复三个月规则），报告里 `tagWindowNote` 明说「最新作品口径，非自然三个月」。

#### (c) 用户画像的数据来源（2026-09-18 实测定论，别再重新调研）

**三条链路都实测过，结论如下：**

| 数据源 | 接口 | 是否需要入驻星图 | 实测结果 |
|---|---|---|---|
| **热榜粉丝画像** ★主力 | `/api/v1/douyin/billboard/fetch_hot_account_fans_portrait_list` | ❌ 不需要 | ✅ 真实账号 8/8 维度全部有值 |
| 星图粉丝画像 | `/api/v1/douyin/xingtu_v2/get_author_fans_distribution` | ✅ **需要** | ⚠️ 真实账号返回 `exist:false` |
| 评论区 | `/api/tikhub/comments` | ❌ | ✅ 可用（见 §2.4） |

- ✅ **账号简介 + sec_user_id**：`secUserResponse` / 作品 `author` 对象里本来就有，
  2026-09-18 打通了「batch → 分类报告 `account.signature` / `account.secUserId` → 1.2」。
  **旧分类报告没有这两个字段**：商业定位落「待人工补充」，粉丝画像提示「请重新跑一次分类分析」。
- ✅ **热榜粉丝画像（用户画像的真实数据源）**：**只要求 `sec_uid`**，
  实测对未入驻星图的真实账号完全可用。**一次调用只能拿一个维度**
  （不带 option 只回 `option=1`；传 `"2,3"` / `"[2,3]"` 都是 **HTTP 422**），
  所以 8 个维度要 **8 次 GET**，并发跑约 3 秒。
  维度 → 规格字段的映射：

  | option | 维度 | 供哪一项 |
  |---|---|---|
  | 2 | 性别分布 | 性别 |
  | 3 | 年龄分布 | 年龄 |
  | 1 | 手机价格分布 | 收入水平 |
  | 7 | 手机品牌分布 | 消费习惯 |
  | 6 / 4 / 5 | 城市等级 / 省份 / 城市 | 地域 |
  | 8 | 兴趣标签分析 | 兴趣 |

  ⚠️ 返回的 `value` 是 **0~1 的比例**（不是百分数），展示前乘 100。
  ⚠️ **职业/行业没有对应维度**，永远是推断 —— 别为了凑满五项去编。
- ⚠️ **星图**：数据更细（10 维，含八大人群/客单价/消费品类），但**只对入驻星图的达人有效**
  （星图是抖音商单平台，普通对标账号基本不入驻）。**当前未接入**，仅作将来可选增强。
  真要用：`get_xingtu_kolid_by_sec_user_id` → 拿 `data.id`（**字段名是 `id`**，
  成功时没有 `exist` 字段；失败时 `{exist:false, message}`）→ `o_author_id`。

**由此产生的证据规则变化**：`benchmarkProfile.js` 里人口属性的硬上限
从「永远最多 inference」改成 **「有画像分布支撑时可且应当标 evidence，否则维持 inference/manual」**。
两个方向都有回归测试锁住（既防编造，也防把真实数据降级浪费）。

#### (d) 已知未做 / 已知限制

1. **1.2 的选题链接**：报告里只带标题（`ProfileCategory.subcategories[].topics` 是 `string[]`），
   前端靠标题去内存里的分类报告反查链接，查不到就渲染成纯文本。要修就改契约带上 `id`。
2. **1.2 端到端未做真实验收**（与 §4.1 同）：链路、归一化、渲染都验证过，
   但**没有用真实账号 + 真实 DeepSeek 跑通完整一份 1.2 报告**。
   粉丝画像是其中**唯一逐个环节实测过**的部分（见 (c)）。
3. **`/api/tikhub/comments` 只取评论首页**（`cursor=0`），不翻页 —— 高赞 Top-N 首页够用，
   翻页成本线性上涨。需要更多评论时再评估。
4. **粉丝画像依赖 `account.secUserId`，旧分类报告没有这个字段** ——
   此时 1.2 如实提示「请重新跑一次分类分析」，不会静默少一块内容。新跑的分类会带上。
5. **热榜粉丝画像接口的单价文档没写**（星图那两个明确写了 $0.002/次）。
   只确认了调用成功，**成本未核实**；一个账号 8 次 GET，缓存 7 天。
6. **星图未接入**：数据更细（10 维，含八大人群/客单价/消费品类），但只对入驻星图的达人有效。
   要做的话先读 (c) 的实测结论，别重新调研。
7. **1.2 自己跑的那次分类不落库**（用户 2026-09-18 定的）。代价：如果之后还想对同一账号跑
   2.2/2.3，得回 2.1 重新抓取 + 分类一次（转写缓存仍可命中，只有分类那一段要重付）。
   想改成落库就先问用户 —— 那会在他没主动创建的情况下多出一份分类报告。

#### (e) 1.2 的输入模型（2026-09-18 用户要求：可自由新增对标账号）原来 1.2 只能从「已保存的分类报告」里挑一份，用户要求改成**能直接分析新账号**，
并且复用 2.1「分析设置」的形式。三条确认过的口径：

> 🔴 **先分清两个「报告」——这里极易误读：**
>
> | | 是什么 | 存不存 |
> |---|---|---|
> | **分类报告** | **2.1 的产出**（60 条大类/小类拆分） | 用户主动保存的**存**；<br>**1.2 内部现跑的那次不存**（只是本次分析的输入） |
> | **对标账号分析报告** | **1.2 的产出**（商业定位/用户画像/内容定位/高频标签/运营策略） | 🔴 **一直都会保存**，`benchmark_profile_reports` |
>
> **模块 2（1.3 账号规划）要读的是后者**，所以 1.2 的「保存报告」按钮与历史列表
> **不能动**。上面说的「不落库」**只针对分类报告**，不是 1.2 自己的报告 ——
> 2026-09-18 用户专门纠正过这一点，别再写含糊。

1. **一次只分析一个账号**（2.1 仍是最多 3 个，没动）。
2. **1.2 内部跑的分类不落库**，只当本次分析的输入（见 (d)7）。
3. **保留「或选择已保存的分类报告」**作为复用路径 —— 已分析过的账号不必重花抓取与分类的钱。

**为了不写两份，抽出了两个共用模块**（这是本次改动的主要结构变化）：

| 文件 | 作用 | 谁在用 |
|---|---|---|
| `src/app/benchmarkRun.ts` | `runAccountClassification()`：抓 60 条 + 跑分类 → 分类报告 | 2.1 和 1.2 |
| `src/app/BenchmarkSetupForm.tsx` | 「分析设置」卡片（内容形式 / 链接 / 数据平台 / 方法说明 / 提交） | 2.1 和 1.2 |

⚠️ **改这两个文件会影响 2.1**，改完必须把 2.1 也渲染看一眼。
2026-09-18 抽出来时已对比截图确认 2.1 外观逐字未变。

⚠️ `runAccountClassification` 的 `fetchProgressMessage` 是**必填**参数：helper 只处理单个账号，
编不出 2.1 的「第 N/M 个账号」序号；若让调用方自己 `setProgress`，helper 的第一句会立刻覆盖它。
两条进度都经 `onProgress` 发出，所以 2.1 的文案才能逐字不变。

⚠️ **来源说明必须如实区分**：报告里 `contentPositioning.classification.source` 会随
`classificationSource`（`fresh` / `reused`）变化。新账号那条路写「本次运行中先跑了一次分类分析
（未落库）」，复用时才写「复用模块 3 的 2.1 分类分析产出」。
前端在 analyze 时把 `freshInput ? "fresh" : "reused"` 传给端点，两套后端都透传这个字段。

#### (f) 导出 Word（2026-09-18）

1.2 报告除「复制 Markdown」外，还能**导出真正的 .docx**。

**实现方式是零依赖手写**（`src/app/docx.ts`）：项目里没有 jszip / docx / file-saver，
而 §6.5㉖ 记着本机装包出过问题。但 .docx 本质就是 zip + 几个 XML，zip 条目用
**STORE（不压缩）** 时只需要 CRC32 + 字节拼装 —— 纯 JS 就能写，浏览器也不需要 zlib。

⚠️ **刻意没走「HTML 改名成 .doc」那条捷径**：Word 会弹「文件格式与扩展名不匹配」，
对非技术用户很像中毒；而且拿到的不是 Word 原生文档，标题级别与表格都不是真的。

⚠️ **两份导出（Markdown / Word）刻意互为镜像，改一个必须改另一个。**
`benchmarkProfileToDocxBlocks`（Word）与 `formatBenchmarkProfileMarkdown`（Markdown）
在 `benchmarkProfile.ts` 里相邻，函数上方有注释钉着这条。

⚠️ **老报告可能整段缺 `sampleWindow` / `account`**，deep 访问必须用可选链。
2026-09-18 就踩过：docx 版少了 `?.` 会直接 **TypeError**，用户点「导出 Word」就失败
（Markdown 版更早也导出过「分类样本：undefined 条」）。两处现在都有兜底。

**验证方式**（改 `docx.ts` 或那份映射后照做）—— 光看构建通过不算数：

```bash
# 1) 是不是合法 zip、CRC 对不对
file <x>.docx                      # 期望：Microsoft Word 2007+
unzip -l <x>.docx                  # 期望：5 个 part 齐全
python3 -c "import zipfile;print(zipfile.ZipFile('<x>.docx').testzip())"   # 期望 None
# 2) ★ 用真实的 Word 格式解析器读一遍（macOS 自带）
textutil -convert txt <x>.docx -output <x>.txt
```
`textutil` 能转出来、且文本里有各段标题与真实取值，才算真的可用。
另外务必确认抽出文本里**没有 `undefined` 泄漏**。

---

### 3.6 模块 2 账号规划（1.3）✅ 前端 + 后端全部完成（2026-09-18 实现，2026-09-20 回写状态）

**批次划分**（用户 2026-09-18 定）：第一批 = 一、IP定位 + 二、账号搭建 + 三、视频选题库；
第二批 = 四、短视频内容框架 + 五、拍摄与剪辑建议 + 六、起号与运营。**两批均已完成，前后端都已接线。**

⚠️ **本节的「前端状态」曾经写着「进行中 / `available` 仍是 `false`」，那是滞后的** ——
实际早已完成（见本节末）。**不要照那段旧描述把它重新实现一遍。**

⚠️ **第二批是「同一份报告从 3 节扩到 6 节」，不是第二份报告** ——
`ACCOUNT_PLAN_SECTIONS` 6 项、`ACCOUNT_PLAN_BATCH = 2`，仍然一个 store / 一个端点 / 一个前端阶段。
**旧的 batch-1 报告必须还能渲染**（四/五/六 全部可选，前端一律 `?.` + `|| []` 兜底）。

#### 第二批的三条诚实性要求（已实现，别改掉）

1. **五、拍摄与剪辑建议最多 `inference`** —— 1.2 报告里没有任何「该账号实际怎么拍/怎么剪」的数据，
   所以这 9 项是**建议而非观测**，界面上明确写着这句话，且**宁可全部留空也不自动补一套通用话术**。
2. **六 的「起号策略 4 步」与「数据复盘 4 维」是行业通用模板**（固定文本、后端写死、带 `template` 标记），
   并在界面上声明「固定文本，后端写死」；只有「平台与矩阵策略」「内容配比」才是按本客户生成的。
3. **内容配比由后端按 1.2 报告里真实存在的大类重算**，每个时期合计恰好 100，
   大类对不上的丢弃并计数 —— 不许模型发明大类、不许采信它填的百分比。

⚠️ **一个架构注意点**：`api/_lib/accountPlan.js` 引入了 `ipProfileStore.js`（内含 mongodb），
所以**它不能被前端 bundle 引用**。做渲染验证时必须在 Node 侧跑真实归一化、把报告导成 JSON 再喂给预览 ——
直接把后端模块 import 进预览会让页面**整页白屏**（无报错框，因为模块级就崩了）。

**后端已完成并实测**（前端同样已完成，见本节末）：

| 文件 | 作用 |
|---|---|
| `api/_lib/ipProfileStore.js` | ★ 客户名册读取层（`customers.ipProfile`）+ `IP_PROFILE_GROUPS`（3 组 19 字段的**唯一来源**） |
| `api/customers.ts` | 客户列表 / 详情（manager-only，**不按 managerId 过滤**） |
| `api/_lib/accountPlan.js` | ★ 1.3 核心：输入组装 / 证据分级 / 后端重算 / 兜底 |
| `api/_lib/accountPlanStore.js` | 第 5 个同构报告 store，集合 `account_plan_reports` |
| `api/agent/account-plan.ts` | 只有 `analyze` 阶段（不需要转写与评论） |
| `api/account-plan-reports/index.ts` | 报告 CRUD |

路由：`server/index.js` 5 条 + `vercel.json` 3 条，两套已同构。

**报告形状**：`ipPositioning{businessPositioning{targetAudience,audienceDimensions,corePain,contentDirections,monetization}, contentPositioning{core,classification(透传1.2),frequentTags}, personaPositioning{role,personality,memoryAnchors}}`
/ `accountSetup{trio,bio}` / `topicLibrary{methods[3]}` / `missingInputs` / `dataCoverage`。

#### ✅ 三个取舍**均已拍板并实现**（2026-09-20 回写；此前本节误记为「待用户拍板」）

> ⚠️ 下面三条**不用再问用户了**，代码与测试都已经是决定后的样子。

1. **`customer.context` 能否支撑 `evidence` → 已放宽。**
   客户名册的补充说明（`ipPositioning` / `contentNeeds` / `notes`）**算客户方一手输入**：
   只要写了补充说明，相关字段的证据上限就抬到 `evidence`，再由引文核对把关
   （「自称 evidence 却给不出可核对引文 → 降级 inference」，与 §6.3⑭ 同一条原则）。
   - ⚠️ **保留的另一半不能删**：客户记录里连一句补充说明都没有时（实测 1/5 的客户连名册都是空的），
     唯一能引的只剩 1.2 报告，而 1.2 报告讲的是**那个对标账号** —— 此时年龄 / 性别 / 收入
     这类结论**仍然最多 `inference`**。这条上限真正防的是「拿对标账号的东西冒充客户自己的事实」。
   - ⚠️ `benchmarkAccounts` **不算一手说明** —— 它只是一串对标账号链接，只用来填方法一(a)。
   - 实现在 `api/_lib/accountPlan.js` 的 `hasCustomerBrief` / `capOf`；
     测试见 `tests/account-plan.test.mjs` 的「客户名册的补充说明是一手输入…」与
     「客户方一手输入一个字都没有…」两条。
2. **方法一(a)「同赛道对标账号」→ 已改用客户档案登记的 `customers.benchmarkAccounts`。**
   实测 5 个客户里有 3 个填了，不再是恒 `manual`。
3. **6 个助手函数重复的债 → 已还清。** 已抽出 **`api/_lib/evidence.js`**，1.2 与 1.3 共用。
   - ⚠️ 注意里面 **`asNumber`（不取整）与 `asCount`（取整）是刻意分开的两个函数**：
     1.2 要读 `33.3%` 这种真实小数，一取整报告里的占比就和分类报告对不上了；
     1.3 数的是选题条数 / 步数，取整才对。**合掉任何一个都会改变另一边的报告数字。**
   - ⚠️ `buildEvidenceHaystack`（证据全文索引）**刻意没有抽到一起**：1.2 取材于账号简介 /
     视频文案 / 评论 / 分类，1.3 取材于客户档案 / 访谈原文 / 1.2 报告 —— 输入域不同，
     硬合并只会变成到处判空的分支堆。共用的只有 `joinEvidenceParts`（拼接 → 去标点）。

#### 验证（实测）

```bash
node scripts/verify-server-routes.mjs     # 37 passed / 0 failed（2026-09-20 复核实测）
npm test                                  # 247 passed / 0 failed
npm run build                             # 成功
```

> ⚠️ 本行原写「32 passed」。2026-09-20 复核时脚本已扩到 **37 条断言**
> （`scripts/verify-server-routes.mjs` 的 mtime 比 HANDOFF 还新，说明当时改完没回写文档）。
> 多出来的断言覆盖 1.3 报告的存 → 取 → 幂等 → 删、`/api/customers` 的 `hasProfile` 标记、
> 以及「缺 1.2 报告时返回 400」。

冒烟脚本已覆盖 1.3：客户列表/详情、`ipProfile` 字段全是字符串、
**Agent 失败时降级成规则兜底而不是 500**、`missingInputs` 存在、
**缺 1.2 报告时返回 400**（而不是硬出一份没有内容定位的报告）。
⚠️ 它跑在**临时库**上，所以要靠脚本里 seed 的那条客户数据 —— 否则 `/api/customers` 只会返回空数组、断言等于没验。

#### ✅ 冒烟脚本曾不稳定 —— 已定位并修复（2026-09-18，值得一读）

`scripts/verify-server-routes.mjs` 一度频繁失败，症状极具误导性：**邀请码文档明明存在、
未使用、`bcrypt.compare` 也返回 `true`，服务端却报「邀请码无效或已失效」403**，
随后所有断言因 401 连锁失败。我为此排查了很久，**根因是这个脚本自己**：

> 临时库名当时是**硬编码**的 `xiaomang_verify_tmp_routes`。
> 我在排查时反复跑它，而另一个进程（子代理）也在跑同一个脚本 ——
> **两个进程共用一个库，各自的 `dropDatabase()` 会把对方运行中途种下的
> 邀请码 / 用户清掉。**

于是出现了「数据看起来完好、逻辑也对、却校验不过」这种最费时间的形态 ——
因为**共享状态被第三方清空**，怎么看都不像环境问题。

**修法（两条都必须有）**：
1. **每次运行用唯一的库名**：`` `xmverify_${pid.toString(36)}${Date.now().toString(36)}` ``。
   ⚠️ MongoDB 库名上限 **38 字节**，拼太长会直接报 `Database name ... is too long`（也踩过）。
2. **不在开头 `dropDatabase()`**：改为只清本脚本用 `SEED_TAG` 标记的数据 ——
   上一轮的 server 连接可能还没释放，在别人连着时删库重建会让它读到中间态。
   收尾的 `dropDatabase()` 保留（那时 server 已死）。

另外当时 8797 端口上还挂着一个**更早的旧 server 进程**（路由表里没有新端点，会 404），也要记得 kill。

修完**连续三次 32/32**。

**教训**：这个脚本会往真实集群上建临时库，**并发跑会互相踩**。同一时间只跑一个。

#### 🔴 「结合 60 条视频基础数据」——2026-09-18 修掉一处不符

用户明确：1.3 除「内容定位」直接复用 1.2 外，其余部分要**结合 IP 信息 + 之前抓取的
60 条视频的基础数据**重新分析。

原实现把 `buildAccountPlanInput` 里的选题压成了**纯标题**
（`topics: sub.topics.map(topic => topic.title)`）—— **每条视频的互动数据
（点赞/评论/转发/收藏）在送模型前被丢掉了**，模型无法判断「这个大类里哪类选题更跑得动」，
而选题库与商业定位恰恰依赖这个判断。**已改为带上 `stats`**（链接仍不送：模型用不上
且白占 token；报告输出里链接与 stats 一直都完整保留，界面不受影响）。

**别再把它改回只给标题。**

#### 前端状态 ✅ **已完成**（2026-09-20 回写；此前本节误记为「进行中」）

`src/app/accountPlan.ts`（类型与导出层）与 `AccountPlanStage.tsx` **均已创建**，
三处接线（`reportApi.ts` / `accountPositioningModules.ts` / `AccountPositioningPage.tsx`）**全部完成**：

- `accountPositioningModules.ts` 里 `account-plan` 的 `available` **已经是 `true`**；
  `code: "1.3"`、`steps: []`（单体模块，选中时**不展开** 2.1/2.2/2.3 子步骤轨道）。
- `AccountPositioningPage.tsx` 已 import 并挂载 `AccountPlanStage`，
  保存成功后用 `markCompleted(ACCOUNT_PLAN_MODULE_ID)` 把卡片标成「已完成」。
- 渲染已截图确认：`.preview-shots/acctpos-13-batch2.png`（六节报告，2026-09-18 16:42）。

⚠️ **不要再按旧描述把它当「接线未完成」而重新实现一遍。**
⚠️ 已知小瑕疵：`accountPositioningModules.ts` 里 `account-plan` 的 `reuses` 文案
写成了「复用「选题库构建」的产出」，但 1.3 的直接输入是**客户 IP 档案 + 1.2 的报告**
（它的 `inputs` 写对了）。见 §4.3 第 6 条。

---

### 3.7 员工「临时分析」入口（不关联客户）✅ 2026-09-20 新增

> ⚠️ **这一节不在「账号定位」板块里** —— 它属于**员工端工作流**。
> 放在这里只是因为它也是本次新增的已完成能力。

#### (a) 解决什么问题

员工的入口原本**只有一条**：`/`（今日任务）→ 点项目经理布置的任务卡 →
写 `sessionStorage.contentTasks` → 跳 `/topics`。任务由项目经理创建、**绑定客户**。

于是「员工要分析一个**不属于任何客户**的对标账号」这种情况**走不通**：
没有任务时，空状态写着「任务中心同步后，新任务会出现在这里」，**没有任何出口**。

#### (b) 关键事实：下游**本来就不依赖任务** ★

**这一条决定了整个方案的形状，别搞反了。** 排查结论：

| 位置 | 实际行为 |
|---|---|
| `App.tsx` (`/topics`) | 没任务时左侧只显示「暂无待处理任务」，**页面其余部分照常渲染，不阻断** |
| `App.tsx` 的抓取区 | 「博主主页分享链接」本来就是**自由文本框**，与任务无关 |
| `ContentPage.tsx` (`/content`) | 全是 `activeTask?.x \|\| "未提供"`，没任务也能跑 |
| `ContentPage.tsx` / `App.tsx` | `bitableTaskKey` 有 `"default"` 兜底、`contentAutoRunKey` 有 `"task"` 兜底 |
| `/api/tikhub/batch` | **无角色限制**，员工本来就能调（只有 `comments` / `fans-portrait` 是 manager-only） |

**结论：不需要新的分析链路，缺的只是一扇门。** 所以实现方式是「补一个入口 +
合成一个形状与真实任务一致的伪任务」，而不是复制一套流程。

#### (c) 实现方式

入口在**今日任务页**（`TodayTasksPage.tsx`）：

1. 卡片头部常驻次要按钮「**+ 临时分析对标账号**」，空状态里另有主按钮「分析一个对标账号」；
2. 点开**就地展开**一个小表单（不用弹窗）：平台（抖音/视频号/TikTok）+ 对标账号链接
   （必填；视频号那一路填的是**账号名称**，所以不校验 URL）+ 项目名（选填）；
3. `POST /api/adhoc-analyses` 落库 → 立刻合成伪任务并进 `/topics`：
   `{ _id: "adhoc-<记录 id>", customerName: 项目名, platformName, benchmarkAccounts, ... }`；
4. 因为现有 effect 会读 `activeTask.benchmarkAccounts`，**链接会被自动预填进抓取框** ——
   员工进来点「开始抓取」即可；
5. 今日任务页下方多一块「**我的临时分析**」，可继续分析 / 删除。

6. **进 `/topics` 后自动开始抓取**（2026-09-20 追加，省掉「还得再点一次开始获取」）：

- `openAdhoc(item, { autoFetch: true })` 写下 `topicsAutoFetchKey`，`App.tsx` 一个 effect
  消费一次就记 `topicsAutoFetchConsumedKey`（与 `ContentPage` 的 `contentAutoRunKey` /
  `...ConsumedKey` 同一套惯例）。
- ⚠️ **只有「新建」这条路带 `autoFetch`**。从「我的临时分析」点「继续分析」重进时**不带** ——
  否则每次回看旧记录都会重新花一次 TikHub 调用。
- ⚠️ **三条守卫缺一不可**，改动时别删：
  1. `topicsAutoFetchRef` —— 同一次挂载内只跑一次（deps 变化不重跑）；
  2. `topicsAutoFetchConsumedKey` —— **刷新 / 返回本页不重跑**。少了它每刷新一次就重抓一遍；
  3. `tikhubInput` 非空 —— 输入还没落地时不抓（否则会抓到上一轮的残留输入）。
- ⚠️ `openAdhoc` 会**同时把链接写进 `sessionStorage.tikhubInput`**，这样 `/topics` 的
  `tikhubInput` **首帧就是对的**，不必等那边「从任务预填」的 effect 跑完 ——
  守卫 3 依赖这一点。
- ⚠️ **视频号那条路上，自动抓取只能推进到「请选择每个视频号名称对应的正确账号」就停下**：
  `runTikhubFetch` 需要用户从候选里选定账号，这一步没法也不该替他做。
  抖音 / TikTok 没有这个中间态，会一路抓完。
- `enterWorkspace` 会一并清掉这两个 key，避免上一次的 key 让下一次被误判成「已消费」。

⚠️ **平台必须显式锁定**：清场时按 `openTask` 同一批 key 清掉 `sourcePlatform` 之后，
再写回员工选的那个并置 `sourcePlatformUserLocked=1`。不锁的话 `App.tsx` 的
`inferDefaultPlatform` **只认「视频号 / 微信」**，**TikTok 会被静默推成抖音**。

⚠️ `_id` 的 **`adhoc-` 前缀是唯一的判别点**（`App.tsx` 的 `isAdhocTask`）。
`/topics` 左侧据此显示徽章「临时分析 · 未关联客户」，免得员工把它当成某个客户。

#### (d) 🔴 隔离口径：**员工私有**（本项目第三种隔离）

| 数据 | 隔离方式 |
|---|---|
| 报告类（分类/三秒/结尾/1.2/1.3） | 按 `managerId` |
| `customers` 客户名册 | **不隔离**（公司共用） |
| **`adhoc_analyses` 临时分析** | **按 `userId`，员工私有** |

- 集合 `adhoc_analyses`，文档 `{ _id, userId, title, benchmarkAccounts, platform, createdAt }`；
- **读、写、删都必须带 `userId` 过滤**，删除时 `userId` 必须进 filter ——
  否则记录 id 就是**跨员工读写/删除**的入口（同 §6.2⑥ 的原则，主体从 manager 换成 employee）；
- 端点用 `requireEmployee`：**项目经理调用一律 403**，看不到员工的临时分析；
- 它**不是任务**：不写回 `tasks` 集合，也不参与今日任务那三个计数。

#### (e) 文件

| 文件 | 作用 |
|---|---|
| `api/_lib/adhocAnalysisStore.js` | ★ store + `ADHOC_PLATFORMS`（平台枚举唯一来源）+ **纯函数** `normalizeAdhocInput` |
| `api/adhoc-analyses/index.ts` | 端点：GET 列表 / POST 新建 / DELETE 删除（员工专用） |
| `src/app/TodayTasksPage.tsx` | 入口表单 + 「我的临时分析」列表 + 伪任务合成（`enterWorkspace` / `openAdhoc`） |
| `src/app/App.tsx` | `isAdhocTask` + 左侧面板的「临时分析 · 未关联客户」徽章 |
| `tests/adhoc-analyses.test.mjs` | `normalizeAdhocInput` 的边界测试（9 条，**不需要 MongoDB**） |

路由三处已同步：`server/index.js`（3 条）、`api/adhoc-analyses/index.ts`、`vercel.json`（functions）。

⚠️ `normalizeAdhocInput` **刻意保留换行**（只逐行 trim + 丢空行）：它会被预填进 `/topics`
的抓取框，而那边按行/逗号解析；把换行压成空格 = 多账号静默变成一个乱码账号。**有测试守住。**
⚠️ 前端的平台清单是从后端 `ADHOC_PLATFORMS` **镜像**的一份（后端 .js 引了 mongodb，
不能进前端 bundle，见 §3.6 的架构注意点）。**改平台要两处一起改。**

#### (f) 验证（实测）

```bash
npm test                                # 256 passed（原 247 + 本功能 9 条）
node scripts/verify-server-routes.mjs   # 52 passed（原 37 + 本功能 15 条）
```

冒烟脚本新增覆盖：**项目经理访问 403**、员工初始列表为空、**空输入返回 400 且原因可读**、
创建 201 + `platformLabel`、**多行链接保留换行**、★**员工 B 看不到 A 的记录**、
★**员工 B 用 A 的 id 删除得 404 且 A 的记录还在**、自删 200 后查不到。
⚠️ 为此脚本用 `insertMany` **直接种了两个员工**（`employees` 集合）—— 员工**没有注册端点**。

渲染已截图确认（脚手架用完已删）：`.preview-shots/adhoc-{empty,form,list,topics}.png`。
其中 `adhoc-topics.png` 证明了**链接自动预填 + 平台锁定 + 徽章**三件事都生效。

**自动抓取用探针客观验过**（不是靠肉眼看截图）：脚手架把所有 `fetch` 记进 `window.__calls`、
再写进 `#probe`，用 `--dump-dom` 断言调用次数。三个模式的结果：

| 模式 | 场景 | `POST /api/tikhub/batch` 次数 | 结论 |
|---|---|---|---|
| `auto` | 刚**新建**（带 key） | **2** | ✅ 自动抓了；2 次 = **两个对标账号各一次**，不是重复触发 |
| `nokey` | 从列表「继续分析」重进 | **0** | ✅ 不会因为回看旧记录而重新花钱 |
| `consumed` | 自动抓过之后**刷新页面** | **0** | ✅ 刷新不重抓（这条最关键，每次抓取都是真金白银） |

截图 `.preview-shots/adhoc-autofetch.png` 是自动抓取**跑完之后**的状态：
面板已显示抓取结果（`作者 / sec_user_id / 作品数量`），说明确实自动发出了请求并回填了 UI。

#### (g) 已知未做 / 待确认

1. **成稿不会进客户的多维表格**？ —— 目前**没有做这个限制**。`ContentPage` 的
   「绑定多维表格」是员工手动触发、自己选目标的，所以不违反「仅自己可见」，
   但如果你要求临时分析的成稿**绝对不能**进公司表，需要在 `bitableTaskKey` /
   `bindNewBitable` 那两处按 `isAdhocTask` 拦一下（**当时没做，等你确认口径**）。
2. **今日任务页顶部那句介绍文案**仍是「选择一个客户任务，开始生成今天值得做的选题。」——
   现在有了第二条路径，这句话略不准确；但 §6.4⑳ 的规矩是**页面级介绍文字要删不要加**，
   所以**没有擅自改**，等你定。
3. **不做审计**：员工之间互相看不到，项目经理也看不到 —— 这是「仅员工自己可见」的必然结果。
   如果以后要「谁分析了哪个账号」可追溯，得另加一份可见性设计。
4. `ADHOC_LIST_LIMIT = 50`：列表只**截断返回**，**不删用户数据**（静默删数据比列表短更糟）。

---

## 4. 当前卡在哪 / 未完成

### 4.1 真实验收状态：转写链路已通过，其余仍未做

**✅ 已由用户实测通过（2026-09-17）**：

- **真实转写链路**（TikHub 解析 → 本地 ffmpeg 裁剪 → 豆包 ASR）在真实账号
  「胥子讲老板用工风险」的作品上跑通，用户确认**方案可行**。数据见 §4.4。

**🔴 仍未验收（下一会话应当请用户用自己的账号跑一次完整流程）**：

1. 真实对标账号链接 → 真实 TikHub 抓取 60 条
2. 真实 DeepSeek 分类分析 / 三秒分析
3. 分类报告 / 三秒报告保存到线上 MongoDB
4. **完整 60 条**的整批转写（优化后的数字是在 4 条 / 12 条样本上测的，60 条未实测）
5. 以项目经理身份在浏览器中检查完整结果页面的视觉效果
6. **1.2 与 1.3 的端到端同样都没做过**（§3.5(d)2）—— 两条链路的归一化、渲染、
   单测、冒烟都验证过，但**没有用真实账号 + 真实 DeepSeek 产出过一整份 1.2 / 1.3 报告**。
   1.3 更是只有单测 + 渲染截图（`.preview-shots/acctpos-13-batch2.png`），
   没有一次真实 Agent 跑完六节。

**注意：验证边界要分清。** 转写链路是**用脚本**（`scripts/transcript-bench.mjs`）验证的，
它直接调 `providers.js` / `goldThreeSecondTranscripts.js`，**没有走 HTTP 端点、没有走前端**。
所以「转写可行」不等于「2.2 端到端可行」。

### 4.2 未实现的功能

- ~~**模块 2 账号规划（1.3）**~~ —— ✅ **已完成**（见 §3.6），**不要再重新实现**
- ~~**正式选题库持久化与新视频标签流程**~~ —— ✅ **2026-09-21 已完成**（见 §0.1）。
  集合 `topic_libraries`、端点 `/api/topic-libraries`、前端 2.4 步骤均已实现并通过
  单测 / 路由冒烟 / 渲染验证；**只剩真实端到端验收**。
- 新选题生成、选题仓、发布仓和导出链路的后续改造
- **星图粉丝画像接口未接入**（1.2 用户画像的真实人口属性数据源，见 §3.5(c)）

### 4.3 已知但未处理的小问题

1. **前端不显示 Agent `warnings` 的真实内容**。后端 `report.warnings[0]` 里存了错误码和消息
   （分类/三秒都有），但前端是硬编码一句话。出问题只能翻 DevTools 的 Network 响应或
   MongoDB 里的 `warnings` 字段。
   **2026-09-18：1.2 已修** —— 降级告警条里会多一行「Agent 返回的错误：[CODE] message」。
   **2.1 / 2.2 / 2.3 仍未修**，同一句硬编码还在，建议照 1.2 的做法补上（排查 1.2 那次
   「分析 500」时就卡在这上面）。
2. **后端兜底那条 `catch` 里没有 `logger.error`**。只有 HTTP 层失败才有
   `external.request.error` 日志；`DEEPSEEK_EMPTY` 这类非 HTTP 错误在日志里不可见。
3. **`api/agent/gold-three-seconds.ts` 的 `maxDuration` 已改成 300s，本地 Express 无此限制** ——
   线上要留意平台的实际上限。

4. ✅ **裁剪 + 本地 ffmpeg 的崩溃（`write EPIPE`）—— 2026-09-17 已修复**

   **症状**：`clipSeconds > 0` 时 ffmpeg 提前退出 → `pipe` 仍往已关闭的 `child.stdin` 写 →
   **`write EPIPE` 无人监听 → 未捕获异常，进程直接挂掉**。修前同一条视频
   `clip=0` 正常、`clip=5` **2/2 必崩**。

   **根因（两处，缺一不可）**：
   - `inputStream.pipe(child.stdin)` 只监听了 `inputStream` 的 `error`。
     **Node 的 `pipe` 不会替调用方吞掉 destination 的 error**，没监听就是未捕获异常。
   - 下载完全没有「够了就停」的机制：`fetchMediaResponse` 只挂了 120s 超时 signal。

   **修法**（`providers.js`，三处配套，改一处不够）：
   - `extractAudioFromStream` 新增 `stopInput()`：解绑 → 销毁输入流 → 回调中止下载；
     在 `close` / `error` / 超时 / 输出超限**四条终止路径**上都要调用，
     且必须在 `finished = true` 之后，这样中止引发的流错误会被兜底忽略。
   - `child.stdin.on("error")` 吞掉 `EPIPE` / `ERR_STREAM_DESTROYED`（这是 ffmpeg 已退出的
     正常后果），其余 stdin 错误才记 `ffmpeg.stdin.error`。
   - `extractAudioFromFetchedMedia` 建 `AbortController`，把 signal 透传给
     `fetchMediaResponse`（后者用 `AbortSignal.any([timeout, external])` 合并），
     ffmpeg 一退出就 `abort()`。

   **回归验证**：原先 2/2 必崩的组合现在成功；`stdin错误 0`；进程存活。

5. ⚠️ **本地 ffmpeg 分支以前从不使用 fast-probe —— 已一并修正（仅裁剪路径）**

   ffmpeg 默认探测窗口是 `probesize 5MB / analyzeduration 5s`，对一条只要开头 5 秒的音频
   来说太重。现在**裁剪时**用 fast-probe，并在 `FFMPEG_EMPTY` / `FFMPEG_FAILED` 时**回退一次
   保守探测**（`shouldRetryFfmpegConservatively`），再不行才交给链上下一个 provider。
   **完整转写（员工二创）不加 fast-probe** —— 那边不能为了快冒丢音频流的风险。
   实测这一项把裁剪路径从 6823ms 压到 3821ms。

6. ✅ **模块 2 卡片的 `reuses` 文案写错了 —— 2026-09-21 已修**。
   原文案是「复用**「选题库构建」**的产出」（从 `benchmark-analysis` 那一条复制过来的），
   会让项目经理以为 1.3 直接吃模块 3 的产出。现已改为
   「复用「客户 IP 档案」与「对标账号分析」的产出」，与它自己的 `inputs` 一致。
   `accountPositioningModules.ts` 是模块结构的**唯一来源**，所以只改那一处。

---

### 4.4 转写性能实测基线（2026-09-17，真实账号「胥子讲老板用工风险」）

**这是目前唯一的真实性能数据，优化前先拿它当对照。** 复现：`node scripts/transcript-bench.mjs`
（只读真实库取链接，会真的调用 TikHub / 豆包，有成本）。

**① 库里已有的 18 条真实转写缓存**（`gold_three_second_transcripts`）：

```
平均 36.9 秒/条｜中位 35.1s｜最慢 118s｜18 条合计 11 分钟
16 条走 tikhub-ffmpeg+doubao-asr:wav（慢路径）
 2 条走 tikhub-music+doubao-asr:mp3 （9~10s，快路径）
```

**② 本次实测（4 条视频，分阶段）**：

| 视频 | mp3 直链 | 默认链路 | 本地ffmpeg·裁剪5s | 本地ffmpeg·完整 |
|---|---|---|---|---|
| 7574… | 有 | 5483ms（tikhub-music） | **2137ms** | 7049ms |
| 7559… | 有 | 6005ms（tikhub-music） | **2034ms** | 6868ms |
| 7686… | 无 | 12348ms（tikhub-ffmpeg） | **9085ms** | 19341ms |
| 7685… | 无 | 15432ms（tikhub-ffmpeg） | 💥 崩（见 §4.3.4） | 未跑 |

**③ 三个可复用的结论**：

- **TikHub 解析（resolve）是每条的固定成本：2.6~7.8s，平均 4.66s，1 次 API 调用。**
  它和执行是串行的。60 条在并发 3 下光解析就要 ≈93s。**这是最容易被忽略的一块。**
- **裁剪确实大幅压缩 ASR**：同一批音频，完整 → ASR 2.5~4.7s，裁剪 5s → ASR 0.6~0.8s（差 4~6 倍）。
  但**它省不掉下载**：同一条视频裁剪与完整都下载了 6.5MB（ffmpeg 退出后下载没有被中止，见 §4.3.4）。
- **本地 ffmpeg + 裁剪比 TikHub 快**（2.0s vs 5.5s 有直链时；9.1s vs 12.3~15.4s 无直链时）。
  所以「把本地 ffmpeg 提到链首」是有收益的 —— **但必须先修掉 §4.3.4 的崩溃。**

**④ 时间模型**：`总时长 ≈ (60 / 并发数) × 单条时长 + 请求轮数 × 请求开销`。
所以**决定总时长的是并发数**；而 `GOLD_TRANSCRIPT_BATCH_SIZE=3` 让 60 条要跑 20 轮，
每轮都要付一次鉴权 + 2 次进度查询 + 往返 —— 这个值还是裁剪之前定的，**该放大**。

**⑤ 优化结果（2026-09-17，全部实测；复现见 `scripts/transcript-bench.mjs`）**

分两组 A/B，各自隔离一件事：

```
A. provider 顺序 + 裁剪 + fast-probe（transcribeVideo，4 条）
   旧：8632ms/条（提取 2560 + ASR 4816）
   新：1667ms/条（提取  565 + ASR  883）                     → 5.2 倍

B. 批量设置（transcribeTargets 整批路径，12 条，**两组都已含 A 的改进**）
   旧设置 每批 3 条 + 不预取解析：4 轮｜39.8s｜3318ms/条
   新设置 每批 30 条 + 预取 8    ：1 轮｜18.1s｜1509ms/条      → 2.2 倍
```

**⑥ 关键实现细节（改动时别踩）**

- **解析预取必须「永不 reject」**：预算用尽时 worker 会提前收工，窗口里会有
  「已发起但没人 await」的条目。存裸 promise 的话一旦 reject 就是 unhandled rejection，
  会把进程带走。所以统一先 settle 成 `{ ok, value }` / `{ ok:false, error }`
  （`createResolvePrefetch`），**这条有回归测试**。
- **补位要等取件结束之后再补**：在 `take()` 里同步 `fill()` 的话，被取走但还在飞的条目
  不计入窗口，实际并发会变成 `windowSize + 在取件数`，窗口就不是硬上限了。**也有测试锁住。**
- 预取宽度由 `GOLD_TRANSCRIPT_RESOLVE_CONCURRENCY`（默认 8）控制，设 0 退回老行为。
- 批量大小由 `GOLD_TRANSCRIPT_BATCH_SIZE`（默认 30）控制。单条变慢时 240s 预算守卫会
  提前收尾并返回 partial progress，前端会接着驱动下一批，不会丢结果。

**⑦ 还剩的余量（没有实测，别当成已解决）**

- `GOLD_TRANSCRIPT_CONCURRENCY` 仍是 3。单条已降到 ~1.5s，再往上提要看 **Doubao ASR /
  TikHub 的限流阈值** —— 这个**没测过**。要提的话在真实账号上跑一次并观察 429：
  `apiRetryAttempts=2` 会把 429 变成「更慢但不报错」，只看界面看不出问题，要翻日志。
- 用户实测通过的是**转写链路**，不是 2.2 端到端（见 §4.1 的边界说明）。
- 「两段式流水线」（提取池 → 队列 → ASR 池）评估后**不建议做**：单条已 ~1.5s，
  边际收益小于复杂度成本。真要做，先拿 `scripts/transcript-bench.mjs` 量出提取与 ASR
  各占多少再决定。

---

## 5. 下一步计划

### 下一步①：~~实现正式选题库与新视频筛选~~ ✅ 2026-09-21 已完成

> **五个步骤全部完成**（模块 3 的 2.1/2.2/2.3/**2.4**、模块 1 的 1.2、模块 2 的 1.3）。
> **不要重新实现其中任何一个**，也不要再把 2.4 当成待办。实现口径与验证见 §0.1。

**当时确认下来的业务方向**（已落地，留档备查）：2.1～2.3 分析多个对标账号，按口播/演绎、
大类/小类构建正式库；**客户级**归属、多账号分类各自独立不合并、**人工点保存入库**；
新视频走「近 7 天/可选时间 → **点赞 > 100** → 完整脚本 → 库内大类/小类标签 → 可勾选列表」。

1. ~~核实报告、客户和任务的关联与权限~~ —— ✅ 已定为**客户级**：库按 `{managerId, customerId}`
   唯一，客户由用户在 2.4 里显式选择（`benchmark_reports` 里**本来没有客户字段**，不去反推）。
2. ~~补正式库保存/读取和来源追溯~~ —— ✅ `topic_libraries` + `/api/topic-libraries`；
   每个账号条目带 `sourceReportId` 指回 2.1 报告。
3. ~~接增量流程~~ —— ✅ 见 `TopicLibraryStage.tsx`；时间窗口复用 `topicTimeWindow`。
4. ~~单测、路由契约和 UI 验证~~ —— ✅ 268 单测 / 77 冒烟 / 无头渲染验证，见 §0.1。
   **仍未做的是真实链路验收**（下一步②）。

### 下一步②：真实端到端验收（§4.1）

**四个模块的链路、归一化、渲染、单测、冒烟都验证过了，但没有一条用真实账号 +
真实 DeepSeek 产出过完整报告。** 这是当前唯一能暴露真实 bug 的途径，按风险排序：

1. **2.1 分类分析** —— 真实抓 60 条 + 真实分析 + 报告落线上库。
   后面所有模块都依赖它，先打通这条。
2. **完整 60 条整批转写** —— 性能优化的数字只在 **4 条 / 12 条**样本上测过（§4.4⑤），
   60 条的真实耗时、以及是否触发上游限流（429）都未知。
   ⚠️ `apiRetryAttempts=2` 会把 429 变成「更慢但不报错」，只看界面看不出问题，要翻日志。
3. **1.2 / 1.3 端到端** —— 两条链路从没用真实数据跑出过一整份报告。

⚠️ 验证边界要分清：转写链路是**用脚本**（`scripts/transcript-bench.mjs`）验证的，
**没有走 HTTP 端点、没有走前端**。「转写可行」≠「2.2 端到端可行」。

### 存档：模块 2（1.3）的实现口径 ✅ 已完成，仅供查阅

> 本节原先写的是「1.3 待实现、实现前先向用户确认」—— **它已经实现完毕**（见 §3.6）。
> 下面保留的是「1.3 该读什么」的定论，改动 1.3 时按这个来，**不要重新调研**。

把外部客户/IP 档案与对标账号分析（1.2 的产出）结合，生成项目经理**可审核可修改**的账号规划。

需要读取并综合：

- **外部客户 / IP 档案** —— 🔴 **2026-09-18 实测定论，别再重新找**：
  它在 **`test` 库的 `customers` 集合、`ipProfile` 字段**里（数据库是同一个，不是另一个库；
  `ai-project-assistant` 库里只有 employees/invitecodes/projects/tasks，**没有客户档案**）。
  结构对应项目经理录入的《IP账号规划访谈信息采集清单》：

  | 清单章节 | `ipProfile` 字段 |
  |---|---|
  | 一、身份信息 | `identity.{name, age, mbti, personaContrast, occupation, yearsExperience, keyCases}` |
  | 二、产品信息 | `product.{businessModel, productType, priceRange, coreAdvantages}` |
  | 三、用户画像 | `userProfile.{gender, age, occupationIndustry, incomeLevel, consumptionHabits, consumptionScenarios, painPoints, goalsNeeds}` |
  | （附）访谈原文 | `interview.rawNotes`（实测 4150 字）+ `status: "confirmed"` |

  ⚠️ **数据很稀疏，别指望它总是有值**：5 个客户里**只有 1 个**有 `ipProfile`；
  那一个里 `userProfile` **8 项只有 `goalsNeeds`**，`identity` 只填了 name/occupation/keyCases，
  `product.priceRange` 为空。**字段为空就必须如实落「待人工补充」，绝不许编造**
  （年龄/性别/收入/定价尤其）。
  ⚠️ `customers` **没有 `ownerId`** —— 它是公司共用的客户名册，端点只做 manager-only，
  **不要按 managerId 过滤**（与其它集合的隔离规则不同）。
- **1.2 对标账号分析报告** —— 这是本模块的主要输入。集合 `benchmark_profile_reports`，
  读取走 `listBenchmarkProfileReports()` / `getBenchmarkProfileReport(id)`
  （前端见 `src/app/reportApi.ts`；本地 Express 与 Vercel 路由都已就绪）。
  内容：商业定位 / 用户画像（含**真实粉丝画像分布**与证据分级）/ 内容定位 / 高频标签 / 运营策略。
  **连同它的证据分级一起读**，不要把 `待人工补充` 当成结论。
  1.3 规格里多处写「模仿【对标账号分析】的 XX」—— 指的就是照这份报告的同名字段结构来生成。
- 对标账号简介、账号基础信息
- 后续可能需要的评论区、粉丝或平台画像数据

⚠️ **正式选题库是模块 3 的产出**，由 2.1/2.2/2.3 汇总而来（结构与链接规则已确认，绑定与保存契约仍需闭环，见 §0.1 /「下一步①」）。
模块 2 是**读取**输入来生成规划，**方向是单向的** —— 不要反过来把规划的结论写回选题库。

⚠️ 补一句准确的口径：1.3 的**直接**输入是「客户 IP 档案 + 1.2 的报告」，
其中 1.2 报告的 `contentPositioning.classification` 是从模块 3 的 2.1 透传过来的
（见 `buildClassificationPassthrough`）—— 所以 1.3 是**经 1.2 间接**用到模块 3。
（模块卡片的 `reuses` 文案目前写成「复用「选题库构建」的产出」，不够准确，见 §4.3 第 6 条。）

---

## 6. 绝对不要再踩的坑

### 6.1 业务语义（改了就是错）

**① 不要恢复「最近三个月」规则。**
本阶段要求是「获取**最新 60 条**视频」，不是最近三个月内的。
- 分类页面请求必须保持 `latestOnly: true`、`count: 60`。
- 旧的通用选题页仍可能用 `days` 做近期开窗 —— 那是**另一条旧业务链路**，
  不要为了本模块全局删除时间窗口逻辑。

**② 口播和演绎不能共用一套分类提示词。**
口播重点是标题关键词、文案重复词句、内容功能；演绎重点是场景、主角身份、
人物数量及关系/冲突。必须保留**两套独立 prompt 和接口语义**，
不能用笼统的「主题分类」提示词替代。

**③ ⚠️ 已作废（2026-09-17 用户修正）：「账号定位阶段不建立正式选题库」不再成立。**

模块 3 就叫**选题库构建**，2.1～2.3 的产出**就是要落成正式选题库**。

- 代码与文案里凡是写「不建立正式选题库」「不等于正式选题库」「不会改写正式选题库」的，
  都已在本次修正中改掉。**不要再改回去。**
- **仍然成立的部分**：`benchmark_reports` 里的**勾选**只标记研究重点样本，不等于选题库
  条目本身；**不要**因此去写员工今日任务或周选题配比 —— 那些仍属于选题仓 / 发布仓链路。
- **已确认与未决要分开**：两类库的层级、来源和链接规则已确认（§0.1）；保存触发、库绑定及跨账号分类整合尚未确定。
  实现前先问用户，**不要自行发明落库链路**。

**④ 不要把平台发布文案当成完整视频脚本。**
- 2.2 的转写能把真实口播拿回来，但**转写不是 100% 覆盖**：失败的样本会退回发布文案。
  判断依据是每条样本的 `openingSource`（`transcript` / `caption`）和界面上的来源徽章。
- 无法确认时标低置信度、用「待人工复核」。
- **不要补写输入中不存在的对白、场景、人物、剧情结果或引流话术。**

### 6.2 架构约束

**⑤ 本地 Express 和 Vercel Serverless 必须同步。**
业务逻辑放 `api/_lib/*.js` 共享层（两套自动生效）；路由层两边都要写。
新增端点时检查：`server/index.js`、`api/**`、`vercel.json` 的 `functions` 配置。

**⑥ 报告接口契约：列表只给元数据，正文按 id 取。**

| 请求 | 行为 |
|---|---|
| `GET /api/benchmark-reports` | 列表，**只返回元数据，不含 `report` 正文** |
| `GET /api/benchmark-reports?id=xxx` | 单份完整报告 |
| `POST /api/benchmark-reports` | 保存，**幂等** |
| `DELETE /api/benchmark-reports?id=xxx` | 删除 |

`gold-three-second-reports` 完全同构。前端统一走 `src/app/reportApi.ts`。

- **列表的 `serializeSummary` 不要加回 `report`。** 单份正文约 62 KB，12 份就是近 2 MB，
  而调用方只是想「挑一份」—— 这曾经让读历史卡好几秒。
- `selectedVideoIds` **要保留**，前端靠它恢复重点样本勾选。
- 按 id 取单份和删除**都必须带 `managerId` 过滤**，否则报告 id 会成为跨项目经理读写的入口。

**⑦ 保存幂等靠内容指纹** `sha256(JSON.stringify([report, selectedVideoIds]))`。
指纹**故意包含重点样本 id**：用户改了重点标记再保存，那是新版本应该新建；
只有整份提交完全一致（双击、刷新重提）才合并。**别简化成只 hash `report`**，那会吞掉正常的新版本。

**⑧ MongoDB 连接配置不要擅自改。**
读取方式固定为 `MONGODB_URI || MONGO_URI` + 可选 `MONGODB_DB_NAME`。
URI 必须以 `mongodb://` 或 `mongodb+srv://` 开头。
`MONGODB_DB_NAME` 为空时用连接串默认库（当前是 `test`，**有真实数据**）——
不要为新集合强制要求新的数据库名，也不要把完整 URI 误填到数据库名变量里。

**⑨ 报告只存选题引用，不重复存视频。**
大类/小类下的 `topics` 只存 `{ id, title }`，完整视频数据统一在 `report.videos`。
- **`report.videos` 必须保持完整**：2.2 要用 `sourceText`、`stats.likes`、`publishDate`。
  实测把 `sourceText` 也省掉只省 3 KB，却等于把功能砍了。
- 读取一律走 `resolveTopicVideo(entry, videos)`（`src/app/benchmarkAnalysis.ts`）——
  数据库里可能有旧形状（topics 里是完整对象）的报告，这个解析器两种都认。
- 收益：单份报告 146 KB → 62 KB。

**⑩ 阶段之间有草稿，内存直传。**
- `useStageDraft(key, initial)`（`src/app/stageDraft.ts`）用法同 `useState`，
  但同步一份到 `sessionStorage`。`AccountPositioningPage` 只渲染当前阶段，
  组件会被卸载重建 —— 用普通 `useState` 时「从第二步退回第一步」数据就没了。
- 已接草稿的：2.1 的输入/分析结果/勾选；2.2 的选中报告/分析结果；壳的阶段位置/已完成标记。
- **不要接草稿的**：`loading` / `progress` / `error` / `savedMessage` / `copied` / `saving` /
  `busyReportId` —— 瞬时状态跨阶段留着只会造成困惑。
- **退出登录会清草稿**（`clearWorkspaceState` 调 `clearStageDrafts`）。这条不能删，
  否则会把上一个人的分析结果带给下一个人。
- 写 `sessionStorage` 失败（配额、隐私模式）时静默降级成纯内存。
- 2.1 点「保存并进入黄金三秒分析」时会把**落库条目 + 完整正文**一起交给 2.2
  （`preselectedReport`），2.2 不再回头查库；只有用户从历史列表另选一份时才按 id 取。

### 6.3 Agent 输出必须做后端归一化（核心不变量）

**⑪ 不能直接把 DeepSeek 原始 JSON 展示给前端。必须：**
- 只接受输入中已有的视频 ID；丢弃不存在或重复的；
- **后端重新计算数量和比例，不信任 Agent 自己填的百分比**；
- 对未知类型、缺失字段、缺失样本标记为 `review`；
- 保留 `analysisSource` 和 `warnings`，让用户知道是 Agent 结果还是规则降级结果。

**⑫ 提示词里的维度清单只能从 `GOLD_THREE_SECOND_DIMENSIONS` 生成。**
不要在两处各写一份 —— 曾经提示词里写「反差」而别处写「需求」，用户直接发现了。
前端也**不另存一份定义**，直接用报告里的 `dimensions` 字段渲染。

**⑬ 「配比」由后端按条数统计，模型只给原因。**
每个大类的 ratio 用最大余额法保证**合计恰好 100**。
- 曾经让模型自己编每个大类的配比，模型不给时还会把**全局 top3 原样塞进每一个大类**，
  结果所有大类一模一样 —— 用户反馈「逻辑不太对」。
- 模型没给原因时 `reason` **留空字符串**，前端如实显示「待人工补充」——
  **不许编一句「出现频率较高」糊过去**。
- 「待人工复核」**永远不进配比**（它是人工待办队列，不是内容大类）。

**⑭ 不信模型自称引用了转写。**
`quotedFromTranscript` 会去掉空白标点后检查那句话是否真在转写原文里。
模型说「我引用了」但文案其实来自发布文案时，如实标 `caption` 并把置信度压到 low。
**这条有回归测试，别删。**

**⑮ `max_tokens` 是 393216，别调小。**
- 实测 DeepSeek 合法范围就是 `[1, 393216]`。
- 当前模型 `deepseek-flash` **是推理模型**，会返回 `reasoning_content`，
  而且**思考 token 计入 `max_tokens`**。代码只读 `message.content`。
- 上限给小了就会「思考吃满预算 → `content` 为空 → `DEEPSEEK_EMPTY` → 直接掉规则兜底」。
- 只是上限，模型正常结束不会真用到，调高不额外花钱。

**⑯ Agent 重试必须带时间预算。**
`runAgentWithRetry` 的 `AGENT_RETRY_BUDGET_MS`（默认 90000ms）不是可选项：
单次 HTTP 超时 120s，serverless `maxDuration` 也是有限的。没有预算守卫，
重试会把函数拖到被平台强杀，那样连规则兜底的报告都拿不到，**比直接降级更糟**。
转写批次同理（`GOLD_TRANSCRIPT_BUDGET_MS`）。
另外 `transcribeTargets` **每完成一条就立刻落库** —— 整批跑完才写的话，函数被杀这一批全白做。

**⑰ `getTranscriptProgress` 里失败的也算「已尝试」**（`attempted = ok + failed`）。
否则前端分批循环会永远卡在同一个失败视频上来回重试，转不出循环。

### 6.4 前端

**⑱ `StageShell` 的 `result` prop 必须自己判空，否则整页白屏。**

`StageShell` 用 `hasResult` 决定要不要渲染 `result`，**但这拦不住 `result` 的求值**：
JSX 属性值是在父组件渲染时就算出来的，等传到 `StageShell` 手里时，
里面的 `report.xxx` 早就执行过了。正确写法：

```tsx
result={
  report && (          // ← 这层判空不能删，别当成和 hasResult 重复
  <>
    ...{report.account.platformLabel}...
  </>
  )
}
```

2026-09-17 就是这样白屏的（黄金三秒阶段的 `report` 初始为 `null`）。
项目现在**已有 error boundary**（`src/app/ErrorBoundary.tsx`，包在 `src/main.tsx` 的
`<AuthProvider>` 外层），渲染期异常会显示成一张可读的错误卡片而不是白屏。
**但不要因为有它就省掉判空**：兜底卡片只是让故障可读，功能照样是坏的；
而且 error boundary **抓不到事件处理器和异步回调里抛出的异常**。

**⑲ 换维度/类型名时必须给查表加兜底。**
`typeTone[type] || UNKNOWN_TYPE_TONE`、`typeLabelOf(type)`。
直接查表会拿到 `undefined`，配色 class 拼成 `"undefined"` 就是渲染异常。
`LEGACY_TYPE_LABELS` 里保留了已废弃类型的显示名，让旧报告还能渲染。

**⑳ 界面保持清爽（用户明确要求）。**
> 「像这种小字就不需要设计上去了，之后也采用这样的原则，保持界面清爽干净。」
> 「只用删去刚刚我上传的两张图中的小标题，其他比如卡片UI中的可以不用删」

- **删**：页面顶部 h1 下面解释「本页是做什么的」的介绍段；阶段轨道/列表上方的导航小标题。
- **不要删**：卡片和面板内部的说明文字（输入提示、方法说明、取样规则、加载提示、
  卡片描述、待实现页说明、欢迎语）一律保留。
- **判断边界是位置（页面级 chrome vs 卡片内部），不是文字长短。**
  不要自作主张按「这句话有没有信息量」去扩大删除范围 —— 这样做过一次，被用户退回了。

**㉑ 保存/删除按钮必须有 in-flight 守卫。**
`saving` / `busyHistoryId` + `disabled`。用户实测双击产生过 4 条一模一样的记录
（两条相隔 30 毫秒，是人手点不出来的间隔）。

**㉒ 历史列表必须显示到秒**（`formatReportTime`）**并带重点样本数**。
同一天保存多份时只显示日期根本分不清哪份是哪份。

### 6.5 验证方法

**㉓ 不要伪造项目经理登录或外部服务成功。**
没有真实凭据时只能验证：页面路由和未登录保护、单元测试、构建和语法、可控的输入归一化。
**不能**通过伪造 cookie、虚构 MongoDB 数据或假装调用 TikHub/DeepSeek 来宣称端到端完成。

**㉔ 前端改动必须真的渲染出来看一眼。**
`npm run build` **不做类型检查**（就是 `vite build`），`npm test` **只覆盖数据层**。
2026-09-17 的黄金三秒白屏就是这样漏过去的 —— 构建和测试全绿，一进页面就崩。
**做法**：临时搭一个渲染真实组件的预览脚手架（只替换 `window.fetch` 那层），
用无头 Chrome 截图确认，**用完删干净**。这套做法在本会话用过很多次，很有效。

**㉕ 改两个 report store 或 transcript store 时，用临时库实测。**
`tests/` 里没有覆盖它们（需要真实 MongoDB，加进去会让 `npm test` 在没有数据库的环境失败）。
做法：先从真实库读一份报告当样本（只读），再 `process.env.MONGODB_DB_NAME = "xiaomang_verify_tmp"`
切到临时库跑写操作，断言幂等 / 越权 / 删除，最后 `dropDatabase()`。

**㉖ 不要用 `npx tsc` 作为默认验证命令。**
本项目没有直接可用的 `tsc` binary，且机器上 npm cache 曾出现权限问题。优先用：

```bash
npm test
npm run build
node --check server/index.js
node --check api/_lib/<相关文件>.js
```

不要因为 `npx` 的缓存权限错误误判业务代码失败。

**㉖b 🔴 改了 `server/index.js` 之后，必须跑路由冒烟测试。**

```bash
node scripts/verify-server-routes.mjs
```

`node --check` **只查语法**，`npm test` **完全不覆盖 `server/index.js`**（那里要真实 MongoDB，
加进单测会让没有数据库的环境挂掉，见 §6.5㉕）。所以「路由体里引用了未声明的变量」这类错误
**两边都拦不住** —— 2026-09-18 就翻车过一次：

给 1.2 加粉丝画像时，把 `/api/agent/benchmark-profile` 里的 `const warnings = []` 顺手删了，
**Express 版一跑到分析就 `warnings is not defined` → 500，而 Vercel 版是好的**（那边声明还在）。
两套后端就此不一致（§2.1 警告的正是这件事），而且它**掩盖了真正的错误**：Agent 调用失败时
本该优雅降级成规则兜底报告，结果 catch 里那句 `warnings.push` 自己先炸了，
用户只看到 500、看不到 Agent 为什么失败。

这个脚本真的把服务起起来、真的发 HTTP 请求，专打「失败降级」这类只有运行时才会走到的分支。
它只用一个**临时库**（跑完 `dropDatabase`），并把 DeepSeek 指向假 key 让 Agent 必失败
—— 不碰真实数据，也不消耗真实额度。已实测：把 `const warnings` 删掉后它报
`warnings is not defined` / 500，加回来 **21/21 全绿**。

它同时覆盖 **1.2 报告的「存 → 列表 → 按 id 读回 → 幂等 → 删除」** 全链路
（模块 2/1.3 要读这份报告，所以正文完整落库是硬需求，只测列表能应答证明不了）。
契约也在里面钉着：列表**只给元数据、不带正文**。

**㉗ 改 transcript store 时，迁移要连索引一起改。**
唯一索引从 `{managerId, videoId}` 扩成 `{managerId, videoId, scope}` 时，**必须 `dropIndex`
掉旧的那个** —— MongoDB 不会因为你建了新索引就放弃旧的唯一约束，旧索引在，同一视频的
第二份（tail）就写不进去。改完用临时库实测（§6.5㉕），别只跑单测。

**㉘ 不要参考旧版文档的 Git 信息。**
当前目录 `git status` 提示**不是 Git 工作树**。除非新会话重新验证，
否则不要声称已经提交、推送或位于某个分支。

**㉙ 「选择分类分析报告」列表可删除（2.2 / 2.3 都有）。**

- 删除入口与 2.1 的「已保存的分类报告」列表**同一套**：单击删除 + `busyClassificationId`
  in-flight 守卫（§6.4㉑）。**不要只在一边加**，也不要换成需要二次确认的弹窗 ——
  同一个破坏性动作在两个地方 UX 必须一致。
- **删掉的正好是当前选中那份时，必须同时清空选择**（`setSelectedClassificationId("")`
  + `setReport(null)`）。不清的话「开始分析」会拿着一份已经不存在的报告去跑。
- 后端 `DELETE /api/benchmark-reports?id=` 已经按 `managerId` 收口，不需要额外鉴权改动。


---

### 6.6 转写缓存（head / tail）

**㉚ ⚠️ 转写缓存必须带 `scope`：开头片段和结尾片段是两份数据。**

`gold_three_second_transcripts` 的唯一索引是 `{managerId, videoId, scope}`。
**读、写都必须显式传 scope**（`TRANSCRIPT_SCOPE_HEAD` / `TRANSCRIPT_SCOPE_TAIL`）。

- 2.2 黄金三秒用 `head`（开头 5 秒），2.3 结尾钩子用 `tail`（结尾 5 秒）。
- 实现 2.3 时发现的原始坑：索引只有 `{managerId, videoId}` 时，**2.3 写结尾转写会覆盖
  2.2 的开头转写**，之后 2.2 重跑会拿结尾文案去判断「开场 3 秒」—— 全程不报错，
  报告看起来完全正常。这是最难发现的那类错。
- 历史数据没有 `scope` 字段，`ensureIndexes` 会把它们补成 `head` 并**删掉旧的两字段唯一索引**
  （不删的话同一视频存不了第二份）。这段迁移**已在临时库实测过**（11 条断言）。
- 不传 scope 时默认按 `head` 读，保证老调用方兼容。

---

### 6.7 codegraph 使用（㉛）

**㉛ ⚠️ codegraph MCP 工具默认绑的是别的项目库，必须显式传 `projectPath`。**

2026-09-18 实测：不传 `projectPath` 时，MCP 返回的是**上一个占用此路径的项目**
（亚马逊 ERP 工作流）的旧图 —— 227 文件 / 2705 节点，目录里全是 `_backup/`、`evidence/`、
`replica/`、`test/`、`tmp/`，而**本项目的 `src/`、`api/` 一个都没有**。
症状是 `codegraph_search("AccountPositioning")` 返回 0 结果、`codegraph_files` 显示一棵
完全不认识的目录树。`.codegraph/daemon.log` 里能看到 daemon 在
`~/Desktop/xiaomang-main` → `归档项目/xiaomang-main` → `归档项目/xiaomang` 之间反复绑定。

**做法**：每次调用都带 `projectPath: "/Users/ypc/Desktop/归档项目/xiaomang"`，
这样拿到的是正确的图（2026-09-20 复核：**170 文件 / 3457 节点 / 7505 边**，
tsx + typescript + javascript —— 含 `src/` 与 `api/`）。
⚠️ 索引会落后于最新改动，用 CLI 同步即可（**CLI 的「当前项目」是对的，只有 MCP 绑错了**）：

```bash
codegraph status                 # Project 一行应当是本项目路径
codegraph sync                   # 同步最新改动（2026-09-20 实测可用：新增 28 / 改 13）
codegraph query "endingHooks"    # CLI 没有 search 子命令，是 query
```

---

## 7. 接手后的第一步

### 0. 确认你在正确的位置

```bash
pwd     # 应为 /Users/ypc/Desktop/归档项目/xiaomang
```

**这是合并后的唯一主开发目录**（git 仓库，20+ 提交）。
`../xiaomang2` 与 `../ai-project-assistant-main` 都是**合并前的旧副本，不要在上面开发**。

### 1. 读 §0.7（第八轮修复 + code review）

四项问题**全部已修**；§0.6 是它们的原始证据。
**唯一遗留的安全项：轮换 Atlas 密码**（本机库已是主库，Atlas 只是历史来源）。

### 2. 验收三步（在 `xiaomang` 目录跑）

```bash
npm test                      # 期望：366 passed / 0 failed
npm run build                 # 期望：成功（index-*.js + 5 个经理端 lazy chunk）
npm run verify:routes         # 期望：234 passed / 0 failed（需要本地 MongoDB + apps/server/.env）
```

⚠️ **注意 `.env` 的位置变了**：现在在 **`apps/server/.env`**，
不在项目根。所以从根目录跑脚本读不到 `MONGODB_URI`（这不是 bug，是 workspace 结构）。

### 3. 本项目的铁律（合并后仍然成立）

1. **后端改动优先改共享层**（`apps/server/api/_lib/**`）—— 两套后端自动同时生效；
   但注意合并后**路由层有三处**：`apps/server/src/index.js`（员工侧 + 账号定位）、
   `apps/server/src/manager/*`（经理端）、以及 `apps/server/api/**`（Vercel 端点）。
2. **前端改动必须 CDP 真渲染看一眼** —— `npm run build` **不做类型检查**、
   `npm test` **只覆盖数据层**。已经**两次**证明「全绿但页面崩」。
3. **改数据结构必须补一次真实读写**，不能只跑纯函数单测。
4. **`scope` 三态**（`head`/`tail`/`script`）不许吞、**「待人工复核」不进配比**、
   **配比换算由后端实算** —— 这三条是踩过坑钉住的（§0.0-F1、§0.2-G1/G2）。

### 4. 要懂业务结构

读 `apps/web/src/app/accountPositioningModules.ts`（★ 三模块结构的**唯一**来源）、
`AccountPositioningPage.tsx`、`GoldThreeSecondsStage.tsx`、`apps/server/api/_lib/goldThreeSeconds.js`。
要动 1.2 / 1.3，再读 `benchmarkProfile.js` 与 `accountPlan.js`
（★ 证据分级与后端实算，共用 `evidence.js`，**不要把「待人工补充」当成结论**）。

### 5. 不要重做已完成的东西

选题库（2.4）、大类配比二创（§0.2）、发布仓（§0.3）、1.3 账号规划（§3.6）、
员工临时分析入口（§3.7）、**架构合并本身（§0.6）** —— 全部已完成，别重做。

---

> ⚠️ **本节的数字是历史快照（第八轮），已经过期**：
> 最新基线与待办看 **§0.8**（`npm test` 382 / 冒烟 255 / 20 集合 226 文档）。
> 下面这段保留作「各模块完成到哪一步」的清单，**数字别照抄**。

## 8. 当前基线结论（第八轮快照）

```text
统一鉴权                                          已完成

模块 3  选题库构建（底座）                        ✅ 四个子步骤全部完成
  ├── 2.1 对标账号分类分析                        已完成
  ├── 2.2 黄金三秒分析                            已完成（含真实口播转写 + 按大类配比）
  │     └── 转写性能优化                          已完成并实测通过（§4.4）
  ├── 2.3 结尾钩子库分析                          已完成（尾部转写实测通过）
  └── 2.4 正式选题库与更新筛选                      ✅ 2026-09-21 实现（§0.1）
  产出：正式选题库                                客户级、多账号各自独立；已持久化（topic_libraries）

模块 1  对标账号分析（1.2）                       已完成（复用模块 3，见 §3.5）
模块 2  账号规划（1.3）                           ✅ 已完成（客户档案 + 1.2 的产出，见 §3.6）

员工端  临时分析入口（不关联客户）                 ✅ 已完成（员工私有数据，见 §3.7）

员工端  内容生成页（二创）                        ✅ 已完成
  └── 三秒 / 结尾钩子「按大类配比生成 10 条候选」   ✅ 2026-09-21 第六轮实现（§0.2）
      标题 agent                                    ⚠️ 保持原样（标题类型配比尚不存在，§0.2-B）

员工端  发布仓（封面 / 发布文案 / 发布标签）        ✅ 2026-09-21 第七轮实现（§0.3）
  ├── 3.1 封面（星辰API 真实出图 + 参考图编辑）      ✅ 已实现；⚠️ 未配密钥、未跑过真图
  ├── 3.2 发布文案（金句+互动 Agent；标题/3s 复用）  ✅ 已实现
  ├── 3.3 发布标签（账号恒定 + 选题配额）            ✅ 已实现（账号标签库持久化复用）
  └── 核查 / 飞书写入 / 导出                        ✅ 已从内容生成页搬到这里

员工端  最终文案编辑页                             ✅ 保留在最后一步

★ 架构合并（第八轮）                                ✅ 已完成并验证（§0.6 / §0.7）
  结构                                              一个 workspace：apps/web + apps/server + packages/shared
  鉴权                                              一套 /api/auth/login（users 先、employees 后，兼容明文与 bcrypt）
  经理端                                            挂在 /api/management/*，前后端双侧 role 守卫
  数据                                              已迁到本地 MongoDB（18 集合 / 225 文档），源库指纹已对账
  安全                                              git 历史明文凭据已清除 + 提交前扫描钩子
  ⚠️ 遗留                                           Atlas 密码未轮换（建议停用或更换）

账号规划（1.3）权限                                  ✅ 按客户对员工开放（§0.4）
  员工可读                                           ?customerId= 的列表与最新正文
  仍然 manager-only                                  按 id 读 / 列全部 / 保存 / 删除

★ 架构合并                                        ✅ 已执行（§0.6 审查）
  新工作目录                                       归档项目/xiaomang（git 仓库）
  代码合并                                          ✅ 完成并验证（单测/冒烟/构建/启动/鉴权）
  🔴 数据库迁移                                     ❌ 未执行（本地库为空 → 登录失败）
  🔴 出图密钥变量名不一致                            ❌ 未修（XINGCHEN_ vs XXCAPI_）
  🟠 经理端 API 冒烟覆盖                             ❌ 零覆盖（/api/management/*）
  🟠 git 历史含明文数据库密码                        ❌ 推远端前必须处理

合并后实测（归档项目/xiaomang）                    366 / 0 pass，冒烟 194 / 0，build 成功
合并前基线（本目录 xiaomang2）                     365 / 365 pass / 0 fail / 0 skipped
构建                                              npm run build 成功（本轮实测）
CDP 渲染验证                                       35 / 0（本轮实测）
冒烟（路由/端到端契约）                            234 / 0（含发布仓、权限边界、经理端 API、关键链路）
真实验收                                          转写链路 ✅ 已通过；**其余未做（§4.1）**，
                                                  含本轮的出图与三个新 Agent（§0.3-G）
新增任务（2.4）                                    ✅ 已实现：近 7 天/可选时间、点赞 > 100、
                                                  完整脚本（scope=script）、库内分类标签、勾选列表
本轮验证                                          单测 + CDP 真渲染（无真实 API 调用）
```

**🔴 下一会话先读 §0.5（架构合并方案）** —— 用户已明确「再做 3.1～3.2 功能之前，
先解决架构问题」，**主线是架构合并/数据库本地化，不是继续写功能**。
§0.5-G 有 4 个问题在等用户回答，**先问，别自己开工**。
如果用户只想先拿收益，**建议单独做 §0.5 的阶段 2（数据库本地化）**：
风险最小、做完延迟与不可达问题当场解决。

**不要再实现已完成的东西**：选题库、新视频筛选（2.4）、大类配比二创（§0.2）、
发布仓（§0.3）、1.3 账号规划（§3.6）、员工临时分析入口（§3.7）、
鉴权、IP 档案录入、分类报告 —— **全部已完成**，模块 3 的子步骤也别重写。

⚠️ 模块 3 的子步骤**共用**同一套转写机制与配比实现
（`stageSampleWindow.js` / `categoryTypeBreakdown.js` / `goldThreeSecondTranscripts.js`），
**新增子步骤时直接复用，不要另写一套**。转写缓存按 `(videoId, scope)` 存 ——
2.2 存开头片段（`head`）、2.3 存结尾片段（`tail`）、**2.4 存完整脚本（`script`）**，
**三者不能互相命中**（见 §6.6㉚）。
⚠️ 2.4 是**第一条完整转写链路**（`script` scope 不裁剪），§4.4 的性能基线是裁剪 5 秒测的，
**不能直接套用**；60 条完整转写是否超 `maxDuration: 300` 尚未验证。

⚠️ 模块 1（1.2）的三条诚实性不变量**已经延续到 1.3**（实现共用 `api/_lib/evidence.js`）：
证据分级（`evidence` / `inference` / `manual`）、人口属性不得无据标「输入证据」、
价格无依据就留空（见 §3.5(a)）。**改动 1.2 / 1.3 时这条口径不能松** ——
1.3 读 1.2 报告时，**不要把 `待人工补充` 当成已验证的结论**。
