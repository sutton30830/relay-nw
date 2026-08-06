# Provider failure visibility and recovery

Relay keeps its existing `leads`, `messages`, `webhook_events`, and `stripe_events`
as the authoritative provider records. `provider_action_events` is the common,
tenant-scoped view that explains failures and recovery consistently.

## Operator response

1. Open **Operations → Account → Diagnostics → Provider actions**.
2. Confirm the account, action, provider identifier, provider status/code, attempts,
   retry eligibility, and recommended next action.
3. If the provider identifier exists, reconcile from the provider before retrying.
4. Never retry an SMS under the same action after an ambiguous timeout or provider
   acceptance. Wait for its signed callback or contact the person another way.
5. Replay webhooks only with the original provider identifier. Stripe and scheduled
   billing failures should be recovered through reconciliation, never a second charge.

## Visibility and recovery matrix

| Path | Customer-visible | Operator-visible | Retry | Suppressed / unsupported |
|---|---|---|---|---|
| Automatic missed-call SMS | Delivery failure or configuration block | Twilio SID, status/code, attempts, callback evidence | Never automatic; callback reconciliation or manual contact | Cooldown, opt-out, and disabled texting are expected suppressions |
| Manual reply | Plain delivery guidance | SID, provider status/code, idempotency reservation | A new deliberate send only after review; same request key cannot duplicate | Opt-out is suppressed |
| SMS delivery callback | Failed/undelivered guidance | Sanitized webhook plus action history | Callback replay is idempotent | Duplicate/stale callbacks cannot downgrade delivered |
| Landline/unreachable | “Cannot receive texts”; call instead | Twilio 30006/21614 or carrier code | Never for landline; review other permanent failures | None |
| Voice/dial/recording webhooks | Failure only when the customer must act | Sanitized payload metadata and correlation ID | Replay same provider event when safe | Raw body and credentials are never stored |
| Recording retrieval | Plain unavailable message | Recording SID and HTTP/provider failure | Safe GET retry unless provider says missing | Missing/unlinked recording is not cross-tenant searched |
| Transcription/summary | Transcript/summary availability and next action | Model status, quality reason, attempts | Provider failures may retry after stale lock; summary can retry independently | Short, silent, hallucinated, or disagreeing audio is quality suppression, not outage |
| Owner SMS/email | Setup or delivery explanation | Twilio/Resend identifier and status | Resend uses provider idempotency; owner SMS uses an atomic local reservation | Missing recipient/provider/A2P is configuration suppression |
| A2P | Registration/rejection next step | Campaign SID, provider status/errors | Manual sync after carrier or operator action | Pending review is not a call outage |
| Stripe webhooks | Billing attention when unresolved | Stripe event ledger plus standardized action | Stripe replay and reconciliation are idempotent | Unresolved tenant identity is operator-only and never guessed |
| Scheduled billing reconciliation | Billing issue when unresolved | Daily per-account attempt and result | Automatic next reconciliation is safe | Accounts with no Stripe identifiers are skipped |
| Scheduled transcription recovery | Transcript failure when actionable | Per-lead transcription action and stale-lock evidence | Automatic only before provider acceptance and through atomic lead claim | Active non-stale work is skipped |

## Known boundary

A webhook with no authoritative account evidence cannot be written into a tenant
action ledger. It remains visible in platform logs/alerts only; Relay deliberately
does not guess an account. Provider delivery beyond Resend acceptance is not yet
available because no Resend delivery webhook is configured.

## Release order

Apply `docs/migrations/2026-08-05-provider-action-events.sql` in a controlled window,
verify both RPC grants, then deploy the matching code. Do not deploy the code first.
