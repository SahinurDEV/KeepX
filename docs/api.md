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
| GET | `/meta` | Product name, email recovery flag, notification channels, web push public key, billing flag |
| POST | `/auth/register` | `{ name, email, password, timeZone? }` |
| POST | `/auth/login` | `{ email, password }` |
| POST | `/auth/logout` | Clears the cookie when present |
| POST | `/auth/recovery` | `{ email }`. `503 EMAIL_NOT_CONFIGURED` until SMTP is set. Otherwise `204` for every address |
| POST | `/auth/reset` | `{ token, password }`. Sets the password and ends existing sessions |

## Session

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/me` | Current user |
| PATCH | `/me` | `{ name?, timeZone?, emailReminders?, pushReminders? }`. A profile that already has those values stays as it is. A plan field is ignored |
| DELETE | `/me` | `{ password }`. Removes the account. Returns 204 and clears the cookie. A wrong password returns 400. A recorded subscription returns 409 and the account stays |
| POST | `/auth/password` | `{ currentPassword, newPassword }`. Keeps the previous password hash for five minutes so Undo can restore it. Ends other browsers and deletes app tokens |
| POST | `/auth/password/restore` | Restores the previous password when that five-minute window is still open. Returns 204. When it has expired, returns 404. Other browsers and app tokens stay signed out |
| POST | `/auth/tokens` | `{ name }` creates a bearer token. The raw token is returned once. At most 10 active tokens |
| GET | `/auth/tokens` | Names and created times of active tokens for this account. Soft-revoked tokens are omitted. The secret is not included |
| DELETE | `/auth/tokens/:id` | Soft-revokes one token so it can be restored. Returns 204 |
| POST | `/auth/tokens/:id/restore` | Clears `revokedAt` on a soft-revoked token. Returns the token metadata. An active or missing token returns 404. The 10-token limit still applies |
| GET | `/auth/sessions` | Active browsers signed in with the password. Soft-revoked sessions are omitted. The cookie hash is not included. `current` marks the session making the request |
| DELETE | `/auth/sessions/:id` | Signs out one of those browsers. Returns 204. Another browser is soft-revoked so it can be restored. Signing out the current browser deletes that session and clears the cookie. Another account's session returns 404 |
| POST | `/auth/sessions/:id/restore` | Clears `revokedAt` on a soft-revoked session that has not expired. Returns the session. An active or missing session returns 404 |

Browser extensions may call the API with `Authorization: Bearer` and a `chrome-extension://` or `moz-extension://` origin. Other origins are still rejected.

## Lists

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/lists` | |
| POST | `/lists` | `{ name, color, icon }` |
| POST | `/lists/:id/duplicate` | Creates a private list named with “ copy”. Copies tasks that are not deleted or archived, including subtasks, as new open tasks. Returns the list with `copiedTasks` for how many were copied. Sharing and completion history are not copied. Someone else's tag is left off |
| POST | `/lists/reorder` | `{ ids }` of every list except Inbox, in the new order. Returns 204. Inbox stays first. A list that is already in that place stays as it is. Another account's list returns 404. A partial list returns 400. An archived list stays where the order puts it, including between the two lists that swapped |
| PATCH | `/lists/:id` | Rename, color, icon, archive flag. A list that already has those values stays as it is. Inbox cannot be renamed or archived. An editor receives 403. Archiving hides the list and leaves its tasks in place |
| DELETE | `/lists/:id` | Moves each task into its author's Inbox, then deletes the list. Inbox cannot be deleted. An editor receives 403 |
| GET | `/lists/:id/members` | The owner and active editors. Someone who left is omitted |
| POST | `/lists/:id/members` | `{ email }` of an existing account. A new editor returns 201 with `added: true`. Someone who already has the list stays as they are and returns 200 with `added: false`. Someone who left is restored and returns 201 with `added: true`. Inbox returns 400. An unknown email returns 404. No message is sent |
| DELETE | `/lists/:id/members/:memberId` | The owner removes an editor (hard delete), or an editor leaves (sets `leftAt`). Assignments to that person on the list are cleared |
| POST | `/lists/:id/rejoin` | An editor who left clears `leftAt` and returns as an editor. Someone still on the list, or with no prior membership, returns 404. The owner returns 400. The 20-person limit still applies |

## Tags

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/tags` | |
| POST | `/tags` | `{ name, color }` |
| PATCH | `/tags/:id` | `{ name?, color? }`. A tag that already has that name and color stays as it is. Another account's tag returns 404. A name you already use returns 409 |
| DELETE | `/tags/:id` | Removes the tag from every task that has it, including a task someone else added on a shared list |

