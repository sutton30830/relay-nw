import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/voicemail-monitoring.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
const require = (specifier) => {
  if (specifier === "@/lib/provider-actions") {
    return {
      isExpectedQualitySuppression: (message) => /No usable voicemail|No clear spoken message|could not confidently transcribe/i.test(message ?? ""),
    };
  }
  throw new Error(`Missing mock for ${specifier}`);
};
new vm.Script(`(function(require,module,exports){${compiled}\n})`)
  .runInThisContext()(require, module, module.exports);
const { calculateVoicemailPipelineHealth } = module.exports;

const now = new Date("2026-08-21T18:00:00.000Z");

function lead(overrides = {}) {
  return {
    id: "lead-1",
    phone: "+12065550123",
    createdAt: "2026-08-21T17:00:00.000Z",
    recordingSid: "RE123",
    recordingDuration: 18,
    recordingStatus: "completed",
    transcriptionStatus: "completed",
    transcriptionError: null,
    transcriptionChangedAt: "2026-08-21T17:02:00.000Z",
    hasSummary: true,
    summaryValidationReasons: [],
    ...overrides,
  };
}

function action(overrides = {}) {
  return {
    id: "action-1",
    action: "voicemail_transcription",
    resourceId: "lead-1",
    internalStatus: "succeeded",
    providerStatus: "completed",
    retryEligibility: "never",
    recommendedNextAction: "Review the transcript.",
    suppressed: false,
    lastAttemptAt: "2026-08-21T17:02:00.000Z",
    ...overrides,
  };
}

test("completed voicemail pipeline reports ready evidence without issues", () => {
  const result = calculateVoicemailPipelineHealth([lead()], [action()], now);

  assert.equal(result.recordings, 1);
  assert.equal(result.transcriptsReady, 1);
  assert.equal(result.summariesReady, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.issues, []);
});
test("waiting and stale processing become affected-call issues after their grace periods", () => {
  const result = calculateVoicemailPipelineHealth([
    lead({ id: "lead-waiting", transcriptionStatus: "pending", hasSummary: false }),
    lead({
      id: "lead-stalled",
      transcriptionStatus: "processing",
      transcriptionChangedAt: "2026-08-21T17:40:00.000Z",
      hasSummary: false,
    }),
    lead({
      id: "lead-active",
      transcriptionStatus: "processing",
      transcriptionChangedAt: "2026-08-21T17:55:00.000Z",
      hasSummary: false,
    }),
  ], [], now);

  assert.equal(result.waiting, 1);
  assert.equal(result.stalled, 1);
  assert.equal(result.processing, 1);
  assert.equal(result.issues.find((issue) => issue.leadId === "lead-stalled").severity, "critical");
});

test("actionable transcription failure retains retry and exact provider evidence", () => {
  const result = calculateVoicemailPipelineHealth([
    lead({ transcriptionStatus: "failed", transcriptionError: "OpenAI transcription failed with 503", hasSummary: false }),
  ], [action({
    id: "provider-event-1",
    internalStatus: "failed",
    providerStatus: "provider_failed",
    retryEligibility: "automatic",
    recommendedNextAction: "Wait for the idempotent retry.",
  })], now);
  const issue = result.issues[0];

  assert.equal(result.failed, 1);
  assert.equal(issue.stage, "transcription");
  assert.equal(issue.providerActionId, "provider-event-1");
  assert.equal(issue.retryEligibility, "automatic");
  assert.equal(issue.callerLast4, "0123");
  assert.doesNotMatch(issue.detail, /OpenAI|503/);
});

test("summary-only failure is distinct from transcription and safe to regenerate", () => {
  const result = calculateVoicemailPipelineHealth([
    lead({ hasSummary: false, summaryValidationReasons: ["summary_request_failed"] }),
  ], [action({
    id: "summary-event-1",
    action: "voicemail_summary",
    internalStatus: "failed",
    providerStatus: "summary_request_failed",
    retryEligibility: "automatic",
    recommendedNextAction: "Retry summary generation from the existing transcript.",
  })], now);
  const issue = result.issues[0];

  assert.equal(issue.stage, "summary");
  assert.match(issue.detail, /verified transcript is ready/i);
  assert.match(issue.recommendedNextAction, /existing transcript/i);
});

test("short, silent, and uncertain voicemail remains a suppression rather than an outage", () => {
  const result = calculateVoicemailPipelineHealth([
    lead({
      transcriptionStatus: "failed",
      transcriptionError: "No usable voicemail was recorded. Listen to the recording instead.",
      hasSummary: false,
    }),
  ], [action({ internalStatus: "suppressed", suppressed: true })], now);

  assert.equal(result.suppressed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.issues, []);
});
