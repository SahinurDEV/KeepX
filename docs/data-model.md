# Data model

Database: MongoDB. ODM: Mongoose. All personal records include `userId`. Queries from HTTP handlers add that constraint from the session.

## User

- `email` (unique, stored lowercase)
- `passwordHash` (bcrypt)
- `previousPasswordHash`, `previousPasswordUntil` (set for five minutes after a password change so Undo can restore it)
- `name`
- `timeZone` (IANA name)
- `emailReminders` (default false)
- `pushReminders` (default false)
- `plan` (`personal` or `plus`, default `personal`)
- `stripeCustomerId`, `stripeSubscriptionId` (set only from a verified billing notice, and not returned by the API)
- `createdAt`, `updatedAt`

## Session

- `userId`
- `tokenHash` (SHA-256 of `SESSION_SECRET` plus the cookie token)
- `expiresAt` (TTL index)
- `userAgent`
- `revokedAt` (null while active; set when another browser is signed out)

The raw token is only the cookie value. `GET /auth/sessions` returns unexpired active rows for the signed-in account and does not include `tokenHash`. Signing out another browser sets `revokedAt`. Signing out this browser deletes the row. `POST /auth/sessions/:id/restore` clears `revokedAt`.

## Password reset

- `userId`
- `tokenHash` (SHA-256 of `SESSION_SECRET` plus the link token)
- `expiresAt` (one hour, TTL index)

A row is created only after SMTP is configured and only for an address that has an account. The raw token is only in the email.

## Access token

- `userId`
- `name`
- `tokenHash` (SHA-256 of `SESSION_SECRET` plus the bearer token)
- `revokedAt` (null while active; set when the token is revoked)

The raw token is returned once from `POST /auth/tokens`. Revoking sets `revokedAt`. `POST /auth/tokens/:id/restore` clears it. At most 10 active tokens. Password change and password reset delete every token for that user.

## List

- `userId`, `name`, `color`, `icon`, `sortOrder`
- `isInbox` (one inbox per user)
- `archivedAt`

The inbox list is created at registration and cannot be deleted or shared.

## List member

- `listId`, `userId`
- `leftAt` (null while active; set when that person leaves)
- Unique on `{ listId, userId }`

A member can read and edit tasks in that list while `leftAt` is null. Leaving soft-leaves so rejoin and invite can restore access. The owner removes someone else with a hard delete. The owner is the list's `userId` and is not stored as a member row. At most 20 active members.

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
- `series` (template for the open occurrence when that date differs: title, description, priority, original due instant, time flag, reminder)
- `omittedDueAts` (series instants removed without counting them)
- `seriesId`
- `sortOrder`, `revision`
- `completedAt`, `deletedAt`, `purgedAt` (set when Delete forever / Empty Trash hides the task for five minutes before hard delete)
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

## Occurrence exception

A date in a series that does not follow the template.

- `userId`, `taskId`, `seriesId`
- `originalDueAt` (the series slot)
- `title`, `description`, `priority`, `dueAt`, `dueHasTime`, `reminderOffsetMinutes`

Unique index: `{ taskId, originalDueAt }`. The row stays after the date is completed so uncomplete can restore it.

## Reminder

- `userId`, `taskId`
- `fireAt`
- `channel`: `in_app`
- `status`: `scheduled`, `delivered`, `cancelled`
- `deliveredAt`
- `emailStatus`: `pending`, `sending`, `sent`, `failed`, `skipped`, or `missed`
- `emailSentAt`
- `pushStatus`: `pending`, `sending`, `sent`, `failed`, `skipped`, or `missed`
- `pushSentAt`

## Push device

- `userId`, `platform` (`web`, `android`, or `ios`), `provider` (`web` or `expo`)
- `token` (browser subscription JSON or Expo push token, unique)
- `createdAt`

The API does not return `token` after registration. At most 10 devices per account.

## IdempotencyKey

- `userId`, `key`, `requestHash`, `statusCode`, `responseBody`, `createdAt`
- TTL: 24 hours

Used by task creation when the client sends `Idempotency-Key`.

## Consistency

Completing a recurring task inserts history, then updates the task if `revision` still matches. On a revision conflict the new history row is removed and the API returns 409. This does not require a multi-document transaction, so it works on a standalone MongoDB server. A crash between the two writes can leave a history row without an advance; a later complete of the same due instant reuses that row instead of inserting a duplicate.
