import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Failure-injection coverage for the missed-call -> SMS -> lead pipeline.
// Every step must either succeed visibly or fail visibly: a failure anywhere must end
// with the lead in an accurate state and/or a webhook event log entry — never a silent
// stale "pending" that only shows up by digging through Supabase or Twilio logs.

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
const voicemailConfidenceModule = {
  assessTranscriptionConfidence: () => ({
    confidence: 0.99,
    quality: "reliable",
    reasons: [],
    metrics: {
      average_logprob: -0.01,
      minimum_logprob: -0.01,
      low_confidence_token_fraction: 0,
      token_count: 1,
    },
  }),
  transcriptWordErrorRate: () => 0,
  transcriptsMateriallyDisagree: () => false,
};
const voicemailSummaryModule = {
  parseStructuredVoicemailSummary: () => null,
  validateStructuredVoicemailSummary: () => ({ result: null, reasons: [] }),
  VOICEMAIL_SUMMARY_JSON_SCHEMA: {},
};

const ACCOUNT = {
  accountId: "acct-1",
  accountSlug: "demo",
  businessName: "Demo HVAC",
  smsEnabled: true,
  missedCallSmsCooldownHours: 6,
  twilioPhoneNumber: "+15551234567",
  ownerPhoneNumber: "+15557654321",
  ownerEmail: "owner@example.com",
};

function resolveConsistentAccountEvidence(evidence) {
  const resolved = evidence.filter((item) => item.resolution.status === "resolved");
  const accountIds = new Set(resolved.map((item) => item.resolution.account.accountId));
  if (accountIds.size > 1) {
    return { status: "unresolved", reason: "provider_account_evidence_mismatch", lookupValue: null };
  }
  return resolved[0]?.resolution ?? evidence[0].resolution;
}

function makeMissedCallMocks(overrides = {}) {
  const calls = {
    leadSmsStatusUpdates: [],
    messagesCreated: [],
    adminIssues: [],
    ownerNotifications: [],
    ownerPush: [],
    twilioSends: [],
  };

  const supabase = {
    createMissedCallLeadIfNew: async () => ({ inserted: true, leadId: "lead-1" }),
    updateCallForMissedLead: async () => {},
    hasRecentMissedCallSms: async () => false,
    isOptedOut: async () => false,
    assertTenantAccount: (account) => account,
    updateLeadSmsStatus: async (input) => {
      calls.leadSmsStatusUpdates.push(input);
    },
    createMessageIfNew: async (input) => {
      calls.messagesCreated.push(input);
      return { inserted: true };
    },
    ...overrides.supabase,
  };

  const twilioClient = {
    messages: {
      create: async (input) => {
        calls.twilioSends.push(input);
        return { sid: "SM_test_123" };
      },
      ...overrides.twilioMessages,
    },
  };

  const mocks = {
    "@/lib/env": { env: { appBaseUrl: "http://localhost:3000" } },
    "@/lib/phone": { normalizePhoneNumber: (value) => value },
    "@/lib/supabase": supabase,
    "@/lib/supabase/accounts": { envAccountConfig: () => ACCOUNT },
    "@/lib/twilio": {
      missedCallSmsBodyForAccount: () => "We missed your call.",
      phoneLast4: (value) => String(value ?? "").slice(-4),
      twilioClient,
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async (input) => {
        calls.adminIssues.push(input);
      },
      notifyOwnerNewMissedCallLead: async (input) => {
        calls.ownerNotifications.push(input);
      },
    },
    "@/lib/web-push": {
      notifyOwnerByWebPush: async (input) => {
        calls.ownerPush.push(input);
        return { attempted: 1, delivered: 1, disabled: 0 };
      },
    },
  };

  return { mocks, calls, supabase };
}

async function runMissedCall(mocks, account = ACCOUNT) {
  const { handleMissedCall } = await loadTsModule("lib/missed-call.ts", mocks);
  return handleMissedCall({
    account,
    callerPhone: "+12065550123",
    callSid: "CA_test_1",
    message: null,
  });
}

