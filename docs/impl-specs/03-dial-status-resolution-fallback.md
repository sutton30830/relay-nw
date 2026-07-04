# Spec 03 — Dial-status webhook: fall back to To-number resolution

**Priority:** Before account #5. **Est. size: S.**

## Problem

The dial-status webhook (direct-mode missed-call detection, also aliased as `/api/twilio/voice-status`) resolves its tenant **only** by CallSid: `app/api/twilio/dial-status/route.ts:120` → `resolveAccountByCallSid`, which looks up the `calls` table (`lib/supabase/accounts.ts:232-262`). That row is written by the earlier voice webhook — but the voice route deliberately treats the call-row upsert as non-fatal bookkeeping: `handleDirectMode` catches the upsert failure, logs, and still returns TwiML (`app/api/twilio/voice/route.ts:247-268`).

Chain: transient Supabase error on the voice webhook's `upsertCall` → caller hears ringing normally → dial-status arrives 20 seconds later with `DialCallStatus=no-answer` → CallSid not in `calls` → `unresolved` → `handleUnresolvedTwilioAccount` returns 200 with **zero tenant writes**. No lead. No text. The payload's `To` field — which the voice route successfully used to resolve the same account seconds earlier — is sitting right there unused.

## Risk if unfixed

The exact failure the product exists to prevent: a real customer's missed call produces no text-back and no lead. The operator gets an "Unresolved Twilio dial status webhook" email and has to reconstruct what happened from Twilio logs; the caller has already phoned a competitor. A one-request Supabase blip becomes a lost job.

## Exact change

In `app/api/twilio/dial-status/route.ts`, replace the single-resolver line 120:

```ts
const accountResolution = await resolveAccountSafely(async () => {
  const byCallSid = await resolveAccountByCallSid(callSid);

  if (byCallSid.status === "resolved") {
    return byCallSid;
  }

  // The calls row may be missing (the voice webhook's bookkeeping upsert is
  // deliberately non-fatal). The To number identifies the same tenant.
  const byNumber = await resolveAccountByTwilioNumber(payload.To);

  if (byNumber.status === "resolved") {
    console.warn("dial-status resolved by To-number fallback; calls row was missing", {
      correlationId,
      callSid,
    });
    return byNumber;
  }

  return byCallSid; // preserve the original, more specific unresolved reason
}, "dial status");
```

Import `resolveAccountByTwilioNumber` from `@/lib/supabase`. Then, inside the existing `try` block, the already-present `upsertCall` (line 174) heals the missing row — no further change needed.

Note on `payload.To`: in both direct mode (the `<Dial action>` callback posts the parent call's fields) and forwarding mode, `To` is the tenant's Twilio number, which is exactly what `resolveAccountByTwilioNumber` normalizes and matches against `account_phone_numbers.phone_number` (globally unique, `supabase.sql:45`). A missing/foreign `To` returns `unresolved` and the existing unresolved path handles it — the fallback can only widen resolution to a number that is provably registered to a tenant.

Apply the same fallback in **`app/api/twilio/recording/route.ts:155`** (`resolveAccountByCallSid(recording.callSid)` → same two-step block, reusing `payload.To`... note: recording callbacks post `To` as well; if absent, behavior is unchanged). Rationale: the recording webhook has the same dependency on the calls/leads row existing, and the same fallback restores voicemail attachment via the existing phone-fallback matcher in `updateLeadRecordingByCallSid`.

Do NOT change `resolveAccountByMessageSid` (sms-status): there is no equivalent trustworthy account identifier on that payload (`To` is the *caller's* handset for outbound status callbacks — wrong direction), and a wrong-account write is worse than an unresolved log.

## Tests required

New file `tests/dial-status-fallback.test.mjs` (loadTsModule of `app/api/twilio/dial-status/route.ts` with mocked `@/lib/supabase`, `@/lib/twilio`, `@/lib/missed-call`, `@/lib/twilio/unresolved-account`, `@/lib/twiml`, `@/lib/env`):

1. `unknown CallSid with a registered To number resolves and texts the caller` — mock `resolveAccountByCallSid` → unresolved, `resolveAccountByTwilioNumber` → resolved; assert `handleMissedCall` called with the resolved account and `handleUnresolvedTwilioAccount` NOT called.
2. `known CallSid never consults the To-number fallback` — assert `resolveAccountByTwilioNumber` uncalled when CallSid resolves.
3. **Negative test:** `unknown CallSid AND unregistered To number stays unresolved with the CallSid reason` — both mocks unresolved; assert `handleUnresolvedTwilioAccount` called with reason `call_sid_not_registered` (guards against the fallback ever inventing a tenant).

Unskip the spec-03 pinned test in `tests/compliance-gaps.pinned.test.mjs`.

## Acceptance criteria

- A dial-status webhook whose CallSid is absent from `calls` but whose To number is registered produces a lead and (subject to normal cooldown/opt-out gates) an SMS, plus a `console.warn` marking the fallback.
- Unresolvable webhooks behave exactly as before (200, event log, admin alert, no tenant writes).
- `npm run test` green with pinned test unskipped.

## Out of scope

Do NOT touch: `resolveAccountByMessageSid` or the sms-status route; the voice route's non-fatal upsert design (correct as-is); `lib/supabase/accounts.ts` resolver internals; the unresolved-account handler.
