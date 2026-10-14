# Architecture

Internal codename: Project Orbit. Default product name: KeepX.

## What exists

| Package | Role |
| --- | --- |
| `apps/web` | Next.js App Router interface, marketing pages, and download pages |
| `apps/api` | Express REST API, MongoDB persistence, session auth |
| `packages/shared` | Domain types, recurrence, date labels, download catalog |
| `packages/validation` | Zod schemas for API input |
| `packages/api-client` | Typed browser/client for `/api/v1` |
| `packages/ui` | Buttons, inputs, dialogs, badges, theme tokens |
| `packages/config` | Shared TypeScript and ESLint configuration |
| `docs` | Design, API, security, and operations notes |

Desktop (Electron), mobile (Expo), and the Chrome extension are described in `docs/platform-builds.md` and are not packages yet. Empty shells are omitted so `pnpm build` only covers code that can compile.

## Request path

The browser talks only to the Next.js origin. `next.config.ts` rewrites `/api/v1/*` to the API process (`API_PROXY_URL`, default `http://127.0.0.1:4000`). The API sets an httpOnly `vela_session` cookie. Because the browser received that cookie from the web origin, later requests send it with the rewrite.

Server authorization uses the session. The client never chooses the user id for a query.

## Task model

A task row is the current open occurrence of a piece of work.

- Non-recurring completion sets `status` to `completed` and stores `completedAt`.
- Recurring completion writes an `Occurrence` row (the history) and moves `dueAt` to the next instant calculated in the task time zone.
- The series stops when the next instant would pass `until`, or when the number of acted occurrences reaches `count`.
- Skipping writes history with action `skipped` and advances the same way.
- Deleting soft-deletes the series. Restoring clears `deletedAt`.
- Uncomplete rolls back the latest occurrence when one exists, or reopens a non-recurring task.

Weekly rules with `byWeekday` stay aligned to the anchor week. Daily, monthly, and yearly rules advance from the current due instant. Monthly and yearly dates keep the anchor day and clamp to the month length.

## Reminders

A reminder is a MongoDB document with `fireAt` and status `scheduled`, `delivered`, or `cancelled`. Saving a task cancels its previous scheduled reminder and writes a new one. The web client polls `/reminders/pending` and acknowledges delivery. That is in-app delivery while a signed-in client is open. Operating-system notifications, email, and mobile push are not implemented.

## Offline behavior

The web client does not queue mutations. If the browser is offline, the interface says so and leaves controls disabled. See `docs/sync-design.md` for the intended queue.

## Branding

`packages/shared/src/brand.ts` and `packages/shared/src/downloads.ts` are the source for the public name defaults and platform availability. Unavailable platforms have no download URL.