test("happy path: SMS sent, lead marked sent with MessageSid", async () => {
  const { mocks, calls } = makeMissedCallMocks();
  const result = await runMissedCall(mocks);

  assert.equal(result.smsStatus, "sent");
  assert.equal(result.twilioMessageSid, "SM_test_123");
  const sentUpdate = calls.leadSmsStatusUpdates.find((u) => u.smsStatus === "sent");
  assert.ok(sentUpdate, "lead should be marked sent");
  assert.equal(sentUpdate.twilioMessageSid, "SM_test_123");
  assert.equal(calls.messagesCreated.length, 1, "outbound message row recorded for reconciliation");
  assert.deepEqual(calls.ownerPush, [{
    account: ACCOUNT,
    event: "missed_call",
    leadId: "lead-1",
    callerPhone: "+12065550123",
  }]);
});

test("Twilio accepted but lead update failed: returns sent_update_failed, never marks lead failed, alerts admin", async () => {
  const { mocks, calls } = makeMissedCallMocks({
    supabase: {
      updateLeadSmsStatus: async (input) => {
        calls.leadSmsStatusUpdates.push(input);
        if (input.smsStatus === "sent") {
          throw new Error("supabase write failed");
        }
      },
    },
  });
  // Re-wire calls into overrides (makeMissedCallMocks merged overrides before calls existed).
  const result = await runMissedCall(mocks);

  assert.equal(result.smsStatus, "sent_update_failed");
  assert.equal(result.twilioMessageSid, "SM_test_123");
  assert.ok(
    !calls.leadSmsStatusUpdates.some((u) => u.smsStatus === "failed"),
    "lead must not be marked failed when Twilio accepted the SMS",
  );
  assert.equal(calls.adminIssues.length, 1);
  assert.match(calls.adminIssues[0].detail, /reconcil/i, "admin alert should explain reconciliation");
  assert.equal(calls.messagesCreated.length, 1, "message row exists so the status callback can reconcile the lead");
});

test("Twilio accepted but message row insert failed: lead still marked sent, admin alerted, no false 'failed'", async () => {
  const { mocks, calls } = makeMissedCallMocks({
    supabase: {
      createMessageIfNew: async () => {
        throw new Error("messages table write failed");
      },
    },
  });
  const result = await runMissedCall(mocks);

  assert.equal(result.smsStatus, "sent", "a bookkeeping failure must not change the customer-facing outcome");
  const sentUpdate = calls.leadSmsStatusUpdates.find((u) => u.smsStatus === "sent");
  assert.ok(sentUpdate, "lead should still converge to sent");
  assert.ok(
    !calls.leadSmsStatusUpdates.some((u) => u.smsStatus === "failed"),
    "lead must not be wrongly marked failed (which would re-open the cooldown and risk a double text)",
  );
  assert.equal(calls.adminIssues.length, 1);
});

test("cooldown/opt-out check failure fails closed: no SMS sent, lead marked failed with reason, admin alerted", async () => {
  const { mocks, calls } = makeMissedCallMocks({
    supabase: {
      hasRecentMissedCallSms: async () => {
        throw new Error("supabase read failed");
      },
    },
  });
  const result = await runMissedCall(mocks);

  assert.equal(result.smsStatus, "failed");
  assert.equal(calls.twilioSends.length, 0, "must not text when opt-out/cooldown cannot be verified");
  const failedUpdate = calls.leadSmsStatusUpdates.find((u) => u.smsStatus === "failed");
  assert.ok(failedUpdate, "lead should be marked failed, not left pending");
  assert.match(failedUpdate.smsError, /cooldown\/opt-out/i);
  assert.equal(calls.adminIssues.length, 1);
});

test("Twilio send failure: lead marked failed with error, admin and owner notified", async () => {
  const { mocks, calls } = makeMissedCallMocks({
    twilioMessages: {
      create: async () => {
        throw new Error("twilio 30007");
      },
    },
  });
  const result = await runMissedCall(mocks);

  assert.equal(result.smsStatus, "failed");
  const failedUpdate = calls.leadSmsStatusUpdates.find((u) => u.smsStatus === "failed");
  assert.ok(failedUpdate);
  assert.match(failedUpdate.smsError, /30007/);
  assert.equal(calls.adminIssues.length, 1);
  assert.ok(calls.ownerNotifications.some((n) => n.smsStatus === "failed"));
});

