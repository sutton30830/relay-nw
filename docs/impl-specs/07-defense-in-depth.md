# Spec 07 — Defense-in-depth: recording URL allowlist + declared RLS posture

**Priority:** Before account #25. **Est. size: S.** Two independent hardening items; neither is an active vulnerability today.

## Item A — Twilio credentials only ever sent to api.twilio.com

### Problem

Two code paths take a `recording_url`/`recording_sid` that originated in the database and issue an authenticated fetch with the **Twilio Basic-auth credential** attached:

- `app/api/recordings/[recordingSid]/route.ts:36-45` — playback proxy, uses `recording.recording_url` from the lead row when present.
- `lib/voicemail-ai.ts:38-56` — builds the URL from `recording_sid` (safe shape), but the playback route trusts the stored URL wholesale.

The stored URL is written only by the signature-validated recording webhook today, so there is no current injection path. But the trust chain is long (webhook → DB → months later → outbound fetch with credentials), and one future bug anywhere along it (an admin edit endpoint, a backfill script, a compromised row) turns into credential exfiltration to an attacker-controlled host.

### Risk if unfixed

A single future write-path mistake upgrades to full Twilio account takeover (the auth token signs webhooks and sends SMS). Cheap insurance now versus incident response later.

### Exact change

In `lib/twilio.ts`, add and export:

```ts
export function isTrustedTwilioMediaUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.twilio.com";
  } catch {
    return false;
  }
}
```

In `app/api/recordings/[recordingSid]/route.ts`, replace the `recordingUrl` derivation:

```ts
const storedUrl = recording.recording_url;
const recordingUrl = isTrustedTwilioMediaUrl(storedUrl)
  ? storedUrl!
  : `https://api.twilio.com/2010-04-01/Accounts/${env.twilioAccountSid}/Recordings/${recordingSid}.mp3`;
```

(Untrusted stored URL falls back to the canonical SID-derived URL — the `recordingSid` is already regex-validated `^RE[a-fA-F0-9]{32}$` at line 20, so the fallback is always safe. Log a `console.warn("Stored recording_url rejected by allowlist", { recordingSid })` when the fallback triggers on a non-null stored URL.)

### Tests (Item A)

In new `tests/defense-in-depth.test.mjs`: (1) `https api.twilio.com urls pass the allowlist`; (2) `http, other hosts, subdomain tricks (api.twilio.com.evil.com), and garbage all fail`; (3) **negative/regression:** loadTsModule the recordings route with a lead whose `recording_url` is `https://evil.example/x.mp3` and a fetch mock — assert the fetched URL hostname is `api.twilio.com`.

## Item B — Declare the RLS posture in SQL, not just a comment

### Problem

All 12 tables have RLS enabled and **zero policies** (`supabase.sql` — no `create policy` anywhere; trailing comment at lines 355-356 explains the service-role-only intent). Behavior today is correct: RLS-with-no-policies denies the anon/authenticated roles everything, and the service-role key bypasses RLS. But the posture is implicit. The magic-link auth flow already ships the **anon key to the browser** (`lib/auth.ts:28`, `middleware.ts`), so the only thing standing between a curious pilot user's browser session and PostgREST table reads is this implicit default. One future convenience policy (`create policy ... using (true)` pasted from a tutorial) or a Supabase dashboard toggle silently changes the answer.

### Risk if unfixed

Not a current leak — a one-mistake-away leak, with no test that would catch the mistake.

### Exact change

1. Append to `supabase.sql` (replacing the trailing comment block), for **every** table currently in the file (`accounts`, `account_settings`, `account_phone_numbers`, `account_users`, `leads`, `webhook_events`, `opt_outs`, `inbound_messages`, `calls`, `messages`, `forwarding_health_checks`, `setup_requests`):

```sql
-- Service-role-only posture, made explicit. The app talks to these tables solely
-- through the service-role key from server routes. These restrictive deny-all
-- policies for client roles are a tripwire: if someone later adds a permissive
-- policy or flips RLS off in the dashboard, drift is visible right here in SQL.
drop policy if exists deny_client_access on public.<table>;
create policy deny_client_access on public.<table>
  as restrictive for all to anon, authenticated
  using (false) with check (false);
```

   (One `drop`+`create` pair per table so the file stays idempotent/re-runnable, matching its existing convention. `restrictive` means a future permissive policy alone still grants nothing — it would also require deleting the tripwire, which is a visible, greppable act.)
2. Extend `tests/tenant-contract.test.mjs` with one test: `every table with RLS enabled has the restrictive deny_client_access policy` — parse `supabase.sql` for `enable row level security` table names and assert each has a matching `create policy deny_client_access on public.<name>` with `as restrictive` and `to anon, authenticated`. This is the **negative test**: it fails if a new table is added without the tripwire.

## Acceptance criteria

- Playback proxy can never send Twilio credentials to a non-`api.twilio.com` host; voicemail download path unchanged (already SID-derived).
- `supabase.sql` re-runs cleanly on an existing database (idempotent) and on a fresh one; app behavior is unchanged (service role bypasses the new policies).
- `npm run test` green including the new contract test.

## Out of scope

Do NOT touch: moving server code off the service-role key, per-tenant Postgres roles, `auth.uid()`-based tenant policies (all deferred until there is a browser data path — there is none today); the voicemail-ai fetch (already canonical); Supabase dashboard settings (manual check in the executive verdict).
