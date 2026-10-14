# API

Base path: `/api/v1`

Errors:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request body is invalid.",
    "details": [{ "path": "title", "message": "Required" }],
    "requestId": "…"
  }
}
```

Authenticated routes require the `vela_session` cookie. Unknown or someone else’s ids return `404` so existence is not leaked.

`POST /tasks` accepts `Idempotency-Key` (8–80 characters: letters, numbers, `_`, `-`). The same key and body replay the first response. The same key with a different body returns `409`.

## Public

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `200` when MongoDB responds, otherwise `503` |
| GET | `/meta` | Product name, email recovery flag, notification channels, billing flag |
| POST | `/auth/register` | `{ name, email, password, timeZone? }` |
| POST | `/auth/login` | `{ email, password }` |
| POST | `/auth/logout` | Clears the cookie when present |
| POST | `/auth/recovery` | `503 EMAIL_NOT_CONFIGURED` until SMTP is set |

## Session

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/me` | Current user |
| PATCH | `/me` | `{ name?, timeZone? }` |
| POST | `/auth/password` | `{ currentPassword, newPassword }` |

## Lists

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/lists` | |
| POST | `/lists` | `{ name, color, icon }` |
| PATCH | `/lists/:id` | Rename, color, icon, archive flag |
| DELETE | `/lists/:id` | Moves tasks to Inbox, then deletes the list. Inbox cannot be deleted |

## Tags

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/tags` | |
| POST | `/tags` | `{ name, color }` |
| PATCH | `/tags/:id` | |
| DELETE | `/tags/:id` | Removes the tag from tasks |

## Tasks

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/tasks` | Filters below |
| POST | `/tasks` | Creates a task |
| GET | `/tasks/:id` | `{ task, subtasks }` |
| PATCH | `/tasks/:id` | Sends `revision`. Mismatch returns `409` |
| DELETE | `/tasks/:id` | Soft delete |
| POST | `/tasks/:id/restore` | |
| POST | `/tasks/:id/complete` | |
| POST | `/tasks/:id/uncomplete` | |
| POST | `/tasks/:id/skip` | Recurring tasks only |
| POST | `/tasks/:id/archive` | |
| POST | `/tasks/:id/unarchive` | |
| POST | `/tasks/reorder` | `{ ids: string[] }` |
| POST | `/tasks/batch` | `{ ids, action: "complete" \| "delete", listId? }` |

### GET `/tasks` query

- `view`: `inbox`, `today`, `upcoming`, `all`, `completed`, `list`, `tag`, `calendar`, `archived`, `search`
- `listId`, `tagId`, `q`, `priority`
- `from`, `to` for calendar (ISO datetimes)
- `topLevel`: `true` or `false` (default depends on the view)

Today includes overdue open tasks. Search matches title and description. Results cap at 500 and set `truncated` when the cap is hit.

Completed responses may include `occurrences` for recurring history.

## Reminders

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/reminders/pending` | Scheduled reminders whose `fireAt` is now or earlier |
| POST | `/reminders/:id/ack` | Marks `delivered` once |

## Task body

`title`, `description`, `listId`, `parentId`, `dueAt`, `dueHasTime`, `startAt`, `priority`, `tagIds`, `estimatedMinutes`, `reminderOffsetMinutes`, `recurrence`, `timeZone`.

Recurrence: `{ frequency: "daily" \| "weekly" \| "monthly" \| "yearly", interval, byWeekday?, until?, count? }`.

A recurring task requires `dueAt`.
