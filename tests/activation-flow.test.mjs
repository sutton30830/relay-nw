import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Route-spanning activation coverage for the real revenue loop:
// missed call -> lead -> SMS -> delivery callback -> caller reply -> voicemail.
// This uses one shared fake tenant state across the actual route handlers so a
// regression in the handoff between callbacks fails here, not in production.

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

const ACCOUNT = {
  accountId: "acct-phase-2",
  accountSlug: "phase-2",
  businessName: "Phase 2 Plumbing",
  smsEnabled: true,
  missedCallSmsCooldownHours: 6,
  twilioPhoneNumber: "+15551234567",
  ownerPhoneNumber: "+15557654321",
  ownerEmail: "owner@example.com",
  dialTimeoutSeconds: 18,
  voicemailMaxSeconds: 60,
  voicemailTranscriptionEnabled: true,
};

const CALLER = "+12065550123";
const CALL_SID = "CA_phase2_activation";
const RECORDING_SID = "RE1234567890abcdef1234567890abcdef";

function formDataToRecord(formData) {
  return Object.fromEntries([...formData.entries()].map(([key, value]) => [key, String(value)]));
}

function normalizePhoneNumber(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return String(value ?? "").trim();
}

function makeState({ account = ACCOUNT, failSentLeadUpdate = false } = {}) {
  return {
    account: { ...account },
    failSentLeadUpdate,
    leadSequence: 0,
    messageSequence: 0,
    inboundSequence: 0,
    calls: new Map(),
    leads: new Map(),
    messages: new Map(),
    inboundMessages: new Set(),
    webhookEvents: [],
    twilioSends: [],
    ownerEmails: [],
    adminIssues: [],
    afterCallbacks: [],
    transcriptions: [],
    optOuts: new Set(),
  };
}

function unresolved(reason, lookupValue) {
  return { status: "unresolved", reason, lookupValue };
}

