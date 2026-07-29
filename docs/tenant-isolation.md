# Relay NW tenant-isolation contract

This document describes the isolation boundary enforced by the application and
the Phase 2 migration. `account_id` is the tenant key. A record ID, URL
parameter, request-body field, cookie, phone number, or provider SID never
grants authority by itself.

## Customer-owned table inventory

| Table | Ownership | Isolation rule |
| --- | --- | --- |
| `accounts` | Tenant root | Primary key is the account boundary. Customer access comes from an active `account_users` membership. |
| `account_settings` | Tenant | `account_id` primary key, non-null, cascading account FK. |
| `account_carrier_profiles` | Tenant | `account_id` primary key, non-null, cascading account FK. |
| `account_phone_numbers` | Tenant | Non-null `account_id`; phone number has one owner; one primary number per account; assignment is a locked service-role RPC. |
| `account_users` | Tenant | Non-null `account_id`; membership is unique per account/user and account/email. |
| `account_audit_events` | Tenant | Non-null `account_id`; all inserts include the resolved account. |
| `leads` | Tenant | Non-null `account_id`; call, SMS, recording, transcript, and summary evidence remains on the owning lead. |
| `opt_outs` | Tenant | Non-null `account_id`; uniqueness is `(account_id, phone)`. |
| `inbound_messages` | Tenant | Non-null `account_id`; duplicate suppression includes the account and provider MessageSid. |
| `calls` | Tenant | Non-null `account_id`; uniqueness is `(account_id, call_sid)`; lead references must have the same account. |
| `messages` | Tenant | Non-null `account_id`; uniqueness is `(account_id, twilio_message_sid)`; lead and call references must have the same account. |

`webhook_events` and `stripe_events` are platform-operational tables with an
optional tenant association. Their `account_id` is intentionally nullable:
unresolved signed provider events must be observable without being attributed
to a customer. Tenant-facing reads of these tables require an explicit
`account_id`.

`setup_requests`, `platform_operators`, `platform_operator_invites`,
`platform_audit_events`, and `auth_rate_limit_events` are platform-owned, not
customer-owned.

## Authority and lookup rules

- Customer routes take `account_id` from the authenticated membership. An
  account-selection cookie is only a preference among memberships already
  proven for that user.
- Customer request bodies and URL query parameters cannot select another
  tenant. Record operations require both the authenticated `account_id` and
  the record ID.
- Operations routes require a platform-operator action permission and resolve
  an account from the explicit Operations slug. A submitted `account_id` does
  not override that lookup.
- Twilio webhooks reconcile all available tenant evidence. A CallSid is checked
  in calls and leads. A MessageSid is checked in messages, inbound messages,
  and leads. The relay-number `To` lookup is checked independently. Conflicting
  or ambiguous evidence is unresolved and causes no tenant write or provider
  action.
- Outbound SMS always uses the relay number on the resolved account runtime
  configuration.
- Recording playback requires both the authenticated account and RecordingSid
  to match a lead before Relay fetches audio from Twilio.
- Closing an account and releasing a number are separate actions. Number
  release locks the account and succeeds only when that exact account is both
  archived and technically closed.

## Deliberate cross-account workflows

These are platform workflows, not customer tenant queries:

- authentication membership discovery by immutable Auth user ID or normalized
  exact email;
- provider-event account resolution by Stripe/Twilio identifier;
- platform-operator account lists and explicit slug lookups;
- retention cleanup;
- scheduled lists of active accounts or stale transcription jobs.

Each workflow either returns an account ID that downstream writes must reuse,
requires platform authority, or performs account-neutral retention. Ambiguous
provider identity fails closed.

## Credential boundary

The environment module, Supabase service-role client, and Supabase server
barrel import `server-only`. Client components may use only erased
`import type` imports from the Supabase barrel. The regression suite parses
every client module and fails on a value import of the environment or server
Supabase modules.

## Migration and deployment

1. Back up the database.
2. Run
   `docs/migrations/2026-07-29-tenant-isolation-hardening.sql` in Supabase.
   Its preflight deliberately aborts on null ownership, cross-account foreign
   keys, ambiguous provider SIDs, invalid relay numbers, or multiple primary
   numbers. Investigate rather than automatically rewriting any failing row.
3. Confirm the migration completes before deploying the application change.
   Relay-number assignment and release use RPCs created by the migration.
4. Deploy the application.
5. Run signed missed-call, SMS reply, recording, playback, and manual-reply
   smoke tests for two non-production businesses.

The migration is additive and idempotent. It has not been executed by Codex.
