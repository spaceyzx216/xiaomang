# Deployment Guide

## Deployment Options

### Option 1: Static Frontend + Node Proxy

Recommended when you want behavior closest to local development.

Components:

- `dist/` served by Nginx
- `server/index.js` running as a Node service on `8787`
- Nginx reverse proxy from `/tikhub-proxy/` to Node service

Reference file:

- `deploy/nginx.xiaomang.conf`

### Option 2: Static Frontend + Serverless APIs

Use the `api/` directory handlers on a compatible platform.

Caveat:

- final draft persistence is weaker in this mode because it uses memory store

## Build Steps

```bash
npm i
npm run build
```

## Required Environment Variables

- `TIKHUB_BASE_URL`
- `TIKHUB_API_TOKEN`
- `DEEPSEEK_API_KEY`
- `DOUBAO_API_KEY` or `DOUBAO_APP_KEY` / `DOUBAO_ACCESS_KEY`
- `PORT` for Node mode
- `VITE_API_PROXY_BASE` when front-end must point to a reverse proxy prefix

## Nginx Behavior

- `/` serves SPA static assets
- `/tikhub-proxy/` proxies to `127.0.0.1:8787`
- `/tikhub-proxy/health` proxies to `/health`
- SSE buffering is disabled for Agent stream compatibility

## Release Checklist

See `deploy/go-live-checklist.md` for:

- environment validation
- KKClaw integration checks
- Agent / Tikhub validation
- rollback readiness

## Known Deployment Risks

- 首页仍依赖本地地址 `127.0.0.1:18891` 获取任务，不适合作为直接线上默认值
- 流式接口对代理超时和 buffering 配置敏感
- 导出接口当前生成的是轻量文本文件，不是富格式 Office 文档
