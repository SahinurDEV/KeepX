# Security

## Authentication

- Passwords are hashed with bcrypt. The cost is `BCRYPT_COST` (default 12).
- Login errors use one message for unknown email and wrong password. A cached hash is compared when the email does not exist so the request still does the slow work.
- Sessions are 32 random bytes in an httpOnly, `SameSite=Lax` cookie named `vela_session`. The database stores a SHA-256 of `SESSION_SECRET` and the token.
- Logout deletes the session row and clears the cookie.
- Password change requires the current password and deletes other sessions for that user.

## Authorization

Every list, tag, task, occurrence, and reminder query is constrained by the session user id. Ids from another account return 404.

## Request protections

- Helmet headers on the API
- JSON body limit 1 MB
- Origin rejection when an `Origin` header is present and is not `APP_ORIGIN`
- Auth routes rate-limited (20 requests / 15 minutes / IP) outside tests
- `trust proxy` stays off unless `TRUST_PROXY=true`, so clients cannot spoof the rate-limit IP
- Task writes validate ObjectIds, list ownership, tag ownership, and parent ownership
- Idempotency keys stop duplicate creates when the client retries

## Account recovery

`POST /auth/recovery` returns `503` with code `EMAIL_NOT_CONFIGURED` when SMTP is unset. The API does not store a reset token it cannot deliver, and the interface does not claim that email was sent.

## Secrets

`.env` files are gitignored. `.env.example` contains placeholders only. `SESSION_SECRET` must be at least 32 characters.

## Not done yet

- CSRF tokens beyond `SameSite=Lax` and the origin check
- Security headers on the Next.js responses (the API is the hardened JSON surface)
- Audit logging of security events to an external sink
- Penetration test or dependency review beyond `pnpm` install
