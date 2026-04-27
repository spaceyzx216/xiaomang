# Component Inventory

## Frontend Pages

### `src/app/App.tsx`

- **Role:** 首页 / 选题页
- **Responsibilities:**
  - 获取任务上下文与鉴权参数
  - 展示推荐选题与 TikHub 解析结果
  - 维护已选话题和任务轮播
  - 跳转到内容生成页
- **Primary Dependencies:** `src/app/api.ts`, `carousel`, `card`, `checkbox`, `button`, `badge`

### `src/app/ContentPage.tsx`

- **Role:** 内容生成与处理中心
- **Responsibilities:**
  - 渲染工作流生成结果分组
  - 维护标题 / hooks / scripts 的勾选状态
  - 执行翻译与平台风格转写
  - 批量导出全部待处理草稿
  - 跳转最终编辑页
- **Primary Dependencies:** `src/app/api.ts`, `accordion`, `switch`, `button`, `card`

### `src/app/FinalEditorPage.tsx`

- **Role:** 最终文案编辑页
- **Responsibilities:**
  - 承接上一步勾选内容
  - 提供文本编辑区域
  - 保存临时草稿
  - 导出单份 Word / Excel
- **Primary Dependencies:** `src/app/api.ts`, `button`, `card`, `badge`

## Frontend Shared Modules

### `src/app/api.ts`

- **Role:** 前端 API 访问基础设施
- **Responsibilities:**
  - 计算代理前缀
  - 拼接 API URL
  - 统一处理非 JSON、HTML 错页和异常响应

### `src/app/components/ui/*`

- **Role:** 通用 UI 组件库
- **Notes:** 数量较多，但当前业务主流程实际高频使用的是 `button`, `card`, `checkbox`, `switch`, `accordion`, `carousel`, `badge`

## Backend Components

### `server/index.js`

- **Role:** 本地运行模式的主后端
- **Responsibilities:**
  - 环境变量加载
  - 第三方代理
  - SSE 透传
  - 文案文件存储

### `api/_lib/common.ts`

- **Role:** Serverless 公共工具
- **Responsibilities:**
  - 统一读取 env
  - 统一响应 JSON
  - 请求体解析
  - URL 规范化

### `api/_lib/draftStore.ts`

- **Role:** Serverless 草稿暂存层
- **Storage:** 内存 Map
- **Caveat:** 重启或多实例场景下不稳定

## API Handlers

### Content / AI

- `api/coze/workflow/stream-run.ts`
  - 流式工作流转发
- `api/coze/workflows/chat.ts`
  - 流式对话转发
- `api/tikhub/batch.ts`
  - 抖音链接批量解析

### Draft / Export

- `api/final-drafts/index.ts`
  - 查询、创建、清空草稿
- `api/final-drafts/[id].ts`
  - 删除单条草稿
- `api/export/word.ts`
  - 导出单份 Word
- `api/export/excel.ts`
  - 导出单份 CSV

## Deployment Assets

- `deploy/nginx.xiaomang.conf`
  - 线上静态资源与 Node 服务代理配置
- `deploy/go-live-checklist.md`
  - 上线验收、回滚与联调清单
