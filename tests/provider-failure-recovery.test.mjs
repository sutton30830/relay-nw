import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { telephonyProviderMock } from "./helpers/telephony-provider.mjs";

async function loadTsModule(path, mocks = {}) {
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
    throw new Error(`Missing mock for ${specifier} while loading ${path}`);
  };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

test("customer explanations classify landlines and quality suppression without calling them outages", async () => {
  const { failurePresentation, isExpectedQualitySuppression } = await loadTsModule("lib/provider-actions.ts");
  const landline = failurePresentation({ provider: "twilio", action: "manual_reply_sms", failureCode: "30006" });
  assert.equal(landline.customerExplanation, "This number cannot receive text messages.");
  assert.equal(landline.retryEligibility, "never");
  assert.match(landline.recommendedNextAction, /Call/);

  assert.equal(isExpectedQualitySuppression("known_hallucination_pattern"), true);
  assert.equal(
    isExpectedQualitySuppression("No clear spoken message was detected. Relay did not generate a transcript."),
    true,
  );
  const quality = failurePresentation({
    provider: "openai",
    action: "voicemail_transcription",
    expectedSuppression: true,
  });
  assert.equal(quality.suppressed, true);
  assert.equal(quality.retryEligibility, "never");
  assert.doesNotMatch(quality.customerExplanation, /outage|platform failed/i);
});

test("diagnostics redact credentials and automatic SMS retries are always refused", async () => {
  const { automaticRetryIsSafe, sanitizeProviderDiagnostic } = await loadTsModule("lib/provider-actions.ts");
  const stripeShapedTestValue = ["sk", "live", "abcdefghijklmnopqrstuvwxyz"].join("_");
  const diagnostic = sanitizeProviderDiagnostic(
    `Bearer secret-token ${stripeShapedTestValue}?token=also-secret`,
  );
  assert.doesNotMatch(diagnostic, /secret-token|sk_live_|also-secret/);
  assert.equal(automaticRetryIsSafe({
    action: "automatic_missed_call_sms",
    status: "failed",
    retryEligibility: "automatic",
    providerIdentifier: null,
  }), false);
  assert.equal(automaticRetryIsSafe({
    action: "scheduled_billing_reconciliation",
    status: "failed",
    retryEligibility: "automatic",
    providerIdentifier: null,
  }), true);
  assert.equal(automaticRetryIsSafe({
    action: "recording_retrieval",
    status: "failed",
    retryEligibility: "automatic",
    providerIdentifier: "RE123",
  }), false);
});

function replyRouteMocks(overrides = {}) {
  const state = { actions: new Map(), sends: 0, messageWrites: 0 };
  const recordProviderAction = async (event) => {
    const existing = state.actions.get(event.idempotencyKey);
    if (existing?.internalStatus === "processing" && event.internalStatus === "pending") return;
    state.actions.set(event.idempotencyKey, {
      ...existing,
      ...event,
      lastAttemptAt: "2026-08-05T12:00:00.000Z",
    });
  };
  const claimProviderActionRetry = async ({ idempotencyKey }) => {
    const action = state.actions.get(idempotencyKey);
    if (!action || action.internalStatus !== "pending") return false;
    state.actions.set(idempotencyKey, { ...action, internalStatus: "processing" });
    return true;
  };
  const twilioClient = {
    messages: {
      create: async () => {
        state.sends += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { sid: "SM_once", status: "queued" };
      },
    },
  };
  const { registry: telephonyRegistry } = telephonyProviderMock({ twilioClient });
  const mocks = {
    "@/lib/auth": {
      requireWriteAccessJson: async () => ({
        response: null,
        session: {
          accountId: "acct-1",
          account: { smsEnabled: true, twilioPhoneNumber: "+12065550100" },
        },
      }),
    },
    "@/lib/env": { env: { appBaseUrl: "https://relay.example" } },
    "@/lib/telephony/registry": telephonyRegistry,
    "@/lib/supabase": {
      recordProviderAction,
      claimProviderActionRetry,
      getProviderActionByKey: async (_accountId, key) => state.actions.get(key) ?? null,
      getLeadByIdForAccount: async () => ({
        id: "lead-1",
        phone: "+12065550123",
        status: "new",
        deleted_at: null,
      }),
      isOptedOut: async () => false,
      createMessageIfNew: async () => { state.messageWrites += 1; },
      updateLead: async () => {},
    },
    "@/lib/twilio": {
      phoneLast4: (phone) => phone.slice(-4),
    },
    ...overrides,
  };
  return { state, mocks };
}

function replyRequest(key) {
  return new Request("https://relay.example/api/leads/lead-1/reply", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ body: "Can we help?" }),
  });
}

test("a retry race reserves one manual SMS and never sends two copies", async () => {
  const { state, mocks } = replyRouteMocks();
  const { POST } = await loadTsModule("app/api/leads/[id]/reply/route.ts", mocks);
  const params = { params: Promise.resolve({ id: "lead-1" }) };
  const [first, second] = await Promise.all([
    POST(replyRequest("same-reply-0001"), params),
    POST(replyRequest("same-reply-0001"), params),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(state.sends, 1);
  assert.equal(state.messageWrites, 1);
});

test("provider acceptance followed by a local message write failure still returns accepted", async () => {
  const fixture = replyRouteMocks();
  fixture.mocks["@/lib/supabase"].createMessageIfNew = async () => {
    throw new Error("simulated database write failure");
  };
  const { POST } = await loadTsModule("app/api/leads/[id]/reply/route.ts", fixture.mocks);
  const response = await POST(replyRequest("accepted-local-fail-1"), {
    params: Promise.resolve({ id: "lead-1" }),
  });
  assert.equal(response.status, 200);
  assert.equal(fixture.state.sends, 1);
  assert.equal(fixture.state.actions.get("manual_reply:lead-1:accepted-local-fail-1").internalStatus, "accepted");
});

test("migration enforces tenant isolation, stale-lock recovery, monotonic callbacks, and no SMS reclaim", async () => {
  const sql = await readFile(new URL("../docs/migrations/2026-08-05-provider-action-events.sql", import.meta.url), "utf8");
  assert.match(sql, /unique \(account_id, idempotency_key\)/i);
  assert.match(sql, /as restrictive for all to anon, authenticated using \(false\)/i);
  assert.match(sql, /processing_started_at < p_stale_before/i);
  assert.match(sql, /action not like '%sms%'/i);
  assert.match(sql, /internal_status = 'succeeded'[\s\S]*excluded\.internal_status in \('pending', 'processing', 'accepted', 'failed'\)/i);
  assert.match(sql, /security definer/i);
  const messages = await readFile(new URL("../lib/supabase/messages.ts", import.meta.url), "utf8");
  assert.match(messages, /input\.smsStatus !== "delivered"[\s\S]*neq\("sms_status", "delivered"\)/);
  assert.match(messages, /input\.status !== "delivered"[\s\S]*neq\("status", "delivered"\)/);
});
