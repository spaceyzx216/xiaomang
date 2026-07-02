# Development Guide

## Local Setup

### 1. Install dependencies

```bash
npm i
```

### 2. Configure environment variables

Root `.env`:

```bash
cp .env.example .env
```

Server `.env`:

```bash
cp server/.env.example server/.env
```

Minimum recommended variables:

- `PORT=8787`
- `TIKHUB_BASE_URL`
- `TIKHUB_API_TOKEN`
- `DEEPSEEK_API_KEY`
- `DOUBAO_API_KEY` or `DOUBAO_APP_KEY` / `DOUBAO_ACCESS_KEY`
- `VITE_API_PROXY_BASE=/tikhub-proxy` for reverse proxy deployment, or empty for same-origin `/api`

## Run Modes

### Full local development

```bash
npm run dev:full
```

This starts:

- `vite` on the frontend side
- `node server/index.js` on port `8787`

### Frontend only

```bash
npm run dev
```

Use this only when the required backend APIs are already reachable through your configured proxy base.

### Backend only

```bash
npm run server
```

## Build

```bash
npm run build
```

Build output goes to `dist/`.

## How Routing Works

- Browser routes:
  - `/`
  - `/content`
  - `/final-editor`
- Vite dev server proxies `/api/*` to `http://localhost:8787`
- Production Nginx uses `try_files` to fallback to `index.html`

## Session Storage Keys

The frontend uses `sessionStorage` heavily. Key keys include:

- `contentTasks`
- `selectedTopics`
- `selectedTopicIds`
- `tikhubInput`
- `tikhubResults`
- `contentWorkflowGroups`
- `contentActiveGroupIndex`
- `workflowRawDone`
- `finalDraftPayload`

Understanding these keys is useful when debugging cross-page behavior.

## Developer Notes

- `ContentPage.tsx` contains most orchestration logic; changes there often affect generation, export and navigation together
- `src/app/api.ts` is the safest place to centralize future proxy normalization changes
- Local Node mode stores final drafts on disk; serverless mode stores them in memory
- There is currently no automated test script in `package.json`

## Suggested Next Refactors

- 抽离 `ContentPage.tsx` 的工作流与流式解析逻辑到 hooks / services
- 统一 `server/` 与 `api/` 的导出和草稿能力，减少两套实现漂移
- 为外部任务系统地址添加环境变量，移除硬编码 `127.0.0.1:18891`