test("recent SMS within cooldown: skipped_recent, no double text to the caller", async () => {
  const { mocks, calls } = makeMissedCallMocks({
    supabase: { hasRecentMissedCallSms: async () => true },
  });
  const result = await runMissedCall(mocks);

  assert.equal(result.smsStatus, "skipped_recent");
  const callerSends = calls.twilioSends.filter((send) => send.to !== ACCOUNT.ownerPhoneNumber);
  assert.equal(callerSends.length, 0, "must never double-text a caller inside the cooldown");
  // The owner is told the caller tried again — a repeat call is a hot lead, not noise.
  const ownerSends = calls.twilioSends.filter((send) => send.to === ACCOUNT.ownerPhoneNumber);
  assert.equal(ownerSends.length, 1);
  assert.match(ownerSends[0].body, /called .*again/i);
});

test("opted-out caller: skipped_opt_out, no SMS to the caller", async () => {
  const { mocks, calls } = makeMissedCallMocks({
    supabase: { isOptedOut: async () => true },
  });
  const result = await runMissedCall(mocks);

  assert.equal(result.smsStatus, "skipped_opt_out");
  const callerSends = calls.twilioSends.filter((send) => send.to !== ACCOUNT.ownerPhoneNumber);
  assert.equal(callerSends.length, 0, "must never text an opted-out caller");
  // The owner still gets an SMS heads-up so they can call the lead back.
  const ownerSends = calls.twilioSends.filter((send) => send.to === ACCOUNT.ownerPhoneNumber);
  assert.equal(ownerSends.length, 1);
  assert.match(ownerSends[0].body, /opted out/i);
});

test("missed call handled: owner gets an SMS heads-up from the Relay number", async () => {
  const { mocks, calls } = makeMissedCallMocks();
  const result = await runMissedCall(mocks);

  assert.equal(result.smsStatus, "sent");
  const ownerSends = calls.twilioSends.filter((send) => send.to === ACCOUNT.ownerPhoneNumber);
  assert.equal(ownerSends.length, 1);
  assert.equal(ownerSends[0].from, ACCOUNT.twilioPhoneNumber);
  assert.match(ownerSends[0].body, /missed call/i);
});

test("missed-call owner text can be disabled without suppressing the caller text", async () => {
  const { mocks, calls } = makeMissedCallMocks();
  const account = {
    ...ACCOUNT,
    notificationPreferences: {
      missedCall: { email: true, sms: false },
      voicemailReady: { email: true, sms: false },
      inboundReply: { email: true, sms: true },
      urgentVoicemailSms: true,
    },
  };

  const result = await runMissedCall(mocks, account);

  assert.equal(result.smsStatus, "sent");
  assert.equal(calls.twilioSends.filter((send) => send.to === ACCOUNT.ownerPhoneNumber).length, 0);
  assert.equal(calls.twilioSends.filter((send) => send.to === "+12065550123").length, 1);
  assert.equal(calls.ownerNotifications.length, 1, "email delivery remains independent");
});

test("owner SMS failure never breaks the customer-facing flow", async () => {
  const { mocks, calls } = makeMissedCallMocks({
    twilioMessages: {
      create: async (input) => {
        calls.twilioSends.push(input);
        if (input.to === ACCOUNT.ownerPhoneNumber) {
          throw new Error("owner unreachable");
        }
        return { sid: "SM_test_123" };
      },
    },
  });
  const result = await runMissedCall(mocks);

  assert.equal(result.smsStatus, "sent", "customer SMS result must be unaffected");
  assert.ok(calls.ownerNotifications.some((n) => n.smsStatus === "sent"), "email fallback still fires");
});

