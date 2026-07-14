import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Load _utils with its one runtime import (./_constants) mocked, so we can unit
// test the pure voicemail-progress logic in isolation.
async function loadUtils() {
  const source = await readFile(new URL("../app/leads/_utils.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mocks = {
    "./_constants": {
      AUTO_VOICEMAIL_SUMMARY_LOOKBACK_MS: 10 * 60 * 1000,
      FAST_REPLY_PATTERNS: [],
      TODAY_REPLY_PATTERNS: [],
      LEGACY_FORWARDING_MESSAGE: "__legacy__",
    },
  };
  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    throw new Error(`Unexpected import ${specifier}`);
  };
  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: "_utils.ts" });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const { shouldShowVoicemailSummaryProgress } = await loadUtils();

const now = Date.now();
const lead = (over) => ({
  recording_sid: "REtest",
  voicemail_summary: null,
  voicemail_transcription_status: null,
  created_at: new Date(now - 60_000).toISOString(), // 1 min old = recent
  ...over,
});

test("completed transcription with no summary => not in progress (the bug)", () => {
  assert.equal(shouldShowVoicemailSummaryProgress(lead({ voicemail_transcription_status: "completed" }), now), false);
});

test("failed transcription => not in progress", () => {
  assert.equal(shouldShowVoicemailSummaryProgress(lead({ voicemail_transcription_status: "failed" }), now), false);
});

test("actively processing => in progress", () => {
  assert.equal(shouldShowVoicemailSummaryProgress(lead({ voicemail_transcription_status: "processing" }), now), true);
});

test("recent voicemail not yet started => in progress (waiting to auto-transcribe)", () => {
  assert.equal(shouldShowVoicemailSummaryProgress(lead({ voicemail_transcription_status: null }), now), true);
});

test("has a summary => not in progress", () => {
  assert.equal(
    shouldShowVoicemailSummaryProgress(lead({ voicemail_summary: "Water heater leaking." }), now),
    false,
  );
});

test("old voicemail, never transcribed => not in progress", () => {
  const old = lead({ created_at: new Date(now - 20 * 60_000).toISOString() });
  assert.equal(shouldShowVoicemailSummaryProgress(old, now), false);
});

test("no recording => not in progress", () => {
  assert.equal(shouldShowVoicemailSummaryProgress(lead({ recording_sid: null }), now), false);
});
