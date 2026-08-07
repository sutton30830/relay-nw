# Secrets inventory template — names and owners only

This inventory must never contain a secret value, recovery code, TOTP seed, private key, database password, value hash, or screenshot that reveals one. Use the provider’s key record **name/ID** and an access-controlled vault/provider-console link. A last-four fragment is unnecessary and can leak information; identify records by provider name, purpose, creation date, and console record ID instead.

Statuses: `active`, `rotating`, `retired`, `revoked`, `candidate-obsolete`, `not-configured`. Environments: `development`, `preview`, `production`, `shared` only when sharing is explicitly approved.

| Secret/configuration name | System | Environment | Human owner | Technical consumer | Purpose / minimum permission | Provider record name or ID (not value) | Storage location (not value) | Created | Last rotated | Next review | Status | Evidence / notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `TWILIO_AUTH_TOKEN` | Twilio | production | __________ | Relay server + webhook validation | Current account API access and signature validation; migrate toward scoped API-key use | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Do not store token |
| Future `TWILIO_API_KEY_SID` | Twilio | production | __________ | Relay server | Key identifier for least-privileged API access; treat as controlled metadata | __________ | Vercel env | __________ | __________ | __________ | not-configured | Code change required before use |
| Future `TWILIO_API_KEY_SECRET` | Twilio | production | __________ | Relay server | Least-privileged API authentication | __________ | Vercel Sensitive env | __________ | __________ | __________ | not-configured | Never place beside value in inventory |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase | production | __________ | Relay server | Privileged database/Auth operations | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Legacy key; migration to new secret keys should be planned |
| `AUTH_RATE_LIMIT_SALT` | Relay-generated | production | __________ | Auth rate limiter | HMAC identifiers; no provider access | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Must be distinct from service-role key |
| `INTAKE_RATE_LIMIT_SALT` | Relay-generated | production | __________ | Intake rate limiter | HMAC identifiers; no provider access | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Must not use repository fallback in production |
| `STRIPE_SECRET_KEY` | Stripe | production | __________ | Relay billing server | Live billing API; restricted permissions if supported | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Must be live-only and distinct from sandbox |
| `STRIPE_WEBHOOK_SECRET` | Stripe | production | __________ | Stripe webhook route | Verify one production endpoint | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Unique per endpoint/mode |
| `BILLING_RECONCILIATION_SECRET` | Relay-generated | production | __________ | Reconciliation caller/route | Authenticate reconciliation trigger | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Never reuse Stripe key |
| `RESEND_API_KEY` | Resend | production | __________ | Relay email | Sending-only, domain-scoped where available | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Separate development key |
| `SENTRY_AUTH_TOKEN` | Sentry | production build | __________ | Vercel build | Source-map/release upload only | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | No runtime access unless justified |
| `OPENAI_API_KEY` | OpenAI | production | __________ | Voicemail processing | Project-scoped transcription/summary with spend controls | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Separate development project/key |
| `CRON_SECRET` | Relay-generated/Vercel | production | __________ | Vercel cron routes | Bearer authentication for scheduled jobs | __________ | Vercel Sensitive env | __________ | __________ | __________ | __________ | Verify all cron consumers after rotation |
| `LEADS_PASSWORD` | Retired Relay gate | any discovered scope | __________ | None in current code | Obsolete shared-password gate | __________ | __________ | __________ | __________ | __________ | candidate-obsolete | Confirm no supported rollback, then revoke/remove under authorization |
| `LEADS_COOKIE_SECRET` | Retired Relay gate | any discovered scope | __________ | None in current code | Obsolete shared-password cookie signing | __________ | __________ | __________ | __________ | __________ | candidate-obsolete | Confirm no supported rollback, then revoke/remove under authorization |

Duplicate a row for Development and Preview. Never place one provider record on both a non-production and production row.

## Public or non-secret configuration register

These values still need ownership and environment separation, but they are not privileged secrets. Do not mislabel public client configuration as a secret; doing so can hide the controls that actually matter.

| Name | Classification | Environment owner | Separation / review evidence |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public client key; authorization depends on RLS | __________ | Distinct production and development Supabase projects/keys; RLS test evidence |
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` | Public service endpoint | __________ | Correct project per Vercel scope |
| `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` | Ingestion endpoint, not an auth secret; abuse controls still matter | __________ | Correct Sentry project/environment; alert test |
| `TWILIO_ACCOUNT_SID` | Provider account identifier, controlled metadata | __________ | Correct account/subaccount decision and environment |
| `STRIPE_PRICE_ID` / `STRIPE_SETUP_FEE_PRICE_ID` | Provider object identifiers | __________ | Live IDs only in Production; sandbox IDs in non-production |
| `APP_BASE_URL`, `INTAKE_URL`, `SCHEDULING_URL` | Public URLs | __________ | Correct domain/environment and signed callback configuration |
| `ADMIN_ALERT_EMAIL`, `ALERT_FROM_EMAIL` | Personal/business contact data, not a credential | __________ | Current owner, domain/DNS, delivery test |

## Environment separation attestation

Complete with provider **record names/IDs only**, never values.

| Provider | Development resource/key record | Preview resource/key record | Production resource/key record | Distinct confirmed by | Date |
|---|---|---|---|---|---|
| Supabase | __________ | __________ | __________ | __________ | __________ |
| Twilio | __________ | __________ | __________ | __________ | __________ |
| Stripe | __________ | __________ | __________ | __________ | __________ |
| Resend | __________ | __________ | __________ | __________ | __________ |
| Sentry | __________ | __________ | __________ | __________ | __________ |
| OpenAI | __________ | __________ | __________ | __________ | __________ |
| Relay-generated secrets | __________ | __________ | __________ | __________ | __________ |

## Quarterly review

- [ ] Every active row has a named human owner and one technical consumer.
- [ ] Provider console record exists, permission is least privilege, and last-used activity is expected.
- [ ] Production and non-production record names/IDs are distinct.
- [ ] Vercel environment scope and Sensitive flag are correct; team-level sharing is justified.
- [ ] Departed staff, dormant keys, stale OAuth apps, old webhook endpoints, and predecessor credentials are removed under authorization.
- [ ] Candidate-obsolete items have an owner, decision, and due date.
- [ ] Rotation and recovery evidence links contain no values.
- [ ] Two reviewers sign the inventory.

**Reviewer 1:** __________  **Reviewer 2:** __________  **Date:** __________
