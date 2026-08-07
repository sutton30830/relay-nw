# Relay NW pilot incident response

Use this runbook for the three-business pilot. The operator-only source of truth is
**Operations → Monitoring**, followed by the affected account’s **Diagnostics**.
Customer pages intentionally contain plain-language service status, not provider
codes or cross-account evidence.

## 1. Detect and acknowledge

- Start with critical findings: missed calls without leads, eligible calls without
  a text attempt, webhook processing failures, ambiguous phone mappings, or stale
  billing reconciliation.
- Treat the configured thresholds shown on the Monitoring page as the alert contract.
  Do not call a single SMS failure an outage before the minimum sample is reached.
- Expected cooldown/opt-out suppression, duplicate callbacks with identical evidence,
  and uncertain/short voicemail suppression are normal controls—not incidents.
- Record the first observation time, business, alert fingerprint, and operator owner.
  Repeated observations of the same account/rule share one fingerprint and daily key.

## 2. Scope

- Open the business’s Diagnostics and confirm `account_id`, provider identifier,
  correlation ID, timestamps, last successful call/SMS, A2P, blocker, and billing state.
- Compare another pilot business. If only one account is affected, suspect its number,
  forwarding, A2P, or tenant configuration. If several are affected, suspect Relay,
  Twilio, Supabase, Stripe, Vercel cron, or a shared credential.
- Never assign an unresolved webhook to a business by phone fragments or timing.

## 3. Contain

- Calls: preserve the Twilio number and webhook evidence; do not change forwarding
  until the mapping is confirmed. For a missed lead gap, contact the caller only after
  establishing the correct business.
- SMS: turn off automatic text-back for the affected account if duplicate-send risk is
  unclear. Never automatically retry an accepted/ambiguous automatic SMS.
- Billing: do not create another charge or subscription. Stripe remains authoritative.
- Security: keep invalid signatures rejected. Do not enable unsigned production webhooks.

## 4. Communicate

- Tell only affected customers, in plain language: what function is affected, what
  continues working, any safe workaround, and when the next update will arrive.
- Do not expose provider codes, raw webhook data, credentials, another tenant, or an
  unconfirmed cause. Expected transcription suppression needs no outage notice.

## 5. Recover or replay

- Fix configuration/code first. Replay only the original idempotent webhook/provider
  identifier. Confirm provider acceptance before any message retry.
- Use Twilio callbacks to reconcile accepted SMS; for permanent/landline errors, call
  instead. Use the atomic transcription retry after stale locks or transient failures.
- Reconcile billing from the existing Stripe customer/subscription. For stale cron,
  verify Vercel invocation and `CRON_SECRET`, then run one authenticated job execution.

## 6. Verify recovery

- Place one signed real missed call and confirm the call row, tenant-scoped lead,
  recording (when left), and owner visibility.
- If texting is approved/enabled, confirm exactly one outbound attempt and its signed
  delivery callback. Verify no cross-tenant rows and no duplicate customer message.
- Confirm Monitoring shows a fresh success/check-in and the actionable finding clears.
  Re-check the provider console and Sentry for residual failures.

## 7. Document and prevent

- Record the timeline, affected accounts/call or message IDs, customer communication,
  containment, replay, verification, and final cause in the account/platform audit trail.
- Add a regression or failure-injection test, then adjust a threshold only with evidence.
  Review number uniqueness, callback URL validation, idempotency, and runbook gaps.
- Deploy follow-up changes only after full tests, typecheck, build, and explicit approval.
