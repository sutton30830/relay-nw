import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Owner correction of wrong transcripts: "This transcript is wrong" hides the
// customer-facing text, keeps evidence, resets urgency, and is idempotent.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function loadModule(path, mocks) {
  const source = await read(path);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`Missing mock: ${id}`);
  };
  new vm.Script(`(function(require,module,exports){${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const quality = await loadModule("lib/voicemail-quality.ts", {});

function disputeHarness({ lead } = {}) {
  const state = { lookups: [], transcriptionUpdates: [], priorityUpdates: [], actions: [] };
  const supabase = {
    getLeadForVoicemailTranscription: async (id, accountId) => {
      state.lookups.push({ id, accountId });
      return lead && lead.account_id === accountId && lead.id === id ? lead : null;
    },
    updateLeadVoicemailTranscription: async (input) => { state.transcriptionUpdates.push(input); },
    updateLeadPriority: async (input) => { state.priorityUpdates.push(input); },
    recordProviderAction: async (input) => { state.actions.push(input); return { id: "evt" }; },
  };
  return { state, mocks: { "@/lib/supabase": supabase, "@/lib/voicemail-quality": quality } };
}

const transcribedLead = {
  id: "lead-1",
  account_id: "acct-a",
  phone: "+12065550177",
  recording_sid: "RE1",
  recording_duration: 34,
  voicemail_transcript: "Looking for a quote on a faucet.",
  voicemail_summary: "Faucet quote.",
  voicemail_transcription_status: "completed",
  voicemail_transcription_error: null,
};

test("dispute hides transcript and summary, keeps raw evidence, resets urgency, records the decision", async () => {
  const { state, mocks } = disputeHarness({ lead: transcribedLead });
  const { disputeLeadVoicemailTranscript } = await loadModule("lib/voicemail-dispute.ts", mocks);

  const result = await disputeLeadVoicemailTranscript({ leadId: "lead-1", accountId: "acct-a", actorEmail: "owner@x.test" });
  assert.deepEqual(result, { outcome: "disputed" });

  assert.equal(state.transcriptionUpdates.length, 1);
  const update = state.transcriptionUpdates[0];
  assert.equal(update.accountId, "acct-a");
  assert.equal(update.id, "lead-1");
  assert.equal(update.transcript, null);
  assert.equal(update.summary, null);
  assert.equal(update.status, "failed");
  assert.equal(update.error, quality.OWNER_DISPUTED_TRANSCRIPT_MESSAGE);
  assert.deepEqual(update.summaryValidationReasons, ["owner_disputed"]);
  assert.equal("rawTranscript" in update, false, "provider raw output is preserved as evidence");

  assert.deepEqual(state.priorityUpdates, [{ accountId: "acct-a", id: "lead-1", priority: "normal", priorityReason: null }]);

  assert.equal(state.actions.length, 1);
  const action = state.actions[0];
  assert.equal(action.accountId, "acct-a");
  assert.equal(action.action, "voicemail_transcription_disputed");
  assert.equal(action.idempotencyKey, "voicemail_dispute:lead-1");
  assert.equal(action.internalStatus, "suppressed");
  assert.equal(action.retryEligibility, "never");
  assert.equal(action.customerVisible, false, "not a red failure banner for the owner");
  assert.equal(action.expectedSuppression, true, "monitoring treats it as healthy");
});

test("dispute is idempotent: a second tap changes nothing", async () => {
  const disputed = {
    ...transcribedLead,
    voicemail_transcript: null,
    voicemail_summary: null,
    voicemail_transcription_status: "failed",
    voicemail_transcription_error: quality.OWNER_DISPUTED_TRANSCRIPT_MESSAGE,
  };
  const { state, mocks } = disputeHarness({ lead: disputed });
  const { disputeLeadVoicemailTranscript } = await loadModule("lib/voicemail-dispute.ts", mocks);

  const result = await disputeLeadVoicemailTranscript({ leadId: "lead-1", accountId: "acct-a" });
  assert.deepEqual(result, { outcome: "already_disputed" });
  assert.equal(state.transcriptionUpdates.length, 0);
  assert.equal(state.priorityUpdates.length, 0);
  assert.equal(state.actions.length, 0);
});

test("dispute cannot reach another tenant's lead or a lead without a recording", async () => {
  const other = disputeHarness({ lead: transcribedLead });
  const { disputeLeadVoicemailTranscript } = await loadModule("lib/voicemail-dispute.ts", other.mocks);
  assert.deepEqual(await disputeLeadVoicemailTranscript({ leadId: "lead-1", accountId: "acct-b" }), { outcome: "not_found" });
  assert.deepEqual(other.state.lookups, [{ id: "lead-1", accountId: "acct-b" }]);
  assert.equal(other.state.transcriptionUpdates.length + other.state.priorityUpdates.length + other.state.actions.length, 0);

  const noRecording = disputeHarness({ lead: { ...transcribedLead, recording_sid: null } });
  const mod = await loadModule("lib/voicemail-dispute.ts", noRecording.mocks);
  assert.deepEqual(await mod.disputeLeadVoicemailTranscript({ leadId: "lead-1", accountId: "acct-a" }), { outcome: "no_recording" });
  assert.equal(noRecording.state.transcriptionUpdates.length, 0);
});

test("dispute route uses the session account, blocks viewers, and maps outcomes to status codes", async () => {
  const calls = [];
  async function load({ role = "owner", outcome = "disputed" } = {}) {
    return loadModule("app/api/leads/[id]/voicemail-dispute/route.ts", {
      "@/lib/auth": {
        requireWriteAccessJson: async (message) => role === "viewer"
          ? { session: null, response: Response.json({ error: message }, { status: 403 }) }
          : { session: { accountId: "acct-session", email: "owner@x.test", role }, response: null },
      },
      "@/lib/voicemail-dispute": {
        disputeLeadVoicemailTranscript: async (input) => { calls.push(input); return { outcome }; },
      },
    });
  }
  const params = Promise.resolve({ id: "lead-9" });
  const request = new Request("https://relay.test/api/leads/lead-9/voicemail-dispute", { method: "POST" });

  const viewer = await (await load({ role: "viewer" })).POST(request, { params });
  assert.equal(viewer.status, 403);
  assert.equal(calls.length, 0);

  const ok = await (await load()).POST(request, { params });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, outcome: "disputed" });
  assert.deepEqual(calls.at(-1), { leadId: "lead-9", accountId: "acct-session", actorEmail: "owner@x.test" });

  assert.equal((await (await load({ outcome: "not_found" })).POST(request, { params })).status, 404);
  assert.equal((await (await load({ outcome: "no_recording" })).POST(request, { params })).status, 400);
  assert.equal((await (await load({ outcome: "already_disputed" })).POST(request, { params })).status, 200);
});

test("a disputed transcript is an expected suppression everywhere retries and monitoring look", async () => {
  const providerActions = await loadModule("lib/provider-actions.ts", {});
  assert.equal(providerActions.isExpectedQualitySuppression(quality.OWNER_DISPUTED_TRANSCRIPT_MESSAGE), true);
  assert.equal(quality.isOwnerDisputedTranscript(quality.OWNER_DISPUTED_TRANSCRIPT_MESSAGE), true);
  assert.equal(quality.isOwnerDisputedTranscript("Relay could not confidently transcribe this voicemail."), false);

  const voicemails = await read("lib/supabase/voicemails.ts");
  assert.match(voicemails, /\.not\("voicemail_transcription_error", "ilike", "You marked this transcript as wrong%"\)/);
  assert.match(voicemails, /voicemail_transcription_error, voicemail_transcribed_at"\)/);
});

test("an owner-corrected summary re-classifies urgency from the corrected text", async () => {
  const priority = await loadModule("lib/priority.ts", {});
  const updates = [];
  const priorities = [];
  const route = await loadModule("app/api/leads/[id]/route.ts", {
    "@/lib/auth": {
      requireWriteAccessJson: async () => ({ session: { accountId: "acct-a", role: "owner" }, response: null }),
    },
    "@/lib/priority": priority,
    "@/lib/supabase": {
      updateLead: async (input) => { updates.push(input); },
      updateLeadPriority: async (input) => { priorities.push(input); },
      deleteLead: async () => {},
    },
  });
  const patch = (body) => route.PATCH(
    new Request("https://relay.test/api/leads/lead-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "lead-1" }) },
  );

  assert.equal((await patch({ voicemailSummary: "No heat since last night, needs someone today." })).status, 200);
  assert.deepEqual(priorities, [{ accountId: "acct-a", id: "lead-1", priority: "fast", priorityReason: "mentioned no heat" }]);
  assert.equal(updates.at(-1).voicemailSummary, "No heat since last night, needs someone today.");

  assert.equal((await patch({ voicemailSummary: "Wants a quote for a new faucet sometime next month." })).status, 200);
  assert.deepEqual(priorities.at(-1), { accountId: "acct-a", id: "lead-1", priority: "normal", priorityReason: null });

  // Clearing the summary or editing notes never rewrites urgency.
  assert.equal((await patch({ voicemailSummary: null })).status, 200);
  assert.equal((await patch({ notes: "called back" })).status, 200);
  assert.equal(priorities.length, 2);
});

test("conversation page offers both corrections inline and hides them for viewers", async () => {
  const view = await read("app/leads/[id]/conversation-view.tsx");
  const corrections = await read("app/leads/_components/voicemail-corrections.tsx");
  const card = await read("app/leads/_components/lead-card.tsx");
  const utils = await read("app/leads/_utils.ts");
  const css = await read("app/globals.css");

  assert.match(view, /\{!readOnly \? \(\s*<VoicemailCorrections/);
  assert.match(corrections, /patchLead\(leadId, \{ voicemailSummary: next \}\)/);
  assert.match(corrections, /disputeVoicemailTranscript\(leadId\)/);
  assert.match(corrections, /Yes, it's wrong/);
  assert.match(corrections, /Keep it/);
  assert.match(corrections, /maxLength=\{MAX_SUMMARY_LENGTH\}/);
  assert.match(corrections, /event\.key === "Escape"/);
  // Disputed leads read as an owner decision, never a Relay failure, and never offer a paid retry.
  assert.match(utils, /error\?\.includes\("marked this transcript as wrong"\)/);
  assert.match(utils, /You marked this transcript as wrong\. Listen to the recording, then call back\./);
  assert.match(card, /You marked the transcript as wrong\. Open the lead to listen, then call back\./);
  assert.match(css, /\.vm-fix__actions \.btn \{\s*min-height: 40px;/);
  assert.match(css, /\.vm-fix__link \{[^}]*min-height: 32px/);
});
