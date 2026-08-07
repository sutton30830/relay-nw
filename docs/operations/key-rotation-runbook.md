# Key-rotation runbook

## Guardrails

Do not create, reveal, replace, revoke, or delete a credential without an approved change/incident ticket and explicit authorization from the credential owner. Never paste values into Git, tickets, chat, screenshots, shell history, logs, or this runbook. Record only the provider key name/ID, owner, environment, timestamps, and evidence link in the secrets inventory.

Use two people for production rotations: an **executor** with provider/Vercel access and a **verifier** who watches health and confirms evidence. Emergency compromise rotation may compress the overlap window, but it does not waive verification or documentation.

## Standard zero-downtime sequence

1. **Scope.** Identify the inventory row, consumers, Vercel environment(s), provider permissions, compromise status, rollback owner, and acceptable maintenance window. Search by variable **name**, never value.
2. **Prove separation.** Confirm the development/test credential and resource are different from production. Stop if the same provider credential is used in more than one environment.
3. **Baseline.** Record current production deployment, provider health, Sentry state, `/ops/monitoring`, recent signed webhook success, and a non-destructive smoke result. Do not send a real SMS/email or charge unless separately authorized.
4. **Create successor.** In the provider, create the least-privileged replacement with a name such as `relay-production-YYYY-MM`. Keep the predecessor active when the provider permits overlap.
5. **Stage only in the intended scope.** Vercel Project → Settings → Environment Variables → update the named variable in **Production only** (and mark Sensitive). Do not select Preview/Development unless their own distinct credential is being rotated. A Vercel change affects new deployments only.
6. **Deploy.** Redeploy the approved production commit. Do not redeploy an unrelated branch. Record deployment ID and time.
7. **Verify successor use.** Check startup, authenticated application read, `/ops/monitoring`, Sentry, provider request/key logs, and the variable-specific smoke checks below. Confirm the new provider key record shows use and the old record stops receiving new use.
8. **Revoke predecessor.** Only after verification and rollback approval, revoke/delete the old provider credential. For a suspected compromise, revoke as soon as the replacement is serving, then investigate unauthorized use.
9. **Remove obsolete copies.** Remove the predecessor from Vercel scopes, local ignored files, CI, provider integrations, password manager notes, and dormant deployments or machines. Do not reveal values to compare them; use provider key IDs/names and creation dates.
10. **Close.** Re-run `npm run security:check`, targeted tests, typecheck/build as appropriate; update inventory dates/status; attach provider audit events, Vercel deployment/environment-name evidence, smoke results, executor/verifier, and exceptions.

Vercel’s documented order is provider-create → Vercel update in the correct environment → redeploy → verify → provider invalidate. See [Rotating environment variables](https://vercel.com/docs/environment-variables/rotating-secrets).

## Credential-specific checks

| Inventory name | Safe rotation method | Verification before predecessor revocation |
|---|---|---|
| `TWILIO_AUTH_TOKEN` | Prefer an approved migration to a Restricted/Standard API key. If retaining the account token, use Twilio’s secondary Auth Token promotion flow; validate webhook signatures during overlap planning because inbound validation also depends on the account token. | Twilio API read succeeds, a separately authorized signed test callback validates, no invalid-signature spike, call/SMS/recording retrieval works. [Twilio secondary token](https://www.twilio.com/docs/iam/api/secondary_authtoken) |
| Future `TWILIO_API_KEY_SID` + `TWILIO_API_KEY_SECRET` | Create a least-privileged, environment-specific key in the correct account/subaccount; deploy both name and secret; revoke old key by provider record ID. | API reads and required create/update operations succeed; callbacks still validate with the correct account auth secret. |
| `SUPABASE_SERVICE_ROLE_KEY` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Current keys are legacy JWT-based keys. Plan a code/config migration to Supabase publishable/secret keys before routine rotation. Legacy JWT-secret rotation can invalidate sessions and all legacy keys immediately; treat it as a migration/incident, not a casual rotation. | Auth login/session plan tested, server reads/writes work, RLS isolation test passes, cron/routes work, no 401 spike. [Supabase key migration](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys) |
| `STRIPE_SECRET_KEY` | Create/roll the correct live or sandbox key; prefer a restricted key if Relay’s required API operations fit it. Never substitute a test key into production. | Read-only `npm run verify:billing`, test/sandbox Checkout as authorized, webhook processing unaffected. |
| `STRIPE_WEBHOOK_SECRET` | Workbench → Webhooks → endpoint → Roll secret; use an overlap window (Stripe supports delayed predecessor expiry) long enough to deploy and verify. | Signed event accepted once, invalid signature rejected, Stripe delivery shows 2xx, no duplicate favorable billing state. [Stripe webhook secret roll](https://docs.stripe.com/webhooks#roll-endpoint-signing-secrets) |
| `RESEND_API_KEY` | Create a production-only **Sending access** key restricted to the Relay domain when possible; deploy, verify, then remove the old key. | Provider key log shows a separately authorized test/alert send and expected domain; old key no longer used. [Resend API keys](https://resend.com/docs/dashboard/api-keys/introduction) |
| `SENTRY_AUTH_TOKEN` | Create a scoped build/source-map token, update the build environment, deploy once, confirm source maps, then revoke predecessor. | Build succeeds and a known non-sensitive test error maps to the approved release. |
| `OPENAI_API_KEY` | Create a project/environment-specific restricted key with budget/rate controls; update Production only. | Separately authorized non-customer transcription/summary fixture succeeds; spend/project logs show successor. |
| `CRON_SECRET` | Generate a new random secret in an approved secure channel. Rotation is not naturally dual-key in current code; schedule a short coordinated deploy and expect old queued invocations to fail. | Every Vercel cron route accepts the new bearer token through its normal scheduler and rejects missing/wrong auth; check-in freshness recovers. |
| `BILLING_RECONCILIATION_SECRET` | Coordinated Vercel update/deploy; update only separately authorized callers. | Reconciliation authorization test and next read-only scheduled reconciliation succeed. |
| `AUTH_RATE_LIMIT_SALT`, `INTAKE_RATE_LIMIT_SALT` | Coordinated deploy. Rotation changes HMAC identifiers and begins fresh limiter buckets; record the temporary abuse-control effect. | Login/reset/intake rate-limit tests pass and no raw email/IP is stored. |

## Obsolete-secret removal

Treat a secret as obsolete only after the code search, deployment history, provider last-used timestamp, rollback policy, and owner all agree. For this repository, `LEADS_PASSWORD` is present by **name** in the ignored local environment but has no runtime reference; `LEADS_COOKIE_SECRET` is also from the retired gate. They are candidates, not authorization to delete.

For each candidate: record the name and owner → search current code/config by name → inspect old supported deployments/integrations → confirm no rollback requires it → obtain approval → revoke provider-side if it was a real credential → remove each environment/local copy → deploy if applicable → verify no error → retain provider/Vercel audit evidence. Never commit the removed value or a value hash.

## Failure and rollback

- If the new deployment cannot authenticate, keep the predecessor active, restore the prior environment-variable reference, redeploy the known-good commit, and document the failed attempt.
- If the predecessor was already revoked for compromise, do **not** restore it. Contain the service, create another successor, and follow incident response.
- If both credentials appear in use after the window, find every old deployment/worker/integration before revoking; Vercel environment changes do not update old deployments.
- Rotation is complete only when the predecessor is revoked, all consumers are on the successor, monitoring is clean, inventory is updated, and two people sign off.
