import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path, mocks) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
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

const voicemailQualityModule = await loadTsModule("lib/voicemail-quality.ts", {});
const voicemailConfidenceModule = await loadTsModule("lib/voicemail-confidence.ts", {
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
const voicemailSummaryModule = await loadTsModule("lib/voicemail-summary.ts", {});

const reliableLogprobs = [
  { token: " Hello", logprob: -0.02 },
  { token: " caller", logprob: -0.02 },
  { token: " message", logprob: -0.02 },
];

function makeClaimBuilder({ data = { id: "lead-1" }, error = null } = {}) {
  const calls = {
    table: null,
    update: null,
    eq: [],
    not: [],
    is: [],
    or: [],
    select: [],
  };

  const builder = {
    update(payload) {
      calls.update = payload;
      return this;
    },
    eq(column, value) {
      calls.eq.push([column, value]);
      return this;
    },
    not(column, operator, value) {
      calls.not.push([column, operator, value]);
      return this;
    },
    is(column, value) {
      calls.is.push([column, value]);
      return this;
    },
    or(predicate) {
      calls.or.push(predicate);
      return this;
    },
    select(columns) {
      calls.select.push(columns);
      return this;
    },
    async maybeSingle() {
      return { data, error };
    },
  };

  return {
    calls,
    supabaseAdmin: {
      from(table) {
        calls.table = table;
        return builder;
      },
    },
  };
}

test("claim returns true and processing is written in one statement", async () => {
  const state = makeClaimBuilder();
  const { claimVoicemailTranscription } = await loadTsModule("lib/supabase/voicemails.ts", {
    "./client": {
      isPlaceholderSupabaseConfig: () => false,
      shouldSkipDatabaseWrite: () => false,
      supabaseAdmin: state.supabaseAdmin,
      throwIfSupabaseError: (error) => {
        if (error) throw error;
      },
    },
    "./tenant": {
      assertAccountId: (accountId) => accountId,
    },
    "@/lib/voicemail-summary": {
      transcriptHasExplicitRequest: () => false,
    },
  });

  const claimed = await claimVoicemailTranscription({
    accountId: "acct-1",
    id: "lead-1",
    staleBefore: "2026-07-04T00:00:00.000Z",
  });

  assert.equal(claimed, true);
  assert.equal(state.calls.table, "leads");
  assert.equal(state.calls.update.voicemail_transcription_status, "processing");
  assert.equal(state.calls.update.voicemail_transcription_error, null);
  assert.ok(state.calls.update.voicemail_transcribed_at);
  assert.deepEqual(state.calls.eq, [
    ["id", "lead-1"],
    ["account_id", "acct-1"],
  ]);
  assert.equal(state.calls.select[0], "id");
  assert.match(state.calls.or[0], /voicemail_transcription_status\.eq\.processing/);
  assert.match(state.calls.or[0], /voicemail_transcribed_at\.lt\.2026-07-04T00:00:00\.000Z/);
});

test("summary-only claim requires a completed transcript and missing summary", async () => {
  const state = makeClaimBuilder();
  const { claimVoicemailSummary } = await loadTsModule("lib/supabase/voicemails.ts", {
    "./client": {
      isPlaceholderSupabaseConfig: () => false,
      shouldSkipDatabaseWrite: () => false,
      supabaseAdmin: state.supabaseAdmin,
      throwIfSupabaseError: (error) => {
        if (error) throw error;
      },
    },
    "./tenant": {
      assertAccountId: (accountId) => accountId,
    },
    "@/lib/voicemail-summary": {
      transcriptHasExplicitRequest: () => false,
    },
  });

  const claimed = await claimVoicemailSummary({ accountId: "acct-1", id: "lead-1" });

  assert.equal(claimed, true);
  assert.deepEqual(state.calls.eq, [
    ["id", "lead-1"],
    ["account_id", "acct-1"],
    ["voicemail_transcription_status", "completed"],
  ]);
  assert.deepEqual(state.calls.not, [["voicemail_transcript", "is", null]]);
  assert.deepEqual(state.calls.is, [["voicemail_summary", null]]);
});

function makeVoicemailMocks({
  lead,
  claimResult = true,
  account = null,
  priority = { level: "normal", reason: null },
}) {
  const calls = {
    claims: [],
    summaryClaims: [],
    priorityUpdates: [],
    transcriptionUpdates: [],
    ownerSms: [],
    ownerEmails: [],
    adminIssues: [],
  };

  const mocks = {
    "@/lib/env": {
      env: {
        appBaseUrl: "http://localhost:3000",
        twilioAccountSid: "AC_test",
        twilioAuthToken: "token",
        openaiApiKey: "sk-test",
        openaiTranscriptionModel: "gpt-4o-transcribe",
        openaiSummaryModel: "gpt-test",
      },
    },
    "@/lib/priority": {
      classifyPriority: () => priority,
    },
    "@/lib/voicemail-confidence": voicemailConfidenceModule,
    "@/lib/voicemail-summary": voicemailSummaryModule,
    "@/lib/voicemail-quality": voicemailQualityModule,
    "@/lib/supabase": {
      claimVoicemailSummary: async (input) => {
        calls.summaryClaims.push(input);
        return claimResult;
      },
      claimVoicemailTranscription: async (input) => {
        calls.claims.push(input);
        return claimResult;
      },
      getAccountConfigByAccountId: async () => account,
      getLeadForVoicemailTranscription: async () => lead,
      updateLeadPriority: async (input) => calls.priorityUpdates.push(input),
      updateLeadVoicemailTranscription: async (input) => calls.transcriptionUpdates.push(input),
    },
    "@/lib/twilio": {
      sendOwnerSms: async (input) => calls.ownerSms.push(input),
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async (input) => calls.adminIssues.push(input),
      notifyOwnerVoicemailReady: async (input) => calls.ownerEmails.push(input),
    },
  };

  return { mocks, calls };
}

test("transcribeLeadVoicemail aborts without calling OpenAI when the claim is lost", async () => {
  const originalFetch = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = async (...args) => {
    fetches.push(args);
    throw new Error("fetch should not run");
  };

  try {
    const { mocks, calls } = makeVoicemailMocks({
      claimResult: false,
      lead: {
        id: "lead-1",
        phone: "+12065550123",
        recording_sid: "RE_1",
        voicemail_transcript: null,
        voicemail_summary: null,
        voicemail_transcription_status: "pending",
        voicemail_transcribed_at: null,
      },
    });
    const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

    await assert.rejects(
      () => transcribeLeadVoicemail("lead-1", "acct-1"),
      /Voicemail summary is already generating\./,
    );

    assert.equal(calls.claims.length, 1);
    assert.deepEqual(fetches, []);
    assert.deepEqual(calls.transcriptionUpdates, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("too-short recording is rejected before claim or AI and clears any generated text", async () => {
  const originalFetch = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = async (...args) => {
    fetches.push(args);
    throw new Error("fetch should not run");
  };

  try {
    const { mocks, calls } = makeVoicemailMocks({
      lead: {
        id: "lead-short",
        phone: "+12065550123",
        recording_sid: "RE_short",
        recording_duration: 1,
        voicemail_transcript: "For more information, visit www.FEMA.gov.",
        voicemail_summary: "Non-service voicemail: No details provided.",
        voicemail_transcription_status: "completed",
        voicemail_transcribed_at: "2026-07-27T00:00:00.000Z",
      },
    });
    const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

    await assert.rejects(
      () => transcribeLeadVoicemail("lead-short", "acct-1"),
      /No usable voicemail was recorded/,
    );

    assert.deepEqual(fetches, []);
    assert.deepEqual(calls.claims, []);
    assert.deepEqual(calls.transcriptionUpdates, [{
      accountId: "acct-1",
      id: "lead-short",
      rawTranscript: null,
      transcriptionModel: "gpt-4o-transcribe",
      transcriptionConfidence: null,
      transcriptionQuality: "unavailable",
      transcriptionQualityReasons: ["recording_too_short"],
      transcriptionMetrics: null,
      transcript: null,
      summary: null,
      summaryClassification: null,
      summaryEvidence: null,
      summaryValidationReasons: null,
      status: "failed",
      error: "No usable voicemail was recorded. Relay did not generate a transcript.",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("empty transcription is treated as no speech and is not reported as a provider failure", async () => {
  const originalFetch = globalThis.fetch;
  const fetches = [];
  globalThis.fetch = async (url) => {
    fetches.push(String(url));

    if (String(url).includes("Recordings/RE_empty.mp3")) {
      return new Response("fake-audio", { status: 200 });
    }

    if (String(url).endsWith("/audio/transcriptions")) {
      return Response.json({ text: "", logprobs: [] });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const { mocks, calls } = makeVoicemailMocks({
      lead: {
        id: "lead-empty",
        phone: "+12065550123",
        recording_sid: "RE_empty",
        recording_duration: 5,
        voicemail_transcript: null,
        voicemail_summary: null,
        voicemail_transcription_status: "pending",
        voicemail_transcribed_at: null,
      },
    });
    const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

    await assert.rejects(
      () => transcribeLeadVoicemail("lead-empty", "acct-1"),
      /No clear spoken message was detected/,
    );

    assert.equal(fetches.length, 2, "do not run verification or summary after an empty primary transcript");
    assert.equal(calls.adminIssues.length, 0, "no-speech recordings should not page an operator");
    assert.deepEqual(calls.transcriptionUpdates.at(-1), {
      accountId: "acct-1",
      id: "lead-empty",
      rawTranscript: null,
      transcriptionModel: "gpt-4o-transcribe",
      transcriptionConfidence: null,
      transcriptionQuality: "unavailable",
      transcriptionQualityReasons: ["no_speech_detected"],
      transcriptionMetrics: null,
      transcript: null,
      summary: null,
      summaryClassification: null,
      summaryEvidence: null,
      summaryValidationReasons: null,
      status: "failed",
      error: "No clear spoken message was detected. Relay did not generate a transcript.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("known silence hallucinations and short-domain transcripts fail quality checks", async () => {
  const {
    hasUsableVoicemail,
    transcriptLooksLikeSilenceHallucination,
  } = await loadTsModule("lib/voicemail-quality.ts", {});

  assert.equal(hasUsableVoicemail("RE_1", 1), false);
  assert.equal(hasUsableVoicemail("RE_1", 3), true);
  assert.equal(
    transcriptLooksLikeSilenceHallucination("For more information, visit www.FEMA.gov.", 1),
    true,
  );
  assert.equal(
    transcriptLooksLikeSilenceHallucination("Please visit example.com", 5),
    true,
  );
  assert.equal(
    transcriptLooksLikeSilenceHallucination("My water heater is leaking in the garage.", 8),
    false,
  );
});

test("completed lead returns cached summary without claiming", async () => {
  const { mocks, calls } = makeVoicemailMocks({
    claimResult: false,
    lead: {
      id: "lead-1",
      phone: "+12065550123",
      recording_sid: "RE_1",
      voicemail_transcript: "Caller needs a sink repair.",
      voicemail_summary: "Sink repair request.",
      voicemail_transcription_status: "completed",
      voicemail_transcribed_at: "2026-07-04T00:00:00.000Z",
    },
  });
  const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

  const result = await transcribeLeadVoicemail("lead-1", "acct-1");

  assert.deepEqual(result, {
    transcript: "Caller needs a sink repair.",
    summary: "Sink repair request.",
    status: "completed",
  });
  assert.deepEqual(calls.claims, []);
  assert.deepEqual(calls.summaryClaims, []);
});

test("completed transcript regenerates only the summary without downloading audio", async () => {
  const originalFetch = globalThis.fetch;
  const transcript = "Water is pouring out under the kitchen sink. Please come by today.";
  const responseInputs = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/responses")) {
      const body = JSON.parse(init.body);
      responseInputs.push(body.input?.[1]?.content);
      return Response.json({
        output_text: JSON.stringify({
          classification: "service_request",
          summary: "Urgent plumbing leak requires immediate service today.",
          evidence: ["Water is pouring out under the kitchen sink", "Please come by today"],
          urgency: "today",
          urgency_evidence: "today",
        }),
      });
    }

    throw new Error(`Summary-only recovery must not fetch audio: ${url}`);
  };

  try {
    const { mocks, calls } = makeVoicemailMocks({
      lead: {
        id: "lead-summary-only",
        phone: "+12065550123",
        recording_sid: "RE_summary_only",
        recording_duration: 43,
        voicemail_transcript: transcript,
        voicemail_summary: null,
        voicemail_transcription_status: "completed",
        voicemail_transcribed_at: "2026-08-17T15:12:00.000Z",
      },
    });
    const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

    const result = await transcribeLeadVoicemail("lead-summary-only", "acct-1");

    assert.deepEqual(calls.claims, []);
    assert.deepEqual(calls.summaryClaims, [{ accountId: "acct-1", id: "lead-summary-only" }]);
    assert.deepEqual(responseInputs, [transcript]);
    assert.equal(
      result.summary,
      "Water is pouring out under the kitchen sink — Please come by today",
    );
    assert.equal(calls.transcriptionUpdates.at(-1).status, "completed");
    assert.deepEqual(
      calls.transcriptionUpdates.at(-1).summaryValidationReasons,
      ["summary_replaced_with_grounded_evidence"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("voicemail-ready text preference sends one non-urgent owner alert", async () => {
  const originalFetch = globalThis.fetch;
  const transcript = "The kitchen faucet is dripping. Please call me tomorrow.";
  globalThis.fetch = async (url) => {
    if (String(url).includes("Recordings/RE_text_ready.mp3")) {
      return new Response("fake-audio", { status: 200 });
    }
    if (String(url).endsWith("/audio/transcriptions")) {
      return Response.json({ text: transcript, logprobs: reliableLogprobs });
    }
    if (String(url).endsWith("/responses")) {
      return Response.json({ output_text: "{}" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const account = {
      accountId: "acct-1",
      businessName: "Demo Plumbing",
      notificationPreferences: {
        missedCall: { email: true, sms: true },
        voicemailReady: { email: true, sms: true },
        inboundReply: { email: true, sms: true },
        urgentVoicemailSms: true,
      },
    };
    const { mocks, calls } = makeVoicemailMocks({
      account,
      lead: {
        id: "lead-text-ready",
        phone: "+12065550123",
        recording_sid: "RE_text_ready",
        recording_duration: 12,
        voicemail_transcript: null,
        voicemail_summary: null,
        voicemail_transcription_status: "pending",
        voicemail_transcribed_at: null,
      },
    });
    const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

    await transcribeLeadVoicemail("lead-text-ready", "acct-1");

    assert.equal(calls.ownerSms.length, 1);
    assert.equal(calls.ownerSms[0].context, "voicemail ready alert");
    assert.match(calls.ownerSms[0].actionKey, /owner_sms:voicemail_ready/);
    assert.equal(calls.ownerEmails.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("urgent voicemail override can be disabled independently", async () => {
  const originalFetch = globalThis.fetch;
  const transcript = "There is water pouring through the ceiling. Please call immediately.";
  globalThis.fetch = async (url) => {
    if (String(url).includes("Recordings/RE_urgent_off.mp3")) {
      return new Response("fake-audio", { status: 200 });
    }
    if (String(url).endsWith("/audio/transcriptions")) {
      return Response.json({ text: transcript, logprobs: reliableLogprobs });
    }
    if (String(url).endsWith("/responses")) {
      return Response.json({ output_text: "{}" });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const account = {
      accountId: "acct-1",
      businessName: "Demo Plumbing",
      notificationPreferences: {
        missedCall: { email: true, sms: true },
        voicemailReady: { email: true, sms: false },
        inboundReply: { email: true, sms: true },
        urgentVoicemailSms: false,
      },
    };
    const { mocks, calls } = makeVoicemailMocks({
      account,
      priority: { level: "fast", reason: "Active leak" },
      lead: {
        id: "lead-urgent-off",
        phone: "+12065550123",
        recording_sid: "RE_urgent_off",
        recording_duration: 12,
        voicemail_transcript: null,
        voicemail_summary: null,
        voicemail_transcription_status: "pending",
        voicemail_transcribed_at: null,
      },
    });
    const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

    await transcribeLeadVoicemail("lead-urgent-off", "acct-1");

    assert.deepEqual(calls.ownerSms, []);
    assert.equal(calls.ownerEmails.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-service voicemails preserve raw evidence and persist a useful summary", async () => {
  const originalFetch = globalThis.fetch;
  const transcript = "Hello, this is Sophia from AT&T. Your monthly bill discount will be removed today.";
  const summary = "AT&T monthly bill discount notice.";
  const structuredSummary = {
    classification: "vendor_notice",
    summary,
    evidence: ["this is Sophia from AT&T", "Your monthly bill discount will be removed today"],
    urgency: "today",
    urgency_evidence: "today",
  };
  const fetches = [];

  globalThis.fetch = async (url) => {
    fetches.push(String(url));

    if (String(url).includes("Recordings/RE_1.mp3")) {
      return new Response("fake-audio", { status: 200 });
    }

    if (String(url).endsWith("/audio/transcriptions")) {
      return Response.json({ text: transcript, logprobs: reliableLogprobs });
    }

    if (String(url).endsWith("/responses")) {
      return Response.json({ output_text: JSON.stringify(structuredSummary) });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const { mocks, calls } = makeVoicemailMocks({
      lead: {
        id: "lead-1",
        phone: "+12065550123",
        recording_sid: "RE_1",
        voicemail_transcript: null,
        voicemail_summary: null,
        voicemail_transcription_status: "pending",
        voicemail_transcribed_at: null,
      },
    });
    const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

    const result = await transcribeLeadVoicemail("lead-1", "acct-1");

    assert.equal(result.status, "completed");
    assert.equal(result.summary, summary);
    assert.equal(calls.claims.length, 1);
    assert.equal(calls.transcriptionUpdates[0].rawTranscript, transcript);
    assert.equal(calls.transcriptionUpdates[0].transcriptionModel, "gpt-4o-transcribe");
    assert.equal(calls.transcriptionUpdates[0].transcriptionQuality, "reliable");
    assert.equal(calls.transcriptionUpdates[0].transcriptionConfidence, 0.9802);
    assert.equal(calls.transcriptionUpdates[0].transcriptionMetrics.verification_word_error_rate, 0);
    assert.equal(calls.transcriptionUpdates[0].transcript, null);
    assert.deepEqual(calls.transcriptionUpdates[1], {
      accountId: "acct-1",
      id: "lead-1",
      transcript,
      transcriptionQuality: "reliable",
      status: "processing",
      error: null,
    });
    assert.equal(calls.transcriptionUpdates.at(-1).summary, summary);
    assert.equal(calls.transcriptionUpdates.at(-1).summaryClassification, "vendor_notice");
    assert.deepEqual(calls.transcriptionUpdates.at(-1).summaryEvidence, structuredSummary.evidence);
    assert.deepEqual(calls.transcriptionUpdates.at(-1).summaryValidationReasons, []);
    assert.equal(calls.transcriptionUpdates.at(-1).status, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("casual voicemail stays verbatim and is never sent through transcript rewriting", async () => {
  const originalFetch = globalThis.fetch;
  const rawTranscript = "  Hey Sutton, it's Joe. Just calling to say what's up. Give me a call. Peace.  ";
  const displayTranscript = rawTranscript.trim();
  const summary = "Personal call from Joe asking Sutton to call back.";
  const structuredSummary = {
    classification: "personal_call",
    summary,
    evidence: ["Hey Sutton, it's Joe", "Give me a call"],
    urgency: "normal",
    urgency_evidence: "",
  };
  const responseInputs = [];
  const transcriptionForms = [];

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("Recordings/RE_joe.mp3")) {
      return new Response("fake-audio", { status: 200 });
    }

    if (String(url).endsWith("/audio/transcriptions")) {
      transcriptionForms.push(init.body);
      return Response.json({ text: rawTranscript, logprobs: reliableLogprobs });
    }

    if (String(url).endsWith("/responses")) {
      const body = JSON.parse(init.body);
      responseInputs.push(body.input?.[1]?.content ?? "");
      return Response.json({
        output_text: JSON.stringify(structuredSummary),
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const { mocks, calls } = makeVoicemailMocks({
      lead: {
        id: "lead-joe",
        phone: "+12065557678",
        recording_sid: "RE_joe",
        recording_duration: 7,
        voicemail_transcript: null,
        voicemail_summary: null,
        voicemail_transcription_status: "pending",
        voicemail_transcribed_at: null,
      },
    });
    const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

    const result = await transcribeLeadVoicemail("lead-joe", "acct-1");

    assert.equal(result.transcript, displayTranscript);
    assert.equal(result.summary, summary);
    assert.equal(transcriptionForms.length, 2, "the new system requires agreement between two GPT-4o transcribers");
    assert.equal(transcriptionForms[0].get("prompt"), null, "biased home-service prompt must be absent");
    assert.equal(transcriptionForms[0].get("include[]"), "logprobs");
    assert.equal(transcriptionForms[0].get("language"), "en");
    assert.deepEqual(responseInputs, [displayTranscript], "the transcript is summarized once and never rewritten");
    assert.equal(calls.transcriptionUpdates[0].rawTranscript, rawTranscript);
    assert.equal(calls.transcriptionUpdates[0].transcriptionQuality, "reliable");
    assert.equal(calls.transcriptionUpdates[0].transcript, null);
    assert.equal(calls.transcriptionUpdates.at(-1).rawTranscript, rawTranscript);
    assert.equal(calls.transcriptionUpdates.at(-1).transcript, displayTranscript);
    assert.equal(calls.transcriptionUpdates.at(-1).summary, summary);
    assert.deepEqual(calls.transcriptionUpdates.at(-1).summaryEvidence, structuredSummary.evidence);
    assert.equal(calls.transcriptionUpdates.at(-1).status, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("conflicting GPT-4o transcriptions are stored as evidence but never shown as a transcript", async () => {
  const originalFetch = globalThis.fetch;
  const responseCalls = [];
  let transcriptionCount = 0;

  globalThis.fetch = async (url) => {
    if (String(url).includes("Recordings/RE_conflict.mp3")) {
      return new Response("fake-audio", { status: 200 });
    }

    if (String(url).endsWith("/audio/transcriptions")) {
      transcriptionCount += 1;
      return Response.json({
        text: transcriptionCount === 1
          ? "Hey Sutton, it's Joe. Give me a call."
          : "For more information visit FEMA dot gov.",
        logprobs: reliableLogprobs,
      });
    }

    if (String(url).endsWith("/responses")) {
      responseCalls.push(url);
      throw new Error("uncertain transcripts must not be summarized");
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const { mocks, calls } = makeVoicemailMocks({
      lead: {
        id: "lead-conflict",
        phone: "+12065557678",
        recording_sid: "RE_conflict",
        recording_duration: 7,
        voicemail_transcript: null,
        voicemail_summary: null,
        voicemail_transcription_status: "pending",
        voicemail_transcribed_at: null,
      },
    });
    const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", mocks);

    await assert.rejects(
      () => transcribeLeadVoicemail("lead-conflict", "acct-1"),
      /could not confidently transcribe/,
    );

    assert.deepEqual(responseCalls, []);
    assert.equal(calls.transcriptionUpdates[0].rawTranscript, "Hey Sutton, it's Joe. Give me a call.");
    assert.equal(calls.transcriptionUpdates[0].transcript, null);
    assert.equal(calls.transcriptionUpdates[0].transcriptionQuality, "review_recommended");
    assert.ok(
      calls.transcriptionUpdates[0].transcriptionQualityReasons.includes("transcription_models_disagree"),
    );
    assert.equal(calls.transcriptionUpdates.at(-1).status, "failed");
    assert.equal(calls.adminIssues.length, 0, "expected uncertainty is not an operational outage");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeCronMocks({ cronSecret = "secret", leads = [], summaryLeads = [], failLeadIds = new Set() } = {}) {
  const calls = {
    listed: 0,
    transcriptions: [],
    checkIns: [],
  };

  const mocks = {
    "@/lib/env": {
      env: { cronSecret },
    },
    "@/lib/supabase": {
      listActiveAccountIds: async () => [...new Set(
        [...leads, ...summaryLeads].map((lead) => lead.account_id),
      )],
      listLeadsNeedingSummaryRetry: async () => {
        calls.listed += 1;
        return summaryLeads;
      },
      listLeadsNeedingTranscriptionRetry: async () => {
        calls.listed += 1;
        return leads;
      },
    },
    "@/lib/cron-checkins": {
      recordCronCheckIn: async (input) => {
        calls.checkIns.push(input);
        return true;
      },
    },
    "@/lib/cron-monitor": {
      withCronMonitor: async (input) => input.run(),
    },
    "@/lib/voicemail-ai": {
      transcribeLeadVoicemail: async (leadId, accountId) => {
        calls.transcriptions.push({ leadId, accountId });
        if (failLeadIds.has(leadId)) {
          throw new Error(`failed ${leadId}`);
        }
        return { status: "completed", transcript: "ok", summary: "ok" };
      },
    },
  };

  return { mocks, calls };
}

async function runCron(mocks, token) {
  const { GET } = await loadTsModule("app/api/cron/retry-transcriptions/route.ts", mocks);
  return GET(new Request("https://example.com/api/cron/retry-transcriptions", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }));
}

test("retry cron route rejects a missing or wrong CRON_SECRET", async () => {
  const missing = makeCronMocks({ cronSecret: "" });
  const missingResponse = await runCron(missing.mocks, "anything");
  assert.equal(missingResponse.status, 503);
  assert.equal(missing.calls.listed, 0);

  const wrong = makeCronMocks({ cronSecret: "secret" });
  const wrongResponse = await runCron(wrong.mocks, "wrong");
  assert.equal(wrongResponse.status, 401);
  assert.equal(wrong.calls.listed, 0);
});

test("retry cron attempts each listed lead and survives one failing", async () => {
  const { mocks, calls } = makeCronMocks({
    leads: [
      { id: "lead-1", account_id: "acct-1" },
      { id: "lead-2", account_id: "acct-2" },
    ],
    failLeadIds: new Set(["lead-1"]),
  });

  const response = await runCron(mocks, "secret");
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.deepEqual(calls.transcriptions, [
    { leadId: "lead-1", accountId: "acct-1" },
    { leadId: "lead-2", accountId: "acct-2" },
  ]);
  assert.equal(body.attempted, 2);
  assert.equal(body.succeeded, 1);
  assert.equal(body.skipped, 0);
  assert.equal(body.failed, 1);
  assert.equal(calls.checkIns.length, 2);
  assert.equal(calls.checkIns.find((item) => item.accountId === "acct-1").ok, false);
  assert.equal(calls.checkIns.find((item) => item.accountId === "acct-2").ok, true);
});

test("retry cron includes completed transcripts that need summary-only recovery", async () => {
  const { mocks, calls } = makeCronMocks({
    summaryLeads: [{ id: "lead-summary", account_id: "acct-1" }],
  });

  const response = await runCron(mocks, "secret");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls.transcriptions, [
    { leadId: "lead-summary", accountId: "acct-1" },
  ]);
  assert.equal(body.attempted, 1);
  assert.equal(body.succeeded, 1);
});