## Tasks

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/tasks` | Filters below |
| POST | `/tasks` | Creates a task |
| GET | `/tasks/:id` | `{ task, subtasks }` |
| PATCH | `/tasks/:id` | Sends `revision`. Mismatch returns `409`. A task that already has those details stays as it is |
| DELETE | `/tasks/:id` | Soft delete |
| POST | `/tasks/:id/duplicate` | Creates an open copy and returns 201. Subtasks are copied. Completion history is not. Tags the caller does not own are left off. Duplicating a subtask whose parent is finished or archived adds the copy as its own task at the end of the list |
| POST | `/tasks/:id/postpone` | Moves an open task one calendar day later in its time zone. A task with no date becomes tomorrow. A time stays at the same clock time. Open subtasks move one day later with it. A repeating task changes only the open date and leaves its subtasks where they are. A completed task returns 400 |
| POST | `/tasks/:id/pin` | `{ pinned: boolean }`. Only an open task. Inbox, a list, All tasks, a tag, and Search keep it at the top, including after a sort. Today and Upcoming stay in date order. The pin stays with a repeating task |
| POST | `/tasks/:id/assign` | `{ userId: string \| null }`. Only an open task. The person must own the list or already be invited. Moving the task to another list clears the assignment |
| POST | `/tasks/:id/purge` | Soft-purges a Trash task for five minutes so Undo can put it back. Returns the purged task ids and the ids of subtasks that stayed because someone else added them. Only the person who added it can do this. A deleted subtask they added is purged with it. Anyone else's subtask stays in Trash on its own |
| POST | `/tasks/:id/restore` | Restores a task that is already in Trash. Subtasks that are still in Trash come back with it. Restoring a subtask while its parent is still in Trash clears `parentId`, so the subtask becomes its own task |
| POST | `/tasks/restore` | `{ ids }`. Restores the selected Trash tasks. Returns `{ restored, skipped, tasks }`. A task that is already open stays as it is and is counted in `skipped`. A selected subtask whose parent is also selected is restored once, with the parent. If one selected task cannot be seen, nothing is restored |
| POST | `/tasks/purge` | `{ ids }`. Soft-purges the selected Trash tasks the caller added. Returns `{ purged, kept, deletedIds, detachedIds }`. Someone else's task stays as it is and is counted in `kept`. A selected subtask whose parent is also selected is purged once, with the parent. If one selected task cannot be seen, nothing changes |
| POST | `/tasks/purge/restore` | `{ ids }` from a recent purge. Clears `purgedAt` so those tasks return to Trash. Returns `{ restored }`. When the five-minute window has passed, returns 404 |
| POST | `/tasks/empty-trash` | Soft-purges every Trash task the caller added, including those subtasks. Returns `{ purged, kept, deletedIds }`. `kept` is deleted tasks on shared lists that someone else added. When Trash has nothing of yours, `purged` is 0 |
| POST | `/tasks/clear-completed` | Moves every completed task the caller added to Trash. Returns `{ deleted, kept, deletedIds }`. `deletedIds` are the root tasks that moved, so a restore can bring them back. `kept` is completed tasks someone else added, and those stay even when some of yours move. Subtasks of a completed task move with it. An open task stays. When you have no completed tasks, `deleted` is 0 |
| POST | `/tasks/:id/complete` | |
| POST | `/tasks/:id/finish-subtasks` | Completes every open subtask and leaves the parent as it is. An archived subtask stays archived. An archived parent is rejected and nothing changes |
| POST | `/tasks/:id/uncomplete` | Reopens a finished task. A task that is already open is rejected, so its finished subtasks stay finished. A repeating task that is still open can still undo its latest date. An archived task is rejected |
| POST | `/tasks/:id/skip` | Recurring tasks only. Counts the occurrence and moves on |
| POST | `/tasks/:id/omit` | Recurring tasks only. Drops that series date without counting it |
| POST | `/tasks/:id/restore-omitted` | Recurring tasks only. Puts back the most recently removed series date. Returns 400 when there is no removed date to restore |
| POST | `/tasks/:id/archive` | Hides the task from active lists. Subtasks are archived with it. Archiving one subtask leaves its parent and the other subtasks as they are |
| POST | `/tasks/:id/unarchive` | Restores an archived task. Subtasks archived with it come back with it. Restoring one subtask also restores an archived parent and leaves the other archived subtasks archived. Unarchiving that parent again is rejected, because it is already open |
| POST | `/tasks/reorder` | `{ ids: string[] }` in the new order. Returns 204. A task that is already in that place stays as it is. A subtask can only be reordered with the other subtasks of that task, and the request has to include every one of them. Leaving one out, or mixing in another task, returns `400 SIBLING_REQUIRED` and nothing moves. A task list includes `parentTitle` for a subtask. Restoring a subtask while its parent is still in Trash clears `parentId`, so the subtask becomes its own task. Restoring the parent still brings back subtasks that are in Trash, so restoring one of those subtasks again is not found. Reopening a finished subtask also reopens a finished parent and leaves the parent's other finished subtasks finished. A new subtask is stored at the end of that parent's subtasks. Duplicating a subtask adds the open copy there too. `GET /tasks/:id` includes `subtaskCount` and `openSubtaskCount` for that task |
| POST | `/tasks/sort` | `{ listId, by: "due" \| "priority" \| "title" }`. Returns 204. Sorts open tasks on that list. Tasks with no date go last. Only the owner can sort. Subtasks stay in place. A task that is already in that order stays as it is |
| POST | `/tasks/batch` | `{ ids, action: "complete" \| "delete" \| "move" \| "priority" \| "due" \| "tag" \| "reopen" \| "remind" \| "postpone" \| "start" \| "estimate" \| "pin" \| "duplicate" \| "archive" \| "unarchive" \| "skip" \| "omit" \| "assign" \| "repeat" \| "parent", listId?, priority?, dueAt?, dueHasTime?, tagId?, tagMode?, reminderOffsetMinutes?, startAt?, estimatedMinutes?, pinned?, assigneeId?, recurrence?, parentId? }`. `complete` finishes the open subtasks of a task that does not repeat. Selecting a subtask with a repeating task still completes that subtask. `delete` moves the tasks to Trash and takes their subtasks, including ones that were not selected. Selecting a subtask with its task deletes it once. `duplicate` copies the tasks and their subtasks that are not archived. Selecting a subtask with its task copies that subtask once, with the task. The response counts those copied subtasks. `pin` changes only the tasks that were not already pinned or unpinned, and leaves the others as they are. `assign` changes only the tasks that were not already assigned to that person, or already unassigned. `tag` adds or removes a tag only on the tasks that did not already have it, or that still had it. `estimate` changes only the tasks that did not already have that estimate. `move` requires `listId`. `priority` requires `priority`. A finished task stays as it is. `priority` changes only the tasks that did not already have that priority. `due` requires `dueAt`, which may be null to clear the date. A finished task stays as it is. Clearing the date leaves a repeating task as it is. `due` changes only the tasks that did not already have that date. `tag` requires `tagId` and `tagMode` of `add` or `remove`, and the tag must belong to the signed-in account. `reopen` puts finished tasks back. A task that is already open stays as it is. Finished subtasks reopen with the task. Selecting one of those subtasks with the task reopens it once, with the task. Reopening a subtask also reopens its finished task and leaves the other subtasks finished. `remind` requires `reminderOffsetMinutes`, which may be null to clear it. A reminder needs a due date. A finished task stays as it is. A task with no due date stays as it is. `remind` changes only the tasks that did not already have that reminder. A repeating task changes only that date. `postpone` moves each open task one day later. A task with no date becomes tomorrow, and a time stays at the same clock time. A repeating task changes only that date. A finished task stays as it is. `start` requires `startAt`, which may be null to clear it. The start date applies to the whole repeating task. A finished task stays as it is. `start` changes only the tasks that did not already have that start date. `estimate` requires `estimatedMinutes`, which may be null to clear it. The estimate applies to the whole repeating task. `pin` requires `pinned`. Only an open task can be pinned. The pin stays with a repeating task. A finished task stays as it is. `duplicate` copies each selected task. The copy is open. Subtasks are copied. Completion history is not. If one selected task cannot be seen, nothing is copied. `complete` checks every selected task first. An archived task stays as it is. A finished task that does not repeat stays as it is. `duplicate` copies each selected task. The copy is open. Subtasks are copied. Completion history is not. A selected subtask whose parent is also selected is copied once, with the parent. If one selected task cannot be seen, nothing is copied. `archive` hides the selected tasks from the active lists. A task that is already archived stays as it is and is not counted as changed. Subtasks are archived with the task. If one selected task cannot be seen, nothing is archived. `unarchive` restores archived tasks. A task that is not archived stays as it is. Subtasks archived with the task come back with it. `skip` moves each selected repeating task to its next date and records the skipped date. A task that does not repeat stays as it is. Deleting a task and its subtask deletes the subtask once, with the parent. The response lists the tasks that were deleted, not a selected subtask that went with its parent. Restoring that parent brings the subtask back, so restoring the subtask again is not found. `omit` drops the current date of each selected repeating task. The series continues, and no completion history is recorded. A task that does not repeat stays as it is. Restoring a task also restores subtasks that are still in Trash. `assign` requires `assigneeId`, which may be null to clear it. That person must be on each task's list. A finished task stays as it is. A task on a list that person is not on stays as it is. The assignment stays with a repeating task. Duplicating a task leaves out subtasks that are archived. `repeat` requires `recurrence`, which may be null to stop repeating. The rule applies to the whole task. `repeat` changes only the tasks that did not already have that rule. A task with no due date stays as it is. A finished task stays as it is. Completing a task also completes its open subtasks. A repeating task stays open and leaves its subtasks open. A weekly rule can name `byWeekday`, with Monday as 1. Reopening a task also reopens subtasks that were completed with it. Reopening a repeating task leaves those subtasks as they are. `interval` is how many of those periods pass between dates, from 1 to 99. Deleting a task also cancels reminders on its subtasks. `count` is how many times the rule repeats, from 1 to 999. Leaving it out repeats until the rule is cleared. When the last date is completed, skipped, or removed, the task is finished, its repeat rule is cleared, and it appears in Completed. Open subtasks are completed with it. `until` is the last instant the rule can schedule. It has to be on or after each task's due date. A task whose due date is after that end stays as it is. `dueHasTime` keeps a clock time on that date. Postponing a task also postpones its open subtasks. A repeating task changes only that date and leaves its subtasks where they are. A tag applies to the whole repeating task. A repeating task changes only that date and cannot lose its date. Subtasks of a moved task go with it. Selecting that subtask with the task moves it once, with the task. `move` leaves a task as it is when it is already on that list and is not becoming its own task. A selected subtask whose parent stays behind becomes its own task. Someone else's task stays as it is when an editor moves the selection. `parent` requires `parentId`, which may be null to make the tasks their own. They move to that task's list. `parent` changes only the tasks that were not already under that task, or already on their own. A finished parent, or a parent that is already a subtask, leaves the selection as it is. Someone else's task stays as it is when an editor puts the selection under a task on another list. A task that already has subtasks stays as it is. Putting a task under a parent adds it at the end of those subtasks and moves it onto that list. Moving a subtask whose parent stays behind places that task at the end of the destination list |

### GET `/tasks` query

- `view`: `inbox`, `today`, `upcoming`, `all`, `completed`, `list`, `tag`, `calendar`, `archived`, `search`, `trash`
- `listId`, `tagId`, `q`, `priority`, `due=none`, `due=overdue`, `started=waiting`, `pinned=true`, `assignee=me`
- `from`, `to` for calendar (ISO datetimes)
- `topLevel`: `true` or `false` (default depends on the view)

Today includes overdue open tasks. `due=none` keeps only tasks with no due date. Today, Upcoming, and Calendar reject that filter. `due=overdue` keeps only open tasks due before today. Upcoming, Completed, Calendar, Trash, and Archived reject that filter. Today and Upcoming leave out a task whose start date is still ahead. `started=waiting` keeps only those tasks, and other views reject it. A task with no start date stays in the list. `pinned=true` keeps only pinned tasks. `assignee=me` keeps only tasks assigned to the signed-in account. Calendar rejects both filters. Removing someone from a list clears every task on that list that was assigned to them. Search matches title and description, and also a tag name that belongs to the signed-in account. Finished tasks are included. Archived tasks stay out. A task in Trash includes parentTitle when it is a subtask. An archived task list includes parentTitle when it is a subtask. Calendar includes open and finished tasks in the range, including a finished subtask and its parentTitle. Results cap at 500 and set `truncated` when the cap is hit. Each task includes `subtaskCount` and `openSubtaskCount` for direct subtasks that are not deleted.

Completed responses may include `occurrences` for recurring history.

## Reminders

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/reminders/pending` | Scheduled reminders whose `fireAt` is now or earlier |
| POST | `/reminders/:id/ack` | Marks `delivered` once |
| POST | `/reminders/:id/unack` | Puts a delivered reminder back to `scheduled` so it can show again. An open reminder returns 400. A missing reminder returns 404 |
| POST | `/reminders/:id/snooze` | `{ minutes }` from 1 to 1440, or `{ fireAt }` as an ISO time. Minutes moves a scheduled reminder forward. `fireAt` sets that time, including when Undo restores the previous time. A dismissed reminder returns 400. Email or push that already went out is not sent again |

