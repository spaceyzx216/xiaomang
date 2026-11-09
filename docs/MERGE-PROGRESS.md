# 系统合并进度

目标：统一一个 React SPA、一个 Express 服务、一个本地数据库，保留全部员工端与经理端业务；准备腾讯云部署。

> **状态：✅ 合并已完成并验证（2026-09-22）。**
> 最新交接文档见根目录 [`../HANDOFF.md`](../HANDOFF.md)（§0.7 是修复结果与 code review）。
> 本文件保留为**合并过程记录**，下面的「必须闭环」清单已逐项标注结果。

## 已完成

- 原项目全量备份：`../xiaomang-merge-backups/20260922-165556`，含校验值 `manifest.json`。
- 新工作目录：`../xiaomang`，保留经理站 Git 历史（以它为基座）。
- 拆分 `apps/web` 与 `apps/server`；经理站页面、路由、模型均已转换并**接入运行**。
- 前端入口是 `apps/web/src/main.tsx`；统一路由：`/manager/*`（经理端）+
  `/topics`·`/content`·`/publish-warehouse`·`/final-editor`（员工侧）。
- **数据库已迁移**：线上 Atlas → 本地 MongoDB（Docker `xiaomang-local-mongo-1`，`127.0.0.1:27018`）。
  18 集合 / 225 文档；逐集合 sha256 对账通过；**2 个明文密码已 bcrypt 化**。
- 部署栈：`Dockerfile`（多阶段、ffmpeg、非 root、tini）、`deploy/compose.yml` +
  `compose.local.yml` + `nginx.conf` + `backup.sh` / `restore.sh` + `mongo-init.js`。
- 安全：git 历史里的明文数据库凭据已用 `git filter-repo` 清除；新增提交前扫描钩子
  （`core.hooksPath=.githooks`）。

## 必须闭环 —— 逐项结果

- ✅ **数据库目标**：本地 MongoDB（已迁移完成，源库只读）。
- ✅ **经理站 CJS/Mongoose → ESM/原生 MongoDB**：6 个 model 改写完成，
  `enum` / 必填 / 状态校验全部保留；`account` 唯一性冲突仍返回 409。
- ✅ **统一鉴权**：一套 `/api/auth/login`（先查 `users` 再查 `employees`，
  兼容 `passwordHash` 与明文 `password`）。
- ✅ **员工管理接口显式要求 manager**：`/api/management/*` 路由器首行即 role 守卫，
  前端 `managed()` 亦包 `RequireRole`。
- ✅ **员工密码写入改为 bcrypt**：`bcrypt.hash(..., 12)`；更新时 `$unset: { password: '' }`
  清掉历史明文；返回体经 `safeEmployeeProjection` 过滤，不外泄任何密码字段。
- ✅ **`taskStore` 聚合保留 `customerId`**：经理端 `normalizeTask` 不再丢弃它；
  员工端 `/api/tasks/today` 投影带上它。**冒烟已端到端钉住**
  「经理建任务 → 员工在今日任务读到 → customerId 一致」。
- ✅ **原有测试 / 路由验证**：`npm test` **366 / 0**；`npm run verify:routes` **234 / 0**。
- ⚠️ **`/api/customers` 列表契约冲突 —— 选择了「绕开」而不是「统一」**：
  员工/定位沿用 `/api/customers`（返回 `{ success, items }`），
  经理站走 `/api/management/customers`（返回数组）。两个前端各调各的、都能跑，
  但**响应风格并存是技术债**，将来统一 API 风格时要一起改。
- ⏳ **合并后浏览器验收**：仅做过服务端端到端（含临时库全链路 11 项）。
  **真实浏览器的双端 UI 验收还没做** —— 建议下一步补。
- ⏳ **腾讯云部署说明**：`deploy/` 已有 compose 与脚本，但**上线与灰度切换尚未执行**。

## 遗留（唯一的安全项）

- 🔴 **Atlas 数据库密码未轮换**。历史里的凭据已清除，但**当前仍在使用同一个密码**。
  本机库已是主库、Atlas 只是历史来源，建议直接**停用或更换**那套凭据。
- `git filter-repo` 移除了原来的 `origin`（原指向经理站旧目录）。新增远端前请先决定指向哪里。
- `core.hooksPath` 是本地配置，**不随 clone 传播**；新克隆的机器需手动
  `git config core.hooksPath .githooks`（或加 `prepare` 脚本自动化）。
