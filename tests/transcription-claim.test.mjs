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

function makeClaimBuilder({ data = { id: "lead-1" }, error = null } = {}) {
  const calls = {
    table: null,
    update: null,
    eq: [],
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

function makeVoicemailMocks({ lead, claimResult = true }) {
  const calls = {
    claims: [],
    priorityUpdates: [],
    transcriptionUpdates: [],
    ownerSms: [],
    adminIssues: [],
  };

  const mocks = {
    "@/lib/env": {
      env: {
        appBaseUrl: "http://localhost:3000",
        twilioAccountSid: "AC_test",
        twilioAuthToken: "token",
        openaiApiKey: "sk-test",
        openaiTranscriptionModel: "whisper-test",
        openaiSummaryModel: "gpt-test",
      },
    },
    "@/lib/priority": {
      classifyPriority: () => ({ level: "normal", reason: null }),
    },
    "@/lib/voicemail-quality": voicemailQualityModule,
    "@/lib/supabase": {
      claimVoicemailTranscription: async (input) => {
        calls.claims.push(input);
        return claimResult;
      },
      getAccountConfigByAccountId: async () => null,
      getLeadForVoicemailTranscription: async () => lead,
      updateLeadPriority: async (input) => calls.priorityUpdates.push(input),
      updateLeadVoicemailTranscription: async (input) => calls.transcriptionUpdates.push(input),
    },
    "@/lib/twilio": {
      sendOwnerSms: async (input) => calls.ownerSms.push(input),
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async (input) => calls.adminIssues.push(input),
      notifyOwnerVoicemailReady: async () => {},
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
      transcript: null,
      summary: null,
      status: "failed",
      error: "No usable voicemail was recorded. Relay did not generate a transcript.",
    }]);
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
});

test("non-service voicemails preserve raw evidence and persist a useful summary", async () => {
  const originalFetch = globalThis.fetch;
  const transcript = "Hello, this is Sophia from AT&T. Your monthly bill discount will be removed today.";
  const summary = "Non-service voicemail: AT&T billing discount notice.";
  const fetches = [];

  globalThis.fetch = async (url) => {
    fetches.push(String(url));

    if (String(url).includes("Recordings/RE_1.mp3")) {
      return new Response("fake-audio", { status: 200 });
    }

    if (String(url).endsWith("/audio/transcriptions")) {
      return Response.json({ text: transcript });
    }

    if (String(url).endsWith("/responses")) {
      const responseIndex = fetches.filter((item) => item.endsWith("/responses")).length;
      if (responseIndex === 1) return Response.json({ output_text: summary });
      return Response.json({ output_text: "normal - billing notice" });
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
    assert.deepEqual(calls.transcriptionUpdates[0], {
      accountId: "acct-1",
      id: "lead-1",
      rawTranscript: transcript,
      transcript: null,
      summary: null,
      status: "processing",
      error: null,
    });
    assert.deepEqual(calls.transcriptionUpdates[1], {
      accountId: "acct-1",
      id: "lead-1",
      transcript,
      status: "processing",
      error: null,
    });
    assert.deepEqual(calls.transcriptionUpdates.at(-1), {
      accountId: "acct-1",
      id: "lead-1",
      rawTranscript: transcript,
      transcript,
      summary,
      status: "completed",
      error: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("casual voicemail stays verbatim and is never sent through transcript rewriting", async () => {
  const originalFetch = globalThis.fetch;
  const rawTranscript = "  Hey Sutton, it's Joe. Just calling to say what's up. Give me a call. Peace.  ";
  const displayTranscript = rawTranscript.trim();
  const summary = "Personal call from Joe asking Sutton to call him back.";
  const responseInputs = [];
  let transcriptionForm = null;

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("Recordings/RE_joe.mp3")) {
      return new Response("fake-audio", { status: 200 });
    }

    if (String(url).endsWith("/audio/transcriptions")) {
      transcriptionForm = init.body;
      return Response.json({ text: rawTranscript });
    }

    if (String(url).endsWith("/responses")) {
      const body = JSON.parse(init.body);
      responseInputs.push(body.input?.[1]?.content ?? "");
      return Response.json({
        output_text: responseInputs.length === 1 ? summary : "normal - personal callback",
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
    assert.equal(transcriptionForm.get("prompt"), null, "biased home-service prompt must be absent");
    assert.deepEqual(responseInputs, [
      displayTranscript,
      `${displayTranscript} ${summary}`,
    ], "only summary and priority may use the Responses API");
    assert.deepEqual(calls.transcriptionUpdates[0], {
      accountId: "acct-1",
      id: "lead-joe",
      rawTranscript,
      transcript: null,
      summary: null,
      status: "processing",
      error: null,
    });
    assert.deepEqual(calls.transcriptionUpdates.at(-1), {
      accountId: "acct-1",
      id: "lead-joe",
      rawTranscript,
      transcript: displayTranscript,
      summary,
      status: "completed",
      error: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function makeCronMocks({ cronSecret = "secret", leads = [], failLeadIds = new Set() } = {}) {
  const calls = {
    listed: 0,
    transcriptions: [],
  };

  const mocks = {
    "@/lib/env": {
      env: { cronSecret },
    },
    "@/lib/supabase": {
      listLeadsNeedingTranscriptionRetry: async () => {
        calls.listed += 1;
        return leads;
      },
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

  assert.equal(response.status, 200);
  assert.deepEqual(calls.transcriptions, [
    { leadId: "lead-1", accountId: "acct-1" },
    { leadId: "lead-2", accountId: "acct-2" },
  ]);
  assert.equal(body.attempted, 2);
  assert.equal(body.succeeded, 1);
  assert.equal(body.skipped, 0);
  assert.equal(body.failed, 1);
});
