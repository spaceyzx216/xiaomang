# xiaomang - Project Overview

**Date:** 2026-03-31
**Type:** web application
**Architecture:** 单仓单体 Web 应用，包含前端、Node 代理和 Serverless API

## Executive Summary

`xiaomang` 是一个内容生产工作台，主要服务于“选题筛选 -> 内容生成 -> 可选翻译/转写 -> 最终编辑导出”的运营流程。前端负责承接用户选择、流式展示 AI 生成结果和编辑导出；后端负责代理第三方能力、流式转发 Coze 输出、临时保存最终文案，以及在不同部署模式下提供等价接口。

## Project Classification

- **Repository Type:** monolith
- **Project Type(s):** web
- **Primary Language(s):** TypeScript, TSX, JavaScript
- **Architecture Pattern:** SPA + proxy backend + serverless compatibility layer

## Technology Stack Summary

| Layer | Technology | Notes |
| --- | --- | --- |
| Frontend | React 18, React Router 7, Vite 6 | 单页应用，3 个主路由 |
| UI | Tailwind CSS 4, Radix UI, lucide-react, MUI | 以本地封装 UI 组件为主 |
| Backend (local) | Express 5, Node fetch, dotenv | 本地代理、SSE 转发、JSON 文件存储 |
| Backend (serverless) | Vercel-style API handlers | `api/` 目录提供与本地代理近似的接口 |
| External Services | Coze, Tikhub | 内容生成、翻译/转写、抖音链接解析 |
| Deployment | Nginx + Node process + static dist | 也可拆分为静态前端 + serverless API |

## Key Features

- 承接外部任务系统传入的任务与鉴权上下文
- 批量输入抖音链接并通过 Tikhub 拉取作者与视频信息
- 调用 Coze 工作流，流式生成标题、3 秒留存和二创文案
- 对选中的内容执行英文翻译
- 对选中的脚本执行平台风格转写，当前支持抖音、小红书、微信
- 进入最终文案编辑页，二次编辑后保存、导出 Word / Excel
- 支持批量导出全部待处理文案

## Architecture Highlights

- 前端通过 `sessionStorage` 在三个页面之间传递任务、选题、工作流结果和编辑结果，减少全局状态复杂度
- 本地开发模式使用 Vite 代理 `/api` 到 `server/index.js`
- 生产示例里，Nginx 把 `/tikhub-proxy/` 反向代理到 Node 服务，同时前端通过 `VITE_COZE_PROXY_BASE` 指向代理前缀
- `api/` 目录复刻了核心接口，方便迁移到 Serverless 平台
- Coze 的两类流式接口都被保留：`workflow/stream-run` 用于工作流，`workflows/chat` 用于对话式转写

## Development Overview

### Prerequisites

- Node.js 18+
- npm
- Coze / Tikhub 的可用凭证

### Getting Started

先安装依赖并配置环境变量，然后运行 `npm run dev:full`。前端默认走 `http://localhost:5173`，Vite 会把 `/api/*` 代理到本地 `8787` 端口的 Express 服务。

### Key Commands

- **Install:** `npm i`
- **Dev:** `npm run dev:full`
- **Build:** `npm run build`
- **Test:** 当前未配置

## Repository Structure

仓库分成四块：`src/` 放前端页面与 UI 组件，`server/` 是本地代理与文件落盘实现，`api/` 是面向部署平台的函数式接口，`deploy/` 存放 Nginx 示例和上线清单。整体是单仓，但包含两套后端运行方式。

## Documentation Map

For detailed information, see:

- [index.md](./index.md) - Master documentation index
- [architecture.md](./architecture.md) - Detailed architecture
- [source-tree-analysis.md](./source-tree-analysis.md) - Directory structure
- [development-guide.md](./development-guide.md) - Development workflow

---

_Generated using BMAD Method `document-project` workflow_
