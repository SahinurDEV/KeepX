# Data model

Database: MongoDB. ODM: Mongoose. All personal records include `userId`. Queries from HTTP handlers add that constraint from the session.

## User

- `email` (unique, stored lowercase)
- `passwordHash` (bcrypt)
- `name`
- `timeZone` (IANA name)
- `createdAt`, `updatedAt`

## Session

- `userId`
- `tokenHash` (SHA-256 of `SESSION_SECRET` plus the cookie token)
- `expiresAt` (TTL index)
- `userAgent`

The raw token is only the cookie value.

## List

- `userId`, `name`, `color`, `icon`, `sortOrder`
- `isInbox` (one inbox per user)
- `archivedAt`

The inbox list is created at registration and cannot be deleted.

## Tag

- `userId`, `name` (unique per user), `color`

## Task

- `userId`, `listId`, `parentId`
- `title`, `description`
- `status`: `open`, `completed`, `archived`
- `dueAt`, `dueHasTime`, `startAt`, `timeZone`
- `priority`: `none`, `low`, `medium`, `high`
- `tagIds`
- `estimatedMinutes`
- `reminderOffsetMinutes` (minutes before `dueAt`; `0` means at the due instant)
- `recurrence` (frequency, interval, optional weekdays, optional until, optional count)
- `anchorAt` (first due instant used to align weekly patterns and month days)
- `seriesId`
- `sortOrder`, `revision`
- `completedAt`, `deletedAt`
- `createdAt`, `updatedAt`

Indexes:

- `{ userId, deletedAt, status, dueAt }`
- `{ userId, listId, sortOrder }`
- `{ userId, parentId }`

## Occurrence

History for a recurring series.

- `userId`, `taskId`, `seriesId`
- `occurrenceDueAt`
- `action`: `completed` or `skipped`
- `actedAt`

Unique index: `{ taskId, occurrenceDueAt, action }`.

## Reminder

- `userId`, `taskId`
- `fireAt`
- `channel`: `in_app`
- `status`: `scheduled`, `delivered`, `cancelled`
- `deliveredAt`

## IdempotencyKey

- `userId`, `key`, `requestHash`, `statusCode`, `responseBody`, `createdAt`
- TTL: 24 hours

Used by task creation when the client sends `Idempotency-Key`.

## Consistency

Completing a recurring task inserts history, then updates the task if `revision` still matches. On a revision conflict the new history row is removed and the API returns 409. This does not require a multi-document transaction, so it works on a standalone MongoDB server. A crash between the two writes can leave a history row without an advance; a later complete of the same due instant reuses that row instead of inserting a duplicate.