Acknowledging the in-app reminder does not send email or push. While the API process is running it checks pending reminder email and push about every 30 seconds. Mail is sent only when SMTP is configured, the account has `emailReminders` turned on, and the reminder became due within the last 15 minutes. Push is sent only when `pushReminders` is on, a configured provider can reach a registered device, and the reminder became due within the last 15 minutes. Otherwise the channel status is `skipped` or `missed`. A failed send is `failed` and is not retried. A push endpoint that is gone is deleted and is not retried.

## Devices

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/devices` | This account's browsers and phones, with when each was added. The push token is not included |
| POST | `/devices` | `{ platform: "web" \| "android" \| "ios", token }`. Web token is a push subscription JSON. Phone token is an Expo push token. Returns 201, or 200 if this account already registered it |
| DELETE | `/devices/:id` | Removes one of your devices. Returns `{ platform, token }` so Undo can register it again. The list endpoint still omits tokens |

An invalid subscription or Expo token is rejected. A token already registered to another account returns 409. The limit is 10 devices. Push for a shared task still goes to the task's author.

## Export

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/export` | JSON archive of this account. `Content-Disposition` is `attachment; filename="keepx-export.json"` |

The file contains the profile, lists and their members, tags, tasks the account can see (including deleted tasks), and occurrence history. It omits the password, sessions, access tokens, Stripe ids, and push subscriptions. At most 5,000 tasks and 5,000 occurrence rows are returned. `truncated` is true when either cap is hit.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/import` | Copies an export into the signed-in account. Returns 201 with counts and `listIds`, `tagIds`, and `taskIds` for what was created. Existing tags with the same name are reused and omitted from `tagIds`. Existing tasks stay. Sharing is not restored. The account plan is not changed |
| POST | `/import/revert` | `{ listIds, tagIds, taskIds }` from a recent import. Permanently removes those owned resources. Leftover tasks on a listed list move to Inbox before the list is removed. Ids that are missing or belong to someone else are skipped |

## Billing

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/billing` | The server plan and the features it includes. Stripe ids are not included |
| POST | `/billing/checkout` | Starts checkout when Stripe is configured. Does not change the plan. Returns 503 `BILLING_NOT_CONFIGURED` when it is not |
| POST | `/billing/webhook` | Stripe signature required. `checkout.session.completed` with `payment_status` `paid` sets Plus. `customer.subscription.deleted` returns the account to Personal |

A profile update cannot set the plan. The settings return page cannot set it either. Without all three Stripe variables, both checkout and the webhook refuse the request and leave the plan unchanged.

## Task body

`title`, `description`, `listId`, `parentId`, `dueAt`, `dueHasTime`, `startAt`, `priority`, `tagIds`, `estimatedMinutes`, `reminderOffsetMinutes`, `recurrence`, `timeZone`.

Recurrence: `{ frequency: "daily" \| "weekly" \| "monthly" \| "yearly", interval, byWeekday?, until?, count? }`.

A recurring task requires `dueAt`. Opening a task can set `until`, the date repeating stops. An earlier date is `400 END_BEFORE_DUE` and the rule stays as it was. A finished or archived task cannot gain a subtask (`400 NOT_OPEN`), and nothing is added.

`PATCH` accepts `occurrenceScope`. `this` changes only the open date (title, description, priority, due date, and reminder) and leaves the repeat rule in place. `following` writes those fields onto the series and clears exceptions from that date forward. A task response includes `occurrenceOriginalDueAt` when the open date differs from the series slot. Completing or skipping that date records the series slot, then restores the series. Uncomplete puts that date back, including its exception.
