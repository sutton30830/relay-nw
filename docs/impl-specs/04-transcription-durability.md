# Spec 04 — Voicemail transcription: atomic claim + automatic retry

**Priority:** Before account #5. **Est. size: M.**

## Problem

Two related defects in `lib/voicemail-ai.ts` / `app/api/twilio/recording/route.ts`:

1. **Non-atomic processing claim.** `transcribeLeadVoicemail` reads the lead, checks `voicemail_transcription_status === "processing"` in JS, then writes `processing` (`lib/voicemail-ai.ts:301-333`). Two concurrent triggers — the recording webhook's `after()` and an owner clicking "Generate summary", or a stale-takeover racing a live run — both pass the check and both run the full OpenAI chain. Consequences: double transcription spend, and for fast-priority voicemails **two** "Relay NW URGENT" owner texts (`lib/voicemail-ai.ts:376-382`).
2. **No automatic retry.** The only automatic trigger is the recording webhook's `after()` callback (`app/api/twilio/recording/route.ts:200-227`). If the instance dies mid-chain (OpenAI slow + 60s `maxDuration`, deploy, crash), the lead sits in `processing` until the 10-minute stale window passes — and then **nothing retries it**. Recovery requires a human clicking retry in the inbox. Same for `failed` leads after transient OpenAI outages. The webhook event log records the failure, but the summary — a paid feature — never arrives on its own.

## Risk if unfixed

A voicemail left Friday evening during an OpenAI hiccup shows "Summary unavailable" all weekend; the owner stops trusting summaries. Worse, an urgent "water is pouring through my ceiling" voicemail gets its priority classification only when someone manually retries — the URGENT escalation SMS that justifies the premium price arrives Monday.

## Exact change

### 1. Atomic claim — `lib/supabase/voicemails.ts`

Add:

```ts
// Atomically claims a lead for transcription. Returns true only for the single
// caller that flipped the row into "processing"; every concurrent caller gets
// false. A lead is claimable when it is not currently processing, or its
// processing claim is stale (older than staleBefore).
export async function claimVoicemailTranscription(input: {
  accountId: string;
  id: string;
  staleBefore: string; // ISO timestamp
}) {
  const accountId = assertAccountId(input.accountId, "claimVoicemailTranscription");

  if (shouldSkipDatabaseWrite("voicemail transcription claim", input)) {
    return true;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .update({
      voicemail_transcription_status: "processing",
      voicemail_transcription_error: null,
      voicemail_transcribed_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("account_id", accountId)
    .or(
      `voicemail_transcription_status.is.null,` +
      `voicemail_transcription_status.in.(pending,failed),` +
      `and(voicemail_transcription_status.eq.processing,voicemail_transcribed_at.lt.${input.staleBefore})`,
    )
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return Boolean(data?.id);
}
```

(Single UPDATE with the claimability predicate in the WHERE clause — Postgres row locking makes exactly one concurrent claimant win. This is why the claim must be one statement, not read-then-write.)

### 2. `lib/voicemail-ai.ts` — use the claim

In `transcribeLeadVoicemail`, after the `lead?.recording_sid` guard and the completed-shortcut (keep both; keep the completed-shortcut **before** claiming so re-requests of finished summaries stay free), replace the entire `processing`-check block (lines 301-318) **and** the unconditional `updateLeadVoicemailTranscription({ status: "processing" })` call (lines 328-333) with:

```ts
const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
const claimed = await claimVoicemailTranscription({ accountId, id: leadId, staleBefore });

if (!claimed) {
  throw new Error("Voicemail summary is already generating.");
}
```

(The thrown message matches the current in-flight message, so the manual-retry UI keeps working unchanged.)

### 3. Automatic retry cron

- New route `app/api/cron/retry-transcriptions/route.ts`, auth identical to `app/api/digest/weekly/route.ts` (503 without `env.cronSecret`, 401 on bearer mismatch), `export const runtime = "nodejs"; export const maxDuration = 300;`.
- New helper in `lib/supabase/voicemails.ts`:

```ts
export async function listLeadsNeedingTranscriptionRetry(limit = 10) {
  // Cross-tenant by design: this is an operator cron, and transcribeLeadVoicemail
  // re-scopes every write by the account_id returned here.
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id, account_id, voicemail_transcription_status, voicemail_transcribed_at")
    .not("recording_sid", "is", null)
    .is("deleted_at", null)
    .or(
      `voicemail_transcription_status.in.(pending,failed),` +
      `and(voicemail_transcription_status.eq.processing,voicemail_transcribed_at.lt.${staleBefore})`,
    )
    .gte("created_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: true })
    .limit(limit);

  throwIfSupabaseError(error);
  return (data ?? []) as Array<{ id: string; account_id: string }>;
}
```

  48-hour lookback: older failures are operationally dead (the owner has moved on) and retrying ancient leads would send confusing stale notification emails. `failed` leads get retried too — but to cap OpenAI spend on permanently broken recordings, skip rows whose `voicemail_transcription_error` starts with `"Twilio recording download failed with 404"` (deleted recording; never recoverable). Implement that as a `.not("voicemail_transcription_error", "ilike", "Twilio recording download failed with 404%")` filter.
- Route body: loop the list sequentially, `try { await transcribeLeadVoicemail(row.id, row.account_id) } catch { record per-row error, continue }` (claim contention just throws "already generating" — count it as skipped, not failed), return `Response.json({ ok: true, attempted, succeeded, skipped, failed })`, `console.info` a summary line.
- `vercel.json`: add `{ "path": "/api/cron/retry-transcriptions", "schedule": "*/15 * * * *" }`.

Chosen design: cron + status-column scan, no jobs table. The leads table already IS the durable job state (status, started-at, error, attempt context) and a jobs table would duplicate it with sync bugs; the standing constraint prefers cron+Postgres over new infrastructure.

## Tests required

New file `tests/transcription-claim.test.mjs` (loadTsModule convention):

1. `claim returns true and processing is written in one statement` — fake builder capturing the chain; assert `.or(` predicate includes `processing` + staleness and `update` payload sets status processing.
2. `transcribeLeadVoicemail aborts without calling OpenAI when the claim is lost` — mock `claimVoicemailTranscription` → false; assert fetch-recording mock uncalled and the thrown message is "Voicemail summary is already generating.".
3. **Negative test:** `a completed lead returns the cached summary without claiming` — mock lead with transcript+summary; assert claim mock uncalled (guards the free-path regression).
4. `retry cron route rejects a missing or wrong CRON_SECRET` — mirror the existing digest auth tests' style.
5. `retry cron attempts each listed lead and survives one failing` — list of two, first throws; assert second still attempted and response counts `failed: 1`.

Unskip the spec-04 pinned test in `tests/compliance-gaps.pinned.test.mjs`.

## Acceptance criteria

- Two concurrent `transcribeLeadVoicemail` calls for the same lead perform exactly one OpenAI chain and at most one urgent owner SMS.
- A lead left in `processing` >10 min or `failed` (transient error, <48h old) converges to `completed` or a fresh `failed` within 15 minutes with no human action.
- `npm run test` green with pinned test unskipped; existing `tests/pipeline-failure-handling.test.mjs` untouched and green.

## Out of scope

Do NOT touch: the transcription/summarization/priority prompts or models; `STALE_PROCESSING_MS`; the recording webhook's `after()` trigger (it stays — the cron is the safety net, not the primary path); the manual transcribe route; no jobs table, no queue, no new service.
