# Security hardening operations

## Password-reset rate limiting

Password reset is limited durably by both normalized email and client IP. Relay stores
only HMAC identifiers in `auth_rate_limit_events`; raw email addresses and IPs are not
written to the limiter table. The database RPC serializes concurrent requests so separate
Vercel instances cannot independently pass the same limit.

Before deploying the code that consumes this limiter, apply:

`docs/migrations/2026-07-29-auth-rate-limits.sql`

`AUTH_RATE_LIMIT_SALT` is optional but recommended as a dedicated production secret. If
it is omitted, Relay uses the server-only Supabase service-role key as the HMAC secret.
Rotating either value changes limiter identifiers and effectively begins a fresh window.

Reset requests intentionally return the same accepted response for existing, unknown,
rate-limited, provider-error, and delivery-error cases.

## Browser mutation boundary

Authenticated browser mutations accept either:

- an `Origin` matching the request origin or configured `APP_BASE_URL`; or
- `Sec-Fetch-Site: same-origin` when a browser omits `Origin`.

Requests with a foreign origin—or with neither signal—receive `403`. Twilio, Stripe,
cron, public intake, and CSP-report endpoints remain outside this browser-only boundary
and retain their provider signature or secret validation.

## CSP rollout

Relay currently sends CSP as `Content-Security-Policy-Report-Only`. Clickjacking is
already enforced independently with `X-Frame-Options: DENY`; the report-only
`frame-ancestors 'none'` directive prepares the eventual CSP equivalent.

The report endpoint logs only directive names and origins, not complete blocked URLs.
Before enforcement:

1. Run production normally for at least one full business week.
2. Review `CSP report-only violation` entries in Vercel/Sentry-adjacent diagnostics.
3. Exercise sign-in, account selection, inbox, recordings, settings, Operations,
   Stripe redirects, and Sentry error delivery.
4. Classify each violation as an expected asset or a blocked dependency. Narrow or add
   sources only when the product genuinely requires them.
5. Remove `'unsafe-eval'` first if production traces show it is unnecessary.
6. Plan a nonce-based Next.js policy before removing `'unsafe-inline'`.
7. Change the header name to `Content-Security-Policy` only after the production trace
   is clean and the complete test/build/smoke suite passes.

Do not enforce the current policy blindly: Next.js script behavior and monitoring assets
must be verified against the deployed build first.
