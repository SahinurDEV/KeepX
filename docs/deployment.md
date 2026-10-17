# Deployment

## Processes

1. MongoDB 7 (Atlas or another hosted replica).
2. `apps/api` listening on `PORT`.
3. `apps/web` (`next start`) with `API_PROXY_URL` pointed at the API.

The browser should call the web origin only. Do not expose the API cookie to a second public site without revisiting `SameSite`, CORS, and HTTPS.

## Environment

See `.env.example`, `apps/api/.env.example`, and `apps/web/.env.example`.

Required in production:

- `MONGODB_URI`
- `SESSION_SECRET` (32+ characters, unique)
- `APP_ORIGIN` (public web origin, https)
- `COOKIE_SECURE=true`
- `API_PROXY_URL` (internal API URL)
- `NEXT_PUBLIC_APP_NAME` matching `APP_NAME`

Leave `TRUST_PROXY=true` only when a reverse proxy overwrites forwarded headers.

Password recovery stays disabled until both `SMTP_HOST` and `SMTP_FROM` are set. Optional: `SMTP_PORT` (default 587), `SMTP_SECURE=true` for implicit TLS, `SMTP_USER`, and `SMTP_PASS`. Leave them unset for local development.

Browser push stays disabled until `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` are all set. The subject is a `mailto:` or `https:` URL. Phone push stays disabled until `EXPO_ACCESS_TOKEN` is set. The Android package in this repo does not register an Expo token.

Billing stays disabled until `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_ID` are all set. Checkout does not change the plan. Only a signed webhook does.

## Database

- Take scheduled snapshots of the MongoDB database.
- Restore drills are an operator task; this repo does not run them.
- Indexes are created by Mongoose on startup (`autoIndex` is left on for this version). For a large production dataset, switch to explicit index migrations before peak traffic.
- There is no separate migration framework. Schema changes need a reviewed script plus a backup.

## Logging and monitoring

The API logs one JSON line per request: time, request id, method, path, status, duration. It does not log bodies, cookies, or passwords.

Health check: `GET /api/v1/health`. Alert on non-200.

## Docker

`docker-compose.yml` runs MongoDB only, for local development. Application images are not published from this slice.

## CI

`.github/workflows/ci.yml` installs dependencies and runs lint, typecheck, test, and build. API tests start an in-memory MongoDB and need network access the first time the binary is downloaded.
