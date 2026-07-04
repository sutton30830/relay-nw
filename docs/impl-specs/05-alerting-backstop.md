# Spec 05 — Alerting that cannot vanish silently

**Priority:** Before account #5. **Est. size: S.**

## Problem

Admin email alerts are the designed backstop for every failure the webhook event log can't capture (including Supabase itself being down — `lib/env.ts:113-115` says so explicitly). But the backstop has no backstop:

- `sendEmail` failures return `{ sent: false }` with only a `console.error` (`lib/email.ts:100-113`); **no caller of `notifyAdminOperationalIssue` checks the return value** (verified: every call site in `lib/missed-call.ts`, `lib/twilio.ts`, `lib/twilio/unresolved-account.ts`, `app/api/twilio/*` discards it).
- If `RESEND_API_KEY`/`ADMIN_ALERT_EMAIL` are unset, alerts are "skipped" with a `console.info` (`lib/email.ts:82-89`). The production boot warning (`lib/env.ts:116-128`) fires once at cold start and scrolls away.
- Sentry is installed and configured (`@sentry/nextjs`, `sentry.server.config.ts`, `instrumentation.ts`) but is only used for unhandled exceptions — a *handled* operational failure whose alert email also fails reaches no human.

## Risk if unfixed

Resend suspends the key / hits quota / the domain's DNS breaks. From that moment every "SMS send failed", "unresolved webhook", "transcription failed" alert evaporates. The operator believes silence means health — the precise failure mode the June hardening pass was built to prevent, reintroduced one layer up.

## Exact change

All in `lib/email.ts`:

1. Import Sentry: `import * as Sentry from "@sentry/nextjs";`
2. In `sendEmail`, on **failure** (the `error` branch and the `catch` branch — NOT the skipped branch), add:

```ts
Sentry.captureMessage("Email alert delivery failed", {
  level: "error",
  tags: { tag: input.tag },
  extra: { subject: input.subject, error: /* message string */ },
});
```

3. In `sendEmail`, in the **skipped** branch, escalate only for the operator-critical tag:

```ts
if (input.tag === "admin_operational_issue") {
  Sentry.captureMessage("Admin alert skipped: email backstop not configured", {
    level: "warning",
    tags: { tag: input.tag },
    extra: { hasResendApiKey: Boolean(env.resendApiKey), hasRecipient: Boolean(input.to) },
  });
}
```

   (Owner-notification skips stay quiet — a tenant without `owner_email` is a known onboarding state, checked by `scripts/verify-account.mjs`; flooding Sentry with those would train the operator to ignore it.)
4. Wrap both `Sentry.captureMessage` calls in try/catch that only `console.error`s — the alert-about-the-alert must never throw into a webhook hot path.
5. If `SENTRY_DSN` is unset, `captureMessage` is a no-op — acceptable; the executive-verdict manual check requires `SENTRY_DSN` in production, and `lib/env.ts` already warns.

Chosen design: Sentry (already wired, zero new infrastructure) rather than a second email provider or a status table — the failure domains are disjoint (Resend/DNS vs Sentry ingest), which is all a backstop needs.

## Tests required

New file `tests/alert-backstop.test.mjs` (loadTsModule of `lib/email.ts`, mocking `resend`, `@sentry/nextjs`, `@/lib/env`, `@/lib/supabase`):

1. `a Resend API error captures a Sentry message tagged with the email tag` — mock `emails.send` → `{ error: {...} }`; assert `captureMessage` called with level error.
2. `a thrown Resend exception captures a Sentry message` — mock `emails.send` throws; same assertion.
3. `a skipped admin_operational_issue alert captures a Sentry warning` — env without key; call `notifyAdminOperationalIssue`; assert warning captured.
4. **Negative tests:** `a successful send captures nothing` and `a skipped owner notification captures nothing` — assert `captureMessage` uncalled (guards against alert-noise regression).
5. `a Sentry failure never throws out of sendEmail` — mock `captureMessage` throws; assert `sendEmail` still resolves `{ sent: false }`.

## Acceptance criteria

- Every failed email alert produces a Sentry event; every skipped **admin** alert produces a Sentry warning; success and skipped-owner paths produce nothing.
- No webhook route's behavior changes (sendEmail still never throws).
- `npm run test` green.

## Out of scope

Do NOT touch: any call site of the notify functions; Resend configuration; Sentry config files; no health-check endpoint, no second email provider, no alert digest/counter (residual-risks lists an "alerts sent/failed" line in the weekly digest as a later nicety).