test("manual replies request delivery callbacks and record Twilio's initial status", async () => {
  const twilioSends = [];
  const recordedMessages = [];
  const { POST } = await loadTsModule("app/api/leads/[id]/reply/route.ts", {
    "@/lib/auth": {
      requireWriteAccessJson: async () => ({
        response: null,
        session: { account: ACCOUNT, accountId: ACCOUNT.accountId },
      }),
    },
    "@/lib/env": { env: { appBaseUrl: "https://relay.example" } },
    "@/lib/supabase": {
      createMessageIfNew: async (input) => recordedMessages.push(input),
      getLeadByIdForAccount: async () => ({
        id: "lead-1",
        phone: "+14305558502",
        status: "contacted",
        deleted_at: null,
      }),
      isOptedOut: async () => false,
      updateLead: async () => {},
    },
    "@/lib/twilio": {
      phoneLast4: (phone) => phone.slice(-4),
      twilioClient: {
        messages: {
          create: async (input) => {
            twilioSends.push(input);
            return { sid: "SM_manual_1", status: "queued" };
          },
        },
      },
    },
  });

  const response = await POST(
    new Request("https://relay.example/api/leads/lead-1/reply", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "reply-test-0001" },
      body: JSON.stringify({ body: "We can help this afternoon." }),
    }),
    { params: Promise.resolve({ id: "lead-1" }) },
  );

  assert.equal(response.status, 200);
  assert.equal(
    twilioSends[0].statusCallback,
    "https://relay.example/api/twilio/sms-status?messageType=manual_reply&accountId=acct-1&leadId=lead-1&actionKey=manual_reply%3Alead-1%3Areply-test-0001",
  );
  assert.equal(recordedMessages[0].status, "queued");
  const payload = await response.json();
  assert.equal(payload.message.status, "queued");
});

// --- SMS status callback reconciliation (production-readiness item #8) ---

function makeSmsStatusRouteMocks(state) {
  return {
    "@/lib/env": { env: { allowUnsignedTwilioWebhooks: true } },
    "@/lib/supabase": {
      assertTenantAccount: (account) => account,
      getAccountConfigByAccountId: async (accountId) => accountId === ACCOUNT.accountId ? ACCOUNT : null,
      resolveAccountByMessageSid: async () => ({ status: "resolved", account: ACCOUNT }),
      resolveConsistentAccountEvidence,
      resolveAccountSafely: async (resolve) => resolve(),
      updateLeadSmsStatusByMessageSid: async (input) => {
        state.leadUpdatesBySid.push(input);
        return { updated: state.leadHasMessageSid };
      },
      updateLeadSmsStatus: async (input) => {
        state.leadUpdatesById.push(input);
      },
      getOutboundMessageLeadIdBySid: async () => state.messageRowLeadId,
      updateMessageStatusBySid: async (input) => {
        state.messageStatusUpdates.push(input);
        return { updated: true };
      },
      recordSmsOnboardingEvidence: async (input) => {
        state.onboardingEvidence.push(input);
      },
      logWebhookEvent: async (input) => {
        state.webhookEvents.push(input);
      },
    },
    "@/lib/twilio": {
      formDataToRecord: (formData) => Object.fromEntries(formData.entries()),
      rejectInvalidTwilioSignature: () => new Response("invalid", { status: 403 }),
      summarizeTwilioRequest: () => ({}),
      validateTwilioWebhook: () => ({
        shouldReject: false,
        wasAllowedByOverride: false,
        matchedUrl: "https://example.com/api/twilio/sms-status",
        candidateUrls: [],
        hasSignature: true,
      }),
    },
    "@/lib/twilio/unresolved-account": {
      handleUnresolvedTwilioAccount: () => new Response("", { status: 200 }),
    },
    "@/lib/twiml": {
      emptyTwiml: () => "<Response/>",
      twimlResponse: (xml) => new Response(xml, { status: 200 }),
    },
  };
}

