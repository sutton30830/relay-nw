# Spec 02 — Make A2P gating unbypassable in code

**Priority:** Before account #5. **Est. size: S.**

## Problem

`account_settings.a2p_registration_status` exists (`supabase.sql:31-33`) but is display-only. Evidence: `grep -rn getA2pRegistrationStatus` shows exactly three consumers — the settings page UI (`app/settings/page.tsx:46`), the accounts helper itself, and `scripts/verify-account.mjs` (a warning). Nothing in the send path or the settings write path reads it. `app/api/settings/route.ts:79-81` lets any `owner`-role user set `sms_enabled = true` with zero A2P check. Every send path gates only on `account.smsEnabled` (`lib/missed-call.ts:130`, `app/api/leads/[id]/reply/route.ts:62`, `lib/twilio.ts:37`, `app/api/sms-test/start/route.ts`).

Also: `getA2pRegistrationStatus` (`lib/supabase/accounts.ts:428-440`) swallows errors and returns `null` — a lookup failure is indistinguishable from "not started," which is the wrong default for a compliance gate (must fail closed as "not approved," which `null` does satisfy, but silently — no log).

## Risk if unfixed

You (or a future owner-role pilot user clicking around Settings) enable texting on an account whose 10DLC campaign isn't approved. Twilio filters or carriers block the traffic, error 30034s pile up, and in the worst case the violation gets attributed to the sole-proprietor brand registration that the whole business depends on. The compliance moat is the product; the code should defend it.

## Exact change

### 1. `app/api/settings/route.ts`

Replace the owner-only `sms_enabled` block:

```ts
if (session.role === "owner") {
  const wantsSmsEnabled = formData.get("sms_enabled") === "on";

  if (wantsSmsEnabled && !session.account.smsEnabled) {
    // Turning texting ON requires an approved A2P campaign. Fail closed on
    // lookup failure: a status we cannot read is not an approved status.
    const a2pStatus = await getA2pRegistrationStatus(session.accountId);

    if (a2pStatus !== "approved") {
      redirect("/settings?error=a2p_not_approved");
    }
  }

  update.sms_enabled = wantsSmsEnabled;
}
```

Import `getA2pRegistrationStatus` from `@/lib/supabase`. Turning SMS **off** is always allowed. Leaving it on when already on is allowed (no re-check; the status page shows drift).

### 2. `lib/supabase/accounts.ts` — make the lookup loud

In `getA2pRegistrationStatus`, replace the silent `return null` on error with:

```ts
if (error) {
  console.error("Could not read a2p_registration_status; treating as not approved", {
    accountId,
    error: error.message,
  });
  return null;
}
```

(Behavior unchanged — `null` is already treated as not-approved by the new gate — but the failure is now visible.)

### 3. `app/settings/settings-form.tsx` (or wherever the settings page renders errors)

Add the `a2p_not_approved` error message: "Texting can't be enabled until this account's A2P registration is approved. Update the status with the provisioning script first." Match the existing `?error=` rendering pattern on the page.

### 4. `scripts/provision-account.mjs`

When provisioning with `smsEnabled: true`, refuse unless the script is also setting/reading `a2p_registration_status = 'approved'`. Follow the script's existing validation/error style; print the same message as the settings page.

## Tests required

New file `tests/a2p-gating.test.mjs` (loadTsModule convention, mock `@/lib/auth`, `@/lib/supabase`, `next/navigation`):

1. `owner enabling sms with a2p approved persists sms_enabled true` — mock `getA2pRegistrationStatus` → `"approved"`, assert `updateAccountSettings` called with `sms_enabled: true`.
2. `owner enabling sms with a2p in_progress is refused` — mock → `"in_progress"`, assert redirect to `/settings?error=a2p_not_approved` and `updateAccountSettings` not called with `sms_enabled: true`.
3. **Negative test:** `a2p status lookup failure fails closed` — mock → `null`, assert refusal (this is the regression guard: if someone later makes `null` pass, this fails).
4. `owner disabling sms never consults a2p status` — assert `getA2pRegistrationStatus` uncalled when checkbox is off.

Unskip the spec-02 pinned test in `tests/compliance-gaps.pinned.test.mjs`.

## Acceptance criteria

- `sms_enabled` cannot transition false→true through the settings route unless `a2p_registration_status = 'approved'`.
- Lookup failure blocks enablement and logs an error.
- Admin role still cannot touch `sms_enabled` at all (existing behavior preserved).
- `npm run test` green with pinned test unskipped.

## Out of scope

Do NOT touch: the send paths (`lib/missed-call.ts`, reply route, `sendOwnerSms`) — `sms_enabled` remains the single runtime send gate, this spec only hardens how it gets turned on; the `account_settings` schema; any UI beyond the one error message; no DB trigger (a check constraint spanning two columns of the same row would fight the provisioning flow where status flips after enablement is requested — the route-level gate is the decision, chosen because both writes go through exactly two choke points that are now both guarded).
