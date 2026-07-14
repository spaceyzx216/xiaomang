# Content Agent Workflow

The main content generation workflow is fully handled by the self-hosted Agent pipeline.
The frontend posts to `/api/agent/workflow/stream-run`, and the server returns an SSE stream with one final `Message` event followed by `Done`.

## Runtime Flow

1. Split `_input.share_links` or `parameters.share_links` by line.
2. Resolve each Douyin or TikTok share link with TikHub and obtain title, cover, and playable video URL.
3. Generate transcript with ordered providers:
   - `tikhub-ffmpeg`: for TikHub-returned TikTok/ByteDance CDN URLs, keep multiple playable CDN candidates, fetch media with Node retry logic, and stream it into bundled `ffmpeg-static`, then call Doubao flash ASR with base64 audio. It starts with a fast ffmpeg probe and retries once with conservative probing only for ffmpeg probe/decode failures. If one CDN candidate fails to download, it quickly moves to the next candidate. With `ASR_AUDIO_FORMAT=auto`, it tries WAV first for short media and falls back to MP3 when WAV is too large or ASR rejects it.
   - `ffmpeg`: generic fallback that lets `ffmpeg-static` read stable direct video URLs, then calls Doubao flash ASR.
   - `doubao-video`: fallback to `doubao-seed-2-0-mini-260428` directly against the video URL and ask it to reconstruct the spoken script.
4. Run four DeepSeek creative agents in parallel:
   - opening hook extraction and recreation
   - ending hook extraction and recreation
   - title generation
   - script rewrite
5. Adapt the result back to the existing workflow-compatible payload:
   - `Code_list[i].fields[0]`: stringified `{ "content": "...", "title": "..." }`
   - `Code_list1[i].records[0].fields`: stringified detail object with `链接`, `标题`, `封面`, `内容`, `开头钩子`, `结尾钩子`

## Local Development

Vite proxies every `/api/*` request to the local Express server at `http://localhost:8787`.
Start both processes together:

```bash
npm run dev:full
```

Or, if Vite is already running in one terminal, start the backend proxy in another terminal:

```bash
npm run server
```

If the browser shows `:5173/api/tikhub/batch 500`, first check that the backend proxy is running on port `8787`.
The backend loads the root `.env` first and then `server/.env`, so `server/.env` can override local proxy values while shared agent keys can stay in the root `.env`.

Runtime progress is printed in the backend terminal as one-line structured logs. Each log includes:

- `requestId`: correlates one browser action across all internal and external calls.
- `scope`: route or module, for example `api.agent.workflow.stream-run`.
- `event`: current operation, for example `route.request.start`, `external.request.start`, `agent.item.start`.
- `interface`: external API name, for example `tikhub:/api/v1/hybrid/video_data`, `ffmpeg-static`, `doubao:asr.flash`, `doubao:video-understanding`, `deepseek:agent-title`.
- `durationMs`, `status`, `code`, `error`: timing and failure details when available.

Example:

```text
time="2026-06-30T12:00:00.000Z" level=info scope=api.agent.workflow.stream-run requestId=... event=route.request.start workflowId="7618854964156563519" mode="agent"
time="2026-06-30T12:00:01.000Z" level=info scope=api.agent.workflow.stream-run requestId=... event=external.request.start interface="tikhub:/api/v1/hybrid/video_data" method="GET" endpoint="https://api.tikhub.io/api/v1/hybrid/video_data"
time="2026-06-30T12:00:12.000Z" level=info scope=api.agent.workflow.stream-run requestId=... event=external.request.end interface="deepseek:agent-title" status="200" durationMs="3100"
```

## Required Vercel Environment Variables

Set these in Vercel Project Settings before enabling the agent:

```bash
AGENT_CONTENT_WORKFLOW_ID=7618854964156563519
AGENT_REQUEST_TIMEOUT_MS=120000
AGENT_API_RETRY_ATTEMPTS=2
AGENT_API_RETRY_BASE_DELAY_MS=500
AGENT_CREATIVE_RETRY_ATTEMPTS=2
AGENT_CREATIVE_RETRY_BASE_DELAY_MS=1200
TIKHUB_BASE_URL=https://api.tikhub.dev
TIKHUB_API_TOKEN=...
TRANSCRIPT_PROVIDERS=tikhub-ffmpeg,ffmpeg,doubao-video
TIKHUB_TRANSCRIPT_PROVIDER_ENABLED=true
FFMPEG_FAST_PROBE_SIZE=4194304
FFMPEG_FAST_ANALYZE_DURATION=3000000
ASR_AUDIO_FORMAT=auto
ASR_WAV_MAX_BYTES=20971520
TIKHUB_MEDIA_URL_MAX_ATTEMPTS=6
TIKTOK_MEDIA_PROXY_URL=
MEDIA_USE_ENV_PROXY=true
DOUBAO_API_KEY=...
DOUBAO_RESOURCE_ID=volc.bigasr.auc_turbo
DOUBAO_ASR_ENDPOINT=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
DOUBAO_VIDEO_ENDPOINT=https://ark.cn-beijing.volces.com/api/v3/chat/completions
DOUBAO_VIDEO_API_KEY=...
DOUBAO_VIDEO_MODEL=doubao-seed-2-0-mini-260428
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
FEISHU_FOLDER_TOKEN= # optional
FEISHU_DOC_BASE_URL=https://feishu.cn
FEISHU_BITABLE_APP_TOKEN= # optional; existing Bitable app token
FEISHU_BITABLE_TABLE_ID= # optional; existing Bitable table id
```

Feishu export supports both document and Bitable outputs. For Bitable:

- Recommended production flow: paste one existing Feishu Bitable URL in the final editor. The app parses the URL, creates one task-specific table in that Bitable on first export, caches the returned table id in the browser, and appends subsequent topic outputs from the same task to that table.
- Set only `FEISHU_BITABLE_APP_TOKEN` when you want a fixed fallback Bitable app without asking users for a URL.
- Set both `FEISHU_BITABLE_APP_TOKEN` and `FEISHU_BITABLE_TABLE_ID` only when every export should append to one fixed table.
- Required app permissions are `base:app:create`, `base:table:create`, `base:field:read`, `base:field:create`, and `base:record:create`, or the broader `bitable:app` permission. The app also needs access to the target folder or target Bitable app.
- When using a user-provided existing Bitable, add the Feishu app as a document app with edit/manage permission for that Bitable once.
- The Bitable schema includes benchmark video cover and duration fields: `视频封面` and `视频时长`.
