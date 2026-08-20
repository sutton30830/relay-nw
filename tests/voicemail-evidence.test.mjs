import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path, mocks = {}) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      resolveJsonModule: true,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    throw new Error(`Missing test mock for ${specifier} while loading ${path}`);
  };

  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const confidence = await loadTsModule("lib/voicemail-confidence.ts", {
  "./voicemail-confidence-config.json": {
    lowLogprobThreshold: -1.25,
    veryLowLogprobThreshold: -2.5,
    minimumReliableConfidence: 0.72,
    minimumReviewConfidence: 0.5,
    maximumReliableLowTokenFraction: 0.15,
    maximumReviewLowTokenFraction: 0.35,
    maximumReliableTranscriptDisagreement: 0.3,
  },
});
const summaries = await loadTsModule("lib/voicemail-summary.ts");

test("high-confidence lexical tokens are accepted", () => {
  const result = confidence.assessTranscriptionConfidence([
    { token: " Hey", logprob: -0.03 },
    { token: " Sutton", logprob: -0.04 },
    { token: ".", logprob: -3.5 },
  ]);

  assert.equal(result.quality, "reliable");
  assert.equal(result.metrics.token_count, 2, "punctuation must not distort confidence");
  assert.ok(result.confidence > 0.95);
});

test("missing or weak logprobs fail closed", () => {
  assert.equal(confidence.assessTranscriptionConfidence([]).quality, "unavailable");

  const weak = confidence.assessTranscriptionConfidence([
    { token: " water", logprob: -0.1 },
    { token: " heater", logprob: -3.2 },
    { token: " leaking", logprob: -2.1 },
  ]);

  assert.notEqual(weak.quality, "reliable");
  assert.ok(weak.reasons.includes("too_many_low_confidence_tokens"));
  assert.ok(weak.reasons.includes("very_low_confidence_token"));
});

test("materially different transcripts are detected by word error rate", () => {
  const reference = "Hey Sutton it's Joe give me a call";

  assert.equal(confidence.transcriptWordErrorRate(reference, reference), 0);
  assert.equal(
    confidence.transcriptsMateriallyDisagree(reference, "Visit FEMA dot gov for information"),
    true,
  );
});

test("a grounded personal-call summary passes validation", () => {
  const transcript = "Hey Sutton, it's Joe. Just calling to say what's up. Give me a call. Peace.";
  const result = summaries.validateStructuredVoicemailSummary(transcript, {
    classification: "personal_call",
    summary: "Personal call from Joe asking Sutton to call back.",
    evidence: ["Hey Sutton, it's Joe", "Give me a call"],
    urgency: "normal",
    urgency_evidence: "",
  });

  assert.equal(result.result?.summary, "Personal call from Joe asking Sutton to call back.");
  assert.deepEqual(result.reasons, []);
});

test("fabricated details or non-verbatim evidence suppress the entire summary", () => {
  const transcript = "Hey Sutton, it's Joe. Give me a call.";
  const fabricated = summaries.validateStructuredVoicemailSummary(transcript, {
    classification: "service_request",
    summary: "Joe needs an emergency water heater repair.",
    evidence: ["Joe said the water heater is leaking"],
    urgency: "fast",
    urgency_evidence: "emergency water heater",
  });

  assert.equal(fabricated.result, null);
  assert.ok(fabricated.reasons.includes("summary_evidence_not_in_transcript"));
  assert.ok(fabricated.reasons.includes("summary_contains_unsupported_words"));
  assert.ok(fabricated.reasons.includes("urgency_missing_transcript_evidence"));
});

test("harmless paraphrasing falls back to exact transcript evidence", () => {
  const transcript = "Hi, water is pouring out under the kitchen sink. Please come by today.";
  const result = summaries.validateStructuredVoicemailSummary(transcript, {
    classification: "service_request",
    summary: "Urgent kitchen plumbing leak requires service today.",
    evidence: ["water is pouring out under the kitchen sink", "Please come by today"],
    urgency: "today",
    urgency_evidence: "today",
  });

  assert.equal(
    result.result?.summary,
    "water is pouring out under the kitchen sink — Please come by today",
  );
  assert.deepEqual(result.reasons, ["summary_replaced_with_grounded_evidence"]);
});

test("normal urgency cannot smuggle in unsupported urgency evidence", () => {
  const transcript = "Please give me a call.";
  const result = summaries.validateStructuredVoicemailSummary(transcript, {
    classification: "personal_call",
    summary: "Caller asks for a call back.",
    evidence: ["give me a call"],
    urgency: "normal",
    urgency_evidence: "today",
  });

  assert.equal(result.result, null);
  assert.ok(result.reasons.includes("normal_urgency_must_not_include_evidence"));
});
