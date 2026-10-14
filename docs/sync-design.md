# Synchronization design

This document is the target design. The current web client does **not** sync offline edits. It refuses mutations while `navigator.onLine` is false and shows that state.

## Goal

A device can create and edit tasks without a connection, then converge with the server without duplicating tasks or dropping another device’s newer edit.

## Client store

- Web: IndexedDB database `vela`, stores `tasks`, `lists`, `tags`, and `mutations`
- Desktop and mobile, later: the same mutation shape in SQLite or the platform database

## Mutation record

```ts
{
  id: string;          // client-generated, stable across retries
  baseRevision: number | null;
  entity: "task" | "list" | "tag";
  entityId: string;
  op: "create" | "update" | "delete" | "complete" | "restore";
  payload: unknown;
  createdAt: string;
  attempt: number;
}
```

Creates already use `Idempotency-Key` on `POST /tasks`. The queue id should be that key.

## Server rules

- Updates must send the revision the client edited. A mismatch returns `409` and the current document.
- The client does not send `userId`.
- Completing a recurring task stays on the server so occurrence history cannot fork per device.

## Conflict policy

- If the local change and the server change touch different fields, merge field-wise and retry with the server revision.
- If they touch the same field, keep the server value, keep the local value in an “unsynced edit” state, and ask the person to choose.
- Deletes win over edits of a soft-deleted task until restore.

## Status in the interface

Show one of: synced, pending local changes, retrying, or needs attention. Do not show “synced” when the queue is non-empty.

## Current gap

None of the IndexedDB queue is implemented. Reloading the page reloads server state only. Two devices see updates only after each one refetches.
