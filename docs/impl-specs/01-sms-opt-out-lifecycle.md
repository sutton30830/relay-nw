# Spec 01 — SMS opt-out lifecycle: START re-opt-in, STOPALL, HELP

**Priority:** Must ship before customer #1. **Est. size: S** (1–2 days including tests).

## Problem

Three gaps in the inbound SMS compliance path (`app/api/twilio/sms/route.ts`):

1. **No re-opt-in.** `OPT_OUT_WORDS` (line 27) records opt-outs into `opt_outs`, but nothing anywhere deletes a row from `opt_outs`. Twilio unblocks a number when the caller texts START, but Relay's app-level suppression is permanent: every future missed call from that caller is marked `skipped_opt_out` forever. Evidence: `grep -rn "opt_outs" lib app` shows inserts (`recordOptOut`, `lib/supabase/messages.ts:165-179`) and reads (`isOptedOut`) only — no delete path in the codebase.
2. **STOPALL not recognized.** Twilio's standard opt-out keyword set is STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT. `OPT_OUT_WORDS` at `app/api/twilio/sms/route.ts:27` omits STOPALL. Twilio still blocks the number at the carrier level, but Relay never records the opt-out, so the owner is never notified, and the lead's `skipped_opt_out` state is never set — Relay will keep attempting sends that fail with Twilio error 21610.
3. **No HELP response.** A HELP inbound falls through to the "forward to owner" branch. Whether the caller receives any HELP auto-response depends on Twilio console configuration this repo can't see. A2P 10DLC campaigns are required to respond to HELP; the approved campaign language promises it.

## Risk if unfixed

A real pilot customer's caller texts STOP during a fat-finger moment, texts START a day later, then misses a call the next week — and never gets the text-back the business is paying for. Neither the caller nor the owner can fix it; only you can, by manually deleting a Supabase row you have no UI for. Separately, a carrier audit or Twilio compliance review that sends HELP and gets silence puts the hard-won A2P approval at risk.

## Exact change

### 1. `lib/supabase/messages.ts` — add `clearOptOut`

```ts
export async function clearOptOut(phone: string, inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "clearOptOut");

  if (shouldSkipDatabaseWrite("opt-out delete", { phone, accountId })) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("opt_outs")
    .delete()
    .eq("phone", phone)
    .eq("account_id", accountId);

  if (error) {
    throw error;
  }
}
```

Export it from `lib/supabase/index.ts` alongside `recordOptOut`.

### 2. `app/api/twilio/sms/route.ts`

- Add `"STOPALL"` to `OPT_OUT_WORDS`.
- Add `const OPT_IN_WORDS = new Set(["START", "UNSTOP", "YES"]);` (Twilio's standard re-opt-in set).
- Add `const HELP_WORDS = new Set(["HELP", "INFO"]);`
- Extend `parseInboundSmsPayload` with `isOptIn` and `isHelp` computed the same way as `isOptOut` (both require `Boolean(from)`).
- In `handleInboundSms`, insert two branches **after** the owner-message check (line 131) and **before** the `isOptOut` branch, in this order: `isOptIn` first, then `isHelp`:

```ts
if (input.isOptIn) {
  await clearOptOut(input.from, account.accountId);
  return "recorded_opt_in" as const;
}

if (input.isHelp) {
  return "answered_help" as const;
}
```

- Add both action strings to `webhookEventNote` with notes "Recorded re-opt-in (START)." and "Answered HELP with business info."
- **HELP response body:** the route currently always returns `emptyTwiml()`. Change `POST` so that when the handled action is `"answered_help"`, it returns a TwiML `<Response><Message>…</Message></Response>` built in `lib/twiml.ts`:

```ts
// lib/twiml.ts
export function helpReplyTwiml(input: { businessName: string }) {
  const body = `${input.businessName} via Relay NW: we text you back when we miss your call. Msg&data rates may apply. Msg frequency varies. Reply STOP to opt out.`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(body)}</Message>\n</Response>`;
}
```

`lib/twiml.ts` already has an XML-escaping helper pattern; reuse or add `escapeXml`. Note: replying to HELP via TwiML is deliverable even for opted-out callers only if Twilio permits it; TwiML `<Message>` replies to an inbound are session messages and are permitted. Do NOT attempt to send a TwiML reply to STOP — Twilio blocks it; rely on Twilio's own STOP confirmation (manual check 1 in the executive verdict).
- **Do not** notify the owner or forward the message for opt-in/help branches. Do log the webhook event (existing code path already does).
- START from a caller who was never opted out: `clearOptOut` deletes zero rows — harmless, still return `recorded_opt_in`.

### 3. Why this design

App-level opt_outs must mirror Twilio's carrier-level state or the two drift apart in the direction that loses customers texts; deleting the row on START is the only place that state can re-converge. The HELP reply is app-side TwiML rather than Twilio console configuration because it must be per-account (business name) and must survive number moves.

## Tests required

Behavioral, `node --test` + `loadTsModule` convention (mock `@/lib/supabase`, `@/lib/twilio`, `@/lib/email`, `@/lib/env`, `@/lib/twiml`), new file `tests/sms-opt-lifecycle.test.mjs`:

1. `START from an opted-out caller calls clearOptOut with the caller phone and account id and returns recorded_opt_in` — assert `clearOptOut` mock called once with normalized phone + accountId.
2. `STOPALL records an opt-out exactly like STOP` — assert `recordOptOut` called.
3. `HELP returns TwiML containing the business name and STOP language` — assert response body includes the account's businessName and "STOP".
4. `START does not notify the owner or forward anything` — assert owner-notify mocks uncalled.
5. **Negative test (regression guard):** `a plain conversational reply still forwards to the owner and does not touch opt_outs` — assert `clearOptOut` and `recordOptOut` uncalled, forward path called. This fails if the new branches over-match.

Also unskip the three matching pinned tests in `tests/compliance-gaps.pinned.test.mjs` (they are source-contract assertions and must pass).

## Acceptance criteria

- STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT all record an opt-out; START, UNSTOP, YES all clear it; HELP gets a TwiML reply with business name, "Msg&data rates may apply", and STOP language.
- `npm run test` green with the three spec-01 pinned tests unskipped.
- No change to STOP behavior other than the STOPALL addition (owner opt-out notification email still sends).
- Webhook event log rows show the new action notes.

## Out of scope

Do NOT touch: the opt-out check in `lib/missed-call.ts` or the reply route (they already read `opt_outs` correctly); Twilio console configuration; the `opt_outs` schema (no new columns); owner-side STOP handling (the owner-message early return stays where it is, before all keyword branches — an owner texting STOP to their own Relay number remains a no-op, which is correct because owner notifications are operational, not marketing).
