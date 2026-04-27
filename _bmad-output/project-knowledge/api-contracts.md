# API Contracts

## Internal APIs Used by Frontend

### `POST /api/tikhub/batch`

- **Purpose:** 批量解析抖音链接，补全作者与公开视频数据
- **Request Body:**

```json
{
  "urls": ["https://example.com/1", "https://example.com/2"]
}
```

- **Response Shape:**

```json
{
  "results": [
    {
      "url": "string",
      "secUserId": "string",
      "authorName": "string",
      "videosCount": 20,
      "secUserResponse": {},
      "videosResponse": {},
      "error": null
    }
  ]
}
```

### `POST /api/coze/workflow/stream-run`

- **Purpose:** 调用 Coze 工作流并将 SSE 事件透传给前端
- **Typical Frontend Uses:**
  - 基础内容生成
  - 翻译工作流
- **Response Type:** `text/event-stream`
- **Important Events:**
  - `Message`
  - `Done`
  - `Error`

### `POST /api/coze/workflows/chat`

- **Purpose:** 调用 Coze 对话式工作流，执行平台风格转写
- **Response Type:** `text/event-stream`
- **Important Events:**
  - `conversation.message.delta`
  - `conversation.message.completed`
  - `conversation.chat.failed`
  - `error`

### `GET /api/final-drafts`

- **Purpose:** 查询待导出草稿列表

### `POST /api/final-drafts`

- **Purpose:** 保存当前最终文案草稿
- **Request Body:**

```json
{
  "titleDraft": "string",
  "hookDraft": "string",
  "scriptDraft": "string",
  "rewriteDraft": "string",
  "translationDraft": "string"
}
```

### `DELETE /api/final-drafts`

- **Purpose:** 清空全部待导出草稿

### `DELETE /api/final-drafts/:id`

- **Purpose:** 删除指定草稿

### `POST /api/export/word`

- **Purpose:** 导出单份文案为 `.doc`
- **Implementation Note:** 实际发送的是纯文本格式的 Word 兼容内容

### `POST /api/export/excel`

- **Purpose:** 导出单份文案为 UTF-8 BOM CSV

## Local-Only / External API

### `GET http://127.0.0.1:18891/api/tasks/today`

- **Purpose:** 从外部任务系统拉取今日任务
- **Used In:** `App.tsx`
- **Risk:** 当前是硬编码地址，不适合直接迁移到生产环境

## Third-Party Upstream APIs

### Tikhub

- `GET /api/v1/douyin/web/get_sec_user_id`
- `GET /api/v1/douyin/app/v3/fetch_user_post_videos`

### Coze

- `POST /v1/workflow/stream_run`
- `POST /v1/workflows/chat`

## Contract Gaps

- 内容生成和翻译的响应结构没有本地 schema 定义，主要依赖前端容错解析
- 没有为批量导出全部草稿提供正式后端接口；前端在 `404` 时内置了回退拼装逻辑
- 没有 OpenAPI / Swagger / GraphQL schema 等机器可读契约文件
