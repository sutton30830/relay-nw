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
  "non-service voicemails still get useful summaries",
  () => {
    assert.match(voicemailAi, /Non-service voicemail:/);
    assert.match(voicemailAi, /vendor notice, billing notice, sales call, wrong number, or spam/);
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
  "intake rate limiting is backed by the database, not per-instance memory",
  () => {
    assert.doesNotMatch(intakeRoute, /new Map<string/);
    assert.match(intakeRoute, /setup_requests|rate_limit/i);
  },
);