function makeMocks(state) {
  const resolveByNumber = (value) =>
    normalizePhoneNumber(value) === state.account.twilioPhoneNumber
      ? { status: "resolved", account: state.account }
      : unresolved("twilio_number_not_registered", value);

  const supabase = {
    assertTenantAccount: (account) => account,
    resolveAccountSafely: async (resolver) => resolver(),
    resolveAccountByCallSid: async (callSid) =>
      state.calls.has(callSid) ? { status: "resolved", account: state.account } : unresolved("call_sid_not_registered", callSid),
    resolveAccountByTwilioNumber: async (phoneNumber) => resolveByNumber(phoneNumber),
    resolveAccountByMessageSid: async (messageSid) =>
      state.messages.has(messageSid) ? { status: "resolved", account: state.account } : unresolved("message_sid_not_registered", messageSid),
    upsertCall: async (input) => {
      const existing = state.calls.get(input.callSid) ?? {};
      state.calls.set(input.callSid, { ...existing, ...input });
    },
    createMissedCallLeadIfNew: async (input) => {
      for (const lead of state.leads.values()) {
        if (lead.account_id === input.accountId && lead.call_sid === input.callSid) {
          return { inserted: false, leadId: lead.id };
        }
      }

      const id = `lead-${++state.leadSequence}`;
      state.leads.set(id, {
        id,
        account_id: input.accountId,
        call_sid: input.callSid,
        phone: input.phone,
        message: input.message,
        sms_status: "pending",
        twilio_message_sid: null,
        recording_sid: null,
        recording_status: null,
        created_at: new Date(state.leadSequence * 1000).toISOString(),
      });
      return { inserted: true, leadId: id, createdAt: new Date(state.leadSequence * 1000).toISOString() };
    },
    updateCallForMissedLead: async (input) => {
      const call = state.calls.get(input.callSid) ?? { callSid: input.callSid };
      state.calls.set(input.callSid, { ...call, leadId: input.leadId, status: input.status });
    },
    hasRecentMissedCallSms: async () => false,
    isOptedOut: async (phone, accountId) => state.optOuts.has(`${accountId}:${phone}`),
    updateLeadSmsStatus: async (input) => {
      if (state.failSentLeadUpdate && input.smsStatus === "sent") {
        throw new Error("simulated lead sent update failure");
      }
      const lead = state.leads.get(input.id);
      assert.ok(lead, `expected lead ${input.id}`);
      Object.assign(lead, {
        sms_status: input.smsStatus,
        sms_error: input.smsError ?? null,
        twilio_message_sid: input.twilioMessageSid ?? lead.twilio_message_sid,
      });
    },
    createMessageIfNew: async (input) => {
      if (input.twilioMessageSid && state.messages.has(input.twilioMessageSid)) {
        return { inserted: false };
      }
      const id = `message-${++state.messageSequence}`;
      state.messages.set(input.twilioMessageSid ?? id, {
        id,
        ...input,
        status: input.status ?? null,
        error: null,
      });
      return { inserted: true, id };
    },
    updateLeadSmsStatusByMessageSid: async (input) => {
      const lead = [...state.leads.values()].find((row) => row.twilio_message_sid === input.twilioMessageSid);
      if (!lead) return { updated: false };
      Object.assign(lead, {
        sms_status: input.smsStatus,
        sms_error: input.smsError ?? null,
      });
      return { updated: true };
    },
    getOutboundMessageLeadIdBySid: async (input) => state.messages.get(input.twilioMessageSid)?.leadId ?? null,
    updateMessageStatusBySid: async (input) => {
      const message = state.messages.get(input.twilioMessageSid);
      if (!message) return { updated: false };
      Object.assign(message, { status: input.status, error: input.error ?? null });
      return { updated: true };
    },
    createInboundMessageIfNew: async (input) => {
      if (state.inboundMessages.has(input.messageSid)) return { inserted: false };
      state.inboundMessages.add(input.messageSid);
      return { inserted: true, id: `inbound-${++state.inboundSequence}` };
    },
    clearOptOut: async (phone, accountId) => state.optOuts.delete(`${accountId}:${phone}`),
    recordOptOut: async (phone, accountId) => state.optOuts.add(`${accountId}:${phone}`),
    updateCallRecordingByCallSid: async (input) => {
      const call = state.calls.get(input.callSid) ?? {};
      state.calls.set(input.callSid, { ...call, recordingSid: input.recordingSid });
    },
    updateLeadRecordingByCallSid: async (input) => {
      let lead = [...state.leads.values()].find((row) => row.call_sid === input.callSid);
      let matchedBy = "call_sid";
      if (!lead && input.callerPhone) {
        lead = [...state.leads.values()].find((row) => row.phone === input.callerPhone);
        matchedBy = "phone";
      }
      if (!lead) return { updated: false, leadId: null, matchedBy: null };
      Object.assign(lead, {
        recording_sid: input.recordingSid,
        recording_url: input.recordingUrl,
        recording_duration: input.recordingDuration,
        recording_status: input.recordingStatus,
      });
      return { updated: true, leadId: lead.id, matchedBy };
    },
    logWebhookEvent: async (input) => state.webhookEvents.push(input),
  };

  const twilioClient = {
    messages: {
      create: async (input) => {
        const sid = input.to === state.account.ownerPhoneNumber
          ? `SM_owner_${state.twilioSends.length + 1}`
          : `SM_auto_${state.twilioSends.length + 1}`;
        state.twilioSends.push({ ...input, sid });
        return { sid };
      },
    },
  };

  return {
    "next/server": {
      after: (fn) => state.afterCallbacks.push(fn),
    },
    "@/lib/env": {
      env: {
        allowUnsignedTwilioWebhooks: false,
        appBaseUrl: "https://relay.test",
      },
    },
    "@/lib/phone": { normalizePhoneNumber },
    "@/lib/supabase": supabase,
    "@/lib/supabase/accounts": { envAccountConfig: () => state.account },
    "@/lib/twilio": {
      formDataToRecord,
      logUnsignedTwilioWebhook: async () => {},
      missedCallSmsBodyForAccount: () => "Sorry we missed your call. Text us what you need.",
      phoneLast4: (value) => String(value ?? "").replace(/\D/g, "").slice(-4),
      rejectInvalidTwilioSignature: () => new Response("invalid", { status: 403 }),
      summarizeTwilioRequest: (_request, payload) => ({
        requestUrl: "https://relay.test/webhook",
        fromLast4: String(payload.From ?? "").replace(/\D/g, "").slice(-4),
        toLast4: String(payload.To ?? "").replace(/\D/g, "").slice(-4),
      }),
      twilioClient,
      validateTwilioWebhook: () => ({
        shouldReject: false,
        wasAllowedByOverride: false,
        matchedUrl: "https://relay.test/webhook",
        candidateUrls: [],
        hasSignature: true,
      }),
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async (input) => state.adminIssues.push(input),
      notifyOwnerInboundReply: async (input) => state.ownerEmails.push({ type: "reply", ...input }),
      notifyOwnerNewMissedCallLead: async (input) => state.ownerEmails.push({ type: "new_lead", ...input }),
      notifyOwnerOptOut: async (input) => state.ownerEmails.push({ type: "opt_out", ...input }),
    },
    "@/lib/twilio/unresolved-account": {
      handleUnresolvedTwilioAccount: async (input) => {
        state.webhookEvents.push({
          accountId: null,
          source: input.source,
          correlationId: input.correlationId,
          payload: input.payload,
          responseStatus: 200,
          responseBody: input.responseBody,
          error: `unresolved ${input.label}`,
        });
        return new Response(input.responseBody ?? "<Response/>", { status: 200 });
      },
    },
    "@/lib/twiml": {
      emptyTwiml: () => "<Response/>",
      helpReplyTwiml: ({ businessName }) => `<Response><Message>${businessName}: reply STOP to opt out.</Message></Response>`,
      twimlResponse: (xml) => new Response(xml, { status: 200 }),
    },
    "@/lib/voicemail-ai": {
      transcribeLeadVoicemail: async (leadId, accountId) => {
        state.transcriptions.push({ leadId, accountId });
      },
    },
  };
}

