# Synchronization design

The web client queues task creates, edits, completes, reopens, deletes, restores, and postpones in IndexedDB. A header shows synced, pending, retrying, or needs attention. List, tag, reorder, and archive changes still need a connection. The sections below are the target for the rest of that design.

## Goal

A device can create and edit tasks without a connection, then converge with the server without duplicating tasks or dropping another device’s newer edit.

## Client store

- Web: IndexedDB database `keepx`, store `mutations`
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

Show one of: synced, pending local changes, retrying, or needs attention. Do not show “synced” when the queue is non-empty. Clicking the status retries the queue when the browser is online. Needs-attention notices name conflicting fields, or say a change failed after several tries.

## Current gap

Task create, update, complete, reopen, delete, and restore are queued. A same-field revision conflict asks the person to keep their edit or the server edit. List, tag, reorder, and archive changes still need a connection. The local task and list caches from the original design are not stored yet.
