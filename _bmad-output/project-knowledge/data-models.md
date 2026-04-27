# Data Models

## Frontend View Models

### `Topic`

Used in `App.tsx` to represent selected or recommended topics.

Key fields:

- `id`
- `title`
- `tags`
- `stats.comments`
- `stats.likes`
- `stats.shares`
- `stats.bookmarks`
- `link`
- `authorName`
- `publishDate`
- `rawData`

### `TaskItem`

Represents task context imported from URL params or the external task system.

Key fields:

- `_id`
- `customerName`
- `customerOccupation`
- `contact`
- `ownerName`
- `platformName`
- `collaborationPeriod`
- `contentRequirements`
- `priority`

### `WorkflowResult`

Parsed Coze workflow output.

- `titles: string[]`
- `hooks: { id, content, hookType }[]`
- `scripts: { id, title, content }[]`

### `WorkflowResultGroup`

Used when multiple share links are batched.

- `id`
- `shareLink`
- `result: WorkflowResult`

### `TranslationItem`

- `id`
- `zh`
- `en`
- `sourceType`
- `original`
- `translated`

### Final Draft Payload

Passed from `ContentPage` to `FinalEditorPage` through `sessionStorage`.

- `selectedTitles`
- `selectedHooks`
- `selectedScripts`
- `rewriteResults`
- `translationItems`
- `sourceGroupId`
- `sourceGroupIndex`
- `totalGroups`

## Backend Draft Models

### Local Node Mode

Stored in `server/data/final-drafts.json`.

```json
{
  "items": [
    {
      "id": "draft_...",
      "createdAt": "2026-03-31T09:25:04Z",
      "titleDraft": "",
      "hookDraft": "",
      "scriptDraft": "",
      "rewriteDraft": "",
      "translationDraft": ""
    }
  ]
}
```

### Serverless Mode

Stored in memory via `Map<string, Draft>`.

Fields are the same as local mode, but persistence is process-bound.

## Persistence Strategy

- **Long-lived data store:** none observed
- **Cross-page transient state:** `sessionStorage`
- **Local server temporary persistence:** JSON file
- **Serverless temporary persistence:** in-memory Map

## Data Model Observations

- 当前模型设计明显偏向“工作台临时态”，而不是长期业务数据沉淀
- 没有数据库 schema、迁移目录或 ORM 模型
- 第三方响应原文被大面积保存在 `rawData` / `videosResponse` / `secUserResponse` 中，便于 UI 二次利用，但也提高了前端状态体积