async function loadActivationModules(mocks) {
  const missedCall = await loadTsModule("lib/missed-call.ts", mocks);
  const routeMocks = {
    ...mocks,
    "next/server": {
      after: (callback) => {
        void callback();
      },
    },
    "@/lib/billing-activation": {
      activateStripeTrialForAccount: async () => ({
        status: "not_eligible",
        reason: "automatic_text_back_not_active",
      }),
    },
    "@/lib/missed-call": missedCall,
  };
  return {
    dialStatus: await loadTsModule("app/api/twilio/dial-status/route.ts", routeMocks),
    smsStatus: await loadTsModule("app/api/twilio/sms-status/route.ts", routeMocks),
    inboundSms: await loadTsModule("app/api/twilio/sms/route.ts", routeMocks),
    recording: await loadTsModule("app/api/twilio/recording/route.ts", routeMocks),
  };
}

function postForm(route, url, payload) {
  return route.POST(new Request(url, {
    method: "POST",
    body: new URLSearchParams(payload),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }));
}

async function runMissedCall(modules, payload = {}) {
  return postForm(modules.dialStatus, "https://relay.test/api/twilio/dial-status", {
    CallSid: CALL_SID,
    From: CALLER,
    To: ACCOUNT.twilioPhoneNumber,
    DialCallStatus: "no-answer",
    ...payload,
  });
}

