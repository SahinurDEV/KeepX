# Security

## Authentication

- Passwords are hashed with bcrypt. The cost is `BCRYPT_COST` (default 12).
- Login errors use one message for unknown email and wrong password. A cached hash is compared when the email does not exist so the request still does the slow work.
- Sessions are 32 random bytes in an httpOnly, `SameSite=Lax` cookie named `vela_session`. The database stores a SHA-256 of `SESSION_SECRET` and the token.
- App tokens are bearer secrets for the browser extensions and the Gmail add-on. The database stores the same style of hash. Revoking one soft-revokes it so Undo can restore the same secret. Changing or resetting the password deletes them. A raw token is shown once.
- Logout deletes the session row and clears the cookie.
- Settings lists unexpired active password sessions for the signed-in account and can sign one out. Signing out another browser soft-revokes it so Undo can restore it. Signing out the current session deletes that row and clears the cookie. The response includes the browser string and whether it is the current session. It does not include the cookie or its hash. App tokens are a separate list.
- Account deletion requires the current password, clears the cookie, and removes that account's lists, tags, tasks, reminders, sessions, tokens, and push devices. A recorded Stripe subscription blocks deletion. This server does not cancel it.
- Password change requires the current password, deletes other sessions and app tokens for that user, and keeps the previous password hash for five minutes so Undo can restore it.

## Authorization

Private lists, tags, tasks, occurrences, reminders, and push devices are constrained by the session user id. A push token is stored and is not returned after registration. It can belong to only one account. The account plan is stored on the server. A profile update cannot change it. A billing notice changes it only when the signature matches `STRIPE_WEBHOOK_SECRET` and the timestamp is within five minutes. A list owner can invite another existing account. That person can read and edit tasks in that list only. Inbox cannot be shared. Ids from another account still return 404 when the list is not shared.

## Request protections

- Helmet headers on the API
- JSON body limit 1 MB
- Origin rejection when an `Origin` header is present and is not `APP_ORIGIN`
- Auth routes rate-limited (20 requests / 15 minutes / IP) outside tests
- `trust proxy` stays off unless `TRUST_PROXY=true`, so clients cannot spoof the rate-limit IP
- Task writes validate ObjectIds, list ownership, tag ownership, and parent ownership
- Idempotency keys stop duplicate creates when the client retries

## Account recovery

`POST /auth/recovery` returns `503` with code `EMAIL_NOT_CONFIGURED` when `SMTP_HOST` or `SMTP_FROM` is unset. In that case the API stores no reset token.

When both are set, the same route returns `204` for every well-formed address. A token is stored and mailed only if that address belongs to an account. The database stores a SHA-256 of `SESSION_SECRET` and the token, with a one-hour TTL. The raw token is only in the email link. A failed send deletes the token and still returns `204`, and the log line does not include the address or the token.

`POST /auth/reset` sets the new password, deletes every session for that user, deletes the reset token, and clears the session cookie. An unknown or expired token returns `400`.

## Secrets

`.env` files are gitignored. `.env.example` contains placeholders only. `SESSION_SECRET` must be at least 32 characters.

## Not done yet

- CSRF tokens beyond `SameSite=Lax` and the origin check
- Security headers on the Next.js responses (the API is the hardened JSON surface)
- Audit logging of security events to an external sink
- Penetration test or dependency review beyond `pnpm` install
