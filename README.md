# Vela

Personal task manager. Internal codename: Project Orbit.

One account on the web app can register, keep tasks, organize lists, set due dates and priorities, and search. Desktop, mobile, and the browser extension are not built yet. Their download cards stay unavailable on purpose.

## Requirements

- Node.js 20 or newer
- pnpm 9.15.9
- MongoDB 7 locally, or any `MONGODB_URI`

Start a local database with Docker:

```bash
docker compose up -d
```

## Setup

```bash
pnpm install
copy apps\api\.env.example apps\api\.env
copy apps\web\.env.example apps\web\.env.local
```

Change `SESSION_SECRET` in `apps/api/.env` before you use the API for anything but a local trial. It must be at least 32 characters.

## Scripts

```bash
pnpm dev        # API on port 4000 and web on port 3000
pnpm test       # unit tests and API integration tests
pnpm e2e        # browser test: sign up, create, edit, complete, reload
pnpm typecheck
pnpm lint
pnpm build
```

Open http://localhost:3000. The web app proxies `/api/v1` to the API, so the session cookie stays on the web origin.

## What works

- Register, sign in, sign out, profile, time zone, password change
- Lists, tags, tasks, subtasks, priorities, due dates, search, filters
- Recurring tasks with occurrence history, skip, and reopen
- Calendar month, week, and day, with reschedule
- In-app reminders stored in MongoDB and shown while the app is open
- Marketing pages and an honest download catalog

## What does not work yet

- Offline editing and multi-device sync (`docs/sync-design.md`)
- Email password recovery (SMTP is not configured)
- Operating-system notifications, email reminders, and mobile push
- Electron, Expo, and the Chrome extension
- Payments

## License

Vela is open source under the [MIT License](LICENSE).

## Docs

- `docs/architecture.md`
- `docs/roadmap.md`
- `docs/data-model.md`
- `docs/api.md`
- `docs/security.md`
- `docs/deployment.md`
