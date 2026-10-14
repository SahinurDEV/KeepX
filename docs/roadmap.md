# Roadmap

## Done in this slice

- Monorepo, lint, typecheck, unit tests, API integration tests, and production builds
- Register, login, logout, password change, profile and time zone
- Lists, tags, tasks, subtasks, priorities, due dates, search, filters
- Recurrence with occurrence history, skip, and uncomplete
- Calendar month, week, and day views with rescheduling
- In-app reminders stored on the server
- Marketing, help, privacy, terms, pricing, and honest download pages
- User isolation on the server
- Playwright coverage for sign-up, create, edit, complete, and reload

## Next

1. IndexedDB mutation queue, revision conflicts, and a visible sync status. Design is in `docs/sync-design.md`.
2. SMTP-backed password recovery using the existing “not configured” response as the gate.
3. Electron shell with context isolation, preload IPC, notifications, and one verified desktop package before any download button is enabled.
4. Expo app sharing `@vela/shared`, `@vela/validation`, and `@vela/api-client`.
5. Manifest V3 extension limited to quick add and an explicit “save this tab” action.

## Later

- Push, email, and mobile notification providers
- Billing and server-side entitlements
- Per-occurrence recurrence exceptions
- Collaborative lists

## Acceptance for the current MVP

A local user can register, keep tasks after a reload, organize lists, set due dates and priorities, search, and cannot read another account’s tasks. `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build` are the gates.
