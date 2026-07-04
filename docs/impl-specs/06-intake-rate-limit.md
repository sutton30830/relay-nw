# Spec 06 — Durable intake rate limiting

**Priority:** Before account #25 (abuse cost, not correctness). **Est. size: S.**

## Problem

The public intake form's rate limiter is a per-instance in-memory `Map` (`app/api/intake/route.ts:11-90`). On Vercel, concurrent instances each hold an independent bucket and instances recycle constantly, so the effective limit is roughly "5 per instance per lifetime" — i.e., nearly unenforced. This was consciously deferred in the June audit (`docs/production-readiness.md:37`); this spec is the payoff of that IOU. The honeypot and validation still stand, but a dumb POST loop bypasses both cost controls: unbounded `setup_requests` rows and unbounded admin notification emails (Resend spend + inbox burial of real alerts).

## Risk if unfixed

A scraper or grudge-bot posts the form a few thousand times overnight. `setup_requests` fills with garbage, every insert fires `notifyAdminNewSetupRequest`, Resend quota burns out — and with it the operational alert channel (compounding the spec-05 problem), all while real setup requests drown.

## Exact change

Replace the in-memory limiter with counting inserts in Postgres — the table itself is the rate-limit state.

### 1. `supabase.sql` — one new column + index on `setup_requests`

```sql
alter table public.setup_requests add column if not exists submitter_hash text;
create index if not exists setup_requests_submitter_created_at_idx
  on public.setup_requests (submitter_hash, created_at desc)
  where submitter_hash is not null;
```

(A salted hash, not the raw IP — no PII-grade identifier at rest for a public form.)

### 2. `lib/supabase/setup-requests.ts`

- Extend `createSetupRequest` input with `submitterHash?: string | null`, written to the new column.
- Add:

```ts
export async function countRecentSetupRequests(input: {
  submitterHash: string;
  since: string; // ISO
}) {
  const { count, error } = await supabaseAdmin
    .from("setup_requests")
    .select("id", { count: "exact", head: true })
    .eq("submitter_hash", input.submitterHash)
    .gte("created_at", input.since);

  throwIfSupabaseError(error);
  return count ?? 0;
}

export async function countSetupRequestsSince(since: string) {
  const { count, error } = await supabaseAdmin
    .from("setup_requests")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);

  throwIfSupabaseError(error);
  return count ?? 0;
}
```

### 3. `app/api/intake/route.ts`

- Delete the `Map`, prune helpers, and `recordSubmissionAttempt` (lines 11-12, 53-90).
- Add `import { createHash } from "node:crypto";` and:

```ts
function submitterHash(ip: string) {
  return createHash("sha256")
    .update(`${process.env.INTAKE_RATE_LIMIT_SALT ?? "relay-nw-intake"}:${ip}`)
    .digest("hex");
}
```

- In `POST`, after computing `ip` (keep `requestIp` as-is), before parsing the form:

```ts
const hash = submitterHash(ip);
const hourAgo = new Date(Date.now() - SUBMISSION_WINDOW_MS).toISOString();

// Fail OPEN on limiter errors: a Supabase blip must not turn away a real
// prospect; the per-IP cap is an abuse control, not a security boundary.
let overLimit = false;
try {
  const [perIp, global] = await Promise.all([
    countRecentSetupRequests({ submitterHash: hash, since: hourAgo }),
    countSetupRequestsSince(hourAgo),
  ]);
  overLimit = perIp >= MAX_SUBMISSIONS_PER_WINDOW || global >= MAX_GLOBAL_SUBMISSIONS_PER_WINDOW;
} catch (error) {
  console.error("Intake rate-limit check failed; allowing submission", { error });
}

if (overLimit) {
  console.warn("Relay NW setup request rate limited", { ipHash: hash.slice(0, 12) });
  redirect("/intake?rate_limited=1");
}
```

- `const MAX_GLOBAL_SUBMISSIONS_PER_WINDOW = 30;` (module constant — the global cap is what actually protects Resend; a distributed bot rotates IPs).
- Pass `submitterHash: hash` into `createSetupRequest`.
- Keep `MAX_SUBMISSIONS_PER_WINDOW = 5` and `SUBMISSION_WINDOW_MS` unchanged. Honeypot check order unchanged (bots hitting the honeypot are never inserted, so they don't consume the global budget — correct: the budget should meter *stored* requests, which are what cost money).

## Tests required

New file `tests/intake-rate-limit.test.mjs` (loadTsModule of the route, mocking `@/lib/supabase`, `@/lib/email`, `next/navigation` with a redirect-capturing throw, per the repo's existing route-test style):

1. `sixth submission from one hashed ip within the window is redirected to rate_limited` — per-IP count mock → 5; assert redirect target and `createSetupRequest` uncalled.
2. `global cap rejects even a fresh ip` — per-IP 0, global 30; assert rejection.
3. `submission stores the sha256 submitter hash, never the raw ip` — capture `createSetupRequest` args; assert 64-char hex, and assert raw IP absent.
4. **Negative test:** `rate-limit lookup failure lets a valid submission through` — count mock throws; assert `createSetupRequest` called (guards the fail-open decision).

Unskip the spec-06 pinned test in `tests/compliance-gaps.pinned.test.mjs`.

## Acceptance criteria

- Limits enforced across instances (state lives only in Postgres); no in-memory rate-limit state remains in the route.
- Raw IPs never written to the database.
- Limiter outage does not block legitimate submissions.
- `npm run test` green with pinned test unskipped; `supabase.sql` re-runnable (all statements idempotent, matching file convention).

## Out of scope

Do NOT touch: honeypot/validation logic, `notifyAdminNewSetupRequest`, the intake UI, the health-check cooldown limiter (already DB-backed per account), Twilio webhook routes (signature-gated; they need no rate limit). No Redis/Upstash/middleware — Postgres beats new infrastructure at this scale.