async function postSmsStatus(mocks, payload, url = "https://example.com/api/twilio/sms-status") {
  const { POST } = await loadTsModule("app/api/twilio/sms-status/route.ts", mocks);
  const body = new URLSearchParams(payload);
  const request = new Request(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  return POST(request);
}

function smsStatusState({ leadHasMessageSid, messageRowLeadId }) {
  return {
    leadHasMessageSid,
    messageRowLeadId,
    leadUpdatesBySid: [],
    leadUpdatesById: [],
    messageStatusUpdates: [],
    onboardingEvidence: [],
    webhookEvents: [],
  };
}

test("status callback with matching lead: lead updated, webhook event logged", async () => {
  const state = smsStatusState({ leadHasMessageSid: true, messageRowLeadId: null });
  const response = await postSmsStatus(makeSmsStatusRouteMocks(state), {
    MessageSid: "SM_test_123",
    MessageStatus: "delivered",
  });

  assert.equal(response.status, 200);
  assert.equal(state.leadUpdatesBySid.length, 1);
  assert.equal(state.leadUpdatesBySid[0].smsStatus, "delivered");
  assert.equal(state.leadUpdatesById.length, 0, "no reconciliation needed");
  assert.equal(state.webhookEvents.length, 1);
  assert.equal(state.onboardingEvidence[0].accountId, ACCOUNT.accountId);
  assert.equal(state.onboardingEvidence[0].status, "delivered");
});

test("signed Twilio landline callback reaches the tenant onboarding evidence recorder", async () => {
  const state = smsStatusState({ leadHasMessageSid: true, messageRowLeadId: null });
  const response = await postSmsStatus(makeSmsStatusRouteMocks(state), {
    MessageSid: "SM_landline_test",
    MessageStatus: "undelivered",
    ErrorCode: "30006",
  });

  assert.equal(response.status, 200);
  assert.equal(state.onboardingEvidence.length, 1);
  assert.equal(state.onboardingEvidence[0].accountId, ACCOUNT.accountId);
  assert.equal(state.onboardingEvidence[0].errorCode, "30006");
});

test("stale lead reconciliation: callback for a MessageSid no lead carries converges the lead via the messages table", async () => {
  const state = smsStatusState({ leadHasMessageSid: false, messageRowLeadId: "lead-stale-1" });
  const response = await postSmsStatus(makeSmsStatusRouteMocks(state), {
    MessageSid: "SM_test_123",
    MessageStatus: "delivered",
  });

  assert.equal(response.status, 200);
  assert.equal(state.leadUpdatesById.length, 1, "lead should be reconciled by id");
  assert.equal(state.leadUpdatesById[0].id, "lead-stale-1");
  assert.equal(state.leadUpdatesById[0].smsStatus, "delivered");
  assert.equal(
    state.leadUpdatesById[0].twilioMessageSid,
    "SM_test_123",
    "reconciliation must backfill the missing MessageSid so future callbacks match directly",
  );
  assert.equal(state.webhookEvents.length, 1);
  assert.match(state.webhookEvents[0].error ?? "", /reconciled lead lead-stale-1/i, "reconciliation must be visible in the webhook event log");
});

test("failed delivery status reconciles too: stale lead converges to failed with the Twilio error", async () => {
  const state = smsStatusState({ leadHasMessageSid: false, messageRowLeadId: "lead-stale-2" });
  await postSmsStatus(makeSmsStatusRouteMocks(state), {
    MessageSid: "SM_test_456",
    MessageStatus: "failed",
    ErrorCode: "30003",
  });

  assert.equal(state.leadUpdatesById.length, 1);
  assert.equal(state.leadUpdatesById[0].smsStatus, "failed");
  assert.match(state.leadUpdatesById[0].smsError ?? "", /30003/);
});

test("manual reply callback updates only its message and preserves the auto-text lead status", async () => {
  const state = smsStatusState({ leadHasMessageSid: false, messageRowLeadId: "lead-1" });
  await postSmsStatus(
    makeSmsStatusRouteMocks(state),
    {
      MessageSid: "SM_manual_1",
      MessageStatus: "undelivered",
      ErrorCode: "30006",
    },
    "https://example.com/api/twilio/sms-status?messageType=manual_reply&accountId=acct-1",
  );

  assert.equal(state.leadUpdatesBySid.length, 0, "manual replies must not overwrite lead.sms_status");
  assert.equal(state.leadUpdatesById.length, 0, "manual replies must not trigger auto-text reconciliation");
  assert.equal(state.messageStatusUpdates.length, 1);
  assert.equal(state.messageStatusUpdates[0].status, "undelivered");
  assert.equal(state.messageStatusUpdates[0].error, "30006");
  assert.match(state.webhookEvents[0].error ?? "", /Manual reply status updated/i);
});

test("invalid SMS status signatures fail closed before any tenant write", async () => {
  const state = smsStatusState({ leadHasMessageSid: false, messageRowLeadId: null });
  const mocks = makeSmsStatusRouteMocks(state);
  let rejected = 0;
  mocks["@/lib/twilio"] = {
    ...mocks["@/lib/twilio"],
    validateTwilioWebhook: () => ({
      shouldReject: true,
      wasAllowedByOverride: false,
      matchedUrl: null,
      candidateUrls: ["https://example.com/api/twilio/sms-status"],
      hasSignature: true,
    }),
    rejectInvalidTwilioSignature: () => {
      rejected += 1;
      return new Response("Forbidden", { status: 403 });
    },
  };

  const response = await postSmsStatus(mocks, {
    MessageSid: "SM_invalid_signature",
    MessageStatus: "delivered",
  });

  assert.equal(response.status, 403);
  assert.equal(rejected, 1);
  assert.deepEqual(state.leadUpdatesBySid, []);
  assert.deepEqual(state.leadUpdatesById, []);
  assert.deepEqual(state.messageStatusUpdates, []);
  assert.deepEqual(state.onboardingEvidence, []);
  assert.deepEqual(state.webhookEvents, []);
});

test("orphan callback (no lead, no message row): webhook event records the miss", async () => {
  const state = smsStatusState({ leadHasMessageSid: false, messageRowLeadId: null });
  await postSmsStatus(makeSmsStatusRouteMocks(state), {
    MessageSid: "SM_orphan_1",
    MessageStatus: "delivered",
  });

  assert.equal(state.leadUpdatesById.length, 0);
  assert.equal(state.webhookEvents.length, 1);
  assert.match(state.webhookEvents[0].error ?? "", /No lead matched/i);
});

// --- Voicemail transcription failure visibility ---

test("SMS delivery errors become actionable customer-facing guidance", async () => {
  const { smsDeliveryIssue, smsDeliveryStatusLabel } = await loadTsModule("lib/twilio/sms-delivery.ts", {});

  assert.deepEqual(smsDeliveryIssue("undelivered", "30006"), {
    title: "Text could not be delivered",
    guidance: "This may be a landline or a number that cannot receive texts. Call the customer instead.",
    diagnostic: "Twilio error 30006 · Landline or unreachable carrier",
  });
  assert.equal(smsDeliveryIssue("delivered", null), null);
  assert.equal(smsDeliveryStatusLabel("delivered"), "Delivered");
  assert.equal(smsDeliveryStatusLabel("failed"), "Not delivered");
});

test("classifyPriority: emergencies are fast, time-sensitive is today, quotes are normal", async () => {
  const { classifyPriority } = await loadTsModule("lib/priority.ts", {});

  assert.deepEqual(classifyPriority("my basement is flooding"), {
    level: "fast",
    reason: "mentioned flooding",
  });
  assert.deepEqual(classifyPriority("I have a really urgent request that needs attention"), {
    level: "fast",
    reason: "said it's urgent",
  });
  assert.equal(classifyPriority("could you come by tomorrow morning?").level, "today");
  assert.equal(classifyPriority("just wanted a quote on a new water heater").level, "normal");
  assert.equal(classifyPriority("").level, "normal");
  assert.equal(classifyPriority(null).level, "normal");
});

function makeVoicemailMocks(state) {
  return {
    "@/lib/env": {
      env: {
        twilioAccountSid: "AC_test",
        twilioAuthToken: "token",
        openaiApiKey: null,
        openaiTranscriptionModel: "gpt-4o-transcribe",
        openaiSummaryModel: "gpt-test",
      },
    },
    "@/lib/priority": {
      classifyPriority: (text) =>
        /\bflood(?:ing)?\b/i.test(text ?? "")
          ? { level: "fast", reason: "mentioned flooding" }
          : { level: "normal", reason: null },
    },
    "@/lib/voicemail-confidence": voicemailConfidenceModule,
    "@/lib/voicemail-summary": voicemailSummaryModule,
    "@/lib/voicemail-quality": voicemailQualityModule,
    "@/lib/supabase": {
      claimVoicemailTranscription: async (input) => {
        const claimed = state.claimResult ?? true;
        if (claimed) {
          state.transcriptionUpdates.push({
            accountId: input.accountId,
            id: input.id,
            status: "processing",
            error: null,
          });
        }
        return claimed;
      },
      getAccountConfigByAccountId: async () => ACCOUNT,
      getLeadForVoicemailTranscription: async () => state.lead,
      updateLeadVoicemailTranscription: async (input) => {
        state.transcriptionUpdates.push(input);
      },
      updateLeadPriority: async (input) => {
        state.priorityUpdates.push(input);
      },
    },
    "@/lib/twilio": {
      sendOwnerSms: async (input) => {
        state.ownerSmsSends.push(input);
        return true;
      },
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async (input) => {
        state.adminIssues.push(input);
      },
      notifyOwnerVoicemailReady: async () => {},
    },
    "@/lib/web-push": {
      notifyOwnerByWebPush: async () => ({ attempted: 0, delivered: 0, disabled: 0 }),
    },
  };
}

function voicemailState(lead) {
  return { lead, transcriptionUpdates: [], adminIssues: [], priorityUpdates: [], ownerSmsSends: [] };
}

test("transcription failure marks lead failed (UI shows 'Summary unavailable') and alerts admin", async () => {
  // openaiApiKey is null so the run fails after the lead is marked processing.
  const state = voicemailState({
    id: "lead-vm-1",
    phone: "+12065550123",
    recording_sid: "RE_1",
    voicemail_transcript: null,
    voicemail_summary: null,
    voicemail_transcription_status: null,
    voicemail_transcribed_at: null,
  });
  const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", makeVoicemailMocks(state));

  await assert.rejects(() => transcribeLeadVoicemail("lead-vm-1", "acct-1"));

  const failedUpdate = state.transcriptionUpdates.find((u) => u.status === "failed");
  assert.ok(failedUpdate, "lead must converge to failed, never stuck on processing");
  assert.ok(failedUpdate.error, "failure reason must be stored on the lead");
  assert.equal(state.adminIssues.length, 1);
});

test("fresh 'processing' lead is locked: concurrent run is rejected", async () => {
  const state = voicemailState({
    id: "lead-vm-2",
    phone: "+12065550123",
    recording_sid: "RE_2",
    voicemail_transcript: null,
    voicemail_summary: null,
    voicemail_transcription_status: "processing",
    voicemail_transcribed_at: new Date().toISOString(),
  });
  state.claimResult = false;
  const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", makeVoicemailMocks(state));

  await assert.rejects(() => transcribeLeadVoicemail("lead-vm-2", "acct-1"), /already generating/);
});

test("stale 'processing' lead (crashed run) is taken over instead of being locked forever", async () => {
  const state = voicemailState({
    id: "lead-vm-3",
    phone: "+12065550123",
    recording_sid: "RE_3",
    voicemail_transcript: null,
    voicemail_summary: null,
    voicemail_transcription_status: "processing",
    voicemail_transcribed_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  });
  const { transcribeLeadVoicemail } = await loadTsModule("lib/voicemail-ai.ts", makeVoicemailMocks(state));

  // Takeover proceeds past the lock; this run then fails (no transcription backend in
  // tests), which must converge the lead to "failed" rather than re-locking it.
  await assert.rejects(
    () => transcribeLeadVoicemail("lead-vm-3", "acct-1"),
    (error) => !/already generating/.test(String(error?.message ?? error)),
  );

  assert.ok(
    state.transcriptionUpdates.some((u) => u.status === "processing"),
    "stale lock should be taken over (re-marked processing)",
  );
  assert.ok(
    state.transcriptionUpdates.some((u) => u.status === "failed"),
    "and the failed takeover must converge to failed",
  );
});
