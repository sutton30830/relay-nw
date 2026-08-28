# Telephony data compatibility

## Current decision

Phase 4 does not change the database schema. Twilio remains the only registered
telephony adapter and the production default, so per-account provider columns
would not yet select a usable alternative. Existing rows, indexes, constraints,
RLS policies, RPC signatures, reporting queries, and operational evidence remain
unchanged.

Application code uses Relay-owned names (`relayPhoneNumber`,
`providerCallId`, `providerMessageId`, `providerRecordingId`, and
`providerNumberId`). `lib/telephony/persistence.ts` is the compatibility boundary
that maps the existing columns to those runtime names:

| Existing storage | Neutral runtime field |
| --- | --- |
| `account_phone_numbers.phone_number` | `relayPhoneNumber` |
| `account_phone_numbers.twilio_sid` | `providerNumberId` with provider `twilio` |
| `call_sid` | `providerCallId` with provider `twilio` |
| `twilio_message_sid` or `message_sid` | `providerMessageId` with provider `twilio` |
| `recording_sid` | `providerRecordingId` with provider `twilio` |

Rows without provider metadata default to `twilio`. An unknown provider, or an
attempt to write a non-Twilio resource into a legacy SID column, fails closed.
Deprecated runtime and function aliases remain temporarily available for rolling
deploy compatibility; they do not change the stored value or query semantics.

## Deferred migration and trigger

The migration is required before a non-Twilio adapter can be enabled for any
account or before a non-Twilio resource can be persisted. A merged provider
contract, vendor discussion, or unused adapter scaffold is not sufficient reason
to migrate production data.

When that trigger is met, implement and verify an additive migration in this
order:

1. Add constrained provider columns defaulting to `twilio` and neutral provider
   resource-ID columns alongside every legacy identifier. Do not drop or rename
   the legacy columns.
2. Backfill in bounded, restartable batches, deriving `twilio` only for existing
   rows. Record counts before and after each table and stop on ambiguity.
3. Add provider-aware unique indexes that retain `account_id` tenant scope. Keep
   all current unique indexes and foreign keys during the compatibility window.
4. Extend RPCs additively or version them. Keep the deployed RPC signatures until
   all callers have moved and behavior has been compared in production.
5. Preserve RLS, service-role grants, tenant filters, webhook reconciliation, and
   operational reports. Reports should continue labeling actual Twilio evidence
   as Twilio evidence.
6. Dual-read old and new columns, then dual-write with mismatch monitoring. Only
   switch reads after backfill and tenant/adversarial tests pass for every table.

Rollback during the compatibility window is to stop dual-writes and remove only
the new indexes/columns after confirming no non-Twilio rows exist. The existing
columns, constraints, RPCs, and data remain the recovery source throughout.