test("activation flow: missed call creates lead, texts caller, reconciles delivery, forwards reply, and attaches voicemail", async () => {
  const state = makeState();
  const modules = await loadActivationModules(makeMocks(state));

  const missed = await runMissedCall(modules);
  assert.equal(missed.status, 200);

  const lead = state.leads.get("lead-1");
  assert.equal(lead.account_id, state.account.accountId);
  assert.equal(lead.call_sid, CALL_SID);
  assert.equal(lead.sms_status, "sent");
  assert.match(lead.twilio_message_sid, /^SM_auto_/);

  assert.equal(state.twilioSends.filter((send) => send.to === CALLER).length, 1);
  assert.equal(state.twilioSends.filter((send) => send.to === state.account.ownerPhoneNumber).length, 1);
  assert.ok(state.ownerEmails.some((email) => email.type === "new_lead"));

  const delivered = await postForm(modules.smsStatus, "https://relay.test/api/twilio/sms-status", {
    MessageSid: lead.twilio_message_sid,
    MessageStatus: "delivered",
    To: CALLER,
    From: state.account.twilioPhoneNumber,
  });
  assert.equal(delivered.status, 200);
  assert.equal(lead.sms_status, "delivered");
  assert.equal(state.messages.get(lead.twilio_message_sid).status, "delivered");

  const reply = await postForm(modules.inboundSms, "https://relay.test/api/twilio/sms", {
    MessageSid: "SM_inbound_phase2",
    From: CALLER,
    To: state.account.twilioPhoneNumber,
    Body: "I still need help today.",
  });
  assert.equal(reply.status, 200);
  assert.equal(state.inboundMessages.has("SM_inbound_phase2"), true);
  assert.ok(state.ownerEmails.some((email) => email.type === "reply" && /still need help/.test(email.body)));
  assert.ok(state.twilioSends.some((send) => send.to === state.account.ownerPhoneNumber && /New Relay reply/.test(send.body)));

  const recording = await postForm(modules.recording, "https://relay.test/api/twilio/recording", {
    CallSid: CALL_SID,
    From: CALLER,
    To: state.account.twilioPhoneNumber,
    RecordingSid: RECORDING_SID,
    RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/${RECORDING_SID}`,
    RecordingDuration: "11",
    RecordingStatus: "completed",
  });
  assert.equal(recording.status, 200);
  assert.equal(lead.recording_sid, RECORDING_SID);
  assert.equal(lead.recording_status, "completed");

  for (const callback of state.afterCallbacks) {
    await callback();
  }
  assert.deepEqual(state.transcriptions, [{ leadId: "lead-1", accountId: state.account.accountId }]);

  const tenantEvents = state.webhookEvents.filter((event) => event.accountId === state.account.accountId);
  assert.ok(tenantEvents.some((event) => event.source === "twilio_dial_status" && /SMS status: sent/.test(event.error ?? "")));
  assert.ok(tenantEvents.some((event) => event.source === "twilio_sms_status" && /MessageStatus: delivered/.test(event.error ?? "")));
  assert.ok(tenantEvents.some((event) => event.source === "twilio_inbound_sms" && /Forwarded inbound reply/.test(event.error ?? "")));
  assert.ok(tenantEvents.some((event) => event.source === "twilio_recording" && /Recording attached/.test(event.error ?? "")));
});

test("duplicate missed-call webhook does not create a second lead or double-text the caller", async () => {
  const state = makeState();
  const modules = await loadActivationModules(makeMocks(state));

  assert.equal((await runMissedCall(modules)).status, 200);
  assert.equal((await runMissedCall(modules)).status, 200);

  assert.equal(state.leads.size, 1);
  assert.equal(state.twilioSends.filter((send) => send.to === CALLER).length, 1);
  assert.ok(state.webhookEvents.some((event) => /SMS status: duplicate/.test(event.error ?? "")));
});

test("delayed SMS status callback self-heals when Twilio accepted but the lead update failed", async () => {
  const state = makeState({ failSentLeadUpdate: true });
  const modules = await loadActivationModules(makeMocks(state));

  assert.equal((await runMissedCall(modules)).status, 200);

  const lead = state.leads.get("lead-1");
  const message = [...state.messages.values()].find((row) => row.leadId === lead.id && row.direction === "outbound");
  assert.ok(message?.twilioMessageSid, "message row should exist for reconciliation");
  assert.equal(lead.twilio_message_sid, null, "simulated partial failure leaves the lead stale");
  assert.ok(state.adminIssues.some((issue) => /lead update failed/i.test(issue.issue)));

  state.failSentLeadUpdate = false;
  const callback = await postForm(modules.smsStatus, "https://relay.test/api/twilio/sms-status", {
    MessageSid: message.twilioMessageSid,
    MessageStatus: "delivered",
    To: CALLER,
    From: state.account.twilioPhoneNumber,
  });
  assert.equal(callback.status, 200);
  assert.equal(lead.sms_status, "delivered");
  assert.equal(lead.twilio_message_sid, message.twilioMessageSid);
  assert.ok(state.webhookEvents.some((event) => /reconciled lead lead-1/i.test(event.error ?? "")));
});

test("SMS-paused account still captures the missed call without texting the caller", async () => {
  const state = makeState({ account: { ...ACCOUNT, smsEnabled: false } });
  const modules = await loadActivationModules(makeMocks(state));

  assert.equal((await runMissedCall(modules)).status, 200);

  const lead = state.leads.get("lead-1");
  assert.equal(lead.sms_status, "skipped_disabled");
  assert.equal(state.twilioSends.filter((send) => send.to === CALLER).length, 0);
  assert.ok(state.ownerEmails.some((email) => email.type === "new_lead" && email.smsStatus === "skipped_disabled"));
  assert.ok(state.webhookEvents.some((event) => /SMS status: skipped_disabled/.test(event.error ?? "")));
});
