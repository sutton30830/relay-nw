import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// PINNED BUGS — July 2026 production-readiness audit.
//
// Every test in this file is SKIPPED because it pins a confirmed, currently-unfixed
// bug. Each skip reason names the spec in docs/impl-specs/ that fixes it. The
// implementer must UNSKIP the matching test as part of executing each spec; the
// test must then pass, and it becomes the regression guard for that fix.
//
// Convention note: these are source-contract tests (same style as
// tests/tenant-contract.test.mjs). Where a spec also requires behavioral tests,
// those are named inside the spec and use the loadTsModule convention from
// tests/audit-fixes.test.mjs.

const smsRoute = await readFile(new URL("../app/api/twilio/sms/route.ts", import.meta.url), "utf8");
const settingsRoute = await readFile(new URL("../app/api/settings/route.ts", import.meta.url), "utf8");
const dialStatusRoute = await readFile(new URL("../app/api/twilio/dial-status/route.ts", import.meta.url), "utf8");
const recordingRoute = await readFile(new URL("../app/api/twilio/recording/route.ts", import.meta.url), "utf8");
const voicemailAi = await readFile(new URL("../lib/voicemail-ai.ts", import.meta.url), "utf8");
const messagesTs = await readFile(new URL("../lib/supabase/messages.ts", import.meta.url), "utf8");
const intakeRoute = await readFile(new URL("../app/api/intake/route.ts", import.meta.url), "utf8");
const leadsInboxHook = await readFile(new URL("../app/leads/_hooks/use-leads-inbox.ts", import.meta.url), "utf8");
const leadCardTsx = await readFile(new URL("../app/leads/_components/lead-card.tsx", import.meta.url), "utf8");
const supabaseSql = await readFile(new URL("../supabase.sql", import.meta.url), "utf8");
const globalsCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test(
  "inbound SMS route handles START/UNSTOP re-opt-in by clearing the opt_outs row",
  () => {
    // Today OPT_OUT_WORDS exists but there is no re-opt-in word set and no
    // opt-out deletion path anywhere in the codebase.
    assert.match(smsRoute, /OPT_IN_WORDS|START/);
    assert.match(messagesTs, /clearOptOut|deleteOptOut|removeOptOut/);
  },
);

test(
  "inbound SMS opt-out words include STOPALL",
  () => {
    assert.match(smsRoute, /"STOPALL"/);
  },
);

test(
  "inbound SMS route answers HELP with business identification",
  () => {
    assert.match(smsRoute, /HELP/);
    assert.match(smsRoute, /helpReply|HELP_RESPONSE|handleHelp/i);
  },
);

test(
  "settings route refuses to enable SMS unless the account's A2P registration is approved",
  () => {
    assert.match(settingsRoute, /getA2pRegistrationStatus|a2p_registration_status/);
  },
);

test(
  "dial-status webhook falls back to To-number account resolution when the CallSid is unknown",
  () => {
    assert.match(dialStatusRoute, /resolveAccountByTwilioNumber/);
  },
);

test(
  "voicemail transcription claims the lead atomically before processing",
  () => {
    assert.match(voicemailAi, /claimVoicemailTranscription/);
  },
);

test(
  "voicemail summaries require structured transcript evidence",
  () => {
    assert.match(voicemailAi, /VOICEMAIL_SUMMARY_JSON_SCHEMA/);
    assert.match(voicemailAi, /validateStructuredVoicemailSummary/);
    assert.match(voicemailAi, /summaryEvidence/);
  },
);

test(
  "duplicate automatic voicemail transcription callbacks are not logged as failures",
  () => {
    assert.match(recordingRoute, /Skipping duplicate automatic voicemail transcription/);
    assert.match(recordingRoute, /Voicemail summary is already generating\./);
  },
);

test(
  "lead search keeps active typing stable across stale server refreshes",
  () => {
    assert.match(leadsInboxHook, /pendingQueryRef/);
    assert.match(leadsInboxHook, /server\.query !== pendingQueryRef\.current/);
  },
);

test(
  "server-side lead search matches the visible Unknown caller label",
  () => {
    assert.match(supabaseSql, /Unknown caller/);
    assert.match(supabaseSql, /nullif\(btrim\(coalesce\(name, ''\)\), ''\) is null/);
  },
);

test(
  "lead category changes update immediately without navigating the entire inbox",
  () => {
    assert.match(leadsInboxHook, /optimisticCounts/);
    assert.match(leadsInboxHook, /applyCountDeltas/);
    assert.doesNotMatch(leadsInboxHook, /setFilter\(status\)/);
    assert.match(leadsInboxHook, /Status is an edit, not an inbox navigation/);
    assert.match(leadsInboxHook, /setItems\(\(current\) => applyPendingWrites\(leads, current\)\)/);
    assert.match(leadsInboxHook, /missingPendingItems/);
    assert.match(leadsInboxHook, /router\.prefetch\(buildInboxHref\(item\.key, query\)\)/);
  },
);

test(
  "lead list stays interactive while category navigation refreshes",
  () => {
    const loadingRule = globalsCss.match(/\.leads-list--loading\s*\{[^}]+\}/)?.[0] ?? "";
    assert.doesNotMatch(loadingRule, /pointer-events:\s*none/);
  },
);

test(
  "lead conversation opens feel responsive without changing the card workflow",
  () => {
    assert.match(leadsInboxHook, /sortedItems\.slice\(0,\s*10\)/);
    assert.match(leadsInboxHook, /router\.prefetch\(`\/leads\/\$\{lead\.id\}`\)/);
    assert.match(leadsInboxHook, /openingLeadId/);
    assert.match(leadCardTsx, /isOpening/);
    assert.match(leadCardTsx, /Opening conversation/);
    assert.match(globalsCss, /\.lead-card--opening/);
  },
);

test(
  "intake rate limiting is backed by the database, not per-instance memory",
  () => {
    assert.doesNotMatch(intakeRoute, /new Map<string/);
    assert.match(intakeRoute, /setup_requests|rate_limit/i);
  },
);
