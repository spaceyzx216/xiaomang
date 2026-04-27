# Source Tree Analysis

## Top-Level Structure

```text
xiaomang/
├── src/                    # React 前端
├── api/                    # Serverless API 处理器
├── server/                 # 本地 Express 代理服务
├── deploy/                 # 部署与上线说明
├── _bmad/                  # BMad 配置
├── _bmad-output/           # BMad 生成文档
├── README.md
├── package.json
├── vite.config.ts
└── .env.example
```

## Annotated Directory Notes

### `src/`

- `main.tsx`
  负责 React 挂载与三条前端路由注册
- `app/App.tsx`
  首页，负责任务上下文读取、选题展示、Tikhub 链接解析与跳转到内容页
- `app/ContentPage.tsx`
  核心工作流页，负责 Coze 流式生成、翻译、平台转写、批量导出和进入最终编辑页
- `app/FinalEditorPage.tsx`
  最终文案编辑与单份导出页
- `app/api.ts`
  前端 API URL 归一化与 JSON 响应解析
- `app/components/ui/`
  本地封装的通用 UI 组件库，主要来自 Radix 风格组件封装
- `styles/`
  字体、主题与全局样式

### `server/`

- `index.js`
  本地代理服务入口，负责：
  - `/health` 健康检查
  - `/api/tikhub/batch` 链接批处理
  - `/api/coze/workflow/stream-run` Coze SSE 透传
  - `/api/final-drafts` 临时文案存取
- `.env.example`
  本地代理所需环境变量样例

### `api/`

- `_lib/common.ts`
  环境变量读取、请求体解析、统一 JSON 响应
- `_lib/draftStore.ts`
  Serverless 模式下的内存临时存储
- `coze/workflow/stream-run.ts`
  工作流流式转发
- `coze/workflows/chat.ts`
  对话式流式转发
- `tikhub/batch.ts`
  Tikhub 批量解析接口
- `final-drafts/*.ts`
  最终文案的增删查
- `export/*.ts`
  Word / Excel 导出接口

### `deploy/`

- `nginx.xiaomang.conf`
  生产环境静态站点与 Node 代理示例
- `go-live-checklist.md`
  上线联调和回滚核对项

## Notable Structural Observations

- 同一仓库里并存两套后端实现：`server/` 适合本地或传统服务器部署，`api/` 适合无服务部署
- 前端页面数量少，但 `ContentPage.tsx` 集中了承载大部分业务状态与流程控制
- 项目当前没有独立的 `docs/` 目录，部署与运行信息分散在 `README.md`、`deploy/` 和代码本身
- 当前未发现测试目录或 CI 配置，质量保障更多依赖人工联调

## Suggested Reading Order

1. `src/main.tsx`
2. `src/app/App.tsx`
3. `src/app/ContentPage.tsx`
4. `src/app/FinalEditorPage.tsx`
5. `src/app/api.ts`
6. `server/index.js`
7. `api/` 下对应接口
8. `deploy/` 下部署配置
